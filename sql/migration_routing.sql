-- Migration: Entity-Level Backward Routing (Phase 1)
-- Run this in Supabase SQL editor.
-- Safe to re-run (all operations are IF NOT EXISTS / CREATE OR REPLACE).

-- ============================================================
-- 1. entity_run_meta: Per-entity-per-run state tracking
--    Tracks loop_count, terminal state, QA history, and config overrides.
--    One row per (run_id, entity_name).
-- ============================================================
CREATE TABLE IF NOT EXISTS entity_run_meta (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  entity_name TEXT NOT NULL,
  loop_count INTEGER NOT NULL DEFAULT 0,
  terminal_state TEXT,              -- NULL while active; 'approved', 'flagged', 'failed'
  failure_reason TEXT,              -- 'dead_site', 'insufficient_sources', 'quality_floor', 'max_loops_exceeded'
  failure_detail TEXT,              -- Human-readable explanation
  last_qa_scores JSONB,            -- { keyword: 0.85, meta: 1.0, citation: 0.72, hallucination: 0.95 }
  qa_score_history JSONB DEFAULT '[]'::jsonb,  -- [{ iteration, scores, timestamp }]
  loop_config JSONB,               -- Config overrides for current loop pass
  routing_applied_at TIMESTAMPTZ,  -- Idempotency guard: when routing was last applied
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_run_meta_unique
  ON entity_run_meta(run_id, entity_name);
CREATE INDEX IF NOT EXISTS idx_entity_run_meta_run
  ON entity_run_meta(run_id);

-- ============================================================
-- 2. entity_routing_log: Audit trail for routing decisions
-- ============================================================
CREATE TABLE IF NOT EXISTS entity_routing_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  entity_name TEXT NOT NULL,
  source_step INTEGER NOT NULL,
  target_step INTEGER NOT NULL,
  decision TEXT NOT NULL,
  route_reason TEXT,
  config_overrides JSONB,
  loop_iteration INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_routing_log_run ON entity_routing_log(run_id);

-- ============================================================
-- 3. loop_iteration column on entity_submodule_runs
--    Supersede pattern: old rows keep original value (0),
--    new rows on loop pass N get loop_iteration = N.
-- ============================================================
ALTER TABLE entity_submodule_runs
  ADD COLUMN IF NOT EXISTS loop_iteration INTEGER NOT NULL DEFAULT 0;

-- ============================================================
-- 4. approve_step_v2: DO NOTHING → DO UPDATE + p_suppress_completion
--    Changes:
--    a) ON CONFLICT DO UPDATE (so looped entities get fresh pool data)
--    b) New p_suppress_completion param (Step 10 routing keeps run active)
--    Return type adds routing_pending column.
-- ============================================================
CREATE OR REPLACE FUNCTION approve_step_v2(
  p_stage_id UUID,
  p_output_render_schema JSONB,
  p_entity_count INTEGER,
  p_approved_count INTEGER,
  p_suppress_completion BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(next_step INTEGER, run_completed BOOLEAN, routing_pending BOOLEAN) AS $$
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

  -- 1. Complete current step
  UPDATE pipeline_stages SET
    status = 'completed',
    completed_at = NOW(),
    output_render_schema = p_output_render_schema,
    entity_count = p_entity_count,
    approved_count = p_approved_count
  WHERE id = p_stage_id;

  IF v_is_last THEN
    IF p_suppress_completion THEN
      -- Routing pipeline: don't complete run, let routing handler decide
      RETURN QUERY SELECT NULL::INTEGER AS next_step, FALSE AS run_completed, TRUE AS routing_pending;
    ELSE
      -- Non-routing pipeline: complete normally (existing behavior)
      UPDATE pipeline_runs SET
        status = 'completed',
        completed_at = NOW()
      WHERE id = v_run_id;

      RETURN QUERY SELECT NULL::INTEGER AS next_step, TRUE AS run_completed, FALSE AS routing_pending;
    END IF;
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
    --    DO UPDATE so loop passes get fresh pool data instead of being silently dropped
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
    ON CONFLICT (run_id, step_index, entity_name) DO UPDATE SET
      pool_items = EXCLUDED.pool_items,
      status = EXCLUDED.status,
      updated_at = NOW();

    -- 4. Update run pointer
    UPDATE pipeline_runs SET
      current_step = v_next_step
    WHERE id = v_run_id;

    RETURN QUERY SELECT v_next_step AS next_step, FALSE AS run_completed, FALSE AS routing_pending;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 5. apply_entity_routing: Atomic routing transaction
--    All entity routing writes in a single transaction.
--    Called by the Step 10 approval handler.
--
--    Input: p_routing_decisions JSONB array:
--    [{ "entity_name": "X", "decision": "loop_discovery", "target_step": 1,
--       "config_overrides": {...}, "route_reason": "...", "failure_reason": null,
--       "qa_scores": {...} }]
--
--    Returns JSONB: { routed_count, approved_count, flagged_count, failed_count,
--                     earliest_step, all_terminal }
-- ============================================================
CREATE OR REPLACE FUNCTION apply_entity_routing(
  p_run_id UUID,
  p_routing_decisions JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_decision JSONB;
  v_entity_name TEXT;
  v_decision_type TEXT;
  v_target_step INTEGER;
  v_config_overrides JSONB;
  v_route_reason TEXT;
  v_failure_reason TEXT;
  v_qa_scores JSONB;
  v_loop_count INTEGER;
  v_source_pool JSONB;
  v_routed_count INTEGER := 0;
  v_approved_count INTEGER := 0;
  v_flagged_count INTEGER := 0;
  v_failed_count INTEGER := 0;
  v_earliest_step INTEGER := 999;
  v_total_entities INTEGER;
  v_terminal_count INTEGER;
BEGIN
  -- Process each entity's routing decision
  FOR v_decision IN SELECT * FROM jsonb_array_elements(p_routing_decisions)
  LOOP
    v_entity_name := v_decision->>'entity_name';
    v_decision_type := v_decision->>'decision';
    v_target_step := (v_decision->>'target_step')::INTEGER;
    v_config_overrides := v_decision->'config_overrides';
    v_route_reason := v_decision->>'route_reason';
    v_failure_reason := v_decision->>'failure_reason';
    v_qa_scores := v_decision->'qa_scores';

    -- Get current loop_count
    SELECT loop_count INTO v_loop_count
    FROM entity_run_meta
    WHERE run_id = p_run_id AND entity_name = v_entity_name;

    -- Auto-create entity_run_meta if missing (safety net)
    IF NOT FOUND THEN
      INSERT INTO entity_run_meta (run_id, entity_name)
      VALUES (p_run_id, v_entity_name)
      ON CONFLICT (run_id, entity_name) DO NOTHING;
      v_loop_count := 0;
    END IF;

    -- Record QA scores in history
    IF v_qa_scores IS NOT NULL THEN
      UPDATE entity_run_meta SET
        last_qa_scores = v_qa_scores,
        qa_score_history = qa_score_history || jsonb_build_object(
          'iteration', v_loop_count,
          'scores', v_qa_scores,
          'timestamp', NOW()
        ),
        updated_at = NOW()
      WHERE run_id = p_run_id AND entity_name = v_entity_name;
    END IF;

    CASE v_decision_type
      WHEN 'approve' THEN
        -- Terminal: approved
        UPDATE entity_run_meta SET
          terminal_state = 'approved',
          updated_at = NOW()
        WHERE run_id = p_run_id AND entity_name = v_entity_name;

        UPDATE entity_stage_pool SET
          status = 'approved'
        WHERE run_id = p_run_id AND step_index = 10 AND entity_name = v_entity_name;

        v_approved_count := v_approved_count + 1;

      WHEN 'flag_manual' THEN
        -- Terminal: flagged
        UPDATE entity_run_meta SET
          terminal_state = 'flagged',
          failure_detail = v_route_reason,
          updated_at = NOW()
        WHERE run_id = p_run_id AND entity_name = v_entity_name;

        v_flagged_count := v_flagged_count + 1;

      WHEN 'failed' THEN
        -- Terminal: failed with reason
        UPDATE entity_run_meta SET
          terminal_state = 'failed',
          failure_reason = v_failure_reason,
          failure_detail = v_route_reason,
          updated_at = NOW()
        WHERE run_id = p_run_id AND entity_name = v_entity_name;

        v_failed_count := v_failed_count + 1;

      ELSE
        -- Backward routing: loop_discovery, loop_tone, loop_generation
        IF v_target_step IS NULL THEN
          RAISE EXCEPTION 'Routing decision % requires target_step for entity %',
            v_decision_type, v_entity_name;
        END IF;

        -- Read pool data from the step BEFORE target (restored state)
        SELECT pool_items INTO v_source_pool
        FROM entity_stage_pool
        WHERE run_id = p_run_id
          AND step_index = v_target_step - 1
          AND entity_name = v_entity_name;

        IF v_source_pool IS NULL THEN
          RAISE EXCEPTION 'Pool restoration failed: no data at step % for entity %',
            v_target_step - 1, v_entity_name;
        END IF;

        -- UPSERT entity at target step with restored pool, status=pending
        INSERT INTO entity_stage_pool (run_id, step_index, entity_name, pool_items, status)
        VALUES (p_run_id, v_target_step, v_entity_name, v_source_pool, 'pending')
        ON CONFLICT (run_id, step_index, entity_name) DO UPDATE SET
          pool_items = EXCLUDED.pool_items,
          status = 'pending',
          updated_at = NOW();

        -- Update entity_run_meta: increment loop, store config, mark routing applied
        UPDATE entity_run_meta SET
          loop_count = loop_count + 1,
          loop_config = v_config_overrides,
          routing_applied_at = NOW(),
          updated_at = NOW()
        WHERE run_id = p_run_id AND entity_name = v_entity_name;

        -- Log the routing decision
        INSERT INTO entity_routing_log
          (run_id, entity_name, source_step, target_step, decision, route_reason, config_overrides, loop_iteration)
        VALUES
          (p_run_id, v_entity_name, 10, v_target_step, v_decision_type, v_route_reason, v_config_overrides, v_loop_count + 1);

        -- Track earliest target for run pointer
        IF v_target_step < v_earliest_step THEN
          v_earliest_step := v_target_step;
        END IF;

        v_routed_count := v_routed_count + 1;
    END CASE;
  END LOOP;

  -- Check if all entities are terminal
  SELECT count(*) INTO v_total_entities
  FROM entity_run_meta WHERE run_id = p_run_id;

  SELECT count(*) INTO v_terminal_count
  FROM entity_run_meta WHERE run_id = p_run_id AND terminal_state IS NOT NULL;

  -- If entities were routed, update stages and run pointer
  IF v_routed_count > 0 THEN
    -- Re-activate target step
    UPDATE pipeline_stages SET
      status = 'active',
      started_at = NOW(),
      completed_at = NULL,
      completed_count = 0,
      failed_count = 0,
      approved_count = 0
    WHERE run_id = p_run_id AND step_index = v_earliest_step;

    -- Reset intermediate steps (target+1 through 10) to pending
    UPDATE pipeline_stages SET
      status = 'pending',
      completed_at = NULL,
      completed_count = 0,
      failed_count = 0,
      approved_count = 0
    WHERE run_id = p_run_id
      AND step_index > v_earliest_step
      AND step_index <= 10;

    -- Update run pointer to earliest target
    UPDATE pipeline_runs SET
      current_step = v_earliest_step
    WHERE id = p_run_id;
  END IF;

  -- If all entities are terminal, complete the run
  IF v_total_entities > 0 AND v_total_entities = v_terminal_count THEN
    UPDATE pipeline_runs SET
      status = 'completed',
      completed_at = NOW()
    WHERE id = p_run_id;
  END IF;

  RETURN jsonb_build_object(
    'routed_count', v_routed_count,
    'approved_count', v_approved_count,
    'flagged_count', v_flagged_count,
    'failed_count', v_failed_count,
    'earliest_step', CASE WHEN v_earliest_step = 999 THEN NULL ELSE v_earliest_step END,
    'all_terminal', v_total_entities > 0 AND v_total_entities = v_terminal_count,
    'total_entities', v_total_entities,
    'terminal_entities', v_terminal_count
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Verification queries (run after migration):
-- ============================================================
-- SELECT count(*) FROM information_schema.tables WHERE table_name = 'entity_run_meta';          -- should be 1
-- SELECT count(*) FROM information_schema.tables WHERE table_name = 'entity_routing_log';       -- should be 1
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'entity_submodule_runs' AND column_name = 'loop_iteration'; -- should return 1 row
-- SELECT proname, pronargs FROM pg_proc WHERE proname = 'approve_step_v2';                      -- should show 5 args
-- SELECT proname, pronargs FROM pg_proc WHERE proname = 'apply_entity_routing';                 -- should show 2 args
