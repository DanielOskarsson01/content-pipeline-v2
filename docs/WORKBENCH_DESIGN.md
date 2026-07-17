# Submodule Workbench — Design & Honest Estimate

**Status:** design only, for review in the planning chat. No code written. No decision_log entry yet.
**Repo/branch/HEAD at authoring:** `content-pipeline-v2` @ `auto-21-w2-2026-06-25` @ `44bdfc7`, clean tree.
**Scope of this doc:** read-only investigation of the current code + a build plan. Nothing here is built.

---

## 0. The product requirement (verbatim intent)

> "I need to be able to go through, step by step, submodule by submodule. And not only change the docs, the model or prompt — other submodules have many other settings that might need changing. In the UI."

Concretely: pick a **completed run**, pick a **step**, pick a **submodule**, edit **any** of its options (the full manifest options surface — the same editor the template cards use), run **only that submodule** against the run's **frozen pool state** at that step, and see the new output **next to** the original. Iterate. No re-scrape, no full pipeline run, no terminal.

This is the tool Daniel uses to tune 40+ submodules across templates. It is **not** a developer harness. `scripts/run-submodule-once.js` exists and is **not** this (terminal-only, spec-file-driven).

**Rule 13 (design constraint, restated by Daniel):** the workbench knows steps, submodules, options, pools. It knows nothing about iGaming, companies, or any specific submodule. This is consistent with the repo's existing Architecture Rules 1–4 in `CLAUDE.md` ("No submodule-specific logic in this repo", "Skeleton renders slots, modules fill them").

---

## 1. What the six pieces actually look like today (verified, cited)

Every claim below was checked against the code on `44bdfc7`. Where the brief assumed a piece "mostly exists," the verdict is stated plainly.

### 1.1 Options editor — **exists, generic, reusable verbatim** ✅

