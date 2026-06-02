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
