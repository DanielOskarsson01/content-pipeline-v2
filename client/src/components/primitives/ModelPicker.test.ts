import { describe, it, expect } from 'vitest';
import { nextModelForProvider } from './ModelPicker';
import type { ProviderInfo } from '../../types/step';

const providers: ProviderInfo[] = [
  { id: 'anthropic', displayName: 'Anthropic', configured: true, reason: null, models: [
    { key: 'haiku', id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', input: 1, output: 5, alias: false },
    { key: 'sonnet', id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', input: 3, output: 15, alias: false },
  ]},
  { id: 'gemini', displayName: 'Google Gemini', configured: true, reason: null, models: [
    { key: 'gemini-flash', id: 'gemini-flash-latest', displayName: 'Gemini Flash', input: 0.3, output: 2.5, alias: true },
  ]},
  { id: 'openai', displayName: 'OpenAI', configured: false, reason: 'no key', models: [] },
  { id: 'openrouter', displayName: 'OpenRouter', configured: true, reason: null, models: [
    { key: 'gpt-oss-120b', id: 'openai/gpt-oss-120b', displayName: 'gpt-oss-120b', input: 0.037, output: 0.17, alias: false },
    { key: 'qwen3.5-flash', id: 'qwen/qwen3.5-flash-02-23', displayName: 'Qwen3.5-Flash', input: 0.065, output: 0.26, alias: false },
  ]},
];

describe('nextModelForProvider (coupling — a mismatched pair cannot be built)', () => {
  it('keeps the current model when it is valid for the new provider', () => {
    expect(nextModelForProvider(providers, 'anthropic', 'sonnet')).toBe('sonnet');
  });
  it('switches to the provider\'s first model when the current one is invalid for it', () => {
    // the footgun: provider→gemini while model is still sonnet → must re-point, not keep sonnet
    expect(nextModelForProvider(providers, 'gemini', 'sonnet')).toBe('gemini-flash');
  });
  it('returns null for an unknown provider (no models to offer)', () => {
    expect(nextModelForProvider(providers, 'mistral', 'x')).toBeNull();
  });
  it('returns null for a provider with no models (e.g. unconfigured openai)', () => {
    expect(nextModelForProvider(providers, 'openai', 'gpt-4o')).toBeNull();
  });

  // #54: switching to/from openrouter must re-point the model, never leave an
  // anthropic key selected while provider=openrouter (the 18-model footgun).
  it('provider→openrouter while model is an anthropic key re-points to the first openrouter model', () => {
    expect(nextModelForProvider(providers, 'openrouter', 'sonnet')).toBe('gpt-oss-120b');
  });
  it('keeps a valid openrouter model when it belongs to openrouter', () => {
    expect(nextModelForProvider(providers, 'openrouter', 'qwen3.5-flash')).toBe('qwen3.5-flash');
  });
  it('provider→anthropic while model is an openrouter key re-points to an anthropic model', () => {
    expect(nextModelForProvider(providers, 'anthropic', 'gpt-oss-120b')).toBe('haiku');
  });
});
