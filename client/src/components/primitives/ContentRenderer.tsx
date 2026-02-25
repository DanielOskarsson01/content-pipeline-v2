import { useRef, useMemo, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { DetailModal, type DetailSchema } from './DetailModal';
import type { DownloadableField } from '../../types/step';

/** Render schema from output_schema — drives display_type, selectable, columns */
export interface RenderSchema {
  display_type?: string;
  selectable?: boolean;
  detail_schema?: DetailSchema;
  downloadable_fields?: DownloadableField[];
  /** Manifest-driven flagging: { field: [values] } — items matching are red-highlighted and auto-deselected */
  flagged_when?: Record<string, string[]>;
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
  /** Callback to request full data loading (e.g. for detail modal with downloadable fields) */
  onRequestFullData?: () => void;
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
 * When renderSchema.detail_schema is set, row clicks open a detail modal
 * showing full content for the item (header fields + scrollable sections).
 *
 * DO NOT replace with naive .map() — virtualisation is critical for performance.
 */
const PAGE_SIZE = 50;

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
  onRequestFullData,
}: ContentRendererProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(0);

  // Reset page when data changes
  const entityCount = entities.length;
  const prevCountRef = useRef(entityCount);
  if (entityCount !== prevCountRef.current) {
    prevCountRef.current = entityCount;
    if (currentPage !== 0) setCurrentPage(0);
  }

  const selectable = renderSchema?.selectable === true && !!checkedKeys && !!onCheckedKeysChange;
  const detailSchema = (renderSchema?.detail_schema as DetailSchema | undefined) ?? null;
  const downloadableFields = renderSchema?.downloadable_fields;
  const flaggedWhen = renderSchema?.flagged_when;

  // Detail modal state — stores index only; reads live from entities for freshest data
  const [detailItem, setDetailItem] = useState<{ index: number } | null>(null);
  const detailItemData = detailItem ? entities[detailItem.index] : null;

  // Derive columns from renderSchema field definitions (exclude meta fields) or from props/data
  const columns = useMemo(() => {
    if (columnsProp) return columnsProp;
    if (renderSchema) {
      const metaFields = new Set(['display_type', 'selectable', 'detail_schema', 'flagged_when', 'downloadable_fields']);
      return Object.keys(renderSchema).filter((k) => !metaFields.has(k));
    }
    return entities.length > 0 ? Object.keys(entities[0]) : [];
  }, [columnsProp, renderSchema, entities]);

  // Pagination — only active when entities exceed PAGE_SIZE
  const totalPages = Math.ceil(entities.length / PAGE_SIZE);
  const showPagination = entities.length > PAGE_SIZE;
  const pageStart = currentPage * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, entities.length);
  const pagedEntities = showPagination ? entities.slice(pageStart, pageEnd) : entities;

  const virtualizer = useVirtualizer({
    count: pagedEntities.length,
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

  // --- Row click handler ---
  const handleRowClick = (_entity: Record<string, unknown>, index: number, key: string) => {
    if (detailSchema) {
      // Has detail_schema: row click opens modal (checkbox has stopPropagation)
      onRequestFullData?.(); // Trigger loading of full data (downloadable fields)
      setDetailItem({ index });
    } else if (selectable) {
      // No detail_schema + selectable: row click toggles checkbox
      toggleItem(key);
    }
    // No detail_schema + not selectable: no action
  };

  // Grid template: optional checkbox + optional data-op icon + # + columns + optional expand icon
  // Wide columns: preview/description fields get 3fr, compact fields get auto-sized
  const WIDE_PATTERNS = /preview|description|content|summary/i;
  const NARROW_PATTERNS = /^(status|word_count|content_type)$/;
  const checkboxCol = selectable ? '28px ' : '';
  const opIconCol = selectable && dataOperation ? '24px ' : '';
  const expandCol = detailSchema ? ' 28px' : '';
  const colWidths = columns.map((col) => {
    if (WIDE_PATTERNS.test(col)) return 'minmax(200px, 3fr)';
    if (NARROW_PATTERNS.test(col)) return 'minmax(60px, auto)';
    return 'minmax(80px, 1fr)';
  }).join(' ');
  const gridTemplate = `${checkboxCol}${opIconCol}40px ${colWidths}${expandCol}`;

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
          {detailSchema && <span className="px-1 py-1.5" />}
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
            const entity = pagedEntities[virtualItem.index];
            const globalIndex = pageStart + virtualItem.index;
            const key = String(entity[itemKey] ?? `row-${globalIndex}`);
            const isChecked = selectable ? checkedKeys!.has(key) : true;
            const isFlagged = flaggedWhen ? Object.entries(flaggedWhen).some(
              ([field, values]) => values.includes(String(entity[field] ?? ''))
            ) : false;
            const isClickable = selectable || !!detailSchema;

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
                className={`items-center text-xs border-b border-gray-100 ${
                  isFlagged ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-gray-50'
                } ${selectable && !isChecked ? 'opacity-50' : ''
                } ${isClickable ? 'cursor-pointer' : ''}`}
                onClick={() => handleRowClick(entity, globalIndex, key)}
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
                  {globalIndex + 1}
                </span>
                {columns.map((col) => {
                  const value = String(entity[col] ?? '');
                  const isUrl = col === 'url' || value.startsWith('http://') || value.startsWith('https://');
                  return (
                    <span key={col} className="px-2 truncate text-gray-700" title={value}>
                      {isUrl ? (
                        <a
                          href={value}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-cyan-600 hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {value}
                        </a>
                      ) : value}
                    </span>
                  );
                })}
                {detailSchema && (
                  <span className="px-1 flex items-center justify-center text-gray-400 hover:text-gray-600">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Pagination footer */}
      {showPagination && (
        <div className="flex items-center justify-between mt-1 flex-shrink-0">
          <span className="text-xs text-gray-500">
            Showing {pageStart + 1}-{pageEnd} of {entities.length}
            {selectable && ` \u00b7 ${checkedKeys!.size} approved \u00b7 ${entities.length - checkedKeys!.size} rejected`}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
              disabled={currentPage === 0}
              className="px-2 py-0.5 text-xs rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Prev
            </button>
            <span className="text-xs text-gray-400 px-1">
              {currentPage + 1}/{totalPages}
            </span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={currentPage >= totalPages - 1}
              className="px-2 py-0.5 text-xs rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Detail modal — only rendered when an item is selected for inspection */}
      {detailItem && detailItemData && detailSchema && (
        <DetailModal
          item={detailItemData}
          index={detailItem.index}
          totalItems={entities.length}
          detailSchema={detailSchema}
          onClose={() => setDetailItem(null)}
          onNavigate={(newIndex) => {
            if (newIndex >= 0 && newIndex < entities.length) {
              setDetailItem({ index: newIndex });
            }
          }}
          downloadableFields={downloadableFields}
          {...(selectable ? {
            isChecked: checkedKeys!.has(String(detailItemData[itemKey] ?? '')),
            onToggle: () => toggleItem(String(detailItemData[itemKey] ?? '')),
          } : {})}
        />
      )}
    </div>
  );
}
