import { useProviders } from '../../hooks/useProviders';
import type { ProviderInfo, ProviderModel } from '../../types/step';

/**
 * Shared model picker (BACKLOG #49) — the ONE component used everywhere a model is
 * chosen (submodule panel, template editor, workbench, all via SubmoduleOptions).
 *
 * Coupled provider→model selection driven by GET /api/providers:
 *   - shows each model's price per Mtok at the point of choice (choosing blind is
 *     how everything ends up on the expensive default);
 *   - unavailable providers (no key on the box) are visibly unavailable WITH the
 *     reason — never silently absent, never selectable-and-broken (kills the
 *     openai footgun: selectable-but-keyless → 500 mid-run);
 *   - changing provider re-points the model to a valid one for that provider, so a
 *     mismatched pair (gemini+sonnet) can't be built in the UI.
 */
export interface ModelPickerProps {
  provider: string;
  model: string;
  onProviderChange: (provider: string) => void;
  onModelChange: (model: string) => void;
  label?: string;
  description?: string;
}

/**
 * The model to select when the provider changes: keep the current model if it's
 * valid for the new provider, else fall back to that provider's first model.
 * Returns null if the provider is unknown / has no models. Pure — unit-tested.
 */
export function nextModelForProvider(
  providers: ProviderInfo[],
  providerId: string,
  currentModel: string,
): string | null {
  const p = providers.find((x) => x.id === providerId);
  if (!p || p.models.length === 0) return null;
  if (p.models.some((m) => m.key === currentModel)) return currentModel;
  return p.models[0].key;
}

const SELECT_CLS =
  'w-full bg-white border border-gray-300 rounded px-3 py-2 text-gray-900 text-sm focus:outline-none focus:border-[#0891B2]';

function priceText(m: ProviderModel): string {
  return `$${m.input}/$${m.output} per Mtok${m.alias ? ' · ⚠ -latest' : ''}`;
}

export function ModelPicker({ provider, model, onProviderChange, onModelChange, label = 'AI Model', description }: ModelPickerProps) {
  const { data, isLoading, isError, refetch } = useProviders();
  const providers = data?.providers ?? [];
  const selectedProvider = providers.find((p) => p.id === provider);
  const selectedModel = selectedProvider?.models.find((m) => m.key === model);

  const handleProviderChange = (newProvider: string) => {
    onProviderChange(newProvider);
    const next = nextModelForProvider(providers, newProvider, model);
    if (next && next !== model) onModelChange(next);
  };

  if (isLoading) {
    return (
      <div className="space-y-1">
        <label className="block text-xs text-gray-600">AI Provider / {label}</label>
        <select className={SELECT_CLS} disabled value={provider}><option>{provider} · loading models…</option></select>
      </div>
    );
  }

  if (isError) {
    // Don't block the form — keep the stored provider/model, surface the failure.
    return (
      <div className="space-y-1">
        <label className="block text-xs text-gray-600">AI Provider / {label}</label>
        <p className="text-[10px] text-red-500">
          Couldn't load provider list. Using stored: <b>{provider}</b> / <b>{model}</b>.{' '}
          <button type="button" className="underline" onClick={() => refetch()}>Retry</button>
        </p>
      </div>
    );
  }

  // If the stored provider isn't in the registry, still show it so the user sees the current value.
  const providerOptions = selectedProvider ? providers : [...providers, { id: provider, displayName: provider, configured: false, reason: 'not in registry', models: [] }];

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs text-gray-600 mb-1">AI Provider</label>
        <select className={SELECT_CLS} value={provider} onChange={(e) => handleProviderChange(e.target.value)}>
          {providerOptions.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.configured}>
              {p.displayName}{p.configured ? '' : ` — unavailable (${p.reason ?? 'no key'})`}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs text-gray-600 mb-1">{label}</label>
        <select className={SELECT_CLS} value={model} onChange={(e) => onModelChange(e.target.value)}>
          {(selectedProvider?.models ?? []).map((m) => (
            <option key={m.key} value={m.key}>{m.displayName} — {priceText(m)}</option>
          ))}
        </select>
        {selectedModel && (
          <p className="text-[10px] text-gray-500 mt-1">
            Price: <b>{priceText(selectedModel)}</b>
          </p>
        )}
      </div>

      {selectedProvider && !selectedProvider.configured && (
        <p className="text-[10px] text-red-500">
          {selectedProvider.displayName} has no API key on the server ({selectedProvider.reason}). Runs on this provider will fail until a key is added.
        </p>
      )}
      {description && <p className="text-[10px] text-gray-400">{description}</p>}
    </div>
  );
}
