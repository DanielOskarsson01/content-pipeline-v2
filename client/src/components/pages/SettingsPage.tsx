import { useState } from 'react';
import { useProviders, useSetProviderKey, useDeleteProviderKey } from '../../hooks/useProviders';
import type { ProviderInfo } from '../../types/step';

/**
 * Settings → LLM provider API keys (BACKLOG #49 Unit 7).
 *
 * Paste a key for a provider that has none → it becomes available everywhere
 * (the running worker picks it up within ~60s, no redeploy). Keys from the
 * server's .env take precedence and are managed on the server (shown, not
 * editable here). The key value is never displayed — presence + last-4 only.
 */
export function SettingsPage() {
  const { data, isLoading, isError } = useProviders();

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">LLM Provider Keys</h2>
        <p className="text-sm text-gray-500">
          Add an API key to make a provider selectable everywhere a model is chosen. A pasted key
          reaches running jobs within ~60s — no redeploy. Keys are stored server-side; the value is
          never shown back.
        </p>
      </div>

      {isLoading && <p className="text-sm text-gray-400">Loading providers…</p>}
      {isError && <p className="text-sm text-red-500">Couldn't load providers.</p>}

      <div className="space-y-3">
        {data?.providers.map((p) => <ProviderKeyRow key={p.id} provider={p} />)}
      </div>
    </div>
  );
}

function ProviderKeyRow({ provider }: { provider: ProviderInfo }) {
  const [value, setValue] = useState('');
  const setKey = useSetProviderKey();
  const delKey = useDeleteProviderKey();
  const fromEnv = provider.source === 'env';
  const fromDb = provider.source === 'db';
  const busy = setKey.isPending || delKey.isPending;

  const save = () => {
    if (!value.trim()) return;
    setKey.mutate({ id: provider.id, apiKey: value.trim() }, { onSuccess: () => setValue('') });
  };

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className="font-medium text-gray-900">{provider.displayName}</span>
          <span className="ml-2 text-xs">
            {provider.configured ? (
              <span className="text-green-600">
                ● configured{provider.last4 ? ` (…${provider.last4})` : ''}
                {fromEnv ? ' · from server .env' : fromDb ? ' · saved key' : ''}
              </span>
            ) : (
              <span className="text-gray-400">○ no key</span>
            )}
          </span>
        </div>
        {fromDb && (
          <button
            type="button"
            disabled={busy}
            onClick={() => delKey.mutate(provider.id)}
            className="text-xs text-red-500 hover:underline disabled:opacity-50"
          >
            Remove key
          </button>
        )}
      </div>

      {fromEnv ? (
        <p className="text-[11px] text-gray-400">
          This key comes from the server environment and takes precedence — manage it on the server.
        </p>
      ) : (
        <div className="flex gap-2">
          <input
            type="password"
            autoComplete="off"
            value={value}
            placeholder={`Paste ${provider.displayName} API key`}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            className="flex-1 bg-white border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-[#0891B2]"
          />
          <button
            type="button"
            disabled={busy || !value.trim()}
            onClick={save}
            className="px-4 py-2 text-sm rounded bg-[#0891B2] text-white disabled:opacity-50"
          >
            {setKey.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
      {setKey.isError && <p className="text-[11px] text-red-500 mt-1">Save failed. Check the server has the key store (migration applied).</p>}
    </div>
  );
}
