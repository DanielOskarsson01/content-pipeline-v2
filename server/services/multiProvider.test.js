/**
 * BACKLOG #49 — multi-provider routing (Gemini) byte-parity + landmine guard.
 *
 * The provider switch is duplicated across stageWorker.js (prod) and
 * submoduleHarness.js (workbench). This test:
 *   1. wraps fetch and drives the IMPORTABLE copy (submoduleHarness) to assert
 *      the exact request body per provider — proving openai/perplexity stay
 *      BYTE-IDENTICAL (content === prompt, no cache_prefix) while gemini inlines
 *      cache_prefix into the content (never decapitated);
 *   2. source-asserts the PROD copy (stageWorker starts a BullMQ worker on
 *      import, so it can't be imported here — same pattern as promptCache.test.js)
 *      and MODEL_MAP parity between the two files, so the next hand-sync drift
 *      fails CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildHarnessTools } from './submoduleHarness.js';
import { applyAiCallMeta } from '../utils/aiCallMeta.js';
import { costOfUsage } from '../lib/aiCost.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAGEWORKER = readFileSync(path.join(__dirname, '../workers/stageWorker.js'), 'utf8');
const HARNESS = readFileSync(path.join(__dirname, 'submoduleHarness.js'), 'utf8');

// Drive one non-anthropic ai.complete call with fetch stubbed; return the
// captured request (url + parsed JSON body), the ai.complete result, and the
// tools ledger (_aiCalls). `content` overrides the stubbed completion text so a
// safety-refusal (empty text) can be simulated.
async function capture(completeArgs, { content = 'RESP', finish_reason = 'stop' } = {}) {
  const orig = globalThis.fetch;
  const keys = ['OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'GOOGLE_AI_API_KEY'];
  const savedKeys = keys.map((k) => process.env[k]);
  keys.forEach((k) => { process.env[k] = 'test-key'; });
  const captured = [];
  globalThis.fetch = async (url, opts) => {
    captured.push({ url, opts });
    return {
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content }, finish_reason }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 42 },
        model: 'stub',
        citations: ['https://x'],
      }),
    };
  };
  try {
    const tools = buildHarnessTools('t', []);
    const result = await tools.ai.complete(completeArgs);
    assert.equal(captured.length, 1, 'exactly one fetch per call');
    return { req: captured[0], body: JSON.parse(captured[0].opts.body), result, calls: tools._aiCalls };
  } finally {
    globalThis.fetch = orig;
    keys.forEach((k, i) => { if (savedKeys[i] === undefined) delete process.env[k]; else process.env[k] = savedKeys[i]; });
  }
}

// ── openai / perplexity stay byte-identical: cache_prefix is NOT inlined ──
// (models are now provider-scoped: gpt-4o for openai, sonar for perplexity — the
// old test paired perplexity+gpt-4o, a cross-provider mismatch the registry now
// correctly rejects.)
for (const [provider, model] of [['openai', 'gpt-4o'], ['perplexity', 'sonar']]) {
  test(`${provider}: cache_prefix is NOT sent (content === prompt, byte-identical to pre-#49)`, async () => {
    const { req, body } = await capture({ provider, model, prompt: 'PROMPT', cache_prefix: 'BIG-STABLE-DOCS' });
    assert.equal(body.messages[0].content, 'PROMPT', 'content must be the bare prompt — no prefix');
    assert.ok(!('cache_prefix' in body) && !('thinking' in body) && !('output_config' in body), 'no anthropic-only keys leak into the body');
    assert.match(req.url, provider === 'openai' ? /api\.openai\.com/ : /api\.perplexity\.ai/);
  });
}

// ── gemini: cache_prefix INLINED, never decapitated ──
test('gemini: cache_prefix is inlined as prefix+prompt (content-analyzer is not decapitated)', async () => {
  const { req, body, result } = await capture({ provider: 'gemini', model: 'gemini-flash', prompt: 'PROMPT', cache_prefix: 'DOCS::' });
  assert.equal(body.messages[0].content, 'DOCS::PROMPT', 'gemini content = cache_prefix + prompt (byte-identical to the split)');
  assert.equal(body.model, 'gemini-flash-latest', 'MODEL_MAP resolves gemini-flash → gemini-flash-latest');
  assert.match(req.url, /generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions/);
  assert.equal(req.opts.headers.Authorization, 'Bearer test-key');
  assert.equal(result.provider, 'gemini');
  assert.equal(result.tokens_in, 11);
  assert.equal(result.tokens_out, 7);
  assert.equal(result.tokens_total, 42, 'gemini carries total_tokens for cost math');
});

test('gemini: no cache_prefix → content === prompt (byte-identical)', async () => {
  const { body } = await capture({ provider: 'gemini', model: 'gemini-pro', prompt: 'JUST-PROMPT' });
  assert.equal(body.messages[0].content, 'JUST-PROMPT');
  assert.equal(body.model, 'gemini-pro-latest');
});

test('gemini: empty-string cache_prefix is treated as absent (guarded — no "undefined"+prompt)', async () => {
  const { body } = await capture({ provider: 'gemini', model: 'gemini-flash', prompt: 'P', cache_prefix: '' });
  assert.equal(body.messages[0].content, 'P');
});

// ── prod copy (stageWorker) parity: can't import it, so assert the source ──
test('stageWorker prod copy carries the same gemini branch (source parity)', () => {
  assert.match(STAGEWORKER, /provider === 'gemini'/, 'stageWorker must have a gemini branch');
  assert.match(STAGEWORKER, /generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions/, 'stageWorker gemini endpoint');
  assert.match(STAGEWORKER, /cache_prefix\.length > 0[\s\S]{0,40}\?\s*cache_prefix \+ prompt/, 'stageWorker inlines cache_prefix for gemini');
  assert.match(STAGEWORKER, /Supported: anthropic, openai, perplexity, gemini/, 'stageWorker unknown-provider message lists gemini');
});

// ── #49: both copies resolve via the shared registry, no local MODEL_MAP ──
test('both copies resolve via the registry (resolveModel), MODEL_MAP is gone', () => {
  for (const [name, src] of [['stageWorker', STAGEWORKER], ['submoduleHarness', HARNESS]]) {
    assert.match(src, /import \{ resolveModel \} from '\.\.\/config\/llmRegistry\.js'/, `${name} imports resolveModel from the registry`);
    assert.match(src, /resolveModel\(provider, model\)/, `${name} resolves via resolveModel(provider, model)`);
    assert.ok(!/const MODEL_MAP = \{/.test(src), `${name} no longer declares a local MODEL_MAP`);
  }
});

test('both copies flag empty_completion + carry finish_reason (source parity)', () => {
  for (const [name, src] of [['stageWorker', STAGEWORKER], ['submoduleHarness', HARNESS]]) {
    assert.match(src, /empty_completion: !res\.text \|\| res\.text\.trim\(\) === ''/, `${name} flags empty completions into the ledger`);
    assert.match(src, /finish_reason: res\.finish_reason \?\? res\.stop_reason \?\? null/, `${name} carries finish_reason`);
  }
});

// ── provider-scoped resolution: a bad pair throws BEFORE any HTTP call ──
test('resolveModel: gemini + a sonnet key throws at resolution, before the key check or any fetch', async () => {
  const orig = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return { status: 200, text: async () => '{}' }; };
  try {
    const tools = buildHarnessTools('t', []);
    await assert.rejects(
      () => tools.ai.complete({ provider: 'gemini', model: 'sonnet', prompt: 'x' }),
      /not valid for provider "gemini"/, // NOT the GOOGLE_AI_API_KEY message → resolution runs first
    );
    assert.equal(fetched, false, 'a bad pair must never reach the network');
  } finally { globalThis.fetch = orig; }
});

// ── empty/refused completion end-to-end: 200-empty → ledger flag → fail closed ──
test('gemini 200-with-empty-text → empty_completion flagged → applyAiCallMeta fails closed', async () => {
  const { result, calls } = await capture(
    { provider: 'gemini', model: 'gemini-flash', prompt: 'write gambling copy' },
    { content: '', finish_reason: 'content_filter' },
  );
  assert.equal(result.text, '', 'a safety refusal returns HTTP 200 with empty text');
  assert.equal(calls[0].empty_completion, true, 'empty completion flagged in the ledger');
  assert.equal(calls[0].finish_reason, 'content_filter');
  const out = applyAiCallMeta({ items: [] }, calls);
  assert.equal(out.meta.status, 'error', 'a refused blank must fail closed, not publish as success');
  assert.match(out.meta.error, /empty\/refused completion on gemini\/gemini-flash-latest.*content_filter/);
});

test('non-empty completion is NOT flagged (success path unchanged)', async () => {
  const { calls } = await capture({ provider: 'openai', model: 'gpt-4o', prompt: 'hi' });
  assert.equal(calls[0].empty_completion, false);
});

// ── cost wiring: tokens_total reaches ai_usage AND is priced (review WARNING) ──
test("gemini tokens_total flows to ai_usage and prices the thinking tokens (not the Opus fallback)", () => {
  const result = applyAiCallMeta({ items: [] }, [
    { provider: 'gemini', model: 'gemini-flash-latest', tokens_in: 100, tokens_out: 20, tokens_total: 200, stop_reason: null },
  ]);
  const u = result.meta.ai_usage;
  assert.equal(u.calls[0].tokens_total, 200, 'per-call tokens_total lands in ai_usage');
  assert.equal(u.tokens_total_total, 200, 'tokens_total_total is summed');
  // billed output = total - in = 100 (completion 20 + 80 thinking), priced at $2.50/M;
  // input 100 @ $0.30/M. NOT the Opus fallback ($5/$25).
  const usd = costOfUsage(u);
  assert.ok(Math.abs(usd - (100 * 0.30 / 1e6 + 100 * 2.50 / 1e6)) < 1e-12, `gemini priced by billed output, got ${usd}`);
});

test("providers without tokens_total keep pricing from tokens_out (backward-compatible)", () => {
  const result = applyAiCallMeta({ items: [] }, [
    { provider: 'anthropic', model: 'claude-sonnet-5', tokens_in: 1000, tokens_out: 100, stop_reason: 'end_turn' },
  ]);
  assert.equal(result.meta.ai_usage.calls[0].tokens_total, 0, 'anthropic carries tokens_total 0');
  const usd = costOfUsage(result.meta.ai_usage);
  assert.ok(Math.abs(usd - (1000 * 3 / 1e6 + 100 * 15 / 1e6)) < 1e-12, `sonnet still priced by tokens_out, got ${usd}`);
});
