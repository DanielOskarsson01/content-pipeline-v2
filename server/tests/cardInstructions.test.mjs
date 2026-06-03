/**
 * Unit tests for cardInstructions.js (Sub-plan 1, Multi-Card Pattern).
 *
 * Priority focus per execution plan §iii — review-driven code (highest fresh-bug risk):
 *   - validateCardInstructions defensive guards (Brutal-critic Fix #4)
 *   - findPendingInstructions + cleanupDeletedCardInstructions read/write split (Fix #5)
 *   - findPendingInstructionsForRun batch helper (Fix #6)
 *   - writeInstructions BOOLEAN return + loop_iteration injection (Fix #1 + CTO Finding 1)
 *   - markSkipped FIFO alignment, no loop_iteration filter (Fix #3)
 *   - SKIP_REASONS 5-value enum (Plan v5 amendment 1d)
 *
 * Run: node server/tests/cardInstructions.test.mjs
 */
import {
  SKIP_REASONS,
  validateCardInstructions,
  findPendingInstructions,
  findPendingInstructionsForRun,
  cleanupDeletedCardInstructions,
  writeInstructions,
  markConsumed,
  markSkipped,
  getConsumedRoundsForRun,
} from '../services/cardInstructions.js';

let passed = 0, failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else            { failed++; failures.push(label); console.log(`  ❌ ${label}`); }
}

function assertThrows(fn, expectedSubstring, label) {
  try {
    const maybePromise = fn();
    if (maybePromise && typeof maybePromise.then === 'function') {
      return maybePromise.then(
        () => { failed++; failures.push(label); console.log(`  ❌ ${label} — expected throw, got resolved`); },
        (err) => {
          if (err.message.includes(expectedSubstring)) { passed++; console.log(`  ✅ ${label}`); }
          else { failed++; failures.push(label); console.log(`  ❌ ${label} — error did not include "${expectedSubstring}": ${err.message}`); }
        }
      );
    }
    failed++; failures.push(label); console.log(`  ❌ ${label} — expected throw, returned ${maybePromise}`);
  } catch (err) {
    if (err.message.includes(expectedSubstring)) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; failures.push(label); console.log(`  ❌ ${label} — error did not include "${expectedSubstring}": ${err.message}`); }
  }
}

// ---------------------------------------------------------------------------
// Mock db builders
// ---------------------------------------------------------------------------

/**
 * Build a mock db that returns a fixed row when entity_run_meta is queried by
 * (run_id, entity_name). Records rpc calls in capturedRpc.
 */
function buildMockDb({ entityRow = null, entityRows = null, rpcReturn = { data: null, error: null }, throwOnRpc = null } = {}) {
  const capturedRpc = [];
  const capturedQueries = [];

  function buildSelectChain(returnSingle, returnAll) {
    const q = {
      _eqs: [],
      eq(col, val) { this._eqs.push({ col, val }); return this; },
      maybeSingle() {
        capturedQueries.push({ kind: 'maybeSingle', eqs: this._eqs });
        return Promise.resolve({ data: returnSingle, error: null });
      },
      then(onFulfilled) {
        // Awaiting the chain without .maybeSingle() returns the multi-row form
        capturedQueries.push({ kind: 'select', eqs: this._eqs });
        return Promise.resolve({ data: returnAll, error: null }).then(onFulfilled);
      },
    };
    return q;
  }

  const db = {
    from(table) {
      return {
        select(_cols) {
          return buildSelectChain(entityRow, entityRows);
        },
      };
    },
    rpc(name, args) {
      capturedRpc.push({ name, args });
      if (throwOnRpc && throwOnRpc[name]) {
        return Promise.resolve({ data: null, error: { message: throwOnRpc[name] } });
      }
      return Promise.resolve(rpcReturn);
    },
  };

  return { db, capturedRpc, capturedQueries };
}

// ===========================================================================
// validateCardInstructions — Brutal-critic Fix #4 (Edge Case 1)
// ===========================================================================
console.log('\n--- validateCardInstructions ---');

(function val_null_returnsEmpty() {
  const r = validateCardInstructions(null, 'entityA');
  assert(Array.isArray(r) && r.length === 0, 'null → empty array');
})();

