-- K003 fix: Atomic step approval via Postgres function.
-- Wraps the 3 sequential writes in a single transaction:
--   1. Complete current step (output_data, render_schema)
--   2. Activate next step (input_data, working_pool) OR complete run
--   3. Update pipeline_runs.current_step
--
-- Usage: SELECT * FROM approve_step(stage_id, output_data, render_schema);
-- Returns: next_step (integer, null if last step)

CREATE OR REPLACE FUNCTION approve_step(
  p_stage_id UUID,
  p_output_data JSONB,
  p_output_render_schema JSONB
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

  -- 1. Complete current step
  UPDATE pipeline_stages SET
    status = 'completed',
    completed_at = NOW(),
    output_data = p_output_data,
    output_render_schema = p_output_render_schema
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
      input_data = p_output_data,
      input_render_schema = p_output_render_schema,
      working_pool = p_output_data,
      started_at = NOW()
    WHERE run_id = v_run_id AND step_index = v_next_step;

    -- 3. Update run pointer
    UPDATE pipeline_runs SET
      current_step = v_next_step
    WHERE id = v_run_id;

    RETURN QUERY SELECT v_next_step AS next_step, FALSE AS run_completed;
  END IF;
END;
$$ LANGUAGE plpgsql;
