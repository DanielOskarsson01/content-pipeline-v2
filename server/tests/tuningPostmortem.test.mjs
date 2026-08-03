/**
 * Hermetic tests for tuning postmortems (TUNING-SESSIONS v1 T5 + T6 summary data).
 *
 * Proves: the digest is fixed-schema, carries per-attempt METRICS only (no
 * article body, few KB), flags the accepted attempt (discarded vs accepted),
 * grows as steps are accepted, is comparable across sessions, and the filesystem
 * store round-trips atomically (no .tmp left behind).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildPostmortem, writePostmortem, postmortemKey, POSTMORTEM_SCHEMA } from '../services/tuningPostmortem.js';
import { createMemoryStore, createPostmortemStore } from '../services/postmortemStore.js';

// ---------- fake db with eq / gte / order ----------
function makeDb(seed = {}) {
  const tables = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map(r => ({ ...r }));
  function from(table) {
    if (!tables[table]) tables[table] = [];
    const filters = [];
    let orderCol = null, orderAsc = true;
    const match = (r) => filters.every(f =>
      f.op === 'eq' ? r[f.col] === f.val : f.op === 'gte' ? r[f.col] >= f.val : true);
    function run({ single = false } = {}) {
      let out = tables[table].filter(match);
      if (orderCol) out = [...out].sort((a, b) => (a[orderCol] < b[orderCol] ? -1 : a[orderCol] > b[orderCol] ? 1 : 0) * (orderAsc ? 1 : -1));
      return single ? { data: out[0] || null, error: null } : { data: out, error: null };
    }
    const b = {
      select() { return b; },
      eq(c, v) { filters.push({ col: c, op: 'eq', val: v }); return b; },
      gte(c, v) { filters.push({ col: c, op: 'gte', val: v }); return b; },
      order(c, o) { orderCol = c; orderAsc = o?.ascending !== false; return b; },
      maybeSingle() { return Promise.resolve(run({ single: true })); },
      then(res, rej) { return Promise.resolve(run({})).then(res, rej); },
    };
    return b;
  }
  return { from };
}

// Realistic ordering: experiments run FIRST, then the first accept creates the
// session at 10:00 — so the founding step's attempts predate session.created_at.
// A created_at>=session filter would wrongly drop them (review T5); these seeds
// prove they are included.
const SESSION = { id: 's1', source_run_id: 'run-1', entity_name: 'Hacksawgaming', created_at: '2026-08-03T10:00:00Z', updated_at: '2026-08-03T10:06:00Z' };

function seedOneStep() {
  return {
    tuning_session_steps: [{ session_id: 's1', step_index: 5, experiment_id: 'e5b', submodule_id: 'content-writer' }],
    workbench_experiments: [
      { id: 'e5a', source_run_id: 'run-1', entity_name: 'Hacksawgaming', step_index: 5, submodule_id: 'content-writer', overrides: { max_tokens: 2000 }, metrics: { words: 1800, tokens_out: 1800, cost_usd: 0.05 }, status: 'completed', created_at: '2026-08-03T09:58:00Z', parent_experiment_id: null },
      { id: 'e5b', source_run_id: 'run-1', entity_name: 'Hacksawgaming', step_index: 5, submodule_id: 'content-writer', overrides: { max_tokens: 4000 }, metrics: { words: 2579, tokens_out: 2579, cost_usd: 0.09 }, status: 'completed', created_at: '2026-08-03T09:59:00Z', parent_experiment_id: null },
    ],
    pipeline_runs: [{ id: 'run-1', project_id: 'proj-1' }],
    projects: [{ id: 'proj-1', template_id: 'tpl-1' }],
    templates: [{ id: 'tpl-1', name: 'Studio Profiles' }],
  };
}

test('T5: buildPostmortem is fixed-schema, flags accepted vs discarded, metrics-only', async () => {
  const db = makeDb(seedOneStep());
  const pm = await buildPostmortem(SESSION, db);
  assert.equal(pm.schema, POSTMORTEM_SCHEMA);
  assert.equal(pm.template_id, 'tpl-1');
  assert.equal(pm.template_name, 'Studio Profiles');
  assert.equal(pm.step_count, 1);
  const step = pm.steps[0];
  assert.equal(step.step_index, 5);
  assert.equal(step.accepted_experiment_id, 'e5b');
  assert.equal(step.attempt_count, 2);
  assert.equal(step.attempts[0].accepted, false, 'e5a discarded');
  assert.equal(step.attempts[1].accepted, true, 'e5b accepted');
  assert.equal(step.attempts[1].metrics.words, 2579);
  assert.deepEqual(step.attempts[1].changed_from_previous, ['max_tokens']);
  assert.equal(step.attempts[1].metric_deltas.words, 779, '2579 - 1800');
  // NO article body anywhere — metrics only, a few KB
  const json = JSON.stringify(pm);
  assert.ok(!json.includes('content_markdown'), 'no article body in postmortem');
  assert.ok(!json.includes('output_data'), 'no raw output in postmortem');
  assert.ok(Buffer.byteLength(json) < 5000, `postmortem is small (${Buffer.byteLength(json)} bytes)`);
});

test('T5: postmortem GROWS as steps are accepted (continuous, not rewritten-from-scratch loss)', async () => {
  const seed = seedOneStep();
  const db1 = makeDb(seed);
  const before = await buildPostmortem(SESSION, db1);
  assert.equal(before.step_count, 1);
  // accept step 6
  const seed2 = seedOneStep();
  seed2.tuning_session_steps.push({ session_id: 's1', step_index: 6, experiment_id: 'e6', submodule_id: 'qa-structural' });
  seed2.workbench_experiments.push({ id: 'e6', source_run_id: 'run-1', entity_name: 'Hacksawgaming', step_index: 6, submodule_id: 'qa-structural', overrides: {}, metrics: { distinct_citations: 41 }, status: 'completed', created_at: '2026-08-03T10:07:00Z', parent_experiment_id: 'e5b' });
  const after = await buildPostmortem(SESSION, makeDb(seed2));
  assert.equal(after.step_count, 2, 'grew to two steps');
  assert.deepEqual(after.steps.map(s => s.step_index), [5, 6]);
});

test('T5: writePostmortem persists to the store under a stable per-(run,entity) key', async () => {
  const db = makeDb(seedOneStep());
  const store = createMemoryStore();
  const res = await writePostmortem(SESSION, db, store);
  assert.equal(res.key, 'tuning/run-1/hacksawgaming.json');
  assert.equal(res.key, postmortemKey(SESSION));
  assert.ok(res.bytes > 0 && res.bytes < 5000);
  const back = JSON.parse(await store.get(res.key));
  assert.equal(back.schema, POSTMORTEM_SCHEMA);
  assert.equal(back.steps[0].accepted_experiment_id, 'e5b');
});

test('T5: two sessions produce comparable, same-schema postmortems', async () => {
  const a = await buildPostmortem(SESSION, makeDb(seedOneStep()));
  const b = await buildPostmortem({ ...SESSION, id: 's2', source_run_id: 'run-2', entity_name: 'Playngo' }, makeDb({
    tuning_session_steps: [{ session_id: 's2', step_index: 5, experiment_id: 'x', submodule_id: 'content-writer' }],
    workbench_experiments: [{ id: 'x', source_run_id: 'run-2', entity_name: 'Playngo', step_index: 5, submodule_id: 'content-writer', overrides: {}, metrics: { words: 3000 }, status: 'completed', created_at: '2026-08-03T11:00:00Z' }],
  }));
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), 'identical top-level schema across runs');
  assert.equal(a.schema, b.schema);
});

test('T5: filesystem store round-trips atomically and leaves no .tmp', async () => {
  const dir = path.join(process.env.TMPDIR || '/tmp', `pm-test-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const store = createPostmortemStore({ db: null, env: { POSTMORTEM_DIR: dir } });
  assert.equal(store.kind, 'fs');
  const r1 = await store.put('tuning/run-1/e.json', JSON.stringify({ v: 1 }));
  assert.equal(await store.get('tuning/run-1/e.json'), JSON.stringify({ v: 1 }));
  await store.put('tuning/run-1/e.json', JSON.stringify({ v: 2 })); // overwrite
  assert.equal(JSON.parse(await store.get('tuning/run-1/e.json')).v, 2, 'overwrite replaces');
  assert.ok(!fs.existsSync(`${path.join(dir, 'tuning/run-1/e.json')}.tmp`), 'no .tmp residue');
  assert.equal(await store.get('missing.json'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T5: no store configured -> createPostmortemStore returns null (caller skips + logs)', () => {
  assert.equal(createPostmortemStore({ db: null, env: {} }), null);
});
