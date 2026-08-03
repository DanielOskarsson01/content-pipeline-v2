/**
 * Hermetic tests for promote-settings (TUNING-SESSIONS v1 T3, the dangerous one).
 *
 * Proves: a promote writes template.fallback_values by PK, refuses when a GLOBAL
 * option_presets row would shadow it (naming the row id), warns on a same-project
 * shadow, md5-verifies the read-back, and PROVES a fresh run resolves to the new
 * value via the REAL resolvePresetMap (db-injected). Uses an in-memory fake db
 * with .in() support so the real resolver runs unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { promoteExperimentSettings, findShadows, FRESH_RUN_PROBE_PROJECT } from '../services/promoteSettings.js';
import { createWorkbenchRouter } from '../routes/workbench.js';

// ---------- in-memory fake db (eq / in / gt filters; select/update/insert) ----------
function makeDb(seed = {}) {
  const tables = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map(r => ({ ...r }));
  let idc = 0;
  const gid = (p) => `${p}-${++idc}`;
  function from(table) {
    if (!tables[table]) tables[table] = [];
    const filters = [];
    let op = 'select', payload = null, conflict = null, orderCol = null, orderAsc = true;
    const match = (r) => filters.every(f =>
      f.op === 'eq' ? r[f.col] === f.val
        : f.op === 'in' ? f.val.includes(r[f.col])
          : f.op === 'gt' ? r[f.col] > f.val : true);
    function run({ single = false } = {}) {
      if (op === 'insert') { const row = { id: gid(table), ...payload }; tables[table].push(row); return single ? { data: row, error: null } : { data: [row], error: null }; }
      if (op === 'upsert') {
        const keys = (conflict || '').split(',').map(s => s.trim());
        const ex = tables[table].find(r => keys.every(k => r[k] === payload[k]));
        if (ex) Object.assign(ex, payload); else tables[table].push({ id: gid(table), ...payload });
        return { data: null, error: null };
      }
      if (op === 'update') { for (const r of tables[table].filter(match)) Object.assign(r, payload); return { data: null, error: null }; }
      if (op === 'delete') { tables[table] = tables[table].filter(r => !match(r)); return { data: null, error: null }; }
      let out = tables[table].filter(match);
      if (orderCol) out = [...out].sort((a, b) => (a[orderCol] - b[orderCol]) * (orderAsc ? 1 : -1));
      return single ? { data: out[0] || null, error: null } : { data: out, error: null };
    }
    const b = {
      select() { return b; }, insert(p) { op = 'insert'; payload = p; return b; },
      update(p) { op = 'update'; payload = p; return b; },
      upsert(p, o) { op = 'upsert'; payload = p; conflict = o?.onConflict; return b; },
      delete() { op = 'delete'; return b; },
      eq(c, v) { filters.push({ col: c, op: 'eq', val: v }); return b; },
      in(c, v) { filters.push({ col: c, op: 'in', val: v }); return b; },
      gt(c, v) { filters.push({ col: c, op: 'gt', val: v }); return b; },
      order(c, o) { orderCol = c; orderAsc = o?.ascending !== false; return b; },
      maybeSingle() { return Promise.resolve(run({ single: true })); },
      single() { return Promise.resolve(run({ single: true })); },
      then(res, rej) { return Promise.resolve(run({})).then(res, rej); },
    };
    return b;
  }
  return { db: { from }, tables };
}

const templateRow = (over = {}) => ({
  id: 'tpl-1', name: 'Studio Profiles',
  preset_map: { 'content-writer': { preset_name: 'MyPreset', fallback_values: { max_tokens: 100 } } },
  ...over,
});
const experimentRow = (over = {}) => ({
  id: 'exp5', source_run_id: 'run-1', entity_name: 'Hacksawgaming', step_index: 5,
  submodule_id: 'content-writer', status: 'completed', overrides: { max_tokens: 4000 }, ...over,
});

// ---------- clean promote ----------
test('T3: clean promote writes fallback_values, md5-verifies, and PROVES a fresh run resolves', async () => {
  const { db, tables } = makeDb({ templates: [templateRow()], option_presets: [] });
  const r = await promoteExperimentSettings({ experiment: experimentRow(), template: templateRow(), projectId: 'proj-1', db });
  assert.equal(r.promoted, 1);
  assert.equal(r.refused, false);
  assert.equal(r.target_layer, 'template.preset_map.fallback_values');
  assert.deepEqual(r.plan[0], { submodule_id: 'content-writer', option: 'max_tokens', old: 100, new: 4000, changes: true });
  assert.ok(r.verification[0].ok, 'read-back md5 matches');
  assert.equal(r.resolved_proof[0].fresh_run_resolves_to, 4000);
  assert.ok(r.resolved_proof[0].matches_new, 'a fresh run resolves to the promoted value');
  // actually written to the table row (by PK)
  assert.equal(tables.templates[0].preset_map['content-writer'].fallback_values.max_tokens, 4000);
  // backup captured the prior value
  assert.equal(r.backup.preset_map_before['content-writer'].fallback_values.max_tokens, 100);
});

// ---------- global shadow -> REFUSE, name the row ----------
test('T3: REFUSES when a global option_presets row would shadow the write', async () => {
  const { db, tables } = makeDb({
    templates: [templateRow()],
    option_presets: [{ id: 'g1', submodule_id: 'content-writer', option_name: 'max_tokens', preset_name: 'MyPreset', preset_value: 9999, project_id: null }],
  });
  const r = await promoteExperimentSettings({ experiment: experimentRow(), template: templateRow(), projectId: 'proj-1', db });
  assert.equal(r.refused, true);
  assert.equal(r.promoted, 0);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].layer, 'global');
  assert.equal(r.conflicts[0].row_id, 'g1', 'names the shadowing row by PK id');
  assert.equal(r.conflicts[0].would_resolve_to, 9999);
  // NOT written — the template is untouched on a refusal
  assert.equal(tables.templates[0].preset_map['content-writer'].fallback_values.max_tokens, 100);
});

// ---------- a global row with the SAME value is not a conflict ----------
test('T3: a global row equal to the new value is not a conflict — promote proceeds', async () => {
  const { db } = makeDb({
    templates: [templateRow()],
    option_presets: [{ id: 'g1', submodule_id: 'content-writer', option_name: 'max_tokens', preset_name: 'MyPreset', preset_value: 4000, project_id: null }],
  });
  const r = await promoteExperimentSettings({ experiment: experimentRow(), template: templateRow(), projectId: 'proj-1', db });
  assert.equal(r.refused, false);
  assert.equal(r.promoted, 1);
  assert.ok(r.resolved_proof[0].matches_new);
});

// ---------- project-scoped shadow -> WARN, still promote ----------
test('T3: a same-project preset is a WARNING (fresh runs unaffected), not a refusal', async () => {
  const { db } = makeDb({
    templates: [templateRow()],
    option_presets: [{ id: 'p1', submodule_id: 'content-writer', option_name: 'max_tokens', preset_name: 'MyPreset', preset_value: 8888, project_id: 'proj-1' }],
  });
  const r = await promoteExperimentSettings({ experiment: experimentRow(), template: templateRow(), projectId: 'proj-1', db });
  assert.equal(r.refused, false);
  assert.equal(r.promoted, 1);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].row_id, 'p1');
});

// ---------- dry run: analyse + plan, write NOTHING ----------
test('T3: dry_run returns the plan and writes nothing', async () => {
  const { db, tables } = makeDb({ templates: [templateRow()], option_presets: [] });
  const r = await promoteExperimentSettings({ experiment: experimentRow(), template: templateRow(), projectId: 'proj-1', dryRun: true, db });
  assert.equal(r.dry_run, true);
  assert.equal(r.promoted, 0);
  assert.equal(r.plan[0].new, 4000);
  assert.equal(tables.templates[0].preset_map['content-writer'].fallback_values.max_tokens, 100, 'template untouched by a dry run');
});

// ---------- no overrides ----------
test('T3: an experiment with no overrides promotes nothing', async () => {
  const { db } = makeDb({ templates: [templateRow()], option_presets: [] });
  const r = await promoteExperimentSettings({ experiment: experimentRow({ overrides: {} }), template: templateRow(), projectId: 'proj-1', db });
  assert.equal(r.promoted, 0);
  assert.match(r.message, /no overrides/);
});

// ---------- findShadows ignores presets when there is no preset_name ----------
test('T3: findShadows returns no shadow when the submodule has no preset_name', async () => {
  const { db } = makeDb({ option_presets: [{ id: 'g1', submodule_id: 'content-writer', option_name: 'max_tokens', preset_name: 'X', preset_value: 1, project_id: null }] });
  const s = await findShadows({ submoduleId: 'content-writer', optionName: 'max_tokens', presetName: null, projectId: 'proj-1', db });
  assert.equal(s.global, null);
  assert.equal(s.project, null);
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

test('T3 endpoint: refuses to promote a NON-accepted experiment (409)', async () => {
  const fake = makeDb({
    templates: [templateRow()],
    workbench_experiments: [experimentRow()],
    pipeline_runs: [{ id: 'run-1', project_id: 'proj-1' }],
    // no tuning_session / accepted step -> not accepted
  });
  const { status, json } = await drivePromote(fake, { experiment_id: 'exp5', template_id: 'tpl-1' });
  assert.equal(status, 409);
  assert.match(json.error, /only an accepted experiment/);
});

test('T3 endpoint: promotes an accepted experiment end-to-end (200)', async () => {
  const fake = makeDb({
    templates: [templateRow()],
    workbench_experiments: [experimentRow()],
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

test('T3 endpoint: dry_run on an accepted experiment shows the plan, 200, no write', async () => {
  const fake = makeDb({
    templates: [templateRow()],
    workbench_experiments: [experimentRow()],
    pipeline_runs: [{ id: 'run-1', project_id: 'proj-1' }],
    tuning_sessions: [{ id: 'sess-1', source_run_id: 'run-1', entity_name: 'Hacksawgaming' }],
    tuning_session_steps: [{ id: 'st-1', session_id: 'sess-1', step_index: 5, experiment_id: 'exp5', submodule_id: 'content-writer' }],
    option_presets: [],
  });
  const { status, json } = await drivePromote(fake, { experiment_id: 'exp5', template_id: 'tpl-1', dry_run: true });
  assert.equal(status, 200);
  assert.equal(json.dry_run, true);
  assert.equal(fake.tables.templates[0].preset_map['content-writer'].fallback_values.max_tokens, 100);
});
