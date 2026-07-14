/**
 * Unit tests for applyDataOperation and validateManifest.
 *
 * No API, no DB, no fixtures. Pure function in, pure value out.
 *
 * Run: node server/tests/data-operations.test.mjs
 */
import { applyDataOperation, isFailedRun } from '../lib/applyDataOperation.js';
import { validateManifest } from '../services/moduleLoader.js';

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

// --- B054 fix: multi-source dedup in remove + transform (2026-06-06) ---

(function nonEmptyPool_remove_collapsesMultiSourceDuplicates() {
  // Step 1 `add` writes one row per (url, source_submodule). Step 2 `remove`
  // approves URLs (not URL-source pairs), so after `remove` the pool must
  // contain AT MOST ONE row per url. First occurrence wins. This is the
  // observed prod bug: 3 copies of `/about-us/` (from browser-crawler,
  // deep-links, page-links) all survived url-dedup before the fix.
  const pool = [
    { url: 'https://x.com/about', source_submodule: 'browser-crawler', section: 'nav' },
    { url: 'https://x.com/about', source_submodule: 'deep-links', section: 'footer' },
    { url: 'https://x.com/about', source_submodule: 'page-links', section: 'body' },
    { url: 'https://x.com/blog', source_submodule: 'browser-crawler' },
    { url: 'https://x.com/blog', source_submodule: 'deep-links' },
    { url: 'https://x.com/contact', source_submodule: 'browser-crawler' },
  ];
  const approved = [
    { url: 'https://x.com/about', status: 'unique' },
    { url: 'https://x.com/blog',  status: 'unique' },
    { url: 'https://x.com/contact', status: 'unique' },
  ];
  const result = applyDataOperation(
    pool,
    approved,
    'remove',
    'url',
    new Set(['https://x.com/about', 'https://x.com/blog', 'https://x.com/contact']),
  );
  assert(result.pool.length === 3, 'remove → collapses multi-source duplicates to one row per url');
  assert(result.pool.filter(i => i.url === 'https://x.com/about').length === 1, 'remove → exactly one /about row survives');
  assert(result.pool.filter(i => i.url === 'https://x.com/blog').length === 1, 'remove → exactly one /blog row survives');
  // First occurrence wins: the browser-crawler row should be the survivor for /about
  const aboutSurvivor = result.pool.find(i => i.url === 'https://x.com/about');
  assert(aboutSurvivor?.source_submodule === 'browser-crawler', 'remove → first occurrence wins');
  assert(aboutSurvivor?.section === 'nav', 'remove → survivor retains its own per-source fields');
  // ops.removed counts both unapproved-rejects AND subsequent-key dropouts
  assert(result.ops.removed === 3, 'remove → ops.removed counts the dropped multi-source dupes');
})();

(function nonEmptyPool_remove_singleSourceUnchanged() {
  // Guard: the fix MUST NOT change behavior for the common case of
  // already-deduplicated pools (no multi-source duplicates).
  const pool = [{ url: 'a' }, { url: 'b' }, { url: 'c' }];
  const approved = [{ url: 'a', relevance: 0.9 }, { url: 'c', relevance: 0.7 }];
  const result = applyDataOperation(pool, approved, 'remove', 'url', new Set(['a', 'c']));
  assert(result.pool.length === 2, 'remove single-source → unchanged from pre-fix behavior');
  assert(result.pool.find(i => i.url === 'a')?.relevance === 0.9, 'remove single-source → enrich still applied');
})();

(function nonEmptyPool_transform_collapsesMultiSourceDuplicates() {
  // Pool has multi-source duplicates for URLs that url-canonicalizer leaves
  // UNCHANGED (no redirect needed). Pre-fix, these passed through with all
  // copies intact. Post-fix, transform collapses them to one row per url.
  const pool = [
    { url: 'https://x.com/about', source_submodule: 'browser-crawler' },
    { url: 'https://x.com/about', source_submodule: 'deep-links' },
    { url: 'https://x.com/about', source_submodule: 'page-links' },
    { url: 'https://x.com/blog',  source_submodule: 'browser-crawler' },
    { url: 'https://x.com/blog',  source_submodule: 'deep-links' },
  ];
  // Canonicalizer approves both URLs as "unchanged" — no redirects, items match
  // existing pool keys but bring no transformation.
  const approved = [
    { url: 'https://x.com/about', status: 'unchanged' },
    { url: 'https://x.com/blog',  status: 'unchanged' },
  ];
  const result = applyDataOperation(
    pool,
    approved,
    'transform',
    'url',
    new Set(['https://x.com/about', 'https://x.com/blog']),
  );
  assert(result.pool.length === 2, 'transform → collapses multi-source duplicates to one row per url');
  assert(result.pool.filter(i => i.url === 'https://x.com/about').length === 1, 'transform → exactly one /about row');
  assert(result.pool.filter(i => i.url === 'https://x.com/blog').length === 1, 'transform → exactly one /blog row');
})();

