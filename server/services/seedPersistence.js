/**
 * Seed persistence — the durable per-entity seed store.
 *
 * The pipeline knows entities by NAME only. The seed's company_id/cms_id/website are
 * parsed at ingest and used to launch discovery, but nothing wrote them anywhere durable,
 * so by Step 5 the entity is {name} (submoduleRuns.js:484-497 → step_context miss →
 * pool-derived {entity_name}), and taxonomySuggestions leaves company_id/cms_id null.
 * run_entities was the intended store (schema exists) but dead since 2026-02.
 *
 * This module revives it: one row per (run_id, entity_name) with the WHOLE parsed seed row
 * in entity_snapshot, written at ingest (persistSeedEntities) and hydrated back through the
 * §7b cascade (fillSeedFieldsForItems) — exactly how scraped pages and gsc_terms hydrate.
 * company_id/cms_id/website stay queryable via entity_snapshot->>'...'.
 *
 * DI `db` (no top-level import) — keeps the module import-safe for hermetic tests.
 */

const TABLE = 'run_entities';
const ON_CONFLICT = 'run_id,entity_name';

/** Pure: one durable seed row per entity. entity_snapshot = the whole parsed seed row. */
export function buildSeedRows(runId, entities) {
  return (entities || [])
    .map((e) => ({ run_id: runId, entity_name: e && (e.name || e.entity_name), entity_snapshot: e }))
    .filter((r) => r.entity_name); // name is the identity (seedParser guarantees one); skip nameless
}

/**
 * Persist the full seed row per entity at ingest. Idempotent (upsert on run_id,entity_name).
 * LOUD on write error (throws — the swallowed-error class). No-op for an empty entity set.
 * Logs seed_rows_written. Returns the number of rows written.
 */
export async function persistSeedEntities({ runId, entities, db }) {
  const rows = buildSeedRows(runId, entities);
  if (rows.length === 0) return 0;
  const { error } = await db.from(TABLE).upsert(rows, { onConflict: ON_CONFLICT });
  if (error) throw new Error(`[seedPersistence] seed write failed (run ${runId}, ${rows.length} entities): ${error.message}`);
  console.log(`[seedPersistence] seed_rows_written=${rows.length} run=${runId}`);
  return rows.length;
}

/**
 * §7b seed hydration — fill still-missing requires_columns from the persisted seed row.
 * Mirrors fillGscTermsForItems (poolHydration.js): data-shape routed (only wantedFields
 * present in the seed are filled, only where the item lacks them), no-op when
 * db/runId/entityName/fields absent or no seed row exists, THROWS on query error (never a
 * silent empty fill). Mutates `items` in place; returns the Set of fields it filled.
 */
export async function fillSeedFieldsForItems({ items, entityName, runId, wantedFields, db }) {
  const filled = new Set();
  if (!db || !runId || !entityName) return filled;
  const fields = (wantedFields || []).filter(Boolean);
  if (fields.length === 0 || !items || items.length === 0) return filled;

  const { data, error } = await db
    .from(TABLE)
    .select('entity_snapshot')
    .eq('run_id', runId)
    .eq('entity_name', entityName)
    .maybeSingle();
  if (error) throw new Error(`[seedPersistence] seed hydrate failed (run ${runId}, entity "${entityName}"): ${error.message}`);

  const seed = data && data.entity_snapshot;
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) {
    console.warn(`[worker:entity] seed hydrate "${entityName}": no run_entities row`);
    return filled;
  }

  let merged = 0;
  for (const item of items) {
    let touched = false;
    for (const f of fields) {
      const cur = item[f];
      const val = seed[f];
      if ((cur === undefined || cur === null || cur === '') && val !== undefined && val !== null && val !== '') {
        item[f] = val;
        filled.add(f);
        touched = true;
      }
    }
    if (touched) merged++;
  }
  if (merged > 0) {
    console.log(`[worker:entity] seed hydrate "${entityName}": filled ${[...filled].join(', ')} on ${merged}/${items.length} items`);
  }
  return filled;
}
