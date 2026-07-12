/**
 * PRE-DEPLOY FLAGSHIP-CAPABILITY FUNCTIONAL GATE — dual-capability fixture + seam tests.
 *
 * Governing requirement: CONTENT_PIPELINE_MASTER_PLAN.md:297 (HARD, blocks the 3.1
 * deploy). Unit 2.7 verified honestly that the migrated 30-april fixture exercises
 * NEITHER flagship capability. Unit 2.5's seam tests are the FLOOR. This unit builds
 * the PROOF that did not previously exist: ONE purpose-built execution_plan
 * (fixtures/dual_capability.execution_plan.json) that exercises BOTH capabilities,
 * plus the seam tests that prove it.
 *
 * THE TWO CAPABILITIES
 *   A. Placed-round-1 override merge via card_id. autoExecutor forwards entry.card_id
 *      to expandCardGroups (autoExecutor.js:226) so a PLACED round-1 card's flat
 *      `overrides` merge on the FIRST pass — correct-v6, inert-legacy, flagged WARNING
 *      by 2.5's /code-review, never tested end-to-end before this fixture.
 *   B. V6-§1.5 different-submodule dispatch. A DIFFERENT submodule exists ONLY as a
 *      routing-only round-2 card (∉ submodules_per_step). On QA failure its pending
 *      instruction is collected by the WF-1 second dispatch pass
 *      (collectUnplacedDispatchGroups) and the different submodule ACTUALLY EXECUTES
 *      with its card's round-2 overrides + advanced loop_iteration.
 *
 * ALTITUDE (established by unit 2.5): seam-level. Mock db/tools; REAL resolveCards
 * (via applyRouting), REAL findPendingInstructionsForRun, REAL
 * collectUnplacedDispatchGroups (the dispatch-pass collection), REAL expandCardGroups,
 * REAL validateExecutionPlan / resolveStepEntries. The one thing not importable is the
 * submoduleRuns.js /run merge BLOCK (inline in a route handler, not a named export);
 * it is reproduced VERBATIM from submoduleRuns.js:659-686 with a src cite, and an
 * anti-drift static guard pins the reproduction to the live source (T-GUARD).
 *
 * SEAM vs LIVE (see report): these tests prove, in-memory, that both capabilities'
 * ENGINE SEAMS carry the right card_id + overrides + dispatch grouping. They do NOT
 * prove a real entity_submodule_run row is written by a running worker, nor that the
 * pool/next-QA physically reads it — that is the LIVE end-to-end gate (Supabase branch
 * + server + workers driving executeRun), the SAME gate per master-plan:297, filed as
 * the next (3.x) pre-deploy item.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { validateExecutionPlan, resolveStepEntries } from '../services/executionPlanUtils.js';
import { expandCardGroups, collectUnplacedDispatchGroups } from '../services/cardGroups.js';
import { findPendingInstructionsForRun } from '../services/cardInstructions.js';
import { applyRouting, resolveCards } from '../services/routingHandler.js';

// ── fixture ───────────────────────────────────────────────────────────────────
const PLAN = JSON.parse(readFileSync(
  new URL('./fixtures/dual_capability.execution_plan.json', import.meta.url), 'utf8',
));
const CARD_A = 'd1a1c0de-0001-4001-8001-000000000a01'; // placed round-1  (capability A)
const CARD_B = 'd1a1c0de-0002-4002-8002-000000000b02'; // routing-only r2 (capability B)
const SUB_A = 'content-writer';        // placed, cheap
const SUB_B = 'deep-research-writer';  // different, unplaced, expensive
const MARK_A = 'placed-round-1-override-merged-on-first-pass';
const MARK_B = 'unplaced-round-2-different-submodule-dispatched';
const STEP = 5;
const RUN = 'run-dual-cap';
const CARD_DEFS = PLAN.card_definitions;
const ROUTING_RULES = PLAN.routing_rules;
const PLACED_STEP5 = PLAN.submodules_per_step['5']; // [CARD_A]

// Faithful registry: every card's submodule_id + every plain-string entry is
// "registered" (exercises validator rule 2b for real without the modules repo).
function registryFor(plan) {
  const allow = new Set();
  for (const entries of Object.values(plan.submodules_per_step || {})) {
    for (const e of entries || []) if (!/^[0-9a-f]{8}-/i.test(e)) allow.add(e);
  }
  for (const c of Object.values(plan.card_definitions || {})) if (c?.submodule_id) allow.add(c.submodule_id);
  return (id) => allow.has(id);
}

// ── mock db (eq-aware; captures rpc/update; delete() forbidden per AC 1) ────────
// Faithful enough for the real service functions under test: select chains filter
// by every .eq() constraint; maybeSingle/single honor them; upsert/insert/rpc/update
// resolve {data,error} and are captured for assertion.
function makeDb({ entity_submodule_runs = [], entity_run_meta = [] } = {}) {
  const tables = { entity_submodule_runs, entity_run_meta };
  const captures = { rpc: [], update: [], upsert: [], insert: [] };

  function selectChain(table) {
    const eqs = [];
    const rows = () => (tables[table] || []).filter(r => eqs.every(([c, v]) => r[c] === v));
    const chain = {
      eq(c, v) { eqs.push([c, v]); return chain; },
      neq() { return chain; },
      like() { return chain; },
      in() { return chain; },
      not() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      then(res, rej) { return Promise.resolve({ data: rows(), error: null }).then(res, rej); },
    };
    return chain;
  }

  const db = {
    from(table) {
      return {
        select() { return selectChain(table); },
        update(patch) {
          const filt = {};
          const chain = {
            eq(c, v) { filt[c] = v; return chain; },
            then(res, rej) { captures.update.push({ table, patch, filt }); return Promise.resolve({ data: null, error: null }).then(res, rej); },
          };
          return chain;
        },
        upsert(r, opts) { captures.upsert.push({ table, rows: r, opts }); return Promise.resolve({ data: null, error: null }); },
        insert(r) { captures.insert.push({ table, rows: r }); return Promise.resolve({ data: null, error: null }); },
        delete() { throw new Error('AC 1: Section C never deletes rows — mock delete() must not be called'); },
      };
    },
    rpc(name, args) {
      captures.rpc.push({ name, args });
      if (name === 'append_card_instruction') return Promise.resolve({ data: true, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { db, captures };
}

function metaRows(entities, extra = {}) {
  return entities.map(name => ({
    run_id: RUN, entity_name: name, loop_count: 0, terminal_state: null, loop_config: {},
    card_instructions: [], qa_score_history: [], ...extra,
  }));
}

// One loop-router batch row carrying per-entity decisions. Columns match the
// applyRouting read filter (run_id / step_index / submodule_id LIKE %loop-router% / status).
function routerRow(items, routingStep = 10) {
  return {
    run_id: RUN, step_index: routingStep, submodule_id: 'loop-router', status: 'completed',
    entity_name: null, output_data: { items },
  };
}

/**
 * Reproduce the submoduleRuns.js /run per-entity option merge VERBATIM from
 * server/routes/submoduleRuns.js:659-686 (frozen product code, not importable — it
 * is inline in the route handler). This is the real "dispatch boundary" for a card's
 * overrides: the returned object is what lands in entity_submodule_runs.options. The
 * T-GUARD static check pins this reproduction to the live source so it cannot rot.
 */
