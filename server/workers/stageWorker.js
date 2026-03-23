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

  const http = {
    get: async (url, options = {}) => {
      const timeout = options.timeout || 30000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: options.headers || {},
        });
        const body = await res.text();
        return { status: res.status, headers: Object.fromEntries(res.headers), body };
      } finally {
        clearTimeout(timer);
      }
    },
    head: async (url, options = {}) => {
      const timeout = options.timeout || 30000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, {
          method: 'HEAD',
          signal: controller.signal,
          headers: options.headers || {},
        });
        return { status: res.status, headers: Object.fromEntries(res.headers) };
      } finally {
        clearTimeout(timer);
      }
    },
    post: async (url, body, options = {}) => {
      const timeout = options.timeout || 30000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        });
        const responseBody = await res.text();
        return { status: res.status, headers: Object.fromEntries(res.headers), body: responseBody };
      } finally {
        clearTimeout(timer);
      }
    },
  };

  const progress = {
    update: (current, total, message) => {
      // Fire-and-forget — progress writes should never crash the execute function
      const progressData = { current, total, message };
      db.from(progressTable)
        .update({ progress: progressData })
        .eq('id', runId)
        .then(({ error }) => {
          if (error) logger.warn(`Progress update failed: ${error.message}`);
        })
        .catch(() => { /* silent */ });
    },
  };

  const ai = {
    complete: async ({ prompt, model = 'haiku', provider = 'anthropic' }) => {
      const startTime = Date.now();
      const modelId = MODEL_MAP[model] || model;

      if (provider === 'anthropic') {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in environment');

        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: modelId,
            max_tokens: 8192,
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        const body = await res.text();
        if (res.status !== 200) {
          throw new Error(`Anthropic API error ${res.status}: ${body}`);
        }

        const data = JSON.parse(body);
        const duration_ms = Date.now() - startTime;
        const result = {
          text: data.content?.[0]?.text || '',
          tokens_in: data.usage?.input_tokens || 0,
          tokens_out: data.usage?.output_tokens || 0,
          model: modelId,
          provider: 'anthropic',
          duration_ms,
        };
        logger.info(`[ai] ${provider}/${model} — ${result.tokens_in} in, ${result.tokens_out} out, ${duration_ms}ms`);
        return result;

      } else if (provider === 'openai') {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error('OPENAI_API_KEY not set in environment');

        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        const body = await res.text();
        if (res.status !== 200) {
          throw new Error(`OpenAI API error ${res.status}: ${body}`);
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
    },
  };

  const browser = {
    fetch: async (url, options = {}) => {
      // Lazy import — Playwright only loaded when actually called
      const { browserFetch } = await import('../services/browserPool.js');
      return browserFetch(url, options);
    },
  };

  return { logger, http, browser, progress, ai, _logs: logs, _partialItems: [] };
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

  // 3. Mark as running
  await db
    .from('entity_submodule_runs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', entity_submodule_run_id);

  // 4. Load execute function
  const executeFn = await loadExecuteFunction(manifest);

  // 5. Build tools
  const tools = buildTools(entity_submodule_run_id, submodule_id);

  // 6. Timeout
  const cost = manifest.cost || 'medium';
  const costConfig = COST_CONFIG[cost] || COST_CONFIG.medium;
  const timeout = costConfig.timeout;
  let timeoutTimer;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new Error(`Execution timed out after ${timeout / 1000}s`)), timeout);
  });

  // 7. Prepare input — single entity format
  const input = entityRun.input_data;
  const options = entityRun.options || manifest.options_defaults || {};

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
    const rawResult = await Promise.race([executeFn(legacyInput, options, tools), timeoutPromise]);

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

    if (partialItems.length > 0) return; // Don't throw — partial success
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
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
      const totalSize = itemDataRows.reduce((sum, row) => sum + row.content.length, 0);
      if (!insertFailed && totalSize > 1 * 1024 * 1024) {
        for (const item of result.items) {
          for (const field of downloadFieldNames) {
            delete item[field];
          }
        }
      } else if (insertFailed) {
        console.warn(`[worker:entity] Keeping downloadable fields inline for ${submodule_id}/${entity_name} because item_data insert failed`);
      }
    }
  }

  // 10. Check if run was aborted while we were executing
  const { data: currentRun } = await db
    .from('entity_submodule_runs')
    .select('status')
    .eq('id', entity_submodule_run_id)
    .single();
  if (currentRun?.status === 'failed') {
    console.log(`[worker:entity] ${submodule_id}/${entity_name} was aborted during execution — discarding results`);
    return;
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
      progress: { current: 1, total: 1, message: 'Done' },
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

  console.log(`[worker:entity] Completed: ${submodule_id} for "${entity_name}"`);
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
