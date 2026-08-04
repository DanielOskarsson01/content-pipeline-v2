/**
 * Provider API-key resolution (BACKLOG #49 Unit 7) — hermetic, injected fake db.
 * Proves: .env precedence (no regression), DB gap-fill, no key value ever leaked,
 * cache + invalidation, and fail-safe on a missing table.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiKey, providerKeyStatus, invalidateApiKeyCache, _resetApiKeyCache } from './apiKeys.js';

const ENV_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'GOOGLE_AI_API_KEY'];
function clearEnv() { for (const k of ENV_VARS) delete process.env[k]; }

// A fake Supabase client returning a controllable provider_api_keys result.
function fakeDb(rows, { error = null, calls } = {}) {
  return { from: (table) => ({ select: async () => { if (calls) calls.push(table); return { data: rows, error }; } }) };
}

beforeEach(() => { _resetApiKeyCache(); clearEnv(); });

test('.env wins — a provider with an env key never reads the DB (no regression, hot path)', async () => {
  process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';
  const calls = [];
  const db = fakeDb([{ provider: 'anthropic', api_key: 'db-anthropic-DIFFERENT' }], { calls });
  const key = await resolveApiKey('anthropic', db);
  assert.equal(key, 'env-anthropic-key', '.env value wins over any DB value');
  assert.equal(calls.length, 0, 'a provider with an .env key does NOT hit the DB');
});

test('DB fills the gap — a keyless provider (openai) resolves from the DB', async () => {
  const db = fakeDb([{ provider: 'openai', api_key: 'db-openai-key' }]);
  assert.equal(await resolveApiKey('openai', db), 'db-openai-key');
});

test('neither .env nor DB → undefined', async () => {
  const db = fakeDb([]);
  assert.equal(await resolveApiKey('openai', db), undefined);
});

test('no db (CLI harness) → env-only, never crashes', async () => {
  process.env.ANTHROPIC_API_KEY = 'env-key';
  assert.equal(await resolveApiKey('anthropic'), 'env-key');
  assert.equal(await resolveApiKey('openai'), undefined);
});

test('unknown provider → undefined (registry-scoped)', async () => {
  assert.equal(await resolveApiKey('mistral', fakeDb([])), undefined);
});

test('cache: the DB is read once per TTL; invalidate forces a re-read', async () => {
  const calls = [];
  const db = fakeDb([{ provider: 'openai', api_key: 'k1' }], { calls });
  await resolveApiKey('openai', db);
  await resolveApiKey('openai', db);           // cached — no second read
  assert.equal(calls.length, 1, 'second resolve served from cache');
  invalidateApiKeyCache();
  await resolveApiKey('openai', db);           // forced re-read
  assert.equal(calls.length, 2, 'invalidate forces a fresh DB read');
});

test('fail-safe: a DB error (e.g. table not yet created) does NOT throw; .env still resolves', async () => {
  process.env.ANTHROPIC_API_KEY = 'env-key';
  const badDb = { from: () => ({ select: async () => ({ data: null, error: { message: 'relation "provider_api_keys" does not exist' } }) }) };
  assert.equal(await resolveApiKey('anthropic', badDb), 'env-key', '.env unaffected by DB error');
  assert.equal(await resolveApiKey('openai', badDb), undefined, 'keyless provider degrades to undefined, no throw');
});

test('providerKeyStatus: presence + source + last4 only — never the key value', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-ABCDwxyz';
  const db = fakeDb([{ provider: 'openai', api_key: 'sk-openai-1234' }]);
  const status = await providerKeyStatus(db);

  assert.deepEqual(status.anthropic, { configured: true, source: 'env', last4: 'wxyz' });
  assert.deepEqual(status.openai, { configured: true, source: 'db', last4: '1234' });
  assert.deepEqual(status.gemini, { configured: false, source: null, last4: null });
  // the raw key value must never appear anywhere in the status payload
  assert.ok(!JSON.stringify(status).includes('sk-ant-ABCDwxyz'));
  assert.ok(!JSON.stringify(status).includes('sk-openai-1234'));
});
