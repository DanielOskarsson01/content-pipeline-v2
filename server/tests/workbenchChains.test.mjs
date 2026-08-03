/**
 * Hermetic tests for A2 forward chains (POST /api/workbench/chains) — no real
 * db, no modules repo, no network. Core assertions:
 *   - sequencing: steps ascending, submodule_id ascending within a step;
 *   - sibling rule: same-step hops chain to the same ancestor set (never to
 *     each other); later steps read start + all earlier-step hops;
 *   - linked-list provenance: hop N's parent_experiment_id = hop N-1's id;
 *   - chain-provenance exemption: a later hop's incidental collision never
 *     destroys an earlier hop's fresh output — but a hop producing a protected
 *     artifact field still supersedes earlier chain bearers of it;
 *   - cost cap refuses (upfront and mid-chain) rather than overspends;
 *   - fail-closed: an errored hop stops the chain;
 *   - the U4 no-write contract holds across a whole chain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runForwardChain, getChainTree } from '../routes/workbenchChains.js';

const RUN = 'run-1';
const ENTITY = 'Hacksawgaming';
const START_ID = 'start-exp';

const WRITE_METHODS = ['insert', 'update', 'upsert', 'delete'];
const FORBIDDEN_TABLES = [
  'submodule_runs', 'entity_submodule_runs', 'run_submodule_config',
  'entity_stage_pool', 'submodule_run_item_data', 'pool_item_blobs',
];

const MANIFESTS = {
  'boilerplate-stripper': { id: 'boilerplate-stripper', step: 4, item_key: 'url', options_defaults: {}, options: [] },
  'seo-planner': { id: 'seo-planner', step: 5, item_key: 'entity_name', options_defaults: {}, options: [] },
  'content-writer': { id: 'content-writer', step: 5, item_key: 'entity_name', options_defaults: {}, options: [] },
  'tone-seo-editor': { id: 'tone-seo-editor', step: 5, item_key: 'entity_name', options_defaults: {}, options: [] },
  'qa-structural': { id: 'qa-structural', step: 6, item_key: 'entity_name', options_defaults: {}, options: [] },
  'citation-coverage-checker': { id: 'citation-coverage-checker', step: 6, item_key: 'entity_name', options_defaults: {}, options: [] },
  'loop-router': { id: 'loop-router', step: 7, item_key: 'entity_name', options_defaults: {}, options: [] },
  'json-output': { id: 'json-output', step: 8, item_key: 'entity_name', options_defaults: {}, options: [] },
};

const stripperItems = (n) => Array.from({ length: n }, (_, i) => ({
  url: `https://x.com/p${i}`, entity_name: ENTITY, status: 'success', word_count: 100, source_submodule: 'boilerplate-stripper',
}));

/**
 * Stateful mock: chains fetch ancestors by id, so inserted experiment rows
 * must be readable back. `writes` collects every write per table.
 */
