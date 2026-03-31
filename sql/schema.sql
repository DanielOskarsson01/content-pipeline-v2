-- Content Pipeline v2 — Database Schema
-- Phase 2: Core pipeline tables

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  timing TEXT,
  template_id UUID,
  mode TEXT NOT NULL DEFAULT 'single_run',
  -- single_run | use_template | update_template | new_template | fork_template
  status TEXT NOT NULL DEFAULT 'active',
  -- active | draft (launch endpoint creates as draft, flips to active on success) | archived
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pipeline Runs — one execution of a project through the 11-step sequence
-- Status: running → auto_executing → completed | halted | abandoned
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL DEFAULT 'running',
  current_step INTEGER NOT NULL DEFAULT 0,
  auto_execute_state JSONB,  -- Phase 12c: orchestrator state (current_step, per_step_results, failure_thresholds, etc.)
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Pipeline Stages — one step's data within a run
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  step_index INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input_data JSONB,
  input_render_schema JSONB,
  output_data JSONB,
  output_render_schema JSONB,
  working_pool JSONB,                -- DEAD: legacy flat-pool column, drop after P6 data cleanup
  working_pool_render_schema JSONB,  -- DEAD: legacy flat-pool column, drop after P6 data cleanup
  entity_count INTEGER,              -- Per-entity: total entities at this step
  completed_count INTEGER DEFAULT 0, -- Per-entity: entities completed
  failed_count INTEGER DEFAULT 0,    -- Per-entity: entities permanently failed
  approved_count INTEGER DEFAULT 0,  -- Per-entity: entities approved to advance
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pipeline_stages_run_id ON pipeline_stages(run_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project_id ON pipeline_runs(project_id);

-- Phase 5: Submodule configuration per run/step/submodule
CREATE TABLE IF NOT EXISTS run_submodule_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  step_index INTEGER NOT NULL,
  submodule_id TEXT NOT NULL,
  input_config JSONB,
  options JSONB,
  data_operation TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(run_id, step_index, submodule_id)
);

-- Phase 6: Shared step context (CSV upload storage)
CREATE TABLE IF NOT EXISTS step_context (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  step_index INTEGER NOT NULL,
  entities JSONB NOT NULL,
  filename TEXT,
  source_submodule TEXT,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(run_id, step_index)
);

-- Phase 7: Submodule runs — one execution of one submodule within a step
-- In per-entity mode, this becomes a "batch run" record tracking the overall trigger.
-- Individual entity results live in entity_submodule_runs.
CREATE TABLE IF NOT EXISTS submodule_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id UUID NOT NULL REFERENCES pipeline_stages(id),
  run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  submodule_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  options JSONB,
  input_data JSONB,
  output_data JSONB,
  output_render_schema JSONB,
  approved_items JSONB,
  progress JSONB,
  error TEXT,
  logs JSONB,
  batch_id UUID,             -- Per-entity: groups entity_submodule_runs from same trigger
  entity_count INTEGER,      -- Per-entity: how many entity jobs were spawned
  completed_count INTEGER DEFAULT 0, -- Per-entity: how many finished
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_submodule_runs_run_id ON submodule_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_submodule_runs_stage_id ON submodule_runs(stage_id);
CREATE INDEX IF NOT EXISTS idx_submodule_runs_stage_submodule ON submodule_runs(stage_id, submodule_id);

-- Prevent concurrent execution: only one pending/running run per submodule per pipeline run
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_submodule
  ON submodule_runs(run_id, submodule_id)
  WHERE status IN ('pending', 'running');

-- Phase 7: Decision log — every human judgment recorded
CREATE TABLE IF NOT EXISTS decision_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  step_index INTEGER NOT NULL,
  submodule_id TEXT,
  entity_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  context JSONB,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decision_log_run_id ON decision_log(run_id);

-- Phase 9c: Project-level reference documents (style guides, templates, brand voice)
CREATE TABLE IF NOT EXISTS project_reference_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text/plain',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, filename)
);

CREATE INDEX IF NOT EXISTS idx_project_reference_docs_project_id
  ON project_reference_docs(project_id);

-- Separate storage for large downloadable fields (e.g. text_content from page-scraper).
-- The main submodule_runs row stores metadata only; full content lives here (one row per item per field).
-- This avoids Supabase row size limits when scraping 1000+ pages.
CREATE TABLE IF NOT EXISTS submodule_run_item_data (
  submodule_run_id UUID NOT NULL,  -- Polymorphic: submodule_runs(id) or entity_submodule_runs(id). No FK — PG can't enforce one column referencing two tables.
  item_key TEXT NOT NULL,
  field_name TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (submodule_run_id, item_key, field_name)
);

