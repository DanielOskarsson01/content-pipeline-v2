/**
 * Integration test — all 5 project modes + template saving.
 *
 * Run against local:      node server/tests/modes.test.mjs
 * Run against production:  BASE_URL=https://www.jugadorvip.com AUTH=onlyigaming:test2026 node server/tests/modes.test.mjs
 *
 * Creates real projects/templates and cleans them up afterward.
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const AUTH = process.env.AUTH; // "user:pass" for basic auth
const TAG = `__test_${Date.now()}`;

let passed = 0;
let failed = 0;
const cleanup = { projects: [], templates: [], runs: [] };

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (AUTH) {
    opts.headers['Authorization'] = 'Basic ' + Buffer.from(AUTH).toString('base64');
  }
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}/api${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// Seed CSV (semicolon-delimited — the format the user actually uses)
function buildSeedCsv() {
  const lines = [
    'company name;company website',
    'Test Alpha;https://alpha.example.com',
    'Test Beta;https://beta.example.com',
    'Test Gamma;https://gamma.example.com',
  ];
  return new Blob([lines.join('\n')], { type: 'text/csv' });
}

// ═══════════════════════════════════════════════════
// Mode 1: single_run
// ═══════════════════════════════════════════════════
console.log('\n── Mode 1: single_run ──');
{
  const { status, data } = await api('POST', '/projects', {
    name: `${TAG} single_run`,
    intent: 'Integration test',
    mode: 'single_run',
  });
  assert(status === 200 || status === 201, `Created project (status ${status})`);
  assert(data.project?.id, `Has project.id: ${data.project?.id?.slice(0, 8)}`);
  assert(data.run?.id, `Has run.id: ${data.run?.id?.slice(0, 8)}`);
  assert(data.project?.mode === 'single_run', `mode = single_run (got "${data.project?.mode}")`);
  assert(data.project?.status === 'active', `status = active (got "${data.project?.status}")`);
  if (data.project?.id) cleanup.projects.push(data.project.id);
  if (data.run?.id) cleanup.runs.push(data.run.id);
}

// ═══════════════════════════════════════════════════
// Mode 2: new_template — creates a new template + project
// ═══════════════════════════════════════════════════
console.log('\n── Mode 2: new_template ──');
let newTemplateId;
let newTemplateRunId;
{
  // First create the template
  const tRes = await api('POST', '/templates', {
    name: `${TAG} new_tmpl`,
    description: 'Created by integration test',
  });
  assert(tRes.status === 200 || tRes.status === 201, `Created template (status ${tRes.status})`);
  newTemplateId = tRes.data.template?.id || tRes.data.id;
  assert(!!newTemplateId, `Has template.id: ${newTemplateId?.slice(0, 8)}`);
  if (newTemplateId) cleanup.templates.push(newTemplateId);

  // Then launch with new_template mode
  const { status, data } = await api('POST', `/templates/${newTemplateId}/launch`, {
    project_name: `${TAG} new_template project`,
    mode: 'new_template',
  });
  assert(status === 200 || status === 201, `Launched new_template (status ${status})`);
  assert(data.project?.id, `Has project.id`);
  assert(data.project?.mode === 'new_template', `mode = new_template (got "${data.project?.mode}")`);
  if (data.project?.id) cleanup.projects.push(data.project.id);
  if (data.run?.id) { cleanup.runs.push(data.run.id); newTemplateRunId = data.run.id; }
}

// ═══════════════════════════════════════════════════
// Mode 3: use_template — launch existing template with CSV seed
// ═══════════════════════════════════════════════════
console.log('\n── Mode 3: use_template (CSV seed) ──');
{
  // Use the template we just created (or pick any existing one)
  const templateId = newTemplateId;
  assert(!!templateId, `Have a template to use: ${templateId?.slice(0, 8)}`);

  // Build multipart form with CSV
  const form = new FormData();
  form.append('project_name', `${TAG} use_template`);
  form.append('mode', 'use_template');
  form.append('file', buildSeedCsv(), 'test_seed.csv');

  const { status, data } = await api('POST', `/templates/${templateId}/launch`, form);
  assert(status === 200 || status === 201, `Launched use_template (status ${status})`);
  assert(data.project?.id, `Has project.id`);
  assert(data.project?.mode === 'use_template', `mode = use_template (got "${data.project?.mode}")`);
  if (data.project?.id) cleanup.projects.push(data.project.id);
  if (data.run?.id) cleanup.runs.push(data.run.id);

  // Verify seed was ingested — check step_context for step 1
  if (data.run?.id) {
    const ctxRes = await api('GET', `/runs/${data.run.id}/steps/1/context`);
    if (ctxRes.status === 200 && ctxRes.data?.entities) {
      const entities = ctxRes.data.entities;
      assert(entities.length === 3, `Seed has 3 entities (got ${entities.length})`);
      assert(entities[0]?.name === 'Test Alpha', `First entity name = "Test Alpha" (got "${entities[0]?.name}")`);
      assert(entities[0]?.website === 'https://alpha.example.com', `First entity website resolved via alias (got "${entities[0]?.website}")`);
    } else {
      assert(false, `Could not verify seed (step_context status ${ctxRes.status})`);
    }
  }
}

// ═══════════════════════════════════════════════════
// Mode 3b: use_template — launch with pre-parsed entities (URL tab)
// ═══════════════════════════════════════════════════
console.log('\n── Mode 3b: use_template (entities JSON) ──');
{
  const templateId = newTemplateId;
  const { status, data } = await api('POST', `/templates/${templateId}/launch`, {
    project_name: `${TAG} use_template_entities`,
    mode: 'use_template',
    entities: [
      { name: 'Entity One', website: 'https://one.example.com' },
      { name: 'Entity Two', website: 'https://two.example.com' },
    ],
  });
  assert(status === 200 || status === 201, `Launched use_template with entities (status ${status})`);
  assert(data.project?.id, `Has project.id`);
  if (data.project?.id) cleanup.projects.push(data.project.id);
  if (data.run?.id) cleanup.runs.push(data.run.id);

  // Verify entities arrived
  if (data.run?.id) {
    const ctxRes = await api('GET', `/runs/${data.run.id}/steps/1/context`);
    if (ctxRes.status === 200 && ctxRes.data?.entities) {
      assert(ctxRes.data.entities.length === 2, `2 entities ingested (got ${ctxRes.data.entities.length})`);
    } else {
      assert(false, `Could not verify entities (status ${ctxRes.status})`);
    }
  }
}

// ═══════════════════════════════════════════════════
// Mode 4: fork_template — deep copy template
// ═══════════════════════════════════════════════════
console.log('\n── Mode 4: fork_template ──');
let forkedTemplateId;
{
  const templateId = newTemplateId;
  const { status, data } = await api('POST', `/templates/${templateId}/launch`, {
    project_name: `${TAG} fork_project`,
    mode: 'fork_template',
    fork_name: `${TAG} forked_tmpl`,
  });
  assert(status === 200 || status === 201, `Launched fork_template (status ${status})`);
  assert(data.project?.id, `Has project.id`);
  assert(data.project?.mode === 'fork_template', `mode = fork_template (got "${data.project?.mode}")`);
  // Forked template should be different from source
  if (data.project?.template_id) {
    forkedTemplateId = data.project.template_id;
    assert(forkedTemplateId !== templateId, `Fork created new template (${forkedTemplateId?.slice(0, 8)} ≠ ${templateId?.slice(0, 8)})`);
    cleanup.templates.push(forkedTemplateId);
  }
  if (data.project?.id) cleanup.projects.push(data.project.id);
  if (data.run?.id) cleanup.runs.push(data.run.id);
}

// ═══════════════════════════════════════════════════
// Mode 5: update_template — reuse existing template
// ═══════════════════════════════════════════════════
console.log('\n── Mode 5: update_template ──');
{
  const templateId = newTemplateId;
  const { status, data } = await api('POST', `/templates/${templateId}/launch`, {
    project_name: `${TAG} update_project`,
    mode: 'update_template',
  });
  assert(status === 200 || status === 201, `Launched update_template (status ${status})`);
  assert(data.project?.id, `Has project.id`);
  assert(data.project?.mode === 'update_template', `mode = update_template (got "${data.project?.mode}")`);
  // Should link to the SAME template (not a copy)
  assert(data.project?.template_id === templateId, `Links to original template (not a fork)`);
  if (data.project?.id) cleanup.projects.push(data.project.id);
  if (data.run?.id) cleanup.runs.push(data.run.id);
}

// ═══════════════════════════════════════════════════
// Template CRUD: verify template was saved correctly
// ═══════════════════════════════════════════════════
console.log('\n── Template CRUD ──');
{
  // Read back the template we created
  const { status, data } = await api('GET', `/templates/${newTemplateId}`);
  assert(status === 200, `GET template (status ${status})`);
  assert(data.name?.includes(TAG), `Template name contains tag (got "${data.name}")`);
  assert(data.description === 'Created by integration test', `Description preserved`);

  // Update template
  const upd = await api('PUT', `/templates/${newTemplateId}`, {
    description: 'Updated by test',
  });
  assert(upd.status === 200, `PUT template (status ${upd.status})`);

  // Verify update persisted
  const check = await api('GET', `/templates/${newTemplateId}`);
  assert(check.data?.description === 'Updated by test', `Description updated (got "${check.data?.description}")`);
}

// ═══════════════════════════════════════════════════
// Template list: verify our test templates appear
// ═══════════════════════════════════════════════════
console.log('\n── Template listing ──');
{
  const { status, data } = await api('GET', '/templates');
  assert(status === 200, `GET /templates (status ${status})`);
  const testTemplates = data.filter(t => t.name?.includes(TAG));
  assert(testTemplates.length >= 2, `At least 2 test templates in list (found ${testTemplates.length})`);
}

// ═══════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════
console.log('\n── Cleanup ──');
{
  // Delete projects first (they reference templates via FK)
  for (const id of cleanup.projects) {
    const { status } = await api('DELETE', `/projects/${id}`);
    console.log(`  Project ${id.slice(0, 8)}… ${status === 200 || status === 204 ? 'deleted' : `status ${status}`}`);
  }
  // Delete templates
  for (const id of cleanup.templates) {
    const { status } = await api('DELETE', `/templates/${id}`);
    console.log(`  Template ${id.slice(0, 8)}… ${status === 200 || status === 204 ? 'deleted' : `status ${status}`}`);
  }
}

// ── Summary ──
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
