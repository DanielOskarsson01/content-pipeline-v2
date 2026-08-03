-- Tuning sessions (TUNING-SESSIONS v1, T1).
--
-- Holds "for run R, entity E, the accepted experiment at each step" — the loop
-- between one-off workbench experiments (workbench_experiments) and template
-- promotion.
--
-- Like workbench_experiments, these tables carry PLAIN uuids with NO foreign key
-- to pipeline_runs or workbench_experiments: a tuning session and its accepted
-- markers must survive deletion of their source run (retention sweeps terminal
-- runs at 7 days) and of any experiment. For the same reason these tables must
-- NEVER be added to retention.js RUN_ID_TABLES.
--
-- Erasing a session's downstream steps (see tuningSessions.js acceptExperiment)
-- deletes rows in tuning_session_steps ONLY — it never deletes
-- workbench_experiments, which are the durable, queryable log (decision 2).

CREATE TABLE tuning_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  source_run_id uuid NOT NULL,          -- plain uuid, NO FK (survive run deletion)
  entity_name   text NOT NULL,
  -- one live tuning chain per (run, entity): decision 1, "one live chain per session"
  UNIQUE (source_run_id, entity_name)
);

CREATE TABLE tuning_session_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES tuning_sessions(id) ON DELETE CASCADE,
  step_index    integer NOT NULL,
  experiment_id uuid NOT NULL,          -- plain uuid, NO FK to workbench_experiments
  submodule_id  text NOT NULL,
  accepted_at   timestamptz NOT NULL DEFAULT now(),
  -- one accepted experiment per step within a session (re-accept replaces it).
  -- This UNIQUE also serves every (session_id) and (session_id, step_index)
  -- lookup + the step-ordered read, so no separate index is needed.
  UNIQUE (session_id, step_index)
);

COMMENT ON TABLE tuning_sessions IS
  'Tuning sessions (TUNING-SESSIONS v1 T1). source_run_id has NO FK and this table must never enter retention RUN_ID_TABLES — a session outlives its source run. One live chain per (run, entity).';
COMMENT ON TABLE tuning_session_steps IS
  'Accepted experiment per step within a tuning session. experiment_id has NO FK to workbench_experiments (the durable log outlives sessions). Accepting at step N erases rows with step_index > N (session-only; never deletes workbench_experiments).';