(function val_undefined_returnsEmpty() {
  const r = validateCardInstructions(undefined, 'entityA');
  assert(Array.isArray(r) && r.length === 0, 'undefined → empty array');
})();

(function val_nonArray_throws() {
  assertThrows(
    () => validateCardInstructions('not-an-array', 'entityA'),
    'expected array, got string',
    'non-array throws with type info',
  );
})();

(function val_objectInsteadOfArray_throws() {
  assertThrows(
    () => validateCardInstructions({ foo: 'bar' }, 'entityA'),
    'expected array, got object',
    'object (non-array) throws',
  );
})();

(function val_recordNonObject_throws() {
  assertThrows(
    () => validateCardInstructions(['not-an-object'], 'entityA'),
    'record[0]',
    'non-object record throws with index',
  );
})();

(function val_targetsNonArray_throws() {
  assertThrows(
    () => validateCardInstructions([{ targets: 'not-an-array' }], 'entityA'),
    'record[0].targets',
    'non-array targets throws with index',
  );
})();

(function val_targetNonObject_throws() {
  assertThrows(
    () => validateCardInstructions([{ targets: ['string-target'] }], 'entityA'),
    'targets[0]',
    'non-object target throws with index',
  );
})();

(function val_pending_missingCardId_throws() {
  assertThrows(
    () => validateCardInstructions([{ targets: [{ status: 'pending', step: 1, loop_iteration: 0 }] }], 'entityA'),
    'missing or non-string card_id',
    'pending target without card_id throws',
  );
})();

(function val_pending_nonStringCardId_throws() {
  assertThrows(
    () => validateCardInstructions([{ targets: [{ status: 'pending', card_id: 123, step: 1, loop_iteration: 0 }] }], 'entityA'),
    'missing or non-string card_id',
    'pending target with non-string card_id throws',
  );
})();

(function val_pending_emptyCardId_throws() {
  assertThrows(
    () => validateCardInstructions([{ targets: [{ status: 'pending', card_id: '', step: 1, loop_iteration: 0 }] }], 'entityA'),
    'missing or non-string card_id',
    'pending target with empty card_id throws',
  );
})();

(function val_pending_missingStep_throws() {
  assertThrows(
    () => validateCardInstructions([{ targets: [{ status: 'pending', card_id: 'uuid', loop_iteration: 0 }] }], 'entityA'),
    'missing or non-number step',
    'pending target without step throws',
  );
})();

(function val_pending_missingLoopIteration_throws() {
  assertThrows(
    () => validateCardInstructions([{ targets: [{ status: 'pending', card_id: 'uuid', step: 1, card_round: 1 }] }], 'entityA'),
    'CTO Finding 1',
    'pending target without loop_iteration throws with CTO Finding 1 reference',
  );
})();

// Section C pre-flight (2026-06-03) — card_round required on pending targets.
// C↔B.5 seam: routingHandler MUST emit card_round so the rounds[N] merge in
// submoduleRuns.js:663-664 picks the escalation round's overrides, not the
// default "1" silent-no-op. Loud-fail at write catches every future caller.
(function val_pending_missingCardRound_throws() {
  assertThrows(
    () => validateCardInstructions([{ targets: [{ status: 'pending', card_id: 'uuid', step: 1, loop_iteration: 2 }] }], 'entityA'),
    'Section C pre-flight',
    'pending target without card_round throws with Section C pre-flight reference',
  );
})();

(function val_pending_nonNumberCardRound_throws() {
  assertThrows(
    () => validateCardInstructions([{ targets: [{ status: 'pending', card_id: 'uuid', step: 1, loop_iteration: 2, card_round: '2' }] }], 'entityA'),
    'non-number card_round',
    'pending target with string card_round throws (must be number, not string)',
  );
})();

(function val_pending_nullCardRound_throws() {
  assertThrows(
    () => validateCardInstructions([{ targets: [{ status: 'pending', card_id: 'uuid', step: 1, loop_iteration: 2, card_round: null }] }], 'entityA'),
    'non-number card_round',
    'pending target with null card_round throws',
  );
})();

