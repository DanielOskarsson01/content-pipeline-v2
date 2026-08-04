import { useState } from 'react';
import type { SubmoduleOption } from '../../types/step';
import { ReferenceDocSelector } from './ReferenceDocSelector';
import { PresetField } from './PresetField';
import { TagListEditor } from './TagListEditor';
import { ProviderEditor } from './ProviderEditor';
import { KeyValueEditor } from './KeyValueEditor';
import { CsvDiscoveryUpload } from './CsvDiscoveryUpload';
import { ModelPicker } from './ModelPicker';

interface SubmoduleOptionsProps {
  options: SubmoduleOption[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  projectId: string;
  submoduleId: string;
}

/**
 * Dynamic form generator for submodule options.
 *
 * Renders form fields based on manifest options[] array.
 * Supports: select, checkbox/boolean, number, text, textarea, doc_selector.
 */
export function SubmoduleOptions({
  options,
  values,
  onChange,
  projectId,
  submoduleId,
}: SubmoduleOptionsProps) {
  // Prompt-sized textareas default to 4 rows — too small to read what's
  // actually loaded. Per-option expand state (textareas stay resize-y too).
  const [expandedTextareas, setExpandedTextareas] = useState<Record<string, boolean>>({});

  if (options.length === 0) {
    return (
      <p className="text-xs text-gray-400 text-center py-2">
        No options available for this submodule
      </p>
    );
  }

  // BACKLOG #49: the registry-driven ai_provider + ai_model pair renders as ONE
  // coupled, priced picker. Detect the pair so the ai_provider slot renders the
  // ModelPicker (managing both values) and the standalone ai_model slot is skipped.
  const registryProviderOpt = options.find((o) => o.name === 'ai_provider' && o.values_from);
  const registryModelOpt = options.find((o) => o.name === 'ai_model' && o.values_from);
  const usePicker = Boolean(registryProviderOpt && registryModelOpt);

  return (
    <div className="space-y-3">
      {options.map((option) => {
        const value = values[option.name] ?? option.default;

        // The coupled ai_provider/ai_model picker replaces both plain selects.
        if (usePicker && option.name === 'ai_model') return null; // handled by the picker on ai_provider
        if (usePicker && option.name === 'ai_provider') {
          return (
            <ModelPicker
              key="model-picker"
              provider={String(values['ai_provider'] ?? registryProviderOpt!.default ?? 'anthropic')}
              model={String(values['ai_model'] ?? registryModelOpt!.default ?? 'haiku')}
              label={registryModelOpt!.label}
              description={registryModelOpt!.description}
              onProviderChange={(p) => onChange('ai_provider', p)}
              onModelChange={(m) => onChange('ai_model', m)}
            />
          );
        }

        const presetDropdown = option.presets_enabled ? (
          <PresetField
            submoduleId={submoduleId}
            optionName={option.name}
            projectId={projectId}
            currentValue={value}
            onLoadPreset={(presetValue) => onChange(option.name, presetValue)}
          />
        ) : null;

        switch (option.type) {
          case 'select':
            return (
              <div key={option.name}>
                <label className="block text-xs text-gray-600 mb-1">
                  {option.label}
                </label>
                {presetDropdown}
                <select
                  value={String(value)}
                  onChange={(e) => onChange(option.name, e.target.value)}
                  className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-gray-900 text-sm focus:outline-none focus:border-[#0891B2]"
                >
                  {option.values?.map((val) => (
                    <option key={val} value={val}>
                      {val}
                    </option>
                  ))}
                </select>
                {option.description && (
                  <p className="text-[10px] text-gray-400 mt-1">{option.description}</p>
                )}
              </div>
            );

          case 'boolean':
            return (
              <label key={option.name} className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(e) => onChange(option.name, e.target.checked)}
                  className="mt-0.5 rounded border-gray-300 text-[#0891B2] focus:ring-[#0891B2]"
                />
                <span className="text-gray-700">
                  {option.label}
                  {option.description && (
                    <span className="block text-[10px] text-gray-400 mt-0.5">
                      {option.description}
                    </span>
                  )}
                </span>
              </label>
            );

          case 'number':
            return (
              <div key={option.name}>
                <label className="block text-xs text-gray-600 mb-1">
                  {option.label}
                </label>
                <input
                  type="number"
                  value={Number(value)}
                  min={option.min}
                  max={option.max}
                  onChange={(e) => onChange(option.name, Number(e.target.value))}
                  className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-gray-900 text-sm focus:outline-none focus:border-[#0891B2]"
                />
                {option.description && (
                  <p className="text-[10px] text-gray-400 mt-1">
                    {option.description}
                    {(option.min != null || option.max != null) && (
                      <span className="ml-1">
                        ({option.min != null && `min: ${option.min}`}
                        {option.min != null && option.max != null && ', '}
                        {option.max != null && `max: ${option.max}`})
                      </span>
                    )}
                  </p>
                )}
              </div>
            );

          case 'textarea': {
            const isExpanded = !!expandedTextareas[option.name];
            return (
              <div key={option.name}>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs text-gray-600">
                    {option.label}
                  </label>
                  <button
                    type="button"
                    onClick={() => setExpandedTextareas((prev) => ({ ...prev, [option.name]: !isExpanded }))}
                    className="text-[10px] text-[#0891B2] hover:underline"
                  >
                    {isExpanded ? 'Collapse' : 'Expand'}
                  </button>
                </div>
                {presetDropdown}
                <textarea
                  value={String(value ?? '')}
                  maxLength={option.maxLength}
                  onChange={(e) => onChange(option.name, e.target.value)}
                  rows={isExpanded ? 28 : 4}
                  className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-gray-900 text-sm focus:outline-none focus:border-[#0891B2] resize-y"
                />
                {option.description && (
                  <p className="text-[10px] text-gray-400 mt-1">
                    {option.description}
                    {option.maxLength && (
                      <span className="ml-1">(max {option.maxLength} chars)</span>
                    )}
                  </p>
                )}
              </div>
            );
          }

          case 'doc_selector':
            return (
              <div key={option.name}>
                <label className="block text-xs text-gray-600 mb-1">
                  {option.label}
                </label>
                {projectId ? (
                  <ReferenceDocSelector
                    projectId={projectId}
                    value={Array.isArray(value) ? value as string[] : []}
                    onChange={(docIds) => onChange(option.name, docIds)}
                  />
                ) : (
                  <p className="text-[10px] text-gray-400 italic">Available when editing from a project run</p>
                )}
                {option.description && (
                  <p className="text-[10px] text-gray-400 mt-1">{option.description}</p>
                )}
              </div>
            );

          case 'file_upload':
            return (
              <div key={option.name}>
                <label className="block text-xs text-gray-600 mb-1">
                  {option.label}
                </label>
                {projectId ? (
                  <CsvDiscoveryUpload
                    projectId={projectId}
                    accept={option.accept}
                    onChange={(uploadDir) => onChange(option.name, uploadDir)}
                  />
                ) : (
                  <p className="text-[10px] text-gray-400 italic">Available when editing from a project run</p>
                )}
                {option.description && (
                  <p className="text-[10px] text-gray-400 mt-1">{option.description}</p>
                )}
              </div>
            );

          case 'json':
            return (
              <JsonOptionField
                key={option.name}
                option={option}
                value={value}
                onChange={(v) => onChange(option.name, v)}
                presetDropdown={presetDropdown}
                allValues={values}
              />
            );

          case 'text':
          default:
            return (
              <div key={option.name}>
                <label className="block text-xs text-gray-600 mb-1">
                  {option.label}
                </label>
                {presetDropdown}
                <input
                  type="text"
                  value={String(value ?? '')}
                  onChange={(e) => onChange(option.name, e.target.value)}
                  className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-gray-900 text-sm focus:outline-none focus:border-[#0891B2]"
                />
                {option.description && (
                  <p className="text-[10px] text-gray-400 mt-1">{option.description}</p>
                )}
              </div>
            );
        }
      })}
    </div>
  );
}

// ── JSON option field with smart sub-editor detection ──────────────

function JsonOptionField({
  option,
  value,
  onChange,
  presetDropdown,
  allValues,
}: {
  option: SubmoduleOption;
  value: unknown;
  onChange: (v: unknown) => void;
  presetDropdown: React.ReactNode;
  allValues: Record<string, unknown>;
}) {
  const [rawMode, setRawMode] = useState(false);

  // Parse value if it's a string (UI may have stored JSON as string)
  const parsed = parseJsonValue(value, option.default);

  // Detect which editor to use based on option name and shape
  const isProviders = option.name === 'providers';
  const isProviderParams = option.name === 'provider_params';
  const isStringArray = Array.isArray(parsed) && (parsed.length === 0 || typeof parsed[0] === 'string');

  // Raw JSON fallback
  if (rawMode || (!isProviders && !isProviderParams && !isStringArray)) {
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-xs text-gray-600">{option.label}</label>
          {(isProviders || isProviderParams || isStringArray) && (
            <button type="button" onClick={() => setRawMode(false)} className="text-[10px] text-[#0891B2]">Form view</button>
          )}
        </div>
        {presetDropdown}
        <JsonTextarea value={parsed} onChange={onChange} />
        {option.description && (
          <p className="text-[10px] text-gray-400 mt-1">{option.description}</p>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-xs text-gray-600">{option.label}</label>
        <button type="button" onClick={() => setRawMode(true)} className="text-[10px] text-gray-400 hover:text-gray-600">JSON</button>
      </div>
      {presetDropdown}

      {isProviders && (
        <ProviderEditor
          value={Array.isArray(parsed) ? parsed : []}
          onChange={onChange}
        />
      )}

      {isProviderParams && (
        <KeyValueEditor
          value={typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, Record<string, string>> : {}}
          onChange={onChange}
          groupKeys={getProviderIds(allValues)}
        />
      )}

      {isStringArray && !isProviders && (
        <TagListEditor
          value={parsed as string[]}
          onChange={onChange}
          placeholder={`Add ${option.label.toLowerCase()}...`}
        />
      )}

      {option.description && (
        <p className="text-[10px] text-gray-400 mt-1">{option.description}</p>
      )}
    </div>
  );
}

function JsonTextarea({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  const handleChange = (raw: string) => {
    setText(raw);
    try {
      const parsed = JSON.parse(raw);
      onChange(parsed);
      setError(null);
    } catch {
      setError('Invalid JSON');
    }
  };

  return (
    <>
      <textarea
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        rows={6}
        className={`w-full bg-white border rounded px-3 py-2 text-gray-900 text-xs font-mono focus:outline-none resize-y ${error ? 'border-red-300 focus:border-red-400' : 'border-gray-300 focus:border-[#0891B2]'}`}
      />
      {error && <p className="text-[10px] text-red-500 mt-0.5">{error}</p>}
    </>
  );
}

function parseJsonValue(value: unknown, defaultValue: unknown): unknown {
  if (value === undefined || value === null) return defaultValue ?? [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try { return JSON.parse(trimmed); } catch { /* fall through */ }
    }
    // Might be comma-separated
    if (Array.isArray(defaultValue)) {
      return trimmed ? trimmed.split(',').map(s => s.trim()).filter(Boolean) : [];
    }
    return defaultValue ?? value;
  }
  return value;
}

function getProviderIds(values: Record<string, unknown>): string[] {
  const providers = values.providers;
  if (!providers) return [];
  const parsed = typeof providers === 'string' ? (() => { try { return JSON.parse(providers); } catch { return []; } })() : providers;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((p: { id?: string }) => p.id).filter(Boolean);
}
