-- ============================================================
-- Multi-Card Pattern Migration — V5 Phase 3 Sub-plan 1
-- ============================================================
-- Target file: content-pipeline-v2/sql/migration_multi_card_pattern.sql
-- Source: PHASE_3B_PER_ENTITY_INSTRUCTIONS_SPEC.md §5 + §6
--         Plan v5 Data model commitments 6 + 7
--         Pre-flight 2026-05-29 to 2026-05-31 (~/.claude/plans/sub-plan-1-preflight.md)
--
-- Apply order:
-- 1. Validate DDL on a Supabase branch with a faithful schema bootstrap.
--    The branch catches DDL-correctness errors (wrong DROP overload, RPC
--    signature mismatch, column constraint conflict) before they reach prod.
-- 2. Apply this migration to production.
-- 3. Apply sql/rebuild_30_april_template.sql to production (placeholder cards
--    in the new UUID-keyed card_definitions format — separate file because
--    schema and template-data concerns are independent).
-- 4. Restart PM2 workers (pipeline-api, stage-worker, batch-worker).
--
-- Safe to re-run: all operations are IF NOT EXISTS / CREATE OR REPLACE.
-- Pre-deploy git tag: pre-sub-plan-1-multi-card-pattern-2026-06-03
--
-- Backup machinery dropped 2026-06-03: prior 30-april template content is
-- disposable placeholders (no real v2 cards yet — sub-plan 4 produces them),
-- so there is nothing of value to back up. Migration correctness still
-- matters (new code queries the new columns), so DDL is validated on a
-- branch before prod apply. See PHASE_3B_SPEC + sub-plan 1 handoff for
-- the full settlement.
-- ============================================================

-- ============================================================
-- Main migration block
-- All schema changes wrapped in BEGIN/COMMIT so any failure rolls back atomically.
-- ============================================================
BEGIN;

-- ============================================================
-- 1. entity_run_meta — add card_instructions JSONB
--    Per spec §6.1
-- ============================================================
ALTER TABLE entity_run_meta
  ADD COLUMN IF NOT EXISTS card_instructions JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN entity_run_meta.card_instructions IS
  'Append-only array of per-entity card routing instructions. Each record: {routing_round, created_at, created_by, qa_failures, targets:[{card_id, card_name, submodule_id, step, card_round, status, consumed_at, skip_reason}]}. See PHASE_3B_SPEC §3.1.';

-- ============================================================
-- 2. submodule_runs — add card_id + loop_iteration
--    Per spec §6.2 + Plan v5 Resolved decision: resume-safety check scoping
-- ============================================================
ALTER TABLE submodule_runs
  ADD COLUMN IF NOT EXISTS card_id UUID NULL,
  ADD COLUMN IF NOT EXISTS loop_iteration INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN submodule_runs.card_id IS
  'Card UUID this batch was triggered for. NULL = default Round 1 horizontal card. References card_id in pipeline_runs.execution_plan_snapshot.card_definitions.';

COMMENT ON COLUMN submodule_runs.loop_iteration IS
  'Routing iteration this batch belongs to. 0 = Round 1; increments per routing pass via entity_run_meta.loop_count. Load-bearing for resume-safety check in autoExecutor.checkExistingSubmoduleRun.';

-- Drop the legacy one-active-run uniqueness; replace with card_id-aware version
DROP INDEX IF EXISTS idx_one_active_run_per_submodule;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_submodule_card
  ON submodule_runs(run_id, submodule_id, COALESCE(card_id::text, ''))
  WHERE status IN ('pending', 'running');

-- ============================================================
-- 3. entity_submodule_runs — add card_id
--    (loop_iteration already exists per migration_routing.sql:53-54)
--    Per spec §6.3
-- ============================================================
ALTER TABLE entity_submodule_runs
  ADD COLUMN IF NOT EXISTS card_id UUID NULL;

COMMENT ON COLUMN entity_submodule_runs.card_id IS
  'Card UUID this entity row was executed for. NULL = default Round 1 horizontal card. Mirrors submodule_runs.card_id for filtering and joining.';