function simulateSubmoduleRunsMerge({ options, cardId, cardDefinitions, cardInstructions, batchLoopIteration, stepIdx }) {
  const loopMeta = { card_instructions: cardInstructions };
  let entityOptions = options;
  if (cardId && cardDefinitions[cardId]) {
    const card = cardDefinitions[cardId];
    let cardRound = '1';
    for (const record of loopMeta?.card_instructions || []) {
      const match = (record.targets || []).find(t =>
        t.step === stepIdx &&
        t.card_id === cardId &&
        t.loop_iteration === batchLoopIteration &&
        t.status === 'pending'
      );
      if (match?.card_round) {
        cardRound = String(match.card_round);
        break;
      }
    }
    const roundOverrides = card.overrides ?? card.rounds?.[cardRound] ?? {};
    entityOptions = { ...options, ...roundOverrides };
  }
  return entityOptions;
}

// ════════════════════════════════════════════════════════════════════════════
// T-VALID — the fixture validates clean under the 2.4 validator (prove it)
// ════════════════════════════════════════════════════════════════════════════
test('T-VALID: dual-capability fixture VALIDATES clean under validateExecutionPlan (2.4)', () => {
  const { errors, warnings } = validateExecutionPlan(PLAN, { isRegisteredSubmodule: registryFor(PLAN) });
  assert.deepEqual(errors, [], `expected zero validator errors; got: ${JSON.stringify(errors)}`);
  // Structural facts the two capabilities depend on (guards against a silently
  // edited fixture that still happens to validate):
  assert.ok(PLACED_STEP5.includes(CARD_A), 'capability A: card A is PLACED in submodules_per_step[5]');
  assert.ok(!PLACED_STEP5.includes(CARD_B), 'capability B: card B is NOT placed (routing-only)');
  assert.equal(CARD_DEFS[CARD_A].round, 1, 'card A is round 1');
  assert.equal(CARD_DEFS[CARD_B].round, 2, 'card B is round 2 (retry)');
  assert.notEqual(CARD_DEFS[CARD_A].submodule_id, CARD_DEFS[CARD_B].submodule_id, 'A and B are DIFFERENT submodules');
  assert.deepEqual(ROUTING_RULES['citation:fail'], [{ step: 5, card_id: CARD_B }], 'citation:fail routes to card B');
  // The inert _fixture_doc key does not perturb validation (unknown keys ignored).
  assert.ok(PLAN._fixture_doc, 'fixture carries human doc, provably ignored by the validator');
  assert.equal(warnings.length, 0, `expected no validator warnings; got: ${JSON.stringify(warnings)}`);
});