(function nonEmptyPool_transform_canonicalizationStillWorks() {
  // Guard: the multi-source dedup MUST NOT break the existing redirect
  // canonicalization (test nonEmptyPool_transform_canonicalization above
  // exercises one redirect; this guards the redirect + multi-source combo).
  const pool = [
    { url: 'https://x.com/a/', source_submodule: 'browser-crawler', extra: 'x' },
    { url: 'https://x.com/a/', source_submodule: 'deep-links',      extra: 'y' },
  ];
  // Canonicalizer transforms /a/ → /a (redirect). Both pool copies should
  // collapse and the new (transformed) row should win, not a stale pool copy.
  const approved = [{ url: 'https://x.com/a', original_url: 'https://x.com/a/' }];
  const result = applyDataOperation(
    pool,
    approved,
    'transform',
    'url',
    new Set(['https://x.com/a']),
  );
  assert(result.pool.length === 1, 'transform redirect + multi-source → one row');
  assert(result.pool[0].url === 'https://x.com/a', 'transform redirect + multi-source → canonical url wins');
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

// --- runtime precondition check (pure-function representation) ---

(function precondition_requires_items_emptyPool_skips() {
  function shouldSkip(precondition, poolLength) {
    return precondition === 'requires_items' && poolLength === 0;
  }
  assert(shouldSkip('requires_items', 0) === true,   'requires_items + empty → skip');
  assert(shouldSkip('requires_items', 5) === false,  'requires_items + non-empty → execute');
  assert(shouldSkip('empty_ok', 0) === false,        'empty_ok + empty → execute');
  assert(shouldSkip('empty_ok', 5) === false,        'empty_ok + non-empty → execute');
})();

// --- manifest validation (Task 8) ---

(function validation_missingPoolPrecondition_throws() {
  let threw = false;
  try {
    validateManifest({
      id: 'foo', name: 'Foo', description: 'Foo', version: '1.0.0',
      step: 1, category: 'discovery', cost: 'cheap',
      data_operation_default: 'add', requires_columns: [], item_key: 'url',
      output_schema: {},
      // pool_precondition intentionally omitted
    }, '/fake/path/manifest.json');
  } catch (e) {
    threw = e.message.includes('missing required field') && e.message.includes('pool_precondition');
  }
  assert(threw, 'missing pool_precondition → throws');
})();

(function validation_invalidPoolPrecondition_throws() {
  let threw = false;
  try {
    validateManifest({
      id: 'foo', name: 'Foo', description: 'Foo', version: '1.0.0',
      step: 1, category: 'discovery', cost: 'cheap',
      data_operation_default: 'add', requires_columns: [], item_key: 'url',
      output_schema: {}, pool_precondition: 'bogus',
    }, '/fake/path/manifest.json');
  } catch (e) {
    threw = e.message.includes('invalid pool_precondition');
  }
  assert(threw, 'invalid pool_precondition → throws');
})();

(function validation_invalidDataOperation_throws() {
  let threw = false;
  try {
    validateManifest({
      id: 'foo', name: 'Foo', description: 'Foo', version: '1.0.0',
      step: 1, category: 'discovery', cost: 'cheap',
      data_operation_default: 'wat', requires_columns: [], item_key: 'url',
      output_schema: {}, pool_precondition: 'empty_ok',
    }, '/fake/path/manifest.json');
  } catch (e) {
    threw = e.message.includes('invalid data_operation_default');
  }
  assert(threw, 'invalid data_operation_default → throws');
})();

// --- FIX B: preserve-on-failure supersede gate (isFailedRun) ---

(function isFailedRun_metaError_true() {
  assert(isFailedRun({ meta: { status: 'error' }, items: [] }) === true, 'meta.status=error → isFailedRun true');
})();

(function isFailedRun_success_and_unset_false() {
  assert(isFailedRun({ meta: { status: 'success' }, items: [{}] }) === false, 'meta.status=success → isFailedRun false');
  assert(isFailedRun({ items: [] }) === false, 'no meta.status (QA fails / normal outputs) → isFailedRun false');
  assert(isFailedRun(undefined) === false, 'undefined output → isFailedRun false');
})();

(function preserveOnFailure_failedRetryDoesNotEvictPriorContent() {
  // Round-1 good content-writer item in the pool (keyed by entity_name + source).
  const prior = [{ entity_name: 'Slotmill', source_submodule: 'content-writer', content_markdown: '# real content', status: 'written' }];
  // Round-2 FAILED output: contentless error item, same composite key.
  const failedOut = { meta: { status: 'error' }, items: [{ entity_name: 'Slotmill', status: 'error', content_markdown: '' }] };
  const failedApproved = failedOut.items.map(it => ({ ...it, source_submodule: 'content-writer' }));

  // Gate: failed run → caller skips applyDataOperation → prior pool preserved.
  assert(isFailedRun(failedOut) === true, 'failed retry classified as failure → supersede skipped');

  // Proof of the bug the gate prevents: WITHOUT the gate, `add` evicts the prior
  // item (same composite key) and leaves only the contentless placeholder →
  // bundler finds no content_markdown → empty bundle.
  const { pool: bugged } = applyDataOperation([...prior], failedApproved, 'add', 'entity_name', new Set(['Slotmill']));
  assert(bugged.length === 1 && bugged[0].content_markdown === '', 'ungated add would evict prior content (the bug)');
})();

(function replaceOnSuccess_goodRetrySupersedes() {
  const prior = [{ entity_name: 'Slotmill', source_submodule: 'content-writer', content_markdown: '# haiku', status: 'written' }];
  const goodOut = { meta: { status: 'success' }, items: [{ entity_name: 'Slotmill', status: 'written', content_markdown: '# sonnet' }] };
  const goodApproved = goodOut.items.map(it => ({ ...it, source_submodule: 'content-writer' }));
  assert(isFailedRun(goodOut) === false, 'successful retry → not a failed run (supersede proceeds)');
  const { pool } = applyDataOperation([...prior], goodApproved, 'add', 'entity_name', new Set(['Slotmill']));
  assert(pool.length === 1 && pool[0].content_markdown === '# sonnet', 'successful retry supersedes prior content');
})();

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