function makeChainDb({ plan, pools, priors = {}, startRow }) {
  const experiments = new Map([[startRow.id, startRow]]);
  let counter = 0;
  const writes = [];
  const db = {
    from(table) {
      const rec = { table, methods: [], args: [] };
      const b = {};
      for (const m of ['select', 'eq', 'gte', 'lte', 'in', 'order', 'limit', 'update', 'insert', 'upsert', 'delete']) {
        b[m] = (...a) => { rec.methods.push(m); rec.args.push(a); return b; };
      }
      const eqArg = (col) => {
        const i = rec.methods.findIndex((m, idx) => m === 'eq' && rec.args[idx][0] === col);
        return i >= 0 ? rec.args[i][1] : undefined;
      };
      const resolve = () => {
        const isWrite = rec.methods.some(m => WRITE_METHODS.includes(m));
        if (isWrite) {
          writes.push(rec);
          if (FORBIDDEN_TABLES.includes(table)) throw new Error(`FORBIDDEN WRITE to ${table}`);
        }
        if (table === 'pipeline_runs') return { data: { id: RUN, status: 'archived' }, error: null };
        if (table === 'run_submodule_config') {
          if (rec.methods.includes('gte')) return { data: structuredClone(plan), error: null };
          const step = eqArg('step_index');
          const sub = eqArg('submodule_id');
          const row = plan.find(p => p.step_index === step && p.submodule_id === sub);
          return { data: row ? { options: row.options || {} } : null, error: null };
        }
        if (table === 'entity_stage_pool') {
          const step = eqArg('step_index');
          return { data: { pool_items: structuredClone(pools[step] || []) }, error: null };
        }
        if (table === 'pool_item_blobs') return { data: [], error: null };
        if (table === 'workbench_experiments') {
          if (rec.methods.includes('insert')) {
            const row = { id: `exp-${++counter}`, created_at: `2026-08-03T00:00:0${counter}Z`, ...rec.args[rec.methods.indexOf('insert')][0] };
            experiments.set(row.id, row);
            return { data: row, error: null };
          }
          if (rec.methods.includes('limit')) { // estimate lookup
            const sub = eqArg('submodule_id');
            return { data: priors[sub] ? { ai_usage: priors[sub] } : null, error: null };
          }
          const id = eqArg('id');
          if (id !== undefined) return { data: experiments.get(id) ? structuredClone(experiments.get(id)) : null, error: null };
          // chain-tree list
          return { data: [...experiments.values()].map(r => structuredClone(r)), error: null };
        }
        throw new Error(`unexpected table ${table}`);
      };
      b.maybeSingle = () => { rec.methods.push('maybeSingle'); return Promise.resolve(resolve()); };
      b.single = () => { rec.methods.push('single'); return Promise.resolve(resolve()); };
      b.then = (ok, err) => Promise.resolve().then(resolve).then(ok, err);
      return b;
    },
  };
  return { db, writes, experiments };
}

const CW_START = {
  id: START_ID, source_run_id: RUN, entity_name: ENTITY, submodule_id: 'content-writer',
  step_index: 5, status: 'completed', created_at: '2026-08-03T00:00:00Z',
  output_data: { items: [{ entity_name: ENTITY, content_markdown: 'ARM B DRAFT', meta_title: 'arm b title', status: 'success' }] },
};

const PLANNER_START = {
  id: START_ID, source_run_id: RUN, entity_name: ENTITY, submodule_id: 'seo-planner',
  step_index: 5, status: 'completed', created_at: '2026-08-03T00:00:00Z',
  output_data: { items: [{ entity_name: ENTITY, meta_title: 'NEW planner title', keywords_text: 'kw1, kw2', status: 'success' }] },
};

// Scripted per-submodule outputs; captures each hop's harness input.
function makeRunSubmodule(outputs, captures) {
  return async (spec) => {
    captures.push({ submodule_id: spec.submodule_id, step_index: spec.step_index, items: spec.entity.items });
    const result = outputs[spec.submodule_id];
    if (!result) throw new Error(`no scripted output for ${spec.submodule_id}`);
    return { resolvedOptions: spec.options, result: structuredClone(result) };
  };
}

const getManifest = (id) => MANIFESTS[id] || null;

