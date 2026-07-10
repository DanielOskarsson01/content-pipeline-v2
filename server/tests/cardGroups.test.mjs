/**
 * Unit tests for cardGroups.js (Sub-plan 1, Multi-Card Pattern).
 *
 * Per execution plan §ii section A user requirements:
 *   - default group (entities without pending instructions)
 *   - N-card grouping (multiple cards in same step)
 *   - duplicate handling (defensive Brutal-critic Fix #1 invariant violation)
 *   - empty entities
 *
 * Per skeleton comment ("Unit-test requirement: assert that no entity appears
 * in more than one group output per call"), partition invariant is verified
 * across all multi-entity tests.
 *
 * Run: node server/tests/cardGroups.test.mjs
 */
import { expandCardGroups } from '../services/cardGroups.js';

let passed = 0, failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else            { failed++; failures.push(label); console.log(`  ❌ ${label}`); }
}

// ---------------------------------------------------------------------------
// Mock db builder (matches cardInstructions.test.mjs style)
// ---------------------------------------------------------------------------
/**
 * Build a mock db that returns the given entity_run_meta rows on the multi-row
 * select used by findPendingInstructionsForRun. Captures any rpc calls (used
 * by cleanupDeletedCardInstructions + markSkipped) in capturedRpc.
 */
