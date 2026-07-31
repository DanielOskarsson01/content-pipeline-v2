-- Workbench chaining (U8, CHAINING-SCOPE v1): parent_experiment_id on
-- workbench_experiments. Nullable, plain uuid, deliberately NO FK — matching
-- the table's no-FK convention on source_run_id (rows must survive deletion
-- of what they reference; a chained experiment outlives its parent).
ALTER TABLE workbench_experiments ADD COLUMN parent_experiment_id uuid;

COMMENT ON COLUMN workbench_experiments.parent_experiment_id IS
  'Chaining (U8): experiment whose output_data items were overlaid onto the frozen pool before this run. Plain uuid, deliberately NO FK (same convention as source_run_id) — a chained experiment must survive deletion of its parent row.';