// ---------- T1: sequencing, sibling rule, linked list, verdict replacement ----------
test('chain 6→8: step order, siblings share ancestors, linked-list provenance, fresh verdicts replace stale', async () => {
  const plan = [
    { step_index: 6, submodule_id: 'qa-structural', options: {} },
    { step_index: 6, submodule_id: 'citation-coverage-checker', options: {} },
    { step_index: 7, submodule_id: 'loop-router', options: {} },
    { step_index: 8, submodule_id: 'json-output', options: {} },
  ];
  const step6pool = [
    ...stripperItems(12),
    { entity_name: ENTITY, content_markdown: 'OLD POOL DRAFT', meta_title: 'old', word_count: 2599, source_submodule: 'content-writer' },
    { entity_name: ENTITY, citation_score: 0.4, qa_pass: false, summary_text: 'stale citations', source_submodule: 'citation-coverage-checker' },
    { entity_name: ENTITY, structural_score: 0.7, qa_pass: false, section_report: 'stale', source_submodule: 'qa-structural' },
  ];
  const pools = { 6: step6pool, 7: step6pool, 8: step6pool };
  const outputs = {
    'citation-coverage-checker': { items: [{ entity_name: ENTITY, citation_score: 0.9, qa_pass: true, summary_text: 'fresh citations', status: 'success' }], meta: {} },
    'qa-structural': { items: [{ entity_name: ENTITY, structural_score: 0.83, qa_pass: true, section_report: 'fresh', section_count: 13, total_words: 2486, status: 'success' }], meta: {} },
    'loop-router': { items: [{ entity_name: ENTITY, decision: 'approve', routing_notes: 'ok', status: 'success' }], meta: {} },
    'json-output': { items: [{ entity_name: ENTITY, final_json: { title: 'x' }, qa_pass: true, status: 'success' }], meta: {} },
  };
  const captures = [];
  const { db, writes } = makeChainDb({ plan, pools, startRow: CW_START });
  const r = await runForwardChain(
    { start_experiment_id: START_ID, from_step: 6, to_step: 8 },
    { db, runSubmodule: makeRunSubmodule(outputs, captures), getManifest },
  );
  assert.equal(r.status, 201);
  assert.equal(r.body.chain_status, 'completed');
  const hops = r.body.hops;
  assert.deepEqual(hops.map(h => `${h.step_index}:${h.submodule_id}`),
    ['6:citation-coverage-checker', '6:qa-structural', '7:loop-router', '8:json-output'],
    'steps ascending, submodule_id ascending within a step');

  // sibling rule: both step-6 checkers read ONLY the start; step 7 reads
  // start + both checkers; step 8 reads everything before it
  assert.deepEqual(hops[0].read_from, [START_ID]);
  assert.deepEqual(hops[1].read_from, [START_ID]);
  assert.deepEqual(hops[2].read_from, [START_ID, hops[0].experiment_id, hops[1].experiment_id]);
  assert.deepEqual(hops[3].read_from, [START_ID, hops[0].experiment_id, hops[1].experiment_id, hops[2].experiment_id]);

  // linked list: each hop's recorded parent is the previous hop (first → start)
  assert.equal(hops[0].parent_experiment_id, START_ID);
  assert.equal(hops[1].parent_experiment_id, hops[0].experiment_id);
  assert.equal(hops[2].parent_experiment_id, hops[1].experiment_id);
  assert.equal(hops[3].parent_experiment_id, hops[2].experiment_id);

  // every hop consumed the ARM B draft, exactly once
  for (const c of captures) {
    const bearers = c.items.filter(i => i.content_markdown);
    assert.equal(bearers.length, 1, `${c.submodule_id}: one bearer`);
    assert.equal(bearers[0].content_markdown, 'ARM B DRAFT');
  }
  // sibling isolation: the qa hop must NOT see the citation hop's fresh verdict
  const qaInput = captures.find(c => c.submodule_id === 'qa-structural').items;
  assert.ok(!qaInput.some(i => i.summary_text === 'fresh citations'), 'sibling verdict not visible');
  assert.ok(qaInput.some(i => i.summary_text === 'stale citations'), 'pool verdict still the input for siblings');
  // the router DOES see both fresh verdicts, and the stale ones are gone
  const routerInput = captures.find(c => c.submodule_id === 'loop-router').items;
  assert.ok(routerInput.some(i => i.summary_text === 'fresh citations'));
  assert.ok(routerInput.some(i => i.section_report === 'fresh'));
  assert.ok(!routerInput.some(i => i.summary_text === 'stale citations'), 'stale verdict replaced');
  assert.ok(!routerInput.some(i => i.section_report === 'stale'), 'stale verdict replaced');

  // step-8 summary carries the qa signal the acceptance wants visible
  assert.equal(hops[1].summary.structural_score, 0.83);
  assert.equal(hops[1].summary.section_count, 13);

  // no-write contract across the whole chain: only workbench_experiments rows
  assert.deepEqual([...new Set(writes.map(w => w.table))], ['workbench_experiments']);
  assert.equal(writes.length, 4, 'exactly one insert per hop');
});