-- Update the per-entity uniqueness to include card_id (allows same submodule to run multiple cards per entity per step in different iterations)
DROP INDEX IF EXISTS idx_entity_submodule_runs_one_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_submodule_runs_one_active_card
  ON entity_submodule_runs(run_id, step_index, entity_name, submodule_id, COALESCE(card_id::text, ''), loop_iteration)
  WHERE status IN ('pending', 'running');

-- ============================================================
-- 4. run_submodule_config — add card_id + new composite UNIQUE
--    Per spec §6.4
-- ============================================================
ALTER TABLE run_submodule_config
  ADD COLUMN IF NOT EXISTS card_id UUID NULL;

-- Drop legacy unique constraint, add card_id-aware one
ALTER TABLE run_submodule_config
  DROP CONSTRAINT IF EXISTS run_submodule_config_run_id_step_index_submodule_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS run_submodule_config_run_step_sm_card_uniq
  ON run_submodule_config(run_id, step_index, submodule_id, COALESCE(card_id::text, ''));

COMMENT ON COLUMN run_submodule_config.card_id IS
  'Card UUID this config applies to. NULL = default Round 1 horizontal card. Allows per-card option overrides without ambiguity.';

-- ============================================================
-- 5. pipeline_runs — add execution_plan_snapshot
--    Per spec §6.5 + Plan v5 Resolved decision: execution_plan_snapshot write site
-- ============================================================
ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS execution_plan_snapshot JSONB NULL;

COMMENT ON COLUMN pipeline_runs.execution_plan_snapshot IS
  'Frozen copy of templates.execution_plan at run creation time. Routing reads this (not live template) so mid-run template edits do not poison decisions. Written in server/routes/projects.js POST / handler (per pre-flight discrepancy #6).';

-- ============================================================
-- 6. RPCs — replace apply_entity_routing with 3 atomic card-instruction RPCs
--    Per spec §5.2 (append), §5.3 (markConsumed), §5.4 (markSkipped)
-- ============================================================

