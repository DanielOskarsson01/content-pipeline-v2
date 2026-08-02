/**
 * Workbench experiments endpoint (WORKBENCH_DESIGN.md §b Unit 4).
 *
 * POST /api/workbench/experiments
 *   { source_run_id, step_index, submodule_id, entity_name,
 *     overrides?, exclude_entity_submodule_run_id?, parent_experiment_id? }
 *
 * Flow (spec §2): pin source run archived (idempotent) → load frozen pool →
 * [U8: overlay parent experiment's output onto the pool] → hydrate via U1
 * (inside the U2 harness) → execute in-process → insert ONE
 * workbench_experiments row → return it.
 *
 * LOAD-BEARING NO-WRITE CONTRACT: unlike the existing /run endpoint
 * (submoduleRuns.js — which upserts resolved options back into
 * run_submodule_config at its step 5a, initializes entity_stage_pool, and
 * writes submodule_runs / entity_submodule_runs), this endpoint writes NOTHING
 * to submodule_runs, entity_submodule_runs, run_submodule_config,
 * entity_stage_pool, submodule_run_item_data, or pool_item_blobs. Real-run
 * data is read-only to the workbench. The only writes are (1) the spec-mandated
 * idempotent pin of pipeline_runs.status='archived' on the source run, so the
 * 7-day retention sweep can't delete the pool an experiment replays against,
 * and (2) the workbench_experiments insert.
 *
 * REPLAY FIDELITY CAVEAT: replays reconstruct the frozen input from the
 * CURRENT submodule_run_item_data / pool_item_blobs rows, so post-run
 * revisions to those rows are visible to a replay — a replay is not a
 * byte-frozen snapshot of what the historical execution saw. Back-to-back
 * A/B experiment arms are comparable with each other; comparing a replay
 * against the historical run's verdict is not sound.
 */
import express from 'express';
import { loadModules, getSubmoduleById } from '../services/moduleLoader.js';
import { runSubmoduleOnce } from '../services/submoduleHarness.js';
import { insertExperiment } from '../services/workbenchExperiments.js';

// Per-request execution ceiling. The harness caps each AI call at 600s with up
// to 3 attempts but has no overall bound (U2 review finding); a single
// workbench replay that can't finish inside 15 minutes is a lost cause.
export const EXECUTION_CEILING_MS = 15 * 60 * 1000;

const REPLAY_FIDELITY_NOTE =
  'Replay reconstructs frozen input from current submodule_run_item_data/pool_item_blobs — '
  + 'post-run revisions are visible; not a byte-frozen snapshot. The replayed entity also '
  + 'carries only {name, items}: original entity fields (website, linkedin, …) are not '
  + 'reconstructed. Compare experiment arms with each other, not with the historical verdict.';

// Runs the workbench may replay: terminal states only. Pinning a live run
// would yank it out from under the auto-executor. 'halted' is deliberately
// EXCLUDED even though retention sweeps it: pinning would flip it to
// 'archived' and permanently break the resume endpoint's halted-check
// (runs.js) — resume first, or accept the sweep.
const PINNABLE_STATUSES = ['completed', 'abandoned', 'archived'];

function defaultGetManifest(submoduleId) {
  loadModules();
  return getSubmoduleById(submoduleId);
}

// ---- U8 chaining overlay (CHAINING-SCOPE v1 §S2) ----

const httpError = (status, message) => Object.assign(new Error(message), { httpStatus: status });

// Identity/bookkeeping fields — never treated as content when computing the
// parent's shape (they appear on virtually every pool item).
const OVERLAY_IDENTITY_FIELDS = new Set(['entity_name', 'name', 'url', 'source_submodule', 'status', 'error', '_blob_ref']);

// Content = a non-empty string, non-empty array, or object. Numbers/booleans
// are metrics (word_count, qa_pass, …), carried by nearly every item — matching
// on them would drop the whole pool.
const isContent = (v) => v != null && typeof v !== 'number' && typeof v !== 'boolean'
  && !(typeof v === 'string' && v === '') && !(Array.isArray(v) && v.length === 0);