// ---------- T2: chain-provenance exemption ----------
test('planner→writer→checker: writer hop cannot destroy the planner hop\'s fresh plan (meta_title collision)', async () => {
  const plan = [
    { step_index: 5, submodule_id: 'content-writer', options: {} },
    { step_index: 6, submodule_id: 'qa-structural', options: {} },
  ];
  const pools = {
    5: [...stripperItems(3)],
    6: [
      ...stripperItems(3),
      { entity_name: ENTITY, content_markdown: 'OLD POOL DRAFT', meta_title: 'old', source_submodule: 'content-writer' },
    ],
  };
  const outputs = {
    'content-writer': { items: [{ entity_name: ENTITY, content_markdown: 'FRESH DRAFT', meta_title: 'fresh title', status: 'success' }], meta: {} },
    'qa-structural': { items: [{ entity_name: ENTITY, structural_score: 0.9, qa_pass: true, section_report: 'ok', status: 'success' }], meta: {} },
  };
  const captures = [];
  const { db } = makeChainDb({ plan, pools, startRow: PLANNER_START });
  const r = await runForwardChain(
    { start_experiment_id: START_ID, from_step: 5, to_step: 6 },
    { db, runSubmodule: makeRunSubmodule(outputs, captures), getManifest },
  );
  assert.equal(r.body.chain_status, 'completed');
  const checkerInput = captures.find(c => c.submodule_id === 'qa-structural').items;
  // the planner hop's fresh plan SURVIVED the writer hop's meta_title collision
  assert.ok(checkerInput.some(i => i.meta_title === 'NEW planner title'), 'fresh plan survives (chain-provenance exemption)');
  // exactly one artifact bearer: the fresh draft; the old pool draft is superseded
  const bearers = checkerInput.filter(i => i.content_markdown);
  assert.equal(bearers.length, 1);
  assert.equal(bearers[0].content_markdown, 'FRESH DRAFT');
});

// ---------- T3: artifact crossover ----------
test('planner→writer+tse→checker: a later artifact hop still supersedes the earlier chain draft (one bearer)', async () => {
  const plan = [
    { step_index: 5, submodule_id: 'content-writer', options: {} },
    { step_index: 5, submodule_id: 'tone-seo-editor', options: {} },
    { step_index: 6, submodule_id: 'qa-structural', options: {} },
  ];
  const pools = { 5: [...stripperItems(3)], 6: [...stripperItems(3)] };
  const outputs = {
    'content-writer': { items: [{ entity_name: ENTITY, content_markdown: 'DRAFT', meta_title: 't1', status: 'success' }], meta: {} },
    'tone-seo-editor': { items: [{ entity_name: ENTITY, content_markdown: 'REVISED', revision_summary: 's', status: 'success' }], meta: {} },
    'qa-structural': { items: [{ entity_name: ENTITY, structural_score: 0.9, qa_pass: true, section_report: 'ok', status: 'success' }], meta: {} },
  };
  const captures = [];
  const { db } = makeChainDb({ plan, pools, startRow: PLANNER_START });
  const r = await runForwardChain(
    { start_experiment_id: START_ID, from_step: 5, to_step: 6 },
    { db, runSubmodule: makeRunSubmodule(outputs, captures), getManifest },
  );
  assert.equal(r.body.chain_status, 'completed');
  const checkerInput = captures.find(c => c.submodule_id === 'qa-structural').items;
  const bearers = checkerInput.filter(i => i.content_markdown);
  assert.equal(bearers.length, 1, 'artifact crossover: exactly one bearer reaches the checker');
  assert.equal(bearers[0].content_markdown, 'REVISED', 'the later artifact hop wins');
  assert.ok(checkerInput.some(i => i.meta_title === 'NEW planner title'), 'non-artifact chain item still survives');
});

