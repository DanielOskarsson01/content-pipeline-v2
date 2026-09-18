/**
 * F-D (VALIDATION_E2E_RUN1, run 9821ed56): INPUT-side truncation was invisible.
 *
 * Vixio was delivered 2,000,000 of 3,100,790 assembled chars (61%), LeoVegas
 * 2,000,000 of 2,643,189 (79%) — the analyzer DECLARED it on its result meta
 * (content_truncated / content_chars_total / content_chars_kept, the B029
 * module contract) and the skeleton persisted that meta — but only as
 * module-shaped JSONB deep inside entity_submodule_runs.output_data. Nothing
 * first-class or run-level recorded it; the validation pass, actively hunting
 * for the signal, declared it absent (report footnote ¹).
 *
 * UNDER HEAD (pre-fix): no skeleton code read these meta fields — this whole
 * test file FAILED (the helper did not exist; the persist spine wrote no
 * record). That red run documents the bug. UNDER THE FIX: the persist spine
 * (stageWorker sync §12 + batch persist) lifts the module's declaration into a
 * first-class decision_log row (decision='input_truncated'), so
 *   SELECT * FROM decision_log WHERE run_id = ? AND decision = 'input_truncated'
 * answers "how many entities in this run had their evidence cut, and by how
 * much" — from the database, not from logs.
 *
 * Run via: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { extractInputTruncation, buildInputTruncationLogRow } from './inputTruncation.js';

// The REAL Vixio meta from run 9821ed56 (queried from the archived run):
// entity_submodule_runs.output_data.meta for content-analyzer.
const VIXIO_META = {
  status: 'success',
  pages_analyzed: 598,
  total_words: 412581,
  content_truncated: true,
  content_chars_kept: 2000000,
  content_chars_total: 3100790,
};

// ── extractInputTruncation ───────────────────────────────────────────────────

test('extract: per-entity unwrapped result (the sync-spine shape) with truncated meta', () => {
  const result = { entity_name: 'Vixio Regulatory Intelligence', items: [{}], meta: VIXIO_META };
  assert.deepEqual(extractInputTruncation(result), {
    content_chars_total: 3100790,
    content_chars_kept: 2000000,
  });
});

test('extract: legacy multi-entity result shape ({results:[{meta}]}) is also read', () => {
  const result = { results: [{ entity_name: 'Vixio', items: [], meta: VIXIO_META }], summary: {} };
  assert.deepEqual(extractInputTruncation(result), {
    content_chars_total: 3100790,
    content_chars_kept: 2000000,
  });
});

test('extract: untruncated meta → null (byte-identity: the spine persists NOTHING new)', () => {
  // Push Gaming in the same run: full corpus delivered, no truncation fields.
  const result = {
    entity_name: 'Push Gaming', items: [{}],
    meta: { status: 'success', pages_analyzed: 530, total_words: 284734 },
  };
  assert.equal(extractInputTruncation(result), null);
});

test('extract: content_truncated must be exactly true (false / truthy strings → null)', () => {
  assert.equal(extractInputTruncation({ meta: { content_truncated: false } }), null);
  assert.equal(extractInputTruncation({ meta: { content_truncated: 'true' } }), null);
});

test('extract: defensive on absent/malformed shapes', () => {
  assert.equal(extractInputTruncation(null), null);
  assert.equal(extractInputTruncation({}), null);
  assert.equal(extractInputTruncation({ meta: null }), null);
  assert.equal(extractInputTruncation({ results: 'not-an-array' }), null);
  assert.equal(extractInputTruncation({ results: [null, { meta: null }] }), null);
});

test('extract: missing char counts still surfaces the truncation (nulls, not a drop)', () => {
  assert.deepEqual(extractInputTruncation({ meta: { content_truncated: true } }), {
    content_chars_total: null,
    content_chars_kept: null,
  });
});

// ── buildInputTruncationLogRow ───────────────────────────────────────────────

test('log row: the Vixio record — queryable decision_log shape with both char counts', () => {
  const row = buildInputTruncationLogRow({
    runId: '9821ed56-5e9a-4b9d-b47a-2d2385a74e76',
    stepIndex: 5,
    submoduleId: 'content-analyzer',
    entityName: 'Vixio Regulatory Intelligence',
    truncation: { content_chars_total: 3100790, content_chars_kept: 2000000 },
  });
  assert.equal(row.run_id, '9821ed56-5e9a-4b9d-b47a-2d2385a74e76');
  assert.equal(row.step_index, 5);
  assert.equal(row.submodule_id, 'content-analyzer');
  assert.equal(row.entity_id, 'Vixio Regulatory Intelligence');
  assert.equal(row.decision, 'input_truncated');
  // 2000000 / 3100790 = 64.4996% → 64
  assert.equal(row.context.pct_delivered, 64);
  assert.equal(row.context.content_chars_total, 3100790);
  assert.equal(row.context.content_chars_kept, 2000000);
  assert.equal(row.context.entity_name, 'Vixio Regulatory Intelligence');
  assert.match(row.reason, /2000000/);
  assert.match(row.reason, /3100790/);
  assert.match(row.reason, /64%/);
});

test('log row: missing char counts stay honest (no invented numbers, no pct)', () => {
  const row = buildInputTruncationLogRow({
    runId: 'r', stepIndex: 5, submoduleId: 'content-analyzer', entityName: 'X',
    truncation: { content_chars_total: null, content_chars_kept: null },
  });
  assert.equal(row.context.pct_delivered, null);
  assert.equal(row.context.content_chars_total, null);
  assert.match(row.reason, /\?/);
});

// ── Structural guards: the persist spine actually lifts the signal ──────────
// stageWorker.js cannot be imported in a unit test (it starts a live BullMQ
// worker at load — same constraint as entityRunStatus.test.js), so we pin the
// wiring textually: BOTH persist spines (sync §12 and batch) must call the
// helper and insert the decision_log row.

const stageWorkerSrc = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../workers/stageWorker.js'),
  'utf8'
);

test('structural: stageWorker imports the helper', () => {
  assert.match(
    stageWorkerSrc,
    /import \{ extractInputTruncation, buildInputTruncationLogRow \} from '\.\.\/utils\/inputTruncation\.js'/,
    'stageWorker.js must import the F-D helpers — under HEAD this import did not exist (the truncation stayed invisible)'
  );
});

test('structural: BOTH persist spines lift the truncation into decision_log', () => {
  const extractCalls = (stageWorkerSrc.match(/extractInputTruncation\(/g) || []).length;
  const buildCalls = (stageWorkerSrc.match(/buildInputTruncationLogRow\(/g) || []).length;
  // ≥2 each: the sync spine (handleEntityJob §12) AND the batch persist
  // (persistBatchEntityResult) — the batch spine's own comment mandates
  // mirroring the sync spine.
  assert.ok(extractCalls >= 2, `extractInputTruncation called in both spines (found ${extractCalls})`);
  assert.ok(buildCalls >= 2, `buildInputTruncationLogRow used in both spines (found ${buildCalls})`);
  assert.match(
    stageWorkerSrc,
    /from\('decision_log'\)\s*\.insert\(/,
    'the lifted truncation must be persisted as a decision_log row'
  );
});
