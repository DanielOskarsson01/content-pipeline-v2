/**
 * Hermetic tests for POST /api/workbench/source-runs/:runId/pin (T5).
 * The pin is the workbench's one sanctioned real-run write besides
 * workbench_experiments inserts: idempotent status='archived' on terminal
 * runs only — identical semantics to the experiment path's own pin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createWorkbenchRouter } from '../routes/workbench.js';

// Same mock-supabase pattern as workbenchSourceRuns.test.mjs.
function makeMockDb(respond) {
  const calls = [];
  function builder(table) {
    const record = { table, methods: [], args: [] };
    calls.push(record);
    const b = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update', 'insert', 'upsert', 'delete']) {
      b[m] = (...a) => { record.methods.push(m); record.args.push(a); return b; };
    }
    const resolve = () => Promise.resolve(respond(record));
    b.maybeSingle = () => { record.methods.push('maybeSingle'); return resolve(); };
    b.single = () => { record.methods.push('single'); return resolve(); };
    b.then = (ok, err) => resolve().then(ok, err);
    return b;
  }
  return { db: { from: builder }, calls };
}

async function drivePin(respond, runId) {
  const { db, calls } = makeMockDb(respond);
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({ db, runSubmodule: async () => { throw new Error('must not run'); }, getManifest: () => null }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/workbench/source-runs/${runId}/pin`, { method: 'POST' });
    return { status: res.status, body: await res.json(), calls };
  } finally {
    server.close();
  }
}

const updates = (calls) => calls.filter(c => c.methods.includes('update'));

test('pin flips a completed run to archived (exactly one update)', async () => {
  const { status, body, calls } = await drivePin((rec) => {
    if (rec.table === 'pipeline_runs' && rec.methods.includes('update')) return { data: null, error: null };
    if (rec.table === 'pipeline_runs') return { data: { id: 'r1', status: 'completed' }, error: null };
    return { data: [], error: null };
  }, 'r1');
  assert.equal(status, 200);
  assert.deepEqual(body, { pinned: true, previous_status: 'completed' });
  const ups = updates(calls);
  assert.equal(ups.length, 1);
  assert.deepEqual(ups[0].args[ups[0].methods.indexOf('update')], [{ status: 'archived' }]);
});

test('pin is idempotent — archived run answers 200 with zero writes', async () => {
  const { status, body, calls } = await drivePin((rec) => {
    if (rec.table === 'pipeline_runs') return { data: { id: 'r1', status: 'archived' }, error: null };
    return { data: [], error: null };
  }, 'r1');
  assert.equal(status, 200);
  assert.deepEqual(body, { pinned: true, previous_status: 'archived' });
  assert.equal(updates(calls).length, 0);
});

test('pin refuses a non-terminal run (400, zero writes)', async () => {
  const { status, body, calls } = await drivePin((rec) => {
    if (rec.table === 'pipeline_runs') return { data: { id: 'r1', status: 'auto_executing' }, error: null };
    return { data: [], error: null };
  }, 'r1');
  assert.equal(status, 400);
  assert.match(body.error, /auto_executing/);
  assert.equal(updates(calls).length, 0);
});

test('pin 404s on unknown run without writing', async () => {
  const { status, calls } = await drivePin((rec) => {
    if (rec.table === 'pipeline_runs') return { data: null, error: null };
    return { data: [], error: null };
  }, 'nope');
  assert.equal(status, 404);
  assert.equal(updates(calls).length, 0);
});
