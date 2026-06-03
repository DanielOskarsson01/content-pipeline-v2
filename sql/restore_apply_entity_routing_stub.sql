-- ============================================================
-- Restore apply_entity_routing as a loud-fail tripwire stub
-- ============================================================
-- Target file: content-pipeline-v2/sql/restore_apply_entity_routing_stub.sql
-- Applies after sql/migration_multi_card_pattern.sql (which DROPped the original).
--
-- Why this exists:
--   migration_multi_card_pattern.sql §7 drops apply_entity_routing.
--   The deployed routingHandler.js:343 still calls it via db.rpc(). Without
--   this stub, any prod run reaching Step 7 (loop-router) with routing
--   decisions would fail with cryptic "function apply_entity_routing does
--   not exist". The stub provides a clear actionable error message instead.
--
-- Why a stub instead of restoring the original:
--   The original body IS the cascade-delete bug (BACKLOG #7) — the exact
--   thing this effort exists to retire. Restoring its body means routing
--   succeeds quietly while cross-entity state gets cascade-deleted. That's
--   silent-and-destructive failure, worst possible mode. The stub raises
--   loud-and-safe: nothing happens, state intact, operator sees a clear
--   message pointing to the right fix.
--
-- Why a stub instead of leaving dropped:
--   "function does not exist" is cryptic. The stub message is self-
--   documenting: it tells the operator exactly what needs to happen
--   (routingHandler rewrite to use append_card_instruction). Acts as a
--   tripwire — if it fires in logs, you immediately know someone advanced
--   a run to Step 7 before Section C landed.
--
-- Signature contract:
--   Must EXACTLY match the deployed routingHandler.js:343 call:
--     db.rpc('apply_entity_routing', {
--       p_run_id: runId,                    -- UUID
--       p_routing_decisions: decisions,     -- JSONB
--       p_routing_step: routingStep,        -- INTEGER
--     })
--   PostgREST binds by parameter name; signature mismatch would defeat
--   the whole point (cryptic error instead of clear one).
--
-- Operational constraint (until Section C / routingHandler rewrite lands):
--   - DO NOT resume paused runs that would advance toward Step 7
--     (5075e460-f588-... and 0f5edae6-c291-... at step 5)
--   - DO NOT start new runs that will reach Step 7
--   - The stub enforces this loudly, but please respect it operationally
--     too — letting a run hit Step 7 just to see the stub fire is wasted
--     work plus a halted run to clean up
-- ============================================================

CREATE OR REPLACE FUNCTION apply_entity_routing(
  p_run_id UUID,
  p_routing_decisions JSONB,
  p_routing_step INTEGER DEFAULT 10
) RETURNS JSONB AS $$
BEGIN
  RAISE EXCEPTION 'apply_entity_routing has been retired by sub-plan 1 Multi-Card Pattern migration (2026-06-03). routingHandler.js must be rewritten to use append_card_instruction + mark_card_instruction_consumed + mark_card_instruction_skipped (see PHASE_3B_SPEC §5). Until Section C deploys the rewritten routingHandler, no run can advance past Step 7. Called with: p_run_id=%, p_routing_step=%', p_run_id, p_routing_step;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION apply_entity_routing IS
  'Tripwire stub installed 2026-06-03 after migration_multi_card_pattern.sql dropped the original. Raises clear error if called by deployed routingHandler.js:343. Replace by rewriting routingHandler to use append_card_instruction (Section C / sub-plan 1 follow-up). Original body was the cascade-delete bug (BACKLOG #7) so cannot be restored as-is.';

-- ============================================================
-- POST-APPLY VERIFICATION (run after to confirm stub is callable)
-- ============================================================
-- SELECT apply_entity_routing(
--   '00000000-0000-0000-0000-000000000001'::uuid,
--   '[]'::jsonb,
--   10
-- );
-- -> expect: ERROR — apply_entity_routing has been retired by sub-plan 1...
