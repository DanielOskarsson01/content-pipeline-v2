/**
 * Unit tests for applyDataOperation.
 *
 * No API, no DB, no fixtures. Pure function in, pure value out.
 *
 * Run: node server/tests/data-operations.test.mjs
 */
import { applyDataOperation } from '../lib/applyDataOperation.js';

let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else            { failed++; console.log(`  ❌ ${label}`); }
}

// --- empty pool semantics ---

(function emptyPool_add_addsAllItems() {
  const result = applyDataOperation(
    [],
    [{ url: 'a', source_submodule: 'sitemap-parser' }, { url: 'b', source_submodule: 'sitemap-parser' }],
    'add',
    'url',
    new Set(['a', 'b']),
  );
  assert(result.pool.length === 2, 'empty + add → adds all items');
  assert(result.ops.added === 2, 'empty + add → ops.added === 2');
})();

(function emptyPool_transform_addsNothing() {
  const result = applyDataOperation(
    [],
    [{ url: 'a' }, { url: 'b' }],
    'transform',
    'url',
    new Set(['a', 'b']),
  );
  assert(result.pool.length === 0, 'empty + transform → adds nothing (THE BUG)');
})();

(function emptyPool_remove_returnsEmpty() {
  const result = applyDataOperation(
    [],
    [{ url: 'a' }],
    'remove',
    'url',
    new Set(['a']),
  );
  assert(result.pool.length === 0, 'empty + remove → empty');
})();

// --- non-empty pool semantics ---

(function nonEmptyPool_add_replacesSameSubmodule() {
  const pool = [
    { url: 'a', source_submodule: 'sitemap-parser', meta: 'old' },
    { url: 'c', source_submodule: 'rss-feeds' },
  ];
  const approved = [{ url: 'a', source_submodule: 'sitemap-parser', meta: 'new' }];
  const result = applyDataOperation(pool, approved, 'add', 'url', new Set(['a']));
  assert(result.pool.length === 2, 'add re-approval → keeps other submodule items');
  const found = result.pool.find(i => i.url === 'a' && i.source_submodule === 'sitemap-parser');
  assert(found?.meta === 'new', 'add re-approval → replaces own prior output');
})();

(function nonEmptyPool_transform_strictPer390e768() {
  const pool = [{ url: 'a', extra: 'x' }, { url: 'b', extra: 'y' }];
  const approved = [
    { url: 'a', extra: 'transformed' },
    { url: 'c', extra: 'NEW_KEY_should_be_dropped' },
  ];
  const result = applyDataOperation(pool, approved, 'transform', 'url', new Set(['a', 'c']));
  assert(result.pool.length === 2, 'transform → no net-new keys (390e768 contract)');
  assert(result.pool.find(i => i.url === 'a')?.extra === 'transformed', 'transform → existing key updated');
  assert(!result.pool.find(i => i.url === 'c'), 'transform → new key NOT injected (390e768 contract)');
  assert(result.pool.find(i => i.url === 'b'), 'transform → unmodified existing key preserved');
})();

(function nonEmptyPool_transform_canonicalization() {
  const pool = [{ url: 'https://example.com/a/', extra: 'x' }];
  const approved = [{ url: 'https://example.com/a', original_url: 'https://example.com/a/' }];
  const result = applyDataOperation(pool, approved, 'transform', 'url', new Set(['https://example.com/a']));
  assert(result.pool.length === 1, 'transform canonicalization → one item');
  assert(result.pool[0].url === 'https://example.com/a', 'transform canonicalization → url updated');
})();

(function nonEmptyPool_remove_filtersAndMerges() {
  const pool = [{ url: 'a' }, { url: 'b' }, { url: 'c' }];
  const approved = [
    { url: 'a', relevance: 0.9 },
    { url: 'c', relevance: 0.7 },
  ];
  const result = applyDataOperation(pool, approved, 'remove', 'url', new Set(['a', 'c']));
  assert(result.pool.length === 2, 'remove → filters to approved keys');
  assert(result.pool.find(i => i.url === 'a')?.relevance === 0.9, 'remove → merges enriched fields');
  assert(!result.pool.find(i => i.url === 'b'), 'remove → drops unapproved items');
})();

// --- error case ---

(function unknownDataOperation_throws() {
  let threw = false;
  try {
    applyDataOperation([], [], 'wat', 'url', new Set());
  } catch (e) {
    threw = e.message.includes('Unknown data_operation');
  }
  assert(threw, 'unknown op → throws with descriptive error');
})();

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
