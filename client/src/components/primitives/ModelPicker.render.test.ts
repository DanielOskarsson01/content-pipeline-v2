/**
 * Drive the real ModelPicker with real provider data (server-render, no browser)
 * — proves it renders model names + prices at the point of choice and shows an
 * unavailable provider WITH its reason (the openai footgun), not compile-only.
 */
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ModelPicker } from './ModelPicker';
import type { ProvidersResponse } from '../../types/step';

const providersData: ProvidersResponse = {
  providers: [
    { id: 'anthropic', displayName: 'Anthropic', configured: true, reason: null, models: [
      { key: 'haiku', id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', input: 1, output: 5, alias: false },
      { key: 'sonnet', id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', input: 3, output: 15, alias: false },
    ]},
    { id: 'gemini', displayName: 'Google Gemini', configured: true, reason: null, models: [
      { key: 'gemini-flash', id: 'gemini-flash-latest', displayName: 'Gemini Flash (latest)', input: 0.3, output: 2.5, alias: true },
    ]},
    { id: 'openai', displayName: 'OpenAI', configured: false, reason: 'No API key configured (OPENAI_API_KEY not set)', models: [] },
  ],
};

function render(provider: string, model: string): string {
  const qc = new QueryClient();
  qc.setQueryData(['providers'], providersData); // prefetched → useProviders resolves on first render
  return renderToString(
    createElement(QueryClientProvider, { client: qc },
      createElement(ModelPicker, { provider, model, onProviderChange: () => {}, onModelChange: () => {} })),
  );
}

describe('ModelPicker renders real provider data', () => {
  it('shows the selected model name and its price at the point of choice', () => {
    const html = render('gemini', 'gemini-flash');
    expect(html).toContain('Gemini Flash (latest)');
    expect(html).toContain('$0.3/$2.5 per Mtok'); // price visible
    expect(html).toContain('-latest');             // alias flagged
  });

  it('shows an unavailable provider (openai) as unavailable WITH the reason — not silently absent', () => {
    const html = render('anthropic', 'sonnet');
    expect(html).toContain('OpenAI');
    expect(html).toContain('unavailable');
    expect(html).toContain('OPENAI_API_KEY not set');
    // openai option is disabled (never selectable-and-broken) — only the
    // unconfigured provider carries the disabled attribute
    expect(html).toContain('disabled');
  });

  it('warns when the currently-selected provider has no key', () => {
    const html = render('openai', 'gpt-4o');
    expect(html).toContain('has no API key on the server');
  });
});
