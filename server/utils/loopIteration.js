/**
 * Resolve the loop_iteration to stamp on a (submodule, card-group) batch and its
 * per-entity rows.
 *
 * loop_iteration is a property of the ENTITY's current round — sourced from
 * entity_run_meta.loop_count — NOT of which card (or no card) targets it. A
 * backward route bumps loop_count for the entity; the next re-execution of ANY
 * submodule at that step must be stamped with the bumped value, including the
 * DEFAULT group (card_id=null) submodules (content-analyzer, seo-planner,
 * tone-seo-editor) that re-run alongside the routed card. autoExecutor scopes its
 * completion wait + resume-safety check by loop_iteration for every group, so a
 * default-group row stamped with a stale 0 in Round 2+ deadlocks the wait
 * (false "batchWorker may be down" 120s timeout → halt before the card runs).
 *
 * This helper is therefore card-AGNOSTIC: the caller loads entity_run_meta for
 * all groups and passes the full map. (Regression fixed 2026-06-27, sub-plan 4
 * task 2 — the load was previously gated on `if (cardId)`, leaving default
 * groups with an empty map → 0.)
 *
 * @param {Array<{entity_name?: string}>} entities       pool entities in this batch
 * @param {Map<string, {loop_count?: number}>} metaByEntity  entity_run_meta keyed by entity_name
 * @returns {number} loop_iteration for the batch (first entity's loop_count; 0 default)
 */
export function resolveBatchLoopIteration(entities, metaByEntity) {
  if (!Array.isArray(entities) || entities.length === 0) return 0;
  const iters = entities.map((ep) => metaByEntity?.get?.(ep.entity_name)?.loop_count ?? 0);
  const first = iters[0];
  if (iters.some((i) => i !== first)) {
    // Default groups after routing may legitimately mix per-entity loop_counts
    // (per-entity rows still carry their own loop_count). Pick the first for the
    // batch-level value, matching autoExecutor.processStep's currentIteration.
    console.warn(`[loopIteration] mixed entity loop_counts [${iters.join(',')}], using ${first} for batch loop_iteration`);
  }
  return first;
}
