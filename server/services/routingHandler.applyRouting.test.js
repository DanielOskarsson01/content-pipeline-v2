/**
 * F-B (VALIDATION_E2E_RUN1, run 9821ed56): the router DECIDED and nothing
 * EXECUTED — and no run-level record said so.
 *
 * The live template's routing_rules point every "<check>:fail" at card
 * a1b2c3d4-…101 (step 1, round: 1 — the SEARCH_OPEN card), while selection at
 * loop_count=0 targets round 2 (INV-ROUND). resolveCards therefore hits
 * sawWrongRound → 'no_card_for_round' → flag-and-continue. That is the
 * INTENDED no-op (round-2 retry is deliberately OFF), and applyRouting
 * executed it correctly: terminal_state='flagged' + failure_reason=
 * 'no_card_for_round' ×5 are in entity_run_meta (DB-verified on the archived
 * run). What was MISSING is the run-level record: routing_events stayed [],
 * the routing summary was discarded, and "decided loop_discovery ×5, executed
 * nothing, because no_card_for_round" was only reconstructable from absence.
 *
 * UNDER HEAD (pre-fix): the no-op-outcome assertions here FAILED — applyRouting
 * wrote zero decision_log rows (run 9821ed56 recorded nothing). That red run
 * documents the bug. UNDER THE FIX: every routing pass writes ONE
 * decision_log row (decision='routing_outcome') — routed or no-op — so
 *   SELECT * FROM decision_log WHERE run_id = ? AND decision = 'routing_outcome'
 * shows what was decided, what executed, and why.
 *
 * The byte-identity tests pin that the ROUTING WRITES themselves are unchanged:
 * the normally-routed path produces the exact same append_card_instruction RPC
 * payload as HEAD, and the no-op path performs zero instruction writes — the
 * fix is purely additive observability. NO retry is re-enabled.
 *
 * The fake DB mimics supabase-js at the chain boundary; assertions run against
 * the REAL applyRouting/resolveCards logic.
 *
 * Run via: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { applyRouting } from './routingHandler.js';

const RUN = '9821ed56-5e9a-4b9d-b47a-2d2385a74e76';
const CARD_101 = 'a1b2c3d4-0000-4000-8000-000000000101'; // step 1, round 1 (search card)
const CARD_005 = 'a1b2c3d4-0000-4000-8000-000000000005'; // step 5, round 2 (writer retry)

// The live company-profile-v3 execution_plan shape (queried from prod):
// every fail key → card …101 (round 1); card …005 (round 2) exists but is
// referenced by NO rule — that is the deliberate retry OFF-switch.
function livePlan() {
  return {
    card_definitions: {
      [CARD_101]: { step: 1, round: 1, submodule_id: 'search-discovery' },
      [CARD_005]: { step: 5, round: 2, submodule_id: 'content-writer' },
    },
    routing_rules: {
      'meta:fail': [{ step: 5, card_id: CARD_101 }],
      'keyword:fail': [{ step: 5, card_id: CARD_101 }],
      'citation:fail': [{ step: 5, card_id: CARD_101 }],
      'structural:fail': [{ step: 5, card_id: CARD_101 }],
      'hallucination:fail': [{ step: 5, card_id: CARD_101 }],
    },
  };
}

// A plan whose rule points at the round-2 card — the path that ACTUALLY routes.
function routablePlan() {
  return {
    card_definitions: {
      [CARD_005]: { step: 5, round: 2, submodule_id: 'content-writer' },
    },
    routing_rules: {
      'hallucination:fail': [{ step: 5, card_id: CARD_005 }],
    },
  };
}

const QA_FAIL = { meta: 'pass', keyword: 'pass', citation: 'pass', structural: 'pass', hallucination: 'fail' };
const QA_PASS = { meta: 'pass', keyword: 'pass', citation: 'pass', structural: 'pass', hallucination: 'pass' };

function routerRow(entity, decision, qa) {
  return {
    entity_name: entity,
    output_data: {
      entity_name: entity,
      items: [{
        entity_name: entity,
        decision,
        route_reason: decision === 'approve'
          ? 'All QA checks passed'
          : 'Routing back to Step 1 (Discovery) to gather better sources',
        qa_scores: qa,
      }],
      meta: { status: 'success' },
    },
  };
}

function metaRow(entity) {
  return { entity_name: entity, loop_count: 0, terminal_state: null, loop_config: null };
}

/**
 * Minimal supabase-js fake covering exactly applyRouting's chains:
 *   from('entity_submodule_runs').select().eq().eq().like().in()        → router rows
 *   from('entity_run_meta').upsert()                                    → {error:null}
 *   from('entity_run_meta').select('entity_name, loop_count, …').eq()   → meta rows
 *   from('entity_run_meta').select('entity_name, card_instructions').eq() → pending rows
 *   from('entity_run_meta').select('qa_score_history').eq().eq().maybeSingle() → history
 *   from('entity_run_meta').update().eq().eq()                          → recorded
 *   from('decision_log').insert()                                       → recorded
 *   rpc('append_card_instruction', args)                                → recorded
 */
