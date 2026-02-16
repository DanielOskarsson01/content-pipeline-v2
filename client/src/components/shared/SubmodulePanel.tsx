import { useEffect, useState, useMemo, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePanelStore } from '../../stores/panelStore';
import { useStepContext } from '../../hooks/useStepContext';
import { useSubmoduleRun, useExecuteSubmodule, useApproveSubmoduleRun, useLatestSubmoduleRuns } from '../../hooks/useSubmoduleRuns';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../api/client';
import type { SubmoduleManifest, SubmoduleConfig } from '../../types/step';
import { CsvUploadInput, type UploadResult } from '../primitives/CsvUploadInput';
import { ContentRenderer, type RenderSchema } from '../primitives/ContentRenderer';
import { SubmoduleOptions } from '../primitives/SubmoduleOptions';
import { UrlTextarea, parseTextareaToEntities } from '../primitives/UrlTextarea';

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
  onSaveConfig: (config: Partial<SubmoduleConfig>) => Promise<unknown>;
  previousStepData: Record<string, unknown>[] | null;
  previousStepRenderSchema: Record<string, unknown> | null;
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
  previousStepData,
  previousStepRenderSchema,
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
    if (!isSelectable) return;
    if (flatItems.length === 0) {
      setCheckedKeys(new Set());
      return;
    }

    if (submoduleRun?.status === 'approved' && submoduleRun.approved_items) {
      setCheckedKeys(new Set(submoduleRun.approved_items));
    } else if (submoduleRun?.status === 'completed') {
      const allKeys = flatItems.map((item) => String(item[itemKey] ?? '')).filter(Boolean);
      setCheckedKeys(new Set(allKeys));
    }
  }, [flatItems, submoduleRun?.status, submoduleRun?.approved_items, itemKey, isSelectable]);

  // --- Textarea state (for manual URL/data entry) ---
  const [textareaValue, setTextareaValue] = useState('');
  // Track which input source is active: 'textarea' | 'csv' | null
  const [inputSource, setInputSource] = useState<'textarea' | 'csv' | null>(null);
  const [inputDirty, setInputDirty] = useState(false);

  // Reset input state when switching submodules
  useEffect(() => {
    setTextareaValue('');
    setInputSource(null);
    setInputDirty(false);
  }, [submodule?.id]);

  // Textarea parsed entities
  const primaryColumn = submodule?.requires_columns?.[0] || 'url';
  const textareaEntities = useMemo(
    () => (textareaValue.trim() ? parseTextareaToEntities(textareaValue, primaryColumn) : []),
    [textareaValue, primaryColumn]
  );

  // Determine which entities to show in content preview
  const hasStepContext = !!stepContext?.entities && stepContext.entities.length > 0;
  const hasPreviousStepData = !!previousStepData && previousStepData.length > 0;
  const previewEntities = inputSource === 'textarea'
    ? textareaEntities
    : hasStepContext
      ? stepContext!.entities
      : hasPreviousStepData
        ? previousStepData!
        : [];
  const hasPreviewData = previewEntities.length > 0;
  // Track whether we're showing previous step data (for render schema and label)
  const showingPreviousStepData = !inputSource && !hasStepContext && hasPreviousStepData;

  // Mutual exclusion handlers
  const handleTextareaChange = useCallback((value: string) => {
    setTextareaValue(value);
    setInputSource(value.trim() ? 'textarea' : null);
    setInputDirty(true);
  }, []);

  const handleUploadComplete = useCallback((result: UploadResult) => {
    queryClient.invalidateQueries({ queryKey: ['stepContext', runId, stepIndex] });
    setTextareaValue(''); // Mutual exclusion: CSV clears textarea
    setInputSource('csv');
    setInputDirty(true);
    showToast(`Uploaded ${result.filename}: ${result.entity_count} entities`, 'success');
    if (result.columns_missing.length > 0) {
      showToast(`Missing columns: ${result.columns_missing.join(', ')}`, 'error');
    }
  }, [queryClient, runId, stepIndex, showToast]);

  const handleUploadError = (msg: string) => {
    showToast(msg, 'error');
  };

  // Download template handler — generates CSV with column headers from requires_columns
  const handleDownloadTemplate = () => {
    if (!submodule) return;
    const cols = submodule.requires_columns.length > 0
      ? submodule.requires_columns
      : ['url'];
    const csv = cols.map((c) => `"${c}"`).join(',') + '\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${submodule.id}-template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // SAVE INPUT handler
  const handleSaveInput = () => {
    if (inputSource === 'textarea') {
      onSaveConfig({ input_config: { source: 'textarea', raw_text: textareaValue, entities: textareaEntities } });
    } else if (inputSource === 'csv') {
      onSaveConfig({ input_config: { source: 'csv', filename: stepContext?.filename || null } });
    }
    setInputDirty(false);
    showToast('Input saved', 'success');
    // Guided flow: collapse Input, open Options
    setPanelAccordion('options');
  };

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

  const uploadUrl = `/api/runs/${runId}/steps/${stepIndex}/context`;

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
  // hasInput: content preview has data from ANY source (textarea, CSV, step context, or previous step)
  const hasInput = hasPreviewData || stepIndex > 0;
  const isRunning = submoduleRun?.status === 'pending' || submoduleRun?.status === 'running';
  const isCompleted = submoduleRun?.status === 'completed' || submoduleRun?.status === 'approved';

  // --- CTA handlers ---

  // Auto-save dirty input before executing — ensures server has the data
  const saveInputIfDirty = async () => {
    if (!inputDirty || !inputSource || !runId || !submodule) return;
    if (inputSource === 'textarea') {
      await api.saveSubmoduleConfig(runId, stepIndex, submodule.id, {
        input_config: { source: 'textarea', raw_text: textareaValue, entities: textareaEntities },
      });
    } else if (inputSource === 'csv') {
      await api.saveSubmoduleConfig(runId, stepIndex, submodule.id, {
        input_config: { source: 'csv', filename: stepContext?.filename || null },
      });
    }
    setInputDirty(false);
  };

  const handleRunTask = async () => {
    if (!runId || !submodule) return;

    // Resolve entities to send directly in the request body (no DB roundtrip needed)
    let entitiesToSend: Record<string, unknown>[] | undefined;
    if (inputSource === 'textarea' && textareaEntities.length > 0) {
      entitiesToSend = textareaEntities;
    } else if (hasPreviewData) {
      entitiesToSend = previewEntities;
    }

    // Also persist the input config for future runs (fire-and-forget)
    saveInputIfDirty().catch(() => { /* non-critical */ });

    executeMutation.mutate(
      { runId, stepIndex, submoduleId: submodule.id, entities: entitiesToSend },
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
      approvedKeys = Array.from(checkedKeys);
    } else {
      approvedKeys = flatItems.map((item) => String(item[itemKey] ?? '')).filter(Boolean);
    }

    approveMutation.mutate(
      { submoduleRunId: activeSubmoduleRunId, approvedItemKeys: approvedKeys, runId: runId!, stepIndex },
      {
        onSuccess: () => {
          closeSubmodulePanel();
          queryClient.invalidateQueries({ queryKey: ['latestSubmoduleRuns', runId, stepIndex] });
        },
      }
    );
  };

  // NEXT button handler — awaits save before running (R001 fix: prevents worker reading stale options)
  const handleNext = async () => {
    if (optionsDirty) {
      await onSaveConfig({ options: localOptions as Record<string, unknown> });
      setOptionsDirty(false);
    }
    handleRunTask();
  };

  // Results action CTAs
  const handleChangeInput = () => setPanelAccordion('input');
  const handleChangeOptions = () => setPanelAccordion('options');
  const handleTryAgain = () => {
    setActiveSubmoduleRunId(null);
    setPanelAccordion('input');
  };

  // --- Input badge ---
  const inputBadge = hasPreviewData
    ? showingPreviousStepData
      ? `${previewEntities.length} from previous step`
      : `${previewEntities.length} entities`
    : stepIndex > 0
      ? 'From previous step'
      : undefined;

  // --- Results badge ---
  const summary = submoduleRun?.output_data?.summary;

  const resultsBadge = isRunning
    ? 'running'
    : isCompleted
      ? isSelectable
        ? `${checkedKeys.size}/${flatItems.length}`
        : `${flatItems.length} items`
      : undefined;

  // --- Results summary label — submodule-authored, skeleton just renders it ---
  const resultsLabel = summary?.description
    || (summary ? `${summary.total_items} items across ${summary.total_entities} entities` : undefined);

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
            badge={inputBadge}
            isOpen={panelAccordion === 'input'}
            onToggle={() => setPanelAccordion(panelAccordion === 'input' ? null : 'input')}
            variant="blue"
          >
            <div className="flex flex-col gap-3 h-full">
              {/* UrlTextarea */}
              <div className="flex-shrink-0">
                <UrlTextarea
                  value={textareaValue}
                  onChange={handleTextareaChange}
                />
              </div>

              {/* "or" divider */}
              <div className="flex items-center gap-3 flex-shrink-0">
                <div className="flex-1 border-t border-gray-200" />
                <span className="text-xs text-gray-400">or</span>
                <div className="flex-1 border-t border-gray-200" />
              </div>

              {/* CsvUploadInput */}
              <div className="flex-shrink-0">
                <CsvUploadInput
                  uploadUrl={uploadUrl}
                  submoduleId={submodule.id}
                  onUploadComplete={handleUploadComplete}
                  onError={handleUploadError}
                  currentFileName={inputSource === 'csv' ? (stepContext?.filename || null) : null}
                  currentEntityCount={inputSource === 'csv' ? (stepContext?.entities?.length || 0) : 0}
                  requiredColumns={submodule.requires_columns || []}
                />
              </div>

              {/* Download template link */}
              {submodule.requires_columns.length > 0 && (
                <button
                  onClick={handleDownloadTemplate}
                  className="text-xs text-[#3B82F6] hover:text-[#3B82F6]/80 flex items-center gap-1 flex-shrink-0"
                >
                  <span>{'\u2B07'}</span> Download template
                </button>
              )}

              {/* Content preview — shows textarea, CSV, or previous step data */}
              {hasPreviewData && (
                <div className="flex-1 min-h-0">
                  {showingPreviousStepData && (
                    <p className="text-xs text-blue-600 font-medium mb-1">Input from previous step — override by entering data above</p>
                  )}
                  <ContentRenderer
                    entities={previewEntities}
                    renderSchema={showingPreviousStepData ? previousStepRenderSchema as RenderSchema | undefined : undefined}
                    fullHeight
                    label={`${previewEntities.length} items \u00d7 ${Object.keys(previewEntities[0] || {}).length} columns`}
                  />
                </div>
              )}

              {!hasPreviewData && stepIndex > 0 && (
                <div className="bg-blue-50 rounded border border-blue-200 p-3 flex-shrink-0">
                  <p className="text-xs text-blue-700 font-medium">No input data available</p>
                  <p className="text-xs text-blue-500 mt-1">Previous step has no output yet. Complete and approve the previous step, or upload data above.</p>
                </div>
              )}

              {!hasPreviewData && stepIndex === 0 && (
                <div className="text-center py-4 flex-shrink-0">
                  <p className="text-xs text-gray-400">No input data. Upload a file or enter data above.</p>
                </div>
              )}

              {/* SAVE INPUT button */}
              <button
                onClick={handleSaveInput}
                disabled={!inputDirty}
                className={`w-full py-2 rounded text-sm font-medium transition-colors flex-shrink-0 ${
                  inputDirty
                    ? 'bg-[#3B82F6] text-white hover:bg-[#3B82F6]/90'
                    : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                }`}
              >
                {inputDirty ? 'Save Input' : 'Save Input (no changes)'}
              </button>
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

              {/* SAVE OPTIONS button */}
              <button
                onClick={handleSaveOptions}
                disabled={!optionsDirty}
                className={`w-full py-2 rounded text-sm font-medium transition-colors ${
                  optionsDirty
                    ? 'bg-[#0891B2] text-white hover:bg-[#0891B2]/90'
                    : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                }`}
              >
                {optionsDirty ? 'Save Options' : 'Save Options (no changes)'}
              </button>

              {/* NEXT button */}
              <button
                onClick={handleNext}
                disabled={!hasInput || isRunning}
                className={`w-full py-2 rounded text-sm font-medium transition-colors ${
                  hasInput && !isRunning
                    ? 'bg-[#E11D73] text-white hover:bg-[#E11D73]/90'
                    : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                }`}
              >
                {isRunning ? 'Running...' : 'Next \u2192'}
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
              onChangeInput={handleChangeInput}
              onChangeOptions={handleChangeOptions}
              onTryAgain={handleTryAgain}
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
  onChangeInput,
  onChangeOptions,
  onTryAgain,
}: {
  submoduleRun: { status: string; progress: { current: number; total: number; message: string } | null; error: string | null } | null;
  flatItems: Array<Record<string, unknown> & { entity_name: string }>;
  renderSchema: RenderSchema | null;
  itemKey: string;
  dataOperation: string;
  checkedKeys: Set<string>;
  onCheckedKeysChange?: (keys: Set<string>) => void;
  summary: { total_entities: number; total_items: number; errors: string[]; description?: string; [key: string]: unknown } | undefined;
  resultsLabel: string | undefined;
  onChangeInput: () => void;
  onChangeOptions: () => void;
  onTryAgain: () => void;
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
      <div className="space-y-3">
        <div className="bg-red-50 border border-red-200 rounded p-3">
          <p className="text-sm text-red-700 font-medium">Execution failed</p>
          <p className="text-xs text-red-600 mt-1">{submoduleRun.error || 'Unknown error'}</p>
        </div>
        <ResultsActionCTAs onChangeInput={onChangeInput} onChangeOptions={onChangeOptions} onTryAgain={onTryAgain} />
      </div>
    );
  }

  // Completed or Approved — pass-through to ContentRenderer
  if (flatItems.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-400">No results returned.</p>
        <ResultsActionCTAs onChangeInput={onChangeInput} onChangeOptions={onChangeOptions} onTryAgain={onTryAgain} />
      </div>
    );
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

      {/* Action CTAs */}
      <ResultsActionCTAs
        onChangeInput={onChangeInput}
        onChangeOptions={onChangeOptions}
        onTryAgain={onTryAgain}
        showDownload
        entities={flatItems}
        renderSchema={renderSchema}
      />
    </div>
  );
}


