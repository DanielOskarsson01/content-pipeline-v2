import type { SubmoduleOption } from '../../types/step';
import { ReferenceDocSelector } from './ReferenceDocSelector';

interface SubmoduleOptionsProps {
  options: SubmoduleOption[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  projectId: string;
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
}: SubmoduleOptionsProps) {
  if (options.length === 0) {
    return (
      <p className="text-xs text-gray-400 text-center py-2">
        No options available for this submodule
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {options.map((option) => {
        const value = values[option.name] ?? option.default;

        switch (option.type) {
          case 'select':
            return (
              <div key={option.name}>
                <label className="block text-xs text-gray-600 mb-1">
                  {option.label}
                </label>
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

          case 'textarea':
            return (
              <div key={option.name}>
                <label className="block text-xs text-gray-600 mb-1">
                  {option.label}
                </label>
                <textarea
                  value={String(value ?? '')}
                  maxLength={option.maxLength}
                  onChange={(e) => onChange(option.name, e.target.value)}
                  rows={4}
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

          case 'doc_selector':
            return (
              <div key={option.name}>
                <label className="block text-xs text-gray-600 mb-1">
                  {option.label}
                </label>
                <ReferenceDocSelector
                  projectId={projectId}
                  value={Array.isArray(value) ? value as string[] : []}
                  onChange={(docIds) => onChange(option.name, docIds)}
                />
                {option.description && (
                  <p className="text-[10px] text-gray-400 mt-1">{option.description}</p>
                )}
              </div>
            );

          case 'text':
          default:
            return (
              <div key={option.name}>
                <label className="block text-xs text-gray-600 mb-1">
                  {option.label}
                </label>
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