CREATE INDEX IF NOT EXISTS idx_submodule_run_item_data_run_id
  ON submodule_run_item_data(submodule_run_id);

-- Per-entity pool storage: one row per entity per step
-- Replaces pipeline_stages.working_pool for new runs
CREATE TABLE IF NOT EXISTS entity_stage_pool (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  step_index INTEGER NOT NULL,
  entity_name TEXT NOT NULL,
  pool_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entity_stage_pool_run_step
  ON entity_stage_pool(run_id, step_index);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_stage_pool_unique
  ON entity_stage_pool(run_id, step_index, entity_name);

-- Per-entity submodule execution: one row per entity per submodule run
CREATE TABLE IF NOT EXISTS entity_submodule_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id UUID NOT NULL REFERENCES pipeline_stages(id),
  run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  batch_id UUID,
  entity_name TEXT NOT NULL,
  submodule_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  options JSONB,
  input_data JSONB,
  output_data JSONB,
  output_render_schema JSONB,
  approved_items JSONB,
  progress JSONB,
  error TEXT,
  logs JSONB,
  retry_of UUID REFERENCES entity_submodule_runs(id),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_entity_submodule_runs_batch
  ON entity_submodule_runs(batch_id);
CREATE INDEX IF NOT EXISTS idx_entity_submodule_runs_stage
  ON entity_submodule_runs(stage_id);
CREATE INDEX IF NOT EXISTS idx_entity_submodule_runs_run
  ON entity_submodule_runs(run_id);

-- Prevent duplicate active runs per entity per submodule
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_submodule_runs_one_active
  ON entity_submodule_runs(run_id, step_index, entity_name, submodule_id)
  WHERE status IN ('pending', 'running');

-- ============================================================
-- DEAD: approve_step — legacy flat-pool RPC, drop after P6 data cleanup
-- Was: Atomic step approval for flat-pool mode. Replaced by approve_step_v2.
-- ============================================================
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
  SELECT run_id, step_index INTO v_run_id, v_step_index
  FROM pipeline_stages
  WHERE id = p_stage_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stage not found: %', p_stage_id;
  END IF;

  v_is_last := v_step_index >= 10;
  v_next_step := CASE WHEN v_is_last THEN NULL ELSE v_step_index + 1 END;

  UPDATE pipeline_stages SET
    status = 'completed',
    completed_at = NOW(),
    output_data = p_output_data,
    output_render_schema = p_output_render_schema
  WHERE id = p_stage_id;

  IF v_is_last THEN
    UPDATE pipeline_runs SET
      status = 'completed',
      completed_at = NOW()
    WHERE id = v_run_id;

    RETURN QUERY SELECT NULL::INTEGER AS next_step, TRUE AS run_completed;
  ELSE
    UPDATE pipeline_stages SET
      status = 'active',
      input_data = p_output_data,
      input_render_schema = p_output_render_schema,
      working_pool = p_output_data,
      started_at = NOW()
    WHERE run_id = v_run_id AND step_index = v_next_step;

    UPDATE pipeline_runs SET
      current_step = v_next_step
    WHERE id = v_run_id;

    RETURN QUERY SELECT v_next_step AS next_step, FALSE AS run_completed;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: approve_step_v2 (Per-entity mode)
-- Forwards approved entity pools to the next step.
-- ============================================================
CREATE OR REPLACE FUNCTION approve_step_v2(
  p_stage_id UUID,
  p_output_render_schema JSONB,
  p_entity_count INTEGER,
  p_approved_count INTEGER
)
RETURNS TABLE(next_step INTEGER, run_completed BOOLEAN) AS $$
DECLARE
  v_run_id UUID;
  v_step_index INTEGER;
  v_is_last BOOLEAN;
  v_next_step INTEGER;
BEGIN
  SELECT run_id, step_index INTO v_run_id, v_step_index
  FROM pipeline_stages
  WHERE id = p_stage_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stage not found: %', p_stage_id;
  END IF;

  v_is_last := v_step_index >= 10;
  v_next_step := CASE WHEN v_is_last THEN NULL ELSE v_step_index + 1 END;

  UPDATE pipeline_stages SET
    status = 'completed',
    completed_at = NOW(),
    output_render_schema = p_output_render_schema,
    entity_count = p_entity_count,
    approved_count = p_approved_count
  WHERE id = p_stage_id;

  IF v_is_last THEN
    UPDATE pipeline_runs SET
      status = 'completed',
      completed_at = NOW()
    WHERE id = v_run_id;

    RETURN QUERY SELECT NULL::INTEGER AS next_step, TRUE AS run_completed;
  ELSE
    UPDATE pipeline_stages SET
      status = 'active',
      started_at = NOW(),
      entity_count = p_approved_count,
      completed_count = 0,
      failed_count = 0,
      approved_count = 0
    WHERE run_id = v_run_id AND step_index = v_next_step;

    INSERT INTO entity_stage_pool (run_id, step_index, entity_name, pool_items, status)
    SELECT
      v_run_id,
      v_next_step,
      esp.entity_name,
      esp.pool_items,
      'pending'
    FROM entity_stage_pool esp
    WHERE esp.run_id = v_run_id
      AND esp.step_index = v_step_index
      AND esp.status = 'approved'
    ON CONFLICT (run_id, step_index, entity_name) DO NOTHING;

    UPDATE pipeline_runs SET
      current_step = v_next_step
    WHERE id = v_run_id;

    RETURN QUERY SELECT v_next_step AS next_step, FALSE AS run_completed;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Pipeline Metrics — lightweight execution metrics for observability
-- One row per entity job completion (success or failure).
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  submodule_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  status TEXT NOT NULL,              -- completed | failed | timeout
  duration_ms INTEGER NOT NULL,      -- Wall-clock execution time
  step_index INTEGER NOT NULL,
  cost TEXT,                         -- cheap | medium | expensive
  error TEXT,                        -- Error message if failed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_metrics_run_id ON pipeline_metrics(run_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_metrics_submodule_id ON pipeline_metrics(submodule_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_metrics_created_at ON pipeline_metrics(created_at);

-- ============================================================
-- Pre-Phase 12: Pool item blob storage
-- Stores large fields (content_markdown, analysis_json, etc.) by reference.
-- Pool items carry a _blob_ref UUID pointing to this table instead of inline content.
-- Hydrated on read by server/services/poolBlobs.js.
-- ============================================================
CREATE TABLE IF NOT EXISTS pool_item_blobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pool_item_blobs_created_at
  ON pool_item_blobs(created_at);

-- ============================================================
-- Phase 12a: Option presets
-- Per-submodule, per-option saved configurations.
-- project_id = NULL means global preset (visible everywhere).
-- ============================================================
CREATE TABLE IF NOT EXISTS option_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submodule_id TEXT NOT NULL,
  option_name TEXT NOT NULL,
  preset_name TEXT NOT NULL,
  preset_value JSONB NOT NULL,
  project_id UUID REFERENCES projects(id),
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Project-scoped presets: standard unique constraint
CREATE UNIQUE INDEX IF NOT EXISTS option_presets_project_unique
  ON option_presets (submodule_id, option_name, preset_name, project_id)
  WHERE project_id IS NOT NULL;

-- Global presets: separate partial index (PostgreSQL treats NULL != NULL in UNIQUE)
CREATE UNIQUE INDEX IF NOT EXISTS option_presets_global_unique
  ON option_presets (submodule_id, option_name, preset_name)
  WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_option_presets_submodule
  ON option_presets(submodule_id, option_name);

-- ============================================================
-- Phase 12b: Pipeline Templates
-- NOTE: Evolves existing templates table (not new pipeline_templates table)
-- to preserve projects.template_id FK and existing data.
-- A template defines a complete pipeline configuration: which submodules
-- to run, what presets to use, and what seed input to expect.
-- ============================================================
CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  preset_map JSONB DEFAULT '{}'::jsonb,
  -- { "submodule-id": { "preset_name": "my-preset", "fallback_values": { "system_prompt": "...", ... } } }
  execution_plan JSONB DEFAULT '{}'::jsonb,
  -- { "steps": [0,1,2,...], "skip_steps": [6,7], "submodules_per_step": { "1": ["sitemap-parser"] } }
  -- Metadata-only in 12b. Auto-execute uses this in 12c.
  seed_config JSONB DEFAULT '{"seed_type":"csv"}'::jsonb,
  -- { "seed_type": "csv"|"url"|"prompt", "required_columns": ["name","website"], "column_aliases": {} }
  -- Template column_aliases extend (not replace) the skeleton's built-in COLUMN_ALIASES.
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- DEPRECATED: Being migrated to templates.preset_map JSONB.
-- Kept during transition period. Will be dropped after 12b is verified end-to-end.
CREATE TABLE IF NOT EXISTS template_preset_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  submodule_id TEXT NOT NULL,
  option_name TEXT NOT NULL,
  preset_id UUID NOT NULL REFERENCES option_presets(id) ON DELETE RESTRICT,
  UNIQUE(template_id, submodule_id, option_name)
);

-- Template-level reference docs (copied to project on use)
CREATE TABLE IF NOT EXISTS template_reference_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text/plain',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(template_id, filename)
);

-- Wire projects.template_id FK (existing column, new constraint)
ALTER TABLE projects
  ADD CONSTRAINT fk_projects_template
  FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL;