// --- Results Action CTAs ---

function ResultsActionCTAs({
  onChangeInput,
  onChangeOptions,
  onTryAgain,
  showDownload,
  entities,
  renderSchema,
}: {
  onChangeInput: () => void;
  onChangeOptions: () => void;
  onTryAgain: () => void;
  showDownload?: boolean;
  entities?: Record<string, unknown>[];
  renderSchema?: RenderSchema | null;
}) {
  const handleDownload = () => {
    if (!entities || entities.length === 0) return;
    const metaFields = new Set(['display_type', 'selectable']);
    const columns = renderSchema
      ? Object.keys(renderSchema).filter((k) => !metaFields.has(k))
      : Object.keys(entities[0]);
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
    a.download = `results-${entities.length}-rows.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex items-center gap-2 flex-shrink-0 pt-2 border-t border-gray-100">
      <button
        onClick={onChangeInput}
        className="text-xs text-[#3B82F6] hover:underline"
      >
        Change Input
      </button>
      <button
        onClick={onChangeOptions}
        className="text-xs text-[#0891B2] hover:underline"
      >
        Change Options
      </button>
      {showDownload && (
        <button
          onClick={handleDownload}
          className="text-xs text-gray-500 hover:underline"
        >
          Download
        </button>
      )}
      <button
        onClick={onTryAgain}
        className="text-xs text-[#E11D73] hover:underline ml-auto"
      >
        Try again
      </button>
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
