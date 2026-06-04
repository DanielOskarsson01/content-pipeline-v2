-- Section C (2026-06-04): add atomic loop_count bump to append_card_instruction.
--
-- Plan v1 considered a separate UPDATE for loop_count after writeInstructions.
-- CTO review surfaced that if the UPDATE failed after the RPC succeeded, the
-- instruction would be persisted with a stale loop_count, causing the next
-- routing pass to undercount and grant one extra retry past MAX_LOOPS — a
-- silent safety-property breach.
--
-- Fold the bump into the SAME UPDATE statement. Atomicity is guaranteed by
-- Postgres' single-statement UPDATE semantics: if WHERE NOT EXISTS blocks the
-- write (0 rows touched), the CASE expression on loop_count is irrelevant
-- because no UPDATE happens. No SELECT FOR UPDATE required — the existing
-- dedup-via-WHERE-NOT-EXISTS already provides the "no rows touched = no bump"
-- gating.
--
-- New parameter: p_increment_loop_count BOOLEAN DEFAULT FALSE.
-- - Default FALSE preserves backward compatibility for any non-routing caller
--   (e.g. sub-plan 2 gate writer).
-- - routingHandler (the only intended caller passing TRUE) opts in explicitly
--   via writeInstructions({ incrementLoopCount: true }).
--
-- Function body is byte-identical to migration_multi_card_pattern.sql:133-163
-- (the live append_card_instruction body) PLUS one additional SET clause:
--   loop_count = CASE WHEN p_increment_loop_count THEN COALESCE(loop_count, 0) + 1 ELSE loop_count END

CREATE OR REPLACE FUNCTION append_card_instruction(
  p_run_id UUID,
  p_entity_name TEXT,
  p_instruction JSONB,
  p_increment_loop_count BOOLEAN DEFAULT FALSE
) RETURNS BOOLEAN AS $$
DECLARE
  v_rows_updated INTEGER;
BEGIN
  UPDATE entity_run_meta
  SET card_instructions = COALESCE(card_instructions, '[]'::jsonb) || jsonb_build_array(p_instruction),
      loop_count = CASE WHEN p_increment_loop_count THEN COALESCE(loop_count, 0) + 1 ELSE loop_count END,
      updated_at = NOW()
  WHERE run_id = p_run_id
    AND entity_name = p_entity_name
    AND NOT EXISTS (
      -- Cross-join p_instruction's new targets against all existing pending targets
      -- in card_instructions. If ANY duplicate (step, card_id, loop_iteration) exists,
      -- block the entire append.
      SELECT 1
      FROM jsonb_array_elements(p_instruction->'targets') AS new_target,
           jsonb_array_elements(COALESCE(card_instructions, '[]'::jsonb)) AS existing_record,
           jsonb_array_elements(existing_record->'targets') AS existing_target
      WHERE (existing_target->>'step')::int = (new_target->>'step')::int
        AND existing_target->>'card_id' = new_target->>'card_id'
        AND (existing_target->>'loop_iteration')::int = (new_target->>'loop_iteration')::int
        AND existing_target->>'status' = 'pending'
    );

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  RETURN v_rows_updated > 0;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION append_card_instruction IS
  'Atomic append to entity_run_meta.card_instructions with target-level dedup + optional atomic loop_count bump. Returns TRUE if appended, FALSE if any target in p_instruction matched an existing pending (step, card_id, loop_iteration) triple (write blocked + loop_count NOT bumped). Section C (2026-06-04): added p_increment_loop_count for routingHandler atomic write+bump.';