(function val_consumed_missingFields_doesNotThrow() {
  const r = validateCardInstructions([{ targets: [{ status: 'consumed', card_id: 'uuid' }] }], 'entityA');
  assert(Array.isArray(r) && r.length === 1, 'consumed target with missing fields does NOT throw (historical state)');
})();

(function val_consumed_missingCardRound_doesNotThrow() {
  // Historical-state safety: consumed targets predate stricter validation; do not retroactively block reads.
  const r = validateCardInstructions([{ targets: [{ status: 'consumed', card_id: 'uuid', step: 1, loop_iteration: 1 }] }], 'entityA');
  assert(Array.isArray(r) && r.length === 1, 'consumed target without card_round does NOT throw (historical state)');
})();

(function val_skipped_missingFields_doesNotThrow() {
  const r = validateCardInstructions([{ targets: [{ status: 'skipped', card_id: 'uuid' }] }], 'entityA');
  assert(Array.isArray(r) && r.length === 1, 'skipped target with missing fields does NOT throw (historical state)');
})();

(function val_valid_returnsAsIs() {
  const input = [{ targets: [{ status: 'pending', card_id: 'uuid', step: 1, loop_iteration: 0, card_round: 1 }] }];
  const r = validateCardInstructions(input, 'entityA');
  assert(r === input, 'valid array (including card_round) returns the same reference');
})();

(function val_valid_pendingWithCardRound_passes() {
  // Happy-path counterpart to the three loud-fail tests above — confirms a well-formed
  // routingHandler write (the post-Section-C contract) passes validation cleanly.
  const r = validateCardInstructions(
    [{ routing_round: 2, targets: [
      { status: 'pending', card_id: 'card-A-uuid', step: 5, loop_iteration: 2, card_round: 2 },
      { status: 'pending', card_id: 'card-B-uuid', step: 5, loop_iteration: 2, card_round: 2 },
    ]}],
    'WazdanGroup',
  );
  assert(Array.isArray(r) && r[0].targets.length === 2, 'well-formed multi-target pending instruction with card_round passes validation');
})();

(function val_errorIncludesContext() {
  assertThrows(
    () => validateCardInstructions('bad', 'WazdanGroup'),
    'WazdanGroup',
    'error message includes entity context',
  );
})();

// ===========================================================================
// SKIP_REASONS — Plan v5 amendment 1d (5-value enum)
// ===========================================================================
console.log('\n--- SKIP_REASONS ---');

(function skipReasons_isFrozen() {
  assert(Object.isFrozen(SKIP_REASONS), 'SKIP_REASONS is frozen');
})();

(function skipReasons_has5Values() {
  const values = Object.values(SKIP_REASONS);
  assert(values.length === 5, 'SKIP_REASONS has exactly 5 values');
})();

(function skipReasons_hasExpectedKeys() {
  const expected = ['QA_PASSED_ON_RECHECK', 'CARD_DELETED', 'ROUNDS_EXHAUSTED', 'POOL_PRECONDITION_NOT_MET', 'MAX_LOOPS_BACKSTOP'];
  const actual = Object.keys(SKIP_REASONS);
  assert(expected.every(k => actual.includes(k)), 'SKIP_REASONS has all 5 expected keys');
})();

(function skipReasons_valuesMatchSpec() {
  assert(SKIP_REASONS.QA_PASSED_ON_RECHECK === 'qa_passed_on_recheck', 'qa_passed_on_recheck spec match');
  assert(SKIP_REASONS.CARD_DELETED === 'card_deleted', 'card_deleted spec match');
  assert(SKIP_REASONS.ROUNDS_EXHAUSTED === 'rounds_exhausted', 'rounds_exhausted spec match');
  assert(SKIP_REASONS.POOL_PRECONDITION_NOT_MET === 'pool_precondition_not_met', 'pool_precondition_not_met spec match');
  assert(SKIP_REASONS.MAX_LOOPS_BACKSTOP === 'max_loops_backstop', 'max_loops_backstop spec match');
})();

// ===========================================================================
// findPendingInstructions — Fix #5 (pure read, no side effects)
// ===========================================================================
console.log('\n--- findPendingInstructions (pure read) ---');

