-- A3 (PHASE-A-WORKBENCH): derived metrics on every experiment row, so
-- comparing two arms is readable from the rows alone. Additive, nullable,
-- no FK; computed at insert by server/lib/experimentMetrics.js. Fields that
-- don't apply to a submodule are null, not zero.
--
-- workbench_experiments stays OUTSIDE retention's RUN_ID_TABLES (retention.js)
-- — this migration must never come with a retention change.
ALTER TABLE workbench_experiments ADD COLUMN IF NOT EXISTS metrics jsonb;

COMMENT ON COLUMN workbench_experiments.metrics IS
  'A3 derived metrics (words, h2_sections, thin_sections, has_h1, marker_leak_headings, dup_token_headings, distinct_citations, max_citation_n, broken_refs, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, stop_reason, duration_ms, cost_usd) — display heuristics computed from the experiment''s own output at insert; never re-runs checkers; null = not applicable.';
