/**
 * Phase 2B — Anthropic Message Batches helper tests (pure, no network).
 * Run: node --test --test-force-exit server/services/anthropicBatch.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBatchRequestParams, batchLedgerEntry,
  parseBatchResultsJsonl, normalizeBatchResult, pollAnthropicBatch,
} from './anthropicBatch.js';

test('buildBatchRequestParams: resolveModel + max_tokens default + no stream', () => {
  const p = buildBatchRequestParams({ prompt: 'hello', model: 'sonnet', provider: 'anthropic' });
  assert.equal(typeof p.model, 'string');
  assert.ok(p.model.startsWith('claude'), `resolved model id: ${p.model}`);
  assert.equal(p.max_tokens, 16384, 'defaults to 16384');
  assert.equal('stream' in p, false, 'no stream key (unsupported in batch)');
  // no cache_prefix -> plain string content (buildCachedUserContent passthrough)
  assert.equal(p.messages[0].content, 'hello');
});

test('buildBatchRequestParams: cache_prefix -> cache_control block; explicit max_tokens honored', () => {
  const p = buildBatchRequestParams({ prompt: 'CLAIMS', cache_prefix: 'STABLE-PREFIX', model: 'sonnet', provider: 'anthropic', max_tokens: 8192 });
  assert.equal(p.max_tokens, 8192);
  assert.ok(Array.isArray(p.messages[0].content), 'content is a two-block array when caching');
  assert.equal(p.messages[0].content[0].text, 'STABLE-PREFIX');
  assert.deepEqual(p.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(p.messages[0].content[1].text, 'CLAIMS');
});

test('normalizeBatchResult: succeeded extracts text/usage/stop_reason/service_tier/model', () => {
  const n = normalizeBatchResult({
    type: 'succeeded',
    message: {
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, service_tier: 'batch' },
    },
  });
  assert.equal(n.ok, true);
  assert.equal(n.text, 'AB');
  assert.equal(n.model, 'claude-sonnet-5');
  assert.equal(n.stop_reason, 'end_turn');
  assert.equal(n.service_tier, 'batch');
  assert.deepEqual(n.usage, { tokens_in: 10, tokens_out: 5, cache_write_tokens: 100, cache_read_tokens: 200 });
});

test('normalizeBatchResult: errored / expired / canceled -> ok:false with a reason', () => {
  const e = normalizeBatchResult({ type: 'errored', error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
  assert.equal(e.ok, false);
  assert.match(e.error, /errored/);
  assert.match(e.error, /Overloaded/);
  assert.equal(normalizeBatchResult({ type: 'expired' }).ok, false);
  assert.match(normalizeBatchResult({ type: 'expired' }).error, /expired/);
  assert.equal(normalizeBatchResult({ type: 'canceled' }).ok, false);
});

test('parseBatchResultsJsonl: keys by custom_id, tolerates blank/garbage lines', () => {
  const jsonl = [
    JSON.stringify({ custom_id: 'esr1__v0', result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'ok' }], usage: {}, stop_reason: 'end_turn' } } }),
    '',
    'not json',
    JSON.stringify({ custom_id: 'esr2__v0', result: { type: 'errored', error: { message: 'boom' } } }),
    JSON.stringify({ no_custom_id: true }),
  ].join('\n');
  const map = parseBatchResultsJsonl(jsonl);
  assert.equal(map.size, 2);
  assert.equal(map.get('esr1__v0').ok, true);
  assert.equal(map.get('esr1__v0').text, 'ok');
  assert.equal(map.get('esr2__v0').ok, false);
});

test('batchLedgerEntry: carries stop_reason + empty_completion so applyAiCallMeta guards fire', () => {
  const full = batchLedgerEntry(normalizeBatchResult({ type: 'succeeded', message: { model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 3, output_tokens: 1, service_tier: 'batch' } } }));
  assert.equal(full.provider, 'anthropic');
  assert.equal(full.stop_reason, 'end_turn');
  assert.equal(full.empty_completion, false);
  assert.equal(full.tokens_in, 3);
  // truncation signal
  const trunc = batchLedgerEntry(normalizeBatchResult({ type: 'succeeded', message: { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'cut' }], usage: {} } }));
  assert.equal(trunc.stop_reason, 'max_tokens', 'truncation surfaces so applyAiCallMeta fails closed');
  // empty completion signal
  const empty = batchLedgerEntry(normalizeBatchResult({ type: 'succeeded', message: { stop_reason: 'end_turn', content: [], usage: {} } }));
  assert.equal(empty.empty_completion, true, 'empty text surfaces so applyAiCallMeta fails closed');
});

test('pollAnthropicBatch: returns on ended; throws batchTimeout past the deadline (injected clock)', async () => {
  let calls = 0;
  const ended = await pollAnthropicBatch('msgbatch_x', 'key', {
    deadlineMs: 10_000,
    intervalMs: 0,
    sleep: async () => {},
    now: () => 0,
    getBatch: async () => (++calls >= 3 ? { processing_status: 'ended', results_url: 'u' } : { processing_status: 'in_progress' }),
  });
  assert.equal(ended.results_url, 'u');
  assert.equal(calls, 3);

  let t = 0;
  await assert.rejects(
    pollAnthropicBatch('msgbatch_y', 'key', {
      deadlineMs: 5,
      intervalMs: 0,
      sleep: async () => { t += 10; },
      now: () => t,
      getBatch: async () => ({ processing_status: 'in_progress' }),
    }),
    (err) => err.batchTimeout === true,
  );
});