const cardDefs = {
  'card-A-uuid': { submodule_id: 'sitemap-parser', rounds: { '1': {}, '2': { depth: 3 } } },
  'card-B-uuid': { submodule_id: 'google-pse', rounds: { '2': { source: 'curated' } } },
};

(async function find_entityMissing_returnsEmpty() {
  const { db, capturedRpc } = buildMockDb({ entityRow: null });
  const { pending, orphaned } = await findPendingInstructions(db, 'run-1', 'NSoft', 1, cardDefs);
  assert(pending.length === 0 && orphaned.length === 0, 'missing entity → empty pending + orphaned');
  assert(capturedRpc.length === 0, 'pure read makes no rpc calls (no side effects)');
})();

(async function find_filtersByStep() {
  const rows = {
    card_instructions: [
      { routing_round: 2, targets: [
        { step: 1, card_id: 'card-A-uuid', status: 'pending', loop_iteration: 1, card_round: 2 },
        { step: 2, card_id: 'card-B-uuid', status: 'pending', loop_iteration: 1, card_round: 2 },
      ]},
    ],
  };
  const { db } = buildMockDb({ entityRow: rows });
  const { pending } = await findPendingInstructions(db, 'run-1', 'Wazdan', 1, cardDefs);
  assert(pending.length === 1 && pending[0].card_id === 'card-A-uuid', 'filters by stepIndex (only step=1 target returned)');
})();

(async function find_filtersByPendingStatus() {
  const rows = {
    card_instructions: [
      { routing_round: 2, targets: [
        { step: 1, card_id: 'card-A-uuid', status: 'consumed', loop_iteration: 1 },
        { step: 1, card_id: 'card-A-uuid', status: 'pending', loop_iteration: 2, card_round: 2 },
      ]},
    ],
  };
  const { db } = buildMockDb({ entityRow: rows });
  const { pending } = await findPendingInstructions(db, 'run-1', 'Wazdan', 1, cardDefs);
  assert(pending.length === 1 && pending[0].loop_iteration === 2, 'only pending status returned (consumed filtered out)');
})();

(async function find_returnsCardMetadata() {
  const rows = {
    card_instructions: [
      { routing_round: 2, targets: [
        { step: 1, card_id: 'card-A-uuid', status: 'pending', loop_iteration: 2, card_round: 2 },
      ]},
    ],
  };
  const { db } = buildMockDb({ entityRow: rows });
  const { pending } = await findPendingInstructions(db, 'run-1', 'Wazdan', 1, cardDefs);
  assert(pending[0].submodule_id === 'sitemap-parser', 'returns card submodule_id from cardDefinitions');
  assert(pending[0].round_overrides.depth === 3, 'returns round_overrides for card_round');
  assert(pending[0].instruction_round === 2, 'returns routing_round from record');
})();

(async function find_orphanedCardId_returnedSeparately() {
  const rows = {
    card_instructions: [
      { routing_round: 2, targets: [
        { step: 1, card_id: 'deleted-card-uuid', status: 'pending', loop_iteration: 1, card_round: 2 },
      ]},
    ],
  };
  const { db, capturedRpc } = buildMockDb({ entityRow: rows });
  const { pending, orphaned } = await findPendingInstructions(db, 'run-1', 'Wazdan', 1, cardDefs);
  assert(pending.length === 0, 'orphaned card not in pending');
  assert(orphaned.length === 1 && orphaned[0].card_id === 'deleted-card-uuid', 'orphaned card in orphaned array');
  assert(capturedRpc.length === 0, 'pure read makes NO rpc calls even for orphans (cleanup is explicit)');
})();

// ===========================================================================
// cleanupDeletedCardInstructions — Fix #5 (explicit write)
// ===========================================================================
console.log('\n--- cleanupDeletedCardInstructions (explicit write) ---');

(async function cleanup_emptyOrphaned_noRpc() {
  const { db, capturedRpc } = buildMockDb({});
  await cleanupDeletedCardInstructions(db, 'run-1', 'Wazdan', []);
  assert(capturedRpc.length === 0, 'empty orphaned → no rpc calls');
})();

