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
import { getSubmoduleById } from '../services/moduleLoader.js';

const COST_TIMEOUTS = {
  cheap: 5 * 60 * 1000,
  medium: 15 * 60 * 1000,
  expensive: 30 * 60 * 1000,
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

  return { logger, http, progress, _logs: logs };
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
  'pipeline-stages',
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

    // 7. Execute with timeout
    const input = run.input_data;
    const options = run.options || manifest.options_defaults || {};

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
      throw err;
    } finally {
      clearTimeout(timeoutTimer);
    }

    // 8. Write success
    await db
      .from('submodule_runs')
      .update({
        status: 'completed',
        output_data: result,
        output_render_schema: manifest.output_schema || null,
        logs: tools._logs,
        progress: { current: 1, total: 1, message: 'Done' },
        completed_at: new Date().toISOString(),
      })
      .eq('id', submodule_run_id);

    console.log(`[worker] Completed: ${submodule_id} (run ${submodule_run_id})`);
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
  await worker.close();
  process.exit(0);
});

export default worker;