function fakeDb({ routerRows, metaRows, pendingRows = [] }) {
  const calls = { updates: [], inserts: [], rpcs: [], upserts: [] };
  function makeBuilder(table, mode, payload, selectCols = '') {
    const resolveValue = () => {
      if (mode === 'select') {
        if (table === 'entity_submodule_runs') return { data: routerRows, error: null };
        if (table === 'entity_run_meta') {
          if (selectCols.includes('card_instructions')) return { data: pendingRows, error: null };
          if (selectCols.includes('qa_score_history')) return { data: { qa_score_history: [] }, error: null };
          return { data: metaRows, error: null };
        }
        return { data: [], error: null };
      }
      if (mode === 'update') { calls.updates.push({ table, payload }); return { error: null }; }
      if (mode === 'insert') { calls.inserts.push({ table, payload }); return { error: null }; }
      if (mode === 'upsert') { calls.upserts.push({ table, payload }); return { error: null }; }
      return { data: null, error: null };
    };
    const b = {
      eq() { return b; },
      like() { return b; },
      in() { return b; },
      maybeSingle() { return Promise.resolve(resolveValue()); },
      then(resolve, reject) { return Promise.resolve(resolveValue()).then(resolve, reject); },
    };
    return b;
  }
  return {
    calls,
    from(table) {
      return {
        select(cols) { return makeBuilder(table, 'select', null, cols || ''); },
        update(p) { return makeBuilder(table, 'update', p); },
        insert(p) { return makeBuilder(table, 'insert', p); },
        upsert(p) { return makeBuilder(table, 'upsert', p); },
      };
    },
    rpc(name, args) {
      calls.rpcs.push({ name, args });
      return Promise.resolve({ data: true, error: null });
    },
  };
}

const terminalUpdates = (db) => db.calls.updates.filter(
  (u) => u.table === 'entity_run_meta' && 'terminal_state' in u.payload
);
const outcomeInserts = (db) => db.calls.inserts.filter(
  (i) => i.table === 'decision_log' && i.payload.decision === 'routing_outcome'
);

// ── The 9821ed56 no-op pass, reproduced exactly ─────────────────────────────

const E2E_ENTITIES = ['Push Gaming', 'PayRetailers', 'Better Collective', 'LeoVegas Group', 'iGP'];

function e2eFixture() {
  return fakeDb({
    routerRows: [
      ...E2E_ENTITIES.map((e) => routerRow(e, 'loop_discovery', QA_FAIL)),
      routerRow('Vixio Regulatory Intelligence', 'approve', QA_PASS),
    ],
    metaRows: [...E2E_ENTITIES, 'Vixio Regulatory Intelligence'].map(metaRow),
  });
}

test('no-op pass: the intended flag-and-continue still executes exactly as before (byte-identity)', async () => {
  const db = e2eFixture();
  const summary = await applyRouting(db, RUN, 7, livePlan());

  // The pre-fix behaviour, unchanged: 5 × flagged/no_card_for_round, 1 × approved,
  // ZERO instruction writes, zero loop consumption — retry stays OFF.
  const terms = terminalUpdates(db);
  assert.equal(terms.filter((u) => u.payload.terminal_state === 'flagged' && u.payload.failure_reason === 'no_card_for_round').length, 5);
  assert.equal(terms.filter((u) => u.payload.terminal_state === 'approved').length, 1);
  assert.equal(db.calls.rpcs.length, 0, 'no append_card_instruction — nothing routes');
  assert.equal(summary.routed_count, 0);
  assert.equal(summary.all_terminal, true);
  assert.equal(summary.earliest_step, null);
  assert.equal(summary.decisions_sent, 6);
  assert.equal(summary.flagged_count, 5);
  assert.equal(summary.approved_count, 1);
});

