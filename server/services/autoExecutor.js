/**
 * Phase 12c: Auto-Execute Orchestrator
 *
 * Fire-and-forget server-side loop that replaces manual pipeline babysitting.
 * Uses DB polling for status checks + HTTP calls to localhost for mutations
 * (trigger, approve, skip) so all existing validation/middleware fires.
 *
 * Exports:
 *   executeRun(runId, config)     — start auto-execution (async, not awaited by caller)
 *   isAutoExecuting(runId)        — check in-memory registry
 *   abortAutoExecute(runId)       — signal abort via AbortController
 *   autoExecuteEvents             — EventEmitter for Pipeline Copilot integration
 */

import { EventEmitter } from 'events';
import db from './db.js';
import { redis } from './queue.js';
import { pipelineQueue } from './queue.js';
import {
  DEFAULT_FAILURE_THRESHOLDS,
  DEFAULT_THRESHOLD,
  DEFAULT_STEP_TIMEOUTS,
  DEFAULT_STEP_TIMEOUT,
  ENTITY_TIMEOUT_FACTOR,
  DEFAULT_ENTITY_FACTOR,
} from '../config/timeouts.js';

const PORT = process.env.PORT || 3001;
const LOCK_TTL = 300;       // 5 min Redis lock TTL
const LOCK_RENEW_INTERVAL = 60_000; // Renew every 60s

// --- EventEmitter ---
export const autoExecuteEvents = new EventEmitter();
autoExecuteEvents.on('error', (err) => {
  console.error('[auto-execute-events] Listener error:', err);
});

// --- In-memory registry ---
// runId → { controller: AbortController, lockInterval: NodeJS.Timer }
const activeRuns = new Map();

export function isAutoExecuting(runId) {
  return activeRuns.has(runId);
}

export function abortAutoExecute(runId) {
  const entry = activeRuns.get(runId);
  if (!entry) return false;
  entry.controller.abort();
  return true;
}

// ============================================================
// Core orchestrator
// ============================================================

