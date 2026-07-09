# Item #47 — Step-10-approval → Step-9 `execute` trigger + `terminal_state` readability — DESIGN

> **STATUS: DESIGN ONLY — DO NOT BUILD. Review gate before any implementation.**
> Master plan: Phase 5 → Unit 5.1 (U1 skeleton-gaps track, `phase5-skeleton-gaps`). Produced per PROMPT B: "#47 … DESIGN FIRST, do not build blind. Produce the design … report it, and STOP for review before implementing." Closes BACKLOG **#9** (distribution gate) and extends **#8** (quality signals to Step 8).
> **Grounding:** `content-pipeline-specs/UNIT_2_1_INVESTIGATION.md` §5.3A (the seam is unbuilt; one execute path; file-coordination caveat), `runs.js` approve handler, Step-9 delivery briefs (`content-pipeline-modules-v2/docs/submodule-briefs-rev-2026-07-03/step9-*.md`). Line numbers are against `phase5-skeleton-gaps` unless noted; the routing-branch citations match branch `auto-21-w2-2026-06-25` in the 2.1 report and are re-confirmed here.

---

## 1. The gap (two coupled halves)

**#47 is two skeleton gaps that must land together, because each is useless without the other:**

1. **No Step-10-approval → Step-9 `execute` trigger.** Steps run 0→10 via the single execute path (`autoExecutor.processStep → resolveStepEntries → expandCardGroups → triggerSubmodule`, 2.1 §5.3A.1). There is **no** mechanism by which the human publish decision at Step 10 kicks off the actual Step-9 send. Grep of `runs.js` for such a trigger finds none; the only terminal-state gating that exists is the **Step-8 forward select** (`runs.js:490-494`, `terminal_state IS NOT NULL`), and the approve handler's only routing hook is `applyRouting` on `routing_pending` (`runs.js:448,483`) — 2.1 §5.3A.3.

2. **`terminal_state` is unreadable by modules.** `entity_run_meta.terminal_state` is set by `routingHandler.applyRouting` (`approved` / `flagged` / `failed`) but lives **only** in `entity_run_meta`. It is **never** stamped onto the `entity_stage_pool.pool_items` the modules consume (verified: `grep terminal_state` in `stageWorker.js` = 0 hits; the module input is `entityRun.input_data`, `stageWorker.js:411`). The Step-9 delivery briefs **require** it on the items: their `flag_conditions` default to `["terminal_state=flagged","qa_pass=false","needs_review=true"]` and are "evaluated against the entity's pool items at stage time" (`step9-strapi-publisher.md:23`, `step9-google-docs-exporter.md:15`, `step9-google-sheets-logger.md:21`). Today those checks silently see `undefined` for `terminal_state` → flagged content is **not** recognized as flagged → the fail-closed default cannot fire.

The module side of the fail-closed contract is **already specified and owned by the modules track** (stage/execute modes; `staged_status ∈ {ready, held_flagged, invalid}`; `flagged_policy` default `hold`; execute NEVER sends `held_flagged`; `flagged_policy=include` is the only, explicit override — `step9-strapi-publisher.md:20-23`). This design covers **only the skeleton's two obligations** that make that contract executable.

---

## 2. The stage/execute split (the model the trigger implements)

The delivery briefs are built around a two-phase split; the skeleton must drive both phases:

| Phase | When | Mode | Network I/O | Produces |
|---|---|---|---|---|
| **STAGE** | Automated forward pass (after Step-8 bundle, before the Step-10 human gate) | `mode: stage` | **none** (write-side); optional auth-scoped GET only | per-item `staged_payload`, `target`, `staged_status`, `validation` — a *preview of what would be sent*, with flagged entities already marked `held_flagged` |
| **EXECUTE** | **Triggered by the Step-10 human publish approval** | `mode: execute` | the real send (create/update entry, upload file, upsert row) | `publish_status` / `remote_url` / `upsert_status`; **never sends `held_flagged`** |

So numeric order is preserved on the forward pass (…8 → 9-stage → 10), and the **execute** of Step 9 is a *deliberate out-of-numeric-order re-trigger* fired by the Step-10 decision. Stage is side-effect-free, so a human reviews concrete staged payloads at Step 10 before anything leaves the system.

---

