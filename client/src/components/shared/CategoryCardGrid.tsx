import { useState } from 'react';
import type { CategoryGroups, SubmoduleManifest, SubmoduleLatestRunMap, SubmoduleConfig } from '../../types/step';
import { usePanelStore } from '../../stores/panelStore';

const DATA_OP_OPTIONS = ['add', 'remove', 'transform'] as const;
const DATA_OP_ICONS: Record<string, string> = {
  add: '\u2795',
  remove: '\u2796',
  transform: '\uFF1D',
};

interface CategoryCardGridProps {
  categories: CategoryGroups;
  latestRuns?: SubmoduleLatestRunMap;
  configMap?: Record<string, SubmoduleConfig>;
  onDataOperationChange?: (submoduleId: string, op: 'add' | 'remove' | 'transform') => void;
}

export function CategoryCardGrid({ categories, latestRuns = {}, configMap = {}, onDataOperationChange }: CategoryCardGridProps) {
  const { openSubmodulePanel } = usePanelStore();
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  // Sort categories in logical pipeline order (not alphabetical/load order)
  const CATEGORY_ORDER: Record<string, number> = {
    crawling: 1, news: 2, filtering: 3, scraping: 4, analysis: 5, planning: 6, generation: 7,
  };
  const categoryEntries = Object.entries(categories).sort(
    ([a], [b]) => (CATEGORY_ORDER[a] ?? 99) - (CATEGORY_ORDER[b] ?? 99)
  );

  if (categoryEntries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center">
        <p className="text-gray-400 text-sm">No submodules available for this step</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
      {categoryEntries.map(([catKey, submodules]) => {
        const isExpanded = expandedCategory === catKey;

        return (
          <div
            key={catKey}
            className={`rounded-lg border transition-all ${
              isExpanded
                ? 'border-dashed border-2 border-sky-400 bg-white'
                : 'border-gray-200 bg-white hover:border-gray-300'
            }`}
          >
            {/* Category Header */}
            <div
              className="p-3 cursor-pointer"
              onClick={() => setExpandedCategory(isExpanded ? null : catKey)}
            >
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-gray-800 capitalize">{catKey}</p>
              </div>
              <p className="text-[10px] text-gray-500 mt-1">
                {submodules.length} submodule{submodules.length !== 1 ? 's' : ''}
              </p>
            </div>

            {/* Inline Submodules (shown when expanded) */}
            {isExpanded && (
              <div className="border-t border-gray-200">
                <p className="text-[10px] text-gray-500 font-medium uppercase px-3 pt-2">
                  Submodules
                </p>
                <div className="p-2 space-y-1">
                  {submodules.map((sub) => {
                    const savedOp = configMap[sub.id]?.data_operation;
                    const currentOp = savedOp || sub.data_operation_default;

                    return (
                      <SubmoduleRow
                        key={sub.id}
                        submodule={sub}
                        categoryKey={catKey}
                        onOpen={openSubmodulePanel}
                        latestRun={latestRuns[sub.id]}
                        currentDataOp={currentOp}
                        onCycleDataOp={
                          onDataOperationChange
                            ? () => {
                                const idx = DATA_OP_OPTIONS.indexOf(currentOp as typeof DATA_OP_OPTIONS[number]);
                                const next = DATA_OP_OPTIONS[(idx + 1) % DATA_OP_OPTIONS.length];
                                onDataOperationChange(sub.id, next);
                              }
                            : undefined
                        }
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SubmoduleRow({
  submodule,
  categoryKey,
  onOpen,
  latestRun,
  currentDataOp,
  onCycleDataOp,
}: {
  submodule: SubmoduleManifest;
  categoryKey: string;
  onOpen: (submoduleId: string, categoryKey: string) => void;
  latestRun?: { status: string; result_count: number; approved_count: number; progress: { current: number; total: number; message: string } | null; error?: string | null };
  currentDataOp: string;
  onCycleDataOp?: () => void;
}) {
  const opIcon = DATA_OP_ICONS[currentDataOp] || '\uFF1D';
  const isActive = submodule.active !== false;

  return (
    <div
      className={`flex items-center justify-between p-2 rounded ${
        isActive
          ? 'hover:bg-gray-50 cursor-pointer group'
          : 'opacity-40 cursor-default'
      }`}
      onClick={isActive ? () => onOpen(submodule.id, categoryKey) : undefined}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="text-sm w-5 text-center hover:scale-125 transition-transform"
          title={`Data operation: ${currentDataOp} (click to change)`}
          onClick={(e) => {
            e.stopPropagation();
            if (isActive) onCycleDataOp?.();
          }}
          disabled={!isActive}
        >
          {opIcon}
        </button>
        <div>
          <p className="text-sm text-gray-700">{submodule.name}</p>
          <p className="text-[10px] text-gray-400">{submodule.description}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {isActive ? (
          <>
            <SubmoduleStatusBadge latestRun={latestRun} />
            <svg
              className="w-4 h-4 text-gray-400 opacity-50 group-hover:opacity-100"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </>
        ) : (
          <span className="text-[10px] text-gray-300 italic">inactive</span>
        )}
      </div>
    </div>
  );
}

function SubmoduleStatusBadge({ latestRun }: { latestRun?: { status: string; result_count: number; approved_count: number; progress: { current: number; total: number; message: string } | null; error?: string | null } }) {
  if (!latestRun) {
    return <span className="text-[10px] text-gray-300">idle</span>;
  }

  switch (latestRun.status) {
    case 'pending':
      return <span className="text-[10px] text-amber-400">queued</span>;
    case 'running':
      return (
        <span className="flex items-center gap-1 text-[10px] text-sky-500">
          <span className="inline-block w-3 h-3 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
          {latestRun.progress
            ? `${latestRun.progress.current}/${latestRun.progress.total}`
            : 'running'}
        </span>
      );
    case 'completed':
      return (
        <span className="text-[10px] font-medium text-amber-500">
          {latestRun.result_count} result{latestRun.result_count !== 1 ? 's' : ''}
        </span>
      );
    case 'approved':
      return (
        <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-500">
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
          {latestRun.approved_count}
        </span>
      );
    case 'failed': {
      const errMsg = latestRun.error ? (latestRun.error.length > 30 ? latestRun.error.slice(0, 30) + '…' : latestRun.error) : 'failed';
      return (
        <span className="flex items-center gap-1 text-[10px] font-medium text-red-500" title={latestRun.error || 'Execution failed'}>
          <svg className="w-3 h-3 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          {errMsg}
        </span>
      );
    }
    default:
      return <span className="text-[10px] text-gray-300">idle</span>;
  }
}
