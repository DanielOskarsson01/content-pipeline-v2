import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface ContentRendererProps {
  /** Array of entity objects (rows) */
  entities: Record<string, unknown>[];
  /** Column names to display (auto-detected from first entity if omitted) */
  columns?: string[];
  /** Maximum container height in pixels (default: 320). Ignored when fullHeight is true. */
  maxHeight?: number;
  /** Use all available space in parent container */
  fullHeight?: boolean;
  /** Optional label above the table (e.g. "12 entities loaded") */
  label?: string;
  /** Optional download handler — shows Download CSV button when set */
  onDownloadCsv?: () => void;
}

/**
 * Reusable content renderer for entity data.
 *
 * Renders a virtual-scrolling table for large datasets (10,000+ rows).
 * Used by Input accordion (CSV preview) and Results accordion (output preview).
 *
 * DO NOT replace with naive .map() — virtualisation is critical for performance.
 */
export function ContentRenderer({
  entities,
  columns: columnsProp,
  maxHeight = 320,
  fullHeight = false,
  label,
  onDownloadCsv,
}: ContentRendererProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Auto-detect columns from first entity if not provided
  const columns = columnsProp || (entities.length > 0 ? Object.keys(entities[0]) : []);

  const virtualizer = useVirtualizer({
    count: entities.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 15,
  });

  if (entities.length === 0) {
    return (
      <div className="text-center py-4">
        <p className="text-xs text-gray-400">No data to display</p>
      </div>
    );
  }

  const handleDownload = () => {
    if (onDownloadCsv) {
      onDownloadCsv();
      return;
    }

    // Default CSV download
    const headerRow = columns.map((c) => `"${c}"`).join(',');
    const rows = entities.map((entity) =>
      columns
        .map((col) => {
          const val = String(entity[col] ?? '');
          return `"${val.replace(/"/g, '""')}"`;
        })
        .join(',')
    );
    const csv = [headerRow, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `data-${entities.length}-rows.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={fullHeight ? 'h-full flex flex-col' : 'space-y-2'}>
      {/* Header bar */}
      <div className={`flex items-center justify-between ${fullHeight ? 'flex-shrink-0 mb-1' : ''}`}>
        <p className="text-xs text-gray-600 font-medium">
          {label || `${entities.length} rows \u00d7 ${columns.length} columns`}
        </p>
        <button
          onClick={handleDownload}
          className="text-xs text-[#0891B2] hover:text-[#0891B2]/80 flex items-center gap-1"
        >
          <span>\u2b07</span> CSV
        </button>
      </div>

      {/* Table with virtual scrolling — unified grid layout for column alignment */}
      <div
        ref={parentRef}
        className={`overflow-auto border border-gray-200 rounded ${fullHeight ? 'flex-1 min-h-0' : ''}`}
        style={fullHeight ? undefined : { maxHeight }}
      >
        {/* Sticky header — same grid as rows */}
        <div
          className="sticky top-0 bg-gray-50 z-10 border-b border-gray-200"
          style={{
            display: 'grid',
            gridTemplateColumns: `40px repeat(${columns.length}, minmax(80px, 1fr))`,
          }}
        >
          <span className="px-2 py-1.5 text-left text-gray-500 font-medium text-xs">#</span>
          {columns.map((col) => (
            <span key={col} className="px-2 py-1.5 text-left text-gray-500 font-medium text-xs truncate">
              {col}
            </span>
          ))}
        </div>

        {/* Virtual rows */}
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const entity = entities[virtualItem.index];
            return (
              <div
                key={virtualItem.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`,
                  display: 'grid',
                  gridTemplateColumns: `40px repeat(${columns.length}, minmax(80px, 1fr))`,
                }}
                className="items-center hover:bg-gray-50 text-xs border-b border-gray-100"
              >
                <span className="px-2 text-gray-400 truncate">
                  {virtualItem.index + 1}
                </span>
                {columns.map((col) => (
                  <span key={col} className="px-2 truncate text-gray-700" title={String(entity[col] ?? '')}>
                    {String(entity[col] ?? '')}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
