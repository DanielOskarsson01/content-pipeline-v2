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

// ── GSC hydration (PIECE 3, specs template-v3/keyword-data/KEYWORD_DATA.md §6) ──
// Fill keyword_data.gsc_terms — the site's own Search Console queries — for any item
// carrying the keyword-data module's keyword_data field. The module leaves gsc_terms:[]
// (Rule 2: modules can't touch the DB); we fill it here during §7b hydration, before
// the consuming module (seo-planner) executes. Data-shape routing (same as Step 8):
// keyed on the field being present, never on source_submodule. Inert until a consumer
// declares keyword_data in requires_columns (§7) — the loop then finds no field, no-ops.
// The aggregation runs server-side in gsc_terms_slice() (sql/gsc_terms_slice_function.sql):
// category slices match 115K–198K raw rows, so a client-side pull is not viable — the RPC
// returns ≤p_limit bounded rows, so there is no client-side read to range-paginate; the
// hydration-fix lesson is honored by the throw-on-error + count log below.

const GSC_RPC = 'gsc_terms_slice';

// Mirror of storage.slugifyEntity — copied (4 lines), not imported, to keep this module
// import-safe (no side-effecting imports) for hermetic tests. Returns '' for empty.
function gscSlugify(name) {
  return String(name ?? '')
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Candidate category slugs from keyword_data.terms, in the module's derived order
// (brand first, then primary categories, then tags — keyword-data deriveTerms). First
// slug that returns GSC rows wins => the entity's primary category that has data.
function gscCategoryCandidates(kd, max) {
  const out = [];
  const seen = new Set();
  for (const t of (kd.terms || [])) {
    const slug = gscSlugify(t && t.term);
    if (slug && !seen.has(slug)) { seen.add(slug); out.push(slug); }
    if (out.length >= max) break;
  }
  return out;
}

async function gscSlice(db, scope, slug, days, limit) {
  if (!slug) return [];
  const { data, error } = await db.rpc(GSC_RPC, { p_scope: scope, p_slug: slug, p_days: days, p_limit: limit });
  // Throw on error so a broken read fails loudly — never a silent empty fill.
  if (error) {
    throw new Error(`[poolHydration] GSC ${scope} slice failed (slug "${slug}"): ${error.message}`);
  }
  // impressions/clicks come back as bigint (string over REST); position as numeric.
  return (data || []).map((r) => ({
    term: r.term,
    impressions: Number(r.impressions) || 0,
    clicks: Number(r.clicks) || 0,
    position: r.position == null ? null : Number(r.position),
  }));
}

// Fill one item's keyword_data.gsc_terms in place. Entity slice first; if empty, the
// category fallback (first candidate slug with rows). "No data" is legitimate — warn and
// leave []; only a query error throws.
async function fillGscTerms(item, entityName, db) {
  let kd = item.keyword_data;
  if (typeof kd === 'string') { try { kd = JSON.parse(kd); } catch { return; } }
  if (!kd || typeof kd !== 'object' || Array.isArray(kd)) return;
  if (Array.isArray(kd.gsc_terms) && kd.gsc_terms.length > 0) return; // already filled

  const limit = Number(process.env.GSC_TERMS_LIMIT) || 25;
  const days = Number(process.env.GSC_LOOKBACK_DAYS) || 0; // 0 = all-time (resolved: GSC presence is durable authority, not a trend; §6 acceptance counts are all-time)
  const maxCats = Number(process.env.GSC_CATEGORY_MAX_ATTEMPTS) || 8;

  let scope = 'entity';
  let rows = await gscSlice(db, 'entity', gscSlugify(entityName), days, limit);
  if (rows.length === 0) {
    scope = 'category';
    for (const slug of gscCategoryCandidates(kd, maxCats)) {
      const r = await gscSlice(db, 'category', slug, days, limit);
      if (r.length > 0) { rows = r; break; }
    }
  }

  kd.gsc_terms = rows.map((r) => ({ ...r, scope }));
  item.keyword_data = kd;

  if (kd.gsc_terms.length > 0) {
    console.log(`[worker:entity] gsc_terms "${entityName}": ${kd.gsc_terms.length} terms (scope ${scope})`);
  } else {
    console.warn(`[worker:entity] gsc_terms "${entityName}": 0 terms (no entity or category GSC rows)`);
  }
}

async function fillGscTermsForItems(items, entityName, db) {
  if (!db) return;
  for (const item of (items || [])) {
    if (item && item.keyword_data) await fillGscTerms(item, entityName, db);
  }
}

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
      // Order rows by source step_index ascending: later STEPS (e.g. boilerplate-
      // stripper step 4) overwrite earlier steps (e.g. page-scraper step 3) in the
      // lookup map. Shared by the primary + cross-key sorts.
      const bySourceRun = (a, b) =>
        (stepIndexMap[a.submodule_run_id] || 0) - (stepIndexMap[b.submodule_run_id] || 0);

      if (upstreamRunIds.length > 0) {
        const itemKeyField = manifest.item_key || 'url';

        // Fetch item_data for `fields` across THIS ENTITY's upstream runs, WITHOUT an
        // item_key IN-filter. The runs are already per-entity (upstreamRunIds come
        // from entity_submodule_runs filtered by entity_name), so scoping by run id
        // returns exactly this entity's rows — the item_key list was redundant and
        // the source of a silent-truncation bug: an .in('item_key', [...]) of ~200+
        // page URLs (up to ~758 chars each) overran the PostgREST request-URI limit,
        // reproduced as "fetch failed" at ~200 keys and "400 Bad Request" at 402,
        // and the old code destructured only `data` so the failed batch silently
        // contributed zero rows (~200 of 402 ELK pages never reached the analyzer).
        // We range-paginate by the table PK (submodule_run_id, item_key, field_name)
        // which also defeats PostgREST's 1000-row response cap for >1000-page
        // entities (Play'n GO scraped 1500+), and THROW on any query error so a
        // future truncation fails loudly instead of degrading quality invisibly.
        // Memory is bounded to the pool via `wantedKeys` (only rows we will merge).
        // ponytail: entity_name-keyed modules (content-analyzer et al.) fetch the
        // corpus once per pass (primary discards it, the url fallback re-fetches it)
        // — a ~2× transfer on the hot path. Upgrade path if it bites: one run-scoped
        // fetch of all missingColumns into a single lookup, then merge by each key
        // shape client-side. Deferred: transfer is bounded by the entity's scraped
        // rows either way, and the single-fetch merge changes cascade semantics.
        const PAGE = 1000;
        const fetchFieldRows = async (fields, wantedKeys, label) => {
          const out = [];
          for (let from = 0; ; from += PAGE) {
            const { data, error } = await db
              .from('submodule_run_item_data')
              .select('submodule_run_id, item_key, field_name, content')
              .in('submodule_run_id', upstreamRunIds)
              .in('field_name', fields)
              .order('submodule_run_id', { ascending: true })
              .order('item_key', { ascending: true })
              .order('field_name', { ascending: true })
              .range(from, from + PAGE - 1);
            if (error) {
              throw new Error(`[poolHydration] item_data fetch failed (${label}, run ${runId}, entity "${entityName}", fields ${fields.join(',')}): ${error.message}`);
            }
            if (!data || data.length === 0) break;
            for (const row of data) {
              if (!wantedKeys || wantedKeys.has(row.item_key)) out.push(row);
            }
            if (data.length < PAGE) break;
          }
          return out;
        };

        // Build item_key → { field: value } from fetched rows, applying the source-run
        // ordering (by source step_index) so later steps overwrite earlier steps.
        const buildLookup = (rows) => {
          rows.sort(bySourceRun);
          const map = new Map();
          for (const row of rows) {
            if (!map.has(row.item_key)) map.set(row.item_key, {});
            map.get(row.item_key)[row.field_name] = parseContent(row.content);
          }
          return map;
        };

        // --- Pass 1: primary key ---
        const primaryKeys = new Set(
          entityItems.map(item => String(item[itemKeyField] ?? '')).filter(Boolean)
        );
        const lookup = buildLookup(await fetchFieldRows(missingColumns, primaryKeys, 'primary'));
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
          // --- Pass 2: url cross-key (for entity_name-keyed modules needing url-keyed data) ---
          if (itemKeyField !== 'url') {
            const urlKeys = new Set(
              entityItems.map(item => String(item.url ?? '')).filter(Boolean)
            );
            if (urlKeys.size > 0) {
              const lookup2 = buildLookup(await fetchFieldRows(stillMissing, urlKeys, 'url-fallback'));
              let crossCount = 0;
              for (const item of entityItems) {
                const extra = lookup2.get(String(item.url ?? ''));
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

          // --- Pass 3: entity_name cross-key (for url-keyed modules needing entity_name-keyed data) ---
          if (itemKeyField !== 'entity_name') {
            const stillMissing2 = stillMissing.filter(col =>
              entityItems.some(item => item[col] === undefined || item[col] === null)
            );
            if (stillMissing2.length > 0) {
              const entityKeys = new Set(
                entityItems.map(item => String(item.entity_name ?? '')).filter(Boolean)
              );
              if (entityKeys.size > 0) {
                const lookup3 = buildLookup(await fetchFieldRows(stillMissing2, entityKeys, 'entity_name-fallback'));
                let entCount = 0;
                for (const item of entityItems) {
                  const extra = lookup3.get(String(item.entity_name ?? ''));
                  if (extra) {
                    for (const k of Object.keys(extra)) enrichedFields.add(k);
                    Object.assign(item, extra);
                    entCount++;
                  }
                }
                if (entCount > 0) {
                  console.log(`[worker:entity] Cross-key enriched ${entCount}/${entityItems.length} items for "${entityName}" (entity_name fallback, fields: ${stillMissing2.join(', ')})`);
                }
              }
            }
          }
        }

        // Loud coverage report so a future silent truncation is visible in logs:
        // how many pool items ended up with each originally-missing field. (Partial
        // coverage can be legitimate — some pages genuinely have no text_content —
        // so this logs rather than throws; the hard guarantee against silent
        // truncation is the throw-on-query-error in fetchFieldRows above.)
        for (const col of missingColumns) {
          const have = entityItems.filter(
            it => it[col] !== undefined && it[col] !== null && String(it[col]).length > 0
          ).length;
          console.log(`[worker:entity] hydration coverage "${entityName}" ${col}: ${have}/${entityItems.length} items`);
        }
      }
    }
  }

  // §7b GSC enricher (PIECE 3): fill keyword_data.gsc_terms for any item carrying the
  // field, independent of the requires_columns cascade above. Data-shape routed; no-op
  // when no item has keyword_data or when db is absent (hermetic tests). See §6.
  // Assumes keyword_data is present as a full object at §7b (it is: a downloadable field,
  // never blob-extracted — stageWorker.js — so it isn't deferred to §7c hydrateItems).
  await fillGscTermsForItems(items, entityName, db);

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
