/**
 * Pure helpers for the tuning-session run-view UI (T2/T6). No React, no fetch —
 * decisions the UI renders, kept testable in the node vitest env.
 *
 * The server is the source of truth (resolveSessionParent / acceptExperiment);
 * these mirror its two rules so the UI can state, BEFORE a run, what the next
 * experiment will read and what a re-accept would destroy.
 */
import type { TuningSessionStep } from '../types/step';

export interface NextReads {
  source: 'chained' | 'pool';
  /** The accepted upstream step the next run will chain from (null when pool). */
  from: TuningSessionStep | null;
}

/**
 * What an experiment at `stepIndex` will read in session mode: the accepted
 * step nearest BELOW stepIndex (server's getAcceptedUpstream), else the raw
 * pool. Mirrors tuningSessions.js:getAcceptedUpstream exactly (step_index <
 * stepIndex, take the highest). An experiment falling back to the pool because
 * nothing is accepted upstream is thus stated explicitly, never inferred from
 * an absent chip.
 */
export function nextStepReads(steps: TuningSessionStep[], stepIndex: number): NextReads {
  const upstream = (steps || [])
    .filter((s) => s.step_index < stepIndex)
    .sort((a, b) => a.step_index - b.step_index);
  const from = upstream.length ? upstream[upstream.length - 1] : null;
  return from ? { source: 'chained', from } : { source: 'pool', from: null };
}

/**
 * The accepted steps a re-accept at `stepIndex` would ERASE — every accepted
 * step strictly downstream (step_index > stepIndex). Mirrors
 * acceptExperiment's erase-downstream (`.gt('step_index', stepIndex)`). Empty
 * array = nothing is lost, so no confirmation is needed.
 */
export function downstreamToErase(steps: TuningSessionStep[], stepIndex: number): TuningSessionStep[] {
  return (steps || [])
    .filter((s) => s.step_index > stepIndex)
    .sort((a, b) => a.step_index - b.step_index);
}

/**
 * The experiment "Promote to template" acts on at `stepIndex`: the accepted
 * experiment for this step from the persisted session — NOT the live Try-It
 * result. Returning it independently of any in-memory result is what lets the
 * promote entry point survive a modal close / panel reopen. null when this step
 * has nothing accepted (promote must not offer).
 */
export function promotableExperimentId(steps: TuningSessionStep[], stepIndex: number): string | null {
  return (steps || []).find((s) => s.step_index === stepIndex)?.experiment_id ?? null;
}
