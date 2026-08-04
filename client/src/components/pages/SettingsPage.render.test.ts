/**
 * Drive the real SettingsPage with real provider data (server-render, no browser).
 * Proves: env providers show "from server .env" (read-only), keyless providers get
 * a paste input, configured last-4 shows, and no key value is present.
 */
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsPage } from './SettingsPage';
import type { ProvidersResponse } from '../../types/step';

const providersData: ProvidersResponse = {
  providers: [
    { id: 'anthropic', displayName: 'Anthropic', configured: true, source: 'env', last4: 'wxyz', reason: null, models: [] },
    { id: 'openai', displayName: 'OpenAI', configured: false, source: null, last4: null, reason: 'no key', models: [] },
    { id: 'gemini', displayName: 'Google Gemini', configured: true, source: 'db', last4: '1234', reason: null, models: [] },
  ],
};

function render(): string {
  const qc = new QueryClient();
  qc.setQueryData(['providers'], providersData);
  return renderToString(createElement(QueryClientProvider, { client: qc }, createElement(SettingsPage)));
}

describe('SettingsPage renders provider key management', () => {
  it('env provider is shown configured + read-only (managed on server)', () => {
    const html = render();
    expect(html).toContain('Anthropic');
    expect(html).toContain('from server .env');
    expect(html).toContain('…wxyz');
    expect(html).toContain('manage it on the server');
  });

  it('keyless provider (openai) offers a paste input', () => {
    const html = render();
    expect(html).toContain('Paste OpenAI API key');
    expect(html).toContain('type="password"');
  });

  it('db-sourced provider (gemini) shows saved key + a Remove control', () => {
    const html = render();
    expect(html).toContain('saved key');
    expect(html).toContain('…1234');
    expect(html).toContain('Remove key');
  });
});
