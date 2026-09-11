import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateRequiresColumns } from './poolHydration.js';

// GSC hydration (PIECE 3) tests. Exercised through the real entry point
// hydrateRequiresColumns with requires_columns: [] so ONLY the gsc_terms fill runs
// (the enrichment cascade is skipped). db.rpc is mocked with the REAL prod rows
// verified via MCP against fevxvwqjhndetktujeuu on 2026-09-11 — so these assert the
// actual []→populated transform on real Search Console output, at $0.

// Real elk-studios entity slice (all-time), top rows — bigint/numeric arrive as strings over REST.
const ELK_ENTITY = [
  { term: 'elk studios', impressions: '668', clicks: '0', position: '47.2' },
  { term: 'elkstudios', impressions: '194', clicks: '0', position: '33.1' },
  { term: 'elk studios recension', impressions: '44', clicks: '0', position: '46.5' },
  { term: 'elk gaming', impressions: '42', clicks: '0', position: '65.4' },
  { term: 'elk studio', impressions: '39', clicks: '0', position: '47.8' },
  { term: 'elk studios review', impressions: '33', clicks: '0', position: '37.4' },
  { term: 'elk studios white label', impressions: '16', clicks: '0', position: '28.3' },
  { term: 'elk studios stockholm', impressions: '3', clicks: '0', position: '36.0' },
];
// PRG's real primary category (3 queries / 19 imp).
const STRATEGY_CONSULTING = [
  { term: 'igaming strategy consulting', impressions: '9', clicks: '0', position: '41.0' },
  { term: 'casino consulting', impressions: '7', clicks: '1', position: '38.0' },
  { term: 'gambling strategy advisory', impressions: '3', clicks: '0', position: '52.0' },
];

// Mock db whose rpc dispatches on (p_scope, p_slug); records every call for assertions.
function mockDb(routes) {
  const calls = [];
  return {
    calls,
    rpc: async (name, params) => {
      calls.push({ name, ...params });
      if (name !== 'gsc_terms_slice') return { data: [], error: null };
      const key = `${params.p_scope}:${params.p_slug}`;
      if (routes.__error && routes.__error === key) return { data: null, error: { message: 'boom' } };
      return { data: routes[key] || [], error: null };
    },
  };
}

const MANIFEST = { item_key: 'entity_name', requires_columns: [] }; // [] => skip cascade, run only the GSC fill
const base = (items, db) => hydrateRequiresColumns({ runId: 'r1', entityName: items[0]?.entity_name, stepIndex: 5, items, manifest: MANIFEST, excludeRunId: null, db });

test('entity slice fills gsc_terms with scope=entity and coerces numbers', async () => {
  const item = { entity_name: 'ELK Studios', keyword_data: { terms: [{ term: 'ELK Studios' }], gsc_terms: [] } };
  const db = mockDb({ 'entity:elk-studios': ELK_ENTITY });
  await base([item], db);
  const g = item.keyword_data.gsc_terms;
  assert.equal(g.length, 8);
  assert.deepEqual(g[0], { term: 'elk studios', impressions: 668, clicks: 0, position: 47.2, scope: 'entity' });
  assert.equal(typeof g[0].impressions, 'number');
  assert.equal(typeof g[0].position, 'number');
  // entity hit => no category fallback calls
  assert.ok(db.calls.every((c) => c.p_scope === 'entity'));
});

test('empty entity slice falls back to category, first candidate slug with rows wins', async () => {
  const item = {
    entity_name: 'Pocket Rockets Gaming',
    keyword_data: {
      terms: [{ term: 'Pocket Rockets Gaming' }, { term: 'strategy-consulting' }, { term: 'casino-platforms' }],
      gsc_terms: [],
    },
  };
  // entity empty; brand-as-category empty; strategy-consulting HITS (before casino-platforms)
  const db = mockDb({
    'entity:pocket-rockets-gaming': [],
    'category:pocket-rockets-gaming': [],
    'category:strategy-consulting': STRATEGY_CONSULTING,
    'category:casino-platforms': [{ term: 'should-not-be-used', impressions: '999', clicks: '0', position: '1.0' }],
  });
  await base([item], db);
  const g = item.keyword_data.gsc_terms;
  assert.equal(g.length, 3);
  assert.equal(g[0].scope, 'category');
  assert.equal(g[0].term, 'igaming strategy consulting');
  // first-hit ordering: casino-platforms must never have been queried
  assert.ok(!db.calls.some((c) => c.p_slug === 'casino-platforms'));
});

test('no entity and no category rows => gsc_terms stays [] (warn, never error)', async () => {
  const item = { entity_name: 'Nobody Ltd', keyword_data: { terms: [{ term: 'obscure-thing' }], gsc_terms: [] } };
  const db = mockDb({}); // everything returns []
  await base([item], db); // must not throw
  assert.deepEqual(item.keyword_data.gsc_terms, []);
});

test('rpc error throws loudly (no silent empty fill)', async () => {
  const item = { entity_name: 'ELK Studios', keyword_data: { terms: [{ term: 'ELK Studios' }], gsc_terms: [] } };
  const db = mockDb({ __error: 'entity:elk-studios' });
  await assert.rejects(() => base([item], db), /GSC entity slice failed/);
});

test('items without keyword_data are ignored (no rpc calls)', async () => {
  const item = { entity_name: 'ELK Studios', url: 'https://x', text_content: 'hi' };
  const db = mockDb({ 'entity:elk-studios': ELK_ENTITY });
  await base([item], db);
  assert.equal(db.calls.length, 0);
});

test('already-filled gsc_terms are not refetched (idempotent)', async () => {
  const item = { entity_name: 'ELK Studios', keyword_data: { terms: [], gsc_terms: [{ term: 'x', impressions: 1, clicks: 0, position: 2, scope: 'entity' }] } };
  const db = mockDb({ 'entity:elk-studios': ELK_ENTITY });
  await base([item], db);
  assert.equal(db.calls.length, 0);
  assert.equal(item.keyword_data.gsc_terms.length, 1);
});

test('keyword_data as a JSON string is parsed then filled', async () => {
  const item = { entity_name: 'ELK Studios', keyword_data: JSON.stringify({ terms: [{ term: 'ELK Studios' }], gsc_terms: [] }) };
  const db = mockDb({ 'entity:elk-studios': ELK_ENTITY });
  await base([item], db);
  assert.equal(item.keyword_data.gsc_terms.length, 8);
  assert.equal(item.keyword_data.gsc_terms[0].scope, 'entity');
});

test('missing db is a safe no-op (hermetic path)', async () => {
  const item = { entity_name: 'ELK Studios', keyword_data: { terms: [], gsc_terms: [] } };
  await hydrateRequiresColumns({ runId: 'r1', entityName: 'ELK Studios', items: [item], manifest: MANIFEST, db: undefined });
  assert.deepEqual(item.keyword_data.gsc_terms, []);
});
