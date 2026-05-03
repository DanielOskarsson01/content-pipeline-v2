import { useState, useCallback } from 'react';

interface KeyValueEditorProps {
  value: Record<string, Record<string, string>>;
  onChange: (value: Record<string, Record<string, string>>) => void;
  /** Available group keys (e.g. provider IDs) */
  groupKeys?: string[];
}

/**
 * Key-value editor for nested objects like provider_params.
 * Structure: { providerId: { paramKey: paramValue, ... }, ... }
 */
export function KeyValueEditor({ value, onChange, groupKeys }: KeyValueEditorProps) {
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupKey, setNewGroupKey] = useState('');

  const addGroup = useCallback((key: string) => {
    if (!key.trim() || value[key.trim()]) return;
    onChange({ ...value, [key.trim()]: {} });
    setAddingGroup(false);
    setNewGroupKey('');
  }, [value, onChange]);

  const removeGroup = useCallback((key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  }, [value, onChange]);

  const setParam = useCallback((group: string, paramKey: string, paramValue: string) => {
    onChange({
      ...value,
      [group]: { ...value[group], [paramKey]: paramValue }
    });
  }, [value, onChange]);

  const removeParam = useCallback((group: string, paramKey: string) => {
    const groupParams = { ...value[group] };
    delete groupParams[paramKey];
    onChange({ ...value, [group]: groupParams });
  }, [value, onChange]);

  const groups = Object.keys(value || {});

  return (
    <div className="space-y-2">
      {groups.length === 0 && !addingGroup && (
        <p className="text-xs text-gray-400 py-1">No extra parameters configured</p>
      )}

      {groups.map((group) => (
        <div key={group} className="bg-gray-50 border border-gray-200 rounded p-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-gray-700">{group}</span>
            <button type="button" onClick={() => removeGroup(group)} className="text-[10px] text-red-400 hover:text-red-600">&times; Remove</button>
          </div>
          <ParamRows
            params={value[group] || {}}
            onSet={(k, v) => setParam(group, k, v)}
            onRemove={(k) => removeParam(group, k)}
          />
        </div>
      ))}

      {addingGroup ? (
        <div className="flex gap-2 items-center">
          {groupKeys && groupKeys.length > 0 ? (
            <select
              value={newGroupKey}
              onChange={(e) => setNewGroupKey(e.target.value)}
              className="flex-1 bg-white border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#0891B2]"
            >
              <option value="">Select provider...</option>
              {groupKeys.filter(k => !value[k]).map(k => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={newGroupKey}
              onChange={(e) => setNewGroupKey(e.target.value)}
              placeholder="Provider ID"
              className="flex-1 bg-white border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#0891B2]"
              onKeyDown={(e) => { if (e.key === 'Enter') addGroup(newGroupKey); }}
            />
          )}
          <button type="button" onClick={() => addGroup(newGroupKey)} disabled={!newGroupKey} className="px-2 py-1.5 bg-[#0891B2] text-white text-xs rounded disabled:opacity-40">Add</button>
          <button type="button" onClick={() => setAddingGroup(false)} className="px-2 py-1.5 bg-gray-200 text-gray-700 text-xs rounded">Cancel</button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAddingGroup(true)}
          className="w-full text-xs text-[#0891B2] border border-dashed border-[#0891B2]/40 rounded px-3 py-1.5 hover:bg-[#0891B2]/5"
        >
          + Add provider params
        </button>
      )}
    </div>
  );
}

function ParamRows({ params, onSet, onRemove }: {
  params: Record<string, string>;
  onSet: (key: string, value: string) => void;
  onRemove: (key: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');

  const entries = Object.entries(params);

  return (
    <div className="space-y-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-1.5 items-center">
          <span className="text-[10px] text-gray-500 w-24 truncate shrink-0">{k}</span>
          <input
            type="text"
            value={v}
            onChange={(e) => onSet(k, e.target.value)}
            className="flex-1 bg-white border border-gray-200 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-[#0891B2]"
          />
          <button type="button" onClick={() => onRemove(k)} className="text-[10px] text-red-400 hover:text-red-600">&times;</button>
        </div>
      ))}
      {adding ? (
        <div className="flex gap-1.5 items-center">
          <input type="text" value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="key" className="w-24 bg-white border border-gray-200 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-[#0891B2]" />
          <input type="text" value={newVal} onChange={(e) => setNewVal(e.target.value)} placeholder="value" className="flex-1 bg-white border border-gray-200 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-[#0891B2]" onKeyDown={(e) => { if (e.key === 'Enter' && newKey) { onSet(newKey, newVal); setNewKey(''); setNewVal(''); setAdding(false); } }} />
          <button type="button" onClick={() => { if (newKey) { onSet(newKey, newVal); setNewKey(''); setNewVal(''); setAdding(false); } }} className="text-[10px] text-[#0891B2]">+</button>
          <button type="button" onClick={() => setAdding(false)} className="text-[10px] text-gray-400">&times;</button>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="text-[10px] text-[#0891B2] hover:text-[#0891B2]/70">+ Add param</button>
      )}
    </div>
  );
}