-- 6.1 append_card_instruction (Brutal-critic Improvement #1 / Edge Case 2 fix — applied 2026-06-02)
-- Per spec §5.2 lines 558-568, PLUS target-level idempotency dedup moved INTO the RPC.
--
-- The previous design relied on callers checking with hasPendingInstruction() before
-- calling, which is TOCTOU-broken: caller A reads "no pending", caller B reads "no pending",
-- A appends, B appends → DUPLICATE INSTRUCTION. Atomic UPDATE doesn't help because both
-- reads happened BEFORE either UPDATE.
--
-- New design: WHERE NOT EXISTS sub-query within the UPDATE atomically checks whether
-- ANY target in p_instruction.targets duplicates an existing pending target by
-- (step, card_id, loop_iteration). If any duplicate exists, the UPDATE is blocked
-- (0 rows affected). Returns TRUE if appended, FALSE if dedup blocked the write so
-- caller can log dedup events.
--
-- Critical for sub-plan 2 dual-writer scenario: gate + router can both write for
-- same entity in same routing pass. This dedup enforces "one pending instruction
-- per (step, card_id, loop_iteration, entity)" invariant at the SQL atomic layer,
-- which mark_card_instruction_skipped (FIFO, per spec §5.4) depends on.
CREATE OR REPLACE FUNCTION append_card_instruction(
  p_run_id UUID,
  p_entity_name TEXT,
  p_instruction JSONB
) RETURNS BOOLEAN AS $$
DECLARE
  v_rows_updated INTEGER;
BEGIN
  UPDATE entity_run_meta
  SET card_instructions = COALESCE(card_instructions, '[]'::jsonb) || jsonb_build_array(p_instruction),
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
  'Atomic append to entity_run_meta.card_instructions with target-level dedup. Returns TRUE if appended, FALSE if any target in p_instruction matched an existing pending (step, card_id, loop_iteration) triple (write blocked). Enforces "one pending per (step, card, iteration, entity)" invariant at SQL atomic layer, supporting sub-plan 2 dual-writer (gate + router) safety. Spec §5.2 + Brutal-critic Round 2 improvement #1.';

-- 6.2 mark_card_instruction_consumed
-- Per spec §5.3 lines 576-610 (with SELECT FOR UPDATE row-level lock to prevent concurrent worker races)
CREATE OR REPLACE FUNCTION mark_card_instruction_consumed(
  p_run_id UUID,
  p_entity_name TEXT,
  p_step INTEGER,
  p_card_id TEXT,
  p_consumed_at TEXT
) RETURNS void AS $$
DECLARE
  v_instructions JSONB;
  v_i INTEGER;
  v_j INTEGER;
  v_target JSONB;
BEGIN
  SELECT card_instructions INTO v_instructions
  FROM entity_run_meta
  WHERE run_id = p_run_id AND entity_name = p_entity_name
  FOR UPDATE;

  IF v_instructions IS NULL THEN RETURN; END IF;

  -- Find earliest pending target matching (step, card_id) — FIFO by array position
  FOR v_i IN 0..jsonb_array_length(v_instructions) - 1 LOOP
    FOR v_j IN 0..jsonb_array_length(v_instructions->v_i->'targets') - 1 LOOP
      v_target := v_instructions->v_i->'targets'->v_j;
      IF (v_target->>'step')::int = p_step
         AND v_target->>'card_id' = p_card_id
         AND v_target->>'status' = 'pending' THEN
        v_instructions := jsonb_set(v_instructions,
          ARRAY[v_i::text, 'targets', v_j::text, 'status'], '"consumed"');
        v_instructions := jsonb_set(v_instructions,
          ARRAY[v_i::text, 'targets', v_j::text, 'consumed_at'], to_jsonb(p_consumed_at));
        UPDATE entity_run_meta
          SET card_instructions = v_instructions, updated_at = NOW()
          WHERE run_id = p_run_id AND entity_name = p_entity_name;
        RETURN;
      END IF;
    END LOOP;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION mark_card_instruction_consumed IS
  'Atomic mark earliest pending target as consumed. SELECT FOR UPDATE prevents concurrent worker races. FIFO ordering by array position.';

-- 6.3 mark_card_instruction_skipped (Brutal-critic Improvement #3 / spec §5.4 alignment — applied 2026-06-02)
-- Per spec §5.4: "Same pattern as markConsumed but sets status='skipped' and skip_reason."
-- FIFO by array position; no loop_iteration filter.
--
-- Earlier draft (now removed) added loop_iteration filter as a deviation from spec.
-- Brutal-critic Round 2 + verification (2026-06-02): the loop_iteration filter doesn't
-- enable any real use case. The invariant "one pending instruction per (step, card_id,
-- loop_iteration, entity)" is enforced by append_card_instruction's target-level dedup
-- (fix #1 above). With the invariant in place, FIFO and loop_iteration-filtered behavior
-- are identical. Spec was right; remove the filter; simpler API; same behavior.
--
-- Skip reason vocabulary (5 total per Plan v5 Gemini amendment 1d):
--   qa_passed_on_recheck (spec §3.4 — routingHandler when QA passes for entity with pending instructions)
--   card_deleted (spec §3.3 — auto-skip in cleanupDeletedCardInstructions when card_definitions missing)
--   rounds_exhausted (spec §4.3 — routingHandler when all rounds of all cards consumed)
--   pool_precondition_not_met (NEW — autoExecutor.expandCardGroups when pool fails precondition for card's submodule)
--   max_loops_backstop (NEW — routingHandler when MAX_LOOPS=3 would be exceeded)
CREATE OR REPLACE FUNCTION mark_card_instruction_skipped(
  p_run_id UUID,
  p_entity_name TEXT,
  p_step INTEGER,
  p_card_id TEXT,
  p_skip_reason TEXT,
  p_skipped_at TEXT
) RETURNS void AS $$
DECLARE
  v_instructions JSONB;
  v_i INTEGER;
  v_j INTEGER;
  v_target JSONB;
BEGIN
  SELECT card_instructions INTO v_instructions
  FROM entity_run_meta
  WHERE run_id = p_run_id AND entity_name = p_entity_name
  FOR UPDATE;

  IF v_instructions IS NULL THEN RETURN; END IF;

  -- Find earliest pending target matching (step, card_id) — FIFO by array position (spec §5.4)
  FOR v_i IN 0..jsonb_array_length(v_instructions) - 1 LOOP
    FOR v_j IN 0..jsonb_array_length(v_instructions->v_i->'targets') - 1 LOOP
      v_target := v_instructions->v_i->'targets'->v_j;
      IF (v_target->>'step')::int = p_step
         AND v_target->>'card_id' = p_card_id
         AND v_target->>'status' = 'pending' THEN
        v_instructions := jsonb_set(v_instructions,
          ARRAY[v_i::text, 'targets', v_j::text, 'status'], '"skipped"');
        v_instructions := jsonb_set(v_instructions,
          ARRAY[v_i::text, 'targets', v_j::text, 'skip_reason'], to_jsonb(p_skip_reason));
        v_instructions := jsonb_set(v_instructions,
          ARRAY[v_i::text, 'targets', v_j::text, 'skipped_at'], to_jsonb(p_skipped_at));
        UPDATE entity_run_meta
          SET card_instructions = v_instructions, updated_at = NOW()
          WHERE run_id = p_run_id AND entity_name = p_entity_name;
        RETURN;
      END IF;
    END LOOP;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION mark_card_instruction_skipped IS
  'Atomic mark earliest pending target as skipped with reason. SELECT FOR UPDATE prevents races. FIFO by array position (spec §5.4 — same pattern as markConsumed). Skip reasons: qa_passed_on_recheck | card_deleted | rounds_exhausted | pool_precondition_not_met | max_loops_backstop.';

-- ============================================================
-- 7. Drop apply_entity_routing — replaced by 3 RPCs above
--    (Verified 2026-05-31: only caller is routingHandler.js:343 which sub-plan 1
--    rewrites to use append_card_instruction directly. Safe to drop.)
-- ============================================================
DROP FUNCTION IF EXISTS apply_entity_routing(UUID, JSONB);
DROP FUNCTION IF EXISTS apply_entity_routing(UUID, JSONB, INTEGER);

COMMIT;

-- ============================================================
-- POST-MIGRATION VERIFICATION QUERIES (run after COMMIT, expect all to pass)
-- ============================================================

-- 1. New columns exist
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'entity_run_meta' AND column_name = 'card_instructions';
-- -> expect 1 row

-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'submodule_runs' AND column_name IN ('card_id', 'loop_iteration');
-- -> expect 2 rows

-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'entity_submodule_runs' AND column_name = 'card_id';
-- -> expect 1 row

-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'run_submodule_config' AND column_name = 'card_id';
-- -> expect 1 row

-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'pipeline_runs' AND column_name = 'execution_plan_snapshot';
-- -> expect 1 row

-- 2. New RPCs exist
-- SELECT proname, pg_get_function_arguments(oid) FROM pg_proc
-- WHERE proname IN ('append_card_instruction', 'mark_card_instruction_consumed', 'mark_card_instruction_skipped');
-- -> expect 3 rows

-- 3. apply_entity_routing dropped
-- SELECT count(*) FROM pg_proc WHERE proname = 'apply_entity_routing';
-- -> expect 0

-- 4. Existing data integrity (no rows broken by NULL columns)
-- SELECT count(*) FROM entity_run_meta WHERE card_instructions IS NULL;
-- -> expect 0 (DEFAULT '[]'::jsonb backfills)
-- SELECT count(*) FROM submodule_runs WHERE loop_iteration IS NULL;
-- -> expect 0 (DEFAULT 0 backfills)
