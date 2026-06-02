/**
 * Unit tests for executionPlanUtils.js (Sub-plan 1, Multi-Card Pattern).
 *
 * Priority focus per execution plan §iii:
 *   - UUID corruption detection (entry matches UUID_REGEX but absent from card_definitions)
 *   - Legacy / new / empty format detection
 *   - Edge cases (null card_definitions, missing fields, empty step list)
 *
 * Run: node server/tests/executionPlanUtils.test.mjs
 */
import {
  resolveStepEntry,
  resolveStepEntries,
  detectExecutionPlanFormat,
} from '../services/executionPlanUtils.js';

let passed = 0, failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else            { failed++; failures.push(label); console.log(`  ❌ ${label}`); }
}

function assertThrows(fn, expectedSubstring, label) {
  try {
    fn();
    failed++; failures.push(label); console.log(`  ❌ ${label} — expected throw, did not throw`);
  } catch (err) {
    if (err.message.includes(expectedSubstring)) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; failures.push(label); console.log(`  ❌ ${label} — error did not include "${expectedSubstring}": ${err.message}`); }
  }
}

// Suppress console.warn during corruption tests (we explicitly verify they LOG, not that the test output is noisy)
const _originalWarn = console.warn;
let warnCalls = [];
function captureWarn() {
  warnCalls = [];
  console.warn = (...args) => { warnCalls.push(args.join(' ')); };
}
function restoreWarn() { console.warn = _originalWarn; }

// ===========================================================================
// resolveStepEntry — new (UUID-keyed) lookup
// ===========================================================================
console.log('\n--- resolveStepEntry — new format (UUID lookup) ---');

const cardDefs = {
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890': {
    submodule_id: 'google-pse',
    card_name: 'pse-v2',
    rounds: { '1': { source: 'curated' }, '2': { source: 'broad' } },
  },
  'deadbeef-1234-5678-9abc-def012345678': {
    submodule_id: 'content-writer',
    name: 'writer-v2',
    rounds: { '1': { tone: 'strict' } },
  },
};

(function res_uuidLookup_returnsCardMeta() {
  const r = resolveStepEntry('a1b2c3d4-e5f6-7890-abcd-ef1234567890', cardDefs);
  assert(r.submodule_id === 'google-pse', 'submodule_id from card definition');
  assert(r.card_id === 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'card_id is the entry');
  assert(r.card_name === 'pse-v2', 'card_name resolved from card_name field');
  assert(r.round_1_overrides.source === 'curated', 'round_1_overrides from rounds["1"]');
  assert(r._corrupt === undefined, 'no _corrupt flag on valid entry');
})();

(function res_uuidLookup_fallsBackToNameField() {
  const r = resolveStepEntry('deadbeef-1234-5678-9abc-def012345678', cardDefs);
  assert(r.card_name === 'writer-v2', 'falls back to .name when .card_name absent');
})();

(function res_uuidLookup_missingRoundsKey() {
  const cardDefsNoR1 = { 'a1b2c3d4-e5f6-7890-abcd-ef1234567890': { submodule_id: 'x', rounds: { '2': {} } } };
  const r = resolveStepEntry('a1b2c3d4-e5f6-7890-abcd-ef1234567890', cardDefsNoR1);
  assert(JSON.stringify(r.round_1_overrides) === '{}', 'missing rounds["1"] → empty overrides');
})();

// ===========================================================================
// resolveStepEntry — legacy (submodule_id string)
// ===========================================================================
console.log('\n--- resolveStepEntry — legacy format ---');

(function res_legacy_returnsSubmoduleId() {
  const r = resolveStepEntry('sitemap-parser', cardDefs);
  assert(r.submodule_id === 'sitemap-parser', 'submodule_id is the entry');
  assert(r.card_id === null, 'card_id null for legacy');
  assert(r.card_name === null, 'card_name null for legacy');
  assert(JSON.stringify(r.round_1_overrides) === '{}', 'round_1_overrides empty for legacy');
})();

