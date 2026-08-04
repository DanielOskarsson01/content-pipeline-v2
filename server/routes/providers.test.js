/**
 * /api/providers (BACKLOG #49) — availability + Unit 7 key management.
 *
 * Mount ONLY this router in a throwaway express app on an ephemeral port with an
 * injected stateful fake key-store (never boot server.js against prod). Proves the
 * box-state availability, DB gap-fill, and POST/DELETE key flow — none of it leaks
 * a key value.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createProvidersRouter } from './providers.js';
import { _resetApiKeyCache } from '../services/apiKeys.js';

// Stateful fake Supabase client for provider_api_keys (in-memory).
function makeDb(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    _store: store,
    from() {
      return {
        select: async () => ({ data: [...store.entries()].map(([provider, api_key]) => ({ provider, api_key })), error: null }),
        upsert: async (row) => { store.set(row.provider, row.api_key); return { error: null }; },
        delete() { return { eq: async (_c, v) => { store.delete(v); return { error: null }; } }; },
      };
    },
  };
}

const ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'GOOGLE_AI_API_KEY'];
const savedEnv = {};
beforeEach(() => {
  _resetApiKeyCache();
  for (const k of ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
function restoreEnv() { for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } }

async function withServer(db, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/providers', createProvidersRouter({ db }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try { return await fn(base); }
  finally { await new Promise((r) => server.close(r)); restoreEnv(); }
}

test("box state: anthropic/gemini/perplexity configured (env), openai not — with reason", async () => {
  process.env.ANTHROPIC_API_KEY = 'x'; process.env.GOOGLE_AI_API_KEY = 'x'; process.env.PERPLEXITY_API_KEY = 'x';
  await withServer(makeDb(), async (base) => {
    const { providers } = await (await fetch(`${base}/api/providers`)).json();
    const by = Object.fromEntries(providers.map((p) => [p.id, p]));
    assert.equal(by.anthropic.configured, true); assert.equal(by.anthropic.source, 'env');
    assert.equal(by.gemini.configured, true); assert.equal(by.perplexity.configured, true);
    assert.equal(by.openai.configured, false);
    assert.match(by.openai.reason, /OPENAI_API_KEY not set/);
  });
});

test("Unit 7: a DB key makes a keyless provider (openai) configured (source db, last4)", async () => {
  await withServer(makeDb({ openai: 'sk-openai-9876' }), async (base) => {
    const { providers } = await (await fetch(`${base}/api/providers`)).json();
    const openai = providers.find((p) => p.id === 'openai');
    assert.equal(openai.configured, true, 'DB key fills the gap');
    assert.equal(openai.source, 'db');
    assert.equal(openai.last4, '9876');
    assert.ok(!JSON.stringify(providers).includes('sk-openai-9876'), 'key value never returned');
  });
});

test("Unit 7 acceptance: POST a key → available; DELETE → unavailable; env providers unaffected", async () => {
  process.env.ANTHROPIC_API_KEY = 'env-anthropic'; // an .env provider present throughout
  const db = makeDb();
  await withServer(db, async (base) => {
    // openai starts keyless
    let by = Object.fromEntries((await (await fetch(`${base}/api/providers`)).json()).providers.map((p) => [p.id, p]));
    assert.equal(by.openai.configured, false);

    // paste a key → available, no redeploy
    _resetApiKeyCache();
    const post = await fetch(`${base}/api/providers/openai/key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: 'sk-live-4321' }) });
    const postBody = await post.json();
    assert.equal(post.status, 200);
    assert.equal(postBody.configured, true); assert.equal(postBody.last4, '4321');
    assert.ok(!JSON.stringify(postBody).includes('sk-live-4321'), 'POST never echoes the value');
    assert.equal(db._store.get('openai'), 'sk-live-4321', 'stored in the DB');

    _resetApiKeyCache();
    by = Object.fromEntries((await (await fetch(`${base}/api/providers`)).json()).providers.map((p) => [p.id, p]));
    assert.equal(by.openai.configured, true, 'openai now available');
    assert.equal(by.anthropic.configured, true, 'env provider unaffected throughout');

    // delete → unavailable
    _resetApiKeyCache();
    const del = await fetch(`${base}/api/providers/openai/key`, { method: 'DELETE' });
    assert.equal((await del.json()).configured, false);
    assert.equal(db._store.has('openai'), false, 'row deleted');
    _resetApiKeyCache();
    by = Object.fromEntries((await (await fetch(`${base}/api/providers`)).json()).providers.map((p) => [p.id, p]));
    assert.equal(by.openai.configured, false, 'openai unavailable again');
    assert.equal(by.anthropic.configured, true, 'env provider still working');
  });
});

test("POST rejects an unknown provider and an empty key", async () => {
  await withServer(makeDb(), async (base) => {
    assert.equal((await fetch(`${base}/api/providers/mistral/key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: 'x' }) })).status, 400);
    assert.equal((await fetch(`${base}/api/providers/openai/key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: '' }) })).status, 400);
  });
});
