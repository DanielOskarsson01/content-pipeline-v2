/**
 * Decide the entity_submodule_runs status from a submodule's per-entity result.
 *
 * The worker used to write 'completed' whenever execute() RETURNED (didn't throw).
 * But several modules signal a per-entity SUBMODULE FAILURE by RETURNING an error
 * result (meta.status==='error') rather than throwing — content-writer (fetch
 * failed), seo-planner (JSON parse failed), content-analyzer (missing vocab /
 * upstream). Writing those as 'completed' masked failures as "N completed, 0
 * failed" and starved the auto-executor's failure-rate threshold, which counts
 * 'failed' runs (server/services/autoExecutor.js).
 *
 * IMPORTANT distinction: a submodule failure is NOT a QA verdict. A checker that
 * returns qa_pass:false produced a VALID result (its meta.status is not 'error';
 * loop-router routes it). This helper flags ONLY meta.status==='error' — or a
 * result whose every item has status==='error' — as 'failed'. QA verdicts, skips,
 * and partial results stay 'completed', so existing routing/threshold behaviour
 * for those is unchanged.
 *
 * @param {{items?:any[], meta?:{status?:string, error?:string}}} result  per-entity result
 * @returns {{status:'completed'|'failed', error:string|null}}
 */
export function deriveEntityRunStatus(result) {
  const metaError = result?.meta?.status === 'error';
  const items = Array.isArray(result?.items) ? result.items : [];
  const allItemsError = items.length > 0 && items.every(it => it?.status === 'error');

  if (!metaError && !allItemsError) {
    return { status: 'completed', error: null };
  }
  const error = items.find(it => it?.error)?.error
    || result?.meta?.error
    || 'Submodule returned an error result for this entity';
  return { status: 'failed', error };
}
