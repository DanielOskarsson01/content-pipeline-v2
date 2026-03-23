/**
 * Cost-based timeout and retry configuration.
 * Single source of truth — imported by both queue.js (BullMQ job opts) and stageWorker.js (Promise.race).
 *
 * Each job processes a single entity. Timeouts reflect per-entity execution time.
 *
 * - timeout:  Max execution time (ms). Worker uses this in Promise.race.
 *             BullMQ stalledInterval (60s) handles detection of truly stuck jobs.
 * - attempts: BullMQ retry count on failure.
 * - priority: BullMQ job priority (lower = higher priority).
 */
export const COST_CONFIG = {
  cheap:     { timeout: 2 * 60 * 1000,  attempts: 3, priority: 1  },
  medium:    { timeout: 5 * 60 * 1000,  attempts: 2, priority: 5  },
  expensive: { timeout: 30 * 60 * 1000, attempts: 1, priority: 10 },
};
