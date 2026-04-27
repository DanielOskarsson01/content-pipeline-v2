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
import { extractToBlob, hydrateItems } from '../services/poolBlobs.js';

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
        reject(new Error(`HTTP request timed out after ${ms}ms`));
      }, ms);
      fn(controller.signal).then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  const http = {
    get: async (url, options = {}) => {
      const timeout = options.timeout || 30000;
      return withTimeout(async (signal) => {
        const res = await fetch(url, { signal, headers: options.headers || {} });
        const body = await res.text();
        return { status: res.status, headers: Object.fromEntries(res.headers), body, url: res.url };
      }, timeout);
    },
    head: async (url, options = {}) => {
      const timeout = options.timeout || 30000;
      return withTimeout(async (signal) => {
        const res = await fetch(url, { method: 'HEAD', signal, headers: options.headers || {} });
        return { status: res.status, headers: Object.fromEntries(res.headers), url: res.url };
      }, timeout);
    },
    post: async (url, body, options = {}) => {
      const timeout = options.timeout || 30000;
      return withTimeout(async (signal) => {
        const res = await fetch(url, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        });
        const responseBody = await res.text();
        return { status: res.status, headers: Object.fromEntries(res.headers), body: responseBody };
      }, timeout);
    },
  };

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

  // Per-request timeout for LLM API calls (5 minutes).
  // Generous for large prompts (content-writer: 100KB+). Cheap modules are bounded
  // by their entity-level COST_CONFIG timeout (2-5 min) which fires first.
  const AI_REQUEST_TIMEOUT_MS = 300_000;

  // Retry config for transient failures
  const AI_MAX_RETRIES = 3;
  const AI_BASE_DELAY_MS = 2000; // 2s → 4s → 8s exponential backoff

  const ai = {
    complete: async ({ prompt, model = 'haiku', provider = 'anthropic', temperature, max_tokens }) => {
      const startTime = Date.now();
      const modelId = MODEL_MAP[model] || model;

      // Inner function that makes a single API call with timeout
      async function callProvider(attempt) {
        if (provider === 'anthropic') {
          const apiKey = process.env.ANTHROPIC_API_KEY;
          if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in environment');

          const { status, body } = await withTimeout(async (signal) => {
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
                messages: [{ role: 'user', content: prompt }],
                ...(temperature != null && { temperature }),
              }),
            });
            return { status: res.status, body: await res.text() };
          }, AI_REQUEST_TIMEOUT_MS);

          if (status !== 200) {
            const err = new Error(`Anthropic API error ${status}: ${body.slice(0, 500)}`);
            err.statusCode = status;
            throw err;
          }

          const data = JSON.parse(body);
          const duration_ms = Date.now() - startTime;
          const stopReason = data.stop_reason || 'unknown';
          const result = {
            text: data.content?.[0]?.text || '',
            tokens_in: data.usage?.input_tokens || 0,
            tokens_out: data.usage?.output_tokens || 0,
            model: modelId,
            provider: 'anthropic',
            stop_reason: stopReason,
            duration_ms,
          };
          if (stopReason === 'max_tokens') {
            logger.warn(`[ai] ${provider}/${model} — response TRUNCATED (hit max_tokens). Output may be incomplete.`);
          }
          logger.info(`[ai] ${provider}/${model} — ${result.tokens_in} in, ${result.tokens_out} out, ${duration_ms}ms, stop: ${stopReason}`);
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

        } else {
          throw new Error(`Unknown AI provider: "${provider}". Supported: anthropic, openai`);
        }
      }

      // Retry loop with exponential backoff for transient errors
      let lastError;
      for (let attempt = 1; attempt <= AI_MAX_RETRIES; attempt++) {
        try {
          return await callProvider(attempt);
        } catch (err) {
          lastError = err;
          const isTransient = !err.statusCode                          // Network/timeout errors (no HTTP status)
            || RETRYABLE_STATUSES.has(err.statusCode);                 // Retryable HTTP statuses

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

  // 7b. Enrich: merge downloadable fields from upstream for this entity's items
  const requiresColumns = manifest.requires_columns || [];
  const entityItems = input?.entity?.items || [];
  if (requiresColumns.length > 0 && entityItems.length > 0) {
    const sampleItems = entityItems.slice(0, 10);
    const missingColumns = requiresColumns.filter(col =>
      sampleItems.every(item => !item[col] || String(item[col]).length === 0)
    );

    if (missingColumns.length > 0) {
      console.log(`[worker:entity] Enriching "${entity_name}": ${missingColumns.join(', ')} missing from ${entityItems.length} items`);

      // Find upstream completed entity_submodule_runs for this entity
      const pipelineRunId = entityRun.run_id;
      const { data: upstreamRuns } = await db
        .from('entity_submodule_runs')
        .select('id')
        .eq('run_id', pipelineRunId)
        .eq('entity_name', entity_name)
        .in('status', ['completed', 'approved']);

      const upstreamRunIds = (upstreamRuns || []).map(r => r.id)
        .filter(id => id !== entity_submodule_run_id);

      if (upstreamRunIds.length > 0) {
        const itemKeyField = manifest.item_key || 'url';
        const itemKeys = [...new Set(
          entityItems.map(item => String(item[itemKeyField] ?? '')).filter(Boolean)
        )];

        const ENRICH_BATCH = 200;
        const lookup = new Map();
        for (let i = 0; i < itemKeys.length; i += ENRICH_BATCH) {
          const keyBatch = itemKeys.slice(i, i + ENRICH_BATCH);
          const { data: itemData } = await db
            .from('submodule_run_item_data')
            .select('item_key, field_name, content')
            .in('submodule_run_id', upstreamRunIds)
            .in('field_name', missingColumns)
            .in('item_key', keyBatch);

          for (const row of (itemData || [])) {
            if (!lookup.has(row.item_key)) lookup.set(row.item_key, {});
            lookup.get(row.item_key)[row.field_name] = row.content;
          }
        }

        let mergedCount = 0;
        for (const item of entityItems) {
          const key = String(item[itemKeyField] ?? '');
          const extra = lookup.get(key);
          if (extra) {
            Object.assign(item, extra);
            mergedCount++;
          }
        }
        console.log(`[worker:entity] Enriched ${mergedCount}/${entityItems.length} items for "${entity_name}"`);
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

      // Strip large downloadable fields from result ONLY if all inserts succeeded.
      // If inserts failed (e.g. FK constraint), keep data inline so it's not lost.
      // Fields are stored in pool_item_blobs (for downstream pool consumers like
      // bundlers and reports) and in submodule_run_item_data (for download button UI).
      const totalSize = itemDataRows.reduce((sum, row) => sum + row.content.length, 0);
      if (!insertFailed && totalSize > 1 * 1024 * 1024) {
        for (const item of result.items) {
          await extractToBlob(item, downloadFieldNames);
        }
      } else if (insertFailed) {
        console.warn(`[worker:entity] Keeping downloadable fields inline for ${submodule_id}/${entity_name} because item_data insert failed`);
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
  const { error: writeErr } = await db
    .from('entity_submodule_runs')
    .update({
      status: 'completed',
      output_data: sanitizedResult,
      output_render_schema: manifest.output_schema || null,
      logs: tools._logs,
      progress: { current: tools.progress.lastTotal, total: tools.progress.lastTotal, message: 'Done' },
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

  // 11. Update entity_stage_pool status to 'completed'
  await db
    .from('entity_stage_pool')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('run_id', entityRun.run_id)
    .eq('step_index', step_index)
    .eq('entity_name', entity_name);

  const duration_ms = Date.now() - startTime;
  console.log(`[worker:entity] Completed: ${submodule_id} for "${entity_name}" (${(duration_ms / 1000).toFixed(1)}s)`);
  logMetric({ run_id: entityRun.run_id, submodule_id, entity_name, status: 'completed', duration_ms, step_index, cost: manifest.cost || 'medium' });
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