/**
 * Overlay a completed parent experiment's output items onto the frozen pool.
 *
 * MERGE POLICY: REPLACE-BY-SHAPE, SCOPED TO GENERATED ITEMS — deliberately NOT
 * prod's add-by-composite-key (item_key, source_submodule) semantics. The
 * predicate sits between two failure modes, both observed live:
 *
 *   (a) UNDER-DROP → concatenation. Prod-parity merge would leave BOTH the
 *       original content-writer item and the parent's output carrying
 *       content_markdown, and step-6 checkers concatenate every bearer they
 *       find (qa-structural execute.js:147, citation-coverage-checker
 *       execute.js:270) — doubling word/section counts (the 5,237-word
 *       artefact). So every GENERATED item carrying a parent field is dropped.
 *
 *   (b) OVER-DROP → source starvation. Shape-matching the WHOLE pool drops
 *       source items on incidental field-name collisions: run cb49ef80's
 *       content-writer parent emits meta_description (SEO meta), 45 scraped
 *       stripper items carried meta_description (their og:description), and
 *       the checker was left 12 footer stubs as its evidence base —
 *       "hallucination" scores measured source deletion, not grounding. So
 *       items from source-producing modules (manifest step <= SOURCE_STEP_MAX:
 *       discovery/validation/scraping/filtering) are EXEMPT from the drop —
 *       they are the evidence base a step-5/6 parent can never supersede.
 *
 * The exemption is provenance-positive: an item with no source_submodule, or
 * one whose module isn't in the registry, stays shape-matched — exempting
 * unknowns could let a second content_markdown bearer through (failure mode a).
 * Ceiling: if a step<=4 module ever emits a generation field name
 * (content_markdown), its items would be exempt and could under-drop.
 * Residual over-drop: a generation-step SIBLING with an incidental collision
 * is still dropped (e.g. a content-writer parent drops the seo-planner item
 * via meta_title) — §7b re-supplies anything in requires_columns;
 * opportunistic readers lose the rest.
 *
 * Returns { items, dropped, kept } — never mutates the caller's arrays or the
 * parent row. All guards throw httpError (fail loud, never skip silently).
 */
