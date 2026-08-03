/**
 * Workbench forward chains (A2) — run the rest of the pipeline forward from a
 * completed experiment: POST /api/workbench/chains { start_experiment_id,
 * from_step, to_step, … } executes each step's configured submodules in order,
 * each hop an ordinary workbench experiment chained onto the accumulated
 * ancestor set. Judges a submodule change where it matters: the FINISHED
 * article, not one checker's verdict.
 *
 * DESIGN (PHASE-A-WORKBENCH A2):
 *  - Hops = run_submodule_config rows for the SOURCE run in [from_step,
 *    to_step], steps ascending, submodule_id ascending within a step (order
 *    within a step has no semantic effect — see sibling rule).
 *  - SIBLING RULE: submodules in one step all chain to the same ancestor set
 *    (the start experiment + every completed hop from EARLIER steps). They
 *    are siblings, not a chain among themselves — a checker never reads a
 *    sibling checker's verdict.
 *  - PROVENANCE: each hop's row records parent_experiment_id = the
 *    immediately preceding hop in execution order (first hop → the start
 *    experiment), so a chain is a linked list reconstructible from rows
 *    alone. What a hop actually READ is the response's read_from list (also
 *    persisted implicitly: frozen_input is the exact hydrated input).
 *  - STEP 7 (loop-router): the hop runs and its routing verdict is reported,
 *    but the chain CONTINUES to 8/9 regardless — production deliberately does
 *    not gate delivery on flag_manual (a human decides), and the forward
 *    chain mirrors that. Routing loops are NOT executed: this is a forward
 *    simulation, not a loop engine.
 *  - FAILURE: fail-closed. A hop that errors or times out STOPS the chain —
 *    a truncated output must never supersede a complete one, and a missing
 *    verdict must never yield a final bundle with a silently partial qa
 *    block. qa_pass:false is a verdict, not an error — the chain continues.
 *  - COST CAP: refuses BEFORE each hop on estimates — it can never start a
 *    hop the estimates say would cross the cap, but it is NOT a hard billing
 *    ceiling: one hop can overshoot by (actual − estimate), and Perplexity
 *    sonar PER-SEARCH FEES are invisible in token counts, so sonar hops ride
 *    partly outside the cap (aiCost.js discloses the same). Estimates come
 *    from the most recent completed experiment for the same (run, submodule),
 *    else a conservative per-model flat rate (manifest defaults consulted, so
 *    a never-ran AI hop is never priced at the non-AI floor).
 *
 * No-write contract: identical to /experiments — each hop writes exactly one
 * workbench_experiments row (plus the idempotent pin on the first hop).
 */
import { runExperimentCore } from './workbench.js';
import { costOfUsage } from '../lib/aiCost.js';

export const CHAIN_DEFAULT_MAX_COST_USD = 3.0;
export const CHAIN_DEFAULT_MAX_HOPS = 8;

// Conservative per-hop USD when no historical experiment exists to price from.
// Deliberately high-side (sonnet at ~100k-in/4k-out ≈ $0.36 → charged 1.00).
const FLAT_ESTIMATE_BY_MODEL = {
  sonnet: 1.0, opus: 3.0, haiku: 0.15,
  'gpt-4o': 0.5, 'gpt-4o-mini': 0.05, sonar: 0.25, 'sonar-pro': 0.5,
};
const NON_AI_HOP_USD = 0.005;

// Scalar verdict fields worth surfacing per hop without reading output_data.
const SUMMARY_FIELDS = [
  'qa_pass', 'structural_score', 'hallucination_score', 'citation_score',
  'section_count', 'total_words', 'word_count', 'verified_claims_count',
  'decision', 'routing_decision', 'meta_title',
];

const round4 = (n) => Math.round(n * 1e4) / 1e4;

function hopSummary(experiment) {
  const item0 = experiment?.output_data?.items?.[0] || {};
  const out = {};
  for (const f of SUMMARY_FIELDS) if (item0[f] != null) out[f] = item0[f];
  const metaStatus = experiment?.output_data?.meta?.status;
  if (metaStatus) out.meta_status = metaStatus;
  return out;
}

/**
 * POST /api/workbench/chains — returns { status, body }.
 */
// One chain per start experiment per process — a dropped POST leaves the
// server executing (nginx read-timeout is shorter than a long chain), and a
// retry click must not double-spend. ponytail: in-process Set; per-process
// only (fine while the api runs as a single fork).
const ACTIVE_CHAIN_STARTS = new Set();