export async function executeRun(runId, config, previousState = null) {
  const controller = new AbortController();
  const signal = controller.signal;
  const processId = `${process.pid}-${Date.now()}`;
  let lockInterval = null;
  let state = null;

  // Cleanup helper — called from every exit path
  const cleanup = async () => {
    if (lockInterval) clearInterval(lockInterval);
    activeRuns.delete(runId);
    await releaseLock(runId, processId);
  };

  try {
    // 1. Acquire Redis distributed lock
    const locked = await acquireLock(runId, processId);
    if (!locked) {
      console.warn(`[auto-execute] Could not acquire lock for run ${runId} — already running elsewhere`);
      return;
    }

    // Register in-memory
    lockInterval = setInterval(() => renewLock(runId, processId), LOCK_RENEW_INTERVAL);
    activeRuns.set(runId, { controller, lockInterval });

    // 2. Set run status to auto_executing (preserve previous state on resume)
    const initialState = {
      started_at: previousState?.started_at || new Date().toISOString(),
      current_step: null,
      steps_completed: previousState?.steps_completed || [],
      steps_skipped: previousState?.steps_skipped || [],
      failure_thresholds: config.failure_thresholds || {},
      step_timeouts: config.step_timeouts || {},
      per_step_results: previousState?.per_step_results || {},
    };

    await db
      .from('pipeline_runs')
      .update({ status: 'auto_executing', auto_execute_state: initialState })
      .eq('id', runId);

    console.log(`[auto-execute] Starting run ${runId} — steps: ${config.steps.join(',')}, skip: ${(config.skipSteps || []).join(',')}`);

    const skipSteps = new Set(config.skipSteps || []);
    const submodulesPerStep = config.submodulesPerStep || {};
    state = { ...initialState };

    // 3. Orchestration loop
    for (const stepIndex of config.steps) {
      if (signal.aborted) break;

      state.current_step = stepIndex;
      await saveState(runId, state);

      // Check if step should be skipped (from template config)
      if (skipSteps.has(stepIndex)) {
        console.log(`[auto-execute] Step ${stepIndex}: skipping (template config)`);
        await safeSkipStep(runId, stepIndex);
        state.steps_skipped.push(stepIndex);
        await saveState(runId, state);
        continue;
      }

      // No submodules configured for this step → skip
      const stepSubmodules = submodulesPerStep[String(stepIndex)] || [];
      if (stepSubmodules.length === 0) {
        console.log(`[auto-execute] Step ${stepIndex}: skipping (no submodules configured)`);
        await safeSkipStep(runId, stepIndex);
        state.steps_skipped.push(stepIndex);
        await saveState(runId, state);
        continue;
      }

      // Check if stage is already completed/skipped (resume safety)
      const stageStatus = await getStageStatus(runId, stepIndex);
      if (stageStatus === 'completed' || stageStatus === 'skipped' || stageStatus === 'approved') {
        console.log(`[auto-execute] Step ${stepIndex}: already ${stageStatus}, skipping`);
        state.steps_completed.push(stepIndex);
        await saveState(runId, state);
        continue;
      }

      if (signal.aborted) break;

      const stepStartTime = Date.now();
      const entityCount = await getEntityCount(runId, stepIndex);
      const stepTimeout = computeStepTimeout(stepIndex, entityCount, config.step_timeouts || {});

      autoExecuteEvents.emit('step_started', {
        runId, stepIndex, submodules: stepSubmodules, entityCount,
      });

      console.log(`[auto-execute] Step ${stepIndex}: starting (${stepSubmodules.length} submodules, ${entityCount} entities, timeout: ${stepTimeout}s)`);

      // Run each submodule sequentially
      let stepTimedOut = false;
      for (const submoduleId of stepSubmodules) {
        if (signal.aborted) break;

        // Check if submodule already has a run (resume safety) [#12]
        const existingRun = await checkExistingSubmoduleRun(runId, stepIndex, submoduleId);
        let batchId;
        let expectedEntityCount;

        if (existingRun) {
          if (existingRun.status === 'approved') {
            console.log(`[auto-execute] Step ${stepIndex}/${submoduleId}: already approved, skipping`);
            continue;
          }
          if (existingRun.status === 'completed') {
            // Submodule finished but was never approved (e.g. abort interrupted before approval).
            // Wait for batchWorker to finalize, then approve so output enters the pool.
            console.log(`[auto-execute] Step ${stepIndex}/${submoduleId}: completed but not approved, approving now`);
            await waitForSubmoduleRunStatus(runId, stepIndex, submoduleId, 'completed', 30_000);
            await autoApproveSingleSubmodule(runId, stepIndex, submoduleId);
            continue;
          }
          if (existingRun.status === 'running') {
            console.log(`[auto-execute] Step ${stepIndex}/${submoduleId}: already running, polling existing batch`);
            batchId = existingRun.batch_id;
            expectedEntityCount = existingRun.entity_count;
          }
          // If failed → re-trigger below
        }

        if (!batchId) {
          // Trigger the submodule
          const triggerResult = await triggerSubmodule(runId, stepIndex, submoduleId);
          if (!triggerResult) {
            // 409 handling [#14]
            const resolved = await handle409(runId, stepIndex, submoduleId);
            if (resolved === 'skip') continue;
            if (resolved === 'halt') {
              await haltRun(runId, state, `409 conflict: submodule ${submoduleId} at step ${stepIndex} stuck`, cleanup);
              return;
            }
            // resolved has batchId + entityCount from the existing run
            batchId = resolved.batchId;
            expectedEntityCount = resolved.entityCount;
          } else {
            batchId = triggerResult.batch_id;
            expectedEntityCount = triggerResult.entity_count;

            // Verify enqueue count [#11]
            const actualCount = await verifyEnqueueCount(batchId);
            if (actualCount !== expectedEntityCount) {
              autoExecuteEvents.emit('enqueue_mismatch', {
                runId, stepIndex, expected: expectedEntityCount, actual: actualCount, batchId,
              });
              await haltRun(runId, state, `Enqueue failure at step ${stepIndex}/${submoduleId}: expected ${expectedEntityCount} entities, found ${actualCount}`, cleanup);
              return;
            }
          }
        }

        // Poll for completion [#2, #10]
        const elapsed = (Date.now() - stepStartTime) / 1000;
        const remainingTimeout = stepTimeout - elapsed;
        if (remainingTimeout <= 0) {
          stepTimedOut = true;
          break;
        }

        const pollResult = await pollBatchCompletion(batchId, remainingTimeout, signal);

        if (signal.aborted) break;

        if (pollResult === 'timeout') {
          stepTimedOut = true;
          await cancelTimeoutEntities(batchId);
          autoExecuteEvents.emit('step_timeout', {
            runId, stepIndex,
            cancelledCount: await countEntitiesByStatus(batchId, ['pending', 'running']),
            completedCount: await countEntitiesByStatus(batchId, ['completed']),
          });
          break;
        }

        autoExecuteEvents.emit('submodule_completed', {
          runId, stepIndex, submoduleId, batchId,
          ...await getEntityCounts(batchId),
        });

        // Mid-step approve: approve this submodule immediately so downstream
        // submodules in the same step can see its output in the pool.
        // Wait for batchWorker to finalize submodule_runs status first (race condition fix).
        await waitForSubmoduleRunStatus(runId, stepIndex, submoduleId, 'completed', 30_000);
        await autoApproveSingleSubmodule(runId, stepIndex, submoduleId);
      }

      if (signal.aborted) break;

      if (stepTimedOut) {
        const evalResult = await evaluateStepResult(runId, stepIndex);
        state.per_step_results[String(stepIndex)] = {
          status: 'timeout',
          ...evalResult,
          duration_ms: Date.now() - stepStartTime,
        };
        await haltRun(runId, state, `Step ${stepIndex} timed out after ${stepTimeout}s`, cleanup);
        return;
      }

      // Evaluate failure [#6]
      const evalResult = await evaluateStepResult(runId, stepIndex);
      const threshold = getThreshold(stepIndex, config.failure_thresholds || {});

      autoExecuteEvents.emit('step_evaluated', {
        runId, stepIndex,
        failureRate: evalResult.failureRate,
        threshold,
        errorSummary: evalResult.errorSummary,
        passed: evalResult.failureRate <= threshold,
      });

      if (evalResult.failureRate > threshold) {
        state.per_step_results[String(stepIndex)] = {
          status: 'halted',
          ...evalResult,
          duration_ms: Date.now() - stepStartTime,
        };
        autoExecuteEvents.emit('threshold_halt', {
          runId, stepIndex,
          failureRate: evalResult.failureRate,
          threshold,
          errorSummary: evalResult.errorSummary,
        });
        await haltRun(runId, state, `Step ${stepIndex} failure rate ${(evalResult.failureRate * 100).toFixed(1)}% exceeds threshold ${(threshold * 100).toFixed(1)}%`, cleanup);
        return;
      }

      if (signal.aborted) break;

      // Auto-approve step (submodules already approved individually above)
      console.log(`[auto-execute] Step ${stepIndex}: approving step`);
      await callEndpoint('POST', `/api/runs/${runId}/steps/${stepIndex}/approve`);

      state.per_step_results[String(stepIndex)] = {
        status: 'completed',
        ...evalResult,
        duration_ms: Date.now() - stepStartTime,
      };
      state.steps_completed.push(stepIndex);
      await saveState(runId, state);

      autoExecuteEvents.emit('step_completed', {
        runId, stepIndex,
        duration_ms: Date.now() - stepStartTime,
        perStepResult: state.per_step_results[String(stepIndex)],
      });

      console.log(`[auto-execute] Step ${stepIndex}: completed (${evalResult.completed}/${evalResult.total} entities, ${(Date.now() - stepStartTime) / 1000}s)`);
    }

    // Handle abort vs completion
    if (signal.aborted) {
      console.log(`[auto-execute] Run ${runId}: aborted at step ${state.current_step}`);
      await db
        .from('pipeline_runs')
        .update({ status: 'running', auto_execute_state: { ...state, halt_reason: 'Aborted by user', halted_at: new Date().toISOString(), halted_step: state.current_step } })
        .eq('id', runId);
      autoExecuteEvents.emit('run_aborted', { runId, abortedAtStep: state.current_step });
    } else {
      console.log(`[auto-execute] Run ${runId}: completed all steps`);
      await db
        .from('pipeline_runs')
        .update({ status: 'completed', completed_at: new Date().toISOString(), auto_execute_state: state })
        .eq('id', runId);
      autoExecuteEvents.emit('run_completed', {
        runId,
        stepsCompleted: state.steps_completed,
        totalDuration_ms: Date.now() - new Date(state.started_at).getTime(),
      });
    }

    await cleanup();
  } catch (err) {
    console.error(`[auto-execute] Run ${runId} error:`, err);
    autoExecuteEvents.emit('execution_error', { runId, stepIndex: state?.current_step ?? null, error: err.message });
    try {
      const haltState = state
        ? { ...state, halt_reason: `Unhandled error: ${err.message}`, halted_at: new Date().toISOString(), halted_step: state.current_step }
        : { halt_reason: `Unhandled error: ${err.message}`, halted_at: new Date().toISOString() };
      await db
        .from('pipeline_runs')
        .update({ status: 'halted', auto_execute_state: haltState })
        .eq('id', runId);
    } catch (dbErr) {
      console.error(`[auto-execute] Failed to halt run ${runId}:`, dbErr);
    }
    await cleanup();
  }
}

