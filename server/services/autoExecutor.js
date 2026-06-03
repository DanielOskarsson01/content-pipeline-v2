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
import {
  DEFAULT_FAILURE_THRESHOLDS,
  DEFAULT_THRESHOLD,
} from '../config/timeouts.js';
import { expandCardGroups } from './cardGroups.js';
import { resolveStepEntries } from './executionPlanUtils.js';

const PORT = process.env.PORT || 3001;
const LOCK_TTL = 300;       // 5 min Redis lock TTL
const LOCK_RENEW_INTERVAL = 60_000; // Renew every 60s
const MAX_BATCH_TIMEOUT = 6 * 60 * 60; // 6 hours — safety net per submodule batch, should never fire

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
      per_step_results: previousState?.per_step_results || {},
      routing_loops: previousState?.routing_loops || 0,
      routing_events: previousState?.routing_events || [],
      auto_resumed: previousState?.auto_resumed || false,
      paused_at_steps: previousState?.paused_at_steps || [],
      paused_after_submodules: previousState?.paused_after_submodules || [],
    };

    await db
      .from('pipeline_runs')
      .update({ status: 'auto_executing', auto_execute_state: initialState })
      .eq('id', runId);

    console.log(`[auto-execute] Starting run ${runId} — steps: ${config.steps.join(',')}, skip: ${(config.skipSteps || []).join(',')}`);

    const skipSteps = new Set(config.skipSteps || []);
    const submodulesPerStep = config.submodulesPerStep || {};
    // Multi-Card Pattern (sub-plan 1): UUID-keyed card definitions from the
    // execution_plan_snapshot. Legacy templates omit this → cardDefinitions = {}
    // → resolveStepEntries treats every entry as a legacy submodule_id and
    // expandCardGroups returns a single default group with all entities.
    const cardDefinitions = config.cardDefinitions || {};
    state = { ...initialState };

    // 3. Orchestration loop (do-while for routing loop continuation)
    let routingLoops = initialState.routing_loops;
    let routingTriggered = false;

    do {
    routingTriggered = false;

    for (const stepIndex of config.steps) {
      if (signal.aborted) break;

      state.current_step = stepIndex;
      await saveState(runId, state);

      // Check if step should be skipped (from template config)
      if (skipSteps.has(stepIndex)) {
        console.log(`[auto-execute] Step ${stepIndex}: skipping (template config)`);
        await safeSkipStep(runId, stepIndex);
        if (!state.steps_skipped.includes(stepIndex)) state.steps_skipped.push(stepIndex);
        await saveState(runId, state);
        continue;
      }

      // Pause before step (template config — user reviews entities before continuing)
      // Guard: only pause once per step (paused_at_steps tracks consumed pauses)
      if (config.pauseBeforeSteps?.includes(stepIndex) && !state.paused_at_steps.includes(stepIndex)) {
        console.log(`[auto-execute] ${runId}: pausing before step ${stepIndex}`);
        state.paused_at_steps.push(stepIndex);
        state.halt_reason = `Paused before step ${stepIndex} (template config)`;
        state.halted_at = new Date().toISOString();
        state.halted_step = stepIndex;
        await db
          .from('pipeline_runs')
          .update({ status: 'paused', auto_execute_state: state })
          .eq('id', runId);
        await cleanup();
        return;
      }

      // No submodules configured for this step → skip
      const stepSubmodules = submodulesPerStep[String(stepIndex)] || [];
      if (stepSubmodules.length === 0) {
        console.log(`[auto-execute] Step ${stepIndex}: skipping (no submodules configured)`);
        await safeSkipStep(runId, stepIndex);
        if (!state.steps_skipped.includes(stepIndex)) state.steps_skipped.push(stepIndex);
        await saveState(runId, state);
        continue;
      }

      // Check if stage is already completed/skipped (resume safety)
      const stageStatus = await getStageStatus(runId, stepIndex);
      if (stageStatus === 'completed' || stageStatus === 'skipped' || stageStatus === 'approved') {
        console.log(`[auto-execute] Step ${stepIndex}: already ${stageStatus}, skipping`);
        if (!state.steps_completed.includes(stepIndex)) state.steps_completed.push(stepIndex);
        await saveState(runId, state);
        continue;
      }

      if (signal.aborted) break;

      const stepStartTime = Date.now();
      const entityCount = await getEntityCount(runId, stepIndex);

      autoExecuteEvents.emit('step_started', {
        runId, stepIndex, submodules: stepSubmodules, entityCount,
      });

      console.log(`[auto-execute] Step ${stepIndex}: starting (${stepSubmodules.length} submodules, ${entityCount} entities)`);

      // -----------------------------------------------------------------
      // Multi-Card Pattern (sub-plan 1) — per-step entry preparation
      // -----------------------------------------------------------------
      // Resolve each submodules_per_step entry to {submodule_id, card_id, ...}.
      // Legacy templates (cardDefinitions == {}) all fall through to legacy
      // submodule_id string entries → existing behavior preserved.
      const resolvedEntries = resolveStepEntries(stepSubmodules, cardDefinitions);

      // Corruption guard (executionPlanUtils._corrupt flag): a UUID-format
      // entry that doesn't exist in card_definitions implies template editor
      // deleted a card without scrubbing submodules_per_step. Halt with a
      // clear reason rather than producing a confusing 404 at trigger time.
      const corrupt = resolvedEntries.find(e => e._corrupt);
      if (corrupt) {
        await haltRun(runId, state,
          `Corrupt card reference in submodules_per_step[${stepIndex}]: ${corrupt.card_id} not in card_definitions`,
          cleanup);
        return;
      }

      // Per-entity loop_count map (spec §3.2 — routing_round = loop_count at
      // creation time). Used to derive currentIteration per group. Loaded once
      // here because loop_count is stable within a single processStep invocation
      // (it increments at routing time, AFTER step completion).
      const { data: metaRows } = await db
        .from('entity_run_meta')
        .select('entity_name, loop_count')
        .eq('run_id', runId);
      const loopCountMap = new Map((metaRows || []).map(m => [m.entity_name, m.loop_count || 0]));
      const allEntities = Array.from(loopCountMap.keys());

      // Run each (submodule, card-group) sequentially
      for (const entry of resolvedEntries) {
        if (signal.aborted) break;
        const submoduleId = entry.submodule_id;

        // Expand to per-card_id groups. Legacy / Round-1 case → single default
        // group with all entities. Routed case → one card group per UUID in
        // entities' pending instructions, plus default group with the rest.
        const groups = await expandCardGroups(db, runId, stepIndex, submoduleId, allEntities, cardDefinitions);

        for (const group of groups) {
          if (signal.aborted) break;
          const cardId = group.card_id;

          // currentIteration derivation per spec §3.2. All card-group entities
          // share the same loop_iteration (per Brutal-critic Fix #1 atomic
          // dedup invariant). Default-group entities may mix iterations after
          // routing; the worst case is a redundant trigger that quickly
          // resolves via checkExistingSubmoduleRun → 'approved' → skip.
          const groupLoopCounts = group.entities.map(e => loopCountMap.get(e) ?? 0);
          const currentIteration = groupLoopCounts[0] ?? 0;
          if (groupLoopCounts.some(i => i !== currentIteration)) {
            console.warn(
              `[auto-execute] Step ${stepIndex}/${submoduleId} ` +
              `(card=${cardId || 'default'}): mixed entity loop_counts ` +
              `[${groupLoopCounts.join(',')}], using ${currentIteration}`
            );
          }

          // Check if this exact batch already has a run (resume safety) [#12]
          const existingRun = await checkExistingSubmoduleRun(runId, stepIndex, submoduleId, cardId, currentIteration);
          let batchId;
          let expectedEntityCount;

          if (existingRun) {
            if (existingRun.status === 'approved') {
              console.log(`[auto-execute] Step ${stepIndex}/${submoduleId} (card=${cardId || 'default'}, iter=${currentIteration}): already approved, skipping`);
              continue;
            }
            if (existingRun.status === 'completed') {
              if (config.pauseAfterSubmodules?.includes(submoduleId)) {
                console.warn(`[auto-execute] ${runId}: ${submoduleId} was in pause_after_submodules but resumed without manual approval — auto-approving all entities`);
              }
              console.log(`[auto-execute] Step ${stepIndex}/${submoduleId} (card=${cardId || 'default'}, iter=${currentIteration}): completed but not approved, approving now`);
              await waitForSubmoduleRunStatus(runId, stepIndex, submoduleId, cardId, currentIteration, 'completed', 120_000);
              await autoApproveSingleSubmodule(runId, stepIndex, submoduleId, cardId, currentIteration);
              continue;
            }
            if (existingRun.status === 'running') {
              console.log(`[auto-execute] Step ${stepIndex}/${submoduleId} (card=${cardId || 'default'}, iter=${currentIteration}): already running, polling existing batch`);
              batchId = existingRun.batch_id;
              expectedEntityCount = existingRun.entity_count;
            }
            // If failed → re-trigger below
          }

          if (!batchId) {
            // Trigger the submodule for this card group
            const triggerResult = await triggerSubmodule(runId, stepIndex, submoduleId, cardId, group.entities);
            if (!triggerResult) {
              // 409 handling [#14] — scoped to (cardId, currentIteration)
              const resolved = await handle409(runId, stepIndex, submoduleId, cardId, currentIteration);
              if (resolved === 'skip') continue;
              if (resolved === 'halt') {
                await haltRun(runId, state, `409 conflict: submodule ${submoduleId} (card=${cardId || 'default'}, iter=${currentIteration}) at step ${stepIndex} stuck`, cleanup);
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
                await haltRun(runId, state, `Enqueue failure at step ${stepIndex}/${submoduleId} (card=${cardId || 'default'}, iter=${currentIteration}): expected ${expectedEntityCount} entities, found ${actualCount}`, cleanup);
                return;
              }
            }
          }

          // Poll for completion — job-level timeouts (COST_CONFIG) handle per-entity limits.
          // MAX_BATCH_TIMEOUT is a safety net only (6 hours).
          const pollResult = await pollBatchCompletion(batchId, MAX_BATCH_TIMEOUT, signal);

          if (signal.aborted) break;

          if (pollResult === 'timeout') {
            // 6-hour safety net fired — something is catastrophically wrong
            await haltRun(runId, state, `Submodule ${submoduleId} (card=${cardId || 'default'}, iter=${currentIteration}) at step ${stepIndex} exceeded maximum batch timeout (6 hours)`, cleanup);
            return;
          }

          autoExecuteEvents.emit('submodule_completed', {
            runId, stepIndex, submoduleId, cardId, loopIteration: currentIteration, batchId,
            ...await getEntityCounts(batchId),
          });

          // Mid-step approve: approve this submodule batch immediately so downstream
          // batches in the same step can see its output in the pool.
          // Wait for batchWorker to finalize submodule_runs status first.
          await waitForSubmoduleRunStatus(runId, stepIndex, submoduleId, cardId, currentIteration, 'completed', 120_000);

          // Pause after this (submodule, card_id) group (template config — user
          // reviews & approves manually). pauseKey scopes to (step, submodule,
          // card_id) so different card groups pause independently — operators
          // can review per-card output before continuing.
          const pauseKey = `${stepIndex}:${submoduleId}:${cardId || 'default'}`;
          if (config.pauseAfterSubmodules?.includes(submoduleId) &&
              !state.paused_after_submodules?.includes(pauseKey)) {
            console.log(`[auto-execute] ${runId}: pausing after ${submoduleId} (card=${cardId || 'default'}) at step ${stepIndex} — manual approval required`);
            if (!state.paused_after_submodules) state.paused_after_submodules = [];
            state.paused_after_submodules.push(pauseKey);
            state.halt_reason = `Paused after ${submoduleId} (card=${cardId || 'default'}) — review results and approve before resuming`;
            state.halted_at = new Date().toISOString();
            state.halted_step = stepIndex;
            await db
              .from('pipeline_runs')
              .update({ status: 'paused', auto_execute_state: state })
              .eq('id', runId);
            await cleanup();
            return;
          }

          await autoApproveSingleSubmodule(runId, stepIndex, submoduleId, cardId, currentIteration);
        }
      }

      if (signal.aborted) break;

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

      // Escalation gate check (Phase 3): evaluate entity-level thresholds
      // before step approval. Marks entities below fail floor as terminal.
      const gateRule = config.escalationRules?.[String(stepIndex)];
      if (gateRule) {
        const gate = await evaluateEscalationGate(runId, stepIndex, gateRule);
        if (gate.belowFail.length > 0) {
          for (const name of gate.belowFail) {
            await db.from('entity_run_meta').upsert({
              run_id: runId, entity_name: name,
              terminal_state: 'failed', failure_reason: 'escalation_floor',
            }, { onConflict: 'run_id,entity_name' });
          }
          console.log(`[auto-execute] Gate ${stepIndex}: ${gate.belowFail.length} entities failed (below floor), ${gate.belowThreshold.length} below threshold`);
        }
        // Escalation submodule triggering: deferred until google-pse-curated-search exists (Phase 5)
      }

      if (signal.aborted) break;

      // Auto-approve step (submodules already approved individually above)
      console.log(`[auto-execute] Step ${stepIndex}: approving step`);
      const approveResult = await callEndpoint('POST', `/api/runs/${runId}/steps/${stepIndex}/approve`);

      // Routing: if routing step triggered routing, handle loop continuation
      if (approveResult?.routing_pending) {
        const summary = approveResult.routing || {};

        // All entities terminal — no backward routing, run complete
        if (summary.all_terminal || summary.routed_count === 0) {
          console.log(`[auto-execute] All entities terminal after routing`);
          state.per_step_results[String(stepIndex)] = {
            status: 'completed', ...evalResult,
            duration_ms: Date.now() - stepStartTime,
          };
          if (!state.steps_completed.includes(stepIndex)) state.steps_completed.push(stepIndex);
          await saveState(runId, state);
          continue; // let for-loop end naturally → completion
        }

        // Actual backward routing — loop continuation
        routingLoops++;

        const earliestStep = summary.earliest_step;
        if (earliestStep == null) {
          // Defensive: routed_count > 0 but no earliest_step — should never happen
          await haltRun(runId, state,
            `Routing returned routed_count=${summary.routed_count} but no earliest_step`,
            cleanup);
          return;
        }

        console.log(`[auto-execute] Routing loop ${routingLoops}: ` +
          `${summary.routed_count} entities routed to step ${earliestStep}`);

        // Record routing event in state
        state.routing_loops = routingLoops;
        if (!state.routing_events) state.routing_events = [];
        state.routing_events.push({
          loop: routingLoops,
          earliest_step: earliestStep,
          routed: summary.routed_count,
          approved: summary.approved_count,
          failed: summary.failed_count,
          flagged: summary.flagged_count,
          timestamp: new Date().toISOString(),
        });

        // Clean state for re-executed steps
        state.steps_completed = state.steps_completed.filter(s => s < earliestStep);
        for (const s of config.steps) {
          if (s >= earliestStep) delete state.per_step_results[String(s)];
        }
        await saveState(runId, state);

        autoExecuteEvents.emit('routing_loop', {
          runId, loop: routingLoops, earliestStep,
          routed: summary.routed_count,
        });

        routingTriggered = true;
        break; // break inner for-loop → do-while re-enters
      }

      state.per_step_results[String(stepIndex)] = {
        status: 'completed',
        ...evalResult,
        duration_ms: Date.now() - stepStartTime,
      };
      if (!state.steps_completed.includes(stepIndex)) state.steps_completed.push(stepIndex);
      await saveState(runId, state);

      autoExecuteEvents.emit('step_completed', {
        runId, stepIndex,
        duration_ms: Date.now() - stepStartTime,
        perStepResult: state.per_step_results[String(stepIndex)],
      });

      console.log(`[auto-execute] Step ${stepIndex}: completed (${evalResult.completed}/${evalResult.total} entities, ${(Date.now() - stepStartTime) / 1000}s)`);
    }

    } while (routingTriggered && !signal.aborted);

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

