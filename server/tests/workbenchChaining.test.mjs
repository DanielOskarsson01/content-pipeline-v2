/**
 * Hermetic tests for workbench U8 chaining (parent_experiment_id overlay) —
 * no real db, no modules repo, no network. Core assertions:
 *   - replace-by-shape: after a TSE→checker chain the child sees EXACTLY ONE
 *     content_markdown bearer (the parent's), including dropping a pool item
 *     whose content_markdown hides behind a §7c _blob_ref;
 *   - siblings (analysis_json, seo_plan_json) survive the overlay;
 *   - every guard fails loud with a 4xx (never a silent skip);
 *   - the U4 no-write contract holds with chaining ON (forbidden-table writes THROW);
 *   - parent_experiment_id is persisted on success AND error insert paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createWorkbenchRouter } from '../routes/workbench.js';
import { hydrateRequiresColumns } from '../services/poolHydration.js';

// ---------- mock supabase client (workbenchExperiments.test.mjs pattern) ----------
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
const writesTo = (calls) => calls
  .filter(c => c.methods.some(m => WRITE_METHODS.includes(m)))
  .map(c => c.table);

// ---------- fixtures ----------
const RUN = 'run-1';
const ENTITY = 'Hacksawgaming';
const PARENT_ID = 'parent-exp-1';

// Step-6-shaped pool: scrape items, the original content-writer bearer (inline),
// a stale tone-seo-editor bearer hiding content_markdown behind a _blob_ref,
// and the analyzer/planner siblings §7b hydration depends on.
const POOL_ITEMS = [
  { url: 'https://x.com/a', entity_name: ENTITY, status: 'success', word_count: 100, source_submodule: 'boilerplate-stripper' },
  { url: 'https://x.com/b', entity_name: ENTITY, status: 'success', word_count: 200, source_submodule: 'boilerplate-stripper' },
  { entity_name: ENTITY, content_markdown: 'ORIGINAL CW CONTENT', meta_title: 'CW title', meta_description: 'CW desc', word_count: 2791, source_submodule: 'content-writer' },
  { entity_name: ENTITY, _blob_ref: 'blob-1', revision_summary: 'old tse summary', keyword_placements_text: 'old placements', word_count: 2446, source_submodule: 'tone-seo-editor' },
  { entity_name: ENTITY, analysis_json: { sections: [1, 2] }, source_submodule: 'content-analyzer' },
  { entity_name: ENTITY, seo_plan_json: { keywords: ['k'] }, source_submodule: 'seo-planner' },
];

const TSE_PARENT = {
  id: PARENT_ID, source_run_id: RUN, entity_name: ENTITY, submodule_id: 'tone-seo-editor', status: 'completed',
  output_data: {
    items: [{ entity_name: ENTITY, content_markdown: 'REVISED TSE CONTENT', revision_summary: 'new summary', keyword_placements_text: 'new placements', word_count: 2601, status: 'success' }],
  },
};

const CW_PARENT = {
  id: PARENT_ID, source_run_id: RUN, entity_name: ENTITY, submodule_id: 'content-writer', status: 'completed',
  output_data: {
    items: [{ entity_name: ENTITY, content_markdown: 'NEW CW CONTENT', meta_title: 'new title', meta_description: 'new desc', word_count: 3000, status: 'success' }],
  },
};

function makeRespond({ parent = TSE_PARENT, insertCapture } = {}) {
  return (rec) => {
    const isWrite = rec.methods.some(m => WRITE_METHODS.includes(m));
    if (isWrite && FORBIDDEN_TABLES.includes(rec.table)) {
      throw new Error(`FORBIDDEN WRITE to ${rec.table} — no-write contract violated`);
    }
    if (rec.table === 'pipeline_runs' && rec.methods.includes('select')) return { data: { id: RUN, status: 'completed' }, error: null };
    if (rec.table === 'pipeline_runs') return { data: null, error: null }; // the pin update
    if (rec.table === 'run_submodule_config') return { data: { options: {} }, error: null };
    if (rec.table === 'entity_stage_pool') return { data: { pool_items: structuredClone(POOL_ITEMS) }, error: null };
    if (rec.table === 'pool_item_blobs') return { data: [{ id: 'blob-1', content: { content_markdown: 'OLD TSE CONTENT (blobbed)' } }], error: null };
    if (rec.table === 'workbench_experiments' && rec.methods.includes('insert')) {
      if (insertCapture) insertCapture(rec.args[0][0]);
      return { data: { id: 'exp-new', ...rec.args[0][0] }, error: null };
    }
    if (rec.table === 'workbench_experiments') return { data: parent ? structuredClone(parent) : null, error: null };
    throw new Error(`unexpected table ${rec.table}`);
  };
}

const MANIFESTS = {
  'qa-structural': { id: 'qa-structural', step: 6, item_key: 'entity_name', options_defaults: {}, options: [] },
  'tone-seo-editor': { id: 'tone-seo-editor', step: 5, item_key: 'entity_name', options_defaults: {}, options: [] },
  'content-writer': { id: 'content-writer', step: 5, item_key: 'entity_name', options_defaults: {}, options: [] },
  'hallucination-detector': { id: 'hallucination-detector', step: 6, item_key: 'entity_name', options_defaults: {}, options: [] },
  'boilerplate-stripper': { id: 'boilerplate-stripper', step: 4, item_key: 'url', options_defaults: {}, options: [] },
  'seo-planner': { id: 'seo-planner', step: 5, item_key: 'entity_name', options_defaults: {}, options: [] },
  'content-analyzer': { id: 'content-analyzer', step: 5, item_key: 'entity_name', options_defaults: {}, options: [] },
};

async function driveEndpoint({ respond, runSubmodule, body, getManifest }) {
  const { db, calls } = makeMockDb(respond);
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({
    db,
    runSubmodule: runSubmodule || (async (spec) => ({
      resolvedOptions: spec.options,
      result: { items: [{ ok: true }], meta: {} },
    })),
    getManifest: getManifest || ((id) => MANIFESTS[id] || null),
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

const chainBody = (child, extra = {}) => ({
  source_run_id: RUN, step_index: 6, submodule_id: child, entity_name: ENTITY,
  parent_experiment_id: PARENT_ID, ...extra,
});

// ---------- (a) TSE → checker: exactly ONE content_markdown bearer, the parent's ----------
test('chain TSE→qa-structural: child sees exactly one content_markdown item (the parent\'s), blob-hidden bearer dropped', async () => {
  let harnessSpec;
  const { status, json } = await driveEndpoint({
    respond: makeRespond({ parent: TSE_PARENT }),
    runSubmodule: async (spec) => { harnessSpec = spec; return { resolvedOptions: spec.options, result: { items: [], meta: {} } }; },
    body: chainBody('qa-structural'),
  });
  assert.equal(status, 201);
  const items = harnessSpec.entity.items;
  const bearers = items.filter(i => i.content_markdown);
  assert.equal(bearers.length, 1, 'exactly one inline content_markdown bearer');
  assert.equal(bearers[0].content_markdown, 'REVISED TSE CONTENT');
  assert.equal(bearers[0].source_submodule, 'tone-seo-editor', 'inserted item stamped with parent submodule');
  // the _blob_ref item hiding content_markdown must be GONE (else §7c hydration
  // resurrects the concatenation bug)
  assert.equal(items.filter(i => i._blob_ref).length, 0, 'blob-hidden content bearer dropped');
  // original content-writer bearer gone
  assert.ok(!items.some(i => i.content_markdown === 'ORIGINAL CW CONTENT'));
  // scrape items untouched
  assert.equal(items.filter(i => i.url).length, 2);
  assert.equal(json.source, 'chained');
  assert.equal(json.chain.parent_experiment_id, PARENT_ID);
  assert.equal(json.chain.pool_items_dropped, 2);
  assert.equal(json.chain.pool_items_kept, 4);
});

// ---------- (b) CW → TSE chain ----------
test('chain CW→tone-seo-editor: parent CW output replaces original bearer', async () => {
  let harnessSpec;
  const { status } = await driveEndpoint({
    respond: makeRespond({ parent: CW_PARENT }),
    runSubmodule: async (spec) => { harnessSpec = spec; return { resolvedOptions: spec.options, result: { items: [], meta: {} } }; },
    body: chainBody('tone-seo-editor', { step_index: 5 }),
  });
  assert.equal(status, 201);
  const items = harnessSpec.entity.items;
  const bearers = items.filter(i => i.content_markdown);
  assert.equal(bearers.length, 1);
  assert.equal(bearers[0].content_markdown, 'NEW CW CONTENT');
  assert.equal(bearers[0].source_submodule, 'content-writer');
  assert.equal(items.filter(i => i._blob_ref).length, 0, 'stale TSE blob bearer dropped');
});

// ---------- (c) guards fail loud ----------
test('guard: non-completed parent rejected 409', async () => {
  const { status, json, calls } = await driveEndpoint({
    respond: makeRespond({ parent: { ...TSE_PARENT, status: 'error' } }),
    body: chainBody('qa-structural'),
  });
  assert.equal(status, 409);
  assert.match(json.error, /only completed experiments/);
  assert.deepEqual(writesTo(calls), [], 'guard rejection must not pin or insert');
});

test('guard: parent from another run rejected 400', async () => {
  const { status, json } = await driveEndpoint({
    respond: makeRespond({ parent: { ...TSE_PARENT, source_run_id: 'other-run' } }),
    body: chainBody('qa-structural'),
  });
  assert.equal(status, 400);
  assert.match(json.error, /belongs to run other-run/);
});

test('guard: parent for another entity rejected 400', async () => {
  const { status, json } = await driveEndpoint({
    respond: makeRespond({ parent: { ...TSE_PARENT, entity_name: 'OtherCo' } }),
    body: chainBody('qa-structural'),
  });
  assert.equal(status, 400);
  assert.match(json.error, /entity 'OtherCo'/);
});

test('guard: parent output item missing its item_key field rejected 422', async () => {
  const badParent = {
    ...TSE_PARENT,
    output_data: { items: [{ content_markdown: 'X', status: 'success' }] }, // no entity_name
  };
  const { status, json } = await driveEndpoint({
    respond: makeRespond({ parent: badParent }),
    body: chainBody('qa-structural'),
  });
  assert.equal(status, 422);
  assert.match(json.error, /lacks its module's item_key field 'entity_name'/);
});

test('guard: unknown parent id rejected 404', async () => {
  const { status, json } = await driveEndpoint({
    respond: makeRespond({ parent: null }),
    body: chainBody('qa-structural'),
  });
  assert.equal(status, 404);
  assert.match(json.error, /not found/);
});

// ---------- (d) siblings survive ----------
test('siblings the parent does not produce (analysis_json, seo_plan_json) survive the overlay', async () => {
  let harnessSpec;
  await driveEndpoint({
    respond: makeRespond({ parent: TSE_PARENT }),
    runSubmodule: async (spec) => { harnessSpec = spec; return { resolvedOptions: spec.options, result: { items: [], meta: {} } }; },
    body: chainBody('qa-structural'),
  });
  const items = harnessSpec.entity.items;
  assert.ok(items.some(i => i.analysis_json), 'analysis_json sibling preserved');
  assert.ok(items.some(i => i.seo_plan_json), 'seo_plan_json sibling preserved');
});

// ---------- (e) no-write contract with chaining on ----------
test('no-write contract holds with chaining on (forbidden-table writes throw in mock)', async () => {
  const { status, calls } = await driveEndpoint({
    respond: makeRespond({ parent: TSE_PARENT }), // throws on any forbidden write
    body: chainBody('qa-structural'),
  });
  assert.equal(status, 201);
  const writes = writesTo(calls);
  assert.deepEqual(writes.sort(), ['pipeline_runs', 'workbench_experiments']);
  for (const t of FORBIDDEN_TABLES) assert.ok(!writes.includes(t), `wrote forbidden table ${t}`);
});

// ---------- (f) parent_experiment_id persisted on success and error ----------
test('parent_experiment_id persisted on the success row', async () => {
  let inserted;
  const { status } = await driveEndpoint({
    respond: makeRespond({ parent: TSE_PARENT, insertCapture: (row) => { inserted = row; } }),
    body: chainBody('qa-structural'),
  });
  assert.equal(status, 201);
  assert.equal(inserted.parent_experiment_id, PARENT_ID);
});

test('parent_experiment_id persisted on the error row when the harness throws', async () => {
  let inserted;
  const { status } = await driveEndpoint({
    respond: makeRespond({ parent: TSE_PARENT, insertCapture: (row) => { inserted = row; } }),
    runSubmodule: async () => { throw new Error('module exploded'); },
    body: chainBody('qa-structural'),
  });
  assert.equal(status, 500);
  assert.equal(inserted.parent_experiment_id, PARENT_ID);
  assert.equal(inserted.status, 'error');
});

// ---------- overlay × §7b seam: production-sized pool ----------
// §7b samples only the FIRST 10 items to decide missing columns
// (poolHydration.js sampleItems.slice(0, 10)). If the parent's bearer sits
// past that window, §7b declares content_markdown missing and Object.assigns
// the HISTORICAL submodule_run_item_data content over every entity_name-keyed
// item — silently scoring the wrong artifact. This drives the overlay output
// through the REAL hydrateRequiresColumns with historical content on offer.
test('>10-item pool: parent content survives real §7b hydration as the only bearer', async () => {
  const bigPool = [
    ...Array.from({ length: 12 }, (_, i) => ({
      url: `https://x.com/p${i}`, entity_name: ENTITY, status: 'success', word_count: 100, source_submodule: 'boilerplate-stripper',
    })),
    { entity_name: ENTITY, content_markdown: 'ORIGINAL CW CONTENT', meta_title: 'CW title', word_count: 2791, source_submodule: 'content-writer' },
    { entity_name: ENTITY, analysis_json: { sections: [1] }, source_submodule: 'content-analyzer' },
  ];
  let itemDataQueried = false;
  const respond = (rec) => {
    if (rec.table === 'entity_stage_pool') return { data: { pool_items: structuredClone(bigPool) }, error: null };
    if (rec.table === 'entity_submodule_runs') return { data: [{ id: 'up1', step_index: 5 }], error: null };
    if (rec.table === 'submodule_run_item_data') {
      itemDataQueried = true;
      return { data: [{ submodule_run_id: 'up1', item_key: ENTITY, field_name: 'content_markdown', content: 'HISTORICAL CW CONTENT' }], error: null };
    }
    return makeRespond({ parent: TSE_PARENT })(rec);
  };
  let hydratedItems;
  const { status } = await driveEndpoint({
    respond,
    runSubmodule: async (spec, deps) => {
      // the real §7b, exactly as the harness invokes it (hydrate: true)
      await hydrateRequiresColumns({
        runId: spec.run_id, entityName: spec.entity.name, stepIndex: spec.step_index,
        items: spec.entity.items,
        manifest: { item_key: 'entity_name', requires_columns: ['content_markdown'] },
        db: deps.db,
      });
      hydratedItems = spec.entity.items;
      return { resolvedOptions: spec.options, result: { items: [], meta: {} } };
    },
    body: chainBody('qa-structural'),
  });
  assert.equal(status, 201);
  const bearers = hydratedItems.filter(i => i.content_markdown);
  assert.equal(bearers.length, 1, `exactly one bearer post-hydration, got ${bearers.length}`);
  assert.equal(bearers[0].content_markdown, 'REVISED TSE CONTENT', 'parent content survives §7b');
  assert.equal(itemDataQueried, false, '§7b saw the parent field present and never hit item_data');
});

// ---------- unchained requests unaffected, and explicitly marked ----------
test('request without parent_experiment_id never touches workbench parent load or blobs, and is marked pool-sourced', async () => {
  let inserted;
  const { status, json, calls } = await driveEndpoint({
    respond: makeRespond({ parent: TSE_PARENT, insertCapture: (row) => { inserted = row; } }),
    body: { source_run_id: RUN, step_index: 6, submodule_id: 'qa-structural', entity_name: ENTITY },
  });
  assert.equal(status, 201);
  assert.ok(!calls.some(c => c.table === 'pool_item_blobs'), 'no blob lookup without a parent');
  assert.equal(inserted.parent_experiment_id, null);
  // the silent-unchained fix: an unchained response says so positively —
  // absence of the chain key must never be the only signal
  assert.equal(json.source, 'pool');
  assert.equal(json.chain, null);
  assert.ok('chain' in json, 'chain key present (explicit null), not omitted');
});

// ---------- the cb49ef80 over-drop shape (failure mode b) ----------
// Run cb49ef80 / Hacksawgaming: 57 boilerplate-stripper items (45 carrying the
// scrape's meta_description og:description), plus step-5 singletons. Chaining a
// content-writer parent (which emits meta_description as SEO meta) shape-dropped
// the 45 scraped sources and left the checker 12 footer stubs — hallucination
// scores measured source deletion, not grounding. Source-step items must be
// exempt from the drop; the stale generated bearers must still go.
test('cb49ef80 shape: scraped meta_description bearers survive a CW parent; stale writer/TSE bearers dropped; one content_markdown bearer', async () => {
  const cbPool = [
    ...Array.from({ length: 45 }, (_, i) => ({
      url: `https://hacksawgaming.com/p${i}`, entity_name: ENTITY, status: 'success',
      meta_description: `og description ${i}`, title: `Page ${i}`, text_preview: `preview ${i}`,
      word_count: 500, source_submodule: 'boilerplate-stripper',
    })),
    ...Array.from({ length: 12 }, (_, i) => ({
      url: `https://hacksawgaming.com/stub${i}`, entity_name: ENTITY, status: 'success',
      text_preview: 'footer stub', word_count: 40, source_submodule: 'boilerplate-stripper',
    })),
    { entity_name: ENTITY, content_markdown: 'ORIGINAL CW CONTENT', meta_title: 'CW title', meta_description: 'CW desc', word_count: 2791, source_submodule: 'content-writer' },
    { entity_name: ENTITY, _blob_ref: 'blob-1', revision_summary: 'old tse summary', word_count: 2446, source_submodule: 'tone-seo-editor' },
    { entity_name: ENTITY, meta_title: 'planner meta title', keywords_text: 'kw', source_submodule: 'seo-planner' },
    { entity_name: ENTITY, analysis_json: { sections: [1] }, source_submodule: 'content-analyzer' },
  ];
  let harnessSpec;
  const { status, json } = await driveEndpoint({
    respond: (rec) => {
      if (rec.table === 'entity_stage_pool') return { data: { pool_items: structuredClone(cbPool) }, error: null };
      return makeRespond({ parent: CW_PARENT })(rec);
    },
    runSubmodule: async (spec) => { harnessSpec = spec; return { resolvedOptions: spec.options, result: { items: [], meta: {} } }; },
    body: chainBody('hallucination-detector'),
  });
  assert.equal(status, 201);
  const items = harnessSpec.entity.items;
  // all 57 scraped/stripped source items survive — including the 45 whose
  // meta_description collides with the parent's declared output field
  assert.equal(items.filter(i => i.source_submodule === 'boilerplate-stripper').length, 57, 'no source starvation');
  // stale generated bearers are gone: exactly ONE content_markdown bearer (the parent's)
  const bearers = items.filter(i => i.content_markdown);
  assert.equal(bearers.length, 1, 'exactly one content_markdown bearer');
  assert.equal(bearers[0].content_markdown, 'NEW CW CONTENT');
  // blob-hidden bearer still dropped (its blob keys include content_markdown)
  assert.equal(items.filter(i => i._blob_ref).length, 0, 'blob-hidden bearer dropped');
  // residual documented over-drop: the seo-planner sibling goes via its
  // meta_title collision (generation-step item, not exempt)
  assert.ok(!items.some(i => i.source_submodule === 'seo-planner'), 'planner sibling still shape-dropped (documented residual)');
  assert.ok(items.some(i => i.analysis_json), 'analyzer sibling survives');
  // counts surface starvation at a glance
  assert.equal(json.source, 'chained');
  assert.equal(json.chain.pool_items_dropped, 3, 'CW + TSE + planner');
  assert.equal(json.chain.pool_items_kept, 58, '57 source items + analyzer');
});

// ---------- step<=4 parent: own originals replaced by composite key, never duplicated ----------
// The source-item exemption must not shield the parent's OWN originals: chaining
// an improved boilerplate-stripper experiment prepends its items — without the
// composite-key arm, every original would be exempt-kept too (two text_content
// bearers per url, doubling the child's corpus with pre-fix text).
test('chain stripper parent: originals replaced by (item_key, source_submodule), other source items and generated bearers kept', async () => {
  const STRIPPER_PARENT = {
    id: PARENT_ID, source_run_id: RUN, entity_name: ENTITY, submodule_id: 'boilerplate-stripper', status: 'completed',
    output_data: {
      items: [
        { url: 'https://x.com/a', entity_name: ENTITY, text_content: 'RESTRIPPED A', word_count: 90, status: 'success' },
        { url: 'https://x.com/b', entity_name: ENTITY, text_content: 'RESTRIPPED B', word_count: 180, status: 'success' },
      ],
    },
  };
  const pool = [
    { url: 'https://x.com/a', entity_name: ENTITY, text_content: 'OLD A', word_count: 100, source_submodule: 'boilerplate-stripper' },
    { url: 'https://x.com/b', entity_name: ENTITY, text_content: 'OLD B', word_count: 200, source_submodule: 'boilerplate-stripper' },
    { url: 'https://x.com/c', entity_name: ENTITY, text_content: 'OLD C', word_count: 300, source_submodule: 'boilerplate-stripper' },
    { entity_name: ENTITY, content_markdown: 'CW CONTENT', word_count: 2791, source_submodule: 'content-writer' },
  ];
  let harnessSpec;
  const { status, json } = await driveEndpoint({
    respond: (rec) => {
      if (rec.table === 'entity_stage_pool') return { data: { pool_items: structuredClone(pool) }, error: null };
      return makeRespond({ parent: STRIPPER_PARENT })(rec);
    },
    runSubmodule: async (spec) => { harnessSpec = spec; return { resolvedOptions: spec.options, result: { items: [], meta: {} } }; },
    body: chainBody('qa-structural'),
  });
  assert.equal(status, 201);
  const items = harnessSpec.entity.items;
  const urls = items.filter(i => i.url).map(i => i.url);
  assert.equal(new Set(urls).size, urls.length, 'no url appears twice');
  assert.equal(items.find(i => i.url === 'https://x.com/a').text_content, 'RESTRIPPED A', 'parent item replaced the original');
  assert.equal(items.find(i => i.url === 'https://x.com/c').text_content, 'OLD C', 'untouched source item kept');
  assert.ok(items.some(i => i.content_markdown === 'CW CONTENT'), 'generated bearer not superseded by a source parent');
  assert.equal(json.chain.pool_items_dropped, 2, 'exactly the two originals');
  assert.equal(json.chain.pool_items_kept, 2);
});

// ---------- unknown provenance stays shape-matched (failure mode a guard) ----------
test('item with no source_submodule carrying a parent field is still dropped', async () => {
  const pool = [
    { entity_name: ENTITY, content_markdown: 'ANONYMOUS BEARER', word_count: 100 }, // no source_submodule
    { url: 'https://x.com/a', entity_name: ENTITY, meta_description: 'og desc', source_submodule: 'boilerplate-stripper' },
  ];
  let harnessSpec;
  const { status } = await driveEndpoint({
    respond: (rec) => {
      if (rec.table === 'entity_stage_pool') return { data: { pool_items: structuredClone(pool) }, error: null };
      return makeRespond({ parent: CW_PARENT })(rec);
    },
    runSubmodule: async (spec) => { harnessSpec = spec; return { resolvedOptions: spec.options, result: { items: [], meta: {} } }; },
    body: chainBody('qa-structural'),
  });
  assert.equal(status, 201);
  const items = harnessSpec.entity.items;
  assert.ok(!items.some(i => i.content_markdown === 'ANONYMOUS BEARER'), 'unknown-provenance bearer dropped');
  assert.equal(items.filter(i => i.content_markdown).length, 1, 'only the parent bearer remains');
  assert.ok(items.some(i => i.source_submodule === 'boilerplate-stripper'), 'source item exempt');
});