## 3. Skeleton deliverable A — propagate quality signals onto pool items

**Goal:** every downstream pool item an entity carries into Steps 8–9 exposes that entity's quality verdict, so both Step-8 bundlers (#8) and Step-9 delivery modules (#9) can read it as ordinary item fields (no `entity_run_meta` access from module code — modules never touch the DB, Rule 2).

**Fields to stamp onto each `pool_items[*]` (namespaced to avoid clobbering module fields):**
- `terminal_state` (`approved` | `flagged` | `failed` | absent-if-no-routing)
- `needs_review` (`"true"`/`"false"` string, per ContentRenderer's `flagged_when` string convention)
- `qa_pass` and `last_qa_scores` (from the QA step's `entity_run_meta` / QA output) — extends #8

**Where:** at the point terminal entities are forwarded out of the routing step — the routing branch already reads `entity_run_meta` for exactly these rows:
- `runs.js:490-494` already selects `entity_name, terminal_state … WHERE terminal_state IS NOT NULL`.
- `runs.js:506-512` forwards each `pool.pool_items` unchanged to `nextStep`.
- **Change:** between the read and the upsert, map `terminal_state` (+ QA signals) onto every item of that entity's `pool_items` before the forward upsert. Same treatment for the non-routing forward at `runs.js:563-585` when `entity_run_meta` rows exist.

**Ownership:** `runs.js` is **not** a Phase-2-owned file and **not** `autoExecutor.js` → editable by this track. No pool schema change (pool_items is JSON; adding fields is additive). **Fail-open risk to note:** for pipelines with no Step-7 routing, `terminal_state` is `null`; the module's other two default conditions (`qa_pass=false`, `needs_review=true`) still gate, provided QA fields survive forwarding — a template without QA + without routing publishes everything, which is the correct "no gate configured ⇒ no hold" behavior and must be documented, not silently patched.

---

## 4. Skeleton deliverable B — the Step-10 → Step-9 execute trigger

**Trigger point:** the human publish decision at Step 10. Two shapes considered:

- **B1 (recommended): a dedicated `POST /api/runs/:runId/publish` (or `…/steps/10/publish`) endpoint** carrying the per-entity human decision (`publish` | `save` | `skip`). Step 10 is a *decision*, not a plain step-approval — only `publish` triggers execute; `save`/`skip` do not. A dedicated verb keeps that semantic explicit and keeps the plain `approve` handler unchanged.
- **B2: a branch inside the existing Step-10 `approve` handler.** Smaller surface but overloads "approve" with "publish," and the current approve handler has no per-entity decision input. Rejected as the primary; noted as a fallback.

**Execute mechanism (this is the file-coordination-sensitive choice):**

- **B-exec-1 (recommended, LOW coordination): re-trigger Step-9 submodules via the existing per-submodule execute route** (`submoduleRuns.js` `POST …/run`), passing `options.mode = 'execute'` and the approved-entity set. This reuses the one execute path **without touching `autoExecutor.js`**. `submoduleRuns.js` assembles the run's `options` (merge of manifest defaults + run options, cf. `stageWorker.js:412`) — adding a `mode` option there is a `submoduleRuns.js`-local change. `submoduleRuns.js` is **not** Phase-2-owned.
- **B-exec-2 (needs coordination): `executeRun(runId, {steps:[9], mode:'execute', …})`** threading a `mode` into the submodule-run options inside `autoExecutor`. 2.1 §5.3A.1 names this ("an execute-mode invocation of `processStep`"). **BUT `autoExecutor.js` is the SHARED file Phase 2 is rewriting** (`resolveStepEntries`/card-scoped grouping). Threading `mode` does **not** require editing `resolveStepEntries`/`resolveCards`/`cardGroups` (2.1 §5.3A.2: delivery is card-less, hits the legacy branch unchanged) — but it **does** touch `autoExecutor.js`. Per PROMPT B's file-coordination rule this is a **STOP-AND-REPORT** before any edit. **Recommendation: prefer B-exec-1 to keep U1 off `autoExecutor.js` entirely**, matching 2.1's severability condition (i): "U1 does not itself edit `resolveStepEntries`/`resolveCards`/`cardGroups`."

**Mode plumbing:** the skeleton passes `mode` as a run **option**; the module reads `options.mode` (module-side contract, already in the briefs). No manifest schema change on the skeleton side — `mode` is just another option value. On the forward pass Step 9 runs with `mode` defaulting to `stage`; the trigger re-runs with `mode: execute`.

**Skeleton-side gate (defense in depth, on top of the module's own fail-closed):**
- The trigger builds the execute-set from entities that are BOTH (a) human-approved-to-publish at Step 10 AND (b) `entity_run_meta.terminal_state = 'approved'`. Flagged/failed entities are never included in the execute-set regardless of the module's policy. Two independent gates: **skeleton** (never dispatches a flagged entity to execute) + **module** (`held_flagged` never sent even if dispatched). Either alone fails safe; both is the design.

---

## 5. What this touches / what it must NOT touch (file-coordination, #42)

| File | Track2 may edit? | Note |
|---|---|---|
| `server/routes/runs.js` | ✅ | new trigger endpoint/branch + deliverable-A stamping in the forward paths |
| `server/routes/submoduleRuns.js` | ✅ | thread `mode` into run options (B-exec-1) |
| `server/services/autoExecutor.js` | ⚠️ **STOP-AND-REPORT** | SHARED. Only if B-exec-2 is chosen; avoid by using B-exec-1 |
| `executionPlanUtils.js`, `routingHandler.js`, `cardPlanEditor.ts`, `types/step.ts`, `cardGroups.js`, card-model client UI | ❌ **STOP-AND-REPORT** | Phase-2-owned. This design requires **none** of them |
| pool / DB schema | ✅ (additive only) | `pool_items` is JSON; new fields are additive. No DDL |

The design is deliberately steered onto `runs.js` + `submoduleRuns.js` (both track-2-editable) and **off** the Phase-2 surface, honoring 2.1's severability verdict (parallelizable, gated on file-coordination not redesign).

---

## 6. Open questions for the review gate (decide before implementing)

1. **Trigger shape B1 vs B2** — dedicated `/publish` verb (recommended) vs a branch in the Step-10 approve handler. Ties into whether Step 10 carries a per-entity `publish|save|skip` decision (it does not today).
2. **Execute mechanism B-exec-1 vs B-exec-2** — recommended B-exec-1 (no `autoExecutor.js` edit). If the reviewer wants B-exec-2, that is a **STOP-AND-REPORT** on `autoExecutor.js` and must be coordinated with the Phase-2 thread.
3. **Re-run vs mutate-in-place for execute** — does `mode: execute` create a *new* Step-9 submodule_run (clean audit trail; my lean) or update the stage run's rows in place? Affects idempotency + the pool's last-writer semantics (BACKLOG #26).
4. **QA-signal source for deliverable A** — `qa_pass`/`last_qa_scores` origin: read from `entity_run_meta`, or from the Step-6 QA submodule output already on the pool items? Determines whether #8 is fully closed here or only `terminal_state` is.
5. **No-routing pipelines** — confirm the intended behavior when `terminal_state` is `null` (no Step-7): gate on `qa_pass`/`needs_review` only; document "no gate configured ⇒ publishes" as intentional, not a bug.
6. **Idempotency of execute** — a double publish (human clicks twice, or retry) must not double-send. The briefs define provider `id_lookup` upsert (`step9-strapi-publisher.md:27`); the skeleton trigger should also guard against concurrent execute dispatch for the same run/step.
7. **Interaction with #45 (this unit)** — cms-publisher execute for Strapi/Ghost/Contentful needs PUT, now delivered by #45 (`03d1b7c`). No blocker remains there; confirm the execute design assumes PUT/PATCH available.

---

## 7. Why this is not built in Unit 5.1

Per PROMPT B: #47 "touches the execute surface Phase 2 is rewriting" and is "the U1 critical path." Building it blind risks (a) an `autoExecutor.js` collision with the concurrent v6 rework (#42), and (b) committing to a trigger/execute shape before the review gate picks B1/B2 and B-exec-1/B-exec-2. Deliverable A (pool-item stamping in `runs.js`) is low-risk and could ship first once the review confirms the field set; deliverable B waits on the mechanism decision. **Recommendation: review this design, pick options for Q1–Q7, then implement A first (isolated, `runs.js`-only), then B via B-exec-1 (submoduleRuns route, no `autoExecutor.js` edit).**
