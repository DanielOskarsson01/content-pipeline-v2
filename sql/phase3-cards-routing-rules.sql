-- Phase 3: Add cards, routing_rules, and escalation_rules to company_profile template
-- Run against the Supabase database after deploying Batches 1-6 code changes.
--
-- This updates the execution_plan JSONB column on the template.
-- Cards provide alternate option sets for routing loops.
-- Routing rules map QA failures → target cards.
-- Escalation rules define threshold gates at Steps 2 and 4.

-- First, verify the template exists and show current execution_plan
-- SELECT id, name, execution_plan FROM templates WHERE name ILIKE '%company%' LIMIT 5;

-- Update: merge cards, routing_rules, and escalation_rules into execution_plan
-- Uses jsonb_set chaining to preserve existing fields (submodules_per_step, etc.)
UPDATE templates
SET execution_plan = execution_plan
  || jsonb_build_object(
    'cards', '{
      "pse-v2": {
        "submodule_id": "browser-crawler",
        "step": 1,
        "options_overrides": {
          "max_pages": 30,
          "depth": 3,
          "follow_external": true
        },
        "description": "Broader discovery: deeper crawl with external links for more source material"
      },
      "scraper-deluxe-v2": {
        "submodule_id": "browser-scraper",
        "step": 3,
        "options_overrides": {
          "use_unlocker": true,
          "timeout": 30000,
          "wait_for_selector": "article, main, .content"
        },
        "description": "Enhanced scraper with Web Unlocker for hard-to-scrape sites"
      },
      "writer-v2": {
        "submodule_id": "content-writer",
        "step": 5,
        "options_overrides": {
          "temperature": 0.2,
          "system_prompt_suffix": "CRITICAL: Every factual claim MUST have an inline citation [#n]. Do not state any fact, statistic, date, or company detail without citing the source. If you cannot cite it, do not include it.",
          "require_citations": true
        },
        "description": "Stricter citation-required writer with lower temperature for factual accuracy"
      },
      "seo-writer-v2": {
        "submodule_id": "tone-seo-editor",
        "step": 5,
        "options_overrides": {
          "temperature": 0.3,
          "keyword_emphasis": "aggressive",
          "system_prompt_suffix": "Focus on keyword placement: ensure head terms appear in H1, H2, and first paragraph of each section. Rewrite headings to naturally include target keywords."
        },
        "description": "Aggressive keyword integration for SEO failures"
      }
    }'::jsonb,
    'routing_rules', '{
      "hallucination:fail": {
        "target_cards": ["pse-v2", "writer-v2"],
        "description": "Hallucination detected: broaden sources + use strict citation writer"
      },
      "citation:fail": {
        "target_cards": ["pse-v2", "writer-v2"],
        "description": "Citation gaps: broaden sources + enforce citation requirements"
      },
      "keyword:fail": {
        "target_cards": ["seo-writer-v2"],
        "description": "Keyword issues: aggressive SEO rewrite"
      },
      "meta:fail": {
        "target_cards": ["seo-writer-v2"],
        "description": "Meta compliance issues: SEO-focused rewrite"
      },
      "structural:fail": {
        "target_cards": ["writer-v2"],
        "description": "Structural issues: stricter writer with better formatting"
      }
    }'::jsonb,
    'escalation_rules', '{
      "2": {
        "volume_threshold": 10,
        "fail_threshold": 3,
        "escalation_submodules": [],
        "_comment": "Step 2 (Validation): entities with <3 discovered URLs are terminal failures, <10 triggers threshold warning"
      },
      "4": {
        "quality_threshold_words": 2000,
        "quality_fail_threshold": 500,
        "escalation_submodules": [],
        "_comment": "Step 4 (Filtering): entities with <500 total scraped words are terminal failures, <2000 triggers threshold warning"
      }
    }'::jsonb
  )
WHERE name ILIKE '%company_profile%'
  OR name ILIKE '%company profile%';