/**
 * Resume-safety scoped lookup per Multi-Card Pattern spec §6.2 + Sub-plan 1
 * resolved decision: cardId + loopIteration are LOAD-BEARING. A Round-2 query
 * without loopIteration scoping returns Round-1 batches → autoExecutor
 * incorrectly skips Round 2 entirely. card_id null vs UUID are distinct
 * paths (default group vs card-routed) and must NOT collapse.
 *
 * Requires schema migration adding submodule_runs.card_id UUID NULL +
 * loop_iteration INTEGER NOT NULL DEFAULT 0 (sub-plan 1 migration §2).
 */
async function checkExistingSubmoduleRun(runId, stepIndex, submoduleId, cardId, loopIteration) {
  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('run_id', runId)
    .eq('step_index', stepIndex)
    .single();

  if (!stage) return null;

  let query = db
    .from('submodule_runs')
    .select('id, status, batch_id, entity_count')
    .eq('stage_id', stage.id)
    .eq('submodule_id', submoduleId)
    .eq('loop_iteration', loopIteration);

  if (cardId === null || cardId === undefined) {
    query = query.is('card_id', null);
  } else {
    query = query.eq('card_id', cardId);
  }

  const { data } = await query
    .order('completed_at', { ascending: false, nullsFirst: false })
    .limit(1);

  return data?.[0] || null;
}

