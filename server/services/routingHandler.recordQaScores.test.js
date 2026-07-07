/**
 * Tests for routingHandler.recordQaScores — the QA-score persistence write that
 * was DROPPED when Section C (2026-06-04, commit be07509) replaced the
 * apply_entity_routing RPC with JS routing. That RPC recorded QA scores to
 * entity_run_meta (migration_move_routing_to_step7.sql:169-180):
 *   - last_qa_scores   ← latest scores object (overwrite)
 *   - qa_score_history ← APPEND { iteration, scores, timestamp }
 * The columns still exist (migration_routing.sql:18-19); only the writer was
 * lost. recordQaScores restores it as a purely additive JS write.
 *
 * These tests pin the CONTRACT: writes both columns when scores are present,
 * APPENDS history (never overwrites prior entries), and is defensive — a
 * missing / null / malformed score is a no-op (no garbage row), and no DB
 * failure (read {error}, write {error}, or a thrown exception) may crash the
 * caller. Quality history is a side-record, never load-bearing.
 *
 * The DB is faked at the supabase-js chain boundary (from().select().eq().eq()
 * .maybeSingle() for the read; from().update().eq().eq() awaited for the
 * write). Assertions are on the REAL recordQaScores logic — the payload it
 * constructs and whether it writes at all — not on the mock.
 *
 * Run via: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordQaScores } from './routingHandler.js';

const RUN = '11111111-1111-1111-1111-111111111111';
const ENTITY = 'Pronet Gaming';

/**
 * Minimal supabase-js fake supporting exactly the two chains recordQaScores uses:
 *   read : db.from(t).select(c).eq().eq().maybeSingle()  → resolves readResult
 *   write: db.from(t).update(p).eq().eq()  (awaited)      → resolves writeResult, records p
 * `calls.reads` / `calls.updates` let tests assert whether each happened.
 */
function fakeDb({
  readResult = { data: { qa_score_history: [] }, error: null },
  writeResult = { error: null },
} = {}) {
  const calls = { reads: 0, updates: [] };
  const builder = (mode, payload) => {
    const b = {
      eq() { return b; },
      maybeSingle() {
        calls.reads += 1;
        return Promise.resolve(readResult);
      },
      then(resolve, reject) {
        if (mode === 'update') calls.updates.push(payload);
        return Promise.resolve(mode === 'update' ? writeResult : readResult)
          .then(resolve, reject);
      },
    };
    return b;
  };
  return {
    calls,
    from() {
      return {
        select() { return builder('select'); },
        update(payload) { return builder('update', payload); },
      };
    },
  };
}

// ── writes both columns ──────────────────────────────────────────────────────

test('recordQaScores: valid scores write last_qa_scores AND append to qa_score_history', async () => {
  const db = fakeDb();
  const scores = { keyword: 0.85, meta: 1.0, citation: 0.72, hallucination: 0.95 };

  await recordQaScores(db, RUN, ENTITY, scores, 0);

  assert.equal(db.calls.updates.length, 1, 'exactly one update');
  const payload = db.calls.updates[0];
  assert.deepEqual(payload.last_qa_scores, scores, 'last_qa_scores = latest scores');
  assert.ok(Array.isArray(payload.qa_score_history), 'qa_score_history is an array');
  assert.equal(payload.qa_score_history.length, 1, 'one history entry appended');
  const entry = payload.qa_score_history[0];
  assert.deepEqual(entry.scores, scores, 'entry.scores = scores');
  assert.equal(entry.iteration, 0, 'entry.iteration = passed iteration');
  assert.equal(typeof entry.timestamp, 'string', 'entry.timestamp is an ISO string');
  assert.ok(!Number.isNaN(Date.parse(entry.timestamp)), 'timestamp parses as a date');
});

test('recordQaScores: iteration is recorded from the argument (not hardcoded)', async () => {
  const db = fakeDb();
  await recordQaScores(db, RUN, ENTITY, { citation: 'fail' }, 2);
  assert.equal(db.calls.updates[0].qa_score_history[0].iteration, 2);
});

// ── appends, never overwrites ────────────────────────────────────────────────

test('recordQaScores: appends to existing history rather than overwriting it', async () => {
  const prior = { iteration: 0, scores: { citation: 0.5 }, timestamp: '2026-07-01T00:00:00.000Z' };
  const db = fakeDb({ readResult: { data: { qa_score_history: [prior] }, error: null } });

  await recordQaScores(db, RUN, ENTITY, { citation: 0.9 }, 1);

  const history = db.calls.updates[0].qa_score_history;
  assert.equal(history.length, 2, 'existing entry preserved + new one appended');
  assert.deepEqual(history[0], prior, 'prior entry unchanged and first');
  assert.deepEqual(history[1].scores, { citation: 0.9 }, 'new entry appended last');
  assert.equal(history[1].iteration, 1);
});

test('recordQaScores: null/missing existing history is treated as an empty array', async () => {
  const db = fakeDb({ readResult: { data: { qa_score_history: null }, error: null } });
  await recordQaScores(db, RUN, ENTITY, { meta: 1.0 }, 0);
  assert.equal(db.calls.updates[0].qa_score_history.length, 1);
});

// ── no scores / malformed → no write, no crash ───────────────────────────────

test('recordQaScores: null scores → no read, no write, no throw', async () => {
  const db = fakeDb();
  await assert.doesNotReject(() => recordQaScores(db, RUN, ENTITY, null, 0));
  assert.equal(db.calls.updates.length, 0, 'no update on null scores');
  assert.equal(db.calls.reads, 0, 'no read on null scores');
});

test('recordQaScores: undefined scores → no write, no throw', async () => {
  const db = fakeDb();
  await assert.doesNotReject(() => recordQaScores(db, RUN, ENTITY, undefined, 0));
  assert.equal(db.calls.updates.length, 0);
});

test('recordQaScores: empty object {} → no write (nothing meaningful to record)', async () => {
  const db = fakeDb();
  await recordQaScores(db, RUN, ENTITY, {}, 0);
  assert.equal(db.calls.updates.length, 0);
});

test('recordQaScores: malformed scores (array / string / number) → no write, no throw', async () => {
  for (const bad of [[1, 2, 3], 'fail', 42, true]) {
    const db = fakeDb();
    await assert.doesNotReject(() => recordQaScores(db, RUN, ENTITY, bad, 0));
    assert.equal(db.calls.updates.length, 0, `no update for ${JSON.stringify(bad)}`);
  }
});

// ── DB failures are non-fatal ────────────────────────────────────────────────

test('recordQaScores: a read {error} is non-fatal — no update, no throw', async () => {
  const db = fakeDb({ readResult: { data: null, error: { message: 'read boom' } } });
  await assert.doesNotReject(() => recordQaScores(db, RUN, ENTITY, { citation: 0.1 }, 0));
  assert.equal(db.calls.updates.length, 0, 'no update attempted after read failure');
});

test('recordQaScores: a write {error} is non-fatal — attempted but never throws', async () => {
  const db = fakeDb({ writeResult: { error: { message: 'write boom' } } });
  await assert.doesNotReject(() => recordQaScores(db, RUN, ENTITY, { citation: 0.1 }, 0));
  assert.equal(db.calls.updates.length, 1, 'update was attempted');
});

test('recordQaScores: a thrown DB exception is swallowed, never crashes the caller', async () => {
  const throwingDb = { from() { throw new Error('connection reset'); } };
  await assert.doesNotReject(() => recordQaScores(throwingDb, RUN, ENTITY, { citation: 0.1 }, 0));
});
