-- Content Pipeline v2 — Database Schema
-- Phase 2: Core pipeline tables

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  timing TEXT,
  template_id UUID,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pipeline Runs — one execution of a project through the 11-step sequence
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL DEFAULT 'running',
  current_step INTEGER NOT NULL DEFAULT 0,
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
  working_pool JSONB,
  working_pool_render_schema JSONB,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(run_id, step_index)
);

-- Phase 7: Submodule runs — one execution of one submodule within a step
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
