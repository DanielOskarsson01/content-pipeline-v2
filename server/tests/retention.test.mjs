/**
 * Hermetic tests for the stale-attended retention pass
 * (server/services/retention.js: sweepStaleAttendedRuns + isStaleAttended).
 *
 * No network, no real DB: an injected recording mock db supplies runs +
 * entity_submodule_runs rows and captures every write. The pass must abandon a
 * genuinely idle attended run, spare a run with recent activity, spare a run
 * with a live queue job (non-terminal entity_submodule_run) however old it is,
 * respect the threshold boundary, and NEVER delete.
 *
 * Run: node --test server/tests/retention.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// db.js (imported by retention.js → abandonRun.js) throws without these.
// Dummy values — every test injects a mock db; no real Supabase call happens.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://hermetic-test.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'hermetic-test-key';

const { sweepStaleAttendedRuns, isStaleAttended } = await import('../services/retention.js');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-03T08:49:35Z');
const iso = (ms) => new Date(ms).toISOString();

// Recording mock db — same shape as workbenchSourceRuns.test.mjs, with per-run
// entity_submodule_runs responses keyed on the eq('run_id', …) argument.
function makeMockDb(cfg) {
  const calls = [];
  function respond(rec) {
    const runId = (rec.args.find((a) => a[0] === 'run_id') || [])[1];
    if (rec.table === 'pipeline_runs') {
      if (rec.methods.includes('update')) return { data: null, error: null };
      return { data: cfg.runs, error: null };
    }
    if (rec.table === 'entity_submodule_runs') return { data: cfg.esr?.[runId] || [], error: null };
    if (rec.table === 'submodule_runs') return { data: cfg.sr?.[runId] || [], error: null };
    if (rec.table === 'decision_log') {
      if (rec.methods.includes('insert')) return { data: null, error: null };
      return { data: cfg.dl?.[runId] || [], error: null };
    }
    return { data: [], error: null };
  }
  function builder(table) {
    const record = { table, methods: [], args: [] };
    calls.push(record);
    const b = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update', 'insert', 'upsert', 'delete']) {
      b[m] = (...a) => { record.methods.push(m); record.args.push(a); return b; };
    }
    const resolve = () => Promise.resolve(respond(record));
    b.single = () => { record.methods.push('single'); return resolve(); };
    b.maybeSingle = () => { record.methods.push('maybeSingle'); return resolve(); };
    b.then = (ok, err) => resolve().then(ok, err);
    return b;
  }
  return { db: { from: builder }, calls };
}

const abandonedIds = (calls) => calls
  .filter((c) => c.table === 'pipeline_runs' && c.methods.includes('update'))
  .map((c) => (c.args.find((a) => a[0] === 'id') || [])[1]);

const abandonPayloads = (calls) => calls
  .filter((c) => c.table === 'pipeline_runs' && c.methods.includes('update'))
  .map((c) => (c.args.find((a) => a[0] && typeof a[0] === 'object') || [])[0]);

const decisionInserts = (calls) => calls.filter((c) => c.table === 'decision_log' && c.methods.includes('insert'));
const anyDelete = (calls) => calls.some((c) => c.methods.includes('delete'));

// ── sweep behaviour (mock db) ────────────────────────────────────────────────

test('a genuinely idle attended run (no submodule activity, old) is abandoned', async () => {
  const { db, calls } = makeMockDb({
    runs: [{ id: 'idle-1', status: 'running', started_at: iso(NOW - 20 * DAY) }],
    esr: { 'idle-1': [] }, // never executed a submodule — like the 2026-07-17 debris
  });
  const n = await sweepStaleAttendedRuns({ db, now: NOW });
  assert.equal(n, 1);
  assert.deepEqual(abandonedIds(calls), ['idle-1']);
  assert.equal(abandonPayloads(calls)[0].status, 'abandoned');
  assert.ok(abandonPayloads(calls)[0].completed_at, 'completed_at is set');
  assert.equal(decisionInserts(calls).length, 1, 'one decision_log entry written');
  assert.equal(anyDelete(calls), false, 'the pass NEVER deletes');
});

test('a run with recent submodule activity is spared, however old the run is', async () => {
  const { db, calls } = makeMockDb({
    runs: [{ id: 'recent-1', status: 'running', started_at: iso(NOW - 40 * DAY) }],
    esr: { 'recent-1': [
      { status: 'completed', started_at: iso(NOW - 40 * DAY), completed_at: iso(NOW - 1 * HOUR) },
    ] },
  });
  const n = await sweepStaleAttendedRuns({ db, now: NOW });
  assert.equal(n, 0);
  assert.deepEqual(abandonedIds(calls), []);
});

test('a run with a live queue job (non-terminal entity_submodule_run) is spared, however old', async () => {
  const { db, calls } = makeMockDb({
    runs: [{ id: 'live-1', status: 'running', started_at: iso(NOW - 40 * DAY) }],
    esr: { 'live-1': [
      { status: 'running', started_at: iso(NOW - 40 * DAY), completed_at: null }, // in flight
    ] },
  });
  const n = await sweepStaleAttendedRuns({ db, now: NOW });
  assert.equal(n, 0, 'a live job blocks abandonment even for an ancient run');
  assert.deepEqual(abandonedIds(calls), []);
});

test('a run whose only recent activity is a decision-log entry (mid-review) is spared', async () => {
  const { db, calls } = makeMockDb({
    runs: [{ id: 'review-1', status: 'running', started_at: iso(NOW - 40 * DAY) }],
    esr: { 'review-1': [{ status: 'approved', started_at: iso(NOW - 40 * DAY), completed_at: iso(NOW - 30 * DAY) }] },
    dl: { 'review-1': [{ decided_at: iso(NOW - 2 * HOUR) }] }, // a human approved a step 2h ago
  });
  const n = await sweepStaleAttendedRuns({ db, now: NOW });
  assert.equal(n, 0, 'a human decision within the window resets the idle clock');
  assert.deepEqual(abandonedIds(calls), []);
});

test('a run with a live (non-terminal) submodule_runs batch is spared, however old', async () => {
  const { db, calls } = makeMockDb({
    runs: [{ id: 'batch-1', status: 'running', started_at: iso(NOW - 40 * DAY) }],
    esr: { 'batch-1': [] },
    sr: { 'batch-1': [{ status: 'running', started_at: iso(NOW - 40 * DAY), completed_at: null }] },
  });
  const n = await sweepStaleAttendedRuns({ db, now: NOW });
  assert.equal(n, 0, 'a non-terminal batch run blocks abandonment');
  assert.deepEqual(abandonedIds(calls), []);
});

test('threshold boundary: just over 14d idle is abandoned, just under 14d is spared', async () => {
  const { db, calls } = makeMockDb({
    runs: [
      { id: 'over', status: 'running', started_at: iso(NOW - (14 * DAY + 1 * HOUR)) },
      { id: 'under', status: 'running', started_at: iso(NOW - (14 * DAY - 1 * HOUR)) },
    ],
    esr: { over: [], under: [] },
  });
  const n = await sweepStaleAttendedRuns({ db, now: NOW });
  assert.equal(n, 1);
  assert.deepEqual(abandonedIds(calls), ['over']);
});

// ── pure decision (isStaleAttended) ──────────────────────────────────────────

test('isStaleAttended: live work is never stale, even when ancient', () => {
  const run = { started_at: iso(NOW - 365 * DAY) };
  assert.equal(isStaleAttended(run, { hasLiveWork: true, lastActivityMs: null }, NOW), false);
});

test('isStaleAttended: recent activity is never stale', () => {
  const run = { started_at: iso(NOW - 365 * DAY) };
  assert.equal(isStaleAttended(run, { hasLiveWork: false, lastActivityMs: NOW - 1 * 60 * 1000 }, NOW), false);
});

test('isStaleAttended: old, quiet, no live work → stale', () => {
  const run = { started_at: iso(NOW - 20 * DAY) };
  assert.equal(isStaleAttended(run, { hasLiveWork: false, lastActivityMs: NOW - 20 * DAY }, NOW), true);
});
