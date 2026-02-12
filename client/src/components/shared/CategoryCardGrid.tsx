import { useState } from 'react';
import type { CategoryGroups, SubmoduleManifest } from '../../types/step';

const DATA_OP_ICONS: Record<string, string> = {
  add: '➕',
  remove: '➖',
  transform: '＝',
};

interface CategoryCardGridProps {
  categories: CategoryGroups;
  onSubmoduleClick?: (submodule: SubmoduleManifest) => void;
}

export function CategoryCardGrid({ categories, onSubmoduleClick }: CategoryCardGridProps) {
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  const categoryEntries = Object.entries(categories);

  if (categoryEntries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center">
        <p className="text-gray-400 text-sm">No submodules available for this step</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      {categoryEntries.map(([catKey, submodules]) => {
        const isExpanded = expandedCategory === catKey;

        return (
          <div
            key={catKey}
            className={`rounded-lg border transition-all ${
              isExpanded
                ? 'border-dashed border-2 border-sky-400 bg-white col-span-2 md:col-span-4'
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
                  {submodules.map((sub) => (
                    <SubmoduleRow
                      key={sub.id}
                      submodule={sub}
                      onClick={onSubmoduleClick}
                    />
                  ))}
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
  onClick,
}: {
  submodule: SubmoduleManifest;
  onClick?: (sub: SubmoduleManifest) => void;
}) {
  const opIcon = DATA_OP_ICONS[submodule.data_operation_default] || '＝';

  return (
    <div
      className="flex items-center justify-between p-2 rounded hover:bg-gray-50 cursor-pointer group"
      onClick={() => onClick?.(submodule)}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm w-5 text-center" title={submodule.data_operation_default}>
          {opIcon}
        </span>
        <div>
          <p className="text-sm text-gray-700">{submodule.name}</p>
          <p className="text-[10px] text-gray-400">{submodule.description}</p>
        </div>
      </div>
      {/* Status: idle (Phase 7+ populates real status) */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-gray-300">idle</span>
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
      </div>
    </div>
  );
}