// ---------- T4: cost cap refuses upfront ----------
test('cost cap below the first hop estimate refuses before running anything', async () => {
  const plan = [{ step_index: 6, submodule_id: 'qa-structural', options: { ai_model: 'sonnet' } }];
  const priors = { 'qa-structural': { calls: [{ model: 'claude-sonnet-5', tokens_in: 100000, tokens_out: 3000 }], tokens_in_total: 100000, tokens_out_total: 3000 } }; // ≈ $0.345
  const captures = [];
  const { db, writes } = makeChainDb({ plan, pools: { 6: stripperItems(2) }, priors, startRow: CW_START });
  const r = await runForwardChain(
    { start_experiment_id: START_ID, from_step: 6, to_step: 6, max_cost_usd: 0.01 },
    { db, runSubmodule: makeRunSubmodule({}, captures), getManifest },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.chain_status, 'refused_cost_cap');
  assert.equal(r.body.hops.length, 0);
  assert.equal(captures.length, 0, 'nothing executed');
  assert.equal(writes.length, 0, 'nothing written');
  assert.equal(r.body.stop.refused_hop.submodule_id, 'qa-structural');
  assert.ok(r.body.stop.refused_hop.estimate_usd > 0.3, `estimate printed: ${r.body.stop.refused_hop.estimate_usd}`);
});

// ---------- T5: cost cap refuses mid-chain ----------
test('cost cap lets cheap hops run and refuses before the expensive one', async () => {
  const plan = [
    { step_index: 6, submodule_id: 'citation-coverage-checker', options: {} }, // non-AI
    { step_index: 6, submodule_id: 'qa-structural', options: { ai_model: 'sonnet' } }, // flat $1 estimate
  ];
  const outputs = {
    'citation-coverage-checker': { items: [{ entity_name: ENTITY, citation_score: 1, qa_pass: true, summary_text: 'ok', status: 'success' }], meta: {} },
  };
  const captures = [];
  const { db } = makeChainDb({ plan, pools: { 6: stripperItems(2) }, startRow: CW_START });
  const r = await runForwardChain(
    { start_experiment_id: START_ID, from_step: 6, to_step: 6, max_cost_usd: 0.5 },
    { db, runSubmodule: makeRunSubmodule(outputs, captures), getManifest },
  );
  assert.equal(r.body.chain_status, 'refused_cost_cap');
  assert.equal(r.body.hops.length, 1, 'cheap hop ran');
  assert.equal(captures.length, 1);
  assert.equal(r.body.stop.refused_hop.submodule_id, 'qa-structural');
});

// ---------- T6: fail-closed ----------
test('an errored hop stops the chain (fail-closed) and later hops never run', async () => {
  const plan = [
    { step_index: 6, submodule_id: 'citation-coverage-checker', options: {} },
    { step_index: 7, submodule_id: 'loop-router', options: {} },
  ];
  const outputs = {
    'citation-coverage-checker': { items: [{ entity_name: ENTITY, summary_text: '', status: 'error' }], meta: { status: 'error', error: 'truncated' } },
    'loop-router': { items: [{ entity_name: ENTITY, decision: 'approve', status: 'success' }], meta: {} },
  };
  const captures = [];
  const { db } = makeChainDb({ plan, pools: { 6: stripperItems(2), 7: stripperItems(2) }, startRow: CW_START });
  const r = await runForwardChain(
    { start_experiment_id: START_ID, from_step: 6, to_step: 7 },
    { db, runSubmodule: makeRunSubmodule(outputs, captures), getManifest },
  );
  assert.equal(r.body.chain_status, 'stopped_error');
  assert.equal(r.body.hops.length, 1);
  assert.equal(r.body.hops[0].status, 'error');
  assert.equal(captures.length, 1, 'the router never ran');
  assert.match(r.body.stop.reason, /error/);
});

