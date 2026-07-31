/**
 * Hermetic tests for the U6 read-only workbench browse routes
 * (GET /api/workbench/source-runs, GET /api/workbench/source-runs/:runId).
 * Core assertion: these routes issue ZERO write operations — they exist
 * precisely because the runs.js step-detail GET lazy-writes pipeline_stages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createWorkbenchRouter } from '../routes/workbench.js';

// Same mock-supabase pattern as workbenchExperiments.test.mjs.
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

const WRITE_METHODS = ['insert', 'update', 'upsert', 'delete'];

async function drive(respond, url) {
  const { db, calls } = makeMockDb(respond);
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({ db, runSubmodule: async () => { throw new Error('must not run'); }, getManifest: () => null }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
    return { status: res.status, body: await res.json(), calls };
  } finally {
    server.close();
  }
}

test('GET /source-runs lists terminal runs with project + entity names, zero writes', async () => {
  const { status, body, calls } = await drive((rec) => {
    if (rec.table === 'pipeline_runs') return { data: [
      { id: 'r2', status: 'archived', project_id: 'p1', started_at: '2026-07-20', completed_at: '2026-07-20' },
      { id: 'r1', status: 'completed', project_id: 'p1', started_at: '2026-07-10', completed_at: '2026-07-10' },
    ], error: null };
    if (rec.table === 'projects') return { data: [{ id: 'p1', name: 'Acme' }], error: null };
    if (rec.table === 'entity_stage_pool') return { data: [
      { run_id: 'r2', entity_name: 'Beta' }, { run_id: 'r2', entity_name: 'Alpha' }, { run_id: 'r2', entity_name: 'Alpha' },
    ], error: null };
    return { data: [], error: null };
  }, '/api/workbench/source-runs');

  assert.equal(status, 200);
  assert.equal(body.length, 2);
  assert.equal(body[0].id, 'r2');
  assert.equal(body[0].project_name, 'Acme');
  assert.deepEqual(body[0].entity_names, ['Alpha', 'Beta']);
  assert.deepEqual(body[1].entity_names, []);
  assert.deepEqual(calls.filter(c => c.methods.some(m => WRITE_METHODS.includes(m))), []);
});

test('GET /source-runs/:runId builds the step tree, zero writes', async () => {
  const { status, body, calls } = await drive((rec) => {
    if (rec.table === 'pipeline_runs') return { data: { id: 'r1', status: 'completed', project_id: 'p1' }, error: null };
    if (rec.table === 'run_submodule_config') return { data: [
      { step_index: 5, submodule_id: 'content-writer', options: { model: 'haiku' } },
      { step_index: 6, submodule_id: 'meta-compliance-checker', options: {} },
    ], error: null };
    if (rec.table === 'submodule_runs') return { data: [
      { step_index: 6, submodule_id: 'meta-compliance-checker' },
      { step_index: 6, submodule_id: 'tone-seo-editor' },
    ], error: null };
    if (rec.table === 'entity_stage_pool') return { data: [
      { step_index: 5, entity_name: 'Acme' }, { step_index: 6, entity_name: 'Acme' },
    ], error: null };
    return { data: [], error: null };
  }, '/api/workbench/source-runs/r1');

  assert.equal(status, 200);
  assert.deepEqual(body.steps.map(s => s.step_index), [5, 6]);
  const s6 = body.steps.find(s => s.step_index === 6);
  assert.deepEqual(s6.submodules.map(m => [m.submodule_id, m.ran]), [
    ['meta-compliance-checker', true], ['tone-seo-editor', true],
  ]);
  const s5 = body.steps.find(s => s.step_index === 5);
  assert.deepEqual(s5.submodules[0], { submodule_id: 'content-writer', options: { model: 'haiku' }, ran: false });
  assert.deepEqual(s5.entities, ['Acme']);
  assert.deepEqual(calls.filter(c => c.methods.some(m => WRITE_METHODS.includes(m))), []);
});

test('GET /source-runs/:runId 404s on unknown run without writing', async () => {
  const { status, calls } = await drive((rec) =>
    rec.table === 'pipeline_runs' ? { data: null, error: null } : { data: [], error: null },
  '/api/workbench/source-runs/nope');
  assert.equal(status, 404);
  assert.deepEqual(calls.filter(c => c.methods.some(m => WRITE_METHODS.includes(m))), []);
});
