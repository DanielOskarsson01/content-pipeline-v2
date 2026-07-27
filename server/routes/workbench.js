/**
 * Workbench experiments endpoint (WORKBENCH_DESIGN.md §b Unit 4).
 *
 * POST /api/workbench/experiments
 *   { source_run_id, step_index, submodule_id, entity_name,
 *     overrides?, exclude_entity_submodule_run_id? }
 *
 * Flow (spec §2): pin source run archived (idempotent) → load frozen pool →
 * hydrate via U1 (inside the U2 harness) → execute in-process → insert ONE
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

  return router;
}

async function handleCreateExperiment(req, res, { db, runSubmodule, getManifest }) {
  const { source_run_id, step_index, submodule_id, entity_name, overrides, exclude_entity_submodule_run_id } = req.body || {};
  if (!source_run_id || step_index == null || !submodule_id || !entity_name) {
    return res.status(400).json({ error: 'source_run_id, step_index, submodule_id, entity_name are required' });
  }
  if (overrides != null && (typeof overrides !== 'object' || Array.isArray(overrides))) {
    return res.status(400).json({ error: 'overrides must be an object' });
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
  const items = pool.pool_items || [];

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
      .json({ error: err.message, experiment, replay_fidelity: REPLAY_FIDELITY_NOTE });
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

  return res.status(201).json({ experiment, replay_fidelity: REPLAY_FIDELITY_NOTE });
}
