import { Queue } from 'bullmq';
import IORedis from 'ioredis';

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

// Cost-based job configuration (from spec Part 15)
const COST_CONFIG = {
  cheap:     { timeout: 5 * 60 * 1000,  attempts: 3, priority: 1  },
  medium:    { timeout: 15 * 60 * 1000, attempts: 2, priority: 5  },
  expensive: { timeout: 30 * 60 * 1000, attempts: 1, priority: 10 },
};

/**
 * Enqueue a submodule execution job.
 * @param {object} params
 * @param {string} params.submoduleRunId - UUID of the submodule_runs row
 * @param {string} params.submoduleId    - Manifest id (e.g. "sitemap-parser")
 * @param {number} params.stepIndex      - Step number (0-10)
 * @param {string} params.cost           - "cheap" | "medium" | "expensive"
 */
export async function enqueueSubmoduleJob({ submoduleRunId, submoduleId, stepIndex, cost }) {
  const config = COST_CONFIG[cost] || COST_CONFIG.medium;

  const job = await pipelineQueue.add(
    'execute-submodule',
    { submodule_run_id: submoduleRunId, submodule_id: submoduleId, step_index: stepIndex },
    {
      attempts: config.attempts,
      priority: config.priority,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );

  console.log(`[queue] Enqueued job ${job.id} for ${submoduleId} (cost: ${cost}, timeout: ${config.timeout / 1000}s)`);
  return { jobId: job.id, timeout: config.timeout };
}