// Steps 0–4 produce/refine source material; 5+ generate/verify content from it.
const SOURCE_STEP_MAX = 4;
async function applyParentOverlay({ items, parentId, source_run_id, entity_name, db, getManifest }) {
  const { data: parent, error: parentErr } = await db
    .from('workbench_experiments')
    .select('id, source_run_id, entity_name, submodule_id, status, output_data')
    .eq('id', parentId)
    .maybeSingle();
  if (parentErr) throw httpError(500, `parent experiment lookup failed: ${parentErr.message}`);
  if (!parent) throw httpError(404, `parent experiment ${parentId} not found`);

  // Guards (CHAINING-SCOPE v1): an errored parent's items are stubs
  // (content_markdown: ''), and a cross-run/cross-entity parent would overlay
  // foreign content onto this entity's pool.
  if (parent.status !== 'completed') {
    throw httpError(409, `parent experiment ${parentId} is '${parent.status}' — only completed experiments can be chained`);
  }
  if (parent.source_run_id !== source_run_id) {
    throw httpError(400, `parent experiment belongs to run ${parent.source_run_id}, not ${source_run_id}`);
  }
  if (parent.entity_name !== entity_name) {
    throw httpError(400, `parent experiment is for entity '${parent.entity_name}', not '${entity_name}'`);
  }

  const parentManifest = getManifest(parent.submodule_id);
  if (!parentManifest) throw httpError(500, `parent submodule '${parent.submodule_id}' not found — cannot resolve its item_key`);
  const itemKeyField = parentManifest.item_key || 'url';

  const parentItems = parent.output_data?.items;
  if (!Array.isArray(parentItems) || parentItems.length === 0) {
    throw httpError(409, `parent experiment ${parentId} has no output items to chain from`);
  }
  for (const it of parentItems) {
    if (it?.[itemKeyField] == null || String(it[itemKeyField]) === '') {
      throw httpError(422, `parent output item lacks its module's item_key field '${itemKeyField}' — cannot merge`);
    }
  }

  // The parent's shape: every content field its output items carry.
  const primaryFields = new Set();
  for (const it of parentItems) {
    for (const [k, v] of Object.entries(it)) {
      if (!OVERLAY_IDENTITY_FIELDS.has(k) && k !== itemKeyField && isContent(v)) primaryFields.add(k);
    }
  }
  if (primaryFields.size === 0) throw httpError(409, `parent experiment ${parentId} output items carry no content fields`);

  // §7c: a pool item's heavy fields can hide behind _blob_ref (e.g. this run's
  // own tone-seo-editor item stores content_markdown in pool_item_blobs).
  // Shape-matching on literal keys alone would KEEP that item; §7c hydration
  // would then restore its content_markdown and resurrect the exact
  // concatenation bug this overlay exists to kill. Fetch the referenced blobs
  // and match on their field keys too (the payload is only read for its keys;
  // a keys-only RPC could avoid the transfer if it ever matters).
  const refs = [...new Set(items.filter(i => i?._blob_ref).map(i => i._blob_ref))];
  let blobKeys = new Map();
  if (refs.length > 0) {
    const { data: blobs, error: blobErr } = await db
      .from('pool_item_blobs').select('id, content').in('id', refs);
    if (blobErr) throw httpError(500, `pool blob lookup failed: ${blobErr.message}`);
    blobKeys = new Map((blobs || []).map(b => [b.id, Object.keys(b.content || {})]));
  }

  const carriesPrimary = (it) => {
    for (const f of primaryFields) if (isContent(it?.[f])) return true;
    for (const f of blobKeys.get(it?._blob_ref) || []) if (primaryFields.has(f)) return true;
    return false;
  };

  // Failure-mode (b) exemption — see the merge-policy comment above.
  // Memoized: the default getManifest rescans the modules dir on every call,
  // and this runs once per pool item (~60 on a production pool).
  const manifestMemo = new Map();
  const isSourceItem = (it) => {
    const src = it?.source_submodule;
    if (!src) return false;
    if (!manifestMemo.has(src)) manifestMemo.set(src, getManifest(src));
    const m = manifestMemo.get(src);
    return !!m && m.step <= SOURCE_STEP_MAX;
  };

  // The parent's OWN originals are always replaced by composite key
  // (item_key, source_submodule) — prod's merge identity — regardless of shape
  // or exemption. Without this, chaining a step<=4 parent (e.g. an improved
  // boilerplate-stripper experiment) would prepend its items while the
  // exemption keeps every original: two text_content bearers per url, doubling
  // the child's corpus with pre-fix text.
  const parentKeys = new Set(parentItems.map(it => String(it[itemKeyField])));
  const isParentOriginal = (it) =>
    it?.source_submodule === parent.submodule_id && parentKeys.has(String(it?.[itemKeyField]));

  const kept = items.filter(it => !isParentOriginal(it) && (isSourceItem(it) || !carriesPrimary(it)));
  // Stamp source_submodule = parent.submodule_id: experiment outputs are never
  // stamped (prod stamps at approval), and downstream display/debugging keys on it.
  const inserted = parentItems.map(it => ({ ...it, source_submodule: parent.submodule_id }));
  // Parent items go FIRST: §7b decides "missing columns" from the first 10
  // items only (poolHydration.js sampleItems.slice(0, 10)). Appended at the
  // end of a production-sized pool, the parent's bearer sits past the sample
  // window, §7b declares its field missing, and enrichment overwrites the
  // parent's content with the HISTORICAL rows from submodule_run_item_data —
  // silently scoring the wrong artifact. Prepending puts the parent's fields
  // inside the sample so §7b sees them present and skips DB enrichment.
  // ponytail: holds while a parent emits ≤10 items (every current step-5/6
  // module emits 1/entity); upgrade path is excluding the parent's
  // primaryFields from enrichment in poolHydration itself.
  return { items: [...inserted, ...kept], dropped: items.length - kept.length, kept: kept.length };
}

