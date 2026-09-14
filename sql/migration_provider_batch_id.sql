-- Phase 2B: Anthropic Message Batches for the step-6 hallucination-detector.
-- Additive, idempotent. Applied to prod 2026-09-14 (project fevxvwqjhndetktujeuu) BEFORE
-- the code deploy, per the established migration-first ordering. Null for every
-- synchronous run; set to the Anthropic Message Batch id only when a step runs in
-- execution_mode=batch, so a restarted worker can re-attach to the in-flight batch
-- instead of re-submitting (double cost).

ALTER TABLE submodule_runs ADD COLUMN IF NOT EXISTS provider_batch_id text;

COMMENT ON COLUMN submodule_runs.provider_batch_id IS
  'Anthropic Message Batch id for a step run in execution_mode=batch (Phase 2B). Null for synchronous runs. Used to re-attach/poll on worker restart.';
