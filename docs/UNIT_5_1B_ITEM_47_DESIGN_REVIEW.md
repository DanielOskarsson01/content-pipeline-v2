# Unit 5.1b — Item #47 Design Review Gate — VERDICT

> **STATUS: DESIGN REVIEW ONLY — #47 IS NOT BUILT. No code wired, no merge, no deploy.**
> Reviews `docs/UNIT_5_1_ITEM_47_STEP10_STEP9_TRIGGER_DESIGN.md` (design commit `63b8920`, now rebased as `6dfa89e` on `phase5-skeleton-gaps` atop reconciled main `8d4de22`).
> **Grounding re-verified against the current tree (Pattern B.1 code-path trace, not the design's pre-rebase line numbers):** `server/routes/runs.js` approve→routing→reopen flow (`:448-595`), `server/services/autoExecutor.js` routing-loop/re-entry (`:400-490`), `server/routes/submoduleRuns.js` execute route + imports, `sql/migration_routing.sql` `entity_run_meta` columns, `server/lib/httpTools.js` (`createHttp` verbs).
> **Corrected surface applied:** `content-pipeline-specs/UNIT_2_1_INVESTIGATION_ADDENDUM.md` (`3e53d45`) **Delta 4** — the acute Phase-2 shared surface is the **approve→routing→reopen control flow** (`runs.js:448-595` / `autoExecutor.js:400-490`), NOT `resolveStepEntries`.

---

## Bottom line

The design is **architecturally sound and correctly steered off the Phase-2-owned files**. B-exec-1 genuinely avoids `autoExecutor.js` (verified). But three things must be fixed/sequenced before build:

1. **CF-1 (HIGH, Part A):** Deliverable A's stamping in the **routing-forward** path lands *inside* the `runs.js:448-595` block that v6 inverts. File-ownership-safe, **region-coupled**. Per Delta 4 its **code wiring waits for / coordinates with Phase 3**; design finalizes now.
2. **CF-3 (MEDIUM, fail-closed):** The two gates are independent **only on the `terminal_state` axis**. On `qa_pass`/`needs_review` there is a **single** (module) layer that depends on Deliverable A. And §4's *inclusion* gate (`terminal_state = 'approved'`) **contradicts** §3/Q5 for no-routing pipelines (would publish **nothing**, not everything). Fix: make the skeleton gate an **exclusion** filter.
3. **Q4 gap:** `qa_pass` is **not a stored column**; it must be derived and given an owner before #8 fully closes.

Recommended sequencing: **finalize this design now → build the modules-side readability + the non-routing-forward slice of Deliverable A now → hold the routing-forward stamping and the Deliverable-B trigger wiring until Phase 3's v6 inversion of `runs.js:448-595` lands.**

---

## Answers to the 7 open questions

### Q1 — Trigger shape: **B1 (dedicated `POST /api/runs/:runId/publish`)** ✅ recommend
Two reasons, one of them new:
- **Semantic:** Step 10 is a *decision* (`publish|save|skip`), not a plain step-approval, and the current approve handler carries no per-entity decision input (verified: the approve handler takes `stepIndex`/counts, not per-entity verdicts — `runs.js:296+`). Only `publish` fires execute.
- **File-coordination (new, from Delta 4):** B2 would weave the trigger *into* the `routing_pending`/last-step branch inside `runs.js:448-595` — the exact block v6 inverts. **B1 as a standalone handler lives outside that block**, minimizing merge collision with Phase 2. So B1 is not just cleaner, it is the coordination-safer choice. Place the new endpoint as its own handler; do **not** branch it inside the routing block.

### Q2 — Execute mechanism: **B-exec-1 (re-trigger via `submoduleRuns.js POST …/run` with `options.mode='execute'`)** ✅ recommend
**Verified severable:** `submoduleRuns.js` does **not** import `autoExecutor` (imports are `express`, `db`, `moduleLoader`, `queue`→`enqueueEntityBatch`, `applyDataOperation`, `resolveBatchLoopIteration`; the 3 "autoExecutor" hits are comments). The route dispatches directly via `enqueueEntityBatch` (BullMQ FlowProducer, `submoduleRuns.js:746`) → batchWorker → stageWorker — it never traverses `autoExecutor.processStep`. Adding a `mode` option is a `submoduleRuns.js`-local, additive change; `submoduleRuns.js` is not Phase-2-owned.
**B-exec-2 is a STOP-AND-REPORT** (edits `autoExecutor.js`) and collides head-on with Phase 2's v6.1 executor-dispatch path. Do not pursue it. (See CF-2 for the one soft coordination note on the shared `/run` contract.)

### Q3 — Re-run vs mutate-in-place: **new Step-9 `submodule_run` for `mode:execute`** ✅ recommend
- Matches the **append-only** model the codebase just adopted in Section C (`runs.js:541`: "append-only model needs Round-1 rows preserved + Round-2 appended"). Mutating the stage run in place fights that grain.
- Preserves the **stage preview the human just reviewed at Step 10** as durable provenance (mutate-in-place destroys the evidence the publish decision was based on — a C.4 failure-visibility concern).
- Cleaner **idempotency** guard (Q6): "does an execute-mode run already exist for this run/step?" is a row-existence check, trivial with a distinct run.
- Avoids **BACKLOG #26** pool last-writer clobber: an execute run writing back over the stage preview on the pool is a real risk with mutate-in-place.

### Q4 — QA-signal source for Deliverable A: **stamp `terminal_state` + `last_qa_scores` from `entity_run_meta`; give `qa_pass` an explicit owner** ⚠️ partial
Verified `entity_run_meta` columns (`migration_routing.sql:10`): `terminal_state`, `last_qa_scores JSONB`, `qa_score_history`, `failure_reason` **exist** — so stamp `terminal_state` + `last_qa_scores` from the **same** `entity_run_meta` read the forward already does (`runs.js:490-494`). Minimal, single-source, survives pool transforms.
**But there is no `qa_pass` boolean column.** `qa_pass` is a *derived* verdict (scores vs QA thresholds, which live in `execution_plan`/`routing_rules` and are evaluated in `routingHandler.resolveCards`). Decision required: **derive `qa_pass` once, in the skeleton, from the same threshold source `routingHandler` uses** — do **not** let each Step-9 module re-derive it from `last_qa_scores` (that duplicates threshold logic across modules and violates "skeleton enforces the contract at the boundary"). Likewise `needs_review` most naturally derives from `terminal_state==='flagged'`.
**#8 status:** the *readability* half (terminal_state + last_qa_scores on items) closes here; **#8 is not fully closed until `qa_pass`'s owner is decided.**

### Q5 — No-routing pipelines: **confirmed intent (gate on `qa_pass`/`needs_review` only; "no gate ⇒ publishes on human approval")** — but it exposes a design contradiction (see CF-3)
Intent is correct: with no Step-7, `terminal_state` is NULL and the hold must fall to the QA signals; a template with neither routing nor QA publishing everything is the correct "no gate configured ⇒ no hold" behavior, to be **documented, not silently patched** (matches design §3). **However**, §4's skeleton gate as written *requires* `terminal_state='approved'`, which is **false for every entity in a no-routing run** (NULL ≠ 'approved') → it would publish **nothing**. This directly contradicts §3/Q5. **Must be resolved** — see CF-3's exclusion-filter fix, which is what makes Q5's intent actually hold.

### Q6 — Idempotency of execute: **state-based dispatch guard + provider `id_lookup` upsert** ✅
- **Skeleton guard:** before dispatching `mode:execute` for `(run, step-9 submodule)`, check no execute-mode `submodule_run` for that tuple is already `pending`/`running` (row-existence, enabled by Q3's new-run choice). Refuse/return-existing on a double click or retry.
- **Provider guard:** the briefs' `id_lookup` upsert (`step9-strapi-publisher.md:27`) makes the destination write idempotent — second layer.
- **Note (Delta 1 lesson):** guard on **state** (does an execute run exist), not on a **counter**. The #29 specimen was exactly "a counter advanced without the corresponding re-execution." B-exec-1 dispatches *outside* `autoExecutor`'s do-while loop (`autoExecutor.js:476`), so the routing loop cannot re-fire execute — the trigger is human-initiated and one-shot.

### Q7 — Interaction with #45: **no blocker; PUT/PATCH confirmed available** ✅
Verified `server/lib/httpTools.js` `createHttp` exposes `get, head, post, put, patch` (`:100-118`); it's on this branch (rebased `32b62aa`, 42/42 tests green). Modules reach it via `tools.http`, so cms-publisher execute (Strapi/Ghost/Contentful PUT/PATCH) is covered. The execute design may assume PUT/PATCH present.

---

## Coordination findings

### CF-1 — Deliverable A's routing-forward stamping is inside the v6-inverted block (HIGH) — Part A pressure-test
**Is `runs.js` genuinely Phase-2-safe? Partially — file yes, region no.** The design (§3/§5) is correct that `runs.js` is **not** a Phase-2-*owned* file. But Addendum **Delta 4** relocates the coupling from file-ownership to **control-flow region**: the acute shared surface is the **approve→routing→reopen flow at `runs.js:448-595`**, which v6 heavily rewrites (engine inversion, `earliest_step` semantics, #28 reopen).
Traced in the current tree, Deliverable A stamps at the **`all_terminal` routing-forward** (`runs.js:486-531`: read `entity_run_meta` `:490-494` → forward `pool_items` `:506-512`) and touches the **#28 reopen** region (`:533-584`). **These are inside `448-595`.** Delta 4's explicit verdict: *"Part A CODE WIRING … keep sequenced with/after Phase 3 … because it lands in the same approve→routing→reopen block v6 inverts."*
**→ Finding:** Deliverable A's **routing-path** code wiring is **not** Phase-2-safe to land now; rebasing new stamping onto a freshly-inverted routing loop is the real merge/regression risk. **Design may finalize now.**
**→ Refinement (partial severability):** Deliverable A also has a **non-routing / general-forward** stamping site *outside* the routing block (the `nextStep` input_data path, `runs.js:613-651`, and the skip path `:674+`). That slice **is** severable and can ship now. Split Deliverable A: non-routing slice now; **routing-forward slice waits for / coordinates with Phase 3.**

### CF-2 — B-exec-1 avoids `autoExecutor.js`, with one soft note (LOW) — Part B pressure-test
**Confirmed avoids.** `submoduleRuns.js` has no `autoExecutor` import and dispatches via `enqueueEntityBatch`; the `mode` option is additive; the file is not Phase-2-owned. Even though Phase 2 is adding an executor-dispatch path *in* `autoExecutor.js` (v6.1), B-exec-1 neither edits nor traverses it.
**Soft note (not a blocker):** the `submoduleRuns.js POST …/run` route is **shared execution surface** — the normal auto-executor forward pass also drives it (`submoduleRuns.js:302` comment: `runs.js → autoExecutor → cardGroups.js → batchWorker → /run with cardId`). If v6.1 changes that route's option-merge or `cardId` contract, the `options.mode` passthrough should be re-checked. LOW risk (additive, orthogonal to `cardId`), but coordinate the contract, not just the file.

### CF-3 — Fail-closed is defense-in-depth on ONE axis only; and the skeleton gate contradicts the no-routing case (MEDIUM) — fail-closed pressure-test
**Does one layer silently depend on the other? Yes, on the QA axes.**
- **`terminal_state` axis — genuinely independent (defense-in-depth holds):** the **skeleton** gate reads `entity_run_meta.terminal_state` directly from the DB (independent of pool-item stamping) and excludes flagged/failed entities; the **module** gate independently marks `held_flagged` at stage time and never sends it. A flagged entity is double-protected.
- **`qa_pass` / `needs_review` axes — single layer, not independent:** the **skeleton** gate checks *only* `terminal_state`. The **only** thing holding a low-QA-but-not-routing-flagged entity is the **module** gate, and that gate can only see `qa_pass`/`needs_review` **because Deliverable A stamped them**. If Deliverable A is absent/broken/degraded (e.g., no-routing + QA fields not surviving forward — the §3 fail-open path), the module gate silently sees `undefined` → treats items as `ready` → publishes. There is **no second layer** here. The design's §4 claim *"either alone fails safe"* is **only true on the `terminal_state` axis.**
- **Plus the no-routing contradiction (from Q5):** §4's gate is an **inclusion** filter (`terminal_state='approved'`), which for NULL (no-routing) publishes **nothing** — contradicting §3/Q5's publishes-everything intent.
**→ Fix (resolves both halves):** restate the skeleton gate as an **exclusion** filter — dispatch entity iff *human-approved-to-publish* **AND** `terminal_state NOT IN ('flagged','failed')` (NULL passes). This (a) lets no-routing entities publish on the human decision (Q5 intent), (b) keeps the flagged/failed defense-in-depth. **Optionally**, for true cross-axis independence, add `qa_pass=false`/`needs_review=true` to the **skeleton** exclusion too — then the skeleton gate no longer silently depends on Deliverable A for the QA axes. At minimum, **document** that on the QA axes the guarantee is single-layer and contingent on Deliverable A.

---

## Do-NOT-touch confirmation (file-coordination #42)
This review **wrote one file** (`docs/UNIT_5_1B_ITEM_47_DESIGN_REVIEW.md`). Zero Phase-2-owned files touched (`executionPlanUtils.js`, `routingHandler.js`, `cardPlanEditor.ts`, `types/step.ts`, `cardGroups.js`, card-model UI — all read-only). **`autoExecutor.js` untouched** (read-only trace only). #47 remains **DESIGN-ONLY — not built.** #46 stays blocked on D12 (unit 5.4); #48 closed.
