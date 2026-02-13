import { useEffect, useState, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePanelStore } from '../../stores/panelStore';
import { useStepContext } from '../../hooks/useStepContext';
import { useAppStore } from '../../stores/appStore';
import type { SubmoduleManifest, SubmoduleConfig } from '../../types/step';
import { CsvUploadInput, type UploadResult } from '../primitives/CsvUploadInput';
import { ContentRenderer } from '../primitives/ContentRenderer';
import { SubmoduleOptions } from '../primitives/SubmoduleOptions';

type AccordionVariant = 'blue' | 'teal' | 'pink';

const VARIANT_COLORS: Record<AccordionVariant, { bg: string; buttonBg: string; buttonText: string }> = {
  blue: { bg: 'bg-[#3B82F6]', buttonBg: 'bg-white', buttonText: 'text-[#3B82F6]' },
  teal: { bg: 'bg-[#0891B2]', buttonBg: 'bg-[#E11D73]', buttonText: 'text-white' },
  pink: { bg: 'bg-[#E11D73]', buttonBg: 'bg-white', buttonText: 'text-[#E11D73]' },
};

const DATA_OP_OPTIONS = ['add', 'remove', 'transform'] as const;
const DATA_OP_ICONS: Record<string, string> = { add: '\u2795', remove: '\u2796', transform: '\uFF1D' };
const DATA_OP_LABELS: Record<string, string> = { add: 'Add to pool', remove: 'Filter pool', transform: 'Transform pool' };

interface SubmodulePanelProps {
  stepName: string;
  submodule: SubmoduleManifest | null;
  runId: string | undefined;
  stepIndex: number;
  dataOperation: 'add' | 'remove' | 'transform';
  onDataOperationChange: (op: 'add' | 'remove' | 'transform') => void;
  savedConfig: SubmoduleConfig | undefined;
  onSaveConfig: (config: Partial<SubmoduleConfig>) => void;
}

function PanelAccordionItem({
  title,
  badge,
  isOpen,
  onToggle,
  variant,
  children,
}: {
  title: string;
  badge?: string;
  isOpen: boolean;
  onToggle: () => void;
  variant: AccordionVariant;
  children: React.ReactNode;
}) {
  const colors = VARIANT_COLORS[variant];

  return (
    <div
      className={`bg-white rounded-lg border border-gray-200 ${isOpen ? 'flex-1 flex flex-col min-h-0' : 'flex-shrink-0'}`}
    >
      <button
        onClick={onToggle}
        className={`w-full flex items-center justify-between px-4 py-3 ${colors.bg} text-white rounded-t-lg`}
      >
        <span className="font-semibold text-sm flex items-center gap-2">
          {title}
          {badge && (
            <span className="text-[10px] bg-white/20 px-2 py-0.5 rounded-full">{badge}</span>
          )}
        </span>
        <div
          className={`w-6 h-6 rounded-full ${colors.buttonBg} flex items-center justify-center`}
        >
          <span className={`${colors.buttonText} font-bold text-sm`}>
            {isOpen ? '\u2212' : '+'}
          </span>
        </div>
      </button>
      {isOpen && (
        <div className="p-4 flex-1 overflow-y-auto">{children}</div>
      )}
    </div>
  );
}