// ============================================================
// Helpers
// ============================================================

async function callEndpoint(method, path, body = null) {
  const url = `http://127.0.0.1:${PORT}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  let res = await fetch(url, opts);

  // Single retry on 5xx
  if (res.status >= 500) {
    console.warn(`[auto-execute] ${method} ${path} returned ${res.status}, retrying in 5s`);
    await sleep(5000);
    res = await fetch(url, opts);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// --- Redis lock ---

async function acquireLock(runId, processId) {
  const key = `auto_execute:${runId}`;
  const result = await redis.set(key, processId, 'NX', 'EX', LOCK_TTL);
  return result === 'OK';
}

async function renewLock(runId, processId) {
  const key = `auto_execute:${runId}`;
  const current = await redis.get(key);
  if (current === processId) {
    await redis.expire(key, LOCK_TTL);
  }
}

async function releaseLock(runId, processId) {
  const key = `auto_execute:${runId}`;
  const current = await redis.get(key);
  if (current === processId) {
    await redis.del(key);
  }
}

// --- DB helpers ---

async function getStageStatus(runId, stepIndex) {
  const { data } = await db
    .from('pipeline_stages')
    .select('status')
    .eq('run_id', runId)
    .eq('step_index', stepIndex)
    .single();
  return data?.status;
}

async function getEntityCount(runId, stepIndex) {
  const { count } = await db
    .from('entity_stage_pool')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId)
    .eq('step_index', stepIndex);
  return count || 0;
}

async function checkExistingSubmoduleRun(runId, stepIndex, submoduleId) {
  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('run_id', runId)
    .eq('step_index', stepIndex)
    .single();

  if (!stage) return null;

  const { data } = await db
    .from('submodule_runs')
    .select('id, status, batch_id, entity_count')
    .eq('stage_id', stage.id)
    .eq('submodule_id', submoduleId)
    .order('completed_at', { ascending: false, nullsFirst: false })
    .limit(1);

  return data?.[0] || null;
}

async function triggerSubmodule(runId, stepIndex, submoduleId) {
  try {
    return await callEndpoint('POST', `/api/runs/${runId}/steps/${stepIndex}/submodules/${submoduleId}/run`);
  } catch (err) {
    if (err.message.includes('409')) return null;
    throw err;
  }
}

async function handle409(runId, stepIndex, submoduleId) {
  // Query existing run status
  const existing = await checkExistingSubmoduleRun(runId, stepIndex, submoduleId);
  if (!existing) return 'halt';

  if (existing.status === 'approved') return 'skip';
  if (existing.status === 'completed') {
    // Completed but not approved — approve it (same fix as resume path)
    await waitForSubmoduleRunStatus(runId, stepIndex, submoduleId, 'completed', 30_000);
    await autoApproveSingleSubmodule(runId, stepIndex, submoduleId);
    return 'skip';
  }
  if (existing.status === 'failed') {
    // Clear the failed run and retry
    // Actually, the trigger endpoint auto-clears stuck runs >10min,
    // but a recently failed run can be re-triggered. Try once more.
    try {
      return await callEndpoint('POST', `/api/runs/${runId}/steps/${stepIndex}/submodules/${submoduleId}/run`);
    } catch {
      return 'halt';
    }
  }

  // Status is running — wait 60s and recheck
  console.log(`[auto-execute] 409 at step ${stepIndex}/${submoduleId}: existing run is running, waiting 60s`);
  await sleep(60_000);

  const rechecked = await checkExistingSubmoduleRun(runId, stepIndex, submoduleId);
  if (!rechecked) return 'halt';
  if (rechecked.status === 'approved') return 'skip';
  if (rechecked.status === 'completed') {
    await waitForSubmoduleRunStatus(runId, stepIndex, submoduleId, 'completed', 30_000);
    await autoApproveSingleSubmodule(runId, stepIndex, submoduleId);
    return 'skip';
  }
  if (rechecked.status === 'running') {
    // Still running — return the batch info so we can poll it
    return { batchId: rechecked.batch_id, entityCount: rechecked.entity_count };
  }

  return 'halt';
}

async function verifyEnqueueCount(batchId) {
  const { count } = await db
    .from('entity_submodule_runs')
    .select('id', { count: 'exact', head: true })
    .eq('batch_id', batchId);
  return count || 0;
}

async function pollBatchCompletion(batchId, timeoutSec, signal) {
  const deadline = Date.now() + (timeoutSec * 1000);
  const FAST_INTERVAL = 2000;
  const SLOW_INTERVAL = 15000;
  const FAST_DURATION = 30000;
  const startTime = Date.now();

  while (Date.now() < deadline) {
    if (signal.aborted) return 'aborted';

    const { count } = await db
      .from('entity_submodule_runs')
      .select('id', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .in('status', ['pending', 'running']);

    if (count === 0) return 'done';

    const elapsed = Date.now() - startTime;
    const interval = elapsed < FAST_DURATION ? FAST_INTERVAL : SLOW_INTERVAL;
    await sleep(Math.max(0, Math.min(interval, deadline - Date.now())));
  }

  return 'timeout';
}

async function countEntitiesByStatus(batchId, statuses) {
  const { count } = await db
    .from('entity_submodule_runs')
    .select('id', { count: 'exact', head: true })
    .eq('batch_id', batchId)
    .in('status', statuses);
  return count || 0;
}

async function getEntityCounts(batchId) {
  const { data } = await db
    .from('entity_submodule_runs')
    .select('status')
    .eq('batch_id', batchId);

  const rows = data || [];
  return {
    completed: rows.filter(r => r.status === 'completed').length,
    failed: rows.filter(r => r.status === 'failed').length,
    total: rows.length,
  };
}

async function evaluateStepResult(runId, stepIndex) {
  // Get all entity_submodule_runs for this step
  const { data: runs } = await db
    .from('entity_submodule_runs')
    .select('entity_name, status, error')
    .eq('run_id', runId)
    .eq('step_index', stepIndex);

  const allRuns = runs || [];

  // Group by entity — entity is "failed" if ANY submodule failed for it [#6]
  const entityStatuses = new Map();
  for (const run of allRuns) {
    const current = entityStatuses.get(run.entity_name) || 'completed';
    if (run.status === 'failed') {
      entityStatuses.set(run.entity_name, 'failed');
    } else if (current !== 'failed') {
      entityStatuses.set(run.entity_name, run.status);
    }
  }

  const totalCount = entityStatuses.size;
  const failedCount = [...entityStatuses.values()].filter(s => s === 'failed').length;
  const completedCount = totalCount - failedCount;
  const failureRate = totalCount > 0 ? failedCount / totalCount : 0;

  // Build error_summary — group by error string (first 50 chars, normalized)
  const errorSummary = {};
  for (const run of allRuns) {
    if (run.status === 'failed' && run.error) {
      const key = run.error.slice(0, 50).trim();
      errorSummary[key] = (errorSummary[key] || 0) + 1;
    }
  }

  return { completed: completedCount, failed: failedCount, total: totalCount, failureRate, errorSummary };
}

/**
 * Wait for batchWorker to finalize submodule_runs status.
 * pollBatchCompletion checks entity_submodule_runs (child rows) which finish
 * before the batchWorker updates the parent submodule_runs record.
 */
async function waitForSubmoduleRunStatus(runId, stepIndex, submoduleId, targetStatus, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const existing = await checkExistingSubmoduleRun(runId, stepIndex, submoduleId);
    if (existing && existing.status === targetStatus) return;
    if (existing && existing.status === 'approved') return; // already approved, even better
    if (existing && existing.status === 'failed') return;   // failed = no point waiting
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${submoduleId} to reach status "${targetStatus}" after ${timeoutMs}ms — batchWorker may be down`);
}

