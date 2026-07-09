/**
 * Pipeline Stage Worker — BullMQ worker that executes submodules.
 *
 * Runs as a standalone PM2 process (not imported by server.js).
 * Entry point: node server/workers/stageWorker.js
 *
 * Job payload: { submodule_run_id, submodule_id, step_index }
 * The worker loads input_data and options from the submodule_runs row,
 * then loads execute.js from MODULES_PATH and calls it.
 */

import 'dotenv/config';
import { Worker } from 'bullmq';
import path from 'path';
import { pathToFileURL } from 'url';
import db from '../services/db.js';
import { redis } from '../services/queue.js';
import { loadModules, getSubmoduleById } from '../services/moduleLoader.js';
import { COST_CONFIG } from '../config/timeouts.js';
import { hydrateItems } from '../services/poolBlobs.js';
import { convertXlsxInDir } from '../utils/xlsxConverter.js';
import { parseAnthropicSSE } from '../services/aiStream.js';
import { buildCachedUserContent } from '../services/promptCache.js';
import { deriveEntityRunStatus } from '../utils/entityRunStatus.js';
import { createHttp } from '../lib/httpTools.js';

// Load submodule manifests (worker is a separate process from server.js)
loadModules();

/**
 * Model name → API model ID mapping.
 * Adding a new model is one line.
 */
const MODEL_MAP = {
  // Anthropic
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-5-20250929',
  opus: 'claude-opus-4-6',
  // OpenAI
  'gpt-4o-mini': 'gpt-4o-mini',
  'gpt-4o': 'gpt-4o',
  // Perplexity
  sonar: 'sonar',
  'sonar-pro': 'sonar-pro',
};

/**
 * Build the tools object that gets passed to execute().
 * See spec Part 12.
 * @param {string} runId - entity_submodule_runs row ID to write progress to
 * @param {string} submoduleId - For logging prefix
 */
