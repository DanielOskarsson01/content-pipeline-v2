import { useEffect, useCallback } from 'react';

// --- Types ---

interface HeaderFieldObject {
  field: string;
  display?: string;
}

type HeaderFieldEntry = string | HeaderFieldObject;

interface SectionDef {
  field: string;
  label: string;
  display: 'prose' | 'text' | 'badge' | 'link';
}

export interface DetailSchema {
  header_fields: HeaderFieldEntry[];
  sections: SectionDef[];
}

interface DetailModalProps {
  item: Record<string, unknown>;
  index: number;
  totalItems: number;
  detailSchema: DetailSchema;
  onClose: () => void;
  onNavigate: (index: number) => void;
}

// --- Badge colors ---

const BADGE_COLORS: Record<string, string> = {
  success: 'bg-green-100 text-green-800',
  error: 'bg-red-100 text-red-800',
  skipped: 'bg-yellow-100 text-yellow-800',
  excluded: 'bg-red-100 text-red-800',
  dead_link: 'bg-red-100 text-red-800',
  kept: 'bg-green-100 text-green-800',
  duplicate: 'bg-orange-100 text-orange-800',
};

// --- Component ---

export function DetailModal({
  item,
  index,
  totalItems,
  detailSchema,
  onClose,
  onNavigate,
}: DetailModalProps) {
  const hasPrev = index > 0;
  const hasNext = index < totalItems - 1;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && hasPrev) onNavigate(index - 1);
      if (e.key === 'ArrowRight' && hasNext) onNavigate(index + 1);
    },
    [onClose, onNavigate, index, hasPrev, hasNext]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div className="relative bg-white rounded-lg shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col mx-4">
        {/* Header bar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 flex-shrink-0">
          <span className="text-xs text-gray-400">
            {index + 1} of {totalItems}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onNavigate(index - 1)}
              disabled={!hasPrev}
              className={`px-2 py-1 rounded text-xs font-medium ${
                hasPrev
                  ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  : 'bg-gray-50 text-gray-300 cursor-not-allowed'
              }`}
            >
              Prev
            </button>
            <button
              onClick={() => onNavigate(index + 1)}
              disabled={!hasNext}
              className={`px-2 py-1 rounded text-xs font-medium ${
                hasNext
                  ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  : 'bg-gray-50 text-gray-300 cursor-not-allowed'
              }`}
            >
              Next
            </button>
            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Header fields */}
        <div className="px-5 py-3 border-b border-gray-100 flex-shrink-0">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            {detailSchema.header_fields.map((entry, i) => {
              const fieldName = typeof entry === 'string' ? entry : entry.field;
              const display = typeof entry === 'string' ? undefined : entry.display;
              const value = String(item[fieldName] ?? '');

              return (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-400">{fieldName}:</span>
                  <HeaderValue value={value} display={display} />
                </div>
              );
            })}
          </div>
        </div>

        {/* Sections */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {detailSchema.sections.map((section, i) => {
            const value = String(item[section.field] ?? '');
            return (
              <div key={i}>
                <h4 className="text-xs font-medium text-gray-500 uppercase mb-1.5">
                  {section.label}
                </h4>
                <SectionRenderer value={value} display={section.display} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// --- Header value renderer ---

function HeaderValue({ value, display }: { value: string; display?: string }) {
  if (display === 'link' && value) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-cyan-600 hover:underline max-w-[300px] truncate"
        title={value}
      >
        {value}
      </a>
    );
  }

  if (display === 'badge' || (!display && value in BADGE_COLORS)) {
    const colorClass = BADGE_COLORS[value] || 'bg-gray-100 text-gray-700';
    return (
      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colorClass}`}>
        {value}
      </span>
    );
  }

  // Auto-detect: if no display specified and field name suggests a status, render as badge
  return <span className="text-xs text-gray-700 font-medium">{value || '\u2014'}</span>;
}

// --- Section renderers ---

function SectionRenderer({ value, display }: { value: string; display: string }) {
  switch (display) {
    case 'prose':
      return (
        <div className="bg-gray-50 rounded border border-gray-200 p-3 max-h-[400px] overflow-y-auto">
          <pre className="text-xs text-gray-700 whitespace-pre-wrap font-sans leading-relaxed">
            {value || '(empty)'}
          </pre>
        </div>
      );

    case 'text':
      return (
        <p className="text-sm text-gray-700">
          {value || <span className="text-gray-400 italic">Not available</span>}
        </p>
      );

    case 'badge': {
      const colorClass = BADGE_COLORS[value] || 'bg-gray-100 text-gray-700';
      return (
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colorClass}`}>
          {value}
        </span>
      );
    }

    case 'link':
      return value ? (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-cyan-600 hover:underline break-all"
        >
          {value}
        </a>
      ) : (
        <span className="text-sm text-gray-400 italic">Not available</span>
      );

    default:
      return <p className="text-sm text-gray-700">{value || '\u2014'}</p>;
  }
}