(function res_legacy_kebabCase() {
  const r = resolveStepEntry('linkedin-post-scraper', cardDefs);
  assert(r.submodule_id === 'linkedin-post-scraper', 'kebab-case submodule_id resolves as legacy');
})();

(function res_legacy_underscore() {
  const r = resolveStepEntry('csv_discovery', cardDefs);
  assert(r.submodule_id === 'csv_discovery', 'underscore submodule_id resolves as legacy');
})();

(function res_legacy_nullCardDefinitions() {
  const r = resolveStepEntry('sitemap-parser', null);
  assert(r.submodule_id === 'sitemap-parser', 'null cardDefinitions → treats entry as legacy');
})();

(function res_legacy_undefinedCardDefinitions() {
  const r = resolveStepEntry('sitemap-parser', undefined);
  assert(r.submodule_id === 'sitemap-parser', 'undefined cardDefinitions → treats entry as legacy');
})();

// ===========================================================================
// resolveStepEntry — corruption detection (UUID-shape but not in card_definitions)
// ===========================================================================
console.log('\n--- resolveStepEntry — corruption detection ---');

(function res_corrupt_unknownUuid() {
  captureWarn();
  const r = resolveStepEntry('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cardDefs);
  restoreWarn();
  assert(r._corrupt === true, '_corrupt: true when UUID-shape entry not in cardDefinitions');
  assert(r.submodule_id === null, 'submodule_id null on corruption');
  assert(r.card_id === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'card_id preserved for forensics');
  assert(warnCalls.length === 1, 'corruption logs exactly one warning');
  assert(warnCalls[0].includes('not found in card_definitions'), 'warning explains the cause');
})();

(function res_corrupt_emptyCardDefinitions() {
  captureWarn();
  const r = resolveStepEntry('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {});
  restoreWarn();
  assert(r._corrupt === true, 'empty card_definitions + UUID entry → _corrupt');
})();

(function res_corrupt_nullCardDefinitions_uuidEntry() {
  captureWarn();
  const r = resolveStepEntry('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', null);
  restoreWarn();
  assert(r._corrupt === true, 'null card_definitions + UUID entry → still corruption flag');
})();

// ===========================================================================
// resolveStepEntry — UUID_REGEX false-positive risk (BACKLOG #13)
// ===========================================================================
console.log('\n--- resolveStepEntry — UUID_REGEX false-positive guards ---');

(function res_kebabCase_doesNotMatchUuid() {
  // Kebab-case submodule IDs in the wild — verify NONE match UUID_REGEX
  const realIds = [
    'sitemap-parser', 'page-links', 'browser-crawler', 'content-analyzer',
    'content-writer', 'seo-planner', 'url-canonicalizer', 'intent-tagger',
    'boilerplate-stripper', 'hallucination-detector', 'citation-coverage-checker',
    'keyword-sufficiency-checker', 'meta-compliance-checker', 'qa-structural',
    'loop-router', 'markdown-output', 'html-output', 'json-output',
    'linkedin-profile-scraper', 'linkedin-post-scraper', 'api-search',
    'job-analyzer', 'cv-generator', 'csv-discovery',
  ];
  for (const id of realIds) {
    captureWarn();
    const r = resolveStepEntry(id, cardDefs);
    restoreWarn();
    assert(r.submodule_id === id && r._corrupt === undefined, `"${id}" treated as legacy (not UUID match)`);
  }
})();

(function res_uuidWithUppercase_matches() {
  // UUID_REGEX has /i flag — uppercase hex is valid UUID syntax
  captureWarn();
  const r = resolveStepEntry('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', cardDefs);
  restoreWarn();
  assert(r._corrupt === true, 'uppercase-hex UUID still matches UUID_REGEX → corruption flagged');
})();

// ===========================================================================
// resolveStepEntry — invalid input
// ===========================================================================
console.log('\n--- resolveStepEntry — invalid input ---');

(function res_throwsOnEmptyString() {
  assertThrows(
    () => resolveStepEntry('', cardDefs),
    'must be non-empty string',
    'empty string throws',
  );
})();

(function res_throwsOnNumber() {
  assertThrows(
    () => resolveStepEntry(123, cardDefs),
    'must be non-empty string',
    'number throws',
  );
})();

(function res_throwsOnNull() {
  assertThrows(
    () => resolveStepEntry(null, cardDefs),
    'must be non-empty string',
    'null throws',
  );
})();

(function res_throwsOnObject() {
  assertThrows(
    () => resolveStepEntry({ id: 'x' }, cardDefs),
    'must be non-empty string',
    'object throws',
  );
})();

// ===========================================================================
// resolveStepEntries — batch wrapper
// ===========================================================================
console.log('\n--- resolveStepEntries ---');

(function batch_emptyList() {
  const r = resolveStepEntries([], cardDefs);
  assert(Array.isArray(r) && r.length === 0, 'empty list → empty array');
})();

(function batch_nullList() {
  const r = resolveStepEntries(null, cardDefs);
  assert(Array.isArray(r) && r.length === 0, 'null list → empty array (defensive)');
})();

(function batch_undefinedList() {
  const r = resolveStepEntries(undefined, cardDefs);
  assert(Array.isArray(r) && r.length === 0, 'undefined list → empty array');
})();

(function batch_preservesOrder() {
  captureWarn();
  const r = resolveStepEntries([
    'sitemap-parser',
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    'page-links',
  ], cardDefs);
  restoreWarn();
  assert(r.length === 3, 'returns 3 entries');
  assert(r[0].submodule_id === 'sitemap-parser', 'order preserved [0]');
  assert(r[1].card_id === 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'order preserved [1]');
  assert(r[2].submodule_id === 'page-links', 'order preserved [2]');
})();

(function batch_mixedLegacyAndNew() {
  captureWarn();
  const r = resolveStepEntries(['sitemap-parser', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'], cardDefs);
  restoreWarn();
  assert(r[0].card_id === null && r[1].card_id !== null, 'legacy and new entries handled in same call');
})();

// ===========================================================================
// detectExecutionPlanFormat
// ===========================================================================
console.log('\n--- detectExecutionPlanFormat ---');

(function fmt_null() {
  assert(detectExecutionPlanFormat(null) === 'empty', 'null → empty');
})();

(function fmt_undefined() {
  assert(detectExecutionPlanFormat(undefined) === 'empty', 'undefined → empty');
})();

(function fmt_emptyObject() {
  assert(detectExecutionPlanFormat({}) === 'empty', '{} → empty');
})();

(function fmt_newFormat() {
  assert(detectExecutionPlanFormat({ card_definitions: { 'uuid': {} } }) === 'new', 'card_definitions populated → new');
})();

(function fmt_newFormatEmptyCardDefs() {
  // card_definitions present but empty — should NOT count as 'new'
  assert(detectExecutionPlanFormat({ card_definitions: {} }) === 'empty', 'empty card_definitions → empty (not new)');
})();

(function fmt_legacyFormat() {
  assert(detectExecutionPlanFormat({ cards: { 'pse-v2': {} } }) === 'legacy', 'cards populated → legacy');
})();

(function fmt_legacyEmptyCards() {
  assert(detectExecutionPlanFormat({ cards: {} }) === 'empty', 'empty cards → empty');
})();

(function fmt_bothPresent_preferNew() {
  // Migration moment: both might be present. New wins.
  assert(
    detectExecutionPlanFormat({ card_definitions: { 'uuid': {} }, cards: { 'pse-v2': {} } }) === 'new',
    'both present → new wins (migration safe)',
  );
})();

(function fmt_otherKeysIgnored() {
  // Plan may have other top-level keys (routing_rules, escalation_rules, etc.)
  assert(
    detectExecutionPlanFormat({ routing_rules: { 'x': 'y' }, escalation_rules: {} }) === 'empty',
    'unrelated keys without cards or card_definitions → empty',
  );
})();

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------
console.log(`\n\n=== Results ===`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
