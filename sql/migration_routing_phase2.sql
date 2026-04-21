-- ============================================================
-- Phase 2 Routing Migration: is_loop_pass + RPC fixes
-- Depends on: migration_routing.sql (Phase 1)
-- ============================================================

-- 1. Add is_loop_pass column to pipeline_stages
--    Set by apply_entity_routing RPC when reactivating stages for loop passes.
--    Explicit signal — not inferred from status heuristics.
ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS is_loop_pass BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Update apply_entity_routing RPC:
--    a) Set is_loop_pass = TRUE on reactivated stages
--    b) Graceful NULL pool handling (flag entity instead of crashing batch)
--    c) Update entity_count on reactivated stages to reflect routed entity count
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
  v_routed_entity_count INTEGER;
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

        -- Graceful NULL handling: flag entity instead of crashing entire batch
        IF v_source_pool IS NULL THEN
          UPDATE entity_run_meta SET
            terminal_state = 'flagged',
            failure_detail = format('Pool restoration failed: no data at step %s', v_target_step - 1),
            updated_at = NOW()
          WHERE run_id = p_run_id AND entity_name = v_entity_name;
          v_flagged_count := v_flagged_count + 1;
          CONTINUE;
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
    -- Count routed entities for entity_count on reactivated stages
    SELECT count(DISTINCT esp.entity_name) INTO v_routed_entity_count
    FROM entity_stage_pool esp
    WHERE esp.run_id = p_run_id
      AND esp.step_index = v_earliest_step
      AND esp.status = 'pending';

    -- Re-activate target step with is_loop_pass flag
    UPDATE pipeline_stages SET
      status = 'active',
      started_at = NOW(),
      completed_at = NULL,
      is_loop_pass = TRUE,
      entity_count = v_routed_entity_count,
      completed_count = 0,
      failed_count = 0,
      approved_count = 0
    WHERE run_id = p_run_id AND step_index = v_earliest_step;

    -- Reset intermediate steps (target+1 through 10) to pending with is_loop_pass
    UPDATE pipeline_stages SET
      status = 'pending',
      is_loop_pass = TRUE,
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
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'pipeline_stages' AND column_name = 'is_loop_pass'; -- should return 1 row
-- SELECT proname, pronargs FROM pg_proc WHERE proname = 'apply_entity_routing'; -- should show 2 args
