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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAGEWORKER = readFileSync(path.join(__dirname, '../workers/stageWorker.js'), 'utf8');
const HARNESS = readFileSync(path.join(__dirname, 'submoduleHarness.js'), 'utf8');

// Drive one non-anthropic ai.complete call with fetch stubbed; return the
// captured request (url + parsed JSON body) and the ai.complete result.
async function capture(completeArgs) {
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
        choices: [{ message: { content: 'RESP' }, finish_reason: 'stop' }],
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
    return { req: captured[0], body: JSON.parse(captured[0].opts.body), result };
  } finally {
    globalThis.fetch = orig;
    keys.forEach((k, i) => { if (savedKeys[i] === undefined) delete process.env[k]; else process.env[k] = savedKeys[i]; });
  }
}

// ── openai / perplexity stay byte-identical: cache_prefix is NOT inlined ──
for (const provider of ['openai', 'perplexity']) {
  test(`${provider}: cache_prefix is NOT sent (content === prompt, byte-identical to pre-#49)`, async () => {
    const { req, body } = await capture({ provider, model: 'gpt-4o', prompt: 'PROMPT', cache_prefix: 'BIG-STABLE-DOCS' });
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

test('MODEL_MAP gemini entries are in sync across both copies', () => {
  for (const line of ["'gemini-flash': 'gemini-flash-latest'", "'gemini-pro': 'gemini-pro-latest'"]) {
    assert.ok(STAGEWORKER.includes(line), `stageWorker MODEL_MAP must contain ${line}`);
    assert.ok(HARNESS.includes(line), `submoduleHarness MODEL_MAP must contain ${line}`);
  }
});
