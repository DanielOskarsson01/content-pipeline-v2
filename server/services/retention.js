/**
 * Automated data retention — deletes pipeline run data older than RETENTION_DAYS.
 * Runs once on startup (after 60s delay) and then every 24 hours.
 * Only deletes terminal runs (completed/halted/abandoned). Active runs are preserved.
 * Preserves projects and templates.
 *
 * Also runs a stale-attended pass (sweepStaleAttendedRuns) that marks long-idle
 * attended runs (status='running' with no submodule/batch execution, no human
 * decision-log activity, and no live job) as abandoned — making them terminal so
 * the deletion sweep can eventually collect them. The pass only adds a status
 * transition; it never deletes and never changes the deletion sweep's rules.
 */
import db from './db.js';
import { abandonRun } from './abandonRun.js';

const RETENTION_DAYS = 7;
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const STARTUP_DELAY_MS = 60 * 1000; // 60s after boot
const BATCH_SIZE = 200;

// --- Stale-attended pass ---------------------------------------------------
// 14 days: double the 7-day retention window and far longer than any plausible
// attended session. A human working a run touches it (a submodule, a batch, or a
// step approval — all of which stamp a fresh timestamp) far more often than once
// per fortnight, so two weeks of zero activity of ANY kind on a 'running' run
// means abandoned, not slow. Configured here; override with STALE_ATTENDED_DAYS.
const STALE_ATTENDED_DAYS = Number(process.env.STALE_ATTENDED_DAYS) || 14;
const STALE_ATTENDED_MS = STALE_ATTENDED_DAYS * 24 * 60 * 60 * 1000;

// entity_submodule_runs / submodule_runs statuses that mean the row has FINISHED.
// Anything else (pending, running, queued, or an unrecognised value) counts as
// live work in flight — the safe direction: unknown ⇒ do not abandon. The enqueue
// path (queue.js) always writes the run row BEFORE creating the BullMQ job, so
// "no non-terminal row" is a sound proxy for "no live queue job".
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'approved', 'skipped', 'skipped_no_input']);

// All tables with a direct run_id column (order matters: children before parents)
const RUN_ID_TABLES = [
  'analysis_results',
  'approval_routing',
  'citation_index',
  'content_draft',
  'content_drafts',
  'decision_log',
  'distribution_audit_log',
  'distribution_outputs',
  'entity_routing_log',
  'entity_run_meta',
  'entity_stage_pool',
  'entity_submodule_runs',
  'manual_review_comments',
  'pipeline_metrics',
  'qa_fail_log',
  'qa_results',
  'run_entities',
  'run_submodule_config',
  'seo_plans',
  'sources_final',
  'step_context',
  'submodule_runs',
  'taxonomy_suggestions',
  'workflow_events',
  'pipeline_stages',
];

async function deleteBatch(table, column, ids) {
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const { error } = await db.from(table).delete().in(column, batch);
    if (error) console.error(`[retention] ${table}: ${error.message}`);
  }
}

async function cleanOldRuns() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Only delete terminal runs — never touch active/running pipelines
  const { data: oldRuns, error: fetchErr } = await db
    .from('pipeline_runs')
    .select('id')
    .in('status', ['completed', 'halted', 'abandoned'])
    .lt('started_at', cutoff);

  if (fetchErr) {
    console.error('[retention] Failed to query old runs:', fetchErr.message);
    return;
  }

  if (!oldRuns?.length) {
    console.log('[retention] No terminal runs older than 7 days — nothing to clean.');
    return;
  }

  const runIds = oldRuns.map(r => r.id);
  console.log(`[retention] Cleaning ${runIds.length} run(s) older than ${cutoff.slice(0, 10)}...`);

  // First: delete submodule_run_item_data (linked via submodule_run_id, not run_id)
  for (let i = 0; i < runIds.length; i += BATCH_SIZE) {
    const batch = runIds.slice(i, i + BATCH_SIZE);
    const { data: subRuns } = await db
      .from('submodule_runs')
      .select('id')
      .in('run_id', batch);

    if (subRuns?.length) {
      await deleteBatch('submodule_run_item_data', 'submodule_run_id', subRuns.map(s => s.id));
    }
  }

  // Then: delete all tables with direct run_id
  for (const table of RUN_ID_TABLES) {
    await deleteBatch(table, 'run_id', runIds);
  }

  // Finally: delete the pipeline_runs themselves
  await deleteBatch('pipeline_runs', 'id', runIds);

  console.log(`[retention] Cleaned ${runIds.length} run(s) and all associated data.`);
}