[`SubmoduleOptions.tsx`](../client/src/components/primitives/SubmoduleOptions.tsx) is a pure controlled form with **zero template-card coupling**. Props ([SubmoduleOptions.tsx:10-16](../client/src/components/primitives/SubmoduleOptions.tsx#L10-L16)):

```ts
interface SubmoduleOptionsProps {
  options: SubmoduleOption[];              // the full manifest options[] array
  values: Record<string, unknown>;         // flat optionName -> value (sparse OK; falls back to option.default)
  onChange: (name: string, value: unknown) => void;   // flat scalar setter
  projectId: string;                       // only doc_selector / file_upload / presets use it
  submoduleId: string;                     // only preset load/save uses it
}
```

It renders one field per declared option, dispatched by `option.type` (`select`/`boolean`/`number`/`textarea`/`doc_selector`/`file_upload`/`json`/`text`). No `runId`, no `cardId`, no `step` anywhere in the file. It is **already reused pointed at three different backing stores**, none of them a template card in the coupled sense:

- Template card overrides — [`VariantPane.tsx:155-161`](../client/src/components/shared/VariantPane.tsx#L155-L161) (flat `localOverrides`, only 202 lines total — the closest analog to copy).
- Run saved config — [`SubmodulePanel.tsx:753-759`](../client/src/components/shared/SubmodulePanel.tsx#L753-L759), seeded `{ ...manifestDefaults, ...savedConfig.options }` ([SubmodulePanel.tsx:306-312](../client/src/components/shared/SubmodulePanel.tsx#L306-L312)).
- Detached preset map — [`TemplateEditor.tsx:394`](../client/src/components/pages/TemplateEditor.tsx#L394) with `projectId=""`, values from a JSONB object, no run and no card.

**Verdict:** point it at an ad-hoc config with **zero changes**. Feed it `manifest.options` + a flat `useState` seeded from `{ ...options_defaults, ...historicalRunConfig.options }` + an `onChange` + the real `projectId` + `submoduleId`. This is the single strongest reuse in the whole design.

### 1.2 Frozen pools — **exists, but it is a 3-table assembly, NOT one table** ⚠️

[`entity_stage_pool`](../supabase/migrations/20260421000000_baseline_core_schema.sql#L147-L158) holds per-`(run_id, step_index, entity_name)` state (unique index `idx_entity_stage_pool_unique` at [baseline:695]; no `submodule_id` dimension — the pool is shared state *between* submodules at a step):

```sql
CREATE TABLE entity_stage_pool (
  id uuid ..., run_id uuid NOT NULL, step_index integer NOT NULL,
  entity_name text NOT NULL, pool_items jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending', error text, retry_count integer, created_at, updated_at );
```

**The loud finding:** `pool_items` is **deliberately lean**. To reconstruct the exact input a submodule consumed at step N you need **three** sources, not one:

1. `entity_stage_pool.pool_items` — the skeleton, but downloadable fields (e.g. `text_content`) are **stripped out** after each run ([stageWorker.js:827-838](../server/workers/stageWorker.js#L827-L838)) and large fields are replaced with a `_blob_ref` UUID pointer.
2. `pool_item_blobs` — holds the large fields; hydrated back via `hydrateItems` ([poolBlobs.js:64](../server/services/poolBlobs.js#L64)).
3. `submodule_run_item_data` — holds the stripped downloadable fields; **re-enriched at run time** by stageWorker §7b (see 1.3).

So "freeze the pool" cannot mean "copy `entity_stage_pool` rows" — that yields a stripped skeleton with dangling pointers and missing `text_content`. The frozen input must be the **fully enriched/hydrated** items. This is sufficient to reconstruct the input **only** when all three are assembled — and it is (that is exactly what a normal run does at step N+1).

**Retention interaction:** the source run's `entity_stage_pool` and `submodule_run_item_data` are **swept at 7 days** once the run is terminal (see 1.5). Run `8801eb9e` survives only because it is pinned `status='archived'`.

### 1.3 Hydration — **inlined in stageWorker, already copied twice, NOT shared** ⚠️ (the mandated extraction)

The requires_columns enrichment ("§7b") that rebuilds `text_content`/`analysis_json`/`seo_plan_json` from `submodule_run_item_data` is **inlined inside `handleEntityJob`** ([stageWorker.js:504-672](../server/workers/stageWorker.js#L504-L672)) and **exported nowhere**. It reads upstream `entity_submodule_runs` for the entity, pulls the missing fields from `submodule_run_item_data`, sorts by `step_index` so later steps win, and merges by `url` / `entity_name`.

Only the blob-ref half ("§7c") is a shared function — `hydrateItems` ([stageWorker.js:674-680](../server/workers/stageWorker.js#L674-L680) → [poolBlobs.js:64](../server/services/poolBlobs.js#L64)).

The §7b logic **already exists in three un-shared places**, and the copies have drifted:

- Production original — [stageWorker.js:504-672](../server/workers/stageWorker.js#L504-L672) (inlined).
- Export copy — [`pool-to-spec.js:86-100`](/Users/danieloskarsson/dev/calibration-8801eb9e-export/pool-to-spec.js) reimplements it (imports only `db`, not any helper; `parseContent` is a verbatim re-copy) and is **already divergent** (fixed url-then-entity apply order vs stageWorker's primary-key-then-cross-key cascade).
- `run-submodule-once.js` does no §7b at all — it relies on the caller (pool-to-spec) having pre-hydrated the items.

**Verdict:** requirement #3 ("run server-side ONCE, shared — not copied a third time") is a **genuine prerequisite, not a given**. The fix is to extract §7b into one exported server function and have stageWorker, pool-to-spec, and the workbench all call it. This collapses three copies to one and stops the drift. It is root-cause work, not optional polish.

### 1.4 Dispatch — **a manual single-submodule path exists; autoExecutor is opt-in; execute is callable in isolation** ✅ (with a pollution caveat)

Three facts settle "smallest execution path that runs one submodule without a `pipeline_runs` row or the auto-executor":

- **A completed run already has its `pipeline_runs` / `pipeline_stages` rows** — the workbench reuses an existing run, it does not create one. Requirement #4's "without creating a pipeline_runs row" is satisfied by construction.
- **autoExecutor never wakes on its own.** It is a fire-and-forget `executeRun(runId, config)` invoked from exactly three explicit call sites ([server.js:213], [runs.js:1218], [runs.js:1294]). It is **not** a queue poller or DB trigger; it dispatches by HTTP POST to `/run` and polls. Nothing it does is triggered by a job appearing or a row being written. The workbench never calls `executeRun`, so autoExecutor stays asleep.
- **The pure execute contract is tiny and callable in isolation:** `executeFn(input, options, tools)` where `input = { entities:[{name,items}], run_id, step_index, submodule_id }`, `options = { ...manifest.options_defaults, ...overrides }`, `tools = { logger, http, progress, ai, _partialItems }`. Proven by [`run-submodule-once.js:181-191`](../scripts/run-submodule-once.js#L181-L191), which runs a submodule in-process touching **zero** DB tables, no queue, no autoExecutor.

The existing HTTP dispatch [`executeRouter.post('/run')`](../server/routes/submoduleRuns.js#L26-L782) is 80% of the backend logic (it already resolves input from the frozen `entity_stage_pool` at Priority 5, [submoduleRuns.js:221-240](../server/routes/submoduleRuns.js#L221-L240), and merges `{ ...options_defaults, ...savedConfig.options }` at [submoduleRuns.js:256](../server/routes/submoduleRuns.js#L256)). **But it is unusable as-is for the workbench because it mutates the run:** it upserts `run_submodule_config.options` ([submoduleRuns.js:264-272](../server/routes/submoduleRuns.js#L264-L272)), initializes/merges `entity_stage_pool`, and its approval path writes back to the pool. That violates "must not pollute entity_stage_pool or submodule_run_item_data for real runs."

**Why `stageWorker.handleEntityJob` cannot simply be reused:** it is a ~520-line function hard-wired to load input/options from a live `entity_submodule_runs` row and write status/output/pool back keyed on `run_id` — reusing it *is* the pollution. And `stageWorker` **cannot be imported in isolation** — it starts a live BullMQ Worker at module top-level ([stageWorker.js:942], `export default worker` at :984). That is precisely why `run-submodule-once.js` mirrors the AI orchestration instead of importing it ([run-submodule-once.js:12-14](../scripts/run-submodule-once.js#L12-L14)).

**Verdict:** the lazy-correct dispatch is **in-process direct execute** (the `run-submodule-once` shape), results written only to a new workbench table — not the `/run` endpoint, and not `handleEntityJob`. This keeps `handleEntityJob` untouched (zero pollution risk) and needs no "workbench mode" flag threaded through the worker + queue.

### 1.5 Results storage & retention — **no experiment table exists; a new one is safe by construction** ✅

There is **no** experiment/scratch/workbench/sandbox/tuning table anywhere (grepped migrations, `sql/`, server). It must be built.

Retention ([retention.js](../server/services/retention.js)) sweeps runs `status IN ('completed','halted','abandoned')` with `started_at < now-7d` ([retention.js:52-59](../server/services/retention.js#L52-L59)), cascading manually through a **hardcoded** `RUN_ID_TABLES` list ([retention.js:15-41](../server/services/retention.js#L15-L41)) plus `submodule_run_item_data` (joined via `submodule_runs.id`, [retention.js:74-95](../server/services/retention.js#L74-L95)). There is no DB `ON DELETE CASCADE` — the sweep is entirely list-driven.

Two consequences that shape the design:

1. **A new table is sweep-safe by default** — retention only touches the ~26 tables it names explicitly. A `workbench_experiments` table is never swept unless someone edits `RUN_ID_TABLES`. (Safety rule: do **not** add it to that list, and do not name it so a future maintainer is tempted to.)
2. **The source run's frozen pool + original outputs are NOT safe** — `entity_stage_pool` and `submodule_run_item_data` are in the sweep. If the source run ages out, the comparison target and the re-runnable pool vanish. **Mitigation: pin the source run `status='archived'`** (a one-line UPDATE; `status` is free text with no CHECK, [baseline:225] + [:652-664], which is exactly why `archived` dodges the sweep). Also snapshot the enriched input into the experiment row so an experiment stays reproducible even if the run is later swept.

**FK trap to avoid:** retention's final step is `delete pipeline_runs`. A workbench table with a NOT-NULL FK `run_id → pipeline_runs(id)` (no `ON DELETE SET NULL`) would FK-violate and **half-sweep** any aging run. So store `source_run_id` as a **plain uuid, no FK** (or FK with `ON DELETE SET NULL`).

**Cost visibility:** there is **no `ai_usage` table.** `ai_usage` is a JSONB sub-object `result.meta.ai_usage` (calls[], tokens_in/out_total, cache tokens) written by the exported pure function `applyAiCallMeta(result, aiCalls)` ([aiCallMeta.js:39-64](../server/utils/aiCallMeta.js#L39-L64)), riding inside `output_data`. On the real path stageWorker collects the per-call ledger in `buildTools` ([stageWorker.js:329-337](../server/workers/stageWorker.js#L329-L337)) and applies it at [stageWorker.js:880]. **`run-submodule-once` does NOT capture cost** — its tools never collect `_aiCalls`. So the workbench must collect `_aiCalls` and call `applyAiCallMeta` itself, then store `meta.ai_usage` in the experiment row. (`applyAiCallMeta` is already exported and pure — direct reuse.)

### 1.6 UI surface — **editor, execute mutation, polling, renderer all exist; one server endpoint is missing** ✅

- Route table is a flat list of `RootLayout` children ([router.tsx:38-54](../client/src/router.tsx#L38-L54)); a `/workbench` route drops straight in.
- The RUN mutation exists — `useExecuteSubmodule` ([useSubmoduleRuns.ts:51-58]) → `api.executeSubmodule` ([client.ts:118-123]); polling via `api.getSubmoduleRun`; original output via `api.getSubmoduleRunFull` (`?full=true`, reassembles `submodule_run_item_data` — [submoduleRuns.js:873-893](../server/routes/submoduleRuns.js#L873-L893)); manifests with full `options[]` via `api.getSubmodulesFull` ([client.ts:287-288]).
- Side-by-side needs **no renderer change** — mount **two [`ContentRenderer`](../client/src/components/primitives/ContentRenderer.tsx) instances** in two flex columns (original vs experiment); both share the submodule's `output_render_schema` so columns line up.
- **The one client-side gap** (matches 1.4): `api.executeSubmodule` runs against the run's **persisted** `run_submodule_config` — there is no call that takes **ad-hoc options in the body** and returns an **ephemeral** output without persisting. That endpoint is the only genuinely-new server surface the UI needs.

---

## 2. The design (lazy-correct architecture)

Data flow for one experiment:

```
[SubmoduleWorkbench view]
  pick run(archived) → step → submodule → entity
  edit options in <SubmoduleOptions/> (reused verbatim)
  RUN ──POST /api/workbench/experiments {source_run_id, step, submodule, entity, options}──►
        server:
          1. pin pipeline_runs.status='archived' for source_run_id (idempotent, protects from sweep)
          2. load entity_stage_pool.pool_items for (run, entity, step)
          3. hydrateFrozenInput()  ── shared §7b + hydrateItems (blobs)  →  enriched {name, items}
          4. runSubmoduleOnce({submodule_id, entity, options})  ── in-process, no queue/worker/pool writes
             collecting _aiCalls → applyAiCallMeta → meta.ai_usage
          5. INSERT workbench_experiments (source_run_id[no FK], step, submodule, entity,
                    resolved_config, frozen_input snapshot, output_data, ai_usage, created_at)
          6. return the row
  ◄── show experiment output in right column of side-by-side
      left column = original via api.getSubmoduleRunFull(original entity_submodule_run)
      experiment history list below, each row showing tokens/cost + resolved config (provenance)
```

Provenance (mandatory): every `workbench_experiments` row records `source_run_id`, `step`, `submodule`, `entity`, the **full resolved config**, `created_at`, and the `frozen_input` snapshot it ran against. An experiment that cannot say what produced it is not written.

Nothing here writes to `entity_stage_pool`, `submodule_run_item_data`, `submodule_runs`, `entity_submodule_runs`, `run_submodule_config`, or `pipeline_metrics`. Real-run data is read-only to the workbench.

---

## a. What exists and is reused

| Piece | Reuse | Location |
|---|---|---|
| Options editor (full manifest surface) | **verbatim, no change** | [SubmoduleOptions.tsx:10-16](../client/src/components/primitives/SubmoduleOptions.tsx#L10-L16) |
| Editor scaffold to copy (manifest lookup, flat overrides, sparse save) | copy the shape (202 lines) | [VariantPane.tsx](../client/src/components/shared/VariantPane.tsx) |
| Seed pattern `{...defaults, ...savedConfig.options}` | reuse | [SubmodulePanel.tsx:306-312](../client/src/components/shared/SubmodulePanel.tsx#L306-L312) |
| Side-by-side output rendering | two instances, no change | [ContentRenderer.tsx](../client/src/components/primitives/ContentRenderer.tsx) |
| Original output fetch (reassembles item_data) | reuse | `api.getSubmoduleRunFull` [client.ts:126-127], [submoduleRuns.js:873-893](../server/routes/submoduleRuns.js#L873-L893) |
| Manifests incl. full `options[]` | reuse | `api.getSubmodulesFull` [client.ts:287-288] |
| In-process single-submodule execute | reuse (hardened) | [run-submodule-once.js:159-191](../scripts/run-submodule-once.js#L159-L191) |
| Blob hydration | reuse | `hydrateItems` [poolBlobs.js:64](../server/services/poolBlobs.js#L64) |
| Cost/token capture | reuse (pure, exported) | `applyAiCallMeta` [aiCallMeta.js:39-64](../server/utils/aiCallMeta.js#L39-L64) |
| Model-param guards (Claude-5 temperature) | reuse | [aiModelParams.js](../server/lib/aiModelParams.js) |
| Prompt override resolution | reuse | `applyPromptOverride` [promptOverrides.js] |
| Route slot / QueryClient / header | reuse | [router.tsx:38-54](../client/src/router.tsx#L38-L54) |
| autoExecutor isolation | free — it is opt-in, never ambient | [autoExecutor.js:57], call sites only |

---

## b. What is genuinely new — build plan (each unit ≤1 day, ordered, independently shippable + testable)

**Unit 1 — Extract shared `hydrateFrozenInput()` (the mandated §7b un-copy).** New `server/services/poolHydration.js` exporting `hydrateRequiresColumns({ runId, entityName, stepIndex, items, manifest })`; refactor [stageWorker.js:504-672](../server/workers/stageWorker.js#L504-L672) to call it (pure move, no behavior change); wrap `hydrateItems` for blobs. *Ship:* pure refactor that collapses 3 copies to 1. *Test:* stageWorker regression (existing tests still green) + a unit test asserting the extracted function reproduces, field-for-field, the enriched input for one `(entity, step, submodule)` of run `8801eb9e` (compare against the already-generated `calibration-8801eb9e-export/specs/`). **~1 day** (touches the most intricate slice of `handleEntityJob`; the risk unit).

**Unit 2 — Harden the in-process execute into a server-owned harness.** Relocate `runSubmoduleOnce` to `server/services/submoduleHarness.js` (CLI keeps importing it); make its `tools.ai` collect an `_aiCalls` array like stageWorker does and call `applyAiCallMeta`; route model params through [aiModelParams.js](../server/lib/aiModelParams.js) so the Claude-5 temperature bug can't recur. *Ship:* fixes the existing harness (cost capture + temperature). *Test:* run one submodule, assert `result.meta.ai_usage.tokens_out_total > 0` and no `temperature` sent to Claude-5. **~0.5 day.** *(Leaves two ai-orchestrations — stageWorker's + this harness — flagged as deferred debt; a clean single `buildAiTools()` extraction from the Worker-on-import module is a bigger refactor, not v1.)*

**Unit 3 — `workbench_experiments` migration + thin DAO.** Table: `id, source_run_id uuid (NO FK), step_index, submodule_id, entity_name, resolved_config jsonb, frozen_input jsonb, output_data jsonb, ai_usage jsonb, status, error, created_at`. **Not** in `RUN_ID_TABLES`. *Ship:* migration applies. *Test:* insert + select round-trip; grep-assert the table name is absent from `retention.js`. **~0.5 day.**

**Unit 4 — `POST /api/workbench/experiments`.** Pin source run archived (idempotent) → load pool → `hydrateFrozenInput` (U1) → `runSubmoduleHarness` (U2) → `applyAiCallMeta` → insert (U3) → return row. *Ship:* backend usable via curl. *Test:* curl against run `8801eb9e`, one entity/step/submodule; assert a row is written, `entity_stage_pool`/`submodule_run_item_data` row-counts for that run are **unchanged**, and `run_submodule_config` is untouched. **~1 day.**

**Unit 5 — Read endpoints.** `GET /api/workbench/experiments?source_run_id=&step=&submodule=&entity=` (history) and `GET /api/workbench/original?...` (locate the original `entity_submodule_run` for `(run,entity,step,submodule)` and return via the existing full-output path). *Ship:* backend read API. *Test:* curl returns history + original. **~0.5 day.**

**Unit 6 — `SubmoduleWorkbench` React view + api/hooks.** New route ([router.tsx](../client/src/router.tsx)); run/step/submodule/entity pickers; embed `<SubmoduleOptions>` seeded `{...defaults, ...historicalConfig}`; RUN button → new `api.createWorkbenchExperiment` + `useCreateWorkbenchExperiment`. *Ship:* can run an experiment and see its output alone. *Test:* browser click-through end-to-end against `8801eb9e`. **~1 day.**

**Unit 7 — Side-by-side + history + cost.** Two `ContentRenderer` columns (original vs latest experiment); experiment history list with per-row tokens/cost and the resolved config (provenance surfaced); "run again" re-uses the editor state. *Ship:* the actual tuning loop. *Test:* browser — edit an option, RUN, confirm new output appears beside the unchanged original and cost shows. **~1 day.**

Dependency order: U1, U2, U3 are independent and parallelizable; U4 needs U1+U2+U3; U5 needs U3; U6 needs U4; U7 needs U5+U6.

---

## c. Honest total estimate

**~6 working days** for a shippable v1 (1 + 0.5 + 0.5 + 1 + 0.5 + 1 + 1 = 5.5, rounded up for integration + browser verification).

Honest range: **5 days** if Unit 1's extraction lands clean and stageWorker has no regressions; **7 days** if the §7b extraction surfaces subtle differences in the cross-key fallback cascade (the copies have already drifted once — see 1.3), which would need reconciliation before the workbench can trust its "frozen input." Units 1 and 2 are the two most likely to slip; everything downstream is conventional CRUD + reuse.

This is not softened. The UI is cheap because `SubmoduleOptions` and `ContentRenderer` are reused whole; the cost is entirely in the two server extractions (hydration + harness) that must be shared rather than copied a further time.

---

## d. Single riskiest assumption + cheapest test first

**Riskiest assumption:** that a re-hydrated frozen pool faithfully reproduces the exact input the submodule originally consumed — so the experiment's new output is genuinely comparable to the original. If §7b re-assembly diverges (it already has, between stageWorker and pool-to-spec — 1.3), or blob hydration is incomplete, Daniel tunes against a **phantom baseline**: the "before" and "after" differ because the *input* differs, not because his option change did anything. That silently corrupts every tuning decision the tool exists to make.

**Cheapest test, before building anything (~half a day, using assets that already exist):** run `8801eb9e` is already archived and already exported. For one `(entity, step, submodule)`, run the *extracted* `hydrateFrozenInput()` (Unit 1, built first) and assert the enriched items match — field for field (`text_content`, `analysis_json`, `seo_plan_json`) — what [`pool-to-spec.js`](/Users/danieloskarsson/dev/calibration-8801eb9e-export/pool-to-spec.js) already wrote into `calibration-8801eb9e-export/specs/`. This is a **pure-data equality check with no LLM nondeterminism**. If hydration is faithful, the whole premise holds and Unit 1 is de-risked before any UI exists. If it diverges, we learn it on day one for the price of one script — not after 6 days and a UI. (Second, cheaper-than-full-build check: re-run the submodule on that faithful input and confirm the output shape matches the original in `submodule_run_item_data`, accepting LLM nondeterminism on content.)

---

## e. Out of scope (so scope cannot creep silently)

- **Batch across entities** — v1 is one entity at a time. Multi-entity fan-out is v2.
- **Backward routing / downstream propagation** — the workbench runs exactly one submodule and shows its output. It does **not** feed the experiment output into step N+1 or re-run the rest of the pipeline.
- **Template writeback** — promoting a good experiment config back into a template card or `run_submodule_config` is deliberately excluded (tempting, and exactly the kind of write that would blur the read-only boundary). v1 is read-only on real-run data; the config lives only in the experiment row.
- **Editing the frozen input** — only *options* are editable in v1. The pool items themselves are the frozen baseline; changing them would defeat the comparison.
- **Re-scrape / live data refresh** — never. The pool is frozen by definition.
- **Output diffing/merging** — v1 shows outputs side by side; no automatic diff, merge, or scoring.
- **Cross-run comparison** — comparing experiments from different source runs is out.
- **Auth/permissions** — single-user tool; no access control.
- **Clean single `buildAiTools()` extraction from stageWorker** — v1 rides the hardened harness (Unit 2) and accepts two ai-orchestration copies as tracked debt; unifying them (the Worker-on-import refactor) is a separate effort.