function buildTools(runId, submoduleId) {
  const progressTable = 'entity_submodule_runs';
  const logs = [];

  const logger = {
    info: (message) => {
      console.log(`[${submoduleId}] ${message}`);
      logs.push({ level: 'info', message, timestamp: new Date().toISOString() });
    },
    warn: (message) => {
      console.warn(`[${submoduleId}] ${message}`);
      logs.push({ level: 'warn', message, timestamp: new Date().toISOString() });
    },
    error: (message) => {
      console.error(`[${submoduleId}] ${message}`);
      logs.push({ level: 'error', message, timestamp: new Date().toISOString() });
    },
  };

  // Helper: race a fetch operation against a timeout. Ensures the ENTIRE operation
  // (connect + headers + body read) completes within the limit. Also aborts the
  // underlying connection on timeout to prevent leaked sockets.
  function withTimeout(fn, ms) {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        const e = new Error(`HTTP request timed out after ${ms}ms`);
        e.isTimeout = true; // duration-driven; NOT retryable (a retry just re-hits the same wall)
        reject(e);
      }, ms);
      fn(controller.signal).then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  // tools.http — GET/HEAD/POST/PUT/PATCH, binary-safe request+response, multipart.
  // Implementation extracted to server/lib/httpTools.js (unit-tested in isolation).
  const http = createHttp({ fetch, withTimeout });

  let _lastTotal = 1; // Track last reported total for completion write
  const progress = {
    update: (current, total, message) => {
      // Fire-and-forget — progress writes should never crash the execute function
      const progressData = { current, total, message };
      if (total > 0) _lastTotal = total;
      db.from(progressTable)
        .update({ progress: progressData })
        .eq('id', runId)
        .then(({ error }) => {
          if (error) logger.warn(`Progress update failed: ${error.message}`);
        })
        .catch(() => { /* silent */ });
    },
    get lastTotal() { return _lastTotal; },
  };

  // Retry-eligible HTTP status codes (transient errors)
  const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);

  // Per-request timeout for LLM API calls (10 minutes).
  // The Anthropic path STREAMS (see parseAnthropicSSE), so the socket stays warm
  // and this AbortController — not undici's hidden ~300s body/headers default — is
  // the real ceiling. Generous for large prompts (content-writer: 100KB+).
  const AI_REQUEST_TIMEOUT_MS = 600_000;

  // Retry config for transient failures
  const AI_MAX_RETRIES = 3;
  const AI_BASE_DELAY_MS = 2000; // 2s → 4s → 8s exponential backoff

  const ai = {
    complete: async ({ prompt, model = 'haiku', provider = 'anthropic', temperature, max_tokens, cache_prefix }) => {
      const startTime = Date.now();
      const modelId = MODEL_MAP[model] || model;

      // Inner function that makes a single API call with timeout
      async function callProvider(attempt) {
        if (provider === 'anthropic') {
          const apiKey = process.env.ANTHROPIC_API_KEY;
          if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in environment');

          // STREAM the response. A non-streamed long generation idles the socket
          // past undici's hidden ~300s body/headers timeout → bare "fetch failed"
          // → (no statusCode) retried 3x → ~908s wall → no content for large
          // entities (Wazdan, 2026-06-13). Streaming keeps bytes flowing, so the
          // request lives until AI_REQUEST_TIMEOUT_MS. The full read is raced
          // against that timeout via withTimeout (its AbortController aborts the
          // fetch + stream on expiry).
          const streamed = await withTimeout(async (signal) => {
            const res = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              signal,
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: modelId,
                max_tokens: max_tokens ?? 16384,
                stream: true,
                // BACKLOG #21: when the caller passes a large stable cache_prefix
                // (e.g. reference docs), split it into a cache_control'd block so
                // the API caches it (~10% input cost on re-read within 5 min).
                // No cache_prefix → plain string content, unchanged from before.
                messages: [{ role: 'user', content: buildCachedUserContent(prompt, cache_prefix) }],
                ...(temperature != null && { temperature }),
              }),
            });
            if (res.status !== 200) {
              // Error responses are NOT streamed — body is a JSON error object.
              const errBody = await res.text();
              const err = new Error(`Anthropic API error ${res.status}: ${errBody.slice(0, 500)}`);
              err.statusCode = res.status;
              throw err;
            }
            return await parseAnthropicSSE(res.body);
          }, AI_REQUEST_TIMEOUT_MS);

          const duration_ms = Date.now() - startTime;
          const stopReason = streamed.stop_reason || 'unknown';
          const result = {
            text: streamed.text || '',
            tokens_in: streamed.tokens_in || 0,
            tokens_out: streamed.tokens_out || 0,
            // BACKLOG #21 prompt-cache observability — additive fields, 0 when
            // no cache_prefix was sent or the prefix was below the cache minimum.
            cache_write_tokens: streamed.cache_creation_input_tokens || 0,
            cache_read_tokens: streamed.cache_read_input_tokens || 0,
            model: modelId,
            provider: 'anthropic',
            stop_reason: stopReason,
            duration_ms,
          };
          if (stopReason === 'max_tokens') {
            logger.warn(`[ai] ${provider}/${model} — response TRUNCATED (hit max_tokens). Output may be incomplete.`);
          }
          const cacheNote = (result.cache_read_tokens || result.cache_write_tokens)
            ? `, cache: ${result.cache_read_tokens} read / ${result.cache_write_tokens} write`
            : '';
          logger.info(`[ai] ${provider}/${model} — ${result.tokens_in} in, ${result.tokens_out} out${cacheNote}, ${duration_ms}ms, stop: ${stopReason} (streamed)`);
          return result;

        } else if (provider === 'openai') {
          const apiKey = process.env.OPENAI_API_KEY;
          if (!apiKey) throw new Error('OPENAI_API_KEY not set in environment');

          const { status, body } = await withTimeout(async (signal) => {
            const res = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              signal,
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model: modelId,
                messages: [{ role: 'user', content: prompt }],
                ...(max_tokens && { max_tokens }),
                ...(temperature != null && { temperature }),
              }),
            });
            return { status: res.status, body: await res.text() };
          }, AI_REQUEST_TIMEOUT_MS);

          if (status !== 200) {
            const err = new Error(`OpenAI API error ${status}: ${body.slice(0, 500)}`);
            err.statusCode = status;
            throw err;
          }

          const data = JSON.parse(body);
          const duration_ms = Date.now() - startTime;
          const result = {
            text: data.choices?.[0]?.message?.content || '',
            tokens_in: data.usage?.prompt_tokens || 0,
            tokens_out: data.usage?.completion_tokens || 0,
            model: modelId,
            provider: 'openai',
            duration_ms,
          };
          logger.info(`[ai] ${provider}/${model} — ${result.tokens_in} in, ${result.tokens_out} out, ${duration_ms}ms`);
          return result;

        } else if (provider === 'perplexity') {
          const apiKey = process.env.PERPLEXITY_API_KEY;
          if (!apiKey) throw new Error('PERPLEXITY_API_KEY not set in environment');

          const { status, body } = await withTimeout(async (signal) => {
            const res = await fetch('https://api.perplexity.ai/chat/completions', {
              method: 'POST',
              signal,
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model: modelId,
                messages: [{ role: 'user', content: prompt }],
                ...(max_tokens && { max_tokens }),
                ...(temperature != null && { temperature }),
              }),
            });
            return { status: res.status, body: await res.text() };
          }, AI_REQUEST_TIMEOUT_MS);

          if (status !== 200) {
            const err = new Error(`Perplexity API error ${status}: ${body.slice(0, 500)}`);
            err.statusCode = status;
            throw err;
          }

          const data = JSON.parse(body);
          const duration_ms = Date.now() - startTime;
          const result = {
            text: data.choices?.[0]?.message?.content || '',
            tokens_in: data.usage?.prompt_tokens || 0,
            tokens_out: data.usage?.completion_tokens || 0,
            model: modelId,
            provider: 'perplexity',
            citations: data.citations || [],
            duration_ms,
          };
          logger.info(`[ai] ${provider}/${model} — ${result.tokens_in} in, ${result.tokens_out} out, ${duration_ms}ms, ${result.citations.length} citations`);
          return result;

        } else {
          throw new Error(`Unknown AI provider: "${provider}". Supported: anthropic, openai, perplexity`);
        }
      }

      // Retry loop with exponential backoff for transient errors
      let lastError;
      for (let attempt = 1; attempt <= AI_MAX_RETRIES; attempt++) {
        try {
          return await callProvider(attempt);
        } catch (err) {
          lastError = err;
          const isTransient = !err.isTimeout && (                       // duration-driven timeout: a retry just re-hits the same wall
            !err.statusCode                                            // Network errors (no HTTP status)
            || RETRYABLE_STATUSES.has(err.statusCode));                // Retryable HTTP statuses

          if (!isTransient || attempt === AI_MAX_RETRIES) {
            throw err; // Permanent error or final attempt — give up
          }

          const delay = AI_BASE_DELAY_MS * Math.pow(2, attempt - 1);  // 2s, 4s, 8s
          logger.warn(`[ai] ${provider}/${model} — attempt ${attempt}/${AI_MAX_RETRIES} failed (${err.message}), retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      throw lastError; // Should not reach here, but safety net
    },
  };

  const browser = {
    fetch: async (url, options = {}) => {
      // Lazy import — Playwright only loaded when actually called
      const { browserFetch } = await import('../services/browserPool.js');
      return browserFetch(url, options);
    },
  };

  const unlocker = {
    fetch: async (url) => {
      // Bright Data Web Unlocker — bypasses Cloudflare/CAPTCHAs server-side
      const { webUnlockerFetch } = await import('../services/browserPool.js');
      return webUnlockerFetch(url);
    },
  };

  return { logger, http, browser, unlocker, progress, ai, _logs: logs, _partialItems: [] };
}

/**
 * Load execute function from a submodule's directory.
 * Supports both ESM (export default) and CommonJS (module.exports).
 */
async function loadExecuteFunction(manifest) {
  const modulePath = manifest._path;
  const executePath = path.join(modulePath, 'execute.js');

  // Use dynamic import (works for both ESM and CJS with file:// URL)
  const moduleUrl = pathToFileURL(executePath).href;
  const mod = await import(moduleUrl);

  // Support both: export default function, module.exports = function
  const fn = mod.default || mod;
  if (typeof fn !== 'function') {
    throw new Error(`execute.js in ${manifest.id} does not export a function`);
  }
  return fn;
}

/**
 * Log an execution metric. Non-blocking — failures are silently ignored.
 */
function logMetric({ run_id, submodule_id, entity_name, status, duration_ms, step_index, cost, error }) {
  db.from('pipeline_metrics')
    .insert({ run_id, submodule_id, entity_name, status, duration_ms, step_index, cost, error })
    .then(() => {})
    .catch(() => {}); // Table may not exist yet — fail silently
}

/**
 * Per-entity job handler.
 * Processes a single entity through a submodule's execute function.
 * Reads from / writes to entity_submodule_runs table.
 */
async function handleEntityJob(job) {
  const { entity_submodule_run_id, entity_name, submodule_id, step_index, batch_id } = job.data;

  console.log(`[worker:entity] Processing ${submodule_id} for "${entity_name}" (step ${step_index})`);

  // 1. Load entity_submodule_runs row
  const { data: entityRun, error: runErr } = await db
    .from('entity_submodule_runs')
    .select('*')
    .eq('id', entity_submodule_run_id)
    .single();

  if (runErr || !entityRun) {
    throw new Error(`entity_submodule_runs row not found: ${entity_submodule_run_id}`);
  }

  // 1b. Idempotency guard — skip if already completed (retry after partial write)
  if (entityRun.status === 'completed' || entityRun.status === 'approved') {
    console.log(`[worker:entity] Skipping ${submodule_id}/${entity_name} — already ${entityRun.status}`);
    return;
  }

  // 1c. Check if run was aborted before we start
  if (entityRun.status === 'failed' && entityRun.error === 'Aborted by user') {
    console.log(`[worker:entity] Skipping ${submodule_id}/${entity_name} — aborted by user`);
    return;
  }

  // 2. Look up manifest
  const manifest = getSubmoduleById(submodule_id);
  if (!manifest) {
    throw new Error(`Submodule not found in registry: ${submodule_id}`);
  }

  // 3. Mark as running + start timer
  const startTime = Date.now();
  await db
    .from('entity_submodule_runs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', entity_submodule_run_id);

  // 4. Load execute function
  const executeFn = await loadExecuteFunction(manifest);

  // 5. Build tools
  const tools = buildTools(entity_submodule_run_id, submodule_id);

  // 6. Timeout + abort polling
  const cost = manifest.cost || 'medium';
  const costConfig = COST_CONFIG[cost] || COST_CONFIG.medium;
  const timeout = costConfig.timeout;
  let timeoutTimer;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new Error(`Execution timed out after ${timeout / 1000}s`)), timeout);
  });

  // Abort polling: check Redis every 2s for entity-level abort signal.
  // When user aborts a single entity, the API sets this key. The reject
  // triggers the catch handler which saves _partialItems.
  let abortInterval;
  const abortPromise = new Promise((_, reject) => {
    abortInterval = setInterval(async () => {
      try {
        const aborted = await redis.get(`abort:entity:${entity_submodule_run_id}`);
        if (aborted) {
          await redis.del(`abort:entity:${entity_submodule_run_id}`);
          reject(new Error('Aborted by user'));
        }
      } catch { /* Redis errors should not crash the worker */ }
    }, 2000);
  });

  // 7. Prepare input — single entity format
  const input = entityRun.input_data;
  const options = { ...(manifest.options_defaults || {}), ...(entityRun.options || {}) };

  // 7a. Pre-process: convert .xlsx/.xls → .csv before csv-discovery runs
  if (submodule_id === 'csv-discovery') {
    for (const dirKey of ['source_dir', 'upload_dir']) {
      if (options[dirKey]) {
        const { converted, errors } = convertXlsxInDir(options[dirKey]);
        if (converted > 0) console.log(`[worker:entity] Converted ${converted} XLSX file(s) in ${options[dirKey]}`);
        if (errors.length > 0) console.warn(`[worker:entity] XLSX conversion errors: ${errors.join('; ')}`);
      }
    }
  }

  // 7b. Enrich: merge downloadable fields from upstream for this entity's items
  // Helper: item_data stores objects as JSON strings — parse them back
  const parseContent = (val) => {
    if (typeof val !== 'string') return val;
    const trimmed = val.trimStart();
    if ((trimmed[0] === '{' || trimmed[0] === '[') && trimmed.length > 1) {
      try { return JSON.parse(val); } catch { /* not JSON */ }
    }
    return val;
  };

  const enrichedFields = new Set();
  const requiresColumns = manifest.requires_columns || [];
  const entityItems = input?.entity?.items || [];
  if (requiresColumns.length > 0 && entityItems.length > 0) {
    const sampleItems = entityItems.slice(0, 10);
    const missingColumns = requiresColumns.filter(col =>
      sampleItems.every(item => !item[col] || String(item[col]).length === 0)
    );

    if (missingColumns.length > 0) {
      console.log(`[worker:entity] Enriching "${entity_name}": ${missingColumns.join(', ')} missing from ${entityItems.length} items`);

      // Find upstream completed entity_submodule_runs for this entity (with step_index for ordering)
      const pipelineRunId = entityRun.run_id;
      const { data: upstreamRuns } = await db
        .from('entity_submodule_runs')
        .select('id, step_index')
        .eq('run_id', pipelineRunId)
        .eq('entity_name', entity_name)
        .in('status', ['completed', 'approved']);

      const upstreamRunList = (upstreamRuns || [])
        .filter(r => r.id !== entity_submodule_run_id);
      const upstreamRunIds = upstreamRunList.map(r => r.id);
      // Map submodule_run_id → step_index so we can sort item_data rows
      const stepIndexMap = Object.fromEntries(upstreamRunList.map(r => [r.id, r.step_index]));

      if (upstreamRunIds.length > 0) {
        const itemKeyField = manifest.item_key || 'url';
        const itemKeys = [...new Set(
          entityItems.map(item => String(item[itemKeyField] ?? '')).filter(Boolean)
        )];

        const ENRICH_BATCH = 200;
        const lookup = new Map();
        const allItemDataRows = [];
        for (let i = 0; i < itemKeys.length; i += ENRICH_BATCH) {
          const keyBatch = itemKeys.slice(i, i + ENRICH_BATCH);
          const { data: itemData } = await db
            .from('submodule_run_item_data')
            .select('submodule_run_id, item_key, field_name, content')
            .in('submodule_run_id', upstreamRunIds)
            .in('field_name', missingColumns)
            .in('item_key', keyBatch);

          if (itemData) allItemDataRows.push(...itemData);
        }
        // Sort by step_index ascending so later steps (e.g. boilerplate-stripper step 4)
        // overwrite earlier steps (e.g. page-scraper step 3) in the lookup map
        allItemDataRows.sort((a, b) =>
          (stepIndexMap[a.submodule_run_id] || 0) - (stepIndexMap[b.submodule_run_id] || 0)
        );
        for (const row of allItemDataRows) {
          if (!lookup.has(row.item_key)) lookup.set(row.item_key, {});
          lookup.get(row.item_key)[row.field_name] = parseContent(row.content);
        }

        let mergedCount = 0;
        for (const item of entityItems) {
          const key = String(item[itemKeyField] ?? '');
          const extra = lookup.get(key);
          if (extra) {
            for (const k of Object.keys(extra)) enrichedFields.add(k);
            Object.assign(item, extra);
            mergedCount++;
          }
        }
        if (mergedCount > 0) {
          console.log(`[worker:entity] Enriched ${mergedCount}/${entityItems.length} items for "${entity_name}" via primary key (${itemKeyField})`);
        }

        // Cross-key fallback: check which required fields are STILL missing after
        // primary enrichment, then try alternate keys (url ↔ entity_name).
        const stillMissing = missingColumns.filter(col =>
          entityItems.some(item => item[col] === undefined || item[col] === null)
        );

        if (stillMissing.length > 0) {
          // Try url-based lookup (for entity_name-keyed modules needing url-keyed data)
          if (itemKeyField !== 'url') {
            const urlKeys = [...new Set(
              entityItems.map(item => String(item.url ?? '')).filter(Boolean)
            )];
            if (urlKeys.length > 0) {
              const lookup2 = new Map();
              const crossRows = [];
              for (let i = 0; i < urlKeys.length; i += ENRICH_BATCH) {
                const keyBatch = urlKeys.slice(i, i + ENRICH_BATCH);
                const { data: itemData } = await db
                  .from('submodule_run_item_data')
                  .select('submodule_run_id, item_key, field_name, content')
                  .in('submodule_run_id', upstreamRunIds)
                  .in('field_name', stillMissing)
                  .in('item_key', keyBatch);
                if (itemData) crossRows.push(...itemData);
              }
              // Sort by step_index ascending so later steps overwrite earlier
              crossRows.sort((a, b) =>
                (stepIndexMap[a.submodule_run_id] || 0) - (stepIndexMap[b.submodule_run_id] || 0)
              );
              for (const row of crossRows) {
                if (!lookup2.has(row.item_key)) lookup2.set(row.item_key, {});
                lookup2.get(row.item_key)[row.field_name] = parseContent(row.content);
              }
              let crossCount = 0;
              for (const item of entityItems) {
                const urlVal = String(item.url ?? '');
                const extra = lookup2.get(urlVal);
                if (extra) {
                  for (const k of Object.keys(extra)) enrichedFields.add(k);
                  Object.assign(item, extra);
                  crossCount++;
                }
              }
              if (crossCount > 0) {
                console.log(`[worker:entity] Cross-key enriched ${crossCount}/${entityItems.length} items for "${entity_name}" (url fallback, fields: ${stillMissing.join(', ')})`);
              }
            }
          }

          // Try entity_name-based lookup (for url-keyed modules needing entity_name-keyed data)
          if (itemKeyField !== 'entity_name') {
            const stillMissing2 = stillMissing.filter(col =>
              entityItems.some(item => item[col] === undefined || item[col] === null)
            );
            if (stillMissing2.length > 0) {
              const entityKeys = [...new Set(
                entityItems.map(item => String(item.entity_name ?? '')).filter(Boolean)
              )];
              if (entityKeys.length > 0) {
                const { data: itemData } = await db
                  .from('submodule_run_item_data')
                  .select('item_key, field_name, content')
                  .in('submodule_run_id', upstreamRunIds)
                  .in('field_name', stillMissing2)
                  .in('item_key', entityKeys);
                const entLookup = {};
                for (const row of (itemData || [])) {
                  entLookup[row.field_name] = parseContent(row.content);
                }
                if (Object.keys(entLookup).length > 0) {
                  let entCount = 0;
                  for (const item of entityItems) {
                    if (item.entity_name && entityKeys.includes(item.entity_name)) {
                      Object.assign(item, entLookup);
                      entCount++;
                    }
                  }
                  for (const k of Object.keys(entLookup)) enrichedFields.add(k);
                  console.log(`[worker:entity] Cross-key enriched ${entCount}/${entityItems.length} items for "${entity_name}" (entity_name fallback, fields: ${stillMissing2.join(', ')})`);
                }
              }
            }
          }
        }
      }
    }
  }

  // 7c. Hydrate pool blob refs — restore large fields that were extracted to pool_item_blobs
  if (entityItems.length > 0) {
    const hydratedCount = await hydrateItems(entityItems);
    if (hydratedCount > 0) {
      console.log(`[worker:entity] Hydrated ${hydratedCount} blob refs for "${entity_name}"`);
    }
  }

  // 8. Execute with timeout
  //    Compatibility shim: wrap single entity into legacy array format until
  //    execute.js files are migrated to single-entity input.
  //    Once migrated, the shim detects `input.entity` support and passes directly.
  const entityItemCount = input?.entity?.items?.length ?? 0;
  if (entityItemCount === 0) {
    console.warn(`[worker:entity] WARNING: "${entity_name}" has 0 input items for ${submodule_id} (step ${step_index}). Pool may be empty or items missing url field. Entity keys: ${Object.keys(input?.entity || {}).join(', ')}`);
  } else {
    console.log(`[worker:entity] "${entity_name}" has ${entityItemCount} input items for ${submodule_id}`);
  }

  const legacyInput = {
    ...input,
    entities: [input.entity],
  };

  let result;
  try {
    const rawResult = await Promise.race([executeFn(legacyInput, options, tools), timeoutPromise, abortPromise]);

    // Unwrap: legacy returns { results: [{ entity_name, items, ... }], summary }
    // Per-entity expects { items: [...], ... } for the single entity
    if (rawResult?.results && Array.isArray(rawResult.results)) {
      const entityResult = rawResult.results.find(r => r.entity_name === entity_name) || rawResult.results[0];
      result = entityResult || { items: [] };
    } else {
      result = rawResult;
    }
  } catch (err) {
    const inputItems = input?.entity?.items || [];
    const itemKeyField = manifest.item_key || 'url';
    const isTimeout = err.message?.includes('timed out');

    // If submodule pushed partial results via tools._partialItems, use those.
    // This saves successfully scraped pages even when the overall run times out.
    const partialItems = tools._partialItems || [];

    let outputItems;
    if (partialItems.length > 0) {
      // Use partial results + mark remaining items as timed_out
      const completedKeys = new Set(partialItems.map(i => String(i[itemKeyField] ?? '')));
      const remainingItems = inputItems
        .filter(item => !completedKeys.has(String(item[itemKeyField] ?? '')))
        .map(item => ({
          [itemKeyField]: item[itemKeyField] || 'unknown',
          status: isTimeout ? 'timed_out' : 'error',
          error: err.message,
          entity_name: entity_name,
          word_count: 0,
        }));
      outputItems = [...partialItems, ...remainingItems];
      console.log(`[worker:entity] ${submodule_id}/${entity_name}: saving ${partialItems.length} partial results + ${remainingItems.length} remaining as ${isTimeout ? 'timed_out' : 'error'}`);
    } else {
      // No partial results — build synthetic error items
      outputItems = inputItems.map(item => ({
        [itemKeyField]: item[itemKeyField] || 'unknown',
        status: 'error',
        error: `Execution failed: ${err.message}`,
        entity_name: entity_name,
        word_count: 0,
      }));
    }

    // Use 'completed' status if we have partial results (so they can be approved)
    const runStatus = partialItems.length > 0 ? 'completed' : 'failed';

    await db
      .from('entity_submodule_runs')
      .update({
        status: runStatus,
        error: err.message,
        output_data: outputItems.length > 0
          ? { items: outputItems, meta: { error: err.message, partial: partialItems.length > 0, completed_count: partialItems.length } }
          : null,
        output_render_schema: runStatus === 'completed' ? (manifest.output_schema || null) : undefined,
        logs: tools._logs,
        completed_at: new Date().toISOString(),
      })
      .eq('id', entity_submodule_run_id);

    // Update entity_stage_pool status
    await db
      .from('entity_stage_pool')
      .update({ status: runStatus, error: err.message, updated_at: new Date().toISOString() })
      .eq('run_id', entityRun.run_id)
      .eq('step_index', step_index)
      .eq('entity_name', entity_name);

    const duration_ms = Date.now() - startTime;
    const metricStatus = isTimeout ? 'timeout' : (partialItems.length > 0 ? 'partial' : 'failed');
    logMetric({ run_id: entityRun.run_id, submodule_id, entity_name, status: metricStatus, duration_ms, step_index, cost: manifest.cost || 'medium', error: err.message });

    if (partialItems.length > 0) return; // Don't throw — partial success
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
    clearInterval(abortInterval);
  }

  // 9. Store downloadable fields (same logic, but for single entity result)
  const downloadFieldDefs = manifest.output_schema?.downloadable_fields || [];
  if (downloadFieldDefs.length > 0 && result?.items) {
    const downloadFieldNames = downloadFieldDefs.map((d) => d.field);
    const itemKeyField = manifest.item_key || 'url';
    const itemDataRows = [];

    for (const item of result.items) {
      const key = String(item[itemKeyField] ?? '');
      if (!key) continue;
      for (const field of downloadFieldNames) {
        const content = item[field];
        if (content != null) {
          const serialized = (typeof content === 'object')
            ? JSON.stringify(content)
            : String(content);
          if (serialized.length > 0) {
            itemDataRows.push({
              submodule_run_id: entity_submodule_run_id,
              item_key: key,
              field_name: field,
              content: serialized,
            });
          }
        }
      }
    }

    if (itemDataRows.length > 0) {
      const BATCH_SIZE = 500;
      let storedCount = 0;
      let insertFailed = false;
      for (let i = 0; i < itemDataRows.length; i += BATCH_SIZE) {
        const batch = itemDataRows.slice(i, i + BATCH_SIZE);
        const { error: itemErr } = await db
          .from('submodule_run_item_data')
          .insert(batch);
        if (itemErr) {
          console.warn(`[worker:entity] Failed to store item data batch for ${submodule_id}/${entity_name}: ${itemErr.message}`);
          insertFailed = true;
        } else {
          storedCount += batch.length;
        }
      }
      console.log(`[worker:entity] Stored ${storedCount}/${itemDataRows.length} downloadable field entries for ${submodule_id}/${entity_name}`);

      // Data is safely stored in submodule_run_item_data (above).
      // Strip downloadable fields from result so pool_items stays lean.
      // We intentionally do NOT use extractToBlob — _blob_ref + hydrateItems
      // restores content for ALL modules, defeating selective field loading
      // via requires_columns. Direct delete + enrichment = selective loading.
      if (!insertFailed) {
        for (const item of result.items) {
          for (const field of downloadFieldNames) {
            delete item[field];
          }
        }
        console.log(`[worker:entity] Stripped ${downloadFieldNames.join(', ')} from ${result.items.length} items for ${submodule_id}/${entity_name} (preserved in item_data)`);
      } else {
        console.warn(`[worker:entity] Keeping downloadable fields inline for ${submodule_id}/${entity_name} because item_data insert failed`);
      }
    }
  }

  // 9b. Strip enriched-but-not-produced fields from output.
  // Transform modules (e.g. intent-tagger) use { ...item, newField } which copies
  // enriched fields (like text_content) back into output, re-inflating pool_items.
  // Strip any enriched field that the module doesn't declare as its own output.
  if (enrichedFields.size > 0 && result?.items) {
    const outputFields = new Set(Object.keys(manifest.output_schema || {}));
    const moduleDownloadable = new Set((manifest.output_schema?.downloadable_fields || []).map(d => d.field));
    for (const item of result.items) {
      for (const field of enrichedFields) {
        // Keep if module declares it as its own output or as downloadable
        if (!outputFields.has(field) && !moduleDownloadable.has(field)) {
          delete item[field];
        }
      }
    }
  }

  // 10. Check if run was aborted while we were executing.
  //     If so, still save results — the work is done, don't throw it away.
  const { data: currentRun } = await db
    .from('entity_submodule_runs')
    .select('status')
    .eq('id', entity_submodule_run_id)
    .single();
  const wasAborted = currentRun?.status === 'failed';
  if (wasAborted) {
    console.log(`[worker:entity] ${submodule_id}/${entity_name} was aborted during execution — saving results anyway`);
  }

  // 11. Write result to entity_submodule_runs
  //     Sanitize: PostgreSQL JSONB rejects \u0000 (null bytes) in text.
  //     Scraped HTML/content may contain them. Strip before writing.
  const sanitizedResult = JSON.parse(JSON.stringify(result).replace(/\\u0000/g, ''));
  // A module that RETURNS an error result (meta.status==='error') for this entity
  // — e.g. content-writer "fetch failed", seo-planner parse-fail — did NOT throw,
  // so without this it was written as 'completed', masking the failure and
  // starving the auto-executor failure-rate threshold. deriveEntityRunStatus
  // flags those as 'failed' while leaving valid QA verdicts (qa_pass:false) as
  // 'completed'. Output is still saved either way so the error item is visible.
  const { status: entityStatus, error: entityError } = deriveEntityRunStatus(result);
  if (entityStatus === 'failed') {
    console.warn(`[worker:entity] ${submodule_id}/${entity_name} returned an ERROR result (not thrown) — marking failed: ${entityError}`);
  }
  const { error: writeErr } = await db
    .from('entity_submodule_runs')
    .update({
      status: entityStatus,
      ...(entityError ? { error: entityError } : {}),
      output_data: sanitizedResult,
      output_render_schema: manifest.output_schema || null,
      logs: tools._logs,
      progress: { current: tools.progress.lastTotal, total: tools.progress.lastTotal, message: entityStatus === 'failed' ? 'Failed' : 'Done' },
      completed_at: new Date().toISOString(),
    })
    .eq('id', entity_submodule_run_id);

  if (writeErr) {
    console.error(`[worker:entity] Output write failed for ${submodule_id}/${entity_name}: ${writeErr.message}`);
    await db
      .from('entity_submodule_runs')
      .update({ status: 'failed', error: `Output write failed: ${writeErr.message}`, logs: tools._logs, completed_at: new Date().toISOString() })
      .eq('id', entity_submodule_run_id);
    throw writeErr;
  }

  // 11. Mirror the run status into entity_stage_pool. batchWorker derives
  //      pipeline_stages.completed_count/failed_count from the POOL status, so a
  //      returned-error entity must be 'failed' here too — otherwise the headline
  //      "N completed, 0 failed" count keeps masking the failure even though the
  //      run row is 'failed'. (The throw-path already mirrors run status to the
  //      pool; this makes the return-path consistent.)
  await db
    .from('entity_stage_pool')
    .update({ status: entityStatus, updated_at: new Date().toISOString() })
    .eq('run_id', entityRun.run_id)
    .eq('step_index', step_index)
    .eq('entity_name', entity_name);

  const duration_ms = Date.now() - startTime;
  console.log(`[worker:entity] ${entityStatus === 'failed' ? 'FAILED' : 'Completed'}: ${submodule_id} for "${entity_name}" (${(duration_ms / 1000).toFixed(1)}s)`);
  logMetric({ run_id: entityRun.run_id, submodule_id, entity_name, status: entityStatus, duration_ms, step_index, cost: manifest.cost || 'medium' });
  return result;
}

// Create the worker — per-entity only (legacy flat-pool removed)
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '2', 10);

const worker = new Worker(
  'pipeline-stages-v2',
  async (job) => {
    return handleEntityJob(job);
  },
  {
    connection: redis,
    concurrency: WORKER_CONCURRENCY,
    stalledInterval: 60000,
    maxStalledCount: 2,        // Mark job as failed after 2 stall detections
    lockDuration: 120000,      // 2 min lock — prevents premature stall detection for slow jobs
  }
);

worker.on('failed', (job, err) => {
  console.error(`[worker] Job ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts?.attempts}): ${err.message}`);
});

worker.on('stalled', (jobId) => {
  console.warn(`[worker] Job ${jobId} stalled — worker may have crashed or lost connection`);
});

worker.on('error', (err) => {
  console.error(`[worker] Worker error: ${err.message}`);
});

worker.on('ready', () => {
  console.log(`[worker] Pipeline stage worker ready (concurrency: ${WORKER_CONCURRENCY})`);
});

// Graceful shutdown — close worker and browser on SIGTERM/SIGINT
async function shutdown() {
  console.log('[worker] Shutting down...');
  try {
    const { closeBrowser } = await import('../services/browserPool.js');
    await closeBrowser();
  } catch (_) { /* browser may not have been loaded */ }
  await worker.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default worker;
