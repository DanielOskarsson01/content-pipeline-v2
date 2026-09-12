/**
 * Taxonomy suggestions — route content-analyzer's out-of-vocabulary tag PROPOSALS
 * to the taxonomy_suggestions review table (Unit 4c §TASK 3a).
 *
 * content-analyzer already emits the proposals in analysis_json.tags.suggested_new[]
 * (shape: {label, why, evidence[]}). Rule 2 forbids the module touching the DB, so the
 * skeleton writes them — same split as the GSC hook (PIECE 3). Data-shape routing (same
 * as Step 8): keyed on the field being present, never on source_submodule — so this is
 * inert for any submodule output that doesn't carry the path.
 *
 * Identity: the pipeline knows entities by NAME only, so entity_name is the stored identity.
 * The seed's company_id/cms_id are now persisted per (run_id, entity_name) in run_entities
 * (seedPersistence.js, 2026-09-12) and are hydratable via poolHydration §7b — but THIS hook
 * is not yet wired to read them, so company_id (a nullable fossil of the retired CMS design)
 * and cms_id (the future Strapi publishing key) are still left null here. Wiring this hook to
 * hydrate them from the seed store is the follow-up that closes the loop.
 *
 * DI `db` (no top-level import) — keeps the module import-safe for hermetic tests.
 */

const TABLE = 'taxonomy_suggestions';
const ON_CONFLICT = 'run_id,entity_name,suggestion_type,label';

/**
 * Pull tag proposals out of a submodule result. Call this BEFORE step 9 strips
 * analysis_json off result.items (it's a content-analyzer downloadable_field). Returns
 * fresh {label, why, evidence} objects so a later `delete item.analysis_json` can't orphan
 * them. Malformed proposals (no usable label — label is NOT NULL) are skipped; why/evidence
 * normalize to null. Returns [] for any output that doesn't carry the path.
 */
export function extractTagSuggestions(result) {
  const out = [];
  for (const item of result?.items || []) {
    const proposals = item?.analysis_json?.tags?.suggested_new;
    if (!Array.isArray(proposals)) continue;
    for (const p of proposals) {
      const label = typeof p?.label === 'string' ? p.label.trim() : '';
      if (!label) continue;
      out.push({
        label,
        why: typeof p?.why === 'string' ? p.why : null,
        evidence: Array.isArray(p?.evidence) ? p.evidence.filter((e) => typeof e === 'string') : null,
      });
    }
  }
  return out;
}

/**
 * Upsert one review-queue row per proposal. Idempotent on (run_id, entity_name,
 * suggestion_type, label): a loop-router / manual re-run of THIS run replaces its own
 * rows and never touches another run's reviewed rows. status/created_at use column
 * defaults ('pending'/now()) and are omitted from the payload, so an on-conflict upsert
 * preserves a human's review state instead of resetting it. company_id/cms_id omitted
 * → null (no live source).
 *
 * LOUD: throws on a db error so handleEntityJob's job retries (the completed-status write
 * hasn't happened yet → the skip guard doesn't fire → clean re-run) rather than silently
 * dropping proposals. No-op when db is absent (tests) or there are no suggestions.
 *
 * @returns {Promise<number>} rows written (post-dedup)
 */
export async function writeTaxonomySuggestions({ db, runId, entityName, suggestions }) {
  if (!db || !Array.isArray(suggestions) || suggestions.length === 0) return 0;

  // Dedup by label (last wins). The analyzer shouldn't repeat a label for one entity,
  // but a single upsert INSERT with two rows sharing the conflict key errors ("ON
  // CONFLICT DO UPDATE cannot affect row a second time").
  const byLabel = new Map();
  for (const s of suggestions) byLabel.set(s.label, s);

  const rows = [...byLabel.values()].map((s) => ({
    run_id: runId,
    entity_name: entityName,
    suggestion_type: 'tag',
    label: s.label,
    why_suggested: s.why ?? null,
    evidence_refs: s.evidence ?? null,
  }));

  const { error } = await db.from(TABLE).upsert(rows, { onConflict: ON_CONFLICT });
  if (error) throw new Error(`taxonomy_suggestions upsert failed for "${entityName}": ${error.message}`);
  return rows.length;
}

// ponytail: tags-only. categories.suggested_new is absent in production (verified run
// 94baa6f6); add a 'category' pass here only when a template's analyzer prompt emits it.
