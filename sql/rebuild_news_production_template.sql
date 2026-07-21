-- ============================================================
-- News Template — build script (content-pipeline-v2)
-- ============================================================
-- Creates the "News Production" template: given a seed list of story URLs (from the News Planner),
-- it scrapes the sources, extracts a cited evidence ledger, writes an ORIGINAL SEO-correct article
-- (evidence-only, never rewording source prose), QAs it including source-overlap, and delivers a
-- publish-ready DRAFT to the CMS editorial queue.
--
-- Selection ("what to write") is NOT in this template — the News Planner already decided and seeded
-- it (see ARCHITECTURE.md). This is existing submodules wired as configured cards + ONE new QA
-- submodule (originality-checker). No new skeleton tool is introduced.
--
-- PREREQUISITES
--   1. Drop the originality-checker submodule into modules/step-6-qa/originality-checker/ (repo:
--      content-pipeline-modules-v2) and deploy it, so 'originality-checker' resolves at load time.
--   2. Upload these reference docs to the project's project_reference_docs and capture each id:
--        master_categories.md        -> :DOC_MASTER_CATEGORIES
--        news_targeting_table.md      -> :DOC_TARGETING_TABLE
--        format_spec_news.md          -> :DOC_FORMAT_SPEC_NEWS
--        tone_guide_news.md           -> :DOC_TONE_GUIDE_NEWS
--   3. Paste each prompt body from the pipeline-news/*.md snapshots into the marked
--      '<<PASTE ...>>' placeholders below (the .md files are the versioned record; the
--      canonical prompt lives here in preset_map — same sync pattern as pipeline-company-profiles).
--
-- SEED INPUT: the News Planner writes a seed CSV (orchestrator/seed_csv_contract.md) into the
--   csv-discovery watched folder; step 1 imports it. For a MANUAL test run, hand-author a small CSV
--   with a few real story URLs + the planning columns and drop it in that folder.
-- ============================================================

BEGIN;

INSERT INTO templates (id, name, description, execution_plan, preset_map, seed_config)
VALUES (
  'd1e5c0de-0001-4a01-8b01-000000000001',              -- stable News template id (change if it collides)
  'News Production',
  'OnlyiGaming news PRODUCTION: seed list (from News Planner) → scrape → cited evidence ledger → SEO plan (directory targeting table) → original evidence-only article → QA (facts, citations, source-overlap, meta, structure) → CMS draft for human approval. Selection is the Planner''s job, not this template''s.',

  -- ---------------- execution_plan ----------------
  jsonb_build_object(
    'submodules_per_step', jsonb_build_object(
      -- AUDIT (TEMPLATE_CONFIG_AUDIT.md): csv-discovery is the ONLY step-1 card — Production is
      -- planner-fed. rss-feeds/sitemap/page-links/api-search/search-discovery REMOVED: they belong to
      -- the Planner; api-search's defaults are recruiting keywords and rss-feeds finds endpoints, not
      -- articles. Array order is cosmetic (sort_order governs); kept in execution order.
      '1', jsonb_build_array('csv-discovery'),
      '2', jsonb_build_array('url-dedup','url-canonicalizer','url-filter','url-heuristics'),
      '3', jsonb_build_array('page-scraper','browser-scraper'),
      -- No quota-ranker here: the Planner already selected the batch (see ARCHITECTURE.md). Production
      -- writes what it is seeded; selection is the Planner's job.
      '4', jsonb_build_array('boilerplate-stripper','intent-tagger'),
      '5', jsonb_build_array('content-analyzer','seo-planner','content-writer','tone-seo-editor'),
      '6', jsonb_build_array('keyword-sufficiency-checker','meta-compliance-checker','qa-structural','citation-coverage-checker','hallucination-detector','originality-checker'),
      '7', jsonb_build_array('loop-router'),
      -- AUDIT: schema-org-injector REMOVED — it hardcodes Organization/Product/FAQPage (company-profile
      -- schema), wrong on an article page; the live site emits NewsArticle itself from the payload data.
      '8', jsonb_build_array('meta-output','html-output','markdown-output','json-output')
    ),
    -- one QA-retry card: a failed article re-writes once with the failure visible.
    'card_definitions', jsonb_build_object(
      'd1e5c0de-0002-4a01-8b01-000000000002', jsonb_build_object(
        'card_name', 'news-writer-retry',
        'submodule_id', 'content-writer',
        'step', 5,
        'description', 'Round-2 rewrite when QA fails (citation / hallucination / originality). Inherits the news-report config; round 2 gets the QA feedback.',
        'rounds', jsonb_build_object('1', jsonb_build_object(), '2', jsonb_build_object())
      )
    ),
    'routing_rules', jsonb_build_object(
      'citation:fail',      jsonb_build_array(jsonb_build_object('step',5,'card_id','d1e5c0de-0002-4a01-8b01-000000000002')),
      'hallucination:fail', jsonb_build_array(jsonb_build_object('step',5,'card_id','d1e5c0de-0002-4a01-8b01-000000000002')),
      -- originality-checker emits pass/review/reject; route a 'reject' to a rewrite. 'review' should
      -- surface to the human editor (not auto-retry) — leave that to the queue, not routing_rules.
      'originality:fail', jsonb_build_array(jsonb_build_object('step',5,'card_id','d1e5c0de-0002-4a01-8b01-000000000002'))
    ),
    'escalation_rules', jsonb_build_object(
      '2', jsonb_build_object('fail_threshold',3,'volume_threshold',10,'escalation_submodules',jsonb_build_array()),
      '4', jsonb_build_object('quality_fail_threshold',500,'quality_threshold_words',2000,'escalation_submodules',jsonb_build_array())
    )
  ),

  -- ---------------- preset_map (per-module option overrides) ----------------
  -- Shape: { submodule_id: { preset_name, fallback_values: { option: value } } }
  jsonb_build_object(

    -- csv-discovery configured for the planner seed CSV (AUDIT: defaults are job-board-shaped).
    'csv-discovery', jsonb_build_object('preset_name','news-seed', 'fallback_values', jsonb_build_object(
      'source_label','news-planner',
      'entity_production', true,
      -- one entity per STORY: multi-source rows share a story_cluster_id (human-readable slug, e.g.
      -- cl-ukgc-petfre-fine). VERIFY csv-discovery merges same-name rows into one entity before relying
      -- on multi-source grouping; fallback = single row per story + corroborating_urls column.
      'entity_name_template','{story_cluster_id}',
      'file_pattern','news_seed_*.csv',
      'column_map', jsonb_build_object(
        'url','url','title','title','publisher','company','published_at','posted_date',
        'external_id','externalId','story_cluster_id','story_cluster_id',
        'coverage_owner_theme','coverage_owner_theme',
        'proposed_primary_news_category','proposed_primary_news_category',
        'proposed_primary_dir_category','proposed_primary_dir_category',
        'source_type','source_type','rights_status','rights_status','planning_reason','planning_reason'
      )
    )),

    'content-analyzer', jsonb_build_object('preset_name','news', 'fallback_values', jsonb_build_object(
      'ai_model','sonnet',                              -- haiku fabricates categories (below floor)
      'max_tokens',32768,
      'temperature',0.2,
      'reference_docs', jsonb_build_array(':DOC_MASTER_CATEGORIES'),
      'vocabulary_checks', E'categories.primary[].slug=master_categories.md\ncategories.secondary[].slug=master_categories.md',
      'prompt', '<<PASTE content_analyzer_news_prompt.md prompt block>>'
    )),

    'seo-planner', jsonb_build_object('preset_name','news', 'fallback_values', jsonb_build_object(
      'ai_model','sonnet',
      'max_tokens',32768,
      'temperature',0.3,
      'keyword_research', false,                        -- keywords are the curated table, not web research
      'requires_prompt_override', true,
      'reference_docs', jsonb_build_array(':DOC_TARGETING_TABLE'),
      'prompt', '<<PASTE seo_planner_news_prompt.md prompt block>>'
    )),

    'content-writer', jsonb_build_object('preset_name','news-report', 'fallback_values', jsonb_build_object(
      'ai_model','opus',                               -- prose floor for published output
      'max_tokens',32768,
      'temperature',0.4,
      'requires_prompt_override', true,
      'allowed_slug_paths','',                          -- news is plain prose — no bracket-slug headings
      'reference_docs', jsonb_build_array(':DOC_FORMAT_SPEC_NEWS', ':DOC_TONE_GUIDE_NEWS'),
      'prompt', '<<PASTE content_writer_news_prompt.md prompt block>>'
    )),

    'tone-seo-editor', jsonb_build_object('preset_name','news', 'fallback_values', jsonb_build_object(
      'reference_docs', jsonb_build_array(':DOC_TONE_GUIDE_NEWS'),
      -- 2026-07-21 test run: with the default prompt the editor STRIPPED the mandatory pillar link +
      -- company links from all 3 drafts. The news override makes links inviolable AND carries the
      -- {doc:tone_guide_news.md} token — without a {doc:} token in the prompt, reference_docs is a
      -- silent no-op (code strips unreplaced tokens). Required.
      'prompt', '<<PASTE tone_seo_editor_news_prompt.md prompt block>>',
      -- AUDIT trap (manifest): editor max_tokens "should match or exceed content-writer max_tokens";
      -- default 16384 is half the writer's and a truncation risk.
      'max_tokens', 32768
    )),

    -- qa-structural: defaults assume long-form (min 1500 words, 5 H2s, FAQ required) — every news
    -- draft (350–600w) would fail. Tuned to the news format spec.
    'qa-structural', jsonb_build_object('preset_name','news', 'fallback_values', jsonb_build_object(
      'min_total_words', 300,
      'min_sections', 2,
      'require_faq', false,
      'min_words_per_section', 40
    )),

    -- html-output: default injects Organization-only JSON-LD (company shape) — wrong on articles;
    -- the site emits NewsArticle itself. Sources section kept (good for news).
    'html-output', jsonb_build_object('preset_name','news', 'fallback_values', jsonb_build_object(
      'include_schema_org', false
    )),

    -- meta-output: news gets shared — emit Twitter cards too.
    'meta-output', jsonb_build_object('preset_name','news', 'fallback_values', jsonb_build_object(
      'include_twitter_tags', true
    ))
    -- NOTE: quota-ranker is NOT configured here — it lives in the News PLANNER template (its selection
    -- step), not Production. Its news config (bucket_field=news_tags, bucket_config=theme_config.json,
    -- weights, select_limit) moves to the Planner's rebuild_news_planner_template.sql. See ARCHITECTURE.md.

    ,
    -- originality-checker (Step 6, new): start with defaults; treat 'reject' as the hard fail (routed
    -- to rewrite) and 'review' as an editor-queue flag. Calibrate thresholds on ~10 labelled drafts
    -- before trusting the auto-reject (per second-AI review). Quoted-span exclusion is on by default.
    'originality-checker', jsonb_build_object('preset_name','news', 'fallback_values', jsonb_build_object(
      'max_similarity',0.18, 'max_verbatim_run_words',12, 'min_words',120
    ))
    -- keyword-sufficiency-checker: tune its density band down for short (350–600w) news via its card
    --   options once confirmed (option names not assumed here).
    -- schema-org-injector: LIKELY DROPPABLE — the 2026-07-19 live-site audit found onlyigaming.com
    --   already emits NewsArticle + BreadcrumbList when the article payload carries the data. If the
    --   CMS renders schema itself, remove the injector from step 8 and ensure json-output/meta-output
    --   deliver datePublished/dateModified/author/articleSection(=primary news category)/description.
    -- Coverage counting (multi-tag vs single coverage_owner_theme) is the PLANNER's decision, not this
    --   template's — quota-ranker lives there. See ARCHITECTURE.md.
  ),

  -- ---------------- seed_config ----------------
  -- Production is seeded by the Planner's CSV via csv-discovery, so there is little to configure here.
  -- csv-discovery settings (watched folder, column_map, entity_production:true) can live in its own
  -- preset_map block. Batch size / theme balance / backfill window are the PLANNER's concern.
  jsonb_build_object('_note','csv-discovery reads the Planner seed CSV; see orchestrator/seed_csv_contract.md')
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      execution_plan = EXCLUDED.execution_plan,
      preset_map = EXCLUDED.preset_map,
      seed_config = EXCLUDED.seed_config;

COMMIT;

-- ============================================================
-- VERIFICATION
-- ============================================================
-- SELECT id, name,
--   execution_plan->'submodules_per_step'->'6' AS step6,           -- expect [...,"originality-checker"]
--   preset_map->'content-writer'->'fallback_values'->>'ai_model'   AS writer_model,  -- expect opus
--   preset_map->'seo-planner'->'fallback_values'->>'keyword_research' AS seo_research -- expect false
-- FROM templates WHERE id = 'd1e5c0de-0001-4a01-8b01-000000000001';
--
-- Then confirm NONE of the placeholders survive (each must be substituted before a real run):
-- SELECT preset_map::text LIKE '%<<PASTE%' AS has_prompt_placeholders,     -- expect false
--        preset_map::text LIKE '%:DOC_%'   AS has_doc_id_placeholders      -- expect false
-- FROM templates WHERE id = 'd1e5c0de-0001-4a01-8b01-000000000001';
