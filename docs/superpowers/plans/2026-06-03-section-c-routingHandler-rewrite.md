# Section C — routingHandler.js Rewrite

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Plan v1 cleared CTO review (7 findings). Plan v2 folded them, then cleared real-Gemini independent verification (6 findings — 4 load-bearing including a silent-no-op the same-model simulated-Gemini round missed). Plan v3 folds those 4 + a Test Group 8 rewrite + a one-line `validateCards` belt-and-suspenders assertion. **Implementation proceeds in a fresh session against v3 after a user read-through.**

**Status:** REVISED v3 (2026-06-04). Live on disk at `docs/superpowers/plans/2026-06-03-section-c-routingHandler-rewrite.md` (untracked). Pre-flight commits b879c1d (card_round required on pending targets) and 1eee648 (LOW cleanups) live on `sub-plan-1-multi-card` HEAD `1eee648`.

**v3 fold (changes from v2):**
- **Finding 1 (real-Gemini + same-model both confirmed; direct file verification):** Task 4 Step 1 SQL replaced. The plan v2 pseudocode invented a `SELECT FOR UPDATE` + `v_already_exists` two-stage pattern that does not exist in the live RPC (`migration_multi_card_pattern.sql:133-163`). The live RPC is a single `UPDATE … WHERE NOT EXISTS` + `GET DIAGNOSTICS ROW_COUNT`. v3 replaces the pseudocode with the live body verbatim + one additional SET clause: `loop_count = CASE WHEN p_increment_loop_count THEN COALESCE(loop_count, 0) + 1 ELSE loop_count END`. Atomicity is mathematically guaranteed by the single-statement UPDATE — if dedup blocks (0 rows touched), loop_count naturally does not bump. No new lock required.
- **Finding 2/3 (real-Gemini + same-model both confirmed):** Architecture section, Task 5 Step 1, and Appendix A no longer cite "enforced by b879c1d" for the cardId invariant (b879c1d enforces `card_round`, not cardId presence). v3 cites the actual writer chain: `runs.js:1155` → autoExecutor → `cardGroups.js:99-106` → batchWorker → `submodule_runs.card_id`. v3 also surfaces Gemini's nuance: the invariant is **structural-plumbing**, not runtime-enforced. Flagged as a Section-C-out-of-scope follow-up candidate (loud-fail runtime check).
- **Finding 5 (real-Gemini + same-model both confirmed; direct grep verification):** AC 2 + Task 4 Step 4 grep exclusion list adds two missing historical files: `sql/migration_routing.sql` and `sql/migration_multi_card_pattern.sql`.
- **Finding 6 (real-Gemini ONLY — CRITICAL; same-model simulated-Gemini missed it):** `findPendingInstructionsForRun(stepIndex=null)` silent no-op. Plan v2 pseudocode passed `null` for the QA-passed cleanup, but the current helper at `cardInstructions.js:203` strictly filters `target.step === stepIndex`. `target.step === null` is always false, so the helper returns zero pending, cleanup silently does nothing. v3 fold: extend `findPendingInstructionsForRun` in `cardInstructions.js` to accept `stepIndex === null` meaning "all steps" via Gemini's prescribed predicate `if ((stepIndex === null || target.step === stepIndex) && target.status === 'pending')`. Open Questions 1 + 3 dropped (Gemini's caller audit confirmed all 4 callers pass integers; extension is purely additive). New test in `cardInstructions.test.mjs` for the `stepIndex=null` path. Task 3 file list extended.
- **Test Group 8 rewrite (same-model agent finding, confirmed correct on inspection):** Group 8 as written in v2 verified a structurally-unreachable scenario (card-routed retry can never reach line 411 because of the if/else exclusivity Gemini independently verified). v3 rewrites Group 8 to exercise the reachable dangerous case: **non-card-routed step-rerun, `cardId=null`, `inputData.entities.length > pool.size`**, where pre-v2 `isLoopPass=true` would have blocked the defensive merge. Without this rewrite, Group 8 is false confidence in exactly the spot the swap changed.
- **One-line `validateCards` assertion (cross-step contamination, latent — belt-and-suspenders):** add a one-line warning in `validateCards` (routingHandler.js:91-138) that fires if any cardId is configured at multiple steps. Cheap insurance — `getConsumedRoundsForRun` keys rounds by `(entity, card_id)` only, not `(entity, card_id, step)`, so a future cardDefinitions that reuses a cardId across steps would silently cross-contaminate round derivation. The warning surfaces the latent shape; no behavior change required today since cardDefinitions does not currently reuse cardIds across steps.

**Cross-model verification disposition (honest accounting):** the v2 same-model "Gemini" review was effectively a same-model leg — it caught findings 1, 2/3, 5 (real-Gemini also caught these), missed finding 6 (real-Gemini caught it by walking the actual execution path; same-model reasoned about it as a design uncertainty, not a code bug). v3 has had a real two-model check. Going forward in this project, treat simulated cross-checks as same-model and weight only real cross-model checks as Pattern B.5.

---

