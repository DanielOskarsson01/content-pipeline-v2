-- Workbench experiments (WORKBENCH_DESIGN.md §b Unit 3).
--
-- source_run_id is a PLAIN uuid — deliberately NO foreign key to pipeline_runs:
-- experiments must survive deletion of their source run (retention sweeps
-- terminal runs at 7 days; an experiment's provenance record outlives that).
-- For the same reason this table must NEVER be added to retention.js
-- RUN_ID_TABLES.
CREATE TABLE workbench_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  source_run_id uuid NOT NULL,
  step_index integer NOT NULL,
  submodule_id text NOT NULL,
  entity_name text NOT NULL,
  -- the ad-hoc per-call overrides the caller supplied (the workbench edit surface)
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- the FULL options object the submodule actually executed with
  -- (manifest defaults <- run_submodule_config <- overrides, docs expanded)
  resolved_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- the hydrated pool items the run consumed (§7b + §7c reconstruction)
  frozen_input jsonb,
  -- the per-entity module result ({items, meta, ...})
  output_data jsonb,
  -- meta.ai_usage copy: per-call tokens/stop_reason + totals (cost basis)
  ai_usage jsonb,
  duration_ms integer,
  status text NOT NULL DEFAULT 'completed',
  error text
);

CREATE INDEX idx_workbench_experiments_lookup
  ON workbench_experiments (source_run_id, step_index, submodule_id, entity_name, created_at DESC);

COMMENT ON TABLE workbench_experiments IS
  'Workbench replay experiments (WORKBENCH_DESIGN.md U3). source_run_id has NO FK and this table must never enter retention RUN_ID_TABLES — experiments outlive their source run.';
