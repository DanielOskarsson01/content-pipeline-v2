/**
 * Hermetic tests for workbench U3 (DAO) + U4 (endpoint) — no real db, no
 * modules repo, no network. The core assertion is the NO-WRITE CONTRACT:
 * an experiment must never write submodule_runs, entity_submodule_runs,
 * run_submodule_config, entity_stage_pool, submodule_run_item_data, or
 * pool_item_blobs (the /run endpoint's pollution the workbench exists to avoid).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { insertExperiment, listExperiments } from '../services/workbenchExperiments.js';
import { createWorkbenchRouter } from '../routes/workbench.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- mock supabase client ----------
// Records every builder chain as { table, methods: [name...], args } and lets
// the test script responses per table. Builders are thenables like the real
// client, so `await db.from(x).update().eq()` works.
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
const FORBIDDEN_TABLES = [
  'submodule_runs', 'entity_submodule_runs', 'run_submodule_config',
  'entity_stage_pool', 'submodule_run_item_data', 'pool_item_blobs',
];
function writesTo(calls) {
  return calls
    .filter(c => c.methods.some(m => WRITE_METHODS.includes(m)))
    .map(c => c.table);
}

// ---------- DAO ----------
test('DAO insert + list round-trip against mock db', async () => {
  const row = { source_run_id: 'r1', step_index: 5, submodule_id: 'x', entity_name: 'E' };
  const { db, calls } = makeMockDb((rec) =>
    rec.table === 'workbench_experiments' ? { data: rec.methods.includes('insert') ? { id: 'new', ...row } : [{ id: 'new' }], error: null } : { data: null, error: null });

  const inserted = await insertExperiment(row, db);
  assert.equal(inserted.id, 'new');
  const listed = await listExperiments({ source_run_id: 'r1', step_index: 5, submodule_id: 'x', entity_name: 'E' }, db);
  assert.equal(listed.length, 1);
  assert.deepEqual([...new Set(calls.map(c => c.table))], ['workbench_experiments']);
});

test('DAO throws loud on insert error', async () => {
  const { db } = makeMockDb(() => ({ data: null, error: { message: 'boom' } }));
  await assert.rejects(() => insertExperiment({}, db), /workbench_experiments insert failed: boom/);
});

// ---------- retention guard (spec U3: NOT in RUN_ID_TABLES) ----------
test('workbench_experiments is absent from retention.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/retention.js'), 'utf8');
  assert.ok(!src.includes('workbench_experiments'), 'workbench_experiments must never enter retention');
});

// ---------- endpoint harness ----------
async function driveEndpoint({ respond, runSubmodule, body }) {
  const { db, calls } = makeMockDb(respond);
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({
    db,
    runSubmodule,
    getManifest: (id) => (id === 'known-sub' ? { id, options_defaults: { a: 1 }, options: [] } : null),
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://localhost:${server.address().port}/api/workbench/experiments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json(), calls };
  } finally {
    server.close();
  }
}

const GOOD_BODY = { source_run_id: 'run-1', step_index: 5, submodule_id: 'known-sub', entity_name: 'E', overrides: { max_tokens: 7 } };

function respondCompleted(rec) {
  if (rec.table === 'pipeline_runs' && rec.methods.includes('select')) return { data: { id: 'run-1', status: 'completed' }, error: null };
  if (rec.table === 'pipeline_runs') return { data: null, error: null }; // the pin update
  if (rec.table === 'run_submodule_config') return { data: { options: { b: 2 } }, error: null };
  if (rec.table === 'entity_stage_pool') return { data: { pool_items: [{ url: 'u' }] }, error: null };
  if (rec.table === 'workbench_experiments') return { data: { id: 'exp-1' }, error: null };
  throw new Error(`unexpected table ${rec.table}`);
}

const okRunSubmodule = async (spec) => ({
  resolvedOptions: spec.options,
  result: { items: [{ ok: true }], meta: { ai_usage: { tokens_out_total: 7 } } },
});

test('endpoint: happy path writes ONLY pipeline_runs pin + workbench_experiments', async () => {
  let harnessSpec;
  const { status, json, calls } = await driveEndpoint({
    respond: respondCompleted,
    runSubmodule: async (spec, deps) => { harnessSpec = spec; return okRunSubmodule(spec, deps); },
    body: GOOD_BODY,
  });
  assert.equal(status, 201);
  assert.equal(json.experiment.id, 'exp-1');
  assert.ok(json.replay_fidelity.includes('not a byte-frozen snapshot'));
  // the workbench edit surface actually reached the harness options
  assert.equal(harnessSpec.options.max_tokens, 7);
  assert.equal(harnessSpec.options.b, 2);       // saved run config
  assert.equal(harnessSpec.options.a, 1);       // manifest default
  assert.equal(harnessSpec.hydrate, true);
  // THE no-write contract
  const writes = writesTo(calls);
  assert.deepEqual(writes.sort(), ['pipeline_runs', 'workbench_experiments']);
  for (const t of FORBIDDEN_TABLES) assert.ok(!writes.includes(t), `wrote forbidden table ${t}`);
});

test('endpoint: archived run is NOT re-pinned (idempotent) and still no forbidden writes', async () => {
  const { status, calls } = await driveEndpoint({
    respond: (rec) => rec.table === 'pipeline_runs'
      ? { data: { id: 'run-1', status: 'archived' }, error: null }
      : respondCompleted(rec),
    runSubmodule: okRunSubmodule,
    body: GOOD_BODY,
  });
  assert.equal(status, 201);
  assert.deepEqual(writesTo(calls), ['workbench_experiments']);
});

test('endpoint: refuses non-terminal runs', async () => {
  const { status, json, calls } = await driveEndpoint({
    respond: (rec) => ({ data: { id: 'run-1', status: 'auto_executing' }, error: null }),
    runSubmodule: okRunSubmodule,
    body: GOOD_BODY,
  });
  assert.equal(status, 400);
  assert.match(json.error, /terminal/);
  assert.deepEqual(writesTo(calls), []);
});

test('endpoint: 400 on missing fields, no db touched', async () => {
  const { status, calls } = await driveEndpoint({ respond: respondCompleted, runSubmodule: okRunSubmodule, body: { submodule_id: 'known-sub' } });
  assert.equal(status, 400);
  assert.equal(calls.length, 0);
});

test('endpoint: harness failure records an error experiment, still no forbidden writes', async () => {
  const { status, json, calls } = await driveEndpoint({
    respond: respondCompleted,
    runSubmodule: async () => { throw new Error('module exploded'); },
    body: GOOD_BODY,
  });
  assert.equal(status, 500);
  assert.match(json.error, /module exploded/);
  assert.ok(json.experiment); // provenance row still written
  const writes = writesTo(calls);
  assert.deepEqual(writes.sort(), ['pipeline_runs', 'workbench_experiments']);
});

test('endpoint: truncated result (meta.status error) stored as status error', async () => {
  let insertedRow;
  const { status } = await driveEndpoint({
    respond: (rec) => {
      if (rec.table === 'workbench_experiments' && rec.methods.includes('insert')) insertedRow = rec.args[0][0];
      return respondCompleted(rec);
    },
    runSubmodule: async (spec) => ({
      resolvedOptions: spec.options,
      result: { items: [], meta: { status: 'error', error: 'truncated', ai_usage: {} } },
    }),
    body: GOOD_BODY,
  });
  assert.equal(status, 201);
  assert.equal(insertedRow.status, 'error');
  assert.equal(insertedRow.error, 'truncated');
});
