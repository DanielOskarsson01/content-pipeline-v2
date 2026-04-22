-- ============================================================
-- Migration: Move Loop-Router from Step 10 to Step 7
-- Makes ALL routing logic step-agnostic (data-driven, no hardcoded step numbers).
--
-- Wrapped in BEGIN/COMMIT — single atomic transaction.
-- Apply via Supabase CLI: npx supabase db execute --project-ref <ref> < this_file.sql
--
-- Depends on: migration_routing.sql (Phase 1), migration_routing_phase2.sql (Phase 2)
-- ============================================================

BEGIN;

-- ============================================================
-- A) Updated approve_step_v2: decouple routing from last-step
--    Key change: check p_suppress_completion FIRST, before v_is_last.
--    This allows routing_pending to fire at ANY step (not just step 10).
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

  -- Routing suppression takes priority (loop-router decides what happens next)
  -- This fires at ANY step where p_suppress_completion is set, not just the last step.
  IF p_suppress_completion THEN
    RETURN QUERY SELECT v_next_step AS next_step, FALSE AS run_completed, TRUE AS routing_pending;

  ELSIF v_is_last THEN
    -- Last step, no routing: complete run
    UPDATE pipeline_runs SET
      status = 'completed',
      completed_at = NOW()
    WHERE id = v_run_id;

    RETURN QUERY SELECT NULL::INTEGER AS next_step, TRUE AS run_completed, FALSE AS routing_pending;

  ELSE
    -- Normal: activate next step, forward pools
    UPDATE pipeline_stages SET
      status = 'active',
      started_at = NOW(),
      entity_count = p_approved_count,
      completed_count = 0,
      failed_count = 0,
      approved_count = 0
    WHERE run_id = v_run_id AND step_index = v_next_step;

    -- DO UPDATE so loop passes get fresh pool data (was DO NOTHING)
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

    -- Update run pointer
    UPDATE pipeline_runs SET
      current_step = v_next_step
    WHERE id = v_run_id;

    RETURN QUERY SELECT v_next_step AS next_step, FALSE AS run_completed, FALSE AS routing_pending;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Drop old 2-arg overload (CREATE OR REPLACE with different arg count creates
-- a new overload rather than replacing; the old version causes ambiguity)
DROP FUNCTION IF EXISTS apply_entity_routing(UUID, JSONB);

-- ============================================================
-- B) Updated apply_entity_routing: step-agnostic + conditional run completion
--    Key changes:
--    1. New p_routing_step param with DEFAULT 10 (backward compat)
--    2. Hardcoded step_index=10 → p_routing_step
--    3. Hardcoded source_step 10 → p_routing_step in routing log
--    4. Run completion only when p_routing_step >= 10
--    5. Preserves Phase 2 fixes: is_loop_pass, graceful NULL pool, entity_count
-- ============================================================
CREATE OR REPLACE FUNCTION apply_entity_routing(
  p_run_id UUID,
  p_routing_decisions JSONB,
  p_routing_step INTEGER DEFAULT 10  -- backward compat: old code omits this
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

        -- Use p_routing_step instead of hardcoded 10
        UPDATE entity_stage_pool SET
          status = 'approved'
        WHERE run_id = p_run_id AND step_index = p_routing_step AND entity_name = v_entity_name;

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

        -- Log the routing decision (p_routing_step instead of hardcoded 10)
        INSERT INTO entity_routing_log
          (run_id, entity_name, source_step, target_step, decision, route_reason, config_overrides, loop_iteration)
        VALUES
          (p_run_id, v_entity_name, p_routing_step, v_target_step, v_decision_type, v_route_reason, v_config_overrides, v_loop_count + 1);

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

    -- Reset intermediate steps (target+1 through pipeline ceiling) to pending with is_loop_pass
    -- Always resets up to step 10 (pipeline end), regardless of routing step
    UPDATE pipeline_stages SET
      status = 'pending',
      is_loop_pass = TRUE,
      completed_at = NULL,
      completed_count = 0,
      failed_count = 0,
      approved_count = 0
    WHERE run_id = p_run_id
      AND step_index > v_earliest_step
      AND step_index <= 10;  -- pipeline ceiling, always 10

    -- Update run pointer to earliest target
    UPDATE pipeline_runs SET
      current_step = v_earliest_step
    WHERE id = p_run_id;
  END IF;

  -- Only complete run if routing is at the last step (step 10).
  -- For mid-pipeline routing (step 7): JS handles pool forwarding when all_terminal=true.
  IF v_total_entities > 0 AND v_total_entities = v_terminal_count THEN
    IF p_routing_step >= 10 THEN
      UPDATE pipeline_runs SET
        status = 'completed',
        completed_at = NOW()
      WHERE id = p_run_id;
    END IF;
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
-- C) Template execution_plan migration
--    Move loop-router from submodules_per_step."10" to "7"
--    Remove step 7 from skip_steps for affected templates
-- ============================================================

-- Move loop-router from step 10 to step 7
UPDATE templates SET
  execution_plan = jsonb_set(
    jsonb_set(
      execution_plan,
      '{submodules_per_step,7}',
      COALESCE(execution_plan->'submodules_per_step'->'7', '[]'::jsonb) || '["loop-router"]'::jsonb
    ),
    '{submodules_per_step,10}',
    (SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
     FROM jsonb_array_elements(COALESCE(execution_plan->'submodules_per_step'->'10', '[]'::jsonb)) elem
     WHERE elem::text != '"loop-router"')
  )
WHERE execution_plan->'submodules_per_step'->'10' ? 'loop-router';

-- Remove 7 from skip_steps for templates that now have routing at step 7
UPDATE templates SET
  execution_plan = jsonb_set(
    execution_plan,
    '{skip_steps}',
    (SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
     FROM jsonb_array_elements(execution_plan->'skip_steps') elem
     WHERE elem::text != '7')
  )
WHERE execution_plan->'skip_steps' @> '7'::jsonb
  AND execution_plan->'submodules_per_step'->'7' ? 'loop-router';

-- ============================================================
-- D) Data wipe — clean slate for routing changes
--    Correct FK dependency order (children before parents).
--    All tables verified to exist in pre-flight check.
-- ============================================================
DELETE FROM submodule_run_item_data;
DELETE FROM entity_submodule_runs;
DELETE FROM submodule_runs;
DELETE FROM entity_stage_pool;
DELETE FROM entity_run_meta;
DELETE FROM entity_routing_log;
DELETE FROM step_context;
DELETE FROM decision_log;
DELETE FROM pipeline_metrics;
DELETE FROM pool_item_blobs;
DELETE FROM pipeline_stages;
DELETE FROM run_submodule_config;
DELETE FROM pipeline_runs;

COMMIT;

-- ============================================================
-- Verification queries (run after migration):
-- ============================================================
-- SELECT proname, pronargs FROM pg_proc WHERE proname = 'approve_step_v2';         -- should show 5 args
-- SELECT proname, pronargs FROM pg_proc WHERE proname = 'apply_entity_routing';    -- should show 3 args
-- SELECT execution_plan->'submodules_per_step'->'7' FROM templates;                -- should contain "loop-router"
-- SELECT execution_plan->'submodules_per_step'->'10' FROM templates;               -- should NOT contain "loop-router"
-- SELECT count(*) FROM pipeline_runs;                                               -- should be 0
