-- ============================================================
-- 30-april Template Clean Rebuild — V5 Phase 3 Sub-plan 1
-- ============================================================
-- Target file: content-pipeline-v2/sql/rebuild_30_april_template.sql
-- Source: PHASE_3B_PER_ENTITY_INSTRUCTIONS_SPEC.md §1.2-§1.4 (new UUID-keyed card_definitions format)
-- Applies to template id 3442873e-921d-4c97-9f0f-39395c676b35 ("30 april")
--
-- Apply order:
-- 1. Apply sql/migration_multi_card_pattern.sql FIRST (schema changes).
-- 2. Apply this file to write the new-format execution_plan.
-- 3. Restart PM2 workers so the new code reads the new format.
--
-- Why this is a clean rebuild, not a conversion:
--   Settlement 2026-06-03 — the 30-april template's existing 4 cards (pse-v2,
--   writer-v2, seo-writer-v2, scraper-deluxe-v2) are placeholder content
--   (v2 cards not yet produced; PSE card doesn't exist; others are
--   same-settings-with-different-config). Nothing of value to preserve.
--   Sub-plan 4 produces real v2 card content; this rebuild puts a single
--   placeholder card in the new format to exercise sub-plan 1's ship-gate
--   (loop mechanism: routed entity → card → retry with distinct
--   card_id/loop_iteration).
--
-- Ship-gate test scope (sub-plan 1):
--   - Wazdan-shape entity fails citation:fail + hallucination:fail
--   - Both rules route to the same writer-v2-placeholder card (Step 5)
--   - Card-instruction dedup (Brutal-critic Fix #1) is exercised
--     for free by the two-rules-→-same-card-id pattern
--   - Round 2 runs content-writer with the _placeholder_marker visible,
--     proving the routed-retry path executed
-- ============================================================

-- Placeholder card UUID (stable, recognizable, valid v4):
--   a8f4d2c1-7e57-4001-8001-deadbeef0001
-- Replaced with a real escalation card in sub-plan 4.

BEGIN;

UPDATE templates
SET execution_plan = jsonb_build_object(
  'submodules_per_step', jsonb_build_object(
    '1', jsonb_build_array(
      'sitemap-parser',
      'page-links',
      'browser-crawler',
      'deep-links',
      'rss-feeds'
    ),
    '2', jsonb_build_array(
      'url-dedup',
      'url-canonicalizer',
      'url-filter',
      'url-relevance'
    ),
    '3', jsonb_build_array(
      'page-scraper',
      'browser-scraper',
      'api-scraper'
    ),
    '4', jsonb_build_array(
      'boilerplate-stripper',
      'intent-tagger',
      'content-filter'
    ),
    '5', jsonb_build_array(
      'content-analyzer',
      'seo-planner',
      'content-writer',
      'tone-seo-editor'
    ),
    '6', jsonb_build_array(
      'keyword-sufficiency-checker',
      'meta-compliance-checker',
      'qa-structural',
      'citation-coverage-checker',
      'hallucination-detector'
    ),
    '7', jsonb_build_array(
      'loop-router'
    ),
    '8', jsonb_build_array(
      'meta-output',
      'html-output',
      'markdown-output',
      'schema-org-injector',
      'company-media',
      'json-output'
    )
  ),
  'card_definitions', jsonb_build_object(
    'a8f4d2c1-7e57-4001-8001-deadbeef0001', jsonb_build_object(
      'card_name', 'writer-v2-placeholder',
      'submodule_id', 'content-writer',
      'step', 5,
      'description', 'Placeholder retry card for sub-plan 1 ship-gate mechanism test. Round 2 marker proves the routed-retry path executed. Real escalation config produced in sub-plan 4.',
      'rounds', jsonb_build_object(
        '1', jsonb_build_object(),
        '2', jsonb_build_object('_placeholder_marker', 'sub-plan-1-ship-gate')
      )
    )
  ),
  'routing_rules', jsonb_build_object(
    'citation:fail', jsonb_build_array(
      jsonb_build_object('step', 5, 'card_id', 'a8f4d2c1-7e57-4001-8001-deadbeef0001')
    ),
    'hallucination:fail', jsonb_build_array(
      jsonb_build_object('step', 5, 'card_id', 'a8f4d2c1-7e57-4001-8001-deadbeef0001')
    )
  ),
  'escalation_rules', jsonb_build_object(
    '2', jsonb_build_object(
      '_comment', 'Step 2 (Validation): entities with <3 discovered URLs are terminal failures, <10 triggers threshold warning',
      'fail_threshold', 3,
      'volume_threshold', 10,
      'escalation_submodules', jsonb_build_array()
    ),
    '4', jsonb_build_object(
      '_comment', 'Step 4 (Filtering): entities with <500 total scraped words are terminal failures, <2000 triggers threshold warning',
      'escalation_submodules', jsonb_build_array(),
      'quality_fail_threshold', 500,
      'quality_threshold_words', 2000
    )
  )
)
WHERE id = '3442873e-921d-4c97-9f0f-39395c676b35'
  AND name = '30 april';

COMMIT;

-- ============================================================
-- POST-REBUILD VERIFICATION QUERIES
-- ============================================================

-- 1. Template updated, has card_definitions
-- SELECT
--   id, name,
--   execution_plan ? 'card_definitions' AS has_card_definitions,
--   jsonb_typeof(execution_plan->'card_definitions') AS card_definitions_type,
--   jsonb_object_keys(execution_plan->'card_definitions') AS card_ids
-- FROM templates WHERE id = '3442873e-921d-4c97-9f0f-39395c676b35';
-- -> expect: has_card_definitions=true, card_definitions_type=object,
--    card_ids=a8f4d2c1-7e57-4001-8001-deadbeef0001

-- 2. The placeholder card resolves to content-writer at Step 5
-- SELECT
--   execution_plan->'card_definitions'->'a8f4d2c1-7e57-4001-8001-deadbeef0001'->>'submodule_id' AS submodule,
--   execution_plan->'card_definitions'->'a8f4d2c1-7e57-4001-8001-deadbeef0001'->'step' AS step,
--   execution_plan->'card_definitions'->'a8f4d2c1-7e57-4001-8001-deadbeef0001'->'rounds'->'2' AS round_2_overrides
-- FROM templates WHERE id = '3442873e-921d-4c97-9f0f-39395c676b35';
-- -> expect: submodule='content-writer', step=5, round_2_overrides={"_placeholder_marker":"sub-plan-1-ship-gate"}

-- 3. routing_rules is new-format array-of-objects (not legacy target_cards strings)
-- SELECT
--   jsonb_typeof(execution_plan->'routing_rules'->'citation:fail') AS citation_type,
--   execution_plan->'routing_rules'->'citation:fail'->0 AS citation_first_target
-- FROM templates WHERE id = '3442873e-921d-4c97-9f0f-39395c676b35';
-- -> expect: citation_type=array, citation_first_target={"step":5,"card_id":"a8f4d2c1-..."}

-- 4. Legacy "cards" key is gone
-- SELECT execution_plan ? 'cards' AS has_legacy_cards FROM templates WHERE id = '3442873e-921d-4c97-9f0f-39395c676b35';
-- -> expect: has_legacy_cards=false
