/**
 * Hermetic tests for server/services/submoduleHarness.js (workbench Unit 2).
 *
 * No network, no real DB, no modules repo: global.fetch is stubbed with a fake
 * Anthropic SSE stream, MODULES_PATH points at a throwaway fixture module, and
 * the injected db is a recording mock whose write methods THROW (proving the
 * read-only contract — the harness must never write a real-run table).
 *
 * Asserts the three U2 capabilities:
 *   1. per-call option overrides reach the outgoing request body
 *   2. model-param gating matches stageWorker (aiModelParams: sonnet-5 drops
 *      temperature / keeps thinking+effort; haiku keeps temperature / drops both)
 *   3. _aiCalls → applyAiCallMeta capture (tokens, stop_reason, truncation
 *      fail-closed) and zero writes during §7b/§7c hydration
 *
 * Run: node --test server/tests/submoduleHarness.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// db.js (lazy-imported via poolBlobs on the hydrate path) throws without these.
// Dummy values — nothing in these tests performs a real Supabase call.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://hermetic-test.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'hermetic-test-key';

const { runSubmoduleOnce } = await import('../services/submoduleHarness.js');
const { anthropicAcceptsTemperature, anthropicAcceptsThinking, anthropicAcceptsEffort } =
  await import('../lib/aiModelParams.js');

// ── fixture module ──────────────────────────────────────────────────────────
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-fixture-'));
const moduleDir = path.join(fixtureRoot, 'modules', 'step-5-generation', 'echo-ai');
fs.mkdirSync(moduleDir, { recursive: true });
fs.writeFileSync(path.join(moduleDir, 'manifest.json'), JSON.stringify({
  id: 'echo-ai',
  name: 'Echo AI',
  description: 'Hermetic fixture: forwards options into one ai.complete call',
  version: '0.0.1',
  step: 5,
  category: 'generation',
  cost: 'cheap',
  data_operation_default: 'add',
  requires_columns: ['seo_plan_json'],
  item_key: 'entity_name',
  output_schema: {},
  pool_precondition: 'requires_items',
}));
fs.writeFileSync(path.join(moduleDir, 'execute.js'), `
export default async function execute(input, options, tools) {
  const r = await tools.ai.complete({
    prompt: options.prompt || 'hi',
    model: options.ai_model,
    temperature: options.temperature,
    max_tokens: options.max_tokens,
    thinking: options.thinking,
    effort: options.effort,
  });
  return {
    results: [{ entity_name: input.entity.name, items: [{ entity_name: input.entity.name, text: r.text }], meta: { status: 'success' } }],
    summary: { ok: true },
  };
}
`);
process.env.MODULES_PATH = fixtureRoot;

// ── fetch stub: capture the request, answer with a fake Anthropic SSE body ──
const captured = [];
function fakeSSE({ stop_reason = 'end_turn', tokens_in = 100, tokens_out = 42 } = {}) {
  const events = [
    `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: tokens_in, output_tokens: 1 } } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: 'stubbed output' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: tokens_out }, delta: { stop_reason } })}\n\n`,
    'data: {"type":"message_stop"}\n\n',
  ];
  return (async function* () { for (const e of events) yield e; })();
}
let nextResponse = {};
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  captured.push({ url, body: JSON.parse(init.body) });
  return { status: 200, body: fakeSSE(nextResponse) };
};
test.after(() => { global.fetch = realFetch; fs.rmSync(fixtureRoot, { recursive: true, force: true }); });

const baseSpec = () => ({
  submodule_id: 'echo-ai',
  entity: { name: 'Acme', items: [{ entity_name: 'Acme', url: 'https://acme.test' }] },
  options: { ai_model: 'haiku', temperature: 0.4, prompt: 'base prompt' },
});

// ── recording mock db: reads resolve empty, writes THROW ────────────────────
function recordingDb() {
  const ops = [];
  function query(table, method) {
    ops.push({ table, method });
    const q = {
      select: () => q, eq: () => q, in: () => q, single: () => q, order: () => q,
      then: (resolve) => resolve({ data: [], error: null }),
    };
    return q;
  }
  return {
    ops,
    from: (table) => ({
      select: (...a) => query(table, 'select').select(...a),
      insert: () => { throw new Error(`WRITE VIOLATION: insert on ${table}`); },
      update: () => { throw new Error(`WRITE VIOLATION: update on ${table}`); },
      upsert: () => { throw new Error(`WRITE VIOLATION: upsert on ${table}`); },
      delete: () => { throw new Error(`WRITE VIOLATION: delete on ${table}`); },
    }),
  };
}

test('overrides reach the request body; sonnet-5 gating matches stageWorker (temperature dropped, thinking/effort kept)', async () => {
  captured.length = 0;
  nextResponse = {};
  const out = await runSubmoduleOnce({
    ...baseSpec(),
    overrides: { ai_model: 'sonnet', max_tokens: 1234, thinking: { type: 'disabled' }, effort: 'low', prompt: 'OVERRIDE PROMPT' },
  });
  assert.equal(captured.length, 1);
  const body = captured[0].body;
  assert.equal(body.model, 'claude-sonnet-5');                       // override over spec.options.ai_model
  assert.equal(body.max_tokens, 1234);                               // override reached the wire
  assert.deepEqual(body.thinking, { type: 'disabled' });             // gated IN for sonnet-5
  assert.deepEqual(body.output_config, { effort: 'low' });           // gated IN for sonnet-5
  assert.equal(body.temperature, undefined);                         // gated OUT for sonnet-5 (the 400 bug)
  assert.match(JSON.stringify(body.messages), /OVERRIDE PROMPT/);    // prompt override reached the wire
  // The gate IS stageWorker's gate — same aiModelParams predicates.
  assert.equal(anthropicAcceptsTemperature('claude-sonnet-5'), false);
  assert.equal(anthropicAcceptsThinking('claude-sonnet-5'), true);
  assert.equal(anthropicAcceptsEffort('claude-sonnet-5'), true);
  assert.equal(out.resolvedPrompt, 'OVERRIDE PROMPT');
});

test('haiku gating matches stageWorker (temperature kept, thinking/effort dropped)', async () => {
  captured.length = 0;
  nextResponse = {};
  await runSubmoduleOnce({
    ...baseSpec(),
    overrides: { thinking: { type: 'disabled' }, effort: 'low' },
  });
  const body = captured[0].body;
  assert.equal(body.model, 'claude-haiku-4-5-20251001');
  assert.equal(body.temperature, 0.4);                               // haiku still accepts temperature
  assert.equal(body.thinking, undefined);                            // haiku: thinking omitted, never 400
  assert.equal(body.output_config, undefined);                       // haiku: effort omitted, never 400
  assert.equal(anthropicAcceptsTemperature('claude-haiku-4-5-20251001'), true);
  assert.equal(anthropicAcceptsThinking('claude-haiku-4-5-20251001'), false);
  assert.equal(anthropicAcceptsEffort('claude-haiku-4-5-20251001'), false);
});

test('_aiCalls → applyAiCallMeta: tokens + stop_reason land in meta.ai_usage on the unwrapped per-entity result', async () => {
  captured.length = 0;
  nextResponse = { tokens_in: 100, tokens_out: 42, stop_reason: 'end_turn' };
  const out = await runSubmoduleOnce(baseSpec());
  assert.equal(Array.isArray(out.result.items), true);               // unwrapped per-entity, not {results:[...]}
  const u = out.result.meta.ai_usage;
  assert.equal(u.tokens_in_total, 100);
  assert.equal(u.tokens_out_total, 42);
  assert.equal(u.calls[0].stop_reason, 'end_turn');
  assert.equal(u.calls[0].model, 'claude-haiku-4-5-20251001');
  assert.equal(out.result.meta.status, 'success');
});

test('truncation fail-closed: stop_reason max_tokens → meta.status error, meta.truncated true (stageWorker parity)', async () => {
  captured.length = 0;
  nextResponse = { stop_reason: 'max_tokens' };
  const out = await runSubmoduleOnce(baseSpec());
  assert.equal(out.result.meta.truncated, true);
  assert.equal(out.result.meta.status, 'error');
  assert.match(out.result.meta.error, /truncated/i);
});

test('hydrate path is read-only: §7b queries run, no insert/update/upsert/delete on any real-run table', async () => {
  captured.length = 0;
  nextResponse = {};
  const db = recordingDb();
  const spec = {
    ...baseSpec(),
    run_id: '00000000-0000-0000-0000-000000000001',
    step_index: 5,
    hydrate: true,
    exclude_run_id: '00000000-0000-0000-0000-000000000002',
  };
  const out = await runSubmoduleOnce(spec, { db });
  // §7b actually ran (items lack seo_plan_json → upstream-runs lookup fired)
  assert.equal(db.ops.some(o => o.table === 'entity_submodule_runs' && o.method === 'select'), true);
  // …and every observed op is a read. Writes would have thrown loudly.
  assert.equal(db.ops.every(o => o.method === 'select'), true);
  assert.deepEqual(out.hydration, { enrichedFields: [], hydratedBlobs: 0 });
});

test('hydrate without deps.db fails loud (never silently skips fidelity)', async () => {
  await assert.rejects(
    () => runSubmoduleOnce({ ...baseSpec(), run_id: 'x', hydrate: true }),
    /requires deps\.db/,
  );
});
