/**
 * Unit tests for poolHydration.js — the extracted §7b requires_columns enrichment
 * (pure move of stageWorker.js:504-672, auto-21 @ 44bdfc7).
 *
 * These are HERMETIC: a mini-Supabase mock exercises the real filter semantics so
 * the primary-key → cross-key cascade is genuinely validated. The field-for-field
 * fidelity check against archived run 8801eb9e is a separate live probe (not a
 * committed test, since it needs prod + the pinned archived run).
 *
 * Run: node server/tests/poolHydration.test.mjs
 */
import { hydrateRequiresColumns } from '../services/poolHydration.js';

let passed = 0, failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else            { failed++; failures.push(label); console.log(`  ❌ ${label}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Mini-Supabase mock — filters fixtures by the exact .eq/.in calls the code makes.
// ---------------------------------------------------------------------------
function buildMockDb({ runs = [], itemData = [] }) {
  function makeQuery(table) {
    const eqf = {}, inf = {};
    const q = {
      select() { return q; },
      eq(col, val) { eqf[col] = val; return q; },
      in(col, vals) { inf[col] = vals; return q; },
      then(resolve, reject) {
        try {
          let rows = [];
          if (table === 'entity_submodule_runs') {
            rows = runs
              .filter(r =>
                (eqf.run_id === undefined || r.run_id === eqf.run_id) &&
                (eqf.entity_name === undefined || r.entity_name === eqf.entity_name) &&
                (inf.status === undefined || inf.status.includes(r.status)))
              .map(r => ({ id: r.id, step_index: r.step_index }));
          } else if (table === 'submodule_run_item_data') {
            rows = itemData
              .filter(d =>
                (inf.submodule_run_id === undefined || inf.submodule_run_id.includes(d.submodule_run_id)) &&
                (inf.field_name === undefined || inf.field_name.includes(d.field_name)) &&
                (inf.item_key === undefined || inf.item_key.includes(d.item_key)))
              .map(d => ({ submodule_run_id: d.submodule_run_id, item_key: d.item_key, field_name: d.field_name, content: d.content }));
          }
          resolve({ data: rows });
        } catch (e) { reject(e); }
      },
    };
    return q;
  }
  return { from: (table) => makeQuery(table) };
}

// ===========================================================================
console.log('\n── Test 1: primary-key merge (item_key=url) ──');
{
  const manifest = { item_key: 'url', requires_columns: ['text_content'] };
  const items = [{ url: 'http://a' }, { url: 'http://b' }];
  const db = buildMockDb({
    runs: [{ id: 'r3', run_id: 'run1', entity_name: 'E', step_index: 3, status: 'approved' }],
    itemData: [
      { submodule_run_id: 'r3', item_key: 'http://a', field_name: 'text_content', content: 'AAA' },
      { submodule_run_id: 'r3', item_key: 'http://b', field_name: 'text_content', content: 'BBB' },
    ],
  });
  const enriched = await hydrateRequiresColumns({ runId: 'run1', entityName: 'E', items, manifest, db });
  assert(items[0].text_content === 'AAA', 'item a enriched via primary key');
  assert(items[1].text_content === 'BBB', 'item b enriched via primary key');
  assert(enriched.has('text_content'), 'enrichedFields records text_content');
}

// ===========================================================================
console.log('\n── Test 2: content-analyzer shape — item_key=entity_name, url cross-key fallback ──');
{
  // Exactly the Hacksaw/Slotmill mechanism: pool keyed by entity_name, text_content
  // stored only by url. Primary pass finds nothing; url fallback fills; entity_name
  // fallback is SKIPPED (item_key IS entity_name). No-url items stay unenriched.
  const manifest = { item_key: 'entity_name', requires_columns: ['text_content', 'entity_name'] };
  const items = [
    { entity_name: 'E', url: 'http://a' },
    { entity_name: 'E', url: 'http://b' },
    { entity_name: 'E' }, // no url — like the 3 non-page items in the real pool
  ];
  const db = buildMockDb({
    runs: [{ id: 'r4', run_id: 'run1', entity_name: 'E', step_index: 4, status: 'approved' }],
    itemData: [
      { submodule_run_id: 'r4', item_key: 'http://a', field_name: 'text_content', content: 'AAA' },
      { submodule_run_id: 'r4', item_key: 'http://b', field_name: 'text_content', content: 'BBB' },
    ],
  });
  const enriched = await hydrateRequiresColumns({ runId: 'run1', entityName: 'E', items, manifest, db });
  assert(items[0].text_content === 'AAA', 'url item a filled via url fallback');
  assert(items[1].text_content === 'BBB', 'url item b filled via url fallback');
  assert(items[2].text_content === undefined, 'no-url item left unenriched (no entity-keyed text_content)');
  assert(enriched.has('text_content'), 'enrichedFields records text_content');
}

// ===========================================================================
console.log('\n── Test 3: step_index last-wins (step 4 overwrites step 3) ──');
{
  const manifest = { item_key: 'url', requires_columns: ['text_content'] };
  const items = [{ url: 'http://a' }];
  const db = buildMockDb({
    runs: [
      { id: 'r3', run_id: 'run1', entity_name: 'E', step_index: 3, status: 'approved' },
      { id: 'r4', run_id: 'run1', entity_name: 'E', step_index: 4, status: 'approved' },
    ],
    itemData: [
      { submodule_run_id: 'r3', item_key: 'http://a', field_name: 'text_content', content: 'RAW-step3' },
      { submodule_run_id: 'r4', item_key: 'http://a', field_name: 'text_content', content: 'STRIPPED-step4' },
    ],
  });
  await hydrateRequiresColumns({ runId: 'run1', entityName: 'E', items, manifest, db });
  assert(items[0].text_content === 'STRIPPED-step4', 'higher step_index wins in the lookup map');
}

// ===========================================================================
console.log('\n── Test 4: missingColumns gate — field already present, no enrichment ──');
{
  const manifest = { item_key: 'url', requires_columns: ['text_content'] };
  const items = [{ url: 'http://a', text_content: 'ORIGINAL' }];
  const db = buildMockDb({
    runs: [{ id: 'r3', run_id: 'run1', entity_name: 'E', step_index: 3, status: 'approved' }],
    itemData: [{ submodule_run_id: 'r3', item_key: 'http://a', field_name: 'text_content', content: 'FROM-DB' }],
  });
  const enriched = await hydrateRequiresColumns({ runId: 'run1', entityName: 'E', items, manifest, db });
  assert(items[0].text_content === 'ORIGINAL', 'present field not overwritten');
  assert(enriched.size === 0, 'nothing enriched when column already present');
}

// ===========================================================================
console.log('\n── Test 5: entity_name fallback (item_key=url) + JSON parseContent ──');
{
  const manifest = { item_key: 'url', requires_columns: ['analysis_json'] };
  const items = [{ url: 'http://a', entity_name: 'E' }];
  const db = buildMockDb({
    runs: [{ id: 'r5', run_id: 'run1', entity_name: 'E', step_index: 5, status: 'approved' }],
    itemData: [{ submodule_run_id: 'r5', item_key: 'E', field_name: 'analysis_json', content: '{"score":9}' }],
  });
  const enriched = await hydrateRequiresColumns({ runId: 'run1', entityName: 'E', items, manifest, db });
  assert(eq(items[0].analysis_json, { score: 9 }), 'entity_name fallback fills + JSON parsed to object');
  assert(enriched.has('analysis_json'), 'enrichedFields records analysis_json');
}

// ===========================================================================
console.log('\n── Test 6: excludeRunId removes a run from the upstream set ──');
{
  const manifest = { item_key: 'url', requires_columns: ['text_content'] };
  const items = [{ url: 'http://a' }];
  const db = buildMockDb({
    runs: [{ id: 'rX', run_id: 'run1', entity_name: 'E', step_index: 3, status: 'approved' }],
    itemData: [{ submodule_run_id: 'rX', item_key: 'http://a', field_name: 'text_content', content: 'AAA' }],
  });
  const enriched = await hydrateRequiresColumns({ runId: 'run1', entityName: 'E', items, manifest, db, excludeRunId: 'rX' });
  assert(items[0].text_content === undefined, 'excluded run contributes nothing');
  assert(enriched.size === 0, 'nothing enriched when the only upstream run is excluded');
}

// ===========================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`poolHydration: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('FAILURES:', failures.join('; ')); process.exit(1); }
process.exit(0);