export async function runForwardChain(params, deps) {
  const { db, getManifest } = deps;
  const {
    start_experiment_id, from_step, to_step,
    overrides_per_submodule = {},
    max_cost_usd = CHAIN_DEFAULT_MAX_COST_USD,
    max_hops = CHAIN_DEFAULT_MAX_HOPS,
    dry_run = false,
  } = params || {};
  const bad = (status, error) => ({ status, body: { error } });

  if (!start_experiment_id || typeof start_experiment_id !== 'string') {
    return bad(400, 'start_experiment_id is required');
  }
  if (!Number.isInteger(from_step) || !Number.isInteger(to_step) || from_step > to_step) {
    return bad(400, 'from_step and to_step must be integers with from_step <= to_step');
  }
  if (typeof max_cost_usd !== 'number' || max_cost_usd <= 0) return bad(400, 'max_cost_usd must be a positive number');
  if (!Number.isInteger(max_hops) || max_hops <= 0) return bad(400, 'max_hops must be a positive integer');

  // Start experiment anchors the chain: run, entity, and the artifact under test.
  const { data: start, error: startErr } = await db
    .from('workbench_experiments')
    .select('id, source_run_id, entity_name, submodule_id, step_index, status')
    .eq('id', start_experiment_id)
    .maybeSingle();
  if (startErr) return bad(500, `start experiment lookup failed: ${startErr.message}`);
  if (!start) return bad(404, `start experiment ${start_experiment_id} not found`);
  if (start.status !== 'completed') {
    return bad(409, `start experiment is '${start.status}' — only completed experiments can start a chain`);
  }
  const source_run_id = start.source_run_id;
  const entity_name = start.entity_name;

  // The plan: replay parity — the submodules THIS run was configured with.
  const { data: cfgs, error: cfgErr } = await db
    .from('run_submodule_config')
    .select('step_index, submodule_id, options')
    .eq('run_id', source_run_id)
    .gte('step_index', from_step)
    .lte('step_index', to_step);
  if (cfgErr) return bad(500, `run_submodule_config lookup failed: ${cfgErr.message}`);
  const planned = (cfgs || [])
    .sort((a, b) => a.step_index - b.step_index || a.submodule_id.localeCompare(b.submodule_id));
  if (planned.length === 0) {
    return bad(400, `no submodules configured for run ${source_run_id} in steps ${from_step}–${to_step}`);
  }
  // Critic F4: overrides are THE knob a forward chain exists to exercise —
  // a typo'd submodule id silently no-ops the whole experiment.
  const plannedIds = new Set(planned.map(p => p.submodule_id));
  const unknownOverrides = Object.keys(overrides_per_submodule).filter(k => !plannedIds.has(k));
  if (unknownOverrides.length > 0) {
    return bad(400, `overrides_per_submodule keys not in the planned hops: ${unknownOverrides.join(', ')} (planned: ${[...plannedIds].join(', ')})`);
  }
  if (planned.length > max_hops) {
    return bad(400, `chain would run ${planned.length} hops (${planned.map(p => `${p.step_index}:${p.submodule_id}`).join(', ')}) — over the max_hops ceiling of ${max_hops}; raise max_hops or narrow the step range`);
  }

  // Per-hop cost estimates: most recent completed experiment for the same
  // (run, submodule) — ANY entity of the run (deliberate: cross-entity priors
  // beat flat rates, and single-entity runs are the common case anyway).
  // A caller override that changes ai_model invalidates the prior (it priced
  // a different model) — the flat rate for the OVERRIDE model wins instead,
  // so the cap can never under-refuse because of a cheap-model prior.
  const estimates = new Map();
  for (const p of planned) {
    const overrideModel = overrides_per_submodule[p.submodule_id]?.ai_model;
    // Never-ran submodules have options:null in run_submodule_config — the
    // manifest's own defaults are the executor's fallback (workbench.js
    // resolves defaults ← config ← overrides), so the estimator must consult
    // them too or a real AI hop estimates at the non-AI floor (critic F1).
    const manifestModel = getManifest?.(p.submodule_id)?.options_defaults?.ai_model;
    const configModel = p.options?.ai_model ?? manifestModel;
    const effectiveModel = overrideModel ?? configModel;
    let est = null;
    if (overrideModel == null || overrideModel === configModel) {
      const { data: prior } = await db
        .from('workbench_experiments')
        .select('ai_usage')
        .eq('source_run_id', source_run_id)
        .eq('submodule_id', p.submodule_id)
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (prior?.ai_usage) est = costOfUsage(prior.ai_usage);
      // A prior WITHOUT ai_usage only proves the hop CAN run AI-free; trust
      // it as cheap only when no model is in play at all (critic F1).
      else if (prior && effectiveModel == null) est = NON_AI_HOP_USD;
    }
    if (est == null) {
      est = effectiveModel != null ? (FLAT_ESTIMATE_BY_MODEL[effectiveModel] ?? 3.0) : NON_AI_HOP_USD;
    }
    estimates.set(`${p.step_index}:${p.submodule_id}`, est);
  }
  const estimateTotal = [...estimates.values()].reduce((a, b) => a + b, 0);

  const plannedOut = planned.map(p => ({
    step_index: p.step_index,
    submodule_id: p.submodule_id,
    estimate_usd: round4(estimates.get(`${p.step_index}:${p.submodule_id}`)),
  }));

  // Generic plan warnings (no per-module knowledge): the sibling rule
  // mis-models intra-step dependencies at generation steps (prod runs
  // analyzer→planner→writer→tse sequentially within step 5), and a chain
  // starting at or before the start experiment's own step folds a later
  // artifact onto an earlier pool.
  const warnings = [];
  const byStep = new Map();
  for (const p of planned) byStep.set(p.step_index, (byStep.get(p.step_index) || 0) + 1);
  for (const [step, n] of byStep) {
    if (step > 4 && n > 1) {
      warnings.push(`step ${step} runs ${n} submodules as SIBLINGS (same input, no intra-step chaining) — production runs generation-step submodules sequentially, so intra-step dependencies are not modeled`);
    }
  }
  if (from_step <= start.step_index) {
    warnings.push(`from_step ${from_step} is at or before the start experiment's step ${start.step_index} — its output will be folded onto an earlier pool`);
  }
  for (let step = from_step; step <= to_step; step++) {
    if (!byStep.has(step)) warnings.push(`step ${step}: nothing configured in this run — skipped`);
  }

  // Cost preview for the UI: plan + estimates, zero execution, zero writes.
  if (dry_run) {
    return {
      status: 200,
      body: {
        chain_status: 'dry_run',
        stop: null,
        start_experiment_id: start.id,
        source_run_id,
        entity_name,
        from_step,
        to_step,
        planned_hops: plannedOut,
        warnings,
        estimate_total_usd: round4(estimateTotal),
        max_cost_usd,
        max_hops,
        hops: [],
        totals: { cost_usd: 0, tokens_in: 0, tokens_out: 0, duration_ms: 0 },
      },
    };
  }

  if (ACTIVE_CHAIN_STARTS.has(start.id)) {
    return bad(409, `a chain from start experiment ${start.id} is already executing in this process — wait for it (poll GET /chains/${start.id}) instead of double-spending`);
  }
  ACTIVE_CHAIN_STARTS.add(start.id);
  try {

  const hops = [];
  let spentUsd = 0;
  let chainStatus = 'completed';
  let stop = null;

  for (const p of planned) {
    const est = estimates.get(`${p.step_index}:${p.submodule_id}`);
    if (spentUsd + est > max_cost_usd) {
      chainStatus = 'refused_cost_cap';
      stop = {
        reason: `hop ${p.step_index}:${p.submodule_id} estimated at $${round4(est)} would take the chain past the $${max_cost_usd} cap (spent so far: $${round4(spentUsd)})`,
        refused_hop: { step_index: p.step_index, submodule_id: p.submodule_id, estimate_usd: round4(est) },
      };
      break;
    }

    // Sibling rule: ancestors = start + completed hops from EARLIER steps only.
    const ancestors = [
      start.id,
      ...hops.filter(h => h.step_index < p.step_index).map(h => h.experiment_id),
    ];
    // Linked-list provenance: previous hop in execution order (or the start).
    const recordParent = hops.length > 0 ? hops[hops.length - 1].experiment_id : start.id;

    // Critic F6: an insertExperiment throw must not nuke the chain report —
    // hops that ran and money spent stay in the response.
    let r;
    try {
      r = await runExperimentCore({
        source_run_id,
        step_index: p.step_index,
        submodule_id: p.submodule_id,
        entity_name,
        overrides: overrides_per_submodule[p.submodule_id],
        overlay_parent_ids: ancestors,
        record_parent_id: recordParent,
      }, deps);
    } catch (err) {
      r = { status: 500, body: { error: `hop threw outside the harness: ${err.message}` } };
    }

    const exp = r.body?.experiment;
    const hopCost = exp ? costOfUsage(exp.ai_usage) : 0;
    spentUsd += hopCost;
    const usage = exp?.ai_usage;
    const hop = {
      step_index: p.step_index,
      submodule_id: p.submodule_id,
      experiment_id: exp?.id || null,
      parent_experiment_id: recordParent,
      read_from: ancestors,
      status: exp?.status || 'error',
      http_status: r.status,
      error: r.body?.error || exp?.error || null,
      duration_ms: exp?.duration_ms ?? null,
      tokens_in: usage?.tokens_in_total ?? 0,
      tokens_out: usage?.tokens_out_total ?? 0,
      cost_usd: round4(hopCost),
      pool_items_dropped: r.body?.chain?.pool_items_dropped ?? null,
      pool_items_kept: r.body?.chain?.pool_items_kept ?? null,
      overlay_warning: r.body?.chain?.warning ?? null,
      summary: hopSummary(exp),
      // full row minus frozen_input (megabytes of hydrated pool) so the UI
      // can render each hop with ExperimentResultView without a second fetch
      experiment: exp ? { ...exp, frozen_input: undefined } : null,
    };
    hops.push(hop);

    // Fail-closed: anything but a clean completed hop stops the chain.
    if (r.status !== 201 || hop.status !== 'completed') {
      chainStatus = 'stopped_error';
      stop = { reason: `hop ${p.step_index}:${p.submodule_id} ${hop.status} — ${hop.error || 'see experiment row'}`, failed_hop_experiment_id: hop.experiment_id };
      break;
    }
  }

  return {
    status: chainStatus === 'completed' ? 201 : 200,
    body: {
      chain_status: chainStatus,
      stop,
      start_experiment_id: start.id,
      source_run_id,
      entity_name,
      from_step,
      to_step,
      planned_hops: plannedOut,
      warnings,
      estimate_total_usd: round4(estimateTotal),
      max_cost_usd,
      max_hops,
      hops,
      totals: {
        cost_usd: round4(spentUsd),
        tokens_in: hops.reduce((a, h) => a + h.tokens_in, 0),
        tokens_out: hops.reduce((a, h) => a + h.tokens_out, 0),
        duration_ms: hops.reduce((a, h) => a + (h.duration_ms || 0), 0),
      },
    },
  };

  } finally {
    ACTIVE_CHAIN_STARTS.delete(start.id);
  }
}