(async function cleanup_eachOrphanedTriggersMarkSkipped() {
  const { db, capturedRpc } = buildMockDb({});
  const orphaned = [
    { step: 1, card_id: 'deleted-1' },
    { step: 2, card_id: 'deleted-2' },
  ];
  await cleanupDeletedCardInstructions(db, 'run-1', 'Wazdan', orphaned);
  assert(capturedRpc.length === 2, '2 orphans → 2 rpc calls');
  assert(capturedRpc.every(c => c.name === 'mark_card_instruction_skipped'), 'all rpc calls are mark_card_instruction_skipped');
  assert(capturedRpc.every(c => c.args.p_skip_reason === SKIP_REASONS.CARD_DELETED), 'all use CARD_DELETED reason');
})();

// ===========================================================================
// findPendingInstructionsForRun — Fix #6 (batch helper, kills N+1)
// ===========================================================================
console.log('\n--- findPendingInstructionsForRun (batch helper) ---');

(async function batch_emptyRows_returnsEmptyMap() {
  const { db, capturedQueries } = buildMockDb({ entityRows: [] });
  const result = await findPendingInstructionsForRun(db, 'run-1', 1, cardDefs);
  assert(result instanceof Map && result.size === 0, 'empty rows → empty Map');
})();

(async function batch_oneQueryForAllEntities() {
  const entityRows = [
    { entity_name: 'NSoft', card_instructions: [] },
    { entity_name: 'Wazdan', card_instructions: [{ routing_round: 2, targets: [
      { step: 1, card_id: 'card-A-uuid', status: 'pending', loop_iteration: 1, card_round: 2 },
    ]}]},
  ];
  const { db, capturedQueries } = buildMockDb({ entityRows });
  const result = await findPendingInstructionsForRun(db, 'run-1', 1, cardDefs);
  assert(capturedQueries.length === 1, 'single batch query (no N+1)');
  assert(result.size === 2, 'Map has both entities');
  assert(result.get('NSoft').pending.length === 0, 'NSoft has no pending');
  assert(result.get('Wazdan').pending.length === 1, 'Wazdan has 1 pending');
})();

(async function batch_orphansInBatchToo() {
  const entityRows = [
    { entity_name: 'Wazdan', card_instructions: [{ routing_round: 2, targets: [
      { step: 1, card_id: 'deleted-card', status: 'pending', loop_iteration: 1, card_round: 2 },
    ]}]},
  ];
  const { db } = buildMockDb({ entityRows });
  const result = await findPendingInstructionsForRun(db, 'run-1', 1, cardDefs);
  assert(result.get('Wazdan').orphaned.length === 1, 'orphaned tracked per entity in batch result');
})();

// ===========================================================================
// writeInstructions — Fix #1 BOOLEAN return + CTO Finding 1 loop_iteration injection
// ===========================================================================
console.log('\n--- writeInstructions (BOOLEAN return + loop_iteration injection) ---');

(async function write_injectsLoopIterationOnTargets() {
  const { db, capturedRpc } = buildMockDb({ rpcReturn: { data: true, error: null } });
  await writeInstructions(db, 'run-1', 'Wazdan', {
    routingRound: 2,
    createdBy: 'router',
    qaFailures: ['citation', 'hallucination'],
    targets: [
      { step: 1, card_id: 'card-A-uuid', card_round: 2, card_name: 'pse-v2' },
      { step: 5, card_id: 'card-B-uuid', card_round: 2, card_name: 'writer-v2' },
    ],
  });
  const sentTargets = capturedRpc[0].args.p_instruction.targets;
  assert(sentTargets.every(t => t.loop_iteration === 2), 'CTO Finding 1: every target gets loop_iteration from routingRound');
  assert(sentTargets.every(t => t.status === 'pending'), 'all targets stamped status=pending');
  assert(sentTargets.every(t => t.consumed_at === null), 'all targets stamped consumed_at=null');
  assert(sentTargets.every(t => t.skip_reason === null), 'all targets stamped skip_reason=null');
})();

