/**
 * GET /api/providers (BACKLOG #49) — availability endpoint.
 *
 * House pattern: mount ONLY this router in a throwaway express app on an
 * ephemeral port (never boot server.js against prod). Drive it with the box's
 * documented key state (brief §2: ANTHROPIC / GOOGLE_AI / PERPLEXITY present,
 * OPENAI absent) and assert the picker-facing shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import providersRouter from './providers.js';

async function withServer(envOverrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const app = express();
  app.use('/api/providers', providersRouter);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    await new Promise((r) => server.close(r));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("today's box state: anthropic/gemini/perplexity configured, openai not (with reason)", async () => {
  await withServer(
    { ANTHROPIC_API_KEY: 'test', GOOGLE_AI_API_KEY: 'test', PERPLEXITY_API_KEY: 'test', OPENAI_API_KEY: undefined },
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/providers`);
      assert.equal(res.status, 200);
      const { providers } = await res.json();
      const by = Object.fromEntries(providers.map((p) => [p.id, p]));

      assert.equal(by.anthropic.configured, true);
      assert.equal(by.anthropic.reason, null);
      assert.equal(by.gemini.configured, true);
      assert.equal(by.perplexity.configured, true);

      assert.equal(by.openai.configured, false, 'openai has no key on the box → not configured');
      assert.match(by.openai.reason, /OPENAI_API_KEY not set/, 'unavailable reason is named');

      // print the acceptance evidence
      console.log('  provider    configured  reason');
      for (const p of providers) console.log(`  ${p.id.padEnd(11)} ${String(p.configured).padEnd(10)} ${p.reason ?? ''}`);
    },
  );
});

test('models carry key + id + prices + alias for the picker', async () => {
  await withServer({ GOOGLE_AI_API_KEY: 'test' }, async (port) => {
    const { providers } = await (await fetch(`http://127.0.0.1:${port}/api/providers`)).json();
    const gemini = providers.find((p) => p.id === 'gemini');
    const flash = gemini.models.find((m) => m.key === 'gemini-flash');
    assert.equal(flash.id, 'gemini-flash-latest');
    assert.equal(flash.input, 0.30);
    assert.equal(flash.output, 2.50);
    assert.equal(flash.alias, true, '-latest alias is flagged');
    // perplexity offers all four sonar variants (incl. the two that were unpriced before)
    const perplexity = providers.find((p) => p.id === 'perplexity');
    assert.deepEqual(perplexity.models.map((m) => m.key).sort(), ['sonar', 'sonar-pro', 'sonar-reasoning', 'sonar-reasoning-pro']);
  });
});
