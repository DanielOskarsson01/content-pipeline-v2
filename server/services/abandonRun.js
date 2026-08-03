/**
 * abandonRun — the single status transition that marks a pipeline run abandoned
 * (a terminal state). Extracted from the POST /api/runs/:id/abandon handler so
 * the manual route and the automated stale-attended retention pass share ONE
 * mechanism rather than two divergent copies.
 *
 * It performs the transition only; callers own the precondition checks (the HTTP
 * route rejects completed/auto_executing runs; the retention pass proves the run
 * is genuinely idle first). The optional dbClient makes it hermetically testable.
 */
import defaultDb from './db.js';

export async function abandonRun(runId, reason, dbClient = defaultDb) {
  await dbClient
    .from('pipeline_runs')
    .update({ status: 'abandoned', completed_at: new Date().toISOString() })
    .eq('id', runId);

  await dbClient
    .from('decision_log')
    .insert({
      run_id: runId,
      step_index: 0,
      decision: 'run_abandoned',
      context: { reason },
    });
}
