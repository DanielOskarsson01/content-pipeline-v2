/**
 * moduleLoader registry-injection (BACKLOG #49): a manifest option declaring
 * `values_from: "registry.*"` gets its `values` populated from the shared LLM
 * registry at load, so every AI submodule offers the SAME provider/model list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRegistryOptionValues } from './moduleLoader.js';
import { PROVIDERS } from '../config/llmRegistry.js';

test('values_from: registry.providers → all provider ids; registry.models → all model keys', () => {
  const manifest = {
    options: [
      { name: 'ai_provider', type: 'select', default: 'anthropic', values_from: 'registry.providers' },
      { name: 'ai_model', type: 'select', default: 'haiku', values_from: 'registry.models' },
    ],
  };
  applyRegistryOptionValues(manifest);

  const [prov, model] = manifest.options;
  assert.deepEqual(prov.values, Object.keys(PROVIDERS), 'provider list = registry providers');
  assert.ok(prov.values.includes('gemini') && prov.values.includes('perplexity'), 'gemini + perplexity now selectable');
  assert.ok(model.values.includes('gemini-flash') && model.values.includes('sonar-reasoning'), 'model list spans every provider');
  assert.equal(prov.default, 'anthropic', 'default preserved');
  assert.equal(model.default, 'haiku', 'default preserved');
});

test('two different AI submodules get the SAME registry-driven list', () => {
  const mk = () => ({ options: [
    { name: 'ai_provider', values_from: 'registry.providers' },
    { name: 'ai_model', values_from: 'registry.models' },
  ]});
  const a = applyRegistryOptionValues(mk());
  const b = applyRegistryOptionValues(mk());
  assert.deepEqual(a.options[0].values, b.options[0].values);
  assert.deepEqual(a.options[1].values, b.options[1].values);
});

test('an option with static values (no values_from) is untouched', () => {
  const manifest = { options: [{ name: 'format', type: 'select', values: ['a', 'b'] }] };
  applyRegistryOptionValues(manifest);
  assert.deepEqual(manifest.options[0].values, ['a', 'b']);
});

test('an unrecognised values_from leaves the option without a values list (visibly empty, not wrong)', () => {
  const manifest = { options: [{ name: 'x', values_from: 'registry.bogus' }] };
  applyRegistryOptionValues(manifest);
  assert.equal(manifest.options[0].values, undefined);
});

test('no options / missing options array is a safe no-op', () => {
  assert.doesNotThrow(() => applyRegistryOptionValues({}));
  assert.doesNotThrow(() => applyRegistryOptionValues({ options: [] }));
});