function buildMockDb({ entityRows = [] } = {}) {
  const capturedRpc = [];

  function buildSelectChain() {
    return {
      _eqs: [],
      eq(col, val) { this._eqs.push({ col, val }); return this; },
      then(onFulfilled) {
        return Promise.resolve({ data: entityRows, error: null }).then(onFulfilled);
      },
    };
  }

  const db = {
    from(_table) {
      return { select(_cols) { return buildSelectChain(); } };
    },
    rpc(name, args) {
      capturedRpc.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
  };

  return { db, capturedRpc };
}

/**
 * Assertion helper: verify partition invariant (no entity appears in 2+ groups).
 */
function assertPartition(groups, label) {
  const seen = new Map(); // entity → group index
  for (let i = 0; i < groups.length; i++) {
    for (const e of groups[i].entities) {
      if (seen.has(e)) {
        assert(false, `${label} — partition violation: ${e} in groups ${seen.get(e)} and ${i}`);
        return;
      }
      seen.set(e, i);
    }
  }
  assert(true, `${label} (partition invariant: each entity in ≤1 group)`);
}

const RUN_ID = 'run-uuid-1';
const STEP = 5;
const SUBMODULE = 'content-writer';

const CARD_DEFS = {
  'card-pse': {
    submodule_id: 'content-writer',
    rounds: { '1': {}, '2': { depth: 3 } },
    prompt_overrides: { tone: 'analytical' },
  },
  'card-research': {
    submodule_id: 'content-writer',
    rounds: { '1': {}, '2': { depth: 5 } },
    prompt_overrides: { tone: 'investigative' },
  },
  'card-third': {
    submodule_id: 'content-writer',
    rounds: { '1': {} },
    prompt_overrides: {},
  },
  'card-other-sub': {
    submodule_id: 'content-analyzer',
    rounds: { '1': {} },
    prompt_overrides: {},
  },
};

// ===========================================================================
// Test 1: empty allEntities → returns []
// ===========================================================================
console.log('\n--- expandCardGroups: empty entities ---');

(async function emptyEntities_returnsEmpty() {
  const { db, capturedRpc } = buildMockDb({ entityRows: [] });
  const r = await expandCardGroups(db, RUN_ID, STEP, SUBMODULE, [], CARD_DEFS);
  assert(Array.isArray(r) && r.length === 0, 'empty allEntities → []');
  assert(capturedRpc.length === 0, 'no rpc calls when no entities to process');
})();

// ===========================================================================
// Test 2: no entity_run_meta rows → all entities go to default group
// ===========================================================================
console.log('\n--- expandCardGroups: no entity_run_meta data ---');

(async function noMetaRows_allDefault() {
  const { db } = buildMockDb({ entityRows: [] });
  const r = await expandCardGroups(db, RUN_ID, STEP, SUBMODULE, ['A', 'B', 'C'], CARD_DEFS);
  assert(r.length === 1, 'single group returned');
  assert(r[0].card_id === null, 'group is default (card_id=null)');
  assert(r[0].entities.length === 3 &&
         r[0].entities.includes('A') &&
         r[0].entities.includes('B') &&
         r[0].entities.includes('C'),
         'all 3 entities in default group');
  assertPartition(r, 'noMetaRows_allDefault');
})();

// ===========================================================================
// Test 3: entities with empty card_instructions → all in default group
// ===========================================================================
console.log('\n--- expandCardGroups: empty card_instructions ---');

(async function emptyInstructions_allDefault() {
  const { db } = buildMockDb({
    entityRows: [
      { entity_name: 'A', card_instructions: [] },
      { entity_name: 'B', card_instructions: null },
    ],
  });
  const r = await expandCardGroups(db, RUN_ID, STEP, SUBMODULE, ['A', 'B'], CARD_DEFS);
  assert(r.length === 1 && r[0].card_id === null, 'single default group');
  assert(r[0].entities.length === 2, 'both entities in default group');
})();

// ===========================================================================
// Test 4: mixed — some entities card-routed, some default
// ===========================================================================
console.log('\n--- expandCardGroups: mixed default + card-routed ---');

(async function mixed_defaultAndCardGroups() {
  const { db } = buildMockDb({
    entityRows: [
      { entity_name: 'Wazdan', card_instructions: [{
        routing_round: 1,
        targets: [
          { step: STEP, card_id: 'card-pse', status: 'pending', loop_iteration: 1, card_round: 2 },
        ],
      }] },
      { entity_name: 'Booming Games', card_instructions: [] },
      { entity_name: 'NSoft', card_instructions: null },
    ],
  });
  const r = await expandCardGroups(db, RUN_ID, STEP, SUBMODULE, ['Wazdan', 'Booming Games', 'NSoft'], CARD_DEFS);
  assert(r.length === 2, '2 groups: default + 1 card');
  const def = r.find(g => g.card_id === null);
  const card = r.find(g => g.card_id === 'card-pse');
  assert(def && def.entities.length === 2 && def.entities.includes('Booming Games') && def.entities.includes('NSoft'),
         'default group has Booming Games + NSoft');
  assert(card && card.entities.length === 1 && card.entities[0] === 'Wazdan',
         'card-pse group has Wazdan');
  assert(card.round_overrides.depth === 3,
         'card group carries round_overrides from pending target (round 2 of card-pse)');
  assert(card.prompt_overrides.tone === 'analytical',
         'card group carries prompt_overrides from cardDefinitions[card-pse]');
  assertPartition(r, 'mixed_defaultAndCardGroups');
})();

// ===========================================================================
// Test 5: N-card grouping (3 entities, 3 different cards)
// ===========================================================================
console.log('\n--- expandCardGroups: N-card grouping ---');

(async function nCard_threeDifferentCards() {
  const { db } = buildMockDb({
    entityRows: [
      { entity_name: 'A', card_instructions: [{
        routing_round: 1,
        targets: [{ step: STEP, card_id: 'card-pse', status: 'pending', loop_iteration: 1, card_round: 1 }],
      }] },
      { entity_name: 'B', card_instructions: [{
        routing_round: 1,
        targets: [{ step: STEP, card_id: 'card-research', status: 'pending', loop_iteration: 1, card_round: 1 }],
      }] },
      { entity_name: 'C', card_instructions: [{
        routing_round: 1,
        targets: [{ step: STEP, card_id: 'card-third', status: 'pending', loop_iteration: 1, card_round: 1 }],
      }] },
    ],
  });
  const r = await expandCardGroups(db, RUN_ID, STEP, SUBMODULE, ['A', 'B', 'C'], CARD_DEFS);
  assert(r.length === 3, '3 card groups (default filtered out — all routed)');
  assert(r.every(g => g.card_id !== null), 'no default group when all entities card-routed');
  assert(r.find(g => g.card_id === 'card-pse')?.entities[0] === 'A', 'card-pse → A');
  assert(r.find(g => g.card_id === 'card-research')?.entities[0] === 'B', 'card-research → B');
  assert(r.find(g => g.card_id === 'card-third')?.entities[0] === 'C', 'card-third → C');
  assertPartition(r, 'nCard_threeDifferentCards');
})();

// ===========================================================================
// Test 6: submodule filter — entity has pending for DIFFERENT submodule → default
// ===========================================================================
console.log('\n--- expandCardGroups: submodule filter ---');

(async function submoduleFilter_pendingForOtherSubmodule() {
  const { db } = buildMockDb({
    entityRows: [
      { entity_name: 'A', card_instructions: [{
        routing_round: 1,
        targets: [{ step: STEP, card_id: 'card-other-sub', status: 'pending', loop_iteration: 1, card_round: 1 }],
      }] },
    ],
  });
  const r = await expandCardGroups(db, RUN_ID, STEP, SUBMODULE, ['A'], CARD_DEFS);
  assert(r.length === 1 && r[0].card_id === null && r[0].entities[0] === 'A',
         'entity with pending for different submodule goes to default group of THIS submodule');
})();

// ===========================================================================
// Test 7: duplicate handling — 2 pending for same (entity, submodule, step) → winner + skip
// ===========================================================================
console.log('\n--- expandCardGroups: duplicate handling (Brutal-critic Fix #1 defensive) ---');

(async function duplicate_winnerKeptDuplicatesSkipped() {
  const { db, capturedRpc } = buildMockDb({
    entityRows: [
      { entity_name: 'A', card_instructions: [{
        routing_round: 1,
        targets: [
          { step: STEP, card_id: 'card-pse',      status: 'pending', loop_iteration: 1, card_round: 1 },
          { step: STEP, card_id: 'card-research', status: 'pending', loop_iteration: 1, card_round: 1 },
        ],
      }] },
    ],
  });
  // Silence the expected console.warn for this test (defensive duplicate skip).
  const origWarn = console.warn;
  let warnCalls = 0;
  console.warn = () => { warnCalls++; };
  let r;
  try {
    r = await expandCardGroups(db, RUN_ID, STEP, SUBMODULE, ['A'], CARD_DEFS);
  } finally {
    console.warn = origWarn;
  }
  assert(r.length === 1, 'single group emitted (winner only)');
  assert(r[0].card_id === 'card-pse', 'winner = first-in-array (card-pse)');
  assert(r[0].entities.length === 1 && r[0].entities[0] === 'A', 'A goes to winner group only');
  assert(warnCalls === 1, 'one warning emitted for the duplicate');
  const skips = capturedRpc.filter(c => c.name === 'mark_card_instruction_skipped');
  assert(skips.length === 1, 'one markSkipped RPC for the duplicate');
  assert(skips[0].args.p_card_id === 'card-research', 'duplicate (card-research) was skipped, not winner');
  assert(skips[0].args.p_skip_reason === 'qa_passed_on_recheck',
         'skip reason matches placeholder enum until DUPLICATE_INSTRUCTION exists');
  assertPartition(r, 'duplicate_winnerKeptDuplicatesSkipped');
})();

// ===========================================================================
// Test 8: orphaned card_id → cleanupDeletedCardInstructions fires, entity → default
// ===========================================================================
console.log('\n--- expandCardGroups: orphaned card_id cleanup ---');

(async function orphaned_cleanedUpAndEntityDefaults() {
  const { db, capturedRpc } = buildMockDb({
    entityRows: [
      { entity_name: 'A', card_instructions: [{
        routing_round: 1,
        targets: [
          { step: STEP, card_id: 'card-deleted', status: 'pending', loop_iteration: 1, card_round: 1 },
        ],
      }] },
    ],
  });
  // 'card-deleted' is NOT in CARD_DEFS → orphan branch fires.
  const r = await expandCardGroups(db, RUN_ID, STEP, SUBMODULE, ['A'], CARD_DEFS);
  assert(r.length === 1 && r[0].card_id === null && r[0].entities[0] === 'A',
         'orphan-only entity goes to default group (no matching pending after orphan filter)');
  const skips = capturedRpc.filter(c => c.name === 'mark_card_instruction_skipped');
  assert(skips.length === 1, 'one markSkipped RPC for the orphan');
  assert(skips[0].args.p_card_id === 'card-deleted', 'orphan card_id was skipped');
  assert(skips[0].args.p_skip_reason === 'card_deleted', 'orphan skip reason = card_deleted');
})();

// ===========================================================================
// Test 9: round_overrides propagation from pending target
// ===========================================================================
console.log('\n--- expandCardGroups: round_overrides propagation ---');

(async function roundOverrides_fromPendingTarget() {
  // findPendingInstructionsForRun derives round_overrides from cardDefinitions[card_id].rounds[String(card_round)].
  // card-pse round 2 has { depth: 3 } per CARD_DEFS above.
  const { db } = buildMockDb({
    entityRows: [
      { entity_name: 'A', card_instructions: [{
        routing_round: 2,
        targets: [{ step: STEP, card_id: 'card-pse', status: 'pending', loop_iteration: 2, card_round: 2 }],
      }] },
    ],
  });
  const r = await expandCardGroups(db, RUN_ID, STEP, SUBMODULE, ['A'], CARD_DEFS);
  assert(r.length === 1 && r[0].card_id === 'card-pse', 'single card-pse group');
  assert(r[0].round_overrides.depth === 3, 'round 2 overrides {depth:3} propagated');
})();

// ===========================================================================
// Test 10: entity not in entity_run_meta map → goes to default
// ===========================================================================
console.log('\n--- expandCardGroups: entity missing from entity_run_meta ---');

(async function entityMissingFromMeta_goesDefault() {
  const { db } = buildMockDb({
    entityRows: [
      { entity_name: 'A', card_instructions: [{
        routing_round: 1,
        targets: [{ step: STEP, card_id: 'card-pse', status: 'pending', loop_iteration: 1, card_round: 1 }],
      }] },
      // 'B' has no entity_run_meta row at all
    ],
  });
  const r = await expandCardGroups(db, RUN_ID, STEP, SUBMODULE, ['A', 'B'], CARD_DEFS);
  assert(r.length === 2, '2 groups: card-pse + default');
  assert(r.find(g => g.card_id === 'card-pse')?.entities[0] === 'A', 'A in card-pse');
  assert(r.find(g => g.card_id === null)?.entities[0] === 'B', 'B (missing meta) in default');
  assertPartition(r, 'entityMissingFromMeta_goesDefault');
})();

// ===========================================================================
// Test 11 (v6 W3): placement-aware — a non-pending entity groups under the
// PLACED card_id, not the null default group.
// ===========================================================================
console.log('\n--- expandCardGroups: placement-aware default group (W3) ---');

(async function placementAware_nonPendingUnderPlacedCard() {
  const { db } = buildMockDb({ entityRows: [] }); // round 1: no pending instructions
  const r = await expandCardGroups(db, RUN_ID, STEP, SUBMODULE, ['A', 'B'], CARD_DEFS, 'card-pse');
  assert(r.length === 1, 'one group');
  assert(r[0].card_id === 'card-pse', 'non-pending entities group under the PLACED card_id (card-pse), NOT null');
  assert(r[0].card_id !== null, 'the default group is no longer the null group when a card is placed');
  assert(JSON.stringify([...r[0].entities].sort()) === JSON.stringify(['A', 'B']), 'both entities in the placed card group');
})();

// ===========================================================================
// Test 12 (v6 W3 / Codex-4 / test #3): TWO ROUND-1 CLONES of the SAME submodule
// execute as DISTINCT card-scoped batches (the placed loop calls expandCardGroups
// once per placed entry; here we simulate the two entries).
// ===========================================================================
console.log('\n--- expandCardGroups: TWO round-1 clones → distinct batches (test #3) ---');

(async function twoRound1Clones_distinctBatches() {
  const { db } = buildMockDb({ entityRows: [] }); // round 1: no pending
  // Entry 1: clone card-pse; Entry 2: clone card-research (both submodule content-writer).
  const g1 = await expandCardGroups(db, RUN_ID, STEP, SUBMODULE, ['A', 'B'], CARD_DEFS, 'card-pse');
  const g2 = await expandCardGroups(db, RUN_ID, STEP, SUBMODULE, ['A', 'B'], CARD_DEFS, 'card-research');
  assert(g1.length === 1 && g1[0].card_id === 'card-pse', 'clone 1 → its own card-scoped group (card-pse)');
  assert(g2.length === 1 && g2[0].card_id === 'card-research', 'clone 2 → its own card-scoped group (card-research)');
  assert(g1[0].card_id !== g2[0].card_id, 'the two clones are DISTINCT card-scoped batches, NOT collapsed to one null default group');
  // Each clone carries its own prompt_overrides (proving they run different configs).
  assert(g1[0].prompt_overrides.tone === 'analytical' && g2[0].prompt_overrides.tone === 'investigative',
    'each clone carries its own overrides — distinct configs, not a silent collapse');
})();

// ===========================================================================
// Test 13 (v6 §4 INV-ORDER / T-ORDER-2): within ONE call that yields multiple
// groups, emission order is DETERMINISTIC and entity-permutation-invariant —
// NOT Array.from(Map).values() entity-insertion order (the :117 hazard).
// ===========================================================================
console.log('\n--- expandCardGroups: INV-ORDER / T-ORDER-2 (deterministic, permutation-invariant) ---');

(async function invOrder_permutationInvariant() {
  // A → pending card-pse, B → pending card-research, C → no pending (placed card-third).
  const entityRows = [
    { entity_name: 'A', card_instructions: [{ routing_round: 2, targets: [{ step: STEP, card_id: 'card-pse', status: 'pending', loop_iteration: 2, card_round: 2 }] }] },
    { entity_name: 'B', card_instructions: [{ routing_round: 2, targets: [{ step: STEP, card_id: 'card-research', status: 'pending', loop_iteration: 2, card_round: 2 }] }] },
    { entity_name: 'C', card_instructions: [] },
  ];
  const seq = async (order) => {
    const { db } = buildMockDb({ entityRows });
    const r = await expandCardGroups(db, RUN_ID, STEP, SUBMODULE, order, CARD_DEFS, 'card-third');
    return r.map(g => g.card_id);
  };
  const forward = await seq(['A', 'B', 'C']);
  const reverse = await seq(['C', 'B', 'A']);
  assert(JSON.stringify(forward) === JSON.stringify(reverse),
    `group order byte-identical across entity permutations (${JSON.stringify(forward)} === ${JSON.stringify(reverse)})`);
  // Deterministic order: placed/default group (card-third) first, then routed cards by card_id.
  assert(JSON.stringify(forward) === JSON.stringify(['card-third', 'card-pse', 'card-research']),
    'placed group first, then routed cards by card_id — authored, not entity-emergent');
})();

// ===========================================================================
// Test 14: legacy path unchanged — no placedCardId → null default group.
// ===========================================================================
console.log('\n--- expandCardGroups: legacy (no placed card) → null default group ---');

(async function legacyNoPlacedCard_nullDefault() {
  const { db } = buildMockDb({ entityRows: [] });
  const r = await expandCardGroups(db, RUN_ID, STEP, SUBMODULE, ['A'], CARD_DEFS); // no 7th arg
  assert(r.length === 1 && r[0].card_id === null, 'legacy submodule-string entry (no card) → null default group (back-compat)');
})();

// ===========================================================================
// Test 15 (static): the placed loop FORWARDS entry.card_id into expandCardGroups
// (the W3 hand-off that was previously dropped at autoExecutor.js:213-220).
// ===========================================================================
console.log('\n--- autoExecutor forwards entry.card_id into expandCardGroups (W3 wiring) ---');

(async function autoExecutorForwardsCardId() {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../services/autoExecutor.js', import.meta.url), 'utf8');
  assert(/expandCardGroups\(\s*db,\s*runId,\s*stepIndex,\s*submoduleId,\s*allEntities,\s*cardDefinitions,\s*entry\.card_id\s*\)/.test(src),
    'expandCardGroups is called WITH entry.card_id (placement forwarded, W3)');
})();

// ===========================================================================
// Wait for all IIFEs to settle, then report
// ===========================================================================
setTimeout(() => {
  console.log(`\n=== Results ===\n  Passed: ${passed}\n  Failed: ${failed}`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}, 100);