export function createWorkbenchRouter(deps) {
  const { db, runSubmodule = runSubmoduleOnce, getManifest = defaultGetManifest } = deps;
  const router = express.Router();

  router.post('/experiments', async (req, res) => {
    try {
      await handleCreateExperiment(req, res, { db, runSubmodule, getManifest });
    } catch (err) {
      // express 4 doesn't route async throws to the error middleware
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // ---- U6 read-only browse endpoints (GET only, zero writes) ----
  // The existing step-detail GET (runs.js) lazy-populates input_data back into
  // pipeline_stages — a write. The workbench browse must not mutate real-run
  // rows, hence these dedicated read-only routes.

  /**
   * GET /api/workbench/source-runs
   * Terminal (replayable) runs, newest first, with project name + entity names.
   */
  router.get('/source-runs', async (req, res) => {
    try {
      const { data: runs, error } = await db
        .from('pipeline_runs')
        .select('id, status, project_id, started_at, completed_at')
        .in('status', PINNABLE_STATUSES)
        .order('started_at', { ascending: false })
        .limit(50);
      if (error) return res.status(500).json({ error: error.message });

      const projectIds = [...new Set((runs || []).map(r => r.project_id).filter(Boolean))];
      let projectNames = {};
      if (projectIds.length > 0) {
        const { data: projects } = await db.from('projects').select('id, name').in('id', projectIds);
        projectNames = Object.fromEntries((projects || []).map(p => [p.id, p.name]));
      }

      const runIds = (runs || []).map(r => r.id);
      const entityNamesByRun = {};
      if (runIds.length > 0) {
        const { data: pools } = await db
          .from('entity_stage_pool').select('run_id, entity_name').in('run_id', runIds);
        for (const p of pools || []) {
          (entityNamesByRun[p.run_id] ||= new Set()).add(p.entity_name);
        }
      }

      res.json((runs || []).map(r => ({
        ...r,
        project_name: projectNames[r.project_id] || null,
        entity_names: [...(entityNamesByRun[r.id] || [])].sort(),
      })));
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/workbench/source-runs/:runId
   * Picker tree for one run: steps → submodules (historical options from
   * run_submodule_config, ran-flag from submodule_runs) + entities per step
   * (entity_stage_pool = exactly what an experiment can replay against).
   */
  router.get('/source-runs/:runId', async (req, res) => {
    try {
      const { runId } = req.params;
      const { data: run, error: runErr } = await db
        .from('pipeline_runs').select('id, status, project_id').eq('id', runId).maybeSingle();
      if (runErr) return res.status(500).json({ error: runErr.message });
      if (!run) return res.status(404).json({ error: `run ${runId} not found` });

      const { data: cfgs } = await db
        .from('run_submodule_config').select('step_index, submodule_id, options').eq('run_id', runId);
      const { data: subRuns } = await db
        .from('submodule_runs').select('step_index, submodule_id').eq('run_id', runId);
      const { data: pools } = await db
        .from('entity_stage_pool').select('step_index, entity_name').eq('run_id', runId);

      const steps = new Map();
      const step = (i) => {
        if (!steps.has(i)) steps.set(i, { step_index: i, submodules: new Map(), entities: new Set() });
        return steps.get(i);
      };
      for (const c of cfgs || []) {
        step(c.step_index).submodules.set(c.submodule_id, { submodule_id: c.submodule_id, options: c.options || {}, ran: false });
      }
      for (const s of subRuns || []) {
        const st = step(s.step_index);
        const existing = st.submodules.get(s.submodule_id);
        if (existing) existing.ran = true;
        else st.submodules.set(s.submodule_id, { submodule_id: s.submodule_id, options: {}, ran: true });
      }
      for (const p of pools || []) step(p.step_index).entities.add(p.entity_name);

      res.json({
        run_id: run.id,
        status: run.status,
        project_id: run.project_id,
        steps: [...steps.values()]
          .sort((a, b) => a.step_index - b.step_index)
          .map(s => ({
            step_index: s.step_index,
            submodules: [...s.submodules.values()].sort((a, b) => a.submodule_id.localeCompare(b.submodule_id)),
            entities: [...s.entities].sort(),
          })),
      });
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/workbench/source-runs/:runId/pin
   * Pin a run BEFORE experimenting — the same idempotent status='archived'
   * pin the experiment path performs (handleCreateExperiment step 1), exposed
   * standalone so a replayable run can be protected from the 7-day retention
   * sweep without burning an experiment first. This is the workbench's ONE
   * sanctioned real-run write besides workbench_experiments inserts.
   * Overloading pipeline_runs.status as the pin is a stopgap — the proper
   * long-term design is a dedicated workbench_pinned flag (see decision_log
   * 2026-07-30); deliberately not built here.
   */
  router.post('/source-runs/:runId/pin', async (req, res) => {
    try {
      const { runId } = req.params;
      const { data: run, error } = await db
        .from('pipeline_runs').select('id, status').eq('id', runId).maybeSingle();
      if (error) return res.status(500).json({ error: `run lookup failed: ${error.message}` });
      if (!run) return res.status(404).json({ error: `run ${runId} not found` });
      if (!PINNABLE_STATUSES.includes(run.status)) {
        return res.status(400).json({ error: `run is '${run.status}' — only terminal runs can be pinned` });
      }
      if (run.status !== 'archived') {
        const { error: pinErr } = await db
          .from('pipeline_runs').update({ status: 'archived' }).eq('id', runId);
        if (pinErr) return res.status(500).json({ error: `failed to pin run: ${pinErr.message}` });
      }
      res.json({ pinned: true, previous_status: run.status });
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  return router;
}

async function handleCreateExperiment(req, res, { db, runSubmodule, getManifest }) {
  const { source_run_id, step_index, submodule_id, entity_name, overrides, exclude_entity_submodule_run_id, parent_experiment_id } = req.body || {};
  if (!source_run_id || step_index == null || !submodule_id || !entity_name) {
    return res.status(400).json({ error: 'source_run_id, step_index, submodule_id, entity_name are required' });
  }
  if (overrides != null && (typeof overrides !== 'object' || Array.isArray(overrides))) {
    return res.status(400).json({ error: 'overrides must be an object' });
  }
  if (parent_experiment_id != null && typeof parent_experiment_id !== 'string') {
    return res.status(400).json({ error: 'parent_experiment_id must be a string' });
  }

  // 1. Pin the source run (spec §2 step 1) — idempotent, terminal runs only.
  const { data: run, error: runErr } = await db
    .from('pipeline_runs').select('id, status').eq('id', source_run_id).maybeSingle();
  if (runErr) return res.status(500).json({ error: `run lookup failed: ${runErr.message}` });
  if (!run) return res.status(404).json({ error: `run ${source_run_id} not found` });
  if (!PINNABLE_STATUSES.includes(run.status)) {
    return res.status(400).json({ error: `run is '${run.status}' — the workbench only replays terminal runs` });
  }

  const manifest = getManifest(submodule_id);
  if (!manifest) return res.status(404).json({ error: `submodule '${submodule_id}' not found` });

  // 2. Resolve options exactly as /run does (submoduleRuns.js step 5/5b) but
  // READ-ONLY: no 5a upsert back into run_submodule_config.
  const { data: optConfig } = await db
    .from('run_submodule_config')
    .select('options')
    .eq('run_id', source_run_id)
    .eq('step_index', step_index)
    .eq('submodule_id', submodule_id)
    .maybeSingle();
  const options = { ...(manifest.options_defaults || {}), ...(optConfig?.options || {}), ...(overrides || {}) };

  // doc_selector expansion (mirror of /run 5b): doc ID arrays → {filename: content}
  for (const optDef of (manifest.options || [])) {
    if (optDef.type === 'doc_selector' && Array.isArray(options[optDef.name])) {
      const docIds = options[optDef.name];
      if (docIds.length > 0) {
        const { data: docs } = await db
          .from('project_reference_docs').select('filename, content').in('id', docIds);
        options[optDef.name] = Object.fromEntries((docs || []).map(d => [d.filename, d.content]));
      } else {
        options[optDef.name] = {};
      }
    }
  }

  // 3. Load the frozen pool for (run, step, entity).
  const { data: pool, error: poolErr } = await db
    .from('entity_stage_pool')
    .select('pool_items')
    .eq('run_id', source_run_id)
    .eq('step_index', step_index)
    .eq('entity_name', entity_name)
    .maybeSingle();
  if (poolErr) return res.status(500).json({ error: `pool lookup failed: ${poolErr.message}` });
  if (!pool) {
    return res.status(404).json({ error: `no entity_stage_pool row for (${source_run_id}, step ${step_index}, ${entity_name}) — swept or never ran?` });
  }
  let items = pool.pool_items || [];

  // U8: chain — overlay the parent experiment's output onto the frozen pool
  // BEFORE the pin (a bad parent id must not archive a run as a side effect)
  // and before hydration (§7b then sees the parent's fields as present and
  // skips DB enrichment for them — experiment content wins).
  let chain = null;
  if (parent_experiment_id) {
    try {
      const overlaid = await applyParentOverlay({
        items, parentId: parent_experiment_id, source_run_id, entity_name, db, getManifest,
      });
      items = overlaid.items;
      // kept alongside dropped so pool starvation is visible at a glance
      chain = { parent_experiment_id, pool_items_dropped: overlaid.dropped, pool_items_kept: overlaid.kept };
    } catch (err) {
      return res.status(err.httpStatus || 500).json({ error: err.message });
    }
  }

  // Pin AFTER validation so a typo'd submodule/entity can't archive a run
  // as a side effect of a 404.
  if (run.status !== 'archived') {
    const { error: pinErr } = await db
      .from('pipeline_runs').update({ status: 'archived' }).eq('id', source_run_id);
    if (pinErr) return res.status(500).json({ error: `failed to pin run archived: ${pinErr.message}` });
  }

  // 4. Hydrate (U1, inside the harness) + execute (U2) under the ceiling.
  // On ceiling breach the harness keeps running detached; we record the
  // timeout and answer 504 — nothing it does afterwards can write anyway.
  const startedAt = Date.now();
  const baseRow = {
    source_run_id,
    step_index,
    submodule_id,
    entity_name,
    overrides: overrides || {},
    // Provenance on success AND error paths — a chained run that failed is
    // still a chained run.
    parent_experiment_id: parent_experiment_id || null,
  };
  let harnessResult;
  try {
    harnessResult = await Promise.race([
      runSubmodule({
        submodule_id,
        entity: { name: entity_name, items },
        options,
        run_id: source_run_id,
        step_index,
        hydrate: true,
        exclude_run_id: exclude_entity_submodule_run_id,
      }, { db }),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(Object.assign(new Error(`workbench execution ceiling (${EXECUTION_CEILING_MS}ms) exceeded`), { isCeiling: true })),
          EXECUTION_CEILING_MS,
        ).unref?.();
      }),
    ]);
  } catch (err) {
    const experiment = await insertExperiment({
      ...baseRow,
      resolved_config: options,
      duration_ms: Date.now() - startedAt,
      status: err.isCeiling ? 'timeout' : 'error',
      error: err.message,
    }, db);
    return res.status(err.isCeiling ? 504 : 500)
      .json({
        error: err.message,
        experiment,
        replay_fidelity: REPLAY_FIDELITY_NOTE,
        // a chained run that failed is still a chained run — same marker as the 201 path
        source: chain ? 'chained' : 'pool',
        chain: chain,
      });
  }

  // 5. Insert the ONE experiment row (spec §2 step 5) and return it.
  const meta = harnessResult.result?.meta || {};
  const experiment = await insertExperiment({
    ...baseRow,
    resolved_config: harnessResult.resolvedOptions,
    frozen_input: items, // hydrated in place by U1 — this IS what execute() consumed
    output_data: harnessResult.result,
    ai_usage: meta.ai_usage || null,
    duration_ms: Date.now() - startedAt,
    status: meta.status === 'error' ? 'error' : 'completed',
    error: meta.error || null,
  }, db);

  // source/chain are ALWAYS present — two live runs came back unchained
  // (parent_experiment_id: null), scored the pool, and were indistinguishable
  // from chained runs because the key was simply absent. An explicit
  // source:'pool' + chain:null makes "what did this run read" unambiguous.
  return res.status(201).json({
    experiment,
    replay_fidelity: REPLAY_FIDELITY_NOTE,
    source: chain ? 'chained' : 'pool',
    chain: chain,
  });
}