/**
 * Pure decision: is an attended run genuinely idle and safe to abandon? Elapsed
 * time alone is never sufficient — a run with live work in flight, or with recent
 * submodule activity, is always spared however old it is.
 * @param {{started_at:string}} run
 * @param {{hasLiveWork:boolean, lastActivityMs:number|null}} activity
 * @param {number} nowMs
 * @param {number} [staleMs]
 * @returns {boolean}
 */
export function isStaleAttended(run, activity, nowMs, staleMs = STALE_ATTENDED_MS) {
  if (activity.hasLiveWork) return false;                                   // a submodule job is in flight
  if (nowMs - new Date(run.started_at).getTime() < staleMs) return false;   // the run itself is young
  if (activity.lastActivityMs != null && nowMs - activity.lastActivityMs < staleMs) return false; // acted recently
  return true;
}

// Reduce a run's activity across ALL signals to { hasLiveWork, lastActivityMs }.
// Any touch counts as activity: a submodule/batch execution OR a decision-log
// entry (step approvals, reopens, routing — the work an attended run does between
// submodule runs). A non-terminal submodule/batch row means work is in flight.
function summariseActivity({ esr, submoduleRuns, decisions }) {
  let hasLiveWork = false;
  let lastActivityMs = null;
  const bump = (ts) => {
    if (!ts) return;
    const ms = new Date(ts).getTime();
    if (lastActivityMs == null || ms > lastActivityMs) lastActivityMs = ms;
  };
  for (const r of [...(esr || []), ...(submoduleRuns || [])]) {
    if (!TERMINAL_RUN_STATUSES.has(r.status)) hasLiveWork = true;
    bump(r.started_at);
    bump(r.completed_at);
  }
  for (const d of decisions || []) bump(d.decided_at); // human/system touch
  return { hasLiveWork, lastActivityMs };
}

/**
 * Mark long-idle ATTENDED runs (status='running') as abandoned via the shared
 * abandonRun transition, so the terminal-run sweep can eventually collect them.
 * Only touches 'running' runs — auto_executing, paused, and terminal runs are
 * left untouched. Deletes nothing.
 * @returns {Promise<number>} count of runs abandoned
 */
export async function sweepStaleAttendedRuns({ db: dbClient = db, now = Date.now() } = {}) {
  const { data: runs, error } = await dbClient
    .from('pipeline_runs')
    .select('id, started_at, status')
    .eq('status', 'running');

  if (error) {
    console.error('[retention:stale-attended] Failed to query running runs:', error.message);
    return 0;
  }
  if (!runs?.length) return 0;

  let abandoned = 0;
  for (const run of runs) {
    const [esrRes, srRes, dlRes] = await Promise.all([
      dbClient.from('entity_submodule_runs').select('status, started_at, completed_at').eq('run_id', run.id),
      dbClient.from('submodule_runs').select('status, started_at, completed_at').eq('run_id', run.id),
      dbClient.from('decision_log').select('decided_at').eq('run_id', run.id),
    ]);

    const readErr = esrRes.error || srRes.error || dlRes.error;
    if (readErr) {
      console.error(`[retention:stale-attended] Failed to read activity for ${run.id}:`, readErr.message);
      continue; // never abandon a run we could not verify is idle
    }

    const activity = summariseActivity({ esr: esrRes.data, submoduleRuns: srRes.data, decisions: dlRes.data });
    if (!isStaleAttended(run, activity, now)) continue;

    const lastSeen = activity.lastActivityMs != null
      ? new Date(activity.lastActivityMs).toISOString()
      : 'never';
    const reason = `stale-attended: 'running' with no submodule/batch/decision activity for >= ${STALE_ATTENDED_DAYS}d `
      + `(last activity ${lastSeen}; no live queue job)`;
    console.warn(`[retention:stale-attended] Abandoning run ${run.id} — ${reason}`);

    try {
      await abandonRun(run.id, reason, dbClient);
      abandoned++;
    } catch (err) {
      console.error(`[retention:stale-attended] Failed to abandon ${run.id}:`, err.message);
    }
  }

  if (abandoned) {
    console.log(`[retention:stale-attended] Marked ${abandoned} stale attended run(s) abandoned.`);
  }
  return abandoned;
}

// One retention cycle: delete old terminal runs first, THEN transition newly-
// stale attended runs — so a run abandoned this cycle survives at least one full
// cycle (an audit window) before the next cycle's delete can collect it.
async function runRetentionCycle() {
  try {
    await cleanOldRuns();
  } catch (err) {
    console.error('[retention] cleanOldRuns error:', err.message);
  }
  try {
    await sweepStaleAttendedRuns();
  } catch (err) {
    console.error('[retention:stale-attended] error:', err.message);
  }
}

export function startRetention() {
  setTimeout(async () => {
    await runRetentionCycle();
    setInterval(runRetentionCycle, INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}
