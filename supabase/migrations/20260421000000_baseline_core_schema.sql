-- =====================================================================
-- BASELINE — Core pipeline schema (Unit 1.3, backlog #17)
-- =====================================================================
-- Purpose: brings the pre-routing "core" schema under Supabase migration
-- history. Prod's ledger (supabase_migrations.schema_migrations) begins at
-- 20260421202908 (entity_routing_phase1); that migration and its successors
-- ASSUME these core tables already exist (e.g. entity_run_meta REFERENCES
-- pipeline_runs). They were applied out-of-band (Path-B), so a fresh branch
-- could not rebuild from the ledger. This baseline is the missing first
-- migration: on a fresh DB it creates the core, then the 21 tracked
-- migrations replay cleanly on top and reproduce prod.
--
-- Version 20260421000000 sorts BEFORE 20260421202908 (first tracked migration).
--
-- SCOPE: this baseline creates ONLY the 37 core tables that NO tracked
-- migration creates, plus the 4 base-only functions and 2 triggers.
-- Objects OWNED by tracked migrations are intentionally NOT here — they are
-- created by their own migrations on replay:
--   * entity_run_meta, entity_routing_log      -> 20260421202908 entity_routing_phase1
--   * js_knowledge_bank                         -> 20260421220212 create_js_knowledge_bank
--   * gsc_* (7 tables)                          -> 20260602094505 gsc_ingest_001_init (+002)
--   * ga4_* (7 tables)                          -> 20260604080947 ga4_ingest_001_init
--   * card_id / loop_iteration / is_loop_pass / execution_plan_snapshot columns,
--     card-scoped unique indexes, routing/card RPCs (approve_step_v2,
--     append_card_instruction, mark_card_instruction_*)  -> routing + multi-card migrations
-- Core tables here carry their CURRENT (final) shape; where a later migration
-- does ADD COLUMN IF NOT EXISTS on them, it no-ops on replay (audited).
--
-- Reconstructed from the LIVE schema of fevxvwqjhndetktujeuu via pg_catalog
-- (format_type / pg_get_constraintdef / pg_get_indexdef / pg_get_functiondef /
-- pg_get_triggerdef) — the same functions pg_dump uses. 2026-07-07.
--
-- PROD APPLICATION IS METADATA-ONLY: prod already has this schema, so this
-- file is NEVER executed against prod. It is recorded in the ledger as
-- already-applied (repair). It only executes on fresh branch databases.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- 1. TABLES (37 core tables)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analysis_results (
  analysis_id uuid DEFAULT uuid_generate_v4() NOT NULL,
  company_id uuid NOT NULL,
  results jsonb NOT NULL,
  categories jsonb,
  tags jsonb,
  confidence_score numeric(3,2),
  run_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approval_routing (
  routing_id uuid DEFAULT uuid_generate_v4() NOT NULL,
  company_id uuid NOT NULL,
  decision text NOT NULL,
  loopback_step integer,
  confidence numeric(3,2),
  routing_reason text,
  run_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS citation_index (
  citation_id uuid DEFAULT uuid_generate_v4() NOT NULL,
  company_id uuid NOT NULL,
  citations jsonb NOT NULL,
  run_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content_draft (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  company_id uuid NOT NULL,
  content_type text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  word_count integer,
  meta_title text,
  meta_description text,
  run_id uuid NOT NULL,
  generated_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS content_drafts (
  draft_id uuid DEFAULT uuid_generate_v4() NOT NULL,
  company_id uuid NOT NULL,
  markdown_content text NOT NULL,
  json_content jsonb NOT NULL,
  word_count integer,
  section_count integer,
  run_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS decision_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  run_id uuid NOT NULL,
  step_index integer NOT NULL,
  submodule_id text,
  entity_id text,
  decision text NOT NULL,
  reason text,
  context jsonb,
  decided_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS discovered_urls (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  run_entity_id uuid,
  url text NOT NULL,
  discovery_method text,
  priority integer DEFAULT 0,
  status text DEFAULT 'pending'::text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS distribution_audit_log (
  audit_id uuid DEFAULT uuid_generate_v4() NOT NULL,
  company_id uuid NOT NULL,
  export_type text NOT NULL,
  export_target text NOT NULL,
  status text NOT NULL,
  error_message text,
  metadata jsonb DEFAULT '{}'::jsonb,
  run_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS distribution_outputs (
  output_id uuid DEFAULT uuid_generate_v4() NOT NULL,
  company_id uuid NOT NULL,
  markdown_content text NOT NULL,
  json_content jsonb NOT NULL,
  html_content text,
  meta_data jsonb,
  media_refs jsonb DEFAULT '[]'::jsonb,
  manifest jsonb NOT NULL,
  run_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entity_stage_pool (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  run_id uuid NOT NULL,
  step_index integer NOT NULL,
  entity_name text NOT NULL,
  pool_items jsonb DEFAULT '[]'::jsonb NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  error text,
  retry_count integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_submodule_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  stage_id uuid NOT NULL,
  run_id uuid NOT NULL,
  batch_id uuid,
  entity_name text NOT NULL,
  submodule_id text NOT NULL,
  step_index integer NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  options jsonb,
  input_data jsonb,
  output_data jsonb,
  output_render_schema jsonb,
  approved_items jsonb,
  progress jsonb,
  error text,
  logs jsonb,
  retry_of uuid,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  loop_iteration integer DEFAULT 0 NOT NULL,
  card_id uuid
);

CREATE TABLE IF NOT EXISTS manual_review_comments (
  comment_id uuid DEFAULT uuid_generate_v4() NOT NULL,
  company_id uuid NOT NULL,
  reviewer_id uuid,
  comment_text text NOT NULL,
  severity text DEFAULT 'info'::text,
  section text,
  status text DEFAULT 'open'::text,
  run_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  resolved_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS option_presets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  submodule_id text NOT NULL,
  option_name text NOT NULL,
  preset_name text NOT NULL,
  preset_value jsonb NOT NULL,
  project_id uuid,
  is_default boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_metrics (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  run_id uuid NOT NULL,
  submodule_id text NOT NULL,
  entity_name text NOT NULL,
  status text NOT NULL,
  duration_ms integer NOT NULL,
  step_index integer NOT NULL,
  cost text,
  error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  project_id uuid NOT NULL,
  status text DEFAULT 'running'::text NOT NULL,
  current_step integer DEFAULT 0 NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  auto_execute_state jsonb,
  execution_plan_snapshot jsonb
);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  run_id uuid NOT NULL,
  step_index integer NOT NULL,
  step_name text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  input_data jsonb,
  input_render_schema jsonb,
  output_data jsonb,
  output_render_schema jsonb,
  working_pool jsonb,
  working_pool_render_schema jsonb,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  entity_count integer,
  completed_count integer DEFAULT 0,
  failed_count integer DEFAULT 0,
  approved_count integer DEFAULT 0,
  is_loop_pass boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_templates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  project_type text NOT NULL,
  name text NOT NULL,
  stages jsonb NOT NULL,
  version integer DEFAULT 1,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pool_item_blobs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  content jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_reference_docs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  project_id uuid NOT NULL,
  filename text NOT NULL,
  content text NOT NULL,
  content_type text DEFAULT 'text/plain'::text NOT NULL,
  size_bytes integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  description text,
  timing text,
  template_id uuid,
  status text DEFAULT 'active'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  mode text DEFAULT 'single_run'::text
);

CREATE TABLE IF NOT EXISTS qa_fail_log (
  fail_id uuid DEFAULT uuid_generate_v4() NOT NULL,
  company_id uuid NOT NULL,
  step integer NOT NULL,
  node_id text NOT NULL,
  failure_code text NOT NULL,
  failure_details text,
  severity text DEFAULT 'error'::text,
  metadata jsonb DEFAULT '{}'::jsonb,
  run_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qa_results (
  qa_id uuid DEFAULT uuid_generate_v4() NOT NULL,
  company_id uuid NOT NULL,
  structural_valid boolean,
  factual_valid boolean,
  seo_valid boolean,
  overall_status text,
  confidence_score numeric(3,2),
  issues jsonb DEFAULT '[]'::jsonb,
  run_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reference_docs (
  doc_id uuid DEFAULT uuid_generate_v4() NOT NULL,
  doc_type text NOT NULL,
  slug text NOT NULL,
  content jsonb NOT NULL,
  version text NOT NULL,
  is_active boolean DEFAULT true,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS run_entities (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  run_id uuid,
  entity_id uuid,
  entity_snapshot jsonb NOT NULL,
  processing_order integer DEFAULT 0,
  priority integer DEFAULT 0,
  status text DEFAULT 'pending'::text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS run_submodule_config (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  run_id uuid NOT NULL,
  step_index integer NOT NULL,
  submodule_id text NOT NULL,
  input_config jsonb,
  options jsonb,
  data_operation text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  card_id uuid
);

CREATE TABLE IF NOT EXISTS scraped_pages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  run_entity_id uuid,
  discovered_url_id uuid,
  url text NOT NULL,
  content_type text,
  raw_content text,
  extracted_data jsonb,
  word_count integer,
  scraped_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seo_plans (
  plan_id uuid DEFAULT uuid_generate_v4() NOT NULL,
  company_id uuid NOT NULL,
  plan jsonb NOT NULL,
  target_keywords text[],
  meta_title text,
  meta_description text,
  run_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources_final (
  source_id uuid DEFAULT uuid_generate_v4() NOT NULL,
  company_id uuid NOT NULL,
  sources jsonb NOT NULL,
  source_count integer NOT NULL,
  total_words integer,
  run_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS step_context (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  run_id uuid,
  step_index integer NOT NULL,
  entities jsonb NOT NULL,
  source_submodule text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  filename text,
  status text
);

CREATE TABLE IF NOT EXISTS submodule_result_approvals (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  submodule_run_id uuid NOT NULL,
  result_index integer NOT NULL,
  result_url text,
  result_entity_id uuid,
  result_entity_name text,
  status text DEFAULT 'pending'::text NOT NULL,
  rejection_reason text,
  decided_at timestamp with time zone,
  decided_by text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS submodule_run_item_data (
  submodule_run_id uuid NOT NULL,
  item_key text NOT NULL,
  field_name text NOT NULL,
  content text NOT NULL
);

CREATE TABLE IF NOT EXISTS submodule_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  stage_id uuid NOT NULL,
  run_id uuid NOT NULL,
  submodule_id text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  options jsonb,
  input_data jsonb,
  output_data jsonb,
  output_render_schema jsonb,
  approved_items jsonb,
  progress jsonb,
  error text,
  logs jsonb,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  batch_id uuid,
  entity_count integer,
  completed_count integer DEFAULT 0,
  card_id uuid,
  loop_iteration integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS taxonomy_suggestions (
  suggestion_id uuid DEFAULT uuid_generate_v4() NOT NULL,
  company_id uuid NOT NULL,
  suggestion_type text NOT NULL,
  label text NOT NULL,
  why_suggested text,
  evidence_refs text[],
  status text DEFAULT 'pending'::text,
  reviewed_by uuid,
  review_notes text,
  run_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  reviewed_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS template_preset_mappings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  template_id uuid NOT NULL,
  submodule_id text NOT NULL,
  option_name text NOT NULL,
  preset_id uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS template_reference_docs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  template_id uuid NOT NULL,
  filename text NOT NULL,
  content text NOT NULL,
  content_type text DEFAULT 'text/plain'::text NOT NULL,
  size_bytes integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS templates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  preset_map jsonb DEFAULT '{}'::jsonb,
  execution_plan jsonb DEFAULT '{}'::jsonb,
  seed_config jsonb DEFAULT '{"seed_type": "csv"}'::jsonb
);

CREATE TABLE IF NOT EXISTS workflow_events (
  event_id uuid DEFAULT uuid_generate_v4() NOT NULL,
  company_id uuid,
  run_id uuid NOT NULL,
  step integer NOT NULL,
  node_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL,
  message text,
  payload jsonb DEFAULT '{}'::jsonb,
  issues jsonb DEFAULT '{}'::jsonb,
  actor text DEFAULT 'system'::text,
  duration_ms integer,
  created_at timestamp with time zone DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 2. BASE FUNCTIONS (not managed by any tracked migration)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_step(p_stage_id uuid, p_output_data jsonb, p_output_render_schema jsonb)
 RETURNS TABLE(next_step integer, run_completed boolean)
 LANGUAGE plpgsql
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.cleanup_old_data()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  TRUNCATE discovered_urls CASCADE;
  TRUNCATE submodule_result_approvals;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_step_context_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------
-- 3. CONSTRAINTS (PK / UNIQUE / CHECK first, then FK)
-- ---------------------------------------------------------------------
ALTER TABLE analysis_results ADD CONSTRAINT analysis_results_pkey PRIMARY KEY (analysis_id);
ALTER TABLE approval_routing ADD CONSTRAINT approval_routing_pkey PRIMARY KEY (routing_id);
ALTER TABLE citation_index ADD CONSTRAINT citation_index_pkey PRIMARY KEY (citation_id);
ALTER TABLE content_draft ADD CONSTRAINT content_draft_pkey PRIMARY KEY (id);
ALTER TABLE content_drafts ADD CONSTRAINT content_drafts_pkey PRIMARY KEY (draft_id);
ALTER TABLE decision_log ADD CONSTRAINT decision_log_pkey PRIMARY KEY (id);
ALTER TABLE discovered_urls ADD CONSTRAINT discovered_urls_pkey PRIMARY KEY (id);
ALTER TABLE distribution_audit_log ADD CONSTRAINT distribution_audit_log_pkey PRIMARY KEY (audit_id);
ALTER TABLE distribution_outputs ADD CONSTRAINT distribution_outputs_pkey PRIMARY KEY (output_id);
ALTER TABLE entity_stage_pool ADD CONSTRAINT entity_stage_pool_pkey PRIMARY KEY (id);
ALTER TABLE entity_submodule_runs ADD CONSTRAINT entity_submodule_runs_pkey PRIMARY KEY (id);
ALTER TABLE manual_review_comments ADD CONSTRAINT manual_review_comments_pkey PRIMARY KEY (comment_id);
ALTER TABLE option_presets ADD CONSTRAINT option_presets_pkey PRIMARY KEY (id);
ALTER TABLE pipeline_metrics ADD CONSTRAINT pipeline_metrics_pkey PRIMARY KEY (id);
ALTER TABLE pipeline_runs ADD CONSTRAINT pipeline_runs_pkey PRIMARY KEY (id);
ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_pkey PRIMARY KEY (id);
ALTER TABLE pipeline_templates ADD CONSTRAINT pipeline_templates_pkey PRIMARY KEY (id);
ALTER TABLE pool_item_blobs ADD CONSTRAINT pool_item_blobs_pkey PRIMARY KEY (id);
ALTER TABLE project_reference_docs ADD CONSTRAINT project_reference_docs_pkey PRIMARY KEY (id);
ALTER TABLE projects ADD CONSTRAINT projects_pkey PRIMARY KEY (id);
ALTER TABLE qa_fail_log ADD CONSTRAINT qa_fail_log_pkey PRIMARY KEY (fail_id);
ALTER TABLE qa_results ADD CONSTRAINT qa_results_pkey PRIMARY KEY (qa_id);
ALTER TABLE reference_docs ADD CONSTRAINT reference_docs_pkey PRIMARY KEY (doc_id);
ALTER TABLE run_entities ADD CONSTRAINT run_entities_pkey PRIMARY KEY (id);
ALTER TABLE run_submodule_config ADD CONSTRAINT run_submodule_config_pkey PRIMARY KEY (id);
ALTER TABLE scraped_pages ADD CONSTRAINT scraped_pages_pkey PRIMARY KEY (id);
ALTER TABLE seo_plans ADD CONSTRAINT seo_plans_pkey PRIMARY KEY (plan_id);
ALTER TABLE sources_final ADD CONSTRAINT sources_final_pkey PRIMARY KEY (source_id);
ALTER TABLE step_context ADD CONSTRAINT step_context_pkey PRIMARY KEY (id);
ALTER TABLE submodule_result_approvals ADD CONSTRAINT submodule_result_approvals_pkey PRIMARY KEY (id);
ALTER TABLE submodule_run_item_data ADD CONSTRAINT submodule_run_item_data_pkey PRIMARY KEY (submodule_run_id, item_key, field_name);
ALTER TABLE submodule_runs ADD CONSTRAINT submodule_runs_pkey PRIMARY KEY (id);
ALTER TABLE taxonomy_suggestions ADD CONSTRAINT taxonomy_suggestions_pkey PRIMARY KEY (suggestion_id);
ALTER TABLE template_preset_mappings ADD CONSTRAINT template_preset_mappings_pkey PRIMARY KEY (id);
ALTER TABLE template_reference_docs ADD CONSTRAINT template_reference_docs_pkey PRIMARY KEY (id);
ALTER TABLE templates ADD CONSTRAINT templates_pkey PRIMARY KEY (id);
ALTER TABLE workflow_events ADD CONSTRAINT workflow_events_pkey PRIMARY KEY (event_id);
ALTER TABLE analysis_results ADD CONSTRAINT analysis_results_company_id_run_id_key UNIQUE (company_id, run_id);
ALTER TABLE approval_routing ADD CONSTRAINT approval_routing_company_id_run_id_key UNIQUE (company_id, run_id);
ALTER TABLE citation_index ADD CONSTRAINT citation_index_company_id_run_id_key UNIQUE (company_id, run_id);
ALTER TABLE content_drafts ADD CONSTRAINT content_drafts_company_id_run_id_key UNIQUE (company_id, run_id);
ALTER TABLE discovered_urls ADD CONSTRAINT discovered_urls_entity_url_unique UNIQUE (run_entity_id, url);
ALTER TABLE distribution_outputs ADD CONSTRAINT distribution_outputs_company_id_run_id_key UNIQUE (company_id, run_id);
ALTER TABLE project_reference_docs ADD CONSTRAINT project_reference_docs_project_id_filename_key UNIQUE (project_id, filename);
ALTER TABLE qa_results ADD CONSTRAINT qa_results_company_id_run_id_key UNIQUE (company_id, run_id);
ALTER TABLE reference_docs ADD CONSTRAINT reference_docs_doc_type_slug_key UNIQUE (doc_type, slug);
ALTER TABLE run_entities ADD CONSTRAINT run_entities_run_id_entity_id_key UNIQUE (run_id, entity_id);
ALTER TABLE seo_plans ADD CONSTRAINT seo_plans_company_id_run_id_key UNIQUE (company_id, run_id);
ALTER TABLE sources_final ADD CONSTRAINT sources_final_company_id_run_id_key UNIQUE (company_id, run_id);
ALTER TABLE step_context ADD CONSTRAINT step_context_run_id_step_index_key UNIQUE (run_id, step_index);
ALTER TABLE submodule_result_approvals ADD CONSTRAINT submodule_result_approvals_submodule_run_id_result_index_key UNIQUE (submodule_run_id, result_index);
ALTER TABLE template_preset_mappings ADD CONSTRAINT template_preset_mappings_template_id_submodule_id_option_na_key UNIQUE (template_id, submodule_id, option_name);
ALTER TABLE template_reference_docs ADD CONSTRAINT template_reference_docs_template_id_filename_key UNIQUE (template_id, filename);
ALTER TABLE templates ADD CONSTRAINT templates_name_key UNIQUE (name);
ALTER TABLE approval_routing ADD CONSTRAINT approval_routing_decision_check CHECK ((decision = ANY (ARRAY['approved'::text, 'loopback'::text])));
ALTER TABLE distribution_audit_log ADD CONSTRAINT distribution_audit_log_status_check CHECK ((status = ANY (ARRAY['success'::text, 'failed'::text, 'partial'::text])));
ALTER TABLE manual_review_comments ADD CONSTRAINT manual_review_comments_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'minor'::text, 'major'::text, 'critical'::text])));
ALTER TABLE manual_review_comments ADD CONSTRAINT manual_review_comments_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'wontfix'::text])));
ALTER TABLE qa_fail_log ADD CONSTRAINT qa_fail_log_severity_check CHECK ((severity = ANY (ARRAY['warning'::text, 'error'::text, 'critical'::text])));
ALTER TABLE qa_results ADD CONSTRAINT qa_results_overall_status_check CHECK ((overall_status = ANY (ARRAY['pass'::text, 'needs_revision'::text, 'fail'::text])));
ALTER TABLE reference_docs ADD CONSTRAINT reference_docs_doc_type_check CHECK ((doc_type = ANY (ARRAY['categories'::text, 'tags'::text, 'tone_guide'::text, 'format_spec'::text, 'keyword_packs'::text])));
ALTER TABLE run_entities ADD CONSTRAINT valid_entity_status CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'skipped'::text, 'awaiting_approval'::text])));
ALTER TABLE submodule_result_approvals ADD CONSTRAINT submodule_result_approvals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE taxonomy_suggestions ADD CONSTRAINT taxonomy_suggestions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'merged'::text])));
ALTER TABLE taxonomy_suggestions ADD CONSTRAINT taxonomy_suggestions_suggestion_type_check CHECK ((suggestion_type = ANY (ARRAY['category'::text, 'tag'::text])));
ALTER TABLE workflow_events ADD CONSTRAINT workflow_events_actor_check CHECK ((actor = ANY (ARRAY['system'::text, 'llm'::text, 'human'::text])));
ALTER TABLE workflow_events ADD CONSTRAINT workflow_events_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'warning'::text, 'error'::text])));
ALTER TABLE decision_log ADD CONSTRAINT decision_log_run_id_fkey FOREIGN KEY (run_id) REFERENCES pipeline_runs(id);
ALTER TABLE discovered_urls ADD CONSTRAINT discovered_urls_run_entity_id_fkey FOREIGN KEY (run_entity_id) REFERENCES run_entities(id) ON DELETE CASCADE;
ALTER TABLE entity_stage_pool ADD CONSTRAINT entity_stage_pool_run_id_fkey FOREIGN KEY (run_id) REFERENCES pipeline_runs(id);
ALTER TABLE entity_submodule_runs ADD CONSTRAINT entity_submodule_runs_retry_of_fkey FOREIGN KEY (retry_of) REFERENCES entity_submodule_runs(id);
ALTER TABLE entity_submodule_runs ADD CONSTRAINT entity_submodule_runs_run_id_fkey FOREIGN KEY (run_id) REFERENCES pipeline_runs(id);
ALTER TABLE entity_submodule_runs ADD CONSTRAINT entity_submodule_runs_stage_id_fkey FOREIGN KEY (stage_id) REFERENCES pipeline_stages(id);
ALTER TABLE option_presets ADD CONSTRAINT option_presets_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE pipeline_metrics ADD CONSTRAINT pipeline_metrics_run_id_fkey FOREIGN KEY (run_id) REFERENCES pipeline_runs(id);
ALTER TABLE pipeline_runs ADD CONSTRAINT pipeline_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_run_id_fkey FOREIGN KEY (run_id) REFERENCES pipeline_runs(id);
ALTER TABLE project_reference_docs ADD CONSTRAINT project_reference_docs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE projects ADD CONSTRAINT fk_projects_template FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL;
ALTER TABLE run_submodule_config ADD CONSTRAINT run_submodule_config_run_id_fkey FOREIGN KEY (run_id) REFERENCES pipeline_runs(id);
ALTER TABLE scraped_pages ADD CONSTRAINT scraped_pages_discovered_url_id_fkey FOREIGN KEY (discovered_url_id) REFERENCES discovered_urls(id);
ALTER TABLE scraped_pages ADD CONSTRAINT scraped_pages_run_entity_id_fkey FOREIGN KEY (run_entity_id) REFERENCES run_entities(id) ON DELETE CASCADE;
ALTER TABLE submodule_runs ADD CONSTRAINT submodule_runs_run_id_fkey FOREIGN KEY (run_id) REFERENCES pipeline_runs(id);
ALTER TABLE submodule_runs ADD CONSTRAINT submodule_runs_stage_id_fkey FOREIGN KEY (stage_id) REFERENCES pipeline_stages(id);
ALTER TABLE template_preset_mappings ADD CONSTRAINT template_preset_mappings_preset_id_fkey FOREIGN KEY (preset_id) REFERENCES option_presets(id) ON DELETE RESTRICT;
ALTER TABLE template_preset_mappings ADD CONSTRAINT template_preset_mappings_template_id_fkey FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE;
ALTER TABLE template_reference_docs ADD CONSTRAINT template_reference_docs_template_id_fkey FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------
-- 4. INDEXES (non-constraint-backing)
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_content_draft_company_id ON public.content_draft USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_content_draft_content_type ON public.content_draft USING btree (content_type);
CREATE INDEX IF NOT EXISTS idx_content_draft_generated_at ON public.content_draft USING btree (generated_at);
CREATE INDEX IF NOT EXISTS idx_decision_log_run_id ON public.decision_log USING btree (run_id);
CREATE INDEX IF NOT EXISTS idx_urls_entity ON public.discovered_urls USING btree (run_entity_id, status);
CREATE INDEX IF NOT EXISTS idx_entity_stage_pool_run_step ON public.entity_stage_pool USING btree (run_id, step_index);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_stage_pool_unique ON public.entity_stage_pool USING btree (run_id, step_index, entity_name);
CREATE INDEX IF NOT EXISTS idx_entity_submodule_runs_batch ON public.entity_submodule_runs USING btree (batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_submodule_runs_one_active_card ON public.entity_submodule_runs USING btree (run_id, step_index, entity_name, submodule_id, COALESCE((card_id)::text, ''::text), loop_iteration) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));
CREATE INDEX IF NOT EXISTS idx_entity_submodule_runs_run ON public.entity_submodule_runs USING btree (run_id);
CREATE INDEX IF NOT EXISTS idx_entity_submodule_runs_stage ON public.entity_submodule_runs USING btree (stage_id);
CREATE INDEX IF NOT EXISTS idx_option_presets_lookup ON public.option_presets USING btree (submodule_id, option_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_option_presets_unique_name_global ON public.option_presets USING btree (submodule_id, option_name, preset_name) WHERE (project_id IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_option_presets_unique_name_project ON public.option_presets USING btree (submodule_id, option_name, preset_name, project_id) WHERE (project_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pipeline_metrics_created_at ON public.pipeline_metrics USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_pipeline_metrics_run_id ON public.pipeline_metrics USING btree (run_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_metrics_submodule_id ON public.pipeline_metrics USING btree (submodule_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project_id ON public.pipeline_runs USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_stages_run_id ON public.pipeline_stages USING btree (run_id);
CREATE INDEX IF NOT EXISTS idx_pool_item_blobs_created_at ON public.pool_item_blobs USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_project_reference_docs_project_id ON public.project_reference_docs USING btree (project_id);
CREATE INDEX IF NOT EXISTS idx_qa_fail_log_company_id ON public.qa_fail_log USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_qa_fail_log_step ON public.qa_fail_log USING btree (step);
CREATE INDEX IF NOT EXISTS idx_qa_results_company_id ON public.qa_results USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_qa_results_status ON public.qa_results USING btree (overall_status);
CREATE INDEX IF NOT EXISTS idx_reference_docs_type ON public.reference_docs USING btree (doc_type);
CREATE UNIQUE INDEX IF NOT EXISTS run_submodule_config_run_step_sm_card_uniq ON public.run_submodule_config USING btree (run_id, step_index, submodule_id, card_id) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_pages_entity ON public.scraped_pages USING btree (run_entity_id);
CREATE INDEX IF NOT EXISTS idx_step_context_run ON public.step_context USING btree (run_id);
CREATE INDEX IF NOT EXISTS idx_sra_entity ON public.submodule_result_approvals USING btree (result_entity_id);
CREATE INDEX IF NOT EXISTS idx_sra_status ON public.submodule_result_approvals USING btree (status);
CREATE INDEX IF NOT EXISTS idx_sra_submodule_run ON public.submodule_result_approvals USING btree (submodule_run_id);
CREATE INDEX IF NOT EXISTS idx_submodule_run_item_data_run_id ON public.submodule_run_item_data USING btree (submodule_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_submodule_card ON public.submodule_runs USING btree (run_id, submodule_id, COALESCE((card_id)::text, ''::text)) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));
CREATE INDEX IF NOT EXISTS idx_submodule_runs_run_id ON public.submodule_runs USING btree (run_id);
CREATE INDEX IF NOT EXISTS idx_submodule_runs_stage_id ON public.submodule_runs USING btree (stage_id);
CREATE INDEX IF NOT EXISTS idx_submodule_runs_stage_submodule ON public.submodule_runs USING btree (stage_id, submodule_id);
CREATE INDEX IF NOT EXISTS idx_taxonomy_suggestions_company_id ON public.taxonomy_suggestions USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_taxonomy_suggestions_status ON public.taxonomy_suggestions USING btree (status);
CREATE INDEX IF NOT EXISTS idx_taxonomy_suggestions_type ON public.taxonomy_suggestions USING btree (suggestion_type);
CREATE INDEX IF NOT EXISTS idx_workflow_events_company_id ON public.workflow_events USING btree (company_id);
CREATE INDEX IF NOT EXISTS idx_workflow_events_created_at ON public.workflow_events USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_events_run_id ON public.workflow_events USING btree (run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_events_status ON public.workflow_events USING btree (status);
CREATE INDEX IF NOT EXISTS idx_workflow_events_step ON public.workflow_events USING btree (step);

-- ---------------------------------------------------------------------
-- 5. TRIGGERS
-- ---------------------------------------------------------------------
CREATE OR REPLACE TRIGGER step_context_updated_at BEFORE UPDATE ON public.step_context FOR EACH ROW EXECUTE FUNCTION update_step_context_timestamp();
CREATE OR REPLACE TRIGGER update_reference_docs_updated_at BEFORE UPDATE ON public.reference_docs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================================
-- END BASELINE
-- =====================================================================