/**
 * GET /api/workbench/chains/:startId — reconstruct chain hops from rows alone
 * (linked-list walk over parent_experiment_id, BFS so a start reused by
 * several chains shows everything). Read-only; the UI polls this while a
 * POST is in flight.
 */
export async function getChainTree(startId, { db }) {
  const bad = (status, error) => ({ status, body: { error } });
  const { data: start, error: startErr } = await db
    .from('workbench_experiments')
    .select('id, source_run_id, entity_name, submodule_id, step_index, status, created_at')
    .eq('id', startId)
    .maybeSingle();
  if (startErr) return bad(500, `start lookup failed: ${startErr.message}`);
  if (!start) return bad(404, `experiment ${startId} not found`);

  // JSON-path select: only item 0 and meta.status ride over the wire — full
  // output_data across a run's experiments is megabytes of article text.
  const { data: rows, error: rowsErr } = await db
    .from('workbench_experiments')
    .select('id, submodule_id, step_index, status, parent_experiment_id, duration_ms, ai_usage, created_at, item0:output_data->items->0, meta_status:output_data->meta->>status')
    .eq('source_run_id', start.source_run_id)
    .eq('entity_name', start.entity_name)
    .order('created_at', { ascending: true });
  if (rowsErr) return bad(500, `chain rows lookup failed: ${rowsErr.message}`);

  const children = new Map();
  for (const r of rows || []) {
    if (!r.parent_experiment_id) continue;
    if (!children.has(r.parent_experiment_id)) children.set(r.parent_experiment_id, []);
    children.get(r.parent_experiment_id).push(r);
  }
  const hops = [];
  const queue = [start.id];
  const seen = new Set([start.id]);
  while (queue.length > 0) {
    const id = queue.shift();
    for (const child of children.get(id) || []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      hops.push({
        experiment_id: child.id,
        submodule_id: child.submodule_id,
        step_index: child.step_index,
        status: child.status,
        parent_experiment_id: child.parent_experiment_id,
        duration_ms: child.duration_ms,
        cost_usd: round4(costOfUsage(child.ai_usage)),
        created_at: child.created_at,
        summary: hopSummary({ output_data: { items: [child.item0 || {}], meta: { status: child.meta_status } } }),
      });
      queue.push(child.id);
    }
  }
  return {
    status: 200,
    body: {
      start: { experiment_id: start.id, submodule_id: start.submodule_id, step_index: start.step_index, status: start.status },
      hops,
    },
  };
}