async function autoApproveSingleSubmodule(runId, stepIndex, submoduleId) {
  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('run_id', runId)
    .eq('step_index', stepIndex)
    .single();

  if (!stage) return;

  const { data: subRuns } = await db
    .from('submodule_runs')
    .select('id, batch_id, status')
    .eq('stage_id', stage.id)
    .eq('submodule_id', submoduleId)
    .in('status', ['completed']);

  const subRun = subRuns?.[0];
  if (!subRun) return;

  const { data: entityNames } = await db
    .from('entity_submodule_runs')
    .select('entity_name')
    .eq('batch_id', subRun.batch_id)
    .eq('status', 'completed');

  if (!entityNames?.length) return;

  const entityApprovals = {};
  const seen = new Set();
  for (const row of entityNames) {
    if (!seen.has(row.entity_name)) {
      entityApprovals[row.entity_name] = '__all__';
      seen.add(row.entity_name);
    }
  }

  console.log(`[auto-execute] Step ${stepIndex}/${submoduleId}: approving (${Object.keys(entityApprovals).length} entities)`);
  await callEndpoint('POST', `/api/submodule-runs/${subRun.id}/approve`, {
    entity_approvals: entityApprovals,
  });
}

async function cancelTimeoutEntities(batchId) {
  // Mark remaining pending/running entities as failed
  const now = new Date().toISOString();
  await db
    .from('entity_submodule_runs')
    .update({ status: 'failed', error: 'Step timeout exceeded', completed_at: now })
    .eq('batch_id', batchId)
    .in('status', ['pending', 'running']);

  // Try to remove pending BullMQ jobs (best effort)
  try {
    const { data: pendingRuns } = await db
      .from('entity_submodule_runs')
      .select('id')
      .eq('batch_id', batchId)
      .eq('status', 'failed')
      .like('error', 'Step timeout%');

    // BullMQ doesn't have a direct "remove by data" API,
    // but the jobs will fail on their own when the worker tries
    // to write results and sees the entity is already failed.
    // The status update above is the authoritative guard.
  } catch (err) {
    console.warn(`[auto-execute] Failed to clean up BullMQ jobs for batch ${batchId}:`, err.message);
  }
}