**Goal:** Rewrite [server/services/routingHandler.js](../../../server/services/routingHandler.js) to (a) emit Multi-Card Pattern instructions via `append_card_instruction` instead of deleting `entity_submodule_runs` and `submodule_runs` rows (closes BACKLOG #7), (b) handle per-entity instruction-write failures without partial-state damage (the failure class Multi-Card Pattern exists to eliminate), (c) consume the now-enforced `card_round` contract so every routed retry actually runs Round-N escalation overrides instead of the silent Round-1 default, (d) increment `loop_count` ATOMICALLY with the instruction-write via a new RPC parameter, (e) replace the orphaned `is_loop_pass` flag with `cardId`-based derivation (the routed-retry signal already structurally plumbed end-to-end), (f) extend `findPendingInstructionsForRun` to handle `stepIndex === null` so the QA-passed cleanup actually surfaces pending instructions instead of silently returning zero, and (g) delete the `apply_entity_routing` tripwire stub atomically with the JS rewrite.

**Architecture:**
- Replace the cascade-delete + `apply_entity_routing` flow with per-entity `writeInstructions()` calls (cardInstructions §5.2) for routed entities, plus targeted `markSkipped` calls for entities that recovered or exhausted rounds. No row deletion. No RPC monolith.
- Section A's `expandCardGroups` (cardGroups.js) already reads pending instructions written by routing and produces per-card batches at the target step. Section B.5's `submoduleRuns.js:651-672` merge applies `card.rounds[card_round]` overrides on top of base options. C closes the loop by writing the instructions those two read.
- Per-entity failure isolation: each entity's instruction-write is its own try/catch. On failure, set `entity_run_meta.terminal_state='failed'` + `failure_reason='instruction_write_failed'` + log per-entity error, continue to the next entity. No cross-entity blast radius — the bug Multi-Card Pattern was designed to eliminate.
- `card_round` now required on pending targets at write time (b879c1d, `cardInstructions.js:96-100`). Plan is built against the enforced contract: every `writeInstructions` call MUST pass `card_round`; omitting it throws synchronously at validation.
- `loop_count` increment folded into `append_card_instruction` RPC via new `p_increment_loop_count BOOLEAN` parameter — atomic write+bump via single-statement UPDATE with conditional SET (no SELECT FOR UPDATE; the existing dedup-via-WHERE-NOT-EXISTS already provides "no rows touched = no bump" gating). Removes the silent-orphan partial-state shape a separate UPDATE could leave.
- `is_loop_pass` retired from runtime use: routed-retry detection now reads `cardId` from the request (the routed-retry signal autoExecutor + cardGroups.js + batchWorker already plumb end-to-end). **The invariant "every routed retry carries cardId" is enforced by the writer chain, not by a runtime validator** — see Symptom 4 and "Out of scope (deferred)" for the candidate follow-up to make it loud-fail.
- `findPendingInstructionsForRun` extended to accept `stepIndex: number | null` (the QA-passed cleanup needs ALL pending across all steps, not a specific step). Open Questions 1+3 closed (Gemini caller audit: 4 callers, all pass integers, extension is purely additive).

**Tech Stack:** Node.js (ESM), Supabase JS client via `cardInstructions` service (`writeInstructions`, `markSkipped`, `getConsumedRoundsForRun`, `findPendingInstructionsForRun`), existing `validateCards` template-time check (extended by one warning), one new SQL parameter on the existing `append_card_instruction` RPC (no new RPCs), one DROP for the tripwire stub.

---

## Pre-condition: C↔B.5 contract seam (HARDENED — pre-flight live)

The CTO-verified silent-no-op risk for Section C lived at the C↔B.5 seam: if Section C wrote an instruction without `card_round`, [server/services/cardInstructions.js:129-130](../../../server/services/cardInstructions.js#L129-L130) would silently default to `card.rounds?.[undefined]` (→ `{}`), and [server/routes/submoduleRuns.js:660-672](../../../server/routes/submoduleRuns.js#L660-L672) would silently default `cardRound` to `"1"`. Every routed Round-2 retry would run Round-1 base settings — the "same settings that just failed" silent no-op B.5 was designed to eliminate.

**Pre-flight commit b879c1d (2026-06-03) closed this** by hardening `validateCardInstructions` at [cardInstructions.js:96-100](../../../server/services/cardInstructions.js#L96-L100) to require `card_round` (number) on pending targets at write time. The check sits inside the existing pending-status if-block — consumed/skipped targets remain exempt as historical state. Tests cover three loud-fail variants (missing, string, null) + a multi-target happy path + a historical-state preservation test. 80/80 pass.

**Important scope note (v3 finding 2/3):** b879c1d enforces `card_round` on the **JSON payload**. It does NOT enforce `cardId` presence on the HTTP request. The cardId invariant ("every routed retry carries cardId") is structural-plumbing through the writer chain (see Symptom 4 below). The two enforcement layers are separate.

**Plan implications:** Section C is now built against an enforced contract for card_round. Every `writeInstructions` call in the rewrite MUST emit a `card_round` field on every target. Test coverage (Task 6) MUST exercise an instruction omitting `card_round` and confirm validation throws.

---

## Issue Description

### Symptom 1 — Cascade-delete damages routing state (BACKLOG #7)

[routingHandler.js:297-340](../../../server/services/routingHandler.js#L297-L340) deletes from `entity_submodule_runs` AND `submodule_runs` for routed entities at every loop. On 2026-05-25 (Wazdan smoke test), 2 QA failures (citation + hallucination) triggered routing to Step 1, the cascade-delete fired, the `apply_entity_routing` RPC failed, and Wazdan ended in partial-delete state with `terminal_state='flagged'`.

Cascade-delete contradicts the `loop_iteration` schema column's intent, has cross-entity collateral damage potential, has no transaction wrapper around the RPC, and pool restoration fails for `target_step=0`.

### Symptom 2 — apply_entity_routing tripwire stub still in production

Migration `376022d` (which IS `sql/migration_multi_card_pattern.sql`) dropped `apply_entity_routing` (lines 283-284: DROPs both `(UUID, JSONB)` and `(UUID, JSONB, INTEGER)` overloads). Commit `ed5c031` restored the 3-arg version as a loud-fail tripwire stub so the deployed `routingHandler.js:343` call wouldn't fail with cryptic "function does not exist." Section C must remove the call site AND drop the stub atomically as part of the migration.

### Symptom 3 — card_round absent from any current write path

Current routingHandler has no `writeInstructions` call. No code in production today writes pending instructions with `card_round`. Section A + B + B.5 plumbed the read/merge side end-to-end against an empty input — they have no producer. Section C is the producer.

### Symptom 4 — is_loop_pass orphan after RPC removal + cardId is structural-plumbing (v3 nuance)

`apply_entity_routing` was the SOLE setter of `pipeline_stages.is_loop_pass = TRUE` (verified by repo-wide grep — see Appendix A). Section C drops the RPC without replacement, leaving **8 read sites in submoduleRuns.js** without a writer. The flag predated the cardId contract; under the Multi-Card Pattern, `cardId` is already a complete proxy for "this is a routed retry" — present on every routed retry via the writer chain:

```
runs.js:1155 (auto-execute start)  →  cardDefinitions into autoExecutor config
runs.js:1230 (auto-execute resume) →  cardDefinitions into autoExecutor config
autoExecutor.processStep            →  invokes expandCardGroups
cardGroups.js:67 (expandCardGroups) →  reads pending instructions, binds winner.card_id
cardGroups.js:99-106                →  emits per-card groups with card_id populated
batchWorker (per-group dispatch)    →  POSTs to /run with cardId in request
submoduleRuns.js                     →  reads cardId, gates card-routed behavior on it
```

Plan v3 retires the flag from runtime use — see Task 7.

**Important nuance (Gemini v3 finding):** the cardId invariant holds because of how the writer chain is written, NOT because a runtime validator catches violations. If a future code path issues a step-execute call without `cardId` to a step that was previously a loop pass, the cardId-based derivation silently re-enables the defensive merge (line 411). This is a **code-discipline guarantee, not a runtime guarantee**. v3 flags this as an out-of-scope candidate for a loud-fail runtime check (see "Out of scope (deferred)" below).

### Root cause

routingHandler.js was designed for the pre-Multi-Card-Pattern routing model: routing decisions written through a single atomic RPC, intermediate state cleared by cascade-delete, side-channel flags (`is_loop_pass`) signaling retry-ness. The Multi-Card Pattern replaces all three. The two models cannot coexist — routingHandler must be rewritten, not adapted; the `is_loop_pass` side-channel must retire.

### Why this approach (vs the rejected alternatives)

| Considered | Rejected because |
|------------|-----------------|
| Patch cascade-delete to be per-entity (keep `apply_entity_routing` RPC) | Doesn't close BACKLOG #7's transaction-wrapper or pool-restoration concerns. Keeps two competing routing models in production. Future bug recurrence inevitable. |
| Write `card_round` defensively in the merge code (B.5 side) | Pushes the contract check downstream — caller can still pass garbage. CTO option b. Rejected in pre-flight in favour of write-time validation (option a, b879c1d). |
| Defer cascade-delete removal to a separate commit | Couples the rewrite to a still-broken intermediate state. Atomic `replace cascade-delete with writeInstructions` is the actual close of BACKLOG #7. Splitting would leave a "writes both" intermediate. |
| Separate UPDATE for loop_count (after writeInstructions) | If UPDATE fails after RPC succeeds, instruction is persisted but loop_count is stale; next routing pass under-counts and entity gets one EXTRA retry past MAX_LOOPS. Silent safety property breach. Rejected. |
| Side-channel is_loop_pass writer (writeInstructions also sets the flag) | Two sources of truth for "this is a routed retry" — the flag and the cardId. Future risk: they disagree. Band-aid shape. Rejected. |
| Pseudocode the QA-passed cleanup as `findPendingInstructionsForRun(..., null, ...)` without extending the helper signature | **The exact silent-no-op real-Gemini caught (v2 finding 6):** `target.step === null` is false for every target → helper returns zero → cleanup loop bypassed without error. v3 extends the helper to handle `stepIndex === null` explicitly. |
| Test Group 8 covering a card-routed retry where `inputData.entities.length > pool.size` (v2 spec) | Card-routed retries can never reach line 411 (else-if structurally excludes them when cardId is truthy). Group 8 passes vacuously — false confidence at the exact spot the swap changed. v3 rewrites to the reachable case (non-card-routed step-rerun, cardId=null). |
| **Single-commit rewrite: cascade-delete out, writeInstructions in, tripwire dropped, per-entity try/catch, loop_count atomic via RPC parameter, is_loop_pass retired via cardId derivation, findPendingInstructionsForRun extended for stepIndex=null** | ✓ Closes BACKLOG #7. ✓ Removes the dead RPC reference. ✓ Per-entity isolation. ✓ Builds against the enforced card_round contract. ✓ No partial-state failure shapes. ✓ Single source of truth for retry-ness. ✓ QA-passed cleanup actually runs. |

---

## File Structure

**Skeleton (`content-pipeline-v2/`):**
- Modify: [server/services/routingHandler.js](../../../server/services/routingHandler.js) — full rewrite of `applyRouting()`. `validateCards()` extended by one warning (cardId-reused-across-steps). `resolveCards()` unchanged.
- Modify: [server/routes/submoduleRuns.js](../../../server/routes/submoduleRuns.js) — retire `isLoopPass` (delete read block 294-301, swap 7 consumers to use `cardId`, drop the `!isLoopPass` guard at line 411 structurally, update comment at line 1295). Detail in Task 7.
- Modify: `sql/schema.sql` — line 47 comment on `pipeline_stages.is_loop_pass` column updated to DEPRECATED with date + reason.
- Create: `sql/add_increment_loop_count_to_append_card_instruction.sql` — re-CREATEs `append_card_instruction` with the new `p_increment_loop_count BOOLEAN DEFAULT FALSE` parameter; the function body matches the live RPC (`migration_multi_card_pattern.sql:133-163`) with one additional SET clause for `loop_count`.
- Create: `sql/drop_apply_entity_routing_tripwire.sql` — single statement: `DROP FUNCTION IF EXISTS apply_entity_routing(uuid, jsonb, integer);` (signature matches the tripwire stub from `ed5c031`).
- Modify: [server/services/cardInstructions.js](../../../server/services/cardInstructions.js) — (a) `writeInstructions` accepts new `incrementLoopCount` boolean option, passes to RPC as `p_increment_loop_count`. (b) `findPendingInstructionsForRun` extended to accept `stepIndex: number | null` ("all steps" semantics when null). (c) `findPendingInstructions` (single-entity variant) also extended for symmetry.
- Create: `server/tests/routingHandler.test.mjs` — unit tests for the rewritten `applyRouting`.
- Modify: `server/tests/cardInstructions.test.mjs` — add coverage for `incrementLoopCount` propagation (3 tests) + `findPendingInstructionsForRun(stepIndex=null)` path (2 tests).

**Out of scope (deferred):**
- Step 8 bundle quality propagation (BACKLOG #8).
- Step 9 distribution gate (BACKLOG #9).
- **`pipeline_stages.is_loop_pass` column drop** — deferred to a follow-up migration after one production cycle (~1 week). Column sits inert (no writes, no reads) until follow-up drop.
- **`ecosystem.config.cjs` cluster_mode → fork_mode fix** — separate 1-task micro-plan, MANDATORY pre-condition of the deploy gate.
- **Runtime loud-fail check that `cardId` is present on step-execute calls to steps with pending instructions** — Gemini v3 surfaced that cardId is structural-plumbing, not runtime-enforced. The plan retires `is_loop_pass` on the structural-plumbing guarantee, which is sound for the dispatch paths today. A future loud-fail check (e.g., in submoduleRuns.js: "if pending instructions exist for this entity at this step and request lacks cardId, return 400") would convert the discipline guarantee to a runtime guarantee — matching the loud-fail principle the rest of Section C operates under. Candidate for a separate 1-task plan; not scope-crept here because (a) Section C is already large, (b) the structural-plumbing audit (Gemini verified the chain end-to-end) proves no current caller violates the invariant.

---

## Sequencing Rules

1. **Plan v3 user read-through MUST clear before implementation begins.** Not a review round — a sanity check that finding 6 (helper extended for `stepIndex=null`) and Test Group 8 (rewritten to the reachable case) landed correctly. The v2-→-v3 fold list is mechanical against named code locations; no further reviewer round needed.
2. **Implementation MUST be a single atomic commit.** Cascade-delete removal + writeInstructions wiring + per-entity try/catch + loop_count RPC parameter + findPendingInstructionsForRun signature extension + is_loop_pass consumer swap + tripwire SQL drop + schema-comment update all land together.
3. **Both SQL files MUST be in the same commit as the JS rewrite.** The RPC-parameter addition is required for the JS writeInstructions caller to compile correctly; the tripwire DROP is required because the call site is removed. Atomic.
4. **Code-path trace trailer REQUIRED on the implementation commit.** [server/services/routingHandler.js](../../../server/services/routingHandler.js) is in the commit-msg hook's routing-class regex. `sql/*.sql` referencing `apply_entity_routing` or routing RPCs is also in scope. Trailer: `Code-path traced by: CTO agent + real-Gemini + same-model brutal-critic` (the actual reviewers from this plan's review cadence).
5. **Ship-gate MUST exercise all 4 ACs (especially AC 4) on real Supabase before deploy.** Run against local Supabase CLI stack OR a dedicated test DB — NOT first-on-prod.
6. **Tripwire continues guarding prod until C lands AND deploys.** Section C session ends at "ship-gate pass" — deploy is a separate gate.
7. **Deploy gate pre-condition 0 (HARD STOP):** `ecosystem.config.cjs` MUST handle fork_mode cleanly before `deploy.sh` runs. The 2026-06-02 cluster_mode incident will recur on any fresh deploy that wipes PM2 state. Separate micro-plan owns the actual fix. If the micro-plan has not landed AND deployed verifiably, `deploy.sh` MUST NOT run. Tripwire stub continues guarding prod indefinitely.

---

## Task 1: User read-through on plan v3 (BLOCKING, not a review round)

**Files:** none. Read-only sanity check.

- [ ] **Step 1: Confirm finding 6 fold landed correctly**

  Read Task 3 Step 3 (helper signature extension) and Task 6 Group 7 (QA-passed cleanup test). Verify: (a) `findPendingInstructionsForRun` accepts `stepIndex: number | null`, (b) the predicate becomes `if ((stepIndex === null || target.step === stepIndex) && target.status === 'pending')`, (c) at least one test in `cardInstructions.test.mjs` exercises `stepIndex=null` returning all pending across steps.

- [ ] **Step 2: Confirm Test Group 8 rewrite landed correctly**

  Read Task 6 Group 8. Verify the scenario is the reachable dangerous case: **cardId=null, non-card-routed step-rerun, `inputData.entities.length > pool.size`** — NOT the v2 vacuously-passing card-routed scenario.

- [ ] **Step 3: Confirm RPC fix landed correctly (no fictional SELECT FOR UPDATE)**

  Read Task 4 Step 1 SQL. Verify it matches the live RPC body from `sql/migration_multi_card_pattern.sql:133-163` with exactly one additional SET clause for `loop_count`. No `SELECT FOR UPDATE`. No `v_already_exists`. No `IF/THEN`.

- [ ] **Step 4: Approve implementation in a fresh session**

  No more review rounds. Implementation runs against v3 in a separate session.

---

## Task 2: Rewrite applyRouting() — instruction-write path

**Files:**
- Modify: [server/services/routingHandler.js](../../../server/services/routingHandler.js)

Current `applyRouting()` ([lines 151-363](../../../server/services/routingHandler.js#L151-L363)) does:
1. Read loop-router output (a) → routerDecisions
2. Build decisions for ALL entities (b)
3. Resolve routing_rules → cards per decision (b2)
4. Enforce max_loops (c)
5. Map decisions → target_step (d)
6. **Cascade-delete entity_submodule_runs + submodule_runs (e) ← REMOVE**
7. **Call apply_entity_routing RPC (f) ← REMOVE**
8. Return summary (g)

The rewrite keeps (a)-(d) unchanged in spirit. It replaces (e)-(g) with per-entity instruction-write.

- [ ] **Step 1: Add executionPlan.cards to the function scope**

Bind `const cardDefinitions = executionPlan?.cards || {}` near the top of `applyRouting` (after the existing routing_rules read at line 240) so all helper calls share one resolved reference. **Required by v2 finding (Ask 5 #2 / cleanup neutered).**

- [ ] **Step 2: Keep (a)-(d) unchanged**

Lines 151-295 produce a `decisions[]` array with `entity_name`, `decision`, `target_step` (when card resolution succeeded), `config_overrides` (`active_cards` map), `qa_scores`. Do not touch.

- [ ] **Step 3: Replace (e)-(g) with per-entity instruction-write loop**

Pseudocode (v3 — bound check, real cardDefinitions, real (step, card_id) loop for exhausted, atomic loop_count, **stepIndex=null in findPendingInstructionsForRun is now valid** because Task 3 Step 3 extends the helper):

```javascript
// ── e) Per-entity instruction-write (Section C) ──────────────────────
const writeResults = [];
const consumedRoundsByEntity = await getConsumedRoundsForRun(db, runId);

// Pre-load pending instructions for QA-passed cleanup (v2 Ask 5 #2 fix + v3 finding 6 fix).
// MUST pass real cardDefinitions — empty {} silently classifies all pending as orphaned.
// stepIndex=null means "all steps" — REQUIRES Task 3 Step 3 helper extension.
const pendingByEntity = await findPendingInstructionsForRun(
  db, runId, null, cardDefinitions
);

for (const d of decisions) {
  if (d.decision === 'completed') {
    // QA-passed cleanup: stale pending from prior rounds → markSkipped(QA_PASSED_ON_RECHECK).
    const entityPending = pendingByEntity.get(d.entity_name)?.pending || [];
    for (const p of entityPending) {
      try {
        await markSkipped(
          db, runId, d.entity_name, p.step, p.card_id,
          SKIP_REASONS.QA_PASSED_ON_RECHECK
        );
      } catch (err) {
        console.error(`[routingHandler] markSkipped QA-passed cleanup failed for ${d.entity_name} step=${p.step} card=${p.card_id}: ${err.message}`);
        // Non-fatal: completed entity already passed QA; cleanup failure does
        // not warrant terminal_state. Log and continue.
      }
    }
    writeResults.push({ entity_name: d.entity_name, decision: 'completed', instructions_skipped: entityPending.length });
    continue;
  }

  if (d.decision === 'flag_manual' || d.decision === 'failed') {
    writeResults.push({ entity_name: d.entity_name, decision: d.decision, instructions_written: 0 });
    continue;
  }

  if (!d.target_step) {
    await db.from('entity_run_meta').update({
      terminal_state: 'failed',
      failure_reason: 'routing_no_target_step',
    }).eq('run_id', runId).eq('entity_name', d.entity_name);
    writeResults.push({ entity_name: d.entity_name, decision: d.decision, error: 'no_target_step' });
    continue;
  }

  // Build pending targets. v2 Ask 5 #1 bound check is REQUIRED: verify
  // card.rounds[String(nextRound)] EXISTS before emitting the target.
  const targets = [];
  const activeCards = d.config_overrides?.active_cards || {};
  const consumedRounds = consumedRoundsByEntity[d.entity_name] || {};
  const exhaustedCards = [];  // (step, card_id, reason) triples

  for (const [stepStr, cardIds] of Object.entries(activeCards)) {
    const step = Number(stepStr);
    for (const cardId of cardIds) {
      const card = cardDefinitions[cardId];
      if (!card) {
        exhaustedCards.push({ step, card_id: cardId, reason: 'card_not_in_definitions' });
        continue;
      }
      const alreadyConsumed = new Set((consumedRounds[cardId] || []).map(Number));
      let nextRound = 2;
      while (alreadyConsumed.has(nextRound)) nextRound++;

      // v2 Ask 5 #1 — REQUIRED bound check. Without this, validation accepts
      // any number, B.5 merge silently falls back to base options for missing rounds.
      if (!card.rounds || !card.rounds[String(nextRound)]) {
        exhaustedCards.push({ step, card_id: cardId, reason: 'rounds_exhausted' });
        continue;
      }

      targets.push({
        step,
        card_id: cardId,
        card_round: nextRound,        // ← enforced by validateCardInstructions (b879c1d)
      });
    }
  }

  // v2 Ask 5 #3 — markSkipped is a LOOP over real (step, card_id) pairs.
  for (const { step, card_id, reason } of exhaustedCards) {
    try {
      const skipReason = reason === 'card_not_in_definitions'
        ? SKIP_REASONS.CARD_DELETED
        : SKIP_REASONS.ROUNDS_EXHAUSTED;
      await markSkipped(db, runId, d.entity_name, step, card_id, skipReason);
    } catch (err) {
      console.error(`[routingHandler] markSkipped exhausted failed for ${d.entity_name} step=${step} card=${card_id}: ${err.message}`);
      // Continue to next pair.
    }
  }

  if (targets.length === 0) {
    await db.from('entity_run_meta').update({
      terminal_state: 'failed',
      failure_reason: exhaustedCards.some(e => e.reason === 'card_not_in_definitions')
        ? 'card_not_in_definitions'
        : 'rounds_exhausted',
    }).eq('run_id', runId).eq('entity_name', d.entity_name);
    writeResults.push({
      entity_name: d.entity_name, decision: d.decision,
      instructions_written: 0, exhausted_cards: exhaustedCards.length,
    });
    continue;
  }

  // Per-entity try/catch. loop_count bump is ATOMIC via the new RPC parameter
  // (v2 Ask 4a fix). No separate UPDATE — no silent-orphan partial-state shape.
  try {
    const newLoopCount = (loopCounts.get(d.entity_name) || 0) + 1;
    const written = await writeInstructions(db, runId, d.entity_name, {
      routingRound: newLoopCount,
      createdBy: 'routingHandler',
      qaFailures: d.config_overrides?.triggered_by || [],
      targets,
      incrementLoopCount: true,
    });
    writeResults.push({
      entity_name: d.entity_name, decision: d.decision, target_step: d.target_step,
      instructions_written: targets.length, dedup_blocked: !written,
    });
  } catch (err) {
    console.error(`[routingHandler] writeInstructions failed for ${d.entity_name}: ${err.message}`);
    await db.from('entity_run_meta').update({
      terminal_state: 'failed',
      failure_reason: 'instruction_write_failed',
    }).eq('run_id', runId).eq('entity_name', d.entity_name);
    writeResults.push({
      entity_name: d.entity_name, decision: d.decision,
      instructions_written: 0, error: err.message,
    });
  }
}

// ── f) Return summary ──────────────────────────────────────────────
return {
  decisions_sent: decisions.length,
  instructions_written: writeResults.reduce((n, r) => n + (r.instructions_written || 0), 0),
  per_entity: writeResults,
};
```

- [ ] **Step 4: Remove the apply_entity_routing RPC call and the cascade-delete blocks entirely**

Current lines 297-340 (cascade-delete) and 343-347 (RPC call): deleted. No fallback, no dual-write.

- [ ] **Step 5: Extend `validateCards` with the cardId-step-uniqueness warning (one line, belt-and-suspenders)**

Current `validateCards` at [routingHandler.js:91-138](../../../server/services/routingHandler.js#L91-L138). After the same-submodule collision detection block (current lines 111-135), append:

```javascript
// Belt-and-suspenders: warn if any cardId appears at multiple steps.
// getConsumedRoundsForRun keys rounds by (entity, card_id) only, so a cardId
// reused across steps would silently cross-contaminate round derivation.
// Today's data model doesn't reuse cardIds across steps; this warning surfaces
// the latent shape if a future template ever does.
const cardIdStepMap = {};  // cardId → Set<step>
for (const [name, card] of Object.entries(cards)) {
  if (card.step === undefined) continue;
  if (!cardIdStepMap[name]) cardIdStepMap[name] = new Set();
  cardIdStepMap[name].add(card.step);
}
for (const [name, steps] of Object.entries(cardIdStepMap)) {
  if (steps.size > 1) {
    warnings.push(
      `Card "${name}" is configured at multiple steps [${[...steps].join(', ')}]. ` +
      `getConsumedRoundsForRun keys consumed rounds by (entity, card_id) only — ` +
      `reusing a cardId across steps will cross-contaminate round derivation. ` +
      `Use distinct cardIds per step.`
    );
  }
}
```

---

## Task 3: Extend writeInstructions + findPendingInstructions for atomic loop_count + stepIndex=null

**Files:**
- Modify: [server/services/cardInstructions.js](../../../server/services/cardInstructions.js)
- Modify: [server/tests/cardInstructions.test.mjs](../../../server/tests/cardInstructions.test.mjs)

- [ ] **Step 1: Update writeInstructions signature**

Current ([cardInstructions.js:248-263](../../../server/services/cardInstructions.js#L248-L263)):

```javascript
export async function writeInstructions(db, runId, entityName, {
  routingRound, createdBy, qaFailures, targets,
}) { ... }
```

New:

```javascript
export async function writeInstructions(db, runId, entityName, {
  routingRound, createdBy, qaFailures, targets,
  incrementLoopCount = false,
}) {
  // ... build newRecord as before ...
  const { data, error } = await db.rpc('append_card_instruction', {
    p_run_id: runId,
    p_entity_name: entityName,
    p_instruction: newRecord,
    p_increment_loop_count: incrementLoopCount,
  });
  // ... error handling + return as before ...
}
```

- [ ] **Step 2: Add 3 unit tests for incrementLoopCount in cardInstructions.test.mjs**

- `write_passesIncrementLoopCount_default_false` — caller omits the flag, RPC receives `p_increment_loop_count: false`. Guards future copy-paste callers.
- `write_passesIncrementLoopCount_explicit_true` — routingHandler path.
- `write_passesIncrementLoopCount_explicit_false` — confirms the boolean propagates as-is.

- [ ] **Step 3: Extend findPendingInstructionsForRun to handle stepIndex=null (v3 finding 6)**

Current implementation at [cardInstructions.js:191-220](../../../server/services/cardInstructions.js#L191-L220) filters strictly:

```javascript
if (target.step === stepIndex && target.status === 'pending') {
```

Gemini's prescribed change:

```javascript
if ((stepIndex === null || target.step === stepIndex) && target.status === 'pending') {
```

When `stepIndex === null`, the helper returns ALL pending across all steps (the QA-passed cleanup case). When `stepIndex` is a number, behavior is unchanged.

**Caller audit confirmation (from Gemini):** all 4 existing callers pass specific integers (1 prod caller in cardGroups.js:67, 3 test callers in cardInstructions.test.mjs at lines 401, 413, 427). The extension is purely additive — zero existing behavior changes.

Apply the same change to the single-entity sibling `findPendingInstructions` at [cardInstructions.js:122-130](../../../server/services/cardInstructions.js#L122-L130) for API symmetry — same one-line predicate change. No existing caller passes null, so no caller behavior changes.

- [ ] **Step 4: Add 2 unit tests for stepIndex=null in cardInstructions.test.mjs**

- `findPendingForRun_stepIndexNull_returnsAllSteps` — entity has pending at step 1 + step 5; `findPendingInstructionsForRun(db, runId, null, cardDefs)` returns both. Asserts the helper actually walks all pending regardless of step.
- `findPendingForRun_stepIndexNumber_unchanged` — same entity; `findPendingInstructionsForRun(db, runId, 1, cardDefs)` returns only step-1 pending. Confirms the existing behavior is preserved (no regression in cardGroups.js path).

- [ ] **Step 5: Update doc comment**

The JSDoc `@param` for `stepIndex` in both functions: `@param {number|null} stepIndex  current step, or null for ALL steps (used by routingHandler QA-passed cleanup)`.

---

## Task 4: SQL — RPC parameter addition + tripwire drop

**Files:**
- Create: `sql/add_increment_loop_count_to_append_card_instruction.sql`
- Create: `sql/drop_apply_entity_routing_tripwire.sql`

- [ ] **Step 1: Write the RPC parameter migration (v3: replace v2 pseudocode with live body verbatim + ONE additional SET clause)**

The v2 plan invented a `SELECT FOR UPDATE` + `v_already_exists` two-stage pattern that does NOT exist in the live RPC. The live RPC is a single `UPDATE … WHERE NOT EXISTS` + `GET DIAGNOSTICS ROW_COUNT`. Atomicity is mathematically guaranteed by the single-statement UPDATE.

Verbatim live body from `migration_multi_card_pattern.sql:133-163` PLUS one added SET clause for `loop_count` PLUS the new parameter:

```sql
-- Section C: add atomic loop_count bump to append_card_instruction.
--
-- Plan v1 considered a separate UPDATE for loop_count after writeInstructions.
-- CTO review surfaced that if the UPDATE failed after the RPC succeeded, the
-- instruction would be persisted with a stale loop_count, causing the next
-- routing pass to undercount and grant one extra retry past MAX_LOOPS — a
-- silent safety-property breach.
--
-- Fold the bump into the SAME UPDATE statement. Atomicity is guaranteed by
-- Postgres' single-statement UPDATE semantics: if WHERE NOT EXISTS blocks the
-- write (0 rows touched), the CASE expression on loop_count is irrelevant
-- because no UPDATE happens. No SELECT FOR UPDATE required.
--
-- New parameter: p_increment_loop_count BOOLEAN DEFAULT FALSE.
-- - Default FALSE preserves backward compatibility for any non-routing caller.
-- - routingHandler (the only intended caller passing TRUE) opts in explicitly.

CREATE OR REPLACE FUNCTION append_card_instruction(
  p_run_id UUID,
  p_entity_name TEXT,
  p_instruction JSONB,
  p_increment_loop_count BOOLEAN DEFAULT FALSE
) RETURNS BOOLEAN AS $$
DECLARE
  v_rows_updated INTEGER;
BEGIN
  UPDATE entity_run_meta
  SET card_instructions = COALESCE(card_instructions, '[]'::jsonb) || jsonb_build_array(p_instruction),
      loop_count = CASE WHEN p_increment_loop_count THEN COALESCE(loop_count, 0) + 1 ELSE loop_count END,
      updated_at = NOW()
  WHERE run_id = p_run_id
    AND entity_name = p_entity_name
    AND NOT EXISTS (
      -- Cross-join p_instruction's new targets against all existing pending targets
      -- in card_instructions. If ANY duplicate (step, card_id, loop_iteration) exists,
      -- block the entire append.
      SELECT 1
      FROM jsonb_array_elements(p_instruction->'targets') AS new_target,
           jsonb_array_elements(COALESCE(card_instructions, '[]'::jsonb)) AS existing_record,
           jsonb_array_elements(existing_record->'targets') AS existing_target
      WHERE (existing_target->>'step')::int = (new_target->>'step')::int
        AND existing_target->>'card_id' = new_target->>'card_id'
        AND (existing_target->>'loop_iteration')::int = (new_target->>'loop_iteration')::int
        AND existing_target->>'status' = 'pending'
    );

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  RETURN v_rows_updated > 0;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION append_card_instruction IS
  'Atomic append to entity_run_meta.card_instructions with target-level dedup + optional atomic loop_count bump. Returns TRUE if appended, FALSE if any target in p_instruction matched an existing pending (step, card_id, loop_iteration) triple (write blocked + loop_count NOT bumped). Section C (2026-06-04): added p_increment_loop_count for routingHandler atomic write+bump.';
```

**Body diff from the live RPC:**
1. Added 4th parameter `p_increment_loop_count BOOLEAN DEFAULT FALSE` to the signature.
2. Added one SET clause: `loop_count = CASE WHEN p_increment_loop_count THEN COALESCE(loop_count, 0) + 1 ELSE loop_count END`.
3. Updated COMMENT to reflect the new behavior.

Everything else (DECLARE, BEGIN, UPDATE shape, WHERE NOT EXISTS dedup, GET DIAGNOSTICS, RETURN) is byte-identical to lines 133-163 of the live file. No SELECT FOR UPDATE. No v_already_exists. No IF/THEN.

- [ ] **Step 2: Write the tripwire DROP**

```sql
-- Section C: drop the apply_entity_routing tripwire stub.
-- migration_multi_card_pattern.sql (lines 283-284) dropped both overloads of
-- the original function. ed5c031 restored the 3-arg version as a loud-fail
-- stub guarding production until Section C rewrites the JS caller. Section C
-- is now landing; the stub has no remaining callers and must be removed
-- atomically with the JS rewrite.
--
-- Idempotent: IF EXISTS guards re-running.
DROP FUNCTION IF EXISTS apply_entity_routing(uuid, jsonb, integer);
```

- [ ] **Step 3: Verify signature matches the tripwire stub**

```bash
grep -A 5 "CREATE OR REPLACE FUNCTION apply_entity_routing\|CREATE FUNCTION apply_entity_routing" sql/restore_apply_entity_routing_stub.sql
```

Confirmed by Gemini: `(UUID, JSONB, INTEGER)` at `sql/restore_apply_entity_routing_stub.sql:48`.

- [ ] **Step 4: Verify no remaining callers (REPO-WIDE — v3 finding 5 fix)**

```bash
grep -rln "apply_entity_routing" . \
  --exclude-dir=.git --exclude-dir=node_modules \
  --exclude=migration_routing_phase2.sql \
  --exclude=migration_routing_phase3_rpc_fix.sql \
  --exclude=migration_move_routing_to_step7.sql \
  --exclude=migration_routing.sql \
  --exclude=migration_multi_card_pattern.sql \
  --exclude=schema.sql \
  --exclude=CLAUDE.md \
  --exclude=2026-06-03-section-c-routingHandler-rewrite.md \
  --exclude=BACKLOG.md \
  --exclude=restore_apply_entity_routing_stub.sql \
  --exclude=drop_apply_entity_routing_tripwire.sql
```

Expected: ZERO matches. Historical migrations (`migration_routing.sql`, `migration_routing_phase2.sql`, `migration_routing_phase3_rpc_fix.sql`, `migration_move_routing_to_step7.sql`, `migration_multi_card_pattern.sql`) + this plan + the stub-restore + the drop file are FILE-LEVEL excluded. **v3 added `migration_routing.sql` and `migration_multi_card_pattern.sql` (both confirmed by real-Gemini direct grep — the v2 list was incomplete).**

---

## Task 5: Retire is_loop_pass — cardId-based derivation

**Files:**
- Modify: [server/routes/submoduleRuns.js](../../../server/routes/submoduleRuns.js)
- Modify: `sql/schema.sql` (line 47 comment only)

The `is_loop_pass` consumer audit determined that `cardId` (request parameter) is already a complete proxy for "this is a routed retry" — present on every routed retry via the writer chain (Symptom 4 above; Appendix A). v3 nuance: the invariant is structural-plumbing, NOT runtime-enforced (Gemini finding).

- [ ] **Step 1: Delete the isLoopPass read block (lines 294-301)**

Current:
```javascript
// 6. Check is_loop_pass flag (set by apply_entity_routing RPC)
const { data: stageRow } = await db
  .from('pipeline_stages')
  .select('is_loop_pass')
  .eq('id', stage.id)
  .single();

const isLoopPass = stageRow?.is_loop_pass === true;
```

Delete entirely. No replacement read.

- [ ] **Step 2: Swap the 7 runtime consumer sites**

| Line | Current | New |
|------|---------|-----|
| 307 | `if (isLoopPass \|\| cardId) {` | `if (cardId) {` |
| 327 | `if (isLoopPass) {` (reset 'completed' pools) | `if (cardId) {` |
| 343 | `if (isLoopPass) {` (filter pool to 'pending') | `if (cardId) {` |
| 353 | `if (isLoopPass) {` (filter terminal entities) | `if (cardId) {` |
| 373 | `if (isLoopPass \|\| cardId) {` (load metaMap) | `if (cardId) {` |
| 411 | `else if (!isLoopPass && inputData?.entities?.length > filteredPools.length) {` | `else if (inputData?.entities?.length > filteredPools.length) {` (DROP guard — see Step 3) |
| 648 | `if (isLoopPass && loopMeta) {` (inject loop_count) | `if (cardId && loopMeta) {` |

- [ ] **Step 3: Line 411 SEMANTICS — DROP guard (Gemini-verified structurally safe)**

Real-Gemini independently verified the structural reasoning (v3 finding 4 VERIFIED):

> "Reading submoduleRuns.js lines 390-411 confirms this is an `if (cardId) { ... } else if (!isLoopPass && ...) { ... }` chain. If `cardId` is truthy, the entire else if block is skipped by standard JS control flow logic. Replacing `!isLoopPass` with nothing (leaving `else if (inputData?.entities?.length > filteredPools.length)`) preserves identical semantics because execution only reaches that else if when `cardId` is falsy. The plan's structural assessment is 100% correct."

This is the single load-bearing semantic change in the consumer swap. Test coverage MANDATORY (Task 6 Group 8 — v3 rewritten to the reachable case).

- [ ] **Step 4: Schema-comment update — `sql/schema.sql:47`**

Current:
```sql
is_loop_pass BOOLEAN NOT NULL DEFAULT FALSE,  -- Set by apply_entity_routing RPC on reactivated stages
```

New:
```sql
is_loop_pass BOOLEAN NOT NULL DEFAULT FALSE,  -- DEPRECATED 2026-06-04 (Section C). No longer written or read. Routed-retry detection now uses request cardId in submoduleRuns.js. Column pending drop in follow-up migration after one production cycle.
```

- [ ] **Step 5: Update the line 1295 comment**

Current:
```javascript
// these entities (critical for is_loop_pass steps where only 'pending' pools are loaded)
```

New:
```javascript
// these entities (critical for card-routed retry steps where only 'pending' pools are loaded)
```

---

## Task 6: Test coverage for the rewrite

**Files:**
- Create: `server/tests/routingHandler.test.mjs`

Match the mock-db pattern from [server/tests/cardInstructions.test.mjs](../../../server/tests/cardInstructions.test.mjs). Eight test groups:

- [ ] **Group 1: Happy path — single entity, single card, write succeeds**

Mock loop-router output with 1 QA failure → routing_rules resolves 1 card at Step 5 → `applyRouting` writes 1 pending instruction with `card_round=2`. Asserts:
- `writeInstructions` called exactly once with `incrementLoopCount: true`
- `targets[0].card_round === 2`
- `targets[0].step === 5`
- RPC args include `p_increment_loop_count: true`
- No cascade-delete attempted (assert no `db.from('entity_submodule_runs').delete()` call)

- [ ] **Group 2: card_round contract — exhausted card uses markSkipped instead of writing pending**

Mock `cardDefinitions` such that the resolved card has only `rounds["1"]` (no Round 2 defined). After bound-check fix (Task 2 Step 3), rewrite should NOT emit a target with `card_round: 2` for that card — should add the (step, card_id) pair to exhaustedCards and call markSkipped(ROUNDS_EXHAUSTED). Assert: NO writeInstructions call for that card; markSkipped called with ROUNDS_EXHAUSTED reason.

- [ ] **Group 3: Per-entity try/catch — one entity fails, others continue**

Three entities. Sub-case (a): mock `db.rpc('append_card_instruction', ...)` to return `{error: {message: 'simulated RPC failure'}}` for entity #2's call only. Sub-case (b): mock writeInstructions to throw synchronously (validation error — drop a malformed target).

Both sub-cases assert:
- Entity #1 succeeds: writeInstructions called, no terminal_state set
- Entity #2 fails: `terminal_state='failed'`, `failure_reason='instruction_write_failed'`, error logged
- Entity #3 succeeds: writeInstructions called, no terminal_state set
- `per_entity` summary array has 3 entries with the right outcomes

- [ ] **Group 4: max_loops backstop — entity at MAX_LOOPS converted to failed**

Mock `loopCounts.get(entity) === MAX_LOOPS`. Assert: decision converted to `'failed'`, `failure_reason='max_loops_exceeded'`, NO instruction written, NO loop_count bump.

- [ ] **Group 5: rounds_exhausted — all rounds for one card consumed, others available**

Mock `getConsumedRoundsForRun` to return `{[card-A]: [2, 3]}` and `card-A.rounds = {"1": {}, "2": {...}, "3": {...}}`. Two active cards: card-A (exhausted) and card-B (Round 2 available). Assert:
- `markSkipped(ROUNDS_EXHAUSTED)` called for (step, card-A) exactly once
- Single `writeInstructions` call with targets = [{card-B, card_round: 2}]
- No terminal_state set (still has card-B work)

- [ ] **Group 6: rounds_exhausted — ALL active cards exhausted → terminal_state='failed'**

Both active cards exhausted. Assert:
- `markSkipped(ROUNDS_EXHAUSTED)` called for both (step, card_id) pairs
- NO `writeInstructions` call
- `terminal_state='failed'`, `failure_reason='rounds_exhausted'`

- [ ] **Group 7: QA-passed cleanup — completed entity with stale pending instructions (v3 finding 6 verification)**

Mock 1 entity with `decision='completed'` and `entity_run_meta.card_instructions` containing 1 pending target with a card_id PRESENT in cardDefinitions. **The rewrite passes `null` as stepIndex to findPendingInstructionsForRun (Task 2 Step 3). The helper's stepIndex=null path (Task 3 Step 3) returns the pending across all steps.** Assert:
- `findPendingInstructionsForRun` called with `stepIndex === null` (NOT a specific integer)
- `markSkipped(QA_PASSED_ON_RECHECK)` called for that target
- NO terminal_state set (entity completed cleanly)
- Sub-case: cleanup throws → catch fires, error logged, no terminal_state on completed entity

**Without the Task 3 Step 3 fix, this test would catch the v2 silent no-op** — the helper would return zero pending and the markSkipped assertion would fail.

- [ ] **Group 8: Line 411 defensive-merge — guard removal preserves behavior on the REACHABLE case (v3 REWRITE)**

**v3 REWRITE rationale:** v2 specified card-routed retry (cardId non-null) with `inputData.entities.length > pool.size`. That scenario can never reach line 411 — Gemini independently verified the if/else exclusivity. The test passes vacuously and proves nothing. The dangerous case is the REACHABLE one: non-card-routed step-rerun where pre-v2 `isLoopPass=true` would have blocked the merge.

**v3 scenario:**
- `cardId === null` (no body card scoping)
- `filteredPools.length === 2` (e.g., Entity-A + Entity-B already in pool from prior partial run)
- `inputData.entities.length === 3` (auto-execute re-running the step with Entity-A + Entity-B + Entity-C)
- Pre-v2 code: `isLoopPass === true` (this was a routed retry that set the flag) → defensive merge guard `!isLoopPass` was FALSE → merge did NOT fire → Entity-C silently dropped from pool
- Post-v2 code with the guard dropped: `isLoopPass` doesn't exist; the `else if` reaches the defensive-merge body; merge fires; Entity-C is upserted into the pool

**Decision required from this test scenario:** does Section C accept the new behavior (Entity-C added to pool on retry) or preserve the old behavior (Entity-C dropped)?

**Argument for accepting the new behavior:** the `isLoopPass=true && cardId=null && inputData.entities > pool.size` case in the OLD model meant "this step was re-entered with a wider entity set than the pool had — silently dropping entities was a feature for loop passes." Under the Multi-Card Pattern, routed retries always come with `cardId`. A non-card-routed step-rerun with widened entities is NOT a routed retry — it's a re-execution that should respect the wider entity set. The new behavior is the desired one.

**Argument against:** the silent drop was load-bearing for some operational path we may not have surveyed.

**Test assertion:** v3 EXPECTS the new behavior (merge fires, Entity-C added). The test is written to **document the semantic shift** explicitly so a future regression that re-disables the merge surfaces loudly. Test name: `line411_nonCardRouted_widenedEntities_mergeFires_documentsSemanticShift`.

**Reachability note:** if test infra can't reproduce a `cardId=null + previously-loop-pass` scenario directly (because there's no public producer for that state under the Multi-Card Pattern), the test can be a unit-level mock of the submoduleRuns request handler that simulates the request shape. The submoduleRuns route handler is not currently extracted as a named export (Gemini confirmed); the test may need to invoke the route via supertest or a similar HTTP-mock harness. If neither is feasible, file as follow-up + add a static-analysis check (`grep -c 'isLoopPass' server/routes/submoduleRuns.js` returns 0 — already in AC 2).

- [ ] **Group 9: validateCards new warning — cardId reused at multiple steps (v3 belt-and-suspenders)**

Mock cardDefinitions where the same `cardName` appears at step 1 AND step 5. `validateCards` should return a warning string including the cardId name and the two step numbers. **Cheap insurance against the latent cross-step contamination shape.**

---

## Task 7: Implementation commit (atomic)

**Files staged in single commit:**
- Modify: [server/services/routingHandler.js](../../../server/services/routingHandler.js)
- Modify: [server/services/cardInstructions.js](../../../server/services/cardInstructions.js)
- Modify: [server/routes/submoduleRuns.js](../../../server/routes/submoduleRuns.js)
- Modify: `sql/schema.sql` (comment-only change on line 47)
- Create: `sql/add_increment_loop_count_to_append_card_instruction.sql`
- Create: `sql/drop_apply_entity_routing_tripwire.sql`
- Create: `server/tests/routingHandler.test.mjs`
- Modify: `server/tests/cardInstructions.test.mjs`
- Modify: `CLAUDE.md` (session log entry — can be a separate commit if preferred)

- [ ] **Step 1: Apply the rewrite from Task 2, the writeInstructions extension + findPendingInstructionsForRun extension from Task 3, the SQL from Task 4, the isLoopPass retirement from Task 5, the tests from Task 6**

- [ ] **Step 2: Run `node server/tests/cardInstructions.test.mjs` — 80/80 + 3 incrementLoopCount tests + 2 stepIndex=null tests = 85/85 green**

- [ ] **Step 3: Run `node server/tests/routingHandler.test.mjs` — all 9 groups green**

- [ ] **Step 4: Run `/code-review` skill against the staged diff**

- [ ] **Step 5: Write decision_log entry** (Supabase, within 15 min of commit)

- [ ] **Step 6: Commit with trace trailer**

```
Code-path traced by: CTO agent + real-Gemini + same-model brutal-critic
```

---

## Task 8: Ship-gate validation (4 ACs)

**Files:** none — validation only.

ACs run against a local Supabase project (CLI stack) OR a dedicated test database with all migrations applied — NOT first-on-prod.

- [ ] **AC 1: Cascade-delete is gone**

```bash
grep -n "from('entity_submodule_runs').delete\|from('submodule_runs').delete" server/services/routingHandler.js
```

Returns ZERO. Routing produces no row deletions.

- [ ] **AC 2: apply_entity_routing reference is gone (repo-wide, v3 finding 5 fix)**

```bash
grep -rln "apply_entity_routing" . \
  --exclude-dir=.git --exclude-dir=node_modules \
  --exclude=migration_routing_phase2.sql \
  --exclude=migration_routing_phase3_rpc_fix.sql \
  --exclude=migration_move_routing_to_step7.sql \
  --exclude=migration_routing.sql \
  --exclude=migration_multi_card_pattern.sql \
  --exclude=schema.sql \
  --exclude=CLAUDE.md \
  --exclude=2026-06-03-section-c-routingHandler-rewrite.md \
  --exclude=BACKLOG.md \
  --exclude=restore_apply_entity_routing_stub.sql \
  --exclude=drop_apply_entity_routing_tripwire.sql
```

Returns ZERO. Additionally:

```bash
grep -rln "is_loop_pass\|isLoopPass" server/ --exclude-dir=node_modules
```

Expected: ZERO.

- [ ] **AC 3: Per-entity isolation under failure**

Force the test setup to throw inside `writeInstructions` for one of three entities (sub-case a: RPC error; sub-case b: synchronous validation error). Assert: failing entity → `terminal_state='failed'`, `failure_reason='instruction_write_failed'`. Other two entities → pending instructions written, loop_count bumped atomically, no terminal_state, no failure_reason. Inspect `entity_run_meta` rows directly via SQL.

- [ ] **AC 4: Runtime proof of B.5 merge — `_placeholder_marker` reaches submodule_runs.options (automated, dual-path)**

Setup:
1. Template's `cardDefinitions.cards.<card-id>.rounds["2"] = { _placeholder_marker: "section-c-AC4-marker-2026-06-04" }`
2. Trigger routing that resolves that card with `card_round=2`
3. Auto-execute advances to the target step, expandCardGroups picks up the pending instruction, batchWorker creates `submodule_runs` for the batch

**Path 1 — submoduleRuns merge:**

```sql
SELECT (options ? '_placeholder_marker') AS marker_present
FROM submodule_runs
WHERE run_id = $1 AND step_index = $target_step AND card_id = $card_id
ORDER BY created_at DESC LIMIT 1;
```

Returning `FALSE` (or NULL) blocks deploy.

**Path 2 — expandCardGroups round_overrides:**

Add a debug log statement (or test hook in `cardGroups.js` gated by `process.env.AC4_TEST_MODE === '1'`) that prints the resolved group's `round_overrides` for each expanded batch. Assert the log contains `_placeholder_marker`.

If both paths surface the marker → AC 4 PASSES.
If only Path 1 surfaces → AC 4 FAILS with "expandCardGroups round_overrides silently lost the marker."
If only Path 2 surfaces → AC 4 FAILS with "submoduleRuns merge silently lost the marker."
If neither surfaces → AC 4 FAILS hard.

**Staging resolution:** AC 4 runs against local Supabase CLI stack OR a dedicated test database. If neither available, AC 4 SPLITS into:
- AC 4a (pre-deploy, unit-test-mockable): unit test that exercises the routingHandler → writeInstructions → mocked findPendingInstructions → expandCardGroups → mocked entity_run_meta chain WITHOUT a real DB. Asserts the marker survives the in-memory chain.
- AC 4b (post-deploy, explicit rollback criteria): real-DB verification within 24h of deploy.

Plan author MUST resolve which form applies before commit. Default: AC 4 against local Supabase.

---

## Task 9: STOP — handoff to deploy gate (separate session)

Section C session ends here. The deploy gate is a separate session with its own pre-conditions:

- [ ] **Deploy gate pre-condition 0 (HARD STOP):** `ecosystem.config.cjs` MUST handle fork_mode cleanly. Reference: `2026-06-XX-ecosystem-fork-mode-fix.md` (separate 1-task micro-plan, filename TBD when authored). If the micro-plan has not landed AND deployed verifiably, `deploy.sh` MUST NOT run. Tripwire stub continues guarding prod indefinitely.

- [ ] **Pre-deploy tags** on both repos: `pre-section-c-2026-06-04` (rollback point).

- [ ] **deploy.sh + `pm2 restart all`** — all 3 PM2 workers (pipeline-api, stage-worker, batch-worker) restart cleanly on the new code.

- [ ] **Production smoke test** — re-run the Wazdan + Pronet Gaming smoke test from 2026-05-25 against the new routing flow. Assert: zero `apply_entity_routing` errors in logs, instructions written to `entity_run_meta.card_instructions` for routed entities, no `entity_submodule_runs.delete` traffic in DB logs, AC 4b (if applicable) passes within 24h.

- [ ] **Tripwire stub no longer reachable** — confirmed by AC 2 + production logs showing no `apply_entity_routing` calls in the 24h after deploy.

**Until deploy gate passes (all 5 sub-tasks above), the tripwire stub continues guarding prod.**

---

## Appendix A — is_loop_pass consumer audit summary

**Setter audit:** `apply_entity_routing` is the sole setter of `pipeline_stages.is_loop_pass = TRUE`. Verified by `grep -rln "is_loop_pass" .` — 5 live-code files reference it total (schema.sql, 3 historical migrations + migration_routing.sql + migration_multi_card_pattern.sql for completeness, submoduleRuns.js). Sole RPC body lives in `sql/migration_routing_phase3_rpc_fix.sql:189-204`. Nothing ever sets it back to FALSE.

**Consumer enumeration (9 hits in submoduleRuns.js; line 1295 is a comment):**

| Line | Effect | Derivation | Grade |
|------|--------|-----------|-------|
| 294-301 | The read itself | DELETE | TRIVIAL |
| 307 | Load cardDefinitions | `if (cardId)` | TRIVIAL |
| 327 | Reset 'completed' pools | `if (cardId)` | MODERATE |
| 343 | Filter pool to 'pending' | `if (cardId)` | TRIVIAL |
| 353 | Filter terminal entities | `if (cardId)` | TRIVIAL |
| 373 | Load metaMap | `if (cardId)` | TRIVIAL |
| 411 | Defensive merge guard | DROP the guard (structural — see Task 5 Step 3, Gemini-verified) | MODERATE (load-bearing) |
| 648 | Inject loop_count | `if (cardId && loopMeta)` | TRIVIAL |
| 1295 | Comment | Text update | TRIVIAL |

**cardId writer chain (v3 finding 2/3 — replaces the v2 "enforced by b879c1d" claim):**

```
runs.js:1155 (auto-execute start)  → cardDefinitions in autoExecutor config
runs.js:1230 (auto-execute resume) → cardDefinitions in autoExecutor config
autoExecutor.processStep            → invokes expandCardGroups(...)
cardGroups.js:67                    → calls findPendingInstructionsForRun(stepIndex=N)
cardGroups.js:99-106                → emits per-card groups: { card_id: winner.card_id, entities, round_overrides }
batchWorker (per-group dispatch)    → POST /run with cardId in request
submoduleRuns.js (cardId reads)     → gates card-routed behavior
```

Invariant holds because of how the chain is written. **Structural-plumbing, NOT runtime-enforced.** No runtime check fails loud if a routed retry arrives without cardId. Candidate follow-up: a loud-fail runtime check in submoduleRuns.js for "step has pending instructions but request lacks cardId."

**Rollup:** option (b)-via-cardId. ~12 mechanical lines + 1 schema comment + 1 load-bearing structural refactor at line 411 + 1 mandatory test for line 411 (v3-rewritten to reachable case).

---

## Appendix B — Folded findings checklist

Cross-reference of every finding across v1 + v2 + v3:

| Finding origin | Verdict | Disposition in current plan |
|----------------|---------|----------------------------|
| v1 Ask 1 — Enforced contract | PASS | Pre-condition section + Task 2 pseudocode `card_round: nextRound` |
| v1 Ask 2 — Cascade-delete + RPC + tripwire | NEEDS-REVISION | Repo-wide grep with file-level exclusions (Task 4 Step 4, AC 2). is_loop_pass orphan → option (b)-via-cardId (Task 5, Appendix A). |
| v1 Ask 3 — Per-entity try/catch tested | NEEDS-REVISION | Group 3 split into RPC-error + validation-throw sub-cases. Atomicity gap eliminated by Ask 4a fix (loop_count in RPC). |
| v1 Ask 4a — loop_count atomicity | NEEDS-REVISION | RPC parameter `p_increment_loop_count` (Task 4 Step 1). writeInstructions signature extended (Task 3). v3: pseudocode replaced with live RPC body verbatim + one added SET clause. |
| v1 Ask 4b — ecosystem.config.cjs | NEEDS-REVISION | Deploy gate pre-condition 0 (Task 9). HARD STOP. |
| v1 Ask 5 #1 — nextRound unbounded | NEEDS-REVISION | Bound check before pushing target. Test Group 2. |
| v1 Ask 5 #2 — QA-passed cleanup neutered | NEEDS-REVISION | Real cardDefinitions plumbed (Task 2 Step 1). Test Group 7. |
| v1 Ask 5 #3 — rounds_exhausted placeholder | NEEDS-REVISION | Real loop over (step, card_id) pairs. Test Group 6. |
| v1 Ask 6 — AC 4 single-path / manual / staging | NEEDS-REVISION | Automated SQL assertion + debug log. Dual-path coverage. AC 4a/4b split if staging unavailable. |
| **v3 Real-Gemini Finding 1 — append_card_instruction RPC hallucinated SELECT FOR UPDATE** | **DISCREPANCY** | **Task 4 Step 1 replaced with live RPC body verbatim + one SET clause for loop_count. Atomicity via single-statement UPDATE WHERE NOT EXISTS — if dedup blocks (0 rows), loop_count naturally doesn't bump.** |
| **v3 Real-Gemini Finding 2/3 — cardId invariant misattribution** | **DISCREPANCY** | **Architecture, Task 5, Appendix A rewritten to cite actual writer chain (runs.js:1155 → autoExecutor → cardGroups.js:99-106 → batchWorker), not b879c1d. Flagged: structural-plumbing, not runtime-enforced. Loud-fail runtime check filed as out-of-scope follow-up candidate.** |
| v3 Real-Gemini Finding 4 — line 411 logic | VERIFIED | No change. Plan's swap is structurally correct per Gemini's independent verification. |
| **v3 Real-Gemini Finding 5 — AC 2 grep exclusion list incomplete** | **DISCREPANCY** | **Added `migration_routing.sql` and `migration_multi_card_pattern.sql` to file-level exclusion list (Task 4 Step 4, AC 2).** |
| **v3 Real-Gemini Finding 6 — findPendingInstructionsForRun(stepIndex=null) silent no-op (CRITICAL — same-model agents missed)** | **CRITICAL DISCREPANCY** | **Open Questions 1+3 dropped. `findPendingInstructionsForRun` and `findPendingInstructions` extended to handle `stepIndex === null` (Task 3 Step 3). 2 new tests for the null path (Task 3 Step 4). Caller audit confirmed extension is purely additive.** |
| Same-model brutal-critic — Test Group 8 vacuously-passing | Caught | Task 6 Group 8 REWRITTEN to the reachable case: non-card-routed step-rerun, cardId=null, widened entities. Documents semantic shift explicitly. |
| Same-model brutal-critic — cross-step contamination latent | Caught (deflated) | v3 folds belt-and-suspenders: one-line `validateCards` warning (Task 2 Step 5). Group 9 test. |

---

## Cross-model verification disposition (honest accounting)

**v2 round used a same-model "Gemini" leg** (general-purpose agent labeled as Gemini brief). It caught findings 1, 2/3, 5 (real-Gemini independently confirmed). It missed finding 6 (real-Gemini caught by walking the actual execution path; same-model reasoned about it as a design uncertainty, not a code bug). Finding 6 alone — `findPendingInstructionsForRun(stepIndex=null)` returning zero pending and silently bypassing QA-passed cleanup — would have shipped if I'd trusted the simulated-Gemini leg as a real cross-model check.

**v3 has had a real two-model check.** The plan is more trustworthy than v2.

**Going forward in this project:**
- Simulated cross-checks (same-model agents framed as a different model) are NOT Pattern B.5.
- Treat prior "Gemini" findings in this project's history as same-model unless re-verified by real-Gemini.
- For Section C specifically, v3 has a real Gemini check; proceed on it.

---

## Out of scope (filed for separate work)

- BACKLOG #8 (Step 8 bundle quality propagation).
- BACKLOG #9 (Step 9 distribution gate).
- BACKLOG #4 (deploy.sh blocker — Rollup darwin-arm64 bug).
- `ecosystem.config.cjs` cluster_mode → fork_mode — separate micro-plan, HARD pre-condition of the deploy gate.
- `pipeline_stages.is_loop_pass` column drop — follow-up migration after one production cycle.
- **Runtime loud-fail check for cardId presence on routed retries** (v3 Gemini-surfaced): the cardId invariant is currently structural-plumbing, not runtime-enforced. A future check ("if pending instructions exist for this entity at this step and request lacks cardId, return 400") would match the loud-fail principle Section C operates under. Candidate for a separate 1-task plan; not scope-crept into Section C because the structural-plumbing audit (Gemini verified end-to-end) proves no current caller violates the invariant.

---

## Rollback path

If the implementation commit lands on the branch but ship-gate FAILS:
1. Revert the commit on `sub-plan-1-multi-card` (or hard-reset to the pre-Section-C HEAD, currently `1eee648`).
2. The RPC parameter migration and the tripwire DROP need rollback SQL. Manual restore:
   - Re-apply `sql/restore_apply_entity_routing_stub.sql` from `ed5c031`.
   - Re-apply the pre-Section-C `append_card_instruction` body from `sql/migration_multi_card_pattern.sql` (lines 133-163).
3. Verify schema.sql:47 comment is restored to pre-DEPRECATED text (file revert handles this automatically).
4. Tripwire continues guarding prod.

If the deploy lands but production validation FAILS:
1. Rsync the pre-Section-C files back from the pre-deploy tag's HEAD.
2. Restore the RPC stub + the pre-Section-C `append_card_instruction` body.
3. `pm2 restart all` (fork_mode per deploy gate pre-condition 0).
4. Investigate the failure mode on the branch, not on prod.