// ---------- T7: max_hops refuses upfront ----------
test('a plan over max_hops is refused before any execution', async () => {
  const plan = [
    { step_index: 6, submodule_id: 'citation-coverage-checker', options: {} },
    { step_index: 6, submodule_id: 'qa-structural', options: {} },
    { step_index: 7, submodule_id: 'loop-router', options: {} },
  ];
  const captures = [];
  const { db, writes } = makeChainDb({ plan, pools: {}, startRow: CW_START });
  const r = await runForwardChain(
    { start_experiment_id: START_ID, from_step: 6, to_step: 7, max_hops: 2 },
    { db, runSubmodule: makeRunSubmodule({}, captures), getManifest },
  );
  assert.equal(r.status, 400);
  assert.match(r.body.error, /max_hops/);
  assert.equal(captures.length, 0);
  assert.equal(writes.length, 0);
});

// ---------- critic F4: unknown override keys refuse, never silently no-op ----------
test('overrides_per_submodule with a typo\'d key is refused 400', async () => {
  const plan = [{ step_index: 6, submodule_id: 'qa-structural', options: {} }];
  const captures = [];
  const { db, writes } = makeChainDb({ plan, pools: {}, startRow: CW_START });
  const r = await runForwardChain(
    { start_experiment_id: START_ID, from_step: 6, to_step: 6, overrides_per_submodule: { qa_structural: { ai_model: 'opus' } } },
    { db, runSubmodule: makeRunSubmodule({}, captures), getManifest },
  );
  assert.equal(r.status, 400);
  assert.match(r.body.error, /qa_structural/);
  assert.equal(captures.length, 0);
  assert.equal(writes.length, 0);
});

// ---------- critic F1: never-ran AI hop estimates from manifest defaults, not the non-AI floor ----------
test('a never-ran hop with ai_model only in manifest defaults is priced as an AI hop', async () => {
  const plan = [{ step_index: 6, submodule_id: 'hallucination-detector', options: {} }]; // options: no ai_model, no prior
  const manifestWithModel = (id) => id === 'hallucination-detector'
    ? { ...MANIFESTS[id], options_defaults: { ai_model: 'sonnet' } }
    : MANIFESTS[id] || null;
  const { db } = makeChainDb({ plan, pools: {}, startRow: CW_START });
  const r = await runForwardChain(
    { start_experiment_id: START_ID, from_step: 6, to_step: 6, max_cost_usd: 0.5 },
    { db, runSubmodule: makeRunSubmodule({}, []), getManifest: manifestWithModel },
  );
  assert.equal(r.body.chain_status, 'refused_cost_cap', 'flat sonnet rate ($1) beats the $0.5 cap');
  assert.equal(r.body.stop.refused_hop.estimate_usd, 1.0);
});

