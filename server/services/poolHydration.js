/**
 * Pool hydration — reconstruct the fully-enriched input a submodule consumes.
 *
 * Extracted verbatim from stageWorker.handleEntityJob §7b/§7c (auto-21 @ 44bdfc7,
 * stageWorker.js:504-672 + the §7c hydrateItems call at :674-680) so the same
 * enrichment runs in exactly one place — stageWorker, the workbench, and any
 * offline reconstruction (e.g. pool-to-spec) all call this instead of re-copying
 * the cascade. The copies had already drifted once (pool-to-spec used a fixed
 * url-then-entity apply order instead of this primary-key-then-cross-key cascade).
 *
 *   hydrateRequiresColumns(...)  — §7b: merge missing requires_columns from
 *                                  submodule_run_item_data (primary key → cross-key
 *                                  cascade). Mutates `items` in place, returns the
 *                                  Set of fields it added (stageWorker uses it to
 *                                  strip enriched-but-not-produced fields on output).
 *   hydrateFrozenInput(...)      — §7b then §7c blob hydration (hydrateItems), the
 *                                  full "frozen input" a run actually saw.
 */

// No top-level db import: `db` is passed in (the repo's dependency-injection
// convention — see cardInstructions.js et al). This keeps the module import-safe
// for hermetic tests, which never touch db.js or its env guard.

/**
 * §7b — Enrich: merge downloadable fields from upstream for this entity's items.
 * Pure move of stageWorker.js:504-672. Mutates `items` in place.
 *
 * @param {object}   p
 * @param {string}   p.runId        - pipeline_runs.id the entity belongs to
 * @param {string}   p.entityName   - entity_name being enriched
 * @param {number}   [p.stepIndex]  - the consuming step. Accepted for caller
 *   symmetry (the workbench loads the pool by step) but NOT referenced here: §7b is
 *   step-agnostic — it enriches from ALL upstream completed/approved runs and orders
 *   by the *source* run's step_index, never by the consuming step.
 * @param {object[]} p.items        - pool items to enrich (mutated in place)
 * @param {object}   p.manifest     - submodule manifest (requires_columns, item_key)
 * @param {string}   [p.excludeRunId] - entity_submodule_run to exclude from upstream
 *   (production passes the currently-executing run; offline/workbench passes nothing).
 * @param {object}   p.db           - Supabase client, injected (repo convention).
 * @returns {Promise<Set<string>>} the field names that were enriched onto items
 */
