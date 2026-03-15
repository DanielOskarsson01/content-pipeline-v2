/**
 * Pipeline Stage Worker — BullMQ worker that executes submodules.
 *
 * Job payload: { submodule_run_id, submodule_id, step_index }
 * The worker loads input_data and options from the submodule_runs row,
 * then loads execute.js from MODULES_PATH and calls it.
 */

import { Worker } from 'bullmq';
import path from 'path';
import { pathToFileURL } from 'url';
import db from '../services/db.js';
import { redis } from '../services/queue.js';
import { loadModules, getSubmoduleById } from '../services/moduleLoader.js';
import { notifyCompletion, notifyFailure } from '../services/webhookNotifier.js';

// Load submodule manifests (worker is a separate process from server.js)
loadModules();

const COST_TIMEOUTS = {
  cheap: 5 * 60 * 1000,
  medium: 15 * 60 * 1000,
  expensive: 30 * 60 * 1000,
};

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
 */
function buildTools(submoduleRunId, submoduleId) {
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
      db.from('submodule_runs')
        .update({ progress: progressData })
        .eq('id', submoduleRunId)
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

  return { logger, http, browser, progress, ai, _logs: logs };
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

// Create the worker
const worker = new Worker(
  'pipeline-stages-v2',
  async (job) => {
    const { submodule_run_id, submodule_id, step_index } = job.data;

    console.log(`[worker] Processing job ${job.id}: ${submodule_id} (step ${step_index})`);

    // 1. Load submodule_runs row
    const { data: run, error: runErr } = await db
      .from('submodule_runs')
      .select('*')
      .eq('id', submodule_run_id)
      .single();

    if (runErr || !run) {
      throw new Error(`submodule_runs row not found: ${submodule_run_id}`);
    }

    // 2. Look up manifest
    const manifest = getSubmoduleById(submodule_id);
    if (!manifest) {
      throw new Error(`Submodule not found in registry: ${submodule_id}`);
    }

    // 3. Mark as running
    await db
      .from('submodule_runs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', submodule_run_id);

    // 4. Load execute function
    const executeFn = await loadExecuteFunction(manifest);

    // 5. Build tools
    const tools = buildTools(submodule_run_id, submodule_id);

    // 6. Set up timeout (with cleanup to prevent leaked timers)
    const cost = manifest.cost || 'medium';
    const timeout = COST_TIMEOUTS[cost] || COST_TIMEOUTS.medium;
    let timeoutTimer;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error(`Execution timed out after ${timeout / 1000}s`)), timeout);
    });

    // 7. Prepare input + options
    const input = run.input_data;
    const options = run.options || manifest.options_defaults || {};

    // 7b. Enrich input items with downloadable fields from upstream submodule runs.
    //     Downloadable fields (e.g. text_content) are stored separately in
    //     submodule_run_item_data and stripped from pool items to prevent row-size
    //     limits. If this submodule requires those fields, merge them back in-memory.
    const requiresColumns = manifest.requires_columns || [];
    if (requiresColumns.length > 0 && input?.entities?.length > 0) {
      const allItems = input.entities.flatMap(e => e.items || []);
      if (allItems.length > 0) {
        const sampleItems = allItems.slice(0, 10);
        const missingColumns = requiresColumns.filter(col =>
          sampleItems.every(item => !item[col] || String(item[col]).length === 0)
        );

        if (missingColumns.length > 0) {
          console.log(`[worker] Enriching: ${missingColumns.join(', ')} missing from ${allItems.length} items`);

          // Find all completed/approved submodule_run_ids for this pipeline run
          const pipelineRunId = input.run_id || run.run_id;
          const { data: upstreamRuns } = await db
            .from('submodule_runs')
            .select('id')
            .eq('run_id', pipelineRunId)
            .in('status', ['completed', 'approved']);

          const upstreamRunIds = (upstreamRuns || []).map(r => r.id)
            .filter(id => id !== submodule_run_id);

          if (upstreamRunIds.length > 0) {
            // Collect all item keys (URLs) from input
            const itemKeys = [...new Set(
              allItems.map(item => String(item.url ?? '')).filter(Boolean)
            )];

            // Fetch from separate table in batches
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

            // Merge into items in memory (not persisted back to DB)
            let mergedCount = 0;
            for (const entity of input.entities) {
              for (const item of (entity.items || [])) {
                const key = String(item.url ?? '');
                const extra = lookup.get(key);
                if (extra) {
                  Object.assign(item, extra);
                  mergedCount++;
                }
              }
            }
            console.log(`[worker] Enriched ${mergedCount}/${allItems.length} items with ${missingColumns.join(', ')}`);
          }
        }
      }
    }

    // 8. Execute with timeout
    let result;
    try {
      result = await Promise.race([executeFn(input, options, tools), timeoutPromise]);
    } catch (err) {
      // Write failure
      await db
        .from('submodule_runs')
        .update({
          status: 'failed',
          error: err.message,
          logs: tools._logs,
          completed_at: new Date().toISOString(),
        })
        .eq('id', submodule_run_id);
      notifyFailure({ submoduleId: submodule_id, submoduleRunId: submodule_run_id, runId: run.run_id, stepIndex: step_index, error: err.message });
      throw err;
    } finally {
      clearTimeout(timeoutTimer);
    }

    // 9. Store downloadable fields separately, then write stripped result to main row.
    //    This prevents row-size limits from losing data (e.g. 1000+ pages of text_content).
    const downloadFieldDefs = manifest.output_schema?.downloadable_fields || [];
    if (downloadFieldDefs.length > 0 && result?.results) {
      const downloadFieldNames = downloadFieldDefs.map((d) => d.field);
      const itemKeyField = manifest.item_key || 'url';
      const itemDataRows = [];

      for (const entityResult of result.results) {
        for (const item of (entityResult.items || [])) {
          const key = String(item[itemKeyField] ?? '');
          if (!key) continue;
          for (const field of downloadFieldNames) {
            const content = item[field];
            if (content != null) {
              // Serialize objects as JSON, primitives as strings
              const serialized = (typeof content === 'object')
                ? JSON.stringify(content)
                : String(content);
              if (serialized.length > 0) {
                itemDataRows.push({
                  submodule_run_id: submodule_run_id,
                  item_key: key,
                  field_name: field,
                  content: serialized,
                });
              }
            }
          }
        }
      }

      // Batch insert to separate table
      if (itemDataRows.length > 0) {
        const BATCH_SIZE = 500;
        let storedCount = 0;
        for (let i = 0; i < itemDataRows.length; i += BATCH_SIZE) {
          const batch = itemDataRows.slice(i, i + BATCH_SIZE);
          const { error: itemErr } = await db
            .from('submodule_run_item_data')
            .insert(batch);
          if (itemErr) {
            console.warn(`[worker] Failed to store item data batch ${i}/${itemDataRows.length} for ${submodule_id}: ${itemErr.message}`);
          } else {
            storedCount += batch.length;
          }
        }
        console.log(`[worker] Stored ${storedCount}/${itemDataRows.length} downloadable field entries for ${submodule_id}`);
      }

      // Only strip from main result if total downloadable data is large (>1MB).
      // Small fields (e.g. analysis_json ~5KB) stay in output so they propagate
      // through the working pool to downstream submodules. Large fields (e.g.
      // text_content ~50MB) are stripped to prevent row-size limits.
      const totalDownloadableSize = itemDataRows.reduce((sum, row) => sum + row.content.length, 0);
      const STRIP_THRESHOLD = 1 * 1024 * 1024; // 1MB

      if (totalDownloadableSize > STRIP_THRESHOLD) {
        console.log(`[worker] Stripping ${downloadFieldNames.join(', ')} from output (${(totalDownloadableSize / 1024 / 1024).toFixed(1)}MB exceeds 1MB threshold)`);
        for (const entityResult of result.results) {
          for (const item of (entityResult.items || [])) {
            for (const field of downloadFieldNames) {
              delete item[field];
            }
          }
        }
      } else {
        console.log(`[worker] Keeping downloadable fields in output (${(totalDownloadableSize / 1024).toFixed(0)}KB under 1MB threshold)`);
      }
    }

    // 10. Write (now-stripped) result to main submodule_runs row
    const writePayload = {
      status: 'completed',
      output_data: result,
      output_render_schema: manifest.output_schema || null,
      logs: tools._logs,
      progress: { current: 1, total: 1, message: 'Done' },
      completed_at: new Date().toISOString(),
    };

    const { error: writeErr } = await db
      .from('submodule_runs')
      .update(writePayload)
      .eq('id', submodule_run_id);

    if (writeErr) {
      console.error(`[worker] Output write failed for ${submodule_id}: ${writeErr.message}`);
      await db
        .from('submodule_runs')
        .update({ status: 'failed', error: `Output write failed: ${writeErr.message}`, logs: tools._logs, completed_at: new Date().toISOString() })
        .eq('id', submodule_run_id);
      throw writeErr;
    }

    console.log(`[worker] Completed: ${submodule_id} (run ${submodule_run_id})`);
    notifyCompletion({ submoduleId: submodule_id, submoduleRunId: submodule_run_id, runId: run.run_id, stepIndex: step_index, result });
    return result;
  },
  {
    connection: redis,
    concurrency: 2,
    stalledInterval: 60000,
  }
);

worker.on('failed', (job, err) => {
  console.error(`[worker] Job ${job?.id} failed: ${err.message}`);
});

worker.on('ready', () => {
  console.log('[worker] Pipeline stage worker ready');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  try {
    const { closeBrowser } = await import('../services/browserPool.js');
    await closeBrowser();
  } catch (_) { /* browser may not have been loaded */ }
  await worker.close();
  process.exit(0);
});

export default worker;
