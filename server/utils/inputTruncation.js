/**
 * F-D (VALIDATION_E2E_RUN1, run 9821ed56): input-side truncation must be
 * queryable after the fact.
 *
 * A module that truncates its assembled input declares it on its per-entity
 * result meta — content_truncated / content_chars_total / content_chars_kept
 * (the content-analyzer B029 contract; module-agnostic: any module emitting
 * these fields is picked up). Run 9821ed56 delivered 61%/79% of two corpora
 * and the only trace was module-shaped JSONB deep inside
 * entity_submodule_runs.output_data — the validation pass hunting for the
 * signal declared it absent. The persist spine (stageWorker sync §12 + batch)
 * lifts the declaration into a first-class decision_log row so
 *   SELECT * FROM decision_log WHERE run_id = ? AND decision = 'input_truncated'
 * answers "how many entities in this run had their evidence cut, and by how
 * much" — from the database, not from logs.
 *
 * Deliberately NOT a hard fail: a profile built on a truncated corpus is not
 * necessarily wrong (Vixio, 61% delivered, was the run's only auto-approved
 * entity). The signal is a loud, durable record — never a run-stopper.
 */

/**
 * Read a module result's input-truncation declaration.
 * Handles both persist-spine shapes: the per-entity unwrapped result
 * ({ entity_name, items, meta }) and the legacy multi-entity envelope
 * ({ results: [{ meta }] }).
 *
 * @param {object} result - module execution result
 * @returns {{content_chars_total: number|null, content_chars_kept: number|null}|null}
 *   the declared truncation, or null when the module declared none
 */
export function extractInputTruncation(result) {
  const metas = Array.isArray(result?.results)
    ? result.results.map((r) => r?.meta)
    : [result?.meta];
  for (const m of metas) {
    if (m?.content_truncated === true) {
      return {
        content_chars_total: m.content_chars_total ?? null,
        content_chars_kept: m.content_chars_kept ?? null,
      };
    }
  }
  return null;
}

/**
 * Build the decision_log row for one entity's input truncation.
 *
 * @param {object} p
 * @param {string} p.runId
 * @param {number} p.stepIndex
 * @param {string} p.submoduleId
 * @param {string} p.entityName
 * @param {{content_chars_total: number|null, content_chars_kept: number|null}} p.truncation
 * @returns {object} insert-ready decision_log row
 */
export function buildInputTruncationLogRow({ runId, stepIndex, submoduleId, entityName, truncation }) {
  const { content_chars_total: total, content_chars_kept: kept } = truncation;
  const pct = total > 0 && kept != null ? Math.round((kept / total) * 100) : null;
  return {
    run_id: runId,
    step_index: stepIndex,
    submodule_id: submoduleId,
    entity_id: entityName,
    decision: 'input_truncated',
    reason:
      `${entityName}: input truncated — ${kept ?? '?'} of ${total ?? '?'} assembled chars delivered` +
      (pct != null ? ` (${pct}%)` : ''),
    context: {
      entity_name: entityName,
      content_chars_total: total,
      content_chars_kept: kept,
      pct_delivered: pct,
    },
  };
}