// ════════════════════════════════════════════════════════════════════════════
// T-A — CAPABILITY A: placed round-1 card's overrides MERGE on the first pass
//        via forwarded card_id. Assert the MERGED CONFIG reaches the dispatch
//        boundary (executed options) — not merely that a card exists.
// ════════════════════════════════════════════════════════════════════════════
test('T-A: capability A — placed round-1 card_id forwarded; overrides merge on first pass to executed options', async () => {
  const entities = ['Acme', 'Globex', 'Initech'];

  // 1) REAL resolver forwards the placed card_id (autoExecutor.js:188 → :226 uses this).
  const [entry] = resolveStepEntries(PLACED_STEP5, CARD_DEFS);
  assert.equal(entry.submodule_id, SUB_A, 'placed entry resolves to content-writer');
  assert.equal(entry.card_id, CARD_A, 'placed entry FORWARDS card_id (the W3 fix — else it collapses to null default)');
  assert.deepEqual(entry.round_1_overrides, CARD_DEFS[CARD_A].overrides, 'flat overrides resolve as round-1 config');

  // 2) REAL expandCardGroups on the FIRST pass (NO pending instructions). The placed
  //    card_id makes the non-routed entities group under CARD_A (not a null default),
  //    and the group carries the card's overrides — the merged config at the seam.
  const { db } = makeDb({ entity_run_meta: metaRows(entities) });
  const groups = await expandCardGroups(db, RUN, STEP, SUB_A, entities, CARD_DEFS, entry.card_id);

  assert.equal(groups.length, 1, 'one group on the first pass (all entities non-routed)');
  const g = groups[0];
  assert.equal(g.card_id, CARD_A, 'first-pass group is scoped to the PLACED round-1 card (not null default)');
  assert.deepEqual(g.entities, entities, 'all non-routed entities land in the placed card group');
  assert.deepEqual(g.round_overrides, CARD_DEFS[CARD_A].overrides, 'group carries the round-1 MERGED overrides (not empty)');
  assert.equal(g.round_overrides._cap_a_marker, MARK_A, 'the capability-A marker is present in the group overrides');

  // 3) The merged config reaches the DISPATCH BOUNDARY: reproduce submoduleRuns.js
  //    :659-686. First pass ⇒ empty card_instructions ⇒ cardRound stays "1", and the
  //    flat card.overrides are still merged (v6 collapse) — so executed options carry
  //    the round-1 overrides even with NO routing instruction. THIS is capability A.
  const baseOptions = { model: 'gpt-base', max_tokens: 2000 }; // base has no marker + a base-only key
  const executed = simulateSubmoduleRunsMerge({
    options: baseOptions, cardId: g.card_id, cardDefinitions: CARD_DEFS,
    cardInstructions: [], batchLoopIteration: 0, stepIdx: STEP,
  });
  assert.equal(executed._cap_a_marker, MARK_A, 'MERGED CONFIG reaches executed options (the dispatch boundary)');
  assert.equal(executed.model, 'haiku', 'round-1 override replaced the base model (real merge, not a no-op)');
  assert.equal(executed.temperature, 0.7, 'round-1 override applied');
  assert.equal(executed.max_tokens, 2000, 'non-overridden base option preserved');

  // Legacy-inert control: a card whose overrides live ONLY in a rounds map with no
  // round-1 key would NOT merge on the first pass (cardRound "1" → rounds["1"] ⇒ {}).
  // The v6 flat-overrides card DOES — that is exactly the 2.5-flagged path.
  const legacyDefs = { [CARD_A]: { submodule_id: SUB_A, step: STEP, round: 1, rounds: { '2': { _cap_a_marker: MARK_A } } } };
  const legacyExecuted = simulateSubmoduleRunsMerge({
    options: baseOptions, cardId: CARD_A, cardDefinitions: legacyDefs,
    cardInstructions: [], batchLoopIteration: 0, stepIdx: STEP,
  });
  assert.equal(legacyExecuted._cap_a_marker, undefined, 'legacy rounds-map card is INERT on the first pass (contrast: v6 flat card merges)');
});

