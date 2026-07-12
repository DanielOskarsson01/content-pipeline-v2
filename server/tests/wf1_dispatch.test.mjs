/**
 * WF-1 (V6-§1.5) — unplaced routing-only dispatch seam tests (unit 2.5, Piece B).
 *
 * Two layers, both deterministic (no live stack):
 *   1. collectUnplacedDispatchGroups (PURE) — the collection + INV-DISPATCH-ORDER
 *      logic, unit-tested in isolation. Proves: only unplaced instructions are
 *      collected (placed set is the placed loop's job), grouping by (submodule,card),
 *      deterministic ordering by routing_rules target order then card_id, entity-
 *      permutation invariance (T-ORDER-2 for the unplaced sequence), and the T-LADDER
 *      discriminator (a DIFFERENT, unplaced submodule's pending instruction IS
 *      collected for dispatch — the v6.0 blocker dropped it).
 *   2. autoExecutor WF-1 wiring (STATIC ANALYSIS) — asserts the pass is positioned
 *      AFTER the placed loop and BEFORE evaluateStepResult, and dispatches through the
 *      SHARED dispatchAndAwaitGroup lifecycle (not a bare triggerSubmodule). autoExecutor
 *      imports module-singleton db/redis + does real fetch/polling, so it has no
 *      functional harness — this static check is the seam-level backstop.
 *
 * WHAT THIS DOES NOT PROVE (deferred to the live pre-deploy run, 3.x): a real
 * entity_submodule_run row created via the dispatch + its output flowing into the
 * next QA end-to-end (needs a Supabase branch + running server + workers). This is
 * the seam FLOOR (W8), not the live proof.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectUnplacedDispatchGroups } from '../services/cardGroups.js';

// Build a findPendingInstructionsForRun-shaped Map from a plain object.
// items: { [entityName]: [ { submodule_id, card_id, loop_iteration }, ... ] }
function pendingMap(items) {
  const m = new Map();
  for (const [name, arr] of Object.entries(items)) {
    m.set(name, { pending: arr, orphaned: [] });
  }
  return m;
}

// ── collectUnplacedDispatchGroups (pure) ──────────────────────────────────────

test('WF-1: collects ONLY unplaced instructions — a placed submodule is left to the placed loop', () => {
  const pm = pendingMap({
    E1: [{ submodule_id: 'perplexity-finder', card_id: 'c-perp', loop_iteration: 0 }],
    E2: [{ submodule_id: 'content-writer', card_id: 'c-cw', loop_iteration: 0 }],
  });
  const groups = collectUnplacedDispatchGroups(pm, ['content-writer'], {});
  assert.equal(groups.length, 1, 'only the unplaced (perplexity) instruction forms a group');
  assert.equal(groups[0].submodule_id, 'perplexity-finder');
  assert.equal(groups[0].card_id, 'c-perp');
  assert.deepEqual(groups[0].entities, ['E1']);
});

test('WF-1: T-LADDER discriminator — a DIFFERENT, unplaced submodule IS collected for dispatch (v6.0 dropped it)', () => {
  // Round 1 placed the cheap finder; round 2 escalates to a different, expensive,
  // unplaced submodule. Its pending instruction must be collected (→ dispatched via
  // §1.5), NOT silently dropped the way the placed-loop-only path did (BLOCKER B1).
  const pm = pendingMap({
    Wazdan: [{ submodule_id: 'perplexity-url-finder', card_id: 'c-perp-r2', loop_iteration: 0 }],
  });
  const groups = collectUnplacedDispatchGroups(pm, ['cheap-url-finder'], {});
  assert.equal(groups.length, 1, 'the different unplaced submodule forms a dispatch group (would be dispatched)');
  assert.equal(groups[0].submodule_id, 'perplexity-url-finder');
  assert.equal(groups[0].card_id, 'c-perp-r2');
  assert.deepEqual(groups[0].entities, ['Wazdan']);
});

test('WF-1: groups by (submodule, card) — many entities on one card → ONE batch group, entities sorted', () => {
  const pm = pendingMap({
    E3: [{ submodule_id: 'perp', card_id: 'c', loop_iteration: 1 }],
    E1: [{ submodule_id: 'perp', card_id: 'c', loop_iteration: 1 }],
    E2: [{ submodule_id: 'perp', card_id: 'c', loop_iteration: 1 }],
  });
  const groups = collectUnplacedDispatchGroups(pm, [], {});
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].entities, ['E1', 'E2', 'E3'], 'entities sorted (intra-group determinism)');
  assert.equal(groups[0].loop_iteration, 1, 'loop_iteration carried from the pending instruction');
});

test('WF-1: INV-DISPATCH-ORDER (a) — groups ordered by routing_rules target array position', () => {
  const routingRules = {
    'citation:fail': [{ step: 5, card_id: 'c-B' }, { step: 5, card_id: 'c-A' }], // B before A
  };
  const pm = pendingMap({
    E1: [
      { submodule_id: 'subA', card_id: 'c-A', loop_iteration: 0 },
      { submodule_id: 'subB', card_id: 'c-B', loop_iteration: 0 },
    ],
  });
  const groups = collectUnplacedDispatchGroups(pm, [], routingRules);
  assert.deepEqual(groups.map(g => g.card_id), ['c-B', 'c-A'],
    'c-B dispatches first (target-array position 0), then c-A — NOT card_id-alpha, NOT Map order');
});

test('WF-1: INV-DISPATCH-ORDER (b) — card_id tiebreak when cards are not in routing_rules', () => {
  const pm = pendingMap({
    E1: [
      { submodule_id: 'subZ', card_id: 'zzz', loop_iteration: 0 },
      { submodule_id: 'subA', card_id: 'aaa', loop_iteration: 0 },
    ],
  });
  const groups = collectUnplacedDispatchGroups(pm, [], {});
  assert.deepEqual(groups.map(g => g.card_id), ['aaa', 'zzz'], 'stable card_id tiebreak');
});

test('WF-1: entity-permutation invariance (T-ORDER-2 for unplaced) — order is byte-identical across Map insertion orders', () => {
  const routingRules = { 'q:fail': [{ card_id: 'c-A' }, { card_id: 'c-B' }] };
  const run = (entityOrder) => {
    const m = new Map();
    for (const e of entityOrder) {
      m.set(e, { pending: [
        { submodule_id: 'subA', card_id: 'c-A', loop_iteration: 0 },
        { submodule_id: 'subB', card_id: 'c-B', loop_iteration: 0 },
      ], orphaned: [] });
    }
    return collectUnplacedDispatchGroups(m, [], routingRules);
  };
  const forward = run(['E1', 'E2', 'E3']);
  const reverse = run(['E3', 'E2', 'E1']);
  assert.equal(JSON.stringify(forward), JSON.stringify(reverse),
    'dispatch sequence + entities identical regardless of entity/Map iteration order');
});

test('WF-1: an entity with a MIX of placed + unplaced pending yields only the unplaced group', () => {
  const pm = pendingMap({
    E1: [
      { submodule_id: 'content-writer', card_id: 'c-cw-r2', loop_iteration: 0 }, // placed (same-submodule retry)
      { submodule_id: 'perplexity', card_id: 'c-perp-r2', loop_iteration: 0 },   // unplaced
    ],
  });
  const groups = collectUnplacedDispatchGroups(pm, ['content-writer'], {});
  assert.equal(groups.length, 1, 'the placed same-submodule retry is excluded (expandCardGroups dispatches it)');
  assert.equal(groups[0].submodule_id, 'perplexity');
});

test('WF-1: empty / missing inputs never throw', () => {
  assert.deepEqual(collectUnplacedDispatchGroups(undefined, undefined, undefined), []);
  assert.deepEqual(collectUnplacedDispatchGroups(new Map(), ['x'], {}), []);
  assert.deepEqual(collectUnplacedDispatchGroups(pendingMap({ E1: [] }), [], {}), []);
});

// ── autoExecutor WF-1 wiring (static analysis) ────────────────────────────────

const autoExecSrc = readFileSync(new URL('../services/autoExecutor.js', import.meta.url), 'utf8');

test('WF-1 wiring: autoExecutor imports the collection + pending-read helpers', () => {
  assert.match(autoExecSrc, /import\s*\{[^}]*collectUnplacedDispatchGroups[^}]*\}\s*from\s*'\.\/cardGroups\.js'/);
  assert.match(autoExecSrc, /import\s*\{[^}]*findPendingInstructionsForRun[^}]*\}\s*from\s*'\.\/cardInstructions\.js'/);
});

test('WF-1 wiring: the unplaced-dispatch pass is positioned AFTER the placed loop and BEFORE evaluateStepResult', () => {
  const placedLoop = autoExecSrc.indexOf('for (const entry of resolvedEntries)');
  const wf1 = autoExecSrc.indexOf('collectUnplacedDispatchGroups(pendingMap');
  const evalStep = autoExecSrc.indexOf('await evaluateStepResult(runId, stepIndex)');
  assert.ok(placedLoop > -1 && wf1 > -1 && evalStep > -1, 'all three anchors present');
  assert.ok(placedLoop < wf1, 'WF-1 pass runs after the placed entry loop');
  assert.ok(wf1 < evalStep, 'WF-1 pass runs BEFORE evaluateStepResult (escalation output feeds step-eval + next QA)');
});

test('WF-1 wiring: both the placed loop AND the WF-1 pass dispatch through the SHARED dispatchAndAwaitGroup lifecycle', () => {
  assert.match(autoExecSrc, /async function dispatchAndAwaitGroup\(/, 'the shared lifecycle helper is defined');
  const calls = [...autoExecSrc.matchAll(/await dispatchAndAwaitGroup\(/g)];
  assert.ok(calls.length >= 2, `dispatchAndAwaitGroup is called by both loops (found ${calls.length} call sites)`);
  // The lifecycle helper reuses poll/await/approve — not a bare triggerSubmodule-and-move-on.
  for (const fn of ['pollBatchCompletion', 'waitForSubmoduleRunStatus', 'autoApproveSingleSubmodule', 'verifyEnqueueCount']) {
    const body = autoExecSrc.slice(autoExecSrc.indexOf('async function dispatchAndAwaitGroup('));
    assert.ok(body.includes(fn), `dispatchAndAwaitGroup reuses the full lifecycle (${fn})`);
  }
});