test('no-op pass: the outcome is RECORDED — decided X, executed nothing, because Y (red on HEAD)', async () => {
  const db = e2eFixture();
  await applyRouting(db, RUN, 7, livePlan());

  // UNDER HEAD: zero decision_log rows — run 9821ed56 recorded nothing and the
  // no-op was only reconstructable from absence. UNDER THE FIX: exactly one
  // queryable outcome row per routing pass.
  const rows = outcomeInserts(db);
  assert.equal(rows.length, 1, 'exactly one routing_outcome row per pass (HEAD wrote 0)');
  const row = rows[0].payload;
  assert.equal(row.run_id, RUN);
  assert.equal(row.step_index, 7);
  assert.equal(row.context.no_op, true, 'the record says nothing executed');
  assert.equal(row.context.routed_count, 0);
  assert.equal(row.context.decisions_sent, 6);
  assert.equal(row.context.flagged_count, 5);
  assert.equal(row.context.approved_count, 1);
  // per-entity: the decision AND why it did not execute
  const flagged = row.context.per_entity.filter((p) => p.failure_reason === 'no_card_for_round');
  assert.equal(flagged.length, 5, 'each flagged entity carries its non-execution reason');
  assert.ok(flagged.every((p) => p.decision === 'loop_discovery'), 'the decided decision is preserved in the record');
  assert.match(row.reason, /no_card_for_round/, 'the human-readable line names the why');
  assert.match(row.reason, /0 routed/, 'the human-readable line names the non-execution');
});

test('flag_manual / failed decisions carry failure_reason into the record', async () => {
  // a 'failed' router decision with a reason, as loop-router emits for dead_site
  const rows = [routerRow('Dead Site Co', 'failed', null)];
  rows[0].output_data.items[0].failure_reason = 'dead_site';
  const db = fakeDb({ routerRows: rows, metaRows: [metaRow('Dead Site Co')] });
  await applyRouting(db, RUN, 7, {});
  const row = outcomeInserts(db)[0].payload;
  assert.equal(row.context.per_entity[0].failure_reason, 'dead_site');
  assert.equal(row.context.per_entity[0].terminal, 'failed');
});

// ── The normally-routed path: byte-identity + outcome ───────────────────────

test('routed pass: append_card_instruction payload is EXACTLY the pre-fix payload (byte-identity)', async () => {
  const db = fakeDb({
    routerRows: [routerRow('Push Gaming', 'loop_generation', QA_FAIL)],
    metaRows: [metaRow('Push Gaming')],
  });
  const summary = await applyRouting(db, RUN, 7, routablePlan());

  assert.equal(db.calls.rpcs.length, 1, 'exactly one instruction write');
  const { name, args } = db.calls.rpcs[0];
  assert.equal(name, 'append_card_instruction');
  assert.equal(args.p_run_id, RUN);
  assert.equal(args.p_entity_name, 'Push Gaming');
  assert.equal(args.p_increment_loop_count, true);
  const instr = args.p_instruction;
  assert.equal(instr.routing_round, 1);
  assert.equal(instr.created_by, 'routingHandler');
  assert.deepEqual(instr.qa_failures, ['hallucination:fail']);
  assert.equal(typeof instr.created_at, 'string');
  assert.deepEqual(instr.targets, [{
    step: 5,
    card_id: CARD_005,
    card_round: 2,
    loop_iteration: 1,
    status: 'pending',
    consumed_at: null,
    skip_reason: null,
  }]);
  assert.equal(summary.routed_count, 1);
  assert.equal(summary.earliest_step, 5);
  assert.equal(summary.all_terminal, false);
});

test('routed pass: the outcome row records the executed route (no_op=false)', async () => {
  const db = fakeDb({
    routerRows: [routerRow('Push Gaming', 'loop_generation', QA_FAIL)],
    metaRows: [metaRow('Push Gaming')],
  });
  await applyRouting(db, RUN, 7, routablePlan());
  const rows = outcomeInserts(db);
  assert.equal(rows.length, 1);
  const row = rows[0].payload;
  assert.equal(row.context.no_op, false);
  assert.equal(row.context.routed_count, 1);
  assert.equal(row.context.earliest_step, 5);
  assert.match(row.reason, /1 routed/);
});

// ── autoExecutor: the state-level half of the record ────────────────────────
// autoExecutor.js cannot be imported in a unit test (it pulls the live redis
// connection at load), so the no-op routing_events push is pinned textually,
// same pattern as the stageWorker structural guards.

test('structural: autoExecutor records a no_op routing event on the all-terminal branch', () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'autoExecutor.js'),
    'utf8'
  );
  const start = src.indexOf('if (summary.all_terminal || summary.routed_count === 0)');
  assert.ok(start > -1, 'the all-terminal branch exists');
  const branch = src.slice(start, src.indexOf('continue;', start));
  assert.match(branch, /routing_events\.push\(/,
    'the all-terminal branch must push a routing event — under HEAD it only console.logged, leaving routing_events [] (run 9821ed56)');
  assert.match(branch, /no_op: true/, 'the event is explicitly marked as a no-op');
});
