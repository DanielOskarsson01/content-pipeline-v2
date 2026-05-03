import { useState, useCallback } from 'react';

interface ProviderConfig {
  id: string;
  name: string;
  mode: 'search' | 'feed';
  url: string;
  keyword_param?: string;
  limit_param?: string;
  results_path?: string;
  filter_fields?: string[];
  field_map: Record<string, string | string[] | null>;
  auth?: { type: string; key: string; env_var: string };
}

interface ProviderEditorProps {
  value: ProviderConfig[];
  onChange: (value: ProviderConfig[]) => void;
}

const EMPTY_PROVIDER: ProviderConfig = {
  id: '',
  name: '',
  mode: 'search',
  url: '',
  keyword_param: 'q',
  limit_param: 'limit',
  results_path: '',
  field_map: { title: '', url: '', externalId: '', snippet: '', company: '', location: '', postedAt: '' },
};

/**
 * Form-based editor for API provider configurations.
 * Shows a list of configured providers with add/edit/delete.
 */
export function ProviderEditor({ value, onChange }: ProviderEditorProps) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<ProviderConfig>(EMPTY_PROVIDER);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const startAdd = useCallback(() => {
    setDraft({ ...EMPTY_PROVIDER, field_map: { ...EMPTY_PROVIDER.field_map } });
    setEditing(-1); // -1 = new
    setShowAdvanced(false);
  }, []);

  const startEdit = useCallback((index: number) => {
    setDraft({ ...value[index], field_map: { ...value[index].field_map } });
    setEditing(index);
    setShowAdvanced(false);
  }, [value]);

  const save = useCallback(() => {
    if (!draft.id || !draft.url) return;
    const updated = [...value];
    if (editing === -1) {
      updated.push(draft);
    } else if (editing !== null) {
      updated[editing] = draft;
    }
    onChange(updated);
    setEditing(null);
  }, [draft, editing, value, onChange]);

  const remove = useCallback((index: number) => {
    onChange(value.filter((_, i) => i !== index));
  }, [value, onChange]);

  const updateDraft = (field: string, val: string) => {
    setDraft(prev => ({ ...prev, [field]: val }));
  };

  const updateFieldMap = (key: string, val: string) => {
    setDraft(prev => ({ ...prev, field_map: { ...prev.field_map, [key]: val || null } }));
  };

  // Provider list view
  if (editing === null) {
    return (
      <div className="space-y-2">
        {value.length === 0 && (
          <p className="text-xs text-gray-400 py-2">No providers configured</p>
        )}
        {value.map((provider, i) => (
          <div key={provider.id} className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded px-3 py-2">
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-gray-800 truncate block">{provider.name || provider.id}</span>
              <span className="text-[10px] text-gray-400 truncate block">{provider.url}</span>
            </div>
            <span className="text-[10px] bg-gray-200 text-gray-600 rounded px-1.5 py-0.5">{provider.mode}</span>
            <button
              type="button"
              onClick={() => startEdit(i)}
              className="text-xs text-[#0891B2] hover:text-[#0891B2]/70"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => remove(i)}
              className="text-xs text-red-400 hover:text-red-600"
            >
              &times;
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={startAdd}
          className="w-full text-xs text-[#0891B2] border border-dashed border-[#0891B2]/40 rounded px-3 py-2 hover:bg-[#0891B2]/5"
        >
          + Add provider
        </button>
      </div>
    );
  }

  // Edit form
  return (
    <div className="border border-gray-200 rounded p-3 space-y-3 bg-gray-50">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Provider ID" value={draft.id} onChange={(v) => updateDraft('id', v)} placeholder="e.g. jobtech" />
        <Field label="Display Name" value={draft.name} onChange={(v) => updateDraft('name', v)} placeholder="e.g. JobTech (Platsbanken)" />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">Mode</label>
          <select
            value={draft.mode}
            onChange={(e) => updateDraft('mode', e.target.value)}
            className="w-full bg-white border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#0891B2]"
          >
            <option value="search">Search (one call per keyword)</option>
            <option value="feed">Feed (one call, client filter)</option>
          </select>
        </div>
        <Field label="API URL" value={draft.url} onChange={(v) => updateDraft('url', v)} placeholder="https://api.example.com/search" />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Field label="Keyword param" value={draft.keyword_param || ''} onChange={(v) => updateDraft('keyword_param', v)} placeholder="q" />
        <Field label="Limit param" value={draft.limit_param || ''} onChange={(v) => updateDraft('limit_param', v)} placeholder="limit" />
        <Field label="Results path" value={draft.results_path || ''} onChange={(v) => updateDraft('results_path', v)} placeholder="hits or data.results" />
      </div>

      {/* Field mapping */}
      <div>
        <p className="text-[10px] text-gray-500 mb-1 font-medium">Field Mapping (API response field → pipeline field)</p>
        <div className="grid grid-cols-2 gap-1.5">
          {Object.entries(draft.field_map).map(([key, val]) => (
            <div key={key} className="flex items-center gap-1">
              <span className="text-[10px] text-gray-600 w-16 shrink-0">{key}:</span>
              <input
                type="text"
                value={typeof val === 'string' ? val : (Array.isArray(val) ? val.join(', ') : '')}
                onChange={(e) => updateFieldMap(key, e.target.value)}
                placeholder={`API field for ${key}`}
                className="flex-1 bg-white border border-gray-200 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-[#0891B2]"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Advanced: auth, filter_fields */}
      <button
        type="button"
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="text-[10px] text-gray-400 hover:text-gray-600"
      >
        {showAdvanced ? '▾ Hide advanced' : '▸ Advanced (auth, filter fields)'}
      </button>

      {showAdvanced && (
        <div className="space-y-2 pl-2 border-l-2 border-gray-200">
          <div className="grid grid-cols-3 gap-2">
            <Field
              label="Auth env var"
              value={draft.auth?.env_var || ''}
              onChange={(v) => setDraft(prev => ({
                ...prev,
                auth: v ? { type: 'query_param', key: prev.auth?.key || 'key', env_var: v } : undefined
              }))}
              placeholder="API_KEY_VAR"
            />
            <Field
              label="Auth param name"
              value={draft.auth?.key || ''}
              onChange={(v) => setDraft(prev => ({
                ...prev,
                auth: prev.auth ? { ...prev.auth, key: v } : undefined
              }))}
              placeholder="apiKey"
            />
            <Field
              label="Filter fields (comma-sep)"
              value={draft.filter_fields?.join(', ') || ''}
              onChange={(v) => setDraft(prev => ({
                ...prev,
                filter_fields: v ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined
              }))}
              placeholder="title, description"
            />
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={save}
          disabled={!draft.id || !draft.url}
          className="px-3 py-1.5 bg-[#0891B2] text-white text-xs rounded hover:bg-[#0891B2]/90 disabled:opacity-40"
        >
          {editing === -1 ? 'Add' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => setEditing(null)}
          className="px-3 py-1.5 bg-gray-200 text-gray-700 text-xs rounded hover:bg-gray-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// Small reusable text field
function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="block text-[10px] text-gray-500 mb-0.5">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-white border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#0891B2]"
      />
    </div>
  );
}