export async function hydrateRequiresColumns({ runId, entityName, stepIndex, items, manifest, excludeRunId, db }) {
  // Helper: item_data stores objects as JSON strings — parse them back
  const parseContent = (val) => {
    if (typeof val !== 'string') return val;
    const trimmed = val.trimStart();
    if ((trimmed[0] === '{' || trimmed[0] === '[') && trimmed.length > 1) {
      try { return JSON.parse(val); } catch { /* not JSON */ }
    }
    return val;
  };

  const enrichedFields = new Set();
  const requiresColumns = manifest.requires_columns || [];
  const entityItems = items || [];
  if (requiresColumns.length > 0 && entityItems.length > 0) {
    const sampleItems = entityItems.slice(0, 10);
    const missingColumns = requiresColumns.filter(col =>
      sampleItems.every(item => !item[col] || String(item[col]).length === 0)
    );

    if (missingColumns.length > 0) {
      console.log(`[worker:entity] Enriching "${entityName}": ${missingColumns.join(', ')} missing from ${entityItems.length} items`);

      // Find upstream completed entity_submodule_runs for this entity (with step_index for ordering)
      const pipelineRunId = runId;
      const { data: upstreamRuns } = await db
        .from('entity_submodule_runs')
        .select('id, step_index')
        .eq('run_id', pipelineRunId)
        .eq('entity_name', entityName)
        .in('status', ['completed', 'approved']);

      const upstreamRunList = (upstreamRuns || [])
        .filter(r => r.id !== excludeRunId);
      const upstreamRunIds = upstreamRunList.map(r => r.id);
      // Map submodule_run_id → step_index so we can sort item_data rows
      const stepIndexMap = Object.fromEntries(upstreamRunList.map(r => [r.id, r.step_index]));

      if (upstreamRunIds.length > 0) {
        const itemKeyField = manifest.item_key || 'url';
        const itemKeys = [...new Set(
          entityItems.map(item => String(item[itemKeyField] ?? '')).filter(Boolean)
        )];

        const ENRICH_BATCH = 200;
        const lookup = new Map();
        const allItemDataRows = [];
        for (let i = 0; i < itemKeys.length; i += ENRICH_BATCH) {
          const keyBatch = itemKeys.slice(i, i + ENRICH_BATCH);
          const { data: itemData } = await db
            .from('submodule_run_item_data')
            .select('submodule_run_id, item_key, field_name, content')
            .in('submodule_run_id', upstreamRunIds)
            .in('field_name', missingColumns)
            .in('item_key', keyBatch);

          if (itemData) allItemDataRows.push(...itemData);
        }
        // Sort by step_index ascending so later steps (e.g. boilerplate-stripper step 4)
        // overwrite earlier steps (e.g. page-scraper step 3) in the lookup map
        allItemDataRows.sort((a, b) =>
          (stepIndexMap[a.submodule_run_id] || 0) - (stepIndexMap[b.submodule_run_id] || 0)
        );
        for (const row of allItemDataRows) {
          if (!lookup.has(row.item_key)) lookup.set(row.item_key, {});
          lookup.get(row.item_key)[row.field_name] = parseContent(row.content);
        }

        let mergedCount = 0;
        for (const item of entityItems) {
          const key = String(item[itemKeyField] ?? '');
          const extra = lookup.get(key);
          if (extra) {
            for (const k of Object.keys(extra)) enrichedFields.add(k);
            Object.assign(item, extra);
            mergedCount++;
          }
        }
        if (mergedCount > 0) {
          console.log(`[worker:entity] Enriched ${mergedCount}/${entityItems.length} items for "${entityName}" via primary key (${itemKeyField})`);
        }

        // Cross-key fallback: check which required fields are STILL missing after
        // primary enrichment, then try alternate keys (url ↔ entity_name).
        const stillMissing = missingColumns.filter(col =>
          entityItems.some(item => item[col] === undefined || item[col] === null)
        );

        if (stillMissing.length > 0) {
          // Try url-based lookup (for entity_name-keyed modules needing url-keyed data)
          if (itemKeyField !== 'url') {
            const urlKeys = [...new Set(
              entityItems.map(item => String(item.url ?? '')).filter(Boolean)
            )];
            if (urlKeys.length > 0) {
              const lookup2 = new Map();
              const crossRows = [];
              for (let i = 0; i < urlKeys.length; i += ENRICH_BATCH) {
                const keyBatch = urlKeys.slice(i, i + ENRICH_BATCH);
                const { data: itemData } = await db
                  .from('submodule_run_item_data')
                  .select('submodule_run_id, item_key, field_name, content')
                  .in('submodule_run_id', upstreamRunIds)
                  .in('field_name', stillMissing)
                  .in('item_key', keyBatch);
                if (itemData) crossRows.push(...itemData);
              }
              // Sort by step_index ascending so later steps overwrite earlier
              crossRows.sort((a, b) =>
                (stepIndexMap[a.submodule_run_id] || 0) - (stepIndexMap[b.submodule_run_id] || 0)
              );
              for (const row of crossRows) {
                if (!lookup2.has(row.item_key)) lookup2.set(row.item_key, {});
                lookup2.get(row.item_key)[row.field_name] = parseContent(row.content);
              }
              let crossCount = 0;
              for (const item of entityItems) {
                const urlVal = String(item.url ?? '');
                const extra = lookup2.get(urlVal);
                if (extra) {
                  for (const k of Object.keys(extra)) enrichedFields.add(k);
                  Object.assign(item, extra);
                  crossCount++;
                }
              }
              if (crossCount > 0) {
                console.log(`[worker:entity] Cross-key enriched ${crossCount}/${entityItems.length} items for "${entityName}" (url fallback, fields: ${stillMissing.join(', ')})`);
              }
            }
          }

          // Try entity_name-based lookup (for url-keyed modules needing entity_name-keyed data)
          if (itemKeyField !== 'entity_name') {
            const stillMissing2 = stillMissing.filter(col =>
              entityItems.some(item => item[col] === undefined || item[col] === null)
            );
            if (stillMissing2.length > 0) {
              const entityKeys = [...new Set(
                entityItems.map(item => String(item.entity_name ?? '')).filter(Boolean)
              )];
              if (entityKeys.length > 0) {
                const { data: itemData } = await db
                  .from('submodule_run_item_data')
                  .select('item_key, field_name, content')
                  .in('submodule_run_id', upstreamRunIds)
                  .in('field_name', stillMissing2)
                  .in('item_key', entityKeys);
                const entLookup = {};
                for (const row of (itemData || [])) {
                  entLookup[row.field_name] = parseContent(row.content);
                }
                if (Object.keys(entLookup).length > 0) {
                  let entCount = 0;
                  for (const item of entityItems) {
                    if (item.entity_name && entityKeys.includes(item.entity_name)) {
                      Object.assign(item, entLookup);
                      entCount++;
                    }
                  }
                  for (const k of Object.keys(entLookup)) enrichedFields.add(k);
                  console.log(`[worker:entity] Cross-key enriched ${entCount}/${entityItems.length} items for "${entityName}" (entity_name fallback, fields: ${stillMissing2.join(', ')})`);
                }
              }
            }
          }
        }
      }
    }
  }

  return enrichedFields;
}

/**
 * §7b + §7c — the full frozen input a submodule actually consumed: requires_columns
 * enrichment followed by blob-ref hydration. This is the single shared entry point
 * for the workbench / offline reconstruction. Mutates `items` in place.
 *
 * @returns {Promise<{ enrichedFields: Set<string>, hydratedBlobs: number }>}
 */
export async function hydrateFrozenInput({ runId, entityName, stepIndex, items, manifest, excludeRunId, db }) {
  const enrichedFields = await hydrateRequiresColumns({ runId, entityName, stepIndex, items, manifest, excludeRunId, db });
  // §7c blob hydration. hydrateItems uses poolBlobs' own db client, so lazy-import
  // it here — keeps this module import-safe for hermetic tests (which only exercise
  // hydrateRequiresColumns and never reach this path).
  let hydratedBlobs = 0;
  if (items && items.length > 0) {
    const { hydrateItems } = await import('./poolBlobs.js');
    hydratedBlobs = await hydrateItems(items);
  }
  return { enrichedFields, hydratedBlobs };
}
