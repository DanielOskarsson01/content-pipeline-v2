/**
 * Automated data retention — deletes pipeline run data older than RETENTION_DAYS.
 * Runs once on startup (after 60s delay) and then every 24 hours.
 * Only deletes terminal runs (completed/halted/abandoned). Active runs are preserved.
 * Preserves projects and templates.
 */
import db from './db.js';

const RETENTION_DAYS = 7;
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const STARTUP_DELAY_MS = 60 * 1000; // 60s after boot
const BATCH_SIZE = 200;

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
    .lt('created_at', cutoff);

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

export function startRetention() {
  setTimeout(async () => {
    try {
      await cleanOldRuns();
    } catch (err) {
      console.error('[retention] Error:', err.message);
    }
    setInterval(async () => {
      try {
        await cleanOldRuns();
      } catch (err) {
        console.error('[retention] Error:', err.message);
      }
    }, INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}
