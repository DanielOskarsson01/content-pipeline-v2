# Live end-to-end gate — reproducibility notes

The pre-deploy flagship gate (`CONTENT_PIPELINE_MASTER_PLAN.md:297`) driven for real:
`executeRun` against a throwaway Supabase branch + local server/workers, only the LLM
provider stubbed. Proves the physical chain the seam tests (`43584f9`) mock. First run
2026-07-11. This note exists so the procedure isn't lost (the prior handoff note was).

## Artifacts (this dir / fixtures)
- `fixtures/live_dual_capability.execution_plan.json` — A + B + C + concurrency floor.
  Sibling of the seam fixture `dual_capability.execution_plan.json` (untouched). Capability B's
  round-2 submodule is **tone-seo-editor** (a real module), NOT the seam fixture's phantom
  `deep-research-writer` (no code in the modules repo) — B's property is *different + unplaced +
  round>1 dispatched*, not the module name.
- `fixtures/live_double_dispatch_probe.execution_plan.json` — the `cardGroups.js:202` D-probe
  (round-1 card placed BY UUID + routing-only round-2 card on the SAME submodule X).
- `llm_fetch_stub.mjs` — `--import` preload; patches `globalThis.fetch` for the 3 provider
  hosts only; returns citation-free Anthropic SSE (→ deterministic `citation:fail`). No product edit.

## Procedure
1. Supabase MCP: `get_cost`(branch) → confirm → `create_branch`. The branch applies the
   consolidated migration history (`supabase/migrations/`), so it comes up **schema-complete**
   (BACKLOG #17 empty-branch trap avoided — do NOT hand-bootstrap). Verify with `list_tables`
   (expect `entity_run_meta`, `entity_submodule_runs`, RPC `append_card_instruction(...,p_increment_loop_count)`).
2. `.env.branch` (scratchpad, NOT committed): `SUPABASE_URL`=branch ref, `SUPABASE_KEY`=anon
   (RLS off on the branch → anon has full access), `REDIS_PORT`=6399, `PORT`=3021, dummy
   `ANTHROPIC_API_KEY` (checked before the stubbed fetch). **Pre-flight assert the URL is the
   branch ref, never `fevxvwqjhndetktujeuu`.**
3. Seed per run: `templates.execution_plan` = the fixture (+ steps 6 `citation-coverage-checker`
   / 7 `loop-router` so the QA→routing loop runs); `projects`; `pipeline_runs` status=running;
   `pipeline_stages` 0-10 (0-4 `completed`, 5 `active`, rest `pending`); `entity_stage_pool` at
   step 5 per entity with a `source_submodule:'content-analyzer'` item (content-writer requires it);
   `entity_run_meta` per entity (`allEntities` derives from this — empty → nothing dispatches).
4. Launch (cwd = repo root): `redis-server --port 6399 --save "" --appendonly no --daemonize yes`,
   then for server.js + workers/stageWorker.js + workers/batchWorker.js:
   `DOTENV_CONFIG_PATH=<abs .env.branch> node --import ./server/tests/harness/llm_fetch_stub.mjs <entry>`.
5. Drive: `POST http://127.0.0.1:3021/api/runs/<runId>/auto-execute`. Assert on the branch DB.
6. Teardown: `delete_branch` → `list_branches` shows only `main`; kill node procs; `redis-cli -p 6399 shutdown nosave`.

## What the run proved (physical rows)
- **A** — content-writer li=0 `entity_submodule_runs.options` carries merged card-A overrides
  (`_cap_a_marker`, model=haiku, temperature=0.7) on the first pass via forwarded card_id.
- **B** — tone-seo-editor gets a real `entity_submodule_runs` row (card `…0b02`, loop_iteration 1);
  its output is stamped `source_submodule='tone-seo-editor'` into the step-6 pool the next QA reads.
- **C** — round exhausted → `entity_run_meta.terminal_state='flagged'`,
  `failure_reason='no_card_for_round'`, entity forwarded (run reaches step 10).
- **D** — the `:202` type-mismatch DOES emit a redundant round-2 dispatch (placed loop + unplaced
  pass both build a group for X/round-2 because `placed.has(submodule_name)` is false when the
  round-1 card is placed by UUID). Exactly ONE execution held **by design**:
  `checkExistingSubmoduleRun` (autoExecutor.js:679, key = stage_id + submodule_id + card_id +
  loop_iteration) skips the second dispatch ("already approved, skipping"); DB partial-unique
  indexes `idx_one_active_run_per_submodule_card` / `idx_entity_submodule_runs_one_active_card`
  are the concurrent-race backstop (`/run` catches 23505 → 409). NOT a live defect.

## Known floor
Worker concurrency = 2 (`stageWorker`), so the ≥3-entity concurrency check is a floor (W8), not a
proof: all 3 entities go through fail→round-2 in one batch with independent `loop_count` and rows,
but only 2 execute truly simultaneously.