// ---------- critic F5: one chain per start experiment at a time ----------
test('a second chain from the same start is refused 409 while the first is executing', async () => {
  const plan = [{ step_index: 6, submodule_id: 'citation-coverage-checker', options: {} }];
  const outputs = {
    'citation-coverage-checker': { items: [{ entity_name: ENTITY, citation_score: 1, qa_pass: true, summary_text: 'ok', status: 'success' }], meta: {} },
  };
  const { db } = makeChainDb({ plan, pools: { 6: stripperItems(2) }, startRow: CW_START });
  let release;
  const gate = new Promise(r => { release = r; });
  const slowRun = async (spec) => { await gate; return { resolvedOptions: spec.options, result: structuredClone(outputs[spec.submodule_id]) }; };
  const first = runForwardChain(
    { start_experiment_id: START_ID, from_step: 6, to_step: 6 },
    { db, runSubmodule: slowRun, getManifest },
  );
  await new Promise(r => setTimeout(r, 20)); // let the first chain take the lock
  const second = await runForwardChain(
    { start_experiment_id: START_ID, from_step: 6, to_step: 6 },
    { db, runSubmodule: slowRun, getManifest },
  );
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already executing/);
  release();
  const r1 = await first;
  assert.equal(r1.body.chain_status, 'completed', 'first chain unaffected');
  // lock released — a fresh chain is allowed again
  const third = await runForwardChain(
    { start_experiment_id: START_ID, from_step: 6, to_step: 6 },
    { db, runSubmodule: async (spec) => ({ resolvedOptions: spec.options, result: structuredClone(outputs[spec.submodule_id]) }), getManifest },
  );
  assert.equal(third.body.chain_status, 'completed');
});

// ---------- dry run: plan + estimates, zero execution, zero writes ----------
test('dry_run returns the plan and estimates without executing or writing anything', async () => {
  const plan = [
    { step_index: 6, submodule_id: 'qa-structural', options: { ai_model: 'sonnet' } },
    { step_index: 7, submodule_id: 'loop-router', options: {} },
  ];
  const captures = [];
  const { db, writes } = makeChainDb({ plan, pools: {}, startRow: CW_START });
  const r = await runForwardChain(
    { start_experiment_id: START_ID, from_step: 6, to_step: 7, dry_run: true },
    { db, runSubmodule: makeRunSubmodule({}, captures), getManifest },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.chain_status, 'dry_run');
  assert.equal(r.body.planned_hops.length, 2);
  assert.ok(r.body.estimate_total_usd > 0);
  assert.equal(captures.length, 0);
  assert.equal(writes.length, 0);
});

// ---------- guards ----------
test('non-completed start experiment rejected 409; unknown start 404', async () => {
  const { db } = makeChainDb({ plan: [], pools: {}, startRow: { ...CW_START, status: 'error' } });
  const r1 = await runForwardChain({ start_experiment_id: START_ID, from_step: 6, to_step: 6 }, { db, runSubmodule: async () => {}, getManifest });
  assert.equal(r1.status, 409);
  const r2 = await runForwardChain({ start_experiment_id: 'nope', from_step: 6, to_step: 6 }, { db, runSubmodule: async () => {}, getManifest });
  assert.equal(r2.status, 404);
});

// ---------- GET /chains/:startId reconstruction ----------
test('getChainTree reconstructs hops from parent_experiment_id links alone', async () => {
  const plan = [
    { step_index: 6, submodule_id: 'qa-structural', options: {} },
    { step_index: 7, submodule_id: 'loop-router', options: {} },
  ];
  const outputs = {
    'qa-structural': { items: [{ entity_name: ENTITY, structural_score: 0.83, qa_pass: true, section_report: 'ok', status: 'success' }], meta: {} },
    'loop-router': { items: [{ entity_name: ENTITY, decision: 'approve', status: 'success' }], meta: {} },
  };
  const { db } = makeChainDb({ plan, pools: { 6: stripperItems(2), 7: stripperItems(2) }, startRow: CW_START });
  const run = await runForwardChain(
    { start_experiment_id: START_ID, from_step: 6, to_step: 7 },
    { db, runSubmodule: makeRunSubmodule(outputs, []), getManifest },
  );
  assert.equal(run.body.chain_status, 'completed');
  const tree = await getChainTree(START_ID, { db });
  assert.equal(tree.status, 200);
  assert.equal(tree.body.hops.length, 2);
  assert.deepEqual(tree.body.hops.map(h => h.submodule_id), ['qa-structural', 'loop-router']);
  assert.equal(tree.body.hops[0].parent_experiment_id, START_ID);
  assert.equal(tree.body.hops[1].parent_experiment_id, tree.body.hops[0].experiment_id);
});
