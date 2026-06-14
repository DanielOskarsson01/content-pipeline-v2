/**
 * Tests for deriveEntityRunStatus + the stageWorker success-path status mirror.
 *
 * Run: npm test            (node --test, Node 18+)
 *      node --test server/utils/entityRunStatus.test.js
 *
 * Why these tests exist
 * ─────────────────────
 * deriveEntityRunStatus decides whether a per-entity submodule result is
 * 'completed' or 'failed'. In handleEntityJob (server/workers/stageWorker.js)
 * that single derived value is written to BOTH surfaces the system reads for
 * different purposes:
 *
 *   - entity_submodule_runs.status  → autoExecutor.evaluateStepResult halt threshold
 *   - entity_stage_pool.status      → batchWorker pipeline_stages completed/failed counts
 *                                      AND approve_step_v2 cross-step forwarding gate
 *                                      (only status='approved' rows forward; a 'failed'
 *                                       pool row is intentionally NOT carried forward).
 *
 * If the two surfaces are fed different values, the headline "N completed,
 * 0 failed" count masks a real failure even though the run row says 'failed'.
 * Commit 874c436 fixed that by mirroring the SAME derived status to the pool.
 * The structural guard at the bottom of this file prevents a silent revert of
 * that mirror back to a hardcoded literal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { deriveEntityRunStatus } from './entityRunStatus.js';

// ── deriveEntityRunStatus: the FAILED cases ──────────────────────────────────

test('meta.status === "error" → failed (module signalled a per-entity failure)', () => {
  const result = { items: [], meta: { status: 'error', error: 'content-writer: fetch failed' } };
  const { status, error } = deriveEntityRunStatus(result);
  assert.equal(status, 'failed');
  assert.equal(error, 'content-writer: fetch failed');
});

test('every item status === "error" → failed (even without meta.status)', () => {
  const result = {
    items: [
      { entity_name: 'Wazdan', status: 'error', error: 'seo-planner: JSON parse failed' },
      { entity_name: 'Wazdan', status: 'error', error: 'second error' },
    ],
  };
  const { status, error } = deriveEntityRunStatus(result);
  assert.equal(status, 'failed');
  // error precedence: first item carrying an error message
  assert.equal(error, 'seo-planner: JSON parse failed');
});

test('single item, status === "error" → failed', () => {
  const result = { items: [{ status: 'error', error: 'boom' }] };
  assert.equal(deriveEntityRunStatus(result).status, 'failed');
});

test('failed with no error message anywhere → default error string', () => {
  const result = { meta: { status: 'error' } };
  const { status, error } = deriveEntityRunStatus(result);
  assert.equal(status, 'failed');
  assert.equal(error, 'Submodule returned an error result for this entity');
});

test('error precedence: item.error wins over meta.error', () => {
  const result = {
    items: [{ status: 'error', error: 'item-level error' }],
    meta: { status: 'error', error: 'meta-level error' },
  };
  assert.equal(deriveEntityRunStatus(result).error, 'item-level error');
});

test('error precedence: meta.error used when no item carries an error', () => {
  // allItemsError requires every item status==='error'; here meta drives the failure
  const result = { items: [], meta: { status: 'error', error: 'meta-level error' } };
  assert.equal(deriveEntityRunStatus(result).error, 'meta-level error');
});

test('meta.status === "error" overrides successful items → failed', () => {
  // The module's explicit per-entity error signal wins even if items look fine.
  const result = {
    items: [{ status: 'success' }, { status: 'success' }],
    meta: { status: 'error', error: 'module aborted after producing items' },
  };
  const { status, error } = deriveEntityRunStatus(result);
  assert.equal(status, 'failed');
  assert.equal(error, 'module aborted after producing items');
});

// ── deriveEntityRunStatus: the COMPLETED cases (must NOT regress to failed) ───

test('CRITICAL: QA verdict qa_pass:false is NOT a failure → completed', () => {
  // A checker that returns qa_pass:false produced a VALID result; loop-router
  // routes it. Treating it as 'failed' would break routing + over-count failures.
  const result = {
    items: [{ entity_name: 'Wazdan', qa_pass: false, keyword_score: 0, status: 'success' }],
    meta: { status: 'success' },
  };
  assert.equal(deriveEntityRunStatus(result).status, 'completed');
});

test('partial: some items error, some ok → completed (not all-error)', () => {
  const result = {
    items: [
      { status: 'error', error: 'one page failed' },
      { status: 'success' },
    ],
  };
  assert.equal(deriveEntityRunStatus(result).status, 'completed');
});

test('all items succeed → completed', () => {
  const result = { items: [{ status: 'success' }, { status: 'success' }], meta: { status: 'success' } };
  const { status, error } = deriveEntityRunStatus(result);
  assert.equal(status, 'completed');
  assert.equal(error, null);
});

test('empty items, no meta (skip / no-op) → completed', () => {
  assert.equal(deriveEntityRunStatus({ items: [] }).status, 'completed');
});

test('items present but none carry a status field → completed (undefined !== "error")', () => {
  // allItemsError must require an explicit error status, not treat missing status as error
  const result = { items: [{ entity_name: 'A' }, { entity_name: 'B' }] };
  assert.equal(deriveEntityRunStatus(result).status, 'completed');
});

test('meta.status === "success", no items field → completed', () => {
  assert.equal(deriveEntityRunStatus({ meta: { status: 'success' } }).status, 'completed');
});

// ── deriveEntityRunStatus: defensive (must never throw) ───────────────────────

test('null result → completed (no throw)', () => {
  assert.equal(deriveEntityRunStatus(null).status, 'completed');
});

test('undefined result → completed (no throw)', () => {
  assert.equal(deriveEntityRunStatus(undefined).status, 'completed');
});

test('result with non-array items → completed (no throw)', () => {
  assert.equal(deriveEntityRunStatus({ items: 'oops' }).status, 'completed');
});

// ── Structural guard: the stageWorker success-path mirror ─────────────────────
// These read the source instead of importing it — importing stageWorker.js
// instantiates a live BullMQ Worker (connects to Redis) at module load, so it
// cannot be imported in a unit test. The guard catches the specific regression
// the mirror fix prevents: the success-path entity_stage_pool update silently
// reverting to a hardcoded literal while entity_submodule_runs keeps the
// derived status (the two surfaces drifting apart again).

const STAGE_WORKER = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workers', 'stageWorker.js'),
  'utf8',
);

test('guard: success-path entity_submodule_runs write uses the derived status', () => {
  // The main success write block: `const { error: writeErr } = await db ... .eq('id', entity_submodule_run_id);`
  const block = STAGE_WORKER.split('const { error: writeErr } = await db')[1]
    ?.split(".eq('id', entity_submodule_run_id);")[0];
  assert.ok(block, 'could not locate the success-path entity_submodule_runs update');
  assert.match(block, /status:\s*entityStatus/, 'entity_submodule_runs.status must be the derived entityStatus');
});

test('guard: success-path entity_stage_pool mirror uses entityStatus, not a literal', () => {
  // Isolate the block after the "Mirror the run status into entity_stage_pool"
  // comment so we do NOT match the throw-path pool update (which uses runStatus).
  const marker = 'Mirror the run status into entity_stage_pool';
  assert.ok(STAGE_WORKER.includes(marker), `expected mirror comment "${marker}" in stageWorker.js`);
  const block = STAGE_WORKER.split(marker)[1].split(".eq('entity_name', entity_name);")[0];

  assert.match(block, /status:\s*entityStatus/, 'pool mirror must write entityStatus');
  assert.doesNotMatch(
    block,
    /status:\s*['"]completed['"]/,
    'pool mirror must NOT hardcode "completed" (re-introduces the count-masking bug)',
  );
});
