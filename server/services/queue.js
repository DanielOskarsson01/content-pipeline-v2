import { Queue, FlowProducer } from 'bullmq';
import IORedis from 'ioredis';
import { COST_CONFIG } from '../config/timeouts.js';

const redisConnection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
};

// Shared Redis connection for queue operations
export const redis = new IORedis(redisConnection);

redis.on('error', (err) => {
  console.error('[queue] Redis connection error:', err.message);
});

// Single queue for all pipeline stage work
export const pipelineQueue = new Queue('pipeline-stages-v2', { connection: redis });

// Batch finalization queue — parent jobs land here when all children complete
export const batchQueue = new Queue('batch-finalization', { connection: redis });

// FlowProducer for creating parent/child job flows
export const flowProducer = new FlowProducer({ connection: redis });

/**
 * Enqueue a per-entity batch via FlowProducer.
 * Creates 1 parent job + N child jobs in a single Redis call.
 *
 * @param {object} params
 * @param {string} params.batchId           - UUID grouping this batch
 * @param {string} params.submoduleRunId    - UUID of the submodule_runs batch record
 * @param {string} params.submoduleId       - Manifest id
 * @param {number} params.stepIndex         - Step number
 * @param {string} params.cost              - "cheap" | "medium" | "expensive"
 * @param {Array}  params.entityRuns        - Array of { entitySubmoduleRunId, entityName }
 * @returns {object} { flowJobId, entityCount }
 */
export async function enqueueEntityBatch({ batchId, submoduleRunId, submoduleId, stepIndex, cost, entityRuns }) {
  const config = COST_CONFIG[cost] || COST_CONFIG.medium;

  const flow = await flowProducer.add({
    name: 'batch-complete',
    queueName: 'batch-finalization',
    data: {
      batch_id: batchId,
      submodule_run_id: submoduleRunId,
      submodule_id: submoduleId,
      entity_count: entityRuns.length,
    },
    opts: {
      removeOnComplete: 100,
      removeOnFail: 50,
    },
    children: entityRuns.map(er => ({
      name: 'entity-execute',
      queueName: 'pipeline-stages-v2',
      data: {
        entity_submodule_run_id: er.entitySubmoduleRunId,
        entity_name: er.entityName,
        submodule_id: submoduleId,
        step_index: stepIndex,
        batch_id: batchId,
      },
      opts: {
        attempts: config.attempts,
        priority: config.priority,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 50,
        removeDependencyOnFailure: true,
      },
    })),
  });

  console.log(`[queue] Enqueued entity batch ${batchId} for ${submoduleId}: ${entityRuns.length} entities (cost: ${cost})`);
  return { flowJobId: flow.job.id, entityCount: entityRuns.length };
}

/**
 * Enqueue an execution_mode:batch submodule (Phase 2B). Same parent `batch-complete`
 * finalizer, but instead of N per-entity children this creates ONE `entity-batch-llm`
 * child that collects every entity's LLM calls into Anthropic Message Batches and writes
 * all the entity rows itself. The parent then finalizes counts exactly as for a normal
 * batch (any entity rows the child didn't write — e.g. if it threw — get zombie-swept to
 * failed by batchWorker, which is the loud outcome). One child, so `attempts: 1`: the job
 * submits a PAID batch, so a BullMQ retry would double-submit; idempotency (re-attach on
 * submodule_runs.provider_batch_id) is the crash guard, not BullMQ retry.
 *
 * entity_submodule_runs rows are created identically by /run before this is called; the
 * child reads them by batch_id.
 *
 * ponytail: this single child runs on the shared `pipeline-stages-v2` worker
 * (concurrency 2) and holds its slot for the whole poll (typically <1h, ceiling 24h), so a
 * stuck batch consumes half the sync worker pool. Acceptable for an opt-in, last-step
 * pilot; a dedicated batch queue/worker is the upgrade if batch mode goes wide.
 */
export async function enqueueLlmBatch({ batchId, submoduleRunId, submoduleId, stepIndex, cost, entityRuns }) {
  const config = COST_CONFIG[cost] || COST_CONFIG.medium;

  const flow = await flowProducer.add({
    name: 'batch-complete',
    queueName: 'batch-finalization',
    data: {
      batch_id: batchId,
      submodule_run_id: submoduleRunId,
      submodule_id: submoduleId,
      entity_count: entityRuns.length,
    },
    opts: {
      removeOnComplete: 100,
      removeOnFail: 50,
    },
    children: [{
      name: 'entity-batch-llm',
      queueName: 'pipeline-stages-v2',
      data: {
        batch_id: batchId,
        submodule_run_id: submoduleRunId,
        submodule_id: submoduleId,
        step_index: stepIndex,
      },
      opts: {
        attempts: 1,
        priority: config.priority,
        removeOnComplete: 100,
        removeOnFail: 50,
        removeDependencyOnFailure: true,
      },
    }],
  });

  console.log(`[queue] Enqueued LLM batch ${batchId} for ${submoduleId}: ${entityRuns.length} entities as ONE async Message-Batch job (cost: ${cost})`);
  return { flowJobId: flow.job.id, entityCount: entityRuns.length };
}
