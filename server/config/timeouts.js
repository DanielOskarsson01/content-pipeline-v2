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
  cheap:     { timeout: 5 * 60 * 1000,  attempts: 3, priority: 1  },
  medium:    { timeout: 15 * 60 * 1000, attempts: 2, priority: 5  },
  expensive: { timeout: 60 * 60 * 1000, attempts: 2, priority: 10 },
};

/**
 * Auto-execute failure thresholds.
 *
 * Failure threshold = max fraction of entities allowed to fail before halting.
 * Per-entity timeouts are handled by COST_CONFIG above (job-level).
 */

// Per-step failure thresholds. Unlisted steps default to DEFAULT_THRESHOLD.
export const DEFAULT_FAILURE_THRESHOLDS = {
  1: 0.1,   // Discovery — low tolerance
  2: 0.2,   // Validation
  3: 0.6,   // Scraping — high failure is normal (403s, timeouts)
  4: 0.3,   // Filtering & Assembly
  5: 0.2,   // Analysis & Generation
  6: 0.3,   // QA — some failures expected (that's the point)
  7: 0.1,   // Routing — low tolerance (routing itself shouldn't fail)
  8: 0.1,   // Bundling — low tolerance
};
export const DEFAULT_THRESHOLD = 0.3;
