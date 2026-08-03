/**
 * Hermetic tests for promote-settings (TUNING-SESSIONS v1 T3, the dangerous one).
 *
 * Covers the review-hardened behaviour: writes template.fallback_values by PK,
 * PROVES-BEFORE-WRITE, refuses on a GLOBAL shadow under ANY of the template's
 * preset_names (naming the row), warns on same- and other-project shadows,
 * canonical md5 survives a jsonb key-reorder, optimistic-concurrency lock, and
 * the endpoint accepted-gate. In-memory fake db with .in()/.eq() + update-select
 * + optional jsonb reorder so the REAL resolver runs unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { promoteExperimentSettings, findShadows } from '../services/promoteSettings.js';
import { createWorkbenchRouter } from '../routes/workbench.js';

// recursively reverse object key order — simulates Postgres jsonb NOT preserving order
function reorderDeep(v) {
  if (Array.isArray(v)) return v.map(reorderDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).reverse()) o[k] = reorderDeep(v[k]);
    return o;
  }
  return v;
}

function makeDb(seed = {}, { jsonbReorder = false } = {}) {
  const tables = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map(r => ({ ...r }));
  let idc = 0;
  const gid = (p) => `${p}-${++idc}`;
  function from(table) {
    if (!tables[table]) tables[table] = [];
    const filters = [];
    let op = 'select', payload = null, conflict = null, selected = false;
    const match = (r) => filters.every(f =>
      f.op === 'eq' ? r[f.col] === f.val : f.op === 'in' ? f.val.includes(r[f.col]) : f.op === 'gt' ? r[f.col] > f.val : true);
    function run({ single = false } = {}) {
      if (op === 'insert') { const row = { id: gid(table), ...payload }; tables[table].push(row); return single ? { data: row, error: null } : { data: [row], error: null }; }
      if (op === 'update') {
        let p = payload;
        if (jsonbReorder && table === 'templates' && p.preset_map) p = { ...p, preset_map: reorderDeep(p.preset_map) };
        const matched = tables[table].filter(match);
        for (const r of matched) Object.assign(r, p);
        return { data: selected ? matched : null, error: null };
      }
      if (op === 'delete') { tables[table] = tables[table].filter(r => !match(r)); return { data: null, error: null }; }
      const out = tables[table].filter(match);
      return single ? { data: out[0] || null, error: null } : { data: out, error: null };
    }
    const b = {
      select() { selected = true; return b; },
      insert(p) { op = 'insert'; payload = p; return b; },
      update(p) { op = 'update'; payload = p; return b; },
      upsert(p, o) { op = 'upsert'; payload = p; conflict = o?.onConflict; return b; },
      delete() { op = 'delete'; return b; },
      eq(c, v) { filters.push({ col: c, op: 'eq', val: v }); return b; },
      in(c, v) { filters.push({ col: c, op: 'in', val: v }); return b; },
      gt(c, v) { filters.push({ col: c, op: 'gt', val: v }); return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve(run({ single: true })); },
      single() { return Promise.resolve(run({ single: true })); },
      then(res, rej) { return Promise.resolve(run({})).then(res, rej); },
    };
    return b;
  }
  return { db: { from }, tables };
}

const templateRow = (over = {}) => ({
  id: 'tpl-1', name: 'Studio Profiles', updated_at: 'v1',
  preset_map: { 'content-writer': { preset_name: 'MyPreset', fallback_values: { max_tokens: 100 } } },
  ...over,
});
const experimentRow = (over = {}) => ({
  id: 'exp5', source_run_id: 'run-1', entity_name: 'Hacksawgaming', step_index: 5,
  submodule_id: 'content-writer', status: 'completed', overrides: { max_tokens: 4000 }, ...over,
});

test('T3: clean promote writes fallback_values, PROVES a fresh run resolves, backs up', async () => {
  const { db, tables } = makeDb({ templates: [templateRow()], option_presets: [] });
  const r = await promoteExperimentSettings({ experiment: experimentRow(), template: templateRow(), projectId: 'proj-1', db });
  assert.equal(r.promoted, 1);
  assert.equal(r.refused, false);
  assert.equal(r.resolved_proof[0].fresh_run_resolves_to, 4000);
  assert.ok(r.resolved_proof[0].matches_new);
  assert.ok(r.verification[0].ok);
  assert.equal(tables.templates[0].preset_map['content-writer'].fallback_values.max_tokens, 4000);
  assert.equal(r.backup.preset_map_before['content-writer'].fallback_values.max_tokens, 100);
});

test('T3 F1: an OBJECT-valued override survives a jsonb key-reorder (canonical md5)', async () => {
  const tmpl = () => templateRow({ preset_map: { 'content-writer': { preset_name: 'MyPreset', fallback_values: {} } } });
  const exp = experimentRow({ overrides: { provider_params: { b: 1, a: 2, z: { y: 1, x: 2 } } } });
  const { db, tables } = makeDb({ templates: [tmpl()], option_presets: [] }, { jsonbReorder: true });
  const r = await promoteExperimentSettings({ experiment: exp, template: tmpl(), projectId: 'proj-1', db });
  assert.equal(r.refused, false, 'object override must not false-fail on jsonb reorder');
  assert.equal(r.promoted, 1);
  assert.ok(r.verification[0].ok, 'read-back md5 stable despite key reorder');
  // the value is stored (keys reordered by the fake, but semantically equal)
  assert.deepEqual(tables.templates[0].preset_map['content-writer'].fallback_values.provider_params, { z: { x: 2, y: 1 }, a: 2, b: 1 });
});

test('T3: REFUSES on a global shadow, names the row, and does NOT write', async () => {
  const { db, tables } = makeDb({
    templates: [templateRow()],
    option_presets: [{ id: 'g1', submodule_id: 'content-writer', option_name: 'max_tokens', preset_name: 'MyPreset', preset_value: 9999, project_id: null }],
  });
  const r = await promoteExperimentSettings({ experiment: experimentRow(), template: templateRow(), projectId: 'proj-1', db });
  assert.equal(r.refused, true);
  assert.equal(r.conflicts[0].row_id, 'g1');
  assert.equal(r.conflicts[0].would_resolve_to, 9999);
  assert.equal(tables.templates[0].preset_map['content-writer'].fallback_values.max_tokens, 100, 'no write on refusal');
});

test('T3 F3: a global row under a DIFFERENT submodule\'s preset_name still shadows (mirrors resolver)', async () => {
  // template: A(content-writer, preset "X"), B(seo-planner, preset "Y"); global row for A under "Y"
  const preset_map = {
    'content-writer': { preset_name: 'X', fallback_values: { max_tokens: 100 } },
    'seo-planner': { preset_name: 'Y', fallback_values: { depth: 1 } },
  };
  const { db, tables } = makeDb({
    templates: [templateRow({ preset_map })],
    option_presets: [{ id: 'gY', submodule_id: 'content-writer', option_name: 'max_tokens', preset_name: 'Y', preset_value: 9999, project_id: null }],
  });
  const r = await promoteExperimentSettings({ experiment: experimentRow(), template: templateRow({ preset_map }), projectId: 'proj-1', db });
  assert.equal(r.refused, true, 'cross-preset-name shadow caught by the widened findShadows');
  assert.equal(r.conflicts[0].row_id, 'gY');
  assert.equal(tables.templates[0].preset_map['content-writer'].fallback_values.max_tokens, 100, 'no write');
});

test('T3 F4: an other-project preset is a WARNING (fresh runs unaffected), still promotes', async () => {
  const { db } = makeDb({
    templates: [templateRow()],
    option_presets: [{ id: 'op1', submodule_id: 'content-writer', option_name: 'max_tokens', preset_name: 'MyPreset', preset_value: 5555, project_id: 'other-proj' }],
  });
  const r = await promoteExperimentSettings({ experiment: experimentRow(), template: templateRow(), projectId: 'proj-1', db });
  assert.equal(r.refused, false);
  assert.equal(r.warnings[0].scope, 'other_project');
  assert.equal(r.warnings[0].project_id, 'other-proj');
});

test('T3 F5: optimistic lock refuses a stale write (concurrent template edit)', async () => {
  const { db, tables } = makeDb({ templates: [templateRow()], option_presets: [] });
  // first promote with the current updated_at succeeds and bumps updated_at
  const ok = await promoteExperimentSettings({ experiment: experimentRow(), template: templateRow(), projectId: 'proj-1', priorUpdatedAt: 'v1', db });
  assert.equal(ok.promoted, 1);
  assert.notEqual(tables.templates[0].updated_at, 'v1', 'updated_at bumped');
  // a second promote still holding the OLD updated_at is a concurrency conflict
  const stale = await promoteExperimentSettings({ experiment: experimentRow({ overrides: { max_tokens: 5000 } }), template: templateRow(), projectId: 'proj-1', priorUpdatedAt: 'v1', db });
  assert.equal(stale.refused, true);
  assert.equal(stale.concurrency_conflict, true);
});

test('T3: dry_run proves + plans, writes nothing', async () => {
  const { db, tables } = makeDb({ templates: [templateRow()], option_presets: [] });
  const r = await promoteExperimentSettings({ experiment: experimentRow(), template: templateRow(), projectId: 'proj-1', dryRun: true, db });
  assert.equal(r.dry_run, true);
  assert.equal(r.promoted, 0);
  assert.ok(r.resolved_proof[0].matches_new, 'dry_run still proves');
  assert.equal(tables.templates[0].preset_map['content-writer'].fallback_values.max_tokens, 100);
});

test('T3: no overrides promotes nothing; findShadows ignores presets with no preset_name', async () => {
  const { db } = makeDb({ templates: [templateRow()], option_presets: [] });
  const none = await promoteExperimentSettings({ experiment: experimentRow({ overrides: {} }), template: templateRow(), projectId: 'proj-1', db });
  assert.equal(none.promoted, 0);
  const s = await findShadows({ submoduleId: 'content-writer', optionName: 'max_tokens', presetNames: [], projectId: 'proj-1', db });
  assert.equal(s.global, null);
});

test('T3 4b: fresh-run proof aborts if the probe project is contaminated', async () => {
  const { db } = makeDb({
    templates: [templateRow()],
    option_presets: [{ id: 'bad', submodule_id: 'x', option_name: 'y', preset_name: 'z', preset_value: 1, project_id: '00000000-0000-0000-0000-000000000000' }],
  });
  await assert.rejects(
    () => promoteExperimentSettings({ experiment: experimentRow(), template: templateRow(), projectId: 'proj-1', db }),
    /FRESH_RUN_PROBE_PROJECT.*real option_presets/);
});

// ---------- endpoint accepted-gate ----------
async function drivePromote(fake, body) {
  const app = express(); app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({ db: fake.db, runSubmodule: async () => ({}), getManifest: () => null }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://localhost:${server.address().port}/api/workbench/promote-settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally { server.close(); }
}

test('T3 endpoint: refuses a NON-accepted experiment (409)', async () => {
  const fake = makeDb({
    templates: [templateRow()], workbench_experiments: [experimentRow()],
    pipeline_runs: [{ id: 'run-1', project_id: 'proj-1' }],
  });
  const { status, json } = await drivePromote(fake, { experiment_id: 'exp5', template_id: 'tpl-1' });
  assert.equal(status, 409);
  assert.match(json.error, /only an accepted experiment/);
});

test('T3 endpoint: promotes an accepted experiment end-to-end (200)', async () => {
  const fake = makeDb({
    templates: [templateRow()], workbench_experiments: [experimentRow()],
    pipeline_runs: [{ id: 'run-1', project_id: 'proj-1' }],
    tuning_sessions: [{ id: 'sess-1', source_run_id: 'run-1', entity_name: 'Hacksawgaming' }],
    tuning_session_steps: [{ id: 'st-1', session_id: 'sess-1', step_index: 5, experiment_id: 'exp5', submodule_id: 'content-writer' }],
    option_presets: [],
  });
  const { status, json } = await drivePromote(fake, { experiment_id: 'exp5', template_id: 'tpl-1' });
  assert.equal(status, 200);
  assert.equal(json.promoted, 1);
  assert.ok(json.resolved_proof[0].matches_new);
  assert.equal(fake.tables.templates[0].preset_map['content-writer'].fallback_values.max_tokens, 4000);
});
