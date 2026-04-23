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
  expensive: { timeout: 30 * 60 * 1000, attempts: 2, priority: 10 },
};

/**
 * Phase 12c: Auto-execute step-level defaults.
 *
 * Failure threshold = max fraction of entities allowed to fail before halting.
 * Step timeout (seconds) = base minimum; scaled up by entity count.
 */

// Per-step failure thresholds. Unlisted steps default to DEFAULT_THRESHOLD.
export const DEFAULT_FAILURE_THRESHOLDS = {
  1: 0.1,   // Discovery — low tolerance
  2: 0.2,   // Validation
  3: 0.6,   // Scraping — high failure is normal (403s, timeouts)
  4: 0.3,   // Filtering & Assembly
  5: 0.2,   // Analysis & Generation
  8: 0.1,   // Bundling — low tolerance
};
export const DEFAULT_THRESHOLD = 0.3;

// Base step timeout in seconds (minimum, before entity scaling).
export const DEFAULT_STEP_TIMEOUTS = {
  1: 300,    // 5 min
  2: 300,    // 5 min
  3: 2700,   // 45 min
  4: 300,    // 5 min
  5: 3600,   // 60 min
  8: 300,    // 5 min
};
export const DEFAULT_STEP_TIMEOUT = 600; // 10 min fallback

// Seconds per entity — step timeout = max(entities * factor, base timeout).
export const ENTITY_TIMEOUT_FACTOR = {
  1: 120,
  2: 10,
  3: 120,
  4: 120,
  5: 300,
  8: 120,
};
export const DEFAULT_ENTITY_FACTOR = 120;
