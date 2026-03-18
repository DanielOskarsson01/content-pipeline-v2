-- Per-Entity Architecture — Migration
-- Phase 1: New tables + altered columns (additive, no destructive changes)
-- Run against Supabase SQL editor. Safe to re-run (IF NOT EXISTS / IF NOT EXISTS).

-- ============================================================
-- 1. New table: entity_stage_pool
--    Replaces pipeline_stages.working_pool. One row per entity per step.
--    Bounded: ~50KB per row instead of one massive JSONB blob.
-- ============================================================
CREATE TABLE IF NOT EXISTS entity_stage_pool (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  step_index INTEGER NOT NULL,
  entity_name TEXT NOT NULL,
  pool_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary lookup: all entity pools for a step
CREATE INDEX IF NOT EXISTS idx_entity_stage_pool_run_step
  ON entity_stage_pool(run_id, step_index);

-- Prevent duplicate entity entries per step
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_stage_pool_unique
  ON entity_stage_pool(run_id, step_index, entity_name);

-- ============================================================
-- 2. New table: entity_submodule_runs
--    One row per entity per submodule execution.
--    Replaces the "one submodule_runs row covers all entities" model.
-- ============================================================
CREATE TABLE IF NOT EXISTS entity_submodule_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id UUID NOT NULL REFERENCES pipeline_stages(id),
  run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  batch_id UUID,
  entity_name TEXT NOT NULL,
  submodule_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  options JSONB,
  input_data JSONB,
  output_data JSONB,
  output_render_schema JSONB,
  approved_items JSONB,
  progress JSONB,
  error TEXT,
  logs JSONB,
  retry_of UUID REFERENCES entity_submodule_runs(id),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Batch lookup: all entity runs for a batch
CREATE INDEX IF NOT EXISTS idx_entity_submodule_runs_batch
  ON entity_submodule_runs(batch_id);

-- Step-level lookup: all entity runs for a stage
CREATE INDEX IF NOT EXISTS idx_entity_submodule_runs_stage
  ON entity_submodule_runs(stage_id);

-- Run-level lookup
CREATE INDEX IF NOT EXISTS idx_entity_submodule_runs_run
  ON entity_submodule_runs(run_id);

-- Prevent duplicate active runs per entity per submodule
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_submodule_runs_one_active
  ON entity_submodule_runs(run_id, step_index, entity_name, submodule_id)
  WHERE status IN ('pending', 'running');

-- ============================================================
-- 3. Alter pipeline_stages: add entity count tracking columns
--    Existing columns kept intact for backward compatibility.
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_stages' AND column_name = 'entity_count'
  ) THEN
    ALTER TABLE pipeline_stages ADD COLUMN entity_count INTEGER;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_stages' AND column_name = 'completed_count'
  ) THEN
    ALTER TABLE pipeline_stages ADD COLUMN completed_count INTEGER DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_stages' AND column_name = 'failed_count'
  ) THEN
    ALTER TABLE pipeline_stages ADD COLUMN failed_count INTEGER DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_stages' AND column_name = 'approved_count'
  ) THEN
    ALTER TABLE pipeline_stages ADD COLUMN approved_count INTEGER DEFAULT 0;
  END IF;
END $$;

-- ============================================================
-- 4. Alter submodule_runs: add batch tracking columns
--    Existing rows unaffected (columns nullable).
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'submodule_runs' AND column_name = 'batch_id'
  ) THEN
    ALTER TABLE submodule_runs ADD COLUMN batch_id UUID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'submodule_runs' AND column_name = 'entity_count'
  ) THEN
    ALTER TABLE submodule_runs ADD COLUMN entity_count INTEGER;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'submodule_runs' AND column_name = 'completed_count'
  ) THEN
    ALTER TABLE submodule_runs ADD COLUMN completed_count INTEGER DEFAULT 0;
  END IF;
END $$;

-- ============================================================
-- 5. RPC: approve_step_v2
--    Per-entity version. Pools are already in entity_stage_pool —
--    this function just advances step status and forwards pools.
-- ============================================================
CREATE OR REPLACE FUNCTION approve_step_v2(
  p_stage_id UUID,
  p_output_render_schema JSONB,
  p_entity_count INTEGER,
  p_approved_count INTEGER
)
RETURNS TABLE(next_step INTEGER, run_completed BOOLEAN) AS $$
DECLARE
  v_run_id UUID;
  v_step_index INTEGER;
  v_is_last BOOLEAN;
  v_next_step INTEGER;
BEGIN
  -- Lock and read the stage row
  SELECT run_id, step_index INTO v_run_id, v_step_index
  FROM pipeline_stages
  WHERE id = p_stage_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stage not found: %', p_stage_id;
  END IF;

  v_is_last := v_step_index >= 10;
  v_next_step := CASE WHEN v_is_last THEN NULL ELSE v_step_index + 1 END;

  -- 1. Complete current step (no output_data — pools are in entity_stage_pool)
  UPDATE pipeline_stages SET
    status = 'completed',
    completed_at = NOW(),
    output_render_schema = p_output_render_schema,
    entity_count = p_entity_count,
    approved_count = p_approved_count
  WHERE id = p_stage_id;

  IF v_is_last THEN
    -- Complete the run
    UPDATE pipeline_runs SET
      status = 'completed',
      completed_at = NOW()
    WHERE id = v_run_id;

    RETURN QUERY SELECT NULL::INTEGER AS next_step, TRUE AS run_completed;
  ELSE
    -- 2. Activate next step
    UPDATE pipeline_stages SET
      status = 'active',
      started_at = NOW(),
      entity_count = p_approved_count,
      completed_count = 0,
      failed_count = 0,
      approved_count = 0
    WHERE run_id = v_run_id AND step_index = v_next_step;

    -- 3. Forward entity pools: copy approved entity rows to next step
    --    Uses UPSERT for idempotency (safe retry)
    INSERT INTO entity_stage_pool (run_id, step_index, entity_name, pool_items, status)
    SELECT
      v_run_id,
      v_next_step,
      esp.entity_name,
      esp.pool_items,
      'pending'
    FROM entity_stage_pool esp
    WHERE esp.run_id = v_run_id
      AND esp.step_index = v_step_index
      AND esp.status = 'approved'
    ON CONFLICT (run_id, step_index, entity_name) DO NOTHING;

    -- 4. Update run pointer
    UPDATE pipeline_runs SET
      current_step = v_next_step
    WHERE id = v_run_id;

    RETURN QUERY SELECT v_next_step AS next_step, FALSE AS run_completed;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 6. Update schema.sql reference (keep in sync)
--    The schema.sql file shows the full schema for fresh installs.
--    This migration file is for existing databases.
-- ============================================================
-- Done. Run this file once in Supabase SQL editor.
-- Verify: SELECT count(*) FROM entity_stage_pool; -- should return 0
-- Verify: SELECT count(*) FROM entity_submodule_runs; -- should return 0
-- Verify: SELECT column_name FROM information_schema.columns WHERE table_name = 'pipeline_stages' AND column_name = 'entity_count'; -- should return 1 row
