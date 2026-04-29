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