(async function write_preservesCallerFields() {
  const { db, capturedRpc } = buildMockDb({ rpcReturn: { data: true, error: null } });
  await writeInstructions(db, 'run-1', 'Wazdan', {
    routingRound: 2,
    createdBy: 'router',
    targets: [{ step: 1, card_id: 'card-A-uuid', card_round: 2, card_name: 'pse-v2' }],
  });
  const sent = capturedRpc[0].args.p_instruction.targets[0];
  assert(sent.card_name === 'pse-v2', 'card_name preserved from caller');
  assert(sent.card_round === 2, 'card_round preserved from caller');
  assert(sent.step === 1, 'step preserved from caller');
})();

(async function write_returnsTrueOnAppend() {
  const { db } = buildMockDb({ rpcReturn: { data: true, error: null } });
  const r = await writeInstructions(db, 'run-1', 'Wazdan', {
    routingRound: 2, createdBy: 'router', targets: [{ step: 1, card_id: 'c', card_round: 2 }],
  });
  assert(r === true, 'returns true when RPC reports append succeeded');
})();

(async function write_returnsFalseOnDedup() {
  const { db } = buildMockDb({ rpcReturn: { data: false, error: null } });
  const r = await writeInstructions(db, 'run-1', 'Wazdan', {
    routingRound: 2, createdBy: 'router', targets: [{ step: 1, card_id: 'c', card_round: 2 }],
  });
  assert(r === false, 'returns false when RPC reports dedup blocked (Fix #1 BOOLEAN contract)');
})();

(async function write_throwsOnRpcError() {
  const { db } = buildMockDb({ throwOnRpc: { append_card_instruction: 'permission denied' } });
  await assertThrows(
    () => writeInstructions(db, 'run-1', 'Wazdan', {
      routingRound: 2, createdBy: 'router', targets: [{ step: 1, card_id: 'c', card_round: 2 }],
    }),
    'permission denied',
    'throws on RPC error with descriptive message',
  );
})();

(async function write_emptyTargets_stillCallsRpc() {
  const { db, capturedRpc } = buildMockDb({ rpcReturn: { data: true, error: null } });
  await writeInstructions(db, 'run-1', 'Wazdan', { routingRound: 2, createdBy: 'router', targets: [] });
  assert(capturedRpc[0].args.p_instruction.targets.length === 0, 'empty targets → empty array sent to RPC');
})();

// ===========================================================================
// markConsumed
// ===========================================================================
console.log('\n--- markConsumed ---');

(async function consumed_callsRpc() {
  const { db, capturedRpc } = buildMockDb({ rpcReturn: { data: null, error: null } });
  await markConsumed(db, 'run-1', 'Wazdan', 1, 'card-A-uuid', '2026-06-02T10:00:00Z');
  assert(capturedRpc[0].name === 'mark_card_instruction_consumed', 'calls mark_card_instruction_consumed');
  assert(capturedRpc[0].args.p_consumed_at === '2026-06-02T10:00:00Z', 'forwards provided consumedAt');
})();

(async function consumed_defaultsConsumedAt() {
  const { db, capturedRpc } = buildMockDb({ rpcReturn: { data: null, error: null } });
  await markConsumed(db, 'run-1', 'Wazdan', 1, 'card-A-uuid');
  assert(typeof capturedRpc[0].args.p_consumed_at === 'string', 'defaults consumedAt to ISO timestamp');
})();

(async function consumed_throwsOnRpcError() {
  const { db } = buildMockDb({ throwOnRpc: { mark_card_instruction_consumed: 'row missing' } });
  await assertThrows(
    () => markConsumed(db, 'run-1', 'Wazdan', 1, 'card-A-uuid'),
    'row missing',
    'throws on RPC error',
  );
})();

// ===========================================================================
// markSkipped — Fix #3 FIFO alignment, no loop_iteration param
// ===========================================================================
console.log('\n--- markSkipped (Fix #3 FIFO alignment) ---');

(async function skipped_callsRpc() {
  const { db, capturedRpc } = buildMockDb({ rpcReturn: { data: null, error: null } });
  await markSkipped(db, 'run-1', 'Wazdan', 1, 'card-A-uuid', SKIP_REASONS.QA_PASSED_ON_RECHECK);
  assert(capturedRpc[0].name === 'mark_card_instruction_skipped', 'calls mark_card_instruction_skipped');
  assert(capturedRpc[0].args.p_skip_reason === 'qa_passed_on_recheck', 'forwards skip reason');
})();

