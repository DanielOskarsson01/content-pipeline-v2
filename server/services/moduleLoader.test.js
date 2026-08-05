/**
 * moduleLoader registry-injection (BACKLOG #49): a manifest option declaring
 * `values_from: "registry.*"` gets its `values` populated from the shared LLM
 * registry at load, so every AI submodule offers the SAME provider/model list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRegistryOptionValues } from './moduleLoader.js';
import { PROVIDERS } from '../config/llmRegistry.js';

// #54: registry.models is now PROVIDER-COUPLED — scoped to the manifest's
// ai_provider default, never a flat cross-provider merge. (Contract change from
// the #49 flat list: with 5 providers a flat 29-model dropdown is unusable and
// lets a wrong pair be built. The live per-selection filter is GET /api/providers,
// rendered by the ModelPicker.)
test('values_from: registry.providers → all provider ids; registry.models → the DEFAULT provider\'s models only (coupled)', () => {
  const manifest = {
    options: [
      { name: 'ai_provider', type: 'select', default: 'anthropic', values_from: 'registry.providers' },
      { name: 'ai_model', type: 'select', default: 'haiku', values_from: 'registry.models' },
    ],
  };
  applyRegistryOptionValues(manifest);

  const [prov, model] = manifest.options;
  assert.deepEqual(prov.values, Object.keys(PROVIDERS), 'provider list = registry providers');
  assert.ok(prov.values.includes('openrouter') && prov.values.includes('gemini') && prov.values.includes('perplexity'), 'openrouter + gemini + perplexity selectable');
  assert.deepEqual(model.values, Object.keys(PROVIDERS.anthropic.models), 'model list is the anthropic default provider only (haiku/sonnet/opus)');
  assert.ok(!model.values.includes('gemini-flash') && !model.values.includes('gpt-oss-120b'), 'NO cross-provider models leak into the coupled list');
  assert.equal(prov.default, 'anthropic', 'default preserved');
  assert.equal(model.default, 'haiku', 'default preserved');
});

test('registry.models couples to a non-anthropic default (openrouter default → only openrouter models)', () => {
  const manifest = {
    options: [
      { name: 'ai_provider', default: 'openrouter', values_from: 'registry.providers' },
      { name: 'ai_model', default: 'gpt-oss-120b', values_from: 'registry.models' },
    ],
  };
  applyRegistryOptionValues(manifest);
  assert.deepEqual(manifest.options[1].values, Object.keys(PROVIDERS.openrouter.models), 'openrouter default → openrouter model keys only');
  assert.ok(manifest.options[1].values.includes('gpt-oss-120b') && !manifest.options[1].values.includes('haiku'), 'openrouter models present, anthropic absent');
});

test('two AI submodules with the same default provider get the SAME registry-driven list', () => {
  const mk = () => ({ options: [
    { name: 'ai_provider', default: 'anthropic', values_from: 'registry.providers' },
    { name: 'ai_model', default: 'haiku', values_from: 'registry.models' },
  ]});
  const a = applyRegistryOptionValues(mk());
  const b = applyRegistryOptionValues(mk());
  assert.deepEqual(a.options[0].values, b.options[0].values);
  assert.deepEqual(a.options[1].values, b.options[1].values);
});

test('registry.models with no sibling ai_provider option falls back to anthropic (safe default)', () => {
  const manifest = { options: [{ name: 'ai_model', values_from: 'registry.models' }] };
  applyRegistryOptionValues(manifest);
  assert.deepEqual(manifest.options[0].values, Object.keys(PROVIDERS.anthropic.models));
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
