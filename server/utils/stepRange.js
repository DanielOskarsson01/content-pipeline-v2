/**
 * Step-range helper for the auto-executor's backward-routing loop.
 *
 * BACKLOG #29: a resumed run clamps config.steps to [haltedStep..N] (see the
 * resume endpoint in server/routes/runs.js). The auto-executor's backward-route
 * re-entry iterates that SAME config.steps. So when a route targets a step
 * BELOW the clamped range (earliestStep < min(steps)), the re-entry loop never
 * reaches it and Round 2 there cannot run. A non-paused auto-execute builds
 * config.steps=[0..N], so the clamp — and this fix — only matter on resume.
 */

/**
 * Widen a contiguous step-range down to `earliestStep` when a backward route
 * targets a step below the current iteration range.
 *
 * config.steps is always a contiguous ascending [min..max] range (built by both
 * the auto-execute and resume endpoints). When earliestStep is already within
 * range (>= min) the input is returned UNCHANGED (same reference) so callers can
 * detect a no-op via `result !== steps`. When it is below range, a new
 * contiguous [earliestStep..max] array is returned.
 *
 * The resume-safety check in autoExecutor.js skips any step already terminal
 * (completed/skipped/approved), so widening only re-runs the steps the #28
 * reopen set back to active/pending — it never re-executes terminal work.
 *
 * @param {number[]} steps - current config.steps (contiguous ascending)
 * @param {number|null|undefined} earliestStep - routing target step index
 * @returns {number[]} the same array if no change, else a widened contiguous range
 */
export function widenStepRange(steps, earliestStep) {
  if (!Array.isArray(steps) || steps.length === 0) return steps;
  if (earliestStep == null) return steps;
  const minStep = Math.min(...steps);
  if (earliestStep >= minStep) return steps;
  const maxStep = Math.max(...steps);
  return Array.from({ length: maxStep - earliestStep + 1 }, (_, i) => earliestStep + i);
}
