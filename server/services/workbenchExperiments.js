/**
 * Thin DAO for workbench_experiments (WORKBENCH_DESIGN.md §b Unit 3).
 *
 * `db` is injected (repo convention — cardInstructions.js, poolHydration.js)
 * so hermetic tests never touch db.js or its env guard.
 *
 * workbench_experiments is the ONLY table this module writes. It is deliberately
 * outside retention's RUN_ID_TABLES and source_run_id has no FK — rows must
 * survive deletion of their source run.
 */

export async function insertExperiment(row, db) {
  // PostgreSQL JSONB rejects null bytes (\\u0000) — replayed scrapers can fetch fresh
  // null-byte content (same fix as stageWorker.js:746).
  const sanitized = JSON.parse(JSON.stringify(row).replace(/\\u0000/g, ''));
  const { data, error } = await db
    .from('workbench_experiments')
    .insert(sanitized)
    .select()
    .single();
  if (error) throw new Error(`workbench_experiments insert failed: ${error.message}`);
  return data;
}

/**
 * List experiments, newest first. All filters optional.
 * @param {{source_run_id?:string, step_index?:number, submodule_id?:string, entity_name?:string, limit?:number}} filters
 */
export async function listExperiments(filters = {}, db) {
  let q = db.from('workbench_experiments').select('*');
  if (filters.source_run_id) q = q.eq('source_run_id', filters.source_run_id);
  if (filters.step_index != null) q = q.eq('step_index', filters.step_index);
  if (filters.submodule_id) q = q.eq('submodule_id', filters.submodule_id);
  if (filters.entity_name) q = q.eq('entity_name', filters.entity_name);
  q = q.order('created_at', { ascending: false }).limit(filters.limit || 50);
  const { data, error } = await q;
  if (error) throw new Error(`workbench_experiments read failed: ${error.message}`);
  return data || [];
}
