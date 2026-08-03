/**
 * Hermetic tests for tuning-session state + erase-downstream (TUNING-SESSIONS v1 T1).
 *
 * Uses a REAL in-memory fake db (not a call-recorder) so the assertions check the
 * resulting ROW STATE — the actual T1 acceptance: accept 5,6,7 -> three steps;
 * re-accept 5 -> one step; workbench_experiments count unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getOrCreateSession, getSessionSteps, getAcceptedUpstream, acceptExperiment,
} from '../services/tuningSessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const silent = { warn() {}, log() {} };

// ---------- in-memory fake supabase client (real filter/insert/upsert/delete) ----------
function makeFakeDb(seed = {}) {
  const tables = {
    tuning_sessions: [...(seed.tuning_sessions || [])],
    tuning_session_steps: [...(seed.tuning_session_steps || [])],
    workbench_experiments: [...(seed.workbench_experiments || [])],
  };
  let idc = 0;
  const genId = (p) => `${p}-${++idc}`;

  function from(table) {
    if (!tables[table]) tables[table] = [];
    const filters = [];
    let op = 'select', payload = null, conflict = null, orderCol = null, orderAsc = true;
    const match = (r) => filters.every(f =>
      f.op === 'eq' ? r[f.col] === f.val : f.op === 'gt' ? r[f.col] > f.val : true);

    function run({ single = false } = {}) {
      if (op === 'insert') {
        const row = { id: genId(table), created_at: 't0', updated_at: 't0', ...payload };
        if (table === 'tuning_sessions' &&
            tables[table].some(r => r.source_run_id === row.source_run_id && r.entity_name === row.entity_name)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        tables[table].push(row);
        return single ? { data: row, error: null } : { data: [row], error: null };
      }
      if (op === 'upsert') {
        const keys = (conflict || '').split(',').map(s => s.trim());
        const existing = tables[table].find(r => keys.every(k => r[k] === payload[k]));
        if (existing) Object.assign(existing, payload);
        else tables[table].push({ id: genId(table), ...payload });
        return { data: null, error: null };
      }
      if (op === 'update') {
        for (const r of tables[table].filter(match)) Object.assign(r, payload);
        return { data: null, error: null };
      }
      if (op === 'delete') {
        tables[table] = tables[table].filter(r => !match(r));
        return { data: null, error: null };
      }
      let out = tables[table].filter(match);
      if (orderCol) out = [...out].sort((a, b2) => (a[orderCol] - b2[orderCol]) * (orderAsc ? 1 : -1));
      return single ? { data: out[0] || null, error: null } : { data: out, error: null };
    }

    const b = {
      select() { return b; },
      insert(p) { op = 'insert'; payload = p; return b; },
      update(p) { op = 'update'; payload = p; return b; },
      upsert(p, opts) { op = 'upsert'; payload = p; conflict = opts?.onConflict; return b; },
      delete() { op = 'delete'; return b; },
      eq(col, val) { filters.push({ col, op: 'eq', val }); return b; },
      gt(col, val) { filters.push({ col, op: 'gt', val }); return b; },
      order(col, opts) { orderCol = col; orderAsc = opts?.ascending !== false; return b; },
      maybeSingle() { return Promise.resolve(run({ single: true })); },
      single() { return Promise.resolve(run({ single: true })); },
      then(res, rej) { return Promise.resolve(run({})).then(res, rej); },
    };
    return b;
  }
  return { db: { from }, tables };
}

// ---------- T1 acceptance ----------
test('T1: accept 5,6,7 -> 3 steps; re-accept 5 -> 1 step; experiments untouched', async () => {
  const { db, tables } = makeFakeDb({
    workbench_experiments: [{ id: 'e5' }, { id: 'e5b' }, { id: 'e6' }, { id: 'e7' }],
  });
  const wbBefore = tables.workbench_experiments.length;

  const session = await getOrCreateSession('run-1', 'Hacksawgaming', db);
  await acceptExperiment({ sessionId: session.id, stepIndex: 5, experimentId: 'e5', submoduleId: 'content-writer' }, db, silent);
  await acceptExperiment({ sessionId: session.id, stepIndex: 6, experimentId: 'e6', submoduleId: 'qa-structural' }, db, silent);
  await acceptExperiment({ sessionId: session.id, stepIndex: 7, experimentId: 'e7', submoduleId: 'loop-router' }, db, silent);

  let steps = await getSessionSteps(session.id, db);
  assert.deepEqual(steps.map(s => s.step_index), [5, 6, 7], 'three accepted steps');

  const { erased } = await acceptExperiment(
    { sessionId: session.id, stepIndex: 5, experimentId: 'e5b', submoduleId: 'content-writer' }, db, silent);
  assert.deepEqual(erased.map(e => e.step_index).sort(), [6, 7], 're-accepting step 5 erases 6 and 7');

  steps = await getSessionSteps(session.id, db);
  assert.equal(steps.length, 1, 'only step 5 remains');
  assert.equal(steps[0].step_index, 5);
  assert.equal(steps[0].experiment_id, 'e5b', 'step 5 replaced, not duplicated');

  assert.equal(tables.workbench_experiments.length, wbBefore, 'workbench_experiments count UNCHANGED');
});

// ---------- one live session per (run, entity) ----------
test('T1: getOrCreateSession is idempotent per (run, entity)', async () => {
  const { db, tables } = makeFakeDb();
  const a = await getOrCreateSession('run-1', 'E', db);
  const b = await getOrCreateSession('run-1', 'E', db);
  assert.equal(a.id, b.id, 'same session reused');
  assert.equal(tables.tuning_sessions.length, 1, 'no duplicate session row');
  const c = await getOrCreateSession('run-1', 'Other', db);
  assert.notEqual(c.id, a.id, 'different entity -> different session');
});

// ---------- chain-from-accepted parent lookup (feeds T2) ----------
test('T1: getAcceptedUpstream returns the nearest accepted step below', async () => {
  const { db } = makeFakeDb();
  const s = await getOrCreateSession('run-1', 'E', db);
  await acceptExperiment({ sessionId: s.id, stepIndex: 5, experimentId: 'e5', submoduleId: 'content-writer' }, db, silent);
  await acceptExperiment({ sessionId: s.id, stepIndex: 6, experimentId: 'e6', submoduleId: 'qa-structural' }, db, silent);
  assert.equal((await getAcceptedUpstream(s.id, 7, db)).experiment_id, 'e6', 'below 7 -> step 6');
  assert.equal((await getAcceptedUpstream(s.id, 6, db)).experiment_id, 'e5', 'below 6 -> step 5');
  assert.equal(await getAcceptedUpstream(s.id, 5, db), null, 'nothing below 5');
});

// ---------- erase is logged loudly ----------
test('T1: erase-downstream is logged loudly with what was cleared', async () => {
  const { db } = makeFakeDb();
  const logs = [];
  const log = { warn: (m) => logs.push(m) };
  const s = await getOrCreateSession('run-1', 'E', db);
  await acceptExperiment({ sessionId: s.id, stepIndex: 5, experimentId: 'e5', submoduleId: 'content-writer' }, db, silent);
  await acceptExperiment({ sessionId: s.id, stepIndex: 6, experimentId: 'e6', submoduleId: 'qa-structural' }, db, silent);
  await acceptExperiment({ sessionId: s.id, stepIndex: 5, experimentId: 'e5b', submoduleId: 'content-writer' }, db, log);
  const joined = logs.join('\n');
  assert.match(joined, /ERASED 1 downstream/);
  assert.match(joined, /s6:e6/, 'names the cleared step + experiment');
});

// ---------- retention guard: these tables must NEVER be swept ----------
test('T1: tuning session tables are absent from retention.js RUN_ID_TABLES', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/retention.js'), 'utf8');
  assert.ok(!src.includes('tuning_session'), 'tuning session tables must never enter retention');
});