// ════════════════════════════════════════════════════════════════════════════
// T-B — CAPABILITY B: §1.5 different-submodule dispatch. On QA failure the DIFFERENT,
//        unplaced submodule's pending instruction is COLLECTED by the WF-1 dispatch
//        pass and would EXECUTE with its round-2 overrides. The instruction-written
//        proxy is EXPLICITLY REJECTED — writing the instruction is B1's failure mode.
// ════════════════════════════════════════════════════════════════════════════
test('T-B: capability B — QA fail → different unplaced submodule is DISPATCHED (proxy rejected), executes with round-2 overrides', async () => {
  // ── Stage 1: REAL applyRouting → REAL resolveCards writes the pending instruction ──
  // loop-router says the entity failed `citation` at round 1 (loop_count 0). The
  // citation:fail rule targets card B (round 2, submodule deep-research-writer).
  const { db: arDb, captures: arCap } = makeDb({
    entity_submodule_runs: [routerRow([{ entity_name: 'Acme', decision: 'loop_generation', qa_scores: { citation: 'fail' } }])],
    entity_run_meta: metaRows(['Acme']), // loop_count 0 → selection round 2
  });
  const summary = await applyRouting(arDb, RUN, /*routingStep*/ 10, PLAN);

  const append = arCap.rpc.find(r => r.name === 'append_card_instruction');
  assert.ok(append, 'a pending instruction WAS written (necessary — but NOT sufficient: B1 writes it too and never dispatches)');
  const target = append.args.p_instruction.targets[0];
  assert.equal(target.card_id, CARD_B, 'the pending target is card B (the different-submodule round-2 card)');
  assert.equal(target.card_round, 2, 'card_round === 2 (round-2 escalation, not a silent round-1 rerun)');
  assert.equal(target.step, STEP, 'target.step === 5');
  assert.equal(target.loop_iteration, 1, 'loop_iteration advanced to 1 (post-bump) — the distinct round-2 batch key');
  assert.equal(summary.routed_count, 1, 'applyRouting reports one genuinely-routed entity');

  // ── Stage 2: persist the instruction, REAL findPendingInstructionsForRun reads it ──
  const persisted = [append.args.p_instruction];
  const { db: pendDb } = makeDb({ entity_run_meta: metaRows(['Acme'], { card_instructions: persisted }) });
  const pendingMap = await findPendingInstructionsForRun(pendDb, RUN, STEP, CARD_DEFS);
  const acmePending = pendingMap.get('Acme').pending;
  assert.equal(acmePending[0].submodule_id, SUB_B, 'resolved pending names the DIFFERENT submodule (deep-research-writer)');

  // ── Stage 3: REAL WF-1 dispatch collection (autoExecutor.js:271-272 verbatim path) ──
  // THE DISCRIMINATOR (T-LADDER, v6.1): the different, UNPLACED submodule's instruction
  // is collected into a dispatch group → it is handed to dispatchAndAwaitGroup →
  // triggerSubmodule → it EXECUTES. This is exactly what B1 (placed-loop-only) could not do.
  const unplaced = collectUnplacedDispatchGroups(pendingMap, PLACED_STEP5, ROUTING_RULES);
  assert.equal(unplaced.length, 1, 'exactly one unplaced dispatch group — the different submodule');
  assert.equal(unplaced[0].submodule_id, SUB_B, 'DISPATCHED submodule is deep-research-writer (∉ submodules_per_step)');
  assert.equal(unplaced[0].card_id, CARD_B, 'dispatched under card B (distinct card_id)');
  assert.equal(unplaced[0].loop_iteration, 1, 'dispatched at advanced loop_iteration 1 (the round-2 batch)');
  assert.deepEqual(unplaced[0].entities, ['Acme'], 'the failing entity is the dispatch target');

  // ── Proxy rejection / §1.5 necessity: the PLACED loop can NEVER surface B ──
  // expandCardGroups for the placed submodule (content-writer) filters pending by its
  // own submodule_id, so B's instruction is invisible to it. Without the §1.5 WF-1
  // pass, B's instruction sits pending and is never dispatched (BLOCKER B1). So B's
  // EXECUTION depends entirely on the dispatch collection asserted above — not on the
  // mere existence of the pending instruction.
  const placedGroups = await expandCardGroups(pendDb, RUN, STEP, SUB_A, ['Acme'], CARD_DEFS, CARD_A);
  assert.ok(placedGroups.every(gp => gp.card_id !== CARD_B), 'the placed content-writer loop produces NO group for card B (B1: placed loop cannot dispatch it)');
  assert.ok(placedGroups.some(gp => gp.card_id === CARD_A), 'the placed loop only ever handles its own placed card');

  // ── Stage 4: the different submodule EXECUTES WITH ITS ROUND-2 OVERRIDES ──
  // Reproduce submoduleRuns.js:659-686 for B's dispatch. For a v6 scalar card the FLAT
  // card.overrides merge regardless of cardRound (card.overrides ?? …); the pending
  // target (step 5, card B, loop_iteration 1) resolves cardRound "2" as provenance (and
  // is what a legacy rounds-map card would key on). Proves B runs its OWN card's config
  // — NOT a different config of the SAME submodule, NOT the "same settings that failed".
  const baseOptions = { model: 'gpt-base', max_tokens: 2000 };
  const executedB = simulateSubmoduleRunsMerge({
    options: baseOptions, cardId: CARD_B, cardDefinitions: CARD_DEFS,
    cardInstructions: persisted, batchLoopIteration: 1, stepIdx: STEP,
  });
  assert.equal(executedB._cap_b_marker, MARK_B, 'the different submodule executes carrying its round-2 overrides');
  assert.equal(executedB.model, 'sonnet', 'round-2 override applied (expensive model), not the base');
  // The executed batch identity (distinct card_id + advanced loop_iteration) is what a
  // real entity_submodule_run row would carry — the row a subsequent QA reads. The
  // physical row-write + pool read is the LIVE gate (see header); the seam proves the
  // card-scoped, round-2 dispatch that produces it.
  assert.equal(unplaced[0].card_id, CARD_B);
  assert.equal(unplaced[0].loop_iteration, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// T-C — OVERFLOW TAIL on THIS fixture: exhaust the authored rounds → no_card_for_round
//        → terminal_state='flagged' (flag-and-continue, V6-§3), entity CONTINUES.
// ════════════════════════════════════════════════════════════════════════════
test('T-C: overflow tail — round exhausted → no_card_for_round → terminal_state flagged, entity continues', async () => {
  // Only round 2 is authored for deep-research-writer. At loop_count 1 the selection
  // round is 3 (INV-ROUND) — no matching card. REAL resolveCards proves the terminus:
  const res = resolveCards({ citation: 'fail' }, PLAN, /*loopCount*/ 1);
  assert.ok(res, 'resolveCards returns a resolution object, never null/crash');
  assert.deepEqual(res.active_cards, {}, 'no round-3 card exists on this fixture');
  assert.equal(res.missing_reason, 'no_card_for_round', 'overflow terminus reason (not corruption)');

  // REAL applyRouting routes that terminus into the terminal write. loop_count 1 <
  // MAX_LOOPS 3 ⇒ it is a genuine round overflow (no_card_for_round), NOT
  // max_loops_exceeded — and the value is 'flagged' (flag-and-continue), NOT 'failed'.
  const { db, captures } = makeDb({
    entity_submodule_runs: [routerRow([{ entity_name: 'Acme', decision: 'loop_generation', qa_scores: { citation: 'fail' } }])],
    entity_run_meta: metaRows(['Acme'], { loop_count: 1 }), // round 3 selection → overflow
  });
  const summary = await applyRouting(db, RUN, 10, PLAN);

  const termWrite = captures.update.find(u => u.table === 'entity_run_meta' && u.patch.terminal_state !== undefined);
  assert.ok(termWrite, 'a terminal_state write happened for the overflowed entity');
  assert.equal(termWrite.patch.terminal_state, 'flagged', "terminal_state === 'flagged' (V6-§3 flag-and-continue, NOT 'failed')");
  assert.equal(termWrite.patch.failure_reason, 'no_card_for_round', 'failure_reason records the overflow');
  assert.equal(termWrite.filt.entity_name, 'Acme', 'the write targets the overflowed entity');

  // "Entity continues": flagged is routing-terminal, not pipeline-stop. It is NOT
  // routed backward (no dispatch) and NOT failed — runs.js:494 forwards flagged
  // entities to steps 8/9. Assert the seam-observable shape of that.
  assert.ok(!captures.rpc.some(r => r.name === 'append_card_instruction'), 'overflow writes NO new dispatch instruction (no escalation to run)');
  assert.equal(summary.routed_count, 0, 'no backward routing');
  assert.equal(summary.all_terminal, true, 'the pass is all-terminal');
  assert.equal(summary.flagged_count, 1, 'the entity is counted as flagged (continues to steps 8/9), not failed');
  assert.equal(summary.failed_count, 0, 'flag-and-continue, not fail');
});

// ════════════════════════════════════════════════════════════════════════════
// T-GUARD — anti-drift: pin the seam reproductions to the FROZEN product source, so
//           the fixture proof cannot silently rot if product plumbing moves (the
//           "never-working path passed 246 tests" failure mode).
// ════════════════════════════════════════════════════════════════════════════
test('T-GUARD: capability-A/B plumbing + reproduced merge block still match frozen product source', () => {
  const autoExec = readFileSync(new URL('../services/autoExecutor.js', import.meta.url), 'utf8');
  const subRuns = readFileSync(new URL('../routes/submoduleRuns.js', import.meta.url), 'utf8');

  // Capability A plumbing: entry.card_id is FORWARDED into expandCardGroups.
  assert.match(autoExec, /expandCardGroups\([^)]*allEntities,\s*cardDefinitions,\s*entry\.card_id\)/,
    'autoExecutor still forwards entry.card_id to expandCardGroups (capability A)');

  // Capability B plumbing: the WF-1 pass collects pending + builds unplaced groups +
  // dispatches through the shared lifecycle.
  assert.match(autoExec, /findPendingInstructionsForRun\(db, runId, stepIndex, cardDefinitions\)/, 'WF-1 reads pending for the step');
  assert.match(autoExec, /collectUnplacedDispatchGroups\(pendingMap, stepSubmodules, config\.routingRules/, 'WF-1 builds the unplaced dispatch groups (capability B)');
  assert.match(autoExec, /await dispatchAndAwaitGroup\(\{\s*runId, stepIndex, submoduleId: g\.submodule_id, cardId: g\.card_id/, 'WF-1 dispatches unplaced groups through the shared lifecycle');

  // The submoduleRuns merge block reproduced by simulateSubmoduleRunsMerge is still
  // the live logic (the two load-bearing lines).
  assert.match(subRuns, /const roundOverrides = card\.overrides \?\? card\.rounds\?\.\[cardRound\] \?\? \{\};/, 'merge still prefers flat card.overrides');
  assert.match(subRuns, /entityOptions = \{ \.\.\.options, \.\.\.roundOverrides \};/, 'merge still spreads roundOverrides onto base options');
});
