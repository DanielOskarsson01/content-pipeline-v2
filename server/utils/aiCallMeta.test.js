/**
 * applyAiCallMeta — provider-agnostic truncation fail-closed + finish_reason
 * observability (CEILING §T2, the fifth swallowed-failure instance).
 *
 * The bug these tests close: the truncation guard detected truncation by
 * stop_reason === 'max_tokens' — Anthropic's field only. The four OpenAI-compat
 * branches (openai/perplexity/gemini/openrouter) report truncation as
 * finish_reason: 'length' and push stop_reason: null, so a gemini call that hit
 * its output ceiling produced a well-formed partial analysis stamped
 * meta.status: 'success', and finish_reason was not persisted in ai_usage.calls
 * — invisible afterwards. Receipts: all 3 REMAINING_SLOTS Push analyzer draws
 * exhausted the full 32,768 budget with finish_reason 'length'; two "succeeded".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAiCallMeta } from './aiCallMeta.js';

// The exact ledger shape stageWorker.js:496-511 (and submoduleHarness.js:267-281)
// pushes into tools._aiCalls.
function call(over = {}) {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    tokens_in: 1000,
    tokens_out: 500,
    tokens_total: 0,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    provider_cost: null,
    stop_reason: null,
    empty_completion: false,
    finish_reason: null,
    ...over,
  };
}

// Per-provider CLEAN (untruncated) shapes, as each stageWorker branch produces them.
const CLEAN = {
  anthropic: call({ stop_reason: 'end_turn', finish_reason: 'end_turn' }),
  openai: call({ provider: 'openai', model: 'gpt-4.1', finish_reason: 'stop' }),
  perplexity: call({ provider: 'perplexity', model: 'sonar', finish_reason: 'stop' }),
  gemini: call({ provider: 'gemini', model: 'gemini-3.8-flash', finish_reason: 'stop', tokens_total: 1800 }),
  openrouter: call({ provider: 'openrouter', model: 'meta-llama/llama-4', finish_reason: 'stop', provider_cost: 0.0123 }),
};

// Per-provider TRUNCATED shapes.
const TRUNCATED = {
  anthropic: call({ stop_reason: 'max_tokens', finish_reason: 'max_tokens', tokens_out: 16384 }),
  // anthropicBatch.js batchLedgerEntry: finish_reason mirrors stop_reason, service_tier rides along.
  anthropic_batch: call({ stop_reason: 'max_tokens', finish_reason: 'max_tokens', tokens_out: 8192, service_tier: 'batch' }),
  openai: call({ provider: 'openai', model: 'gpt-4.1', finish_reason: 'length', tokens_out: 16384 }),
  perplexity: call({ provider: 'perplexity', model: 'sonar', finish_reason: 'length', tokens_out: 4096 }),
  gemini: call({ provider: 'gemini', model: 'gemini-3.8-flash', finish_reason: 'length', tokens_out: 53542, tokens_total: 55580 }),
  openrouter: call({ provider: 'openrouter', model: 'meta-llama/llama-4', finish_reason: 'length', tokens_out: 32768, provider_cost: 0.31 }),
};

// ---------------------------------------------------------------------------
// THE MISS TEST — the bug this unit closes.
// Under HEAD (predicate: c.stop_reason === 'max_tokens' only), this exact shape
// — gemini, finish_reason 'length', stop_reason null — yielded meta.status
// 'success': the truncated JSON was salvaged by json_retry, the hollow gate
// passed, and nothing anywhere flagged the amputation. Under the fix it MUST
// fail closed naming provider, field, and token count.
// ---------------------------------------------------------------------------
test("MISS: gemini finish_reason 'length' with stop_reason null fails closed as truncation", () => {
  const result = applyAiCallMeta({ items: [], meta: { status: 'success' } }, [TRUNCATED.gemini]);
  assert.equal(result.meta.status, 'error', "was 'success' under HEAD — the swallowed truncation");
  assert.equal(result.meta.truncated, true);
  assert.equal(result.meta.truncated_by, 'gemini/gemini-3.8-flash');
  assert.match(result.meta.error, /finish_reason 'length'/, 'reason must name the reporting field');
  assert.match(result.meta.error, /53542 output tokens/, 'reason must name the token count');
  assert.match(result.meta.error, /gemini\/gemini-3\.8-flash/, 'reason must name provider/model');
});

test("openai / perplexity / openrouter finish_reason 'length' also fail closed", () => {
  for (const p of ['openai', 'perplexity', 'openrouter']) {
    const result = applyAiCallMeta({ items: [], meta: { status: 'success' } }, [TRUNCATED[p]]);
    assert.equal(result.meta.status, 'error', `${p}: truncation must not report success`);
    assert.equal(result.meta.truncated, true, p);
    assert.match(result.meta.error, /finish_reason 'length'/, p);
    assert.match(result.meta.error, new RegExp(`${TRUNCATED[p].tokens_out} output tokens`), p);
  }
});

test("anthropic stop_reason 'max_tokens' still fires — sync and batch shapes", () => {
  for (const key of ['anthropic', 'anthropic_batch']) {
    const result = applyAiCallMeta({ items: [], meta: {} }, [TRUNCATED[key]]);
    assert.equal(result.meta.status, 'error', key);
    assert.equal(result.meta.truncated, true, key);
    assert.equal(result.meta.truncated_by, 'anthropic/claude-sonnet-5', key);
    assert.match(result.meta.error, /stop_reason 'max_tokens'/, `${key}: reason names the field`);
    assert.match(result.meta.error, new RegExp(`${TRUNCATED[key].tokens_out} output tokens`), key);
  }
});

// ---------------------------------------------------------------------------
// Byte-identity: an untruncated call of every provider shape leaves meta/status
// exactly as HEAD did, and ai_usage is identical to HEAD's output except the
// deliberately added finish_reason field (TASK 2b observability).
// ---------------------------------------------------------------------------
test('clean calls: status untouched, ai_usage identical to HEAD modulo the added finish_reason', () => {
  for (const [p, c] of Object.entries(CLEAN)) {
    const result = applyAiCallMeta({ items: [{ x: 1 }], meta: { status: 'success' } }, [c]);
    assert.equal(result.meta.status, 'success', p);
    assert.equal(result.meta.truncated, undefined, p);
    assert.equal(result.meta.error, undefined, p);

    // HEAD's exact per-call persisted shape (aiCallMeta.js calls map, pre-fix).
    const headCall = {
      provider: c.provider,
      model: c.model,
      tokens_in: c.tokens_in,
      tokens_out: c.tokens_out,
      cache_write_tokens: c.cache_write_tokens,
      cache_read_tokens: c.cache_read_tokens,
      tokens_total: c.tokens_total,
      provider_cost: c.provider_cost,
      stop_reason: c.stop_reason,
    };
    const persisted = { ...result.meta.ai_usage.calls[0] };
    delete persisted.finish_reason;
    assert.deepEqual(persisted, headCall, `${p}: ai_usage.calls byte-identical to HEAD minus finish_reason`);

    // Totals unchanged from HEAD.
    assert.equal(result.meta.ai_usage.tokens_in_total, c.tokens_in, p);
    assert.equal(result.meta.ai_usage.tokens_out_total, c.tokens_out, p);
  }
});

test('finish_reason (and stop_reason) persist in ai_usage.calls for clean and truncated calls', () => {
  for (const set of [CLEAN, TRUNCATED]) {
    for (const [key, c] of Object.entries(set)) {
      const result = applyAiCallMeta({ items: [], meta: {} }, [c]);
      const persisted = result.meta.ai_usage.calls[0];
      assert.equal(persisted.finish_reason, c.finish_reason, `${key}: finish_reason persisted`);
      assert.equal(persisted.stop_reason, c.stop_reason, `${key}: stop_reason persisted`);
    }
  }
});

// ---------------------------------------------------------------------------
// A genuine content failure stays a content failure.
// ---------------------------------------------------------------------------
test('content failure with clean calls is not misreported as truncation', () => {
  const result = applyAiCallMeta(
    { items: [], meta: { status: 'error', error: 'vocabulary fidelity gate failed' } },
    [CLEAN.gemini]
  );
  assert.equal(result.meta.status, 'error');
  assert.equal(result.meta.error, 'vocabulary fidelity gate failed');
  assert.equal(result.meta.truncated, undefined);
});

test("module's own error message survives a truncated call (guard flags but never overwrites)", () => {
  const result = applyAiCallMeta(
    { items: [], meta: { status: 'error', error: 'module-level failure' } },
    [TRUNCATED.gemini]
  );
  assert.equal(result.meta.status, 'error');
  assert.equal(result.meta.error, 'module-level failure');
  assert.equal(result.meta.truncated, true, 'truncated flag still recorded');
});

// ---------------------------------------------------------------------------
// Regressions: the refused/empty guard and the no-op paths are untouched.
// ---------------------------------------------------------------------------
test('refused guard unchanged: empty_completion fails closed as refusal, not truncation', () => {
  const c = call({ provider: 'gemini', model: 'gemini-3.8-flash', finish_reason: 'stop', empty_completion: true, tokens_out: 0 });
  const result = applyAiCallMeta({ items: [], meta: {} }, [c]);
  assert.equal(result.meta.status, 'error');
  assert.equal(result.meta.refused, true);
  assert.equal(result.meta.truncated, undefined);
  assert.match(result.meta.error, /empty\/refused/);
});

test('no-op on empty calls and non-object results', () => {
  const untouched = { items: [], meta: { status: 'success' } };
  assert.equal(applyAiCallMeta(untouched, []), untouched);
  assert.equal(untouched.meta.ai_usage, undefined);
  assert.equal(applyAiCallMeta(null, [CLEAN.gemini]), null);
});
