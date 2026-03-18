/**
 * Batch Finalization Worker — handles FlowProducer parent job completion.
 *
 * When all entity child jobs for a submodule batch finish, BullMQ auto-processes
 * the parent job on the 'batch-finalization' queue. This worker:
 *   1. Counts completed/failed entity_submodule_runs
 *   2. Updates the submodule_runs batch record with final status + counts
 *   3. Updates the pipeline_stages entity counts
 */

import { Worker } from 'bullmq';
import db from '../services/db.js';
import { redis } from '../services/queue.js';
import { notifyCompletion, notifyFailure } from '../services/webhookNotifier.js';

const batchWorker = new Worker(
  'batch-finalization',
  async (job) => {
    const { batch_id, submodule_run_id, submodule_id, entity_count } = job.data;

    console.log(`[batch] Finalizing batch ${batch_id} for ${submodule_id} (${entity_count} entities)`);

    // 1. Count entity results
    const { data: entityRuns, error: countErr } = await db
      .from('entity_submodule_runs')
      .select('id, status, entity_name')
      .eq('batch_id', batch_id);

    if (countErr) throw countErr;

    const completed = entityRuns.filter(r => r.status === 'completed').length;
    const failed = entityRuns.filter(r => r.status === 'failed').length;
    const total = entityRuns.length;

    // Determine batch status: all success = completed, any fail = completed (partial failures are normal)
    const batchStatus = total === failed ? 'failed' : 'completed';

    // 2. Update submodule_runs batch record
    const { error: updateErr } = await db
      .from('submodule_runs')
      .update({
        status: batchStatus,
        completed_count: completed,
        completed_at: new Date().toISOString(),
        progress: { current: total, total, message: `${completed} succeeded, ${failed} failed` },
      })
      .eq('id', submodule_run_id);

    if (updateErr) {
      console.error(`[batch] Failed to update submodule_runs ${submodule_run_id}: ${updateErr.message}`);
      throw updateErr;
    }

    // 3. Update pipeline_stages entity counts
    // Load the submodule_runs row to get stage_id
    const { data: batchRun } = await db
      .from('submodule_runs')
      .select('stage_id')
      .eq('id', submodule_run_id)
      .single();

    if (batchRun) {
      // Count all entity_stage_pool statuses for this stage's step
      const { data: stage } = await db
        .from('pipeline_stages')
        .select('run_id, step_index')
        .eq('id', batchRun.stage_id)
        .single();

      if (stage) {
        const { data: poolCounts } = await db
          .from('entity_stage_pool')
          .select('status')
          .eq('run_id', stage.run_id)
          .eq('step_index', stage.step_index);

        if (poolCounts) {
          const counts = {
            entity_count: poolCounts.length,
            completed_count: poolCounts.filter(p => p.status === 'completed' || p.status === 'approved').length,
            failed_count: poolCounts.filter(p => p.status === 'failed').length,
            approved_count: poolCounts.filter(p => p.status === 'approved').length,
          };

          await db
            .from('pipeline_stages')
            .update(counts)
            .eq('id', batchRun.stage_id);
        }
      }
    }

    console.log(`[batch] Finalized: ${submodule_id} — ${completed}/${total} succeeded, ${failed} failed`);

    if (batchStatus === 'failed') {
      notifyFailure({ submoduleId: submodule_id, submoduleRunId: submodule_run_id, error: `All ${total} entities failed` });
    } else {
      notifyCompletion({ submoduleId: submodule_id, submoduleRunId: submodule_run_id });
    }
  },
  {
    connection: redis,
    concurrency: 5,
  }
);

batchWorker.on('failed', (job, err) => {
  console.error(`[batch] Job ${job?.id} failed: ${err.message}`);
});

batchWorker.on('ready', () => {
  console.log('[batch] Batch finalization worker ready');
});

export default batchWorker;