export function SubmodulePanel({
  stepName,
  submodule,
  runId,
  stepIndex,
  dataOperation,
  onDataOperationChange,
  savedConfig,
  onSaveConfig,
}: SubmodulePanelProps) {
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);
  const {
    submodulePanelOpen,
    panelAccordion,
    closeSubmodulePanel,
    setPanelAccordion,
  } = usePanelStore();

  // Step context (shared CSV data for this step)
  const { data: stepContext } = useStepContext(runId, stepIndex);

  // Local options state — initialized from savedConfig or manifest defaults
  const manifestDefaults = useMemo(() => {
    if (!submodule) return {};
    return submodule.options_defaults || {};
  }, [submodule]);

  const [localOptions, setLocalOptions] = useState<Record<string, unknown>>({});
  const [optionsDirty, setOptionsDirty] = useState(false);

  // Reset local options when submodule or savedConfig changes
  useEffect(() => {
    const base = { ...manifestDefaults };
    if (savedConfig?.options) {
      Object.assign(base, savedConfig.options);
    }
    setLocalOptions(base);
    setOptionsDirty(false);
  }, [submodule?.id, savedConfig?.options, manifestDefaults]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && submodulePanelOpen) {
        closeSubmodulePanel();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [submodulePanelOpen, closeSubmodulePanel]);

  if (!submodulePanelOpen || !submodule) return null;

  const submoduleName = submodule.name;
  const submoduleDescription = submodule.description;

  const cycleDataOp = () => {
    const idx = DATA_OP_OPTIONS.indexOf(dataOperation);
    const next = DATA_OP_OPTIONS[(idx + 1) % DATA_OP_OPTIONS.length];
    onDataOperationChange(next);
  };

  // --- Input logic ---
  const hasStepContext = !!stepContext?.entities && stepContext.entities.length > 0;
  const uploadUrl = `/api/runs/${runId}/steps/${stepIndex}/context`;

  const handleUploadComplete = (result: UploadResult) => {
    // Invalidate step context query to reload the preview
    queryClient.invalidateQueries({ queryKey: ['stepContext', runId, stepIndex] });
    showToast(`Uploaded ${result.filename}: ${result.entity_count} entities`, 'success');

    if (result.columns_missing.length > 0) {
      showToast(`Missing columns: ${result.columns_missing.join(', ')}`, 'error');
    }
  };

  const handleUploadError = (msg: string) => {
    showToast(msg, 'error');
  };

  // --- Options logic ---
  const handleOptionChange = (name: string, value: unknown) => {
    setLocalOptions((prev) => ({ ...prev, [name]: value }));
    setOptionsDirty(true);
  };

  const handleSaveOptions = () => {
    onSaveConfig({ options: localOptions as Record<string, unknown> });
    setOptionsDirty(false);
    showToast('Options saved', 'success');
  };

  // --- RUN TASK enablement ---
  const hasInput = hasStepContext;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 transition-opacity duration-300 opacity-100"
        onClick={closeSubmodulePanel}
      />

      {/* Panel — slides from left */}
      <div className="fixed inset-y-0 left-0 w-[672px] min-w-[672px] max-w-[672px] bg-gray-100 shadow-2xl flex flex-col transition-transform duration-300 translate-x-0">
        {/* Header */}
        <div className="bg-[#0891B2] text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
          <div>
            <h3 className="text-base font-semibold">
              {stepName} — {submoduleName}
            </h3>
          </div>
          <button
            onClick={closeSubmodulePanel}
            className="p-1 text-white/80 hover:text-white rounded hover:bg-white/10"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Description */}
        <p className="px-4 py-2 text-xs text-gray-500 bg-white border-b flex-shrink-0">
          {submoduleDescription}
        </p>

        {/* Data Operation Toggle */}
        <div className="px-4 py-2 bg-white border-b flex-shrink-0">
          <button
            onClick={cycleDataOp}
            className="flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900"
            title="Click to cycle data operation"
          >
            <span className="text-lg">{DATA_OP_ICONS[dataOperation]}</span>
            <span className="font-medium">{DATA_OP_LABELS[dataOperation]}</span>
            <span className="text-[10px] text-gray-400 ml-1">(click to change)</span>
          </button>
        </div>

        {/* Accordions */}
        <div className="flex-1 flex flex-col overflow-hidden p-3 gap-3">
          {/* --- INPUT ACCORDION --- */}
          <PanelAccordionItem
            title="Input"
            badge={hasStepContext ? `${stepContext!.entities.length} entities` : undefined}
            isOpen={panelAccordion === 'input'}
            onToggle={() => setPanelAccordion(panelAccordion === 'input' ? null : 'input')}
            variant="blue"
          >
            <div className="flex flex-col gap-3 h-full">
              {/* Shared context banner */}
              {hasStepContext && stepContext!.filename && (
                <div className="bg-blue-50 border border-blue-200 rounded p-2 text-xs text-blue-700 flex-shrink-0">
                  Shared step data: <span className="font-medium">{stepContext!.filename}</span>
                  {' \u2014 '}{stepContext!.entities.length} entities
                </div>
              )}

              {/* CSV upload zone */}
              <div className="flex-shrink-0">
                <CsvUploadInput
                  uploadUrl={uploadUrl}
                  submoduleId={submodule.id}
                  onUploadComplete={handleUploadComplete}
                  onError={handleUploadError}
                  currentFileName={stepContext?.filename || null}
                  currentEntityCount={stepContext?.entities?.length || 0}
                  requiredColumns={submodule.requires_columns || []}
                />
              </div>

              {/* Content preview (ContentRenderer) — fills remaining space */}
              {hasStepContext && (
                <div className="flex-1 min-h-0">
                  <ContentRenderer
                    entities={stepContext!.entities}
                    fullHeight
                    label={`${stepContext!.entities.length} entities \u00d7 ${Object.keys(stepContext!.entities[0] || {}).length} columns`}
                  />
                </div>
              )}
            </div>
          </PanelAccordionItem>

          {/* --- OPTIONS ACCORDION --- */}
          <PanelAccordionItem
            title="Options"
            badge={optionsDirty ? 'unsaved' : undefined}
            isOpen={panelAccordion === 'options'}
            onToggle={() => setPanelAccordion(panelAccordion === 'options' ? null : 'options')}
            variant="teal"
          >
            <div className="space-y-4">
              <SubmoduleOptions
                options={submodule.options || []}
                values={localOptions}
                onChange={handleOptionChange}
              />

              {/* Save Options button */}
              <button
                onClick={handleSaveOptions}
                disabled={!optionsDirty}
                className={`w-full py-2 rounded text-sm font-medium transition-colors ${
                  optionsDirty
                    ? 'bg-[#0891B2] text-white hover:bg-[#0891B2]/90'
                    : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                }`}
              >
                {optionsDirty ? 'SAVE OPTIONS' : 'Options saved'}
              </button>
            </div>
          </PanelAccordionItem>

          {/* --- RESULTS ACCORDION (Phase 7 placeholder) --- */}
          <PanelAccordionItem
            title="Results"
            isOpen={panelAccordion === 'results'}
            onToggle={() => setPanelAccordion(panelAccordion === 'results' ? null : 'results')}
            variant="pink"
          >
            <p className="text-sm text-gray-400">No results yet. Configure input and click RUN TASK.</p>
          </PanelAccordionItem>
        </div>

        {/* CTA Footer */}
        <div className="border-t border-gray-200 px-4 py-3 bg-white flex-shrink-0">
          <div className="flex items-center justify-center gap-3">
            <button
              disabled={!hasInput}
              className={`px-8 py-3 rounded text-sm font-medium transition-colors ${
                hasInput
                  ? 'bg-[#3B82F6] text-white hover:bg-[#3B82F6]/90'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              }`}
            >
              RUN TASK
            </button>
            <button
              disabled
              className="px-8 py-3 rounded text-sm font-medium bg-gray-100 text-gray-400 cursor-not-allowed"
            >
              SEE RESULTS
            </button>
            <button
              disabled
              className="px-8 py-3 rounded text-sm font-medium bg-gray-100 text-gray-400 cursor-not-allowed"
            >
              APPROVE
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
