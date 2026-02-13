import { useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/** Render schema from output_schema — drives display_type, selectable, columns */
export interface RenderSchema {
  display_type?: string;
  selectable?: boolean;
  [field: string]: unknown;
}

export interface ContentRendererProps {
  /** Array of entity/item objects (rows) */
  entities: Record<string, unknown>[];
  /** Render schema — drives display_type, selectable, and column definitions */
  renderSchema?: RenderSchema | null;
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
  /** Selectable mode props — only used when renderSchema.selectable is true */
  checkedKeys?: Set<string>;
  onCheckedKeysChange?: (keys: Set<string>) => void;
  /** Field used as unique key for each row (default: 'url') */
  itemKey?: string;
  /** Current data operation — shown as per-row icon when selectable */
  dataOperation?: string;
}

const DATA_OP_ICONS: Record<string, string> = { add: '\u2795', remove: '\u2796', transform: '\uFF1D' };

/**
 * Pass-through content renderer for entity/item data.
 *
 * Renders a virtual-scrolling table for large datasets (10,000+ rows).
 * Used by Input accordion (CSV preview) and Results accordion (output preview).
 *
 * When renderSchema.selectable is true, adds per-row checkboxes and
 * Select all / Deselect all controls for item-level approval.
 *
 * DO NOT replace with naive .map() — virtualisation is critical for performance.
 */
export function ContentRenderer({
  entities,
  renderSchema,
  columns: columnsProp,
  maxHeight = 320,
  fullHeight = false,
  label,
  onDownloadCsv,
  checkedKeys,
  onCheckedKeysChange,
  itemKey = 'url',
  dataOperation,
}: ContentRendererProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const selectable = renderSchema?.selectable === true && !!checkedKeys && !!onCheckedKeysChange;

  // Derive columns from renderSchema field definitions (exclude meta fields) or from props/data
  const columns = useMemo(() => {
    if (columnsProp) return columnsProp;
    if (renderSchema) {
      const metaFields = new Set(['display_type', 'selectable']);
      return Object.keys(renderSchema).filter((k) => !metaFields.has(k));
    }
    return entities.length > 0 ? Object.keys(entities[0]) : [];
  }, [columnsProp, renderSchema, entities]);

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

  // --- Selectable helpers ---
  const toggleItem = (key: string) => {
    if (!checkedKeys || !onCheckedKeysChange) return;
    const next = new Set(checkedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onCheckedKeysChange(next);
  };

  const selectAll = () => {
    if (!onCheckedKeysChange) return;
    const allKeys = entities.map((e) => String(e[itemKey] ?? '')).filter(Boolean);
    onCheckedKeysChange(new Set(allKeys));
  };

  const deselectAll = () => {
    if (!onCheckedKeysChange) return;
    onCheckedKeysChange(new Set());
  };

  // Grid template: optional checkbox + optional data-op icon + # + columns
  const checkboxCol = selectable ? '28px ' : '';
  const opIconCol = selectable && dataOperation ? '24px ' : '';
  const gridTemplate = `${checkboxCol}${opIconCol}40px repeat(${columns.length}, minmax(80px, 1fr))`;

  const opIcon = dataOperation ? (DATA_OP_ICONS[dataOperation] || '\uFF1D') : '';

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
          <span>{'\u2b07'}</span> CSV
        </button>
      </div>

      {/* Select all / Deselect all controls — only when selectable */}
      {selectable && (
        <div className="flex items-center gap-3 flex-shrink-0">
          <button onClick={selectAll} className="text-xs text-[#0891B2] hover:underline">
            Select all
          </button>
          <button onClick={deselectAll} className="text-xs text-[#0891B2] hover:underline">
            Deselect all
          </button>
          <span className="text-xs text-gray-400 ml-auto">
            {checkedKeys!.size} approved {'\u00b7'} {entities.length - checkedKeys!.size} rejected
          </span>
        </div>
      )}

      {/* Table with virtual scrolling */}
      <div
        ref={parentRef}
        className={`overflow-auto border border-gray-200 rounded ${fullHeight ? 'flex-1 min-h-0' : ''}`}
        style={fullHeight ? undefined : { maxHeight }}
      >
        {/* Sticky header */}
        <div
          className="sticky top-0 bg-gray-50 z-10 border-b border-gray-200"
          style={{ display: 'grid', gridTemplateColumns: gridTemplate }}
        >
          {selectable && <span className="px-1 py-1.5" />}
          {selectable && dataOperation && <span className="px-1 py-1.5" />}
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
            const key = String(entity[itemKey] ?? `row-${virtualItem.index}`);
            const isChecked = selectable ? checkedKeys!.has(key) : true;

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
                  gridTemplateColumns: gridTemplate,
                }}
                className={`items-center hover:bg-gray-50 text-xs border-b border-gray-100 ${
                  selectable && !isChecked ? 'opacity-50' : ''
                } ${selectable ? 'cursor-pointer' : ''}`}
                onClick={selectable ? () => toggleItem(key) : undefined}
              >
                {selectable && (
                  <span className="px-1 flex items-center justify-center">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleItem(key)}
                      className="w-3.5 h-3.5 rounded border-gray-300 text-[#0891B2] focus:ring-[#0891B2] cursor-pointer"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </span>
                )}
                {selectable && dataOperation && (
                  <span className="px-1 text-center text-[10px]" title={dataOperation}>{opIcon}</span>
                )}
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
