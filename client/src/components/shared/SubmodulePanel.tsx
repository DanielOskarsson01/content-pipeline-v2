import { useEffect, useState, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePanelStore } from '../../stores/panelStore';
import { useStepContext } from '../../hooks/useStepContext';
import { useSubmoduleRun, useExecuteSubmodule, useApproveSubmoduleRun, useLatestSubmoduleRuns } from '../../hooks/useSubmoduleRuns';
import { useAppStore } from '../../stores/appStore';
import type { SubmoduleManifest, SubmoduleConfig } from '../../types/step';
import { CsvUploadInput, type UploadResult } from '../primitives/CsvUploadInput';
import { ContentRenderer, type RenderSchema } from '../primitives/ContentRenderer';
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
    activeSubmoduleRunId,
    closeSubmodulePanel,
    setPanelAccordion,
    setActiveSubmoduleRunId,
  } = usePanelStore();

  // Step context (shared CSV data for this step)
  const { data: stepContext } = useStepContext(runId, stepIndex);

  // Latest submodule runs — to auto-load previous run on panel open
  const { data: latestRuns } = useLatestSubmoduleRuns(runId, stepIndex);

  // Auto-set activeSubmoduleRunId when opening a panel for a submodule with a previous run
  useEffect(() => {
    if (!submodulePanelOpen || !submodule || !latestRuns) return;
    const latest = latestRuns[submodule.id];
    if (latest && !activeSubmoduleRunId) {
      setActiveSubmoduleRunId(latest.id);
    }
  }, [submodulePanelOpen, submodule?.id, latestRuns, activeSubmoduleRunId, setActiveSubmoduleRunId]);

  // Clear activeSubmoduleRunId when switching submodules
  useEffect(() => {
    setActiveSubmoduleRunId(null);
  }, [submodule?.id, setActiveSubmoduleRunId]);

  // Poll active submodule run — only poll while panel is open
  const { data: submoduleRun } = useSubmoduleRun(activeSubmoduleRunId, submodulePanelOpen);

  // Execution mutation
  const executeMutation = useExecuteSubmodule();
  const approveMutation = useApproveSubmoduleRun();

  // --- Render schema and selectable flag ---
  const renderSchema = submoduleRun?.output_render_schema as RenderSchema | null;
  const isSelectable = renderSchema?.selectable === true;

  // --- Flatten results into a single list of items with entity_name ---
  const flatItems = useMemo(() => {
    if (!submoduleRun?.output_data?.results) return [];
    const items: Array<Record<string, unknown> & { entity_name: string }> = [];
    for (const entityResult of submoduleRun.output_data.results) {
      for (const item of entityResult.items || []) {
        items.push({ ...item, entity_name: entityResult.entity_name });
      }
    }
    return items;
  }, [submoduleRun?.output_data]);

  const itemKey = submodule?.item_key || 'url';

  // --- Checked items state (only used when selectable) ---
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set());

  // Initialize checked keys when results arrive — only for selectable mode
  useEffect(() => {
    if (flatItems.length === 0 || !isSelectable) return;

    if (submoduleRun?.status === 'approved' && submoduleRun.approved_items) {
      // Re-approval: restore previous checkbox state
      setCheckedKeys(new Set(submoduleRun.approved_items));
    } else if (submoduleRun?.status === 'completed') {
      // Fresh completion: all checked by default
      const allKeys = flatItems.map((item) => String(item[itemKey] ?? '')).filter(Boolean);
      setCheckedKeys(new Set(allKeys));
    }
  }, [flatItems, submoduleRun?.status, submoduleRun?.approved_items, itemKey, isSelectable]);

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

  // Show toast when background job completes
  useEffect(() => {
    if (!submoduleRun || !submodule) return;
    if (submoduleRun.status === 'completed' && submoduleRun.output_data) {
      const count = submoduleRun.output_data.summary?.total_items ?? 0;
      if (!submodulePanelOpen) {
        showToast(`${submodule.name} completed \u2014 ${count} results`, 'success');
      }
    }
    if (submoduleRun.status === 'failed') {
      showToast(`${submodule.name} failed: ${submoduleRun.error || 'Unknown error'}`, 'error');
    }
  }, [submoduleRun?.status]);

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

  // --- Execution state ---
  const hasInput = hasStepContext || stepIndex > 0;
  const isRunning = submoduleRun?.status === 'pending' || submoduleRun?.status === 'running';
  const isCompleted = submoduleRun?.status === 'completed' || submoduleRun?.status === 'approved';

  // --- CTA handlers ---
  const handleRunTask = () => {
    if (!runId || !submodule) return;
    executeMutation.mutate(
      { runId, stepIndex, submoduleId: submodule.id },
      {
        onSuccess: (data) => {
          setActiveSubmoduleRunId(data.submodule_run_id);
          setPanelAccordion('results');
        },
      }
    );
  };

  const handleSeeResults = () => {
    setPanelAccordion('results');
  };

  const handleApprove = () => {
    if (!activeSubmoduleRunId) return;

    let approvedKeys: string[];
    if (isSelectable) {
      // Selectable: send only checked keys
      approvedKeys = Array.from(checkedKeys);
    } else {
      // Non-selectable: approve ALL items
      approvedKeys = flatItems.map((item) => String(item[itemKey] ?? '')).filter(Boolean);
    }

    approveMutation.mutate(
      { submoduleRunId: activeSubmoduleRunId, approvedItemKeys: approvedKeys },
      {
        onSuccess: () => {
          closeSubmodulePanel();
          queryClient.invalidateQueries({ queryKey: ['latestSubmoduleRuns'] });
        },
      }
    );
  };

  // --- Results badge ---
  const resultsBadge = isRunning
    ? 'running'
    : isCompleted
      ? isSelectable
        ? `${checkedKeys.size}/${flatItems.length}`
        : `${flatItems.length} items`
      : undefined;

  // --- Results summary label ---
  const summary = submoduleRun?.output_data?.summary;
  const resultsLabel = summary
    ? `${summary.total_items} items across ${summary.total_entities} entities`
    : undefined;

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
              {hasStepContext && stepContext!.filename && (
                <div className="bg-blue-50 border border-blue-200 rounded p-2 text-xs text-blue-700 flex-shrink-0">
                  Shared step data: <span className="font-medium">{stepContext!.filename}</span>
                  {' \u2014 '}{stepContext!.entities.length} entities
                </div>
              )}

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

          {/* --- RESULTS ACCORDION (pass-through via ContentRenderer) --- */}
          <PanelAccordionItem
            title="Results"
            badge={resultsBadge}
            isOpen={panelAccordion === 'results'}
            onToggle={() => setPanelAccordion(panelAccordion === 'results' ? null : 'results')}
            variant="pink"
          >
            <ResultsContent
              submoduleRun={submoduleRun ?? null}
              flatItems={flatItems}
              renderSchema={renderSchema}
              itemKey={itemKey}
              dataOperation={dataOperation}
              checkedKeys={checkedKeys}
              onCheckedKeysChange={isSelectable ? setCheckedKeys : undefined}
              summary={summary}
              resultsLabel={resultsLabel}
            />
          </PanelAccordionItem>
        </div>

        {/* CTA Footer */}
        <div className="border-t border-gray-200 px-4 py-3 bg-white flex-shrink-0">
          <div className="flex items-center justify-center gap-3">
            {/* RUN TASK */}
            <button
              disabled={!hasInput || isRunning}
              onClick={handleRunTask}
              className={`px-8 py-3 rounded text-sm font-medium transition-colors ${
                hasInput && !isRunning
                  ? 'bg-[#E11D73] text-white hover:bg-[#E11D73]/90'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              }`}
            >
              {isRunning ? 'RUNNING...' : 'RUN TASK'}
            </button>

            {/* SEE RESULTS */}
            <button
              disabled={!isCompleted}
              onClick={handleSeeResults}
              className={`px-8 py-3 rounded text-sm font-medium transition-colors ${
                isCompleted
                  ? 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              }`}
            >
              SEE RESULTS
            </button>

            {/* APPROVE */}
            <button
              disabled={!isCompleted || approveMutation.isPending}
              onClick={handleApprove}
              className={`px-8 py-3 rounded text-sm font-medium transition-colors ${
                isCompleted && !approveMutation.isPending
                  ? 'bg-green-600 text-white hover:bg-green-700'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              }`}
            >
              {approveMutation.isPending ? 'APPROVING...' : 'APPROVE'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


// --- Results Content (skeleton container + ContentRenderer pass-through) ---

function ResultsContent({
  submoduleRun,
  flatItems,
  renderSchema,
  itemKey,
  dataOperation,
  checkedKeys,
  onCheckedKeysChange,
  summary,
  resultsLabel,
}: {
  submoduleRun: { status: string; progress: { current: number; total: number; message: string } | null; error: string | null } | null;
  flatItems: Array<Record<string, unknown> & { entity_name: string }>;
  renderSchema: RenderSchema | null;
  itemKey: string;
  dataOperation: string;
  checkedKeys: Set<string>;
  onCheckedKeysChange?: (keys: Set<string>) => void;
  summary: { total_entities: number; total_items: number; errors: string[] } | undefined;
  resultsLabel: string | undefined;
}) {
  // No run yet
  if (!submoduleRun) {
    return <p className="text-sm text-gray-400">No results yet. Configure input and click RUN TASK.</p>;
  }

  // Pending
  if (submoduleRun.status === 'pending') {
    return (
      <div className="flex items-center gap-3 py-4">
        <Spinner />
        <p className="text-sm text-gray-500">Waiting to start...</p>
      </div>
    );
  }

  // Running — show progress
  if (submoduleRun.status === 'running') {
    const progress = submoduleRun.progress;
    const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

    return (
      <div className="space-y-3 py-2">
        <div className="flex items-center gap-3">
          <Spinner />
          <p className="text-sm text-gray-700">
            {progress?.message || 'Processing...'}
          </p>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-[#E11D73] h-2 rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-gray-500 text-right">
          {progress ? `${progress.current}/${progress.total}` : ''} {pct}%
        </p>
      </div>
    );
  }

  // Failed
  if (submoduleRun.status === 'failed') {
    return (
      <div className="bg-red-50 border border-red-200 rounded p-3">
        <p className="text-sm text-red-700 font-medium">Execution failed</p>
        <p className="text-xs text-red-600 mt-1">{submoduleRun.error || 'Unknown error'}</p>
      </div>
    );
  }

  // Completed or Approved — pass-through to ContentRenderer
  if (flatItems.length === 0) {
    return <p className="text-sm text-gray-400">No results returned.</p>;
  }

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* Summary */}
      {summary && (
        <div className="flex-shrink-0 text-xs text-gray-600">
          {resultsLabel}
          {summary.errors.length > 0 && (
            <span className="text-red-500 ml-2">{summary.errors.length} errors</span>
          )}
        </div>
      )}

      {/* ContentRenderer — drives all rendering from render_schema */}
      <div className="flex-1 min-h-0">
        <ContentRenderer
          entities={flatItems}
          renderSchema={renderSchema}
          itemKey={itemKey}
          dataOperation={dataOperation}
          checkedKeys={checkedKeys}
          onCheckedKeysChange={onCheckedKeysChange}
          fullHeight
        />
      </div>
    </div>
  );
}


// --- Spinner ---

function Spinner() {
  return (
    <svg className="animate-spin w-5 h-5 text-[#E11D73]" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
