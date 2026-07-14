/**
 * Unit tests for applyAiCallMeta (output-integrity: fail-closed on truncated LLM
 * output + per-entity AI usage observability).
 *
 * The load-bearing guarantee: a round-2 sonnet call that hit max_tokens must be
 * marked failed so the per-entity supersede gate preserves the complete round-1
 * content. These tests assert that chain end-to-end by importing the REAL
 * isFailedRun (supersede gate) and deriveEntityRunStatus (entity status),
 * not re-implemented copies — if either helper's contract drifts, this fails.
 *
 * Run: node --test server/tests/aiCallMeta.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAiCallMeta } from '../utils/aiCallMeta.js';
import { isFailedRun } from '../lib/applyDataOperation.js';
import { deriveEntityRunStatus } from '../utils/entityRunStatus.js';

const maxTokensCall = { provider: 'anthropic', model: 'sonnet', tokens_in: 56600, tokens_out: 16384, stop_reason: 'max_tokens' };
const completeCall  = { provider: 'anthropic', model: 'sonnet', tokens_in: 21834, tokens_out: 6698,  stop_reason: 'end_turn' };

test('truncation → meta.status=error, truncated flag, and isFailedRun true (supersede skipped)', () => {
  const result = { items: [{ entity_name: 'Push Gaming', body_markdown: 'partial…' }], meta: {} };
  applyAiCallMeta(result, [maxTokensCall]);

  assert.equal(result.meta.status, 'error', 'must mark failed so supersede gate fires');
  assert.equal(result.meta.truncated, true);
  assert.equal(result.meta.truncated_by, 'anthropic/sonnet');
  // The whole point: the supersede gate (submoduleRuns.js:1261) branches on this.
  assert.equal(isFailedRun(result), true, 'isFailedRun must be true → preserve-on-failure, round-1 survives');
  assert.equal(deriveEntityRunStatus(result).status, 'failed', 'entity run must be failed');
});

test('stop_reason captured and propagated into meta.ai_usage.calls', () => {
  const result = { items: [], meta: {} };
  applyAiCallMeta(result, [completeCall, maxTokensCall]);
  const reasons = result.meta.ai_usage.calls.map(c => c.stop_reason);
  assert.deepEqual(reasons, ['end_turn', 'max_tokens']);
});

test('token usage totals land in meta.ai_usage (FIX 4)', () => {
  const result = { items: [], meta: {} };
  applyAiCallMeta(result, [completeCall, maxTokensCall]);
  assert.equal(result.meta.ai_usage.tokens_in_total, 56600 + 21834);
  assert.equal(result.meta.ai_usage.tokens_out_total, 16384 + 6698);
  assert.equal(result.meta.ai_usage.calls.length, 2);
});

test('complete output (end_turn) is NOT failed — round-2 supersedes normally', () => {
  const result = { items: [{ body_markdown: 'full profile' }], meta: {} };
  applyAiCallMeta(result, [completeCall]);
  assert.notEqual(result.meta.status, 'error');
  assert.equal(result.meta.truncated, undefined);
  assert.equal(isFailedRun(result), false, 'a complete retry must be free to supersede round-1');
  // usage still recorded even on success
  assert.equal(result.meta.ai_usage.tokens_out_total, 6698);
});

test('no AI calls → meta untouched (non-LLM module keeps its result)', () => {
  const result = { items: [{ url: 'x' }], meta: { status: 'ok', count: 1 } };
  applyAiCallMeta(result, []);
  assert.deepEqual(result.meta, { status: 'ok', count: 1 }, 'no ai_usage, no clobber');
  assert.equal(isFailedRun(result), false);
});

test('module already errored → keep its error message, still record usage', () => {
  const result = { items: [], meta: { status: 'error', error: 'fetch failed' } };
  applyAiCallMeta(result, [maxTokensCall]);
  assert.equal(result.meta.error, 'fetch failed', 'do not clobber the module’s own error');
  assert.equal(result.meta.truncated, true);
  assert.equal(result.meta.ai_usage.tokens_out_total, 16384);
});

test('missing meta object is created; non-object result is a no-op', () => {
  const r1 = { items: [] };
  applyAiCallMeta(r1, [maxTokensCall]);
  assert.equal(r1.meta.status, 'error');

  assert.equal(applyAiCallMeta(null, [maxTokensCall]), null);
  assert.equal(applyAiCallMeta('nope', [maxTokensCall]), 'nope');
});
