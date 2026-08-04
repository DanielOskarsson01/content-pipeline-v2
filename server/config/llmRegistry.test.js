/**
 * LLM REGISTRY (BACKLOG #49) — resolution correctness + no-regression proof.
 *
 * Asserts the brief's Unit 1 acceptance:
 *   1. every currently-live (provider, model) pair resolves to the SAME id it
 *      does today (the old `MODEL_MAP[model] || model`), printed as a table;
 *   2. a bad pair (gemini + a sonnet id/key) THROWS at resolution instead of
 *      falling through to send the wrong id — the gotcha-#2 landmine;
 *   3. prices stay in sync between the registry and aiCost (single source).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, resolveModel, PRICES_BY_ID } from './llmRegistry.js';
import { MODEL_PRICES_PER_MTOK, costOfUsage } from '../lib/aiCost.js';

// The exact global map that shipped before the registry (stageWorker.js:37-54).
// resolveModel must reproduce `OLD_MODEL_MAP[model] || model` for every live pair.
const OLD_MODEL_MAP = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
  'gpt-4o-mini': 'gpt-4o-mini',
  'gpt-4o': 'gpt-4o',
  sonar: 'sonar',
  'sonar-pro': 'sonar-pro',
  'gemini-flash': 'gemini-flash-latest',
  'gemini-pro': 'gemini-pro-latest',
};

// Every live (provider, dropdown-key) pair the manifests / option_defaults use.
// Includes sonar-reasoning / sonar-reasoning-pro (seo-planner offers them; today
// they resolve via the `|| model` fall-through and would REGRESS under strict
// resolution if the registry didn't enumerate them).
const LIVE_PAIRS = [
  ['anthropic', 'haiku'],
  ['anthropic', 'sonnet'],
  ['anthropic', 'opus'],
  ['openai', 'gpt-4o-mini'],
  ['openai', 'gpt-4o'],
  ['perplexity', 'sonar'],
  ['perplexity', 'sonar-pro'],
  ['perplexity', 'sonar-reasoning'],
  ['perplexity', 'sonar-reasoning-pro'],
  ['gemini', 'gemini-flash'],
  ['gemini', 'gemini-pro'],
];

test('every currently-live model resolves exactly as it does today (before/after table)', () => {
  const rows = [['provider', 'model', 'BEFORE (MODEL_MAP||model)', 'AFTER (resolveModel)', 'match']];
  for (const [provider, model] of LIVE_PAIRS) {
    const before = OLD_MODEL_MAP[model] || model;
    const after = resolveModel(provider, model);
    rows.push([provider, model, before, after, before === after ? 'OK' : 'DRIFT']);
    assert.equal(after, before, `${provider}/${model} must resolve to ${before}`);
  }
  // Print the table so the acceptance number is visible in test output.
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log('  ' + r.map((c, i) => String(c).padEnd(w[i])).join('  '));
});

test('resolveModel accepts the already-resolved API id within the same provider', () => {
  assert.equal(resolveModel('anthropic', 'claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(resolveModel('gemini', 'gemini-flash-latest'), 'gemini-flash-latest');
});

test('gotcha #2: gemini + a sonnet key/id ERRORS instead of falling through', () => {
  // key form
  assert.throws(() => resolveModel('gemini', 'sonnet'), /not valid for provider "gemini"/);
  // resolved-id form (the actually dangerous case: today MODEL_MAP['...']||... could
  // send claude-sonnet-5 to the gemini endpoint)
  assert.throws(() => resolveModel('gemini', 'claude-sonnet-5'), /not valid for provider "gemini"/);
  // unknown provider
  assert.throws(() => resolveModel('google', 'gemini-flash'), /Unknown AI provider: "google"/);
  // unknown model under a valid provider (was: silently POSTed and 400'd)
  assert.throws(() => resolveModel('anthropic', 'gpt-4o'), /not valid for provider "anthropic"/);
});

test('prices: registry is the single source aiCost reads from', () => {
  assert.equal(MODEL_PRICES_PER_MTOK, PRICES_BY_ID, 'aiCost re-exports the registry price map');
  // a live model prices identically through both paths
  const usd = costOfUsage({ calls: [{ model: 'gemini-flash-latest', tokens_in: 1e6, tokens_out: 1e6 }] });
  assert.ok(Math.abs(usd - (0.30 + 2.50)) < 1e-9, `gemini-flash priced from registry, got ${usd}`);
});

test('every provider declares an env var and every model an id + prices', () => {
  for (const [pid, p] of Object.entries(PROVIDERS)) {
    assert.equal(p.id, pid, 'provider key === p.id (the adapter branch string)');
    assert.match(p.envVar, /_API_KEY$/, `${pid} declares an env var name`);
    for (const [key, m] of Object.entries(p.models)) {
      assert.ok(m.id, `${pid}/${key} has an api id`);
      assert.equal(typeof m.input, 'number', `${pid}/${key} has input price`);
      assert.equal(typeof m.output, 'number', `${pid}/${key} has output price`);
    }
  }
});
