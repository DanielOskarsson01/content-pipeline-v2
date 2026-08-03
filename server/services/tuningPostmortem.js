/**
 * Tuning postmortem builder (TUNING-SESSIONS v1, T5 + the T6 summary data layer).
 *
 * A postmortem is a small, FIXED-SCHEMA digest of one (run, entity) tuning
 * session: per step, every attempt (experiment) tried, its overrides + its
 * derived `metrics` block (words/sections/thin/marker-leaks/citations/tokens/
 * cost) — metrics ONLY, never the article body, so files stay a few KB — with
 * the accepted attempt flagged and what changed between iterations. Fixed schema
 * + template_id keying make postmortems comparable across runs and templates
 * (the copilot's cross-run evidence base — decision 5).
 *
 * There is exactly one session per (run, entity) (UNIQUE), so EVERY experiment
 * for that (run, entity) is this session's attempt history — including the ones
 * run BEFORE the first accept created the session row. (A created_at >= session
 * filter wrongly dropped the founding step's own accepted attempt — review T5.)
 *
 * `db` is injected. Reads only; writes go through an injected postmortem store.
 */
import { getSessionSteps } from './tuningSessions.js';

export const POSTMORTEM_SCHEMA = 'tuning-postmortem/v1';

export function postmortemKey(session) {
  const slug = String(session.entity_name || 'entity')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'entity';
  return `tuning/${session.source_run_id}/${slug}.json`;
}

function changedKeys(prev, cur) {
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(cur || {})]);
  return [...keys].filter(k => JSON.stringify(prev?.[k]) !== JSON.stringify(cur?.[k]));
}

const METRIC_DELTA_FIELDS = ['words', 'h2_sections', 'thin_sections', 'distinct_citations', 'broken_refs', 'tokens_out', 'cost_usd'];
function metricDeltas(prev, cur) {
  if (!prev || !cur) return null;
  const out = {};
  for (const f of METRIC_DELTA_FIELDS) {
    if (typeof prev[f] === 'number' && typeof cur[f] === 'number') out[f] = cur[f] - prev[f];
  }
  return Object.keys(out).length ? out : null;
}

/** Build the fixed-schema postmortem object for a session. */
export async function buildPostmortem(session, db) {
  const accepted = await getSessionSteps(session.id, db);
  const acceptedByStep = new Map(accepted.map(s => [s.step_index, s]));

  const { data: exps, error } = await db
    .from('workbench_experiments')
    .select('id, step_index, submodule_id, overrides, metrics, status, created_at, parent_experiment_id')
    .eq('source_run_id', session.source_run_id)
    .eq('entity_name', session.entity_name)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`postmortem experiment read failed: ${error.message}`);

  const byStep = new Map();
  for (const e of exps || []) {
    if (!byStep.has(e.step_index)) byStep.set(e.step_index, []);
    byStep.get(e.step_index).push(e);
  }

  // template identity (best-effort): run -> project -> template
  let template_id = null; let template_name = null;
  const { data: run } = await db.from('pipeline_runs').select('project_id').eq('id', session.source_run_id).maybeSingle();
  if (run?.project_id) {
    const { data: proj } = await db.from('projects').select('template_id').eq('id', run.project_id).maybeSingle();
    if (proj?.template_id) {
      const { data: tpl } = await db.from('templates').select('id, name').eq('id', proj.template_id).maybeSingle();
      template_id = tpl?.id ?? proj.template_id;
      template_name = tpl?.name ?? null;
    }
  }

  const stepIndices = [...new Set([...acceptedByStep.keys(), ...byStep.keys()])].sort((a, b) => a - b);
  const steps = stepIndices.map(si => {
    const acc = acceptedByStep.get(si) || null;
    const raw = byStep.get(si) || [];
    let prev = null;
    const attempts = raw.map(e => {
      const overrides = e.overrides || {};
      const attempt = {
        experiment_id: e.id,
        accepted: acc?.experiment_id === e.id,
        status: e.status,
        overrides,
        metrics: e.metrics || null, // metrics only — NO article body
        parent_experiment_id: e.parent_experiment_id || null,
        created_at: e.created_at,
        changed_from_previous: prev ? changedKeys(prev.overrides, overrides) : Object.keys(overrides),
        metric_deltas: prev ? metricDeltas(prev.metrics, e.metrics) : null,
      };
      prev = e;
      return attempt;
    });
    return {
      step_index: si,
      submodule_id: acc?.submodule_id || raw[0]?.submodule_id || null,
      accepted_experiment_id: acc?.experiment_id || null,
      attempt_count: attempts.length,
      attempts,
    };
  });

  return {
    schema: POSTMORTEM_SCHEMA,
    session_id: session.id,
    source_run_id: session.source_run_id,
    entity_name: session.entity_name,
    template_id,
    template_name,
    created_at: session.created_at,
    updated_at: session.updated_at ?? null,
    step_count: steps.length,
    steps,
  };
}

/**
 * Build + persist the postmortem to the durable store. Called after each accept
 * (continuous, overwrite — the file grows as steps are accepted). Returns
 * { key, bytes, location } or null if no store is configured.
 */
export async function writePostmortem(session, db, store) {
  if (!store) return null;
  const pm = await buildPostmortem(session, db);
  const json = JSON.stringify(pm, null, 2);
  const key = postmortemKey(session);
  const { bytes, location } = await store.put(key, json);
  return { key, bytes, location };
}
