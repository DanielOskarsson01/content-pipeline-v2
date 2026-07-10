-- =====================================================================
-- v6 card-model migration — rounds-map -> scalar `round` + flat `overrides`
-- Unit 2.7 (PREPARE + DRY-RUN). The PROD flip is a step inside unit 3.1,
-- applied atomically WITH the v6 runtime + validator (never before them).
-- Amendment: noble-wandering-graham.md V6-§1.1, V6-§8. Decision: DECISION_CARD_MODEL_V6.md.
--
-- WHAT THIS DOES (a JSONB DATA rewrite of templates.execution_plan):
--   For the ONLY card-bearing template (30-april / 3442873e), card
--   a8f4d2c1-...-0001 ("writer-v2-placeholder", content-writer, step 5):
--     (a) drop the OLD `rounds` map; promote round 2 to a SCALAR `round` + FLAT
--         `overrides` (round-1 was an empty dummy that only satisfied old rule 5
--          and never ran — the routing-only hack V6-§2 removes).
--     (b) DE-PLACE the card UUID from submodules_per_step['5']. Under the new
--         validator a round>1 card is routing-only (option (e)); a PLACED group
--         must include round 1 and be contiguous, so leaving it placed would 400.
--         'content-writer' still runs at round 1 as its plain-string entry.
--   routing_rules already reference the card by id (unchanged); escalation_rules
--   and every other step are left byte-identical (surgical, not a full rebuild).
--
-- SCOPE (unit 2.7 enumeration, verified against prod 2026-07-10): mutates EXACTLY
--   ONE row. Of 28 templates, only 3442873e carries a card_definitions card in the
--   old `rounds`-map shape; 0 carry the legacy `cards` key; the other 27 are
--   card-less legacy plans this migration does not touch (id-scoped + guarded).
--
-- SAFETY: single atomic UPDATE. GUARDED on the old shape (rounds IS NOT NULL), so
--   it is idempotent — a second run touches 0 rows. FAIL-CLOSED: if the fixture
--   drifted from the captured shape, the guard yields 0 rows rather than corrupt.
--
-- ROLLBACK: a code revert-anchor CANNOT undo a data rewrite. The ONLY working
--   rollback is the per-row pre-migration snapshot — see
--   supabase/artifacts/unit-2.7/rollback.sql (CTO2-1).
-- =====================================================================

UPDATE templates AS t
SET execution_plan = jsonb_set(
    -- (a) reshape the card: drop `rounds`; add scalar `round` = 2 + flat `overrides`
    jsonb_set(
      t.execution_plan,
      '{card_definitions,a8f4d2c1-7e57-4001-8001-deadbeef0001}',
      ((t.execution_plan #> '{card_definitions,a8f4d2c1-7e57-4001-8001-deadbeef0001}') - 'rounds')
        || jsonb_build_object(
             'round', 2,
             'overrides', COALESCE(
               t.execution_plan #> '{card_definitions,a8f4d2c1-7e57-4001-8001-deadbeef0001,rounds,2}',
               '{}'::jsonb
             )
           )
    ),
    -- (b) de-place the card UUID from submodules_per_step['5'] (routing-only, option (e)),
    --     preserving the order of the remaining plain-string entries
    '{submodules_per_step,5}',
    COALESCE(
      (SELECT jsonb_agg(elem ORDER BY ord)
         FROM jsonb_array_elements_text(t.execution_plan #> '{submodules_per_step,5}')
              WITH ORDINALITY AS arr(elem, ord)
        WHERE elem <> 'a8f4d2c1-7e57-4001-8001-deadbeef0001'),
      '[]'::jsonb
    )
  )
WHERE t.id = '3442873e-921d-4c97-9f0f-39395c676b35'
  -- guard: only the OLD rounds-map shape; idempotent + fail-closed on drift
  AND (t.execution_plan #> '{card_definitions,a8f4d2c1-7e57-4001-8001-deadbeef0001,rounds}') IS NOT NULL;
