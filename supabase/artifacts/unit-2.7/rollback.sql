-- =====================================================================
-- ROLLBACK for 20260710000000_v6_scalar_round_card_model.sql (CTO2-1, CRITICAL)
-- =====================================================================
-- The card-model migration is a JSONB DATA rewrite of templates.execution_plan.
-- A code revert-anchor does NOT undo a data rewrite — this per-row pre-migration
-- snapshot is the ONLY working rollback.
--
-- Mutated templates (unit 2.7 enumeration, verified against prod 2026-07-10):
--   EXACTLY ONE — 30-april / 3442873e-921d-4c97-9f0f-39395c676b35.
--
-- The embedded JSON below is the EXACT pre-migration execution_plan captured from
-- prod (fevxvwqjhndetktujeuu) on 2026-07-10.
--   canonical md5( execution_plan::text ) = 637910f29ea241ac53047b44de08c984
-- After restore, verify:
--   SELECT md5(execution_plan::text) FROM templates
--   WHERE id = '3442873e-921d-4c97-9f0f-39395c676b35';
--   -- expect: 637910f29ea241ac53047b44de08c984
--
-- RESUME-TIME HAZARD (V6-§8, master-plan 3.1 Codex-2): halted old-shape runs
-- re-read the LIVE template on resume, and per-batch execution reads the FROZEN
-- execution_plan_snapshot — a snapshot/live split-brain. This restore fixes the
-- TEMPLATE only; the 3.1 deploy must ALSO gate on run-state (drain all resumable
-- old-shape runs) before/after any flip. Restoring the template is necessary, not
-- sufficient, for a mid-flight rollback.
-- =====================================================================

UPDATE templates
SET execution_plan = $ep$
{"routing_rules": {"citation:fail": [{"step": 5, "card_id": "a8f4d2c1-7e57-4001-8001-deadbeef0001"}], "hallucination:fail": [{"step": 5, "card_id": "a8f4d2c1-7e57-4001-8001-deadbeef0001"}]}, "card_definitions": {"a8f4d2c1-7e57-4001-8001-deadbeef0001": {"step": 5, "rounds": {"1": {}, "2": {"_placeholder_marker": "sub-plan-1-ship-gate"}}, "card_name": "writer-v2-placeholder", "description": "Placeholder retry card for sub-plan 1 ship-gate mechanism test. Round 2 marker proves the routed-retry path executed. Real escalation config produced in sub-plan 4.", "submodule_id": "content-writer"}}, "escalation_rules": {"2": {"_comment": "Step 2 (Validation): entities with <3 discovered URLs are terminal failures, <10 triggers threshold warning", "fail_threshold": 3, "volume_threshold": 10, "escalation_submodules": []}, "4": {"_comment": "Step 4 (Filtering): entities with <500 total scraped words are terminal failures, <2000 triggers threshold warning", "escalation_submodules": [], "quality_fail_threshold": 500, "quality_threshold_words": 2000}}, "submodules_per_step": {"1": ["sitemap-parser", "page-links", "browser-crawler", "deep-links", "rss-feeds"], "2": ["url-dedup", "url-canonicalizer", "url-filter", "url-relevance"], "3": ["page-scraper", "browser-scraper", "api-scraper"], "4": ["boilerplate-stripper", "intent-tagger", "content-filter"], "5": ["content-analyzer", "seo-planner", "content-writer", "tone-seo-editor", "a8f4d2c1-7e57-4001-8001-deadbeef0001"], "6": ["keyword-sufficiency-checker", "meta-compliance-checker", "qa-structural", "citation-coverage-checker", "hallucination-detector"], "7": ["loop-router"], "8": ["meta-output", "html-output", "markdown-output", "schema-org-injector", "company-media", "json-output"]}}
$ep$::jsonb
WHERE id = '3442873e-921d-4c97-9f0f-39395c676b35';