/**
 * Trigger /run for a specific (submodule, card_id) group. The card_id query
 * param drives card-aware options + prompt merge inside submoduleRuns.js
 * (cardDefinitions[card_id]) and the entity_submodule_runs card_id stamp.
 * The body's entities subset is the HIGHEST-priority input source on /run
 * (server/routes/submoduleRuns.js line 96), so passing it explicitly scopes
 * the batch to exactly the entities in this group.
 *
 * @param {string} runId
 * @param {number} stepIndex
 * @param {string} submoduleId
 * @param {string|null} cardId   null for default group; UUID for card-routed
 * @param {string[]} entities    entity names in this group
 */
async function triggerSubmodule(runId, stepIndex, submoduleId, cardId, entities) {
  try {
    const path = `/api/runs/${runId}/steps/${stepIndex}/submodules/${submoduleId}/run`
               + (cardId ? `?card_id=${encodeURIComponent(cardId)}` : '');
    const body = entities && entities.length > 0
      ? { entities: entities.map(e => ({ entity_name: e })) }
      : null;
    return await callEndpoint('POST', path, body);
  } catch (err) {
    if (err.message.includes('409')) return null;
    throw err;
  }
}

async function handle409(runId, stepIndex, submoduleId, cardId, loopIteration) {
  // Query existing run status, scoped to (card_id, loop_iteration) per Multi-Card spec.
  const existing = await checkExistingSubmoduleRun(runId, stepIndex, submoduleId, cardId, loopIteration);
  if (!existing) return 'halt';

  if (existing.status === 'approved') return 'skip';
  if (existing.status === 'completed') {
    // Completed but not approved — approve it (same fix as resume path)
    await waitForSubmoduleRunStatus(runId, stepIndex, submoduleId, cardId, loopIteration, 'completed', 120_000);
    await autoApproveSingleSubmodule(runId, stepIndex, submoduleId, cardId, loopIteration);
    return 'skip';
  }
  if (existing.status === 'failed') {
    // Clear the failed run and retry
    // Actually, the trigger endpoint auto-clears stuck runs >10min,
    // but a recently failed run can be re-triggered. Try once more.
    try {
      const path = `/api/runs/${runId}/steps/${stepIndex}/submodules/${submoduleId}/run`
                 + (cardId ? `?card_id=${encodeURIComponent(cardId)}` : '');
      return await callEndpoint('POST', path);
    } catch {
      return 'halt';
    }
  }

  // Status is running — wait 60s and recheck
  console.log(`[auto-execute] 409 at step ${stepIndex}/${submoduleId} (card=${cardId || 'default'}, iter=${loopIteration}): existing run is running, waiting 60s`);
  await sleep(60_000);

  const rechecked = await checkExistingSubmoduleRun(runId, stepIndex, submoduleId, cardId, loopIteration);
  if (!rechecked) return 'halt';
  if (rechecked.status === 'approved') return 'skip';
  if (rechecked.status === 'completed') {
    await waitForSubmoduleRunStatus(runId, stepIndex, submoduleId, cardId, loopIteration, 'completed', 120_000);
    await autoApproveSingleSubmodule(runId, stepIndex, submoduleId, cardId, loopIteration);
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

    try {
      // Check batch-level completion first. batchWorker fires when BullMQ finalizes the
      // parent flow job — which happens even when stalled child jobs are killed internally
      // without updating entity_submodule_runs. If the batch record is already done, exit
      // immediately rather than waiting the full 6h for zombie entity rows.
      const { data: batchRecord } = await db
        .from('submodule_runs')
        .select('status')
        .eq('batch_id', batchId)
        .maybeSingle();

      if (batchRecord && (batchRecord.status === 'completed' || batchRecord.status === 'failed')) {
        return 'done';
      }

      const { count } = await db
        .from('entity_submodule_runs')
        .select('id', { count: 'exact', head: true })
        .eq('batch_id', batchId)
        .in('status', ['pending', 'running']);

      if (count === 0) return 'done';
    } catch (dbErr) {
      // Transient DB connectivity error (e.g. 522 / fetch failed). Log and retry on
      // next interval — do NOT propagate, which would crash the auto-executor.
      console.warn(`[auto-execute] DB error polling batch ${batchId}, will retry: ${dbErr.message}`);
    }

    const elapsed = Date.now() - startTime;
    const interval = elapsed < FAST_DURATION ? FAST_INTERVAL : SLOW_INTERVAL;
    await sleep(Math.max(0, Math.min(interval, deadline - Date.now())));
  }

  return 'timeout';
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

/**
 * Evaluate escalation gate thresholds for a step (Phase 3).
 * Checks entity-level volume (item count) or quality (word count) against
 * per-template thresholds. Returns entities below threshold and below fail floor.
 */
async function evaluateEscalationGate(runId, stepIndex, rule) {
  const { data: pools } = await db.from('entity_stage_pool')
    .select('entity_name, pool_items')
    .eq('run_id', runId).eq('step_index', stepIndex);

  const belowThreshold = [];
  const belowFail = [];

  for (const pool of (pools || [])) {
    const items = pool.pool_items || [];

    // Volume gate (Step 2): count items
    if (rule.volume_threshold !== undefined) {
      const count = items.length;
      if (count < rule.volume_threshold) belowThreshold.push(pool.entity_name);
      if (rule.fail_threshold !== undefined && count < rule.fail_threshold) {
        belowFail.push(pool.entity_name);
      }
    }

    // Quality gate (Step 4): sum word counts
    if (rule.quality_threshold_words !== undefined) {
      const totalWords = items.reduce((s, i) => s + (i.word_count ?? 0), 0);
      if (totalWords < rule.quality_threshold_words) belowThreshold.push(pool.entity_name);
      if (rule.quality_fail_threshold !== undefined && totalWords < rule.quality_fail_threshold) {
        belowFail.push(pool.entity_name);
      }
    }
  }
  return { belowThreshold, belowFail };
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
  // Entity is "skipped_no_input" if ALL submodules were skipped (precondition not met) — not a failure.
  const entityStatuses = new Map();
  for (const run of allRuns) {
    const current = entityStatuses.get(run.entity_name) || 'completed';
    if (run.status === 'failed') {
      entityStatuses.set(run.entity_name, 'failed');
    } else if (run.status === 'skipped_no_input' && current !== 'failed') {
      entityStatuses.set(run.entity_name, 'skipped_no_input');
    } else if (current !== 'failed' && current !== 'skipped_no_input') {
      entityStatuses.set(run.entity_name, run.status);
    }
  }

  const totalCount = entityStatuses.size;
  const failedCount = [...entityStatuses.values()].filter(s => s === 'failed').length;
  const skippedCount = [...entityStatuses.values()].filter(s => s === 'skipped_no_input').length;
  const completedCount = totalCount - failedCount - skippedCount;
  // Composition errors (precondition not met) are excluded from the failure rate denominator —
  // they are not execution failures and must not trigger the halt threshold.
  const effectiveTotal = totalCount - skippedCount;
  const failureRate = effectiveTotal > 0 ? failedCount / effectiveTotal : 0;

  // Build error_summary — group by error string (first 50 chars, normalized)
  const errorSummary = {};
  for (const run of allRuns) {
    if (run.status === 'failed' && run.error) {
      const key = run.error.slice(0, 50).trim();
      errorSummary[key] = (errorSummary[key] || 0) + 1;
    }
  }

  return { completed: completedCount, failed: failedCount, skipped: skippedCount, total: totalCount, effectiveTotal, failureRate, errorSummary };
}

/**
 * Wait for batchWorker to finalize submodule_runs status.
 * pollBatchCompletion checks entity_submodule_runs (child rows) which finish
 * before the batchWorker updates the parent submodule_runs record.
 */
async function waitForSubmoduleRunStatus(runId, stepIndex, submoduleId, cardId, loopIteration, targetStatus, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const existing = await checkExistingSubmoduleRun(runId, stepIndex, submoduleId, cardId, loopIteration);
    if (existing && existing.status === targetStatus) return;
    if (existing && existing.status === 'approved') return; // already approved, even better
    if (existing && existing.status === 'failed') return;   // failed = no point waiting
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${submoduleId} (card=${cardId || 'default'}, iter=${loopIteration}) to reach status "${targetStatus}" after ${timeoutMs}ms — batchWorker may be down`);
}

async function autoApproveSingleSubmodule(runId, stepIndex, submoduleId, cardId, loopIteration) {
  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('run_id', runId)
    .eq('step_index', stepIndex)
    .single();

  if (!stage) return;

  // Scope to the specific (card_id, loop_iteration) batch — without this, a
  // multi-card step would auto-approve the WRONG submodule_run (different
  // group's batch), violating the per-card approval boundary.
  let subRunsQuery = db
    .from('submodule_runs')
    .select('id, batch_id, status')
    .eq('stage_id', stage.id)
    .eq('submodule_id', submoduleId)
    .eq('loop_iteration', loopIteration)
    .in('status', ['completed', 'failed']);

  if (cardId === null || cardId === undefined) {
    subRunsQuery = subRunsQuery.is('card_id', null);
  } else {
    subRunsQuery = subRunsQuery.eq('card_id', cardId);
  }

  const { data: subRuns } = await subRunsQuery;
  const subRun = subRuns?.[0];
  if (!subRun) return;

  const { data: entityNames } = await db
    .from('entity_submodule_runs')
    .select('entity_name')
    .eq('batch_id', subRun.batch_id)
    .eq('status', 'completed');

  const entityApprovals = {};
  const seen = new Set();
  for (const row of (entityNames || [])) {
    if (!seen.has(row.entity_name)) {
      entityApprovals[row.entity_name] = '__all__';
      seen.add(row.entity_name);
    }
  }

  // Rescue: failed entities that saved partial results (output_data is not null)
  // should still be approved so their scraped data flows to downstream steps.
  const { data: rescuable } = await db
    .from('entity_submodule_runs')
    .select('id, entity_name')
    .eq('batch_id', subRun.batch_id)
    .eq('status', 'failed')
    .not('output_data', 'is', null);

  if (rescuable?.length > 0) {
    for (const entity of rescuable) {
      // Re-mark as completed so the approval endpoint includes them
      await db
        .from('entity_submodule_runs')
        .update({ status: 'completed', error: null })
        .eq('id', entity.id);
      if (!seen.has(entity.entity_name)) {
        entityApprovals[entity.entity_name] = '__all__';
        seen.add(entity.entity_name);
      }
    }
    // Also update parent submodule_runs to 'completed' — the approval endpoint
    // rejects non-completed/approved status with 400.
    if (subRun.status === 'failed') {
      await db
        .from('submodule_runs')
        .update({ status: 'completed' })
        .eq('id', subRun.id);
    }
    console.log(`[auto-execute] Step ${stepIndex}/${submoduleId}: rescued ${rescuable.length} entities with partial results`);
  }

  if (Object.keys(entityApprovals).length === 0) return;

  console.log(`[auto-execute] Step ${stepIndex}/${submoduleId}: approving (${Object.keys(entityApprovals).length} entities)`);
  await callEndpoint('POST', `/api/submodule-runs/${subRun.id}/approve`, {
    entity_approvals: entityApprovals,
  });
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