(async function skipped_signatureHas6Params() {
  // Fix #3 verification: markSkipped(db, runId, entityName, step, cardId, skipReason) — NO loopIteration
  assert(markSkipped.length === 6, 'markSkipped signature has 6 params (no loop_iteration — Fix #3)');
})();

(async function skipped_rpcArgsHaveNoLoopIteration() {
  const { db, capturedRpc } = buildMockDb({ rpcReturn: { data: null, error: null } });
  await markSkipped(db, 'run-1', 'Wazdan', 1, 'card-A-uuid', SKIP_REASONS.CARD_DELETED);
  assert(!('p_loop_iteration' in capturedRpc[0].args), 'rpc args do not include p_loop_iteration (Fix #3 alignment)');
})();

(async function skipped_invalidReasonThrows() {
  const { db } = buildMockDb({ rpcReturn: { data: null, error: null } });
  await assertThrows(
    () => markSkipped(db, 'run-1', 'Wazdan', 1, 'card-A-uuid', 'invented_reason'),
    'Invalid skip_reason',
    'invalid skip_reason throws',
  );
})();

(async function skipped_allFiveReasonsAccepted() {
  for (const r of Object.values(SKIP_REASONS)) {
    const { db } = buildMockDb({ rpcReturn: { data: null, error: null } });
    let threw = false;
    try { await markSkipped(db, 'run-1', 'E', 1, 'c', r); } catch (e) { threw = true; }
    assert(!threw, `skip_reason "${r}" accepted`);
  }
})();

(async function skipped_throwsOnRpcError() {
  const { db } = buildMockDb({ throwOnRpc: { mark_card_instruction_skipped: 'lock timeout' } });
  await assertThrows(
    () => markSkipped(db, 'run-1', 'Wazdan', 1, 'card-A-uuid', SKIP_REASONS.CARD_DELETED),
    'lock timeout',
    'throws on RPC error with descriptive message',
  );
})();

// ===========================================================================
// getConsumedRoundsForRun
// ===========================================================================
console.log('\n--- getConsumedRoundsForRun ---');

(async function consumedRounds_emptyRun() {
  const { db } = buildMockDb({ entityRows: [] });
  const r = await getConsumedRoundsForRun(db, 'run-1');
  assert(Object.keys(r).length === 0, 'empty run → empty result');
})();

(async function consumedRounds_perEntityPerCard() {
  const entityRows = [
    { entity_name: 'Wazdan', card_instructions: [
      { routing_round: 2, targets: [
        { step: 1, card_id: 'card-A', status: 'consumed', card_round: 2 },
        { step: 1, card_id: 'card-A', status: 'consumed', card_round: 3 },
        { step: 1, card_id: 'card-B', status: 'consumed', card_round: 2 },
        { step: 1, card_id: 'card-C', status: 'pending', card_round: 2, loop_iteration: 2 },
      ]},
    ]},
    { entity_name: 'NSoft', card_instructions: [] },
  ];
  const { db } = buildMockDb({ entityRows });
  const r = await getConsumedRoundsForRun(db, 'run-1');
  assert(r.Wazdan['card-A'].length === 2 && r.Wazdan['card-A'].includes(2) && r.Wazdan['card-A'].includes(3), 'Wazdan card-A has 2 consumed rounds');
  assert(r.Wazdan['card-B'].length === 1 && r.Wazdan['card-B'][0] === 2, 'Wazdan card-B has 1 consumed round');
  assert(!r.Wazdan['card-C'], 'Wazdan card-C (pending, not consumed) absent from result');
  assert(Object.keys(r.NSoft).length === 0, 'NSoft has empty per-card map');
})();

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------
// Wait for any async tests to settle by deferring summary to end of microtask queue
await new Promise(resolve => setImmediate(resolve));
await new Promise(resolve => setImmediate(resolve));

console.log(`\n\n=== Results ===`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