async function haltRun(runId, state, reason, cleanup) {
  console.warn(`[auto-execute] HALT run ${runId}: ${reason}`);
  state.halt_reason = reason;
  state.halted_at = new Date().toISOString();
  state.halted_step = state.current_step;

  await db
    .from('pipeline_runs')
    .update({ status: 'halted', auto_execute_state: state })
    .eq('id', runId);

  await cleanup();
}

/**
 * Skip a step safely — only calls the /skip API if the stage is "active".
 * Steps that are already completed/approved/skipped or don't exist are just logged.
 */
async function safeSkipStep(runId, stepIndex) {
  const status = await getStageStatus(runId, stepIndex);
  if (status === 'active') {
    await callEndpoint('POST', `/api/runs/${runId}/steps/${stepIndex}/skip`);
  } else {
    console.log(`[auto-execute] Step ${stepIndex}: stage is "${status || 'missing'}", no skip API call needed`);
  }
}

function computeStepTimeout(stepIndex, entityCount, overrides) {
  if (overrides[String(stepIndex)]) return overrides[String(stepIndex)];
  const base = DEFAULT_STEP_TIMEOUTS[stepIndex] || DEFAULT_STEP_TIMEOUT;
  const factor = ENTITY_TIMEOUT_FACTOR[stepIndex] || DEFAULT_ENTITY_FACTOR;
  return Math.max(entityCount * factor, base);
}

function getThreshold(stepIndex, overrides) {
  if (overrides[String(stepIndex)] !== undefined) return overrides[String(stepIndex)];
  return DEFAULT_FAILURE_THRESHOLDS[stepIndex] ?? DEFAULT_THRESHOLD;
}

async function saveState(runId, state) {
  await db
    .from('pipeline_runs')
    .update({ auto_execute_state: state })
    .eq('id', runId);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
