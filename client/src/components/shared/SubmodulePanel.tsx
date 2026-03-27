import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import JSZip from 'jszip';
import { usePanelStore } from '../../stores/panelStore';
import { useStepContext } from '../../hooks/useStepContext';
import { useSubmoduleRun, useSubmoduleRunFull, useExecuteSubmodule, useApproveSubmoduleRun, useApproveSubmoduleRunPerEntity, useLatestSubmoduleRuns, useEntityRunDetail } from '../../hooks/useSubmoduleRuns';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../api/client';
import type { SubmoduleManifest, SubmoduleConfig, DownloadableField, SubmoduleRun, SubmoduleRunBatch, EntityRunStatus } from '../../types/step';
import { isPerEntityRun } from '../../types/step';
import { CsvUploadInput, type UploadResult } from '../primitives/CsvUploadInput';
import { ContentRenderer, type RenderSchema } from '../primitives/ContentRenderer';
import { SubmoduleOptions } from '../primitives/SubmoduleOptions';
import { UrlTextarea, parseTextareaToEntities } from '../primitives/UrlTextarea';
import { sanitizeFilename } from '../../utils/sanitize';

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
  projectId: string;
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
  projectId,
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
  const approvePerEntityMutation = useApproveSubmoduleRunPerEntity();

  // Per-entity mode detection
  const perEntityMode = submoduleRun ? isPerEntityRun(submoduleRun) : false;
  // Type-narrow for legacy code paths
  const legacyRun = (!perEntityMode ? submoduleRun : null) as (SubmoduleRun | null);
  const batchRun = (perEntityMode ? submoduleRun : null) as (SubmoduleRunBatch | null);

  // Per-entity checked keys: Map<entityName, Set<itemKey>>
  // Unexpanded entities are NOT in this map — approval sends '__all__' sentinel for them
  const [entityCheckedKeys, setEntityCheckedKeys] = useState<Map<string, Set<string>>>(new Map());

  // Reset entity checked keys when switching submodules
  useEffect(() => {
    setEntityCheckedKeys(new Map());
  }, [submodule?.id]);

  // --- Render schema and selectable flag ---
  const renderSchema = submoduleRun?.output_render_schema as RenderSchema | null;
  const isSelectable = renderSchema?.selectable === true;

  // --- Flatten results into a single list of items with entity_name (LEGACY ONLY) ---
  const flatItems = useMemo(() => {
    if (perEntityMode || !legacyRun?.output_data?.results) return [];
    const items: Array<Record<string, unknown> & { entity_name: string }> = [];
    for (const entityResult of legacyRun.output_data.results) {
      for (const item of entityResult.items || []) {
        items.push({ ...item, entity_name: entityResult.entity_name });
      }
    }
    return items;
  }, [legacyRun?.output_data, perEntityMode]);

  const itemKey = submodule?.item_key || 'url';

  // --- Full data fetching for detail modal + download ---
  // Only triggered on demand (detail modal open or download click).
  // Fetches unstripped output_data including downloadable fields (e.g. text_content).
  const hasDownloadableFields = !!(renderSchema?.downloadable_fields as unknown[])?.length;
  const [fullDataRequested, setFullDataRequested] = useState(false);
  const { data: fullSubmoduleRun } = useSubmoduleRunFull(
    activeSubmoduleRunId,
    fullDataRequested && hasDownloadableFields
  );

  // Reset full data request when switching submodules
  useEffect(() => { setFullDataRequested(false); }, [submodule?.id]);

  // Merge full data into flatItems when available
  const mergedFlatItems = useMemo(() => {
    if (!fullSubmoduleRun?.output_data?.results || flatItems.length === 0) return flatItems;
    const fullMap = new Map<string, Record<string, unknown>>();
    for (const entityResult of fullSubmoduleRun.output_data.results) {
      for (const item of entityResult.items || []) {
        fullMap.set(String(item[itemKey] ?? ''), item);
      }
    }
    return flatItems.map(item => {
      const fullItem = fullMap.get(String(item[itemKey] ?? ''));
      return fullItem ? { ...item, ...fullItem } : item;
    });
  }, [flatItems, fullSubmoduleRun?.output_data, itemKey]);

  // Callback for ContentRenderer to request full data (detail modal open)
  const handleRequestFullData = useCallback(() => {
    if (hasDownloadableFields) setFullDataRequested(true);
  }, [hasDownloadableFields]);

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
      // Pre-deselect flagged items using manifest-declared flagged_when rules
      const flaggedWhen = renderSchema?.flagged_when;
      const selectedKeys = flatItems
        .filter((item) => {
          if (!flaggedWhen) return true;
          return !Object.entries(flaggedWhen).some(
            ([field, values]) => values.includes(String(item[field] ?? ''))
          );
        })
        .map((item) => String(item[itemKey] ?? ''))
        .filter(Boolean);
      setCheckedKeys(new Set(selectedKeys));
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
      // Textarea entities are also saved to step_context server-side — refresh so siblings see them
      queryClient.invalidateQueries({ queryKey: ['stepContext', runId, stepIndex] });
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
    if (submoduleRun.status === 'completed') {
      if (perEntityMode && batchRun) {
        if (!submodulePanelOpen) {
          showToast(`${submodule.name} completed \u2014 ${batchRun.entity_count} entities`, 'success');
        }
      } else if (legacyRun?.output_data) {
        const count = legacyRun.output_data.summary?.total_items ?? 0;
        if (!submodulePanelOpen) {
          showToast(`${submodule.name} completed \u2014 ${count} results`, 'success');
        }
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
      // Textarea entities are also saved to step_context server-side — refresh so siblings see them
      queryClient.invalidateQueries({ queryKey: ['stepContext', runId, stepIndex] });
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
      { runId, stepIndex, submoduleId: submodule.id, entities: entitiesToSend, fromPreviousStep: showingPreviousStepData },
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

    // Per-entity approval: build entity_approvals map
    if (perEntityMode && batchRun) {
      const entityApprovals: Record<string, string[] | string> = {};
      for (const entity of batchRun.entities) {
        const checked = entityCheckedKeys.get(entity.entity_name);
        if (checked) {
          // User expanded and possibly modified selection
          entityApprovals[entity.entity_name] = Array.from(checked);
        } else {
          // Never expanded — approve all via sentinel
          entityApprovals[entity.entity_name] = '__all__';
        }
      }
      approvePerEntityMutation.mutate(
        { submoduleRunId: activeSubmoduleRunId, entityApprovals, runId: runId!, stepIndex },
        {
          onSuccess: () => {
            closeSubmodulePanel();
            queryClient.invalidateQueries({ queryKey: ['latestSubmoduleRuns', runId, stepIndex] });
            queryClient.invalidateQueries({ queryKey: ['run', runId] });
          },
        }
      );
      return;
    }

    // Legacy approval
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
          queryClient.invalidateQueries({ queryKey: ['run', runId] });
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

  const handleAbort = async () => {
    if (!activeSubmoduleRunId) return;
    try {
      await api.abortSubmoduleRun(activeSubmoduleRunId);
      showToast('Run aborted', 'info');
      queryClient.invalidateQueries({ queryKey: ['submoduleRun', activeSubmoduleRunId] });
      queryClient.invalidateQueries({ queryKey: ['latestSubmoduleRuns', runId, stepIndex] });
    } catch (err) {
      showToast('Failed to abort', 'error');
    }
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
      ? `${previewEntities.length} in working pool`
      : `${previewEntities.length} entities`
    : stepIndex > 0
      ? 'From previous step'
      : undefined;

  // --- Results badge ---
  const summary = legacyRun?.output_data?.summary;

  const resultsBadge = perEntityMode
    ? (isRunning
      ? `${batchRun?.completed_count || 0}/${batchRun?.entity_count || 0} entities`
      : isCompleted
        ? `${batchRun?.entity_count || 0} entities`
        : undefined)
    : (isRunning
      ? 'running'
      : isCompleted
        ? isSelectable
          ? `${checkedKeys.size}/${flatItems.length}`
          : `${flatItems.length} items`
        : undefined);

  // --- Results summary label — submodule-authored, skeleton just renders it ---
  const resultsLabel = perEntityMode
    ? (batchRun ? `${batchRun.entity_count} entities (${batchRun.completed_count} completed, ${batchRun.failed_count} failed)` : undefined)
    : (summary?.description
      || (summary ? `${summary.total_items} items across ${summary.total_entities} entities` : undefined));

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

        {/* Previous Run Summary — visible when a completed/approved/failed run exists */}
        {(() => {
          // Only show when we're NOT viewing that run already
          const latestRun = latestRuns?.[submodule.id];
          if (!latestRun || latestRun.id === activeSubmoduleRunId) return null;

          const status = latestRun.status;
          if (!['completed', 'approved', 'failed'].includes(status)) return null;

          const isPerEntity = latestRun.mode === 'per_entity';
          const countLabel = isPerEntity
            ? `${latestRun.entity_count || 0} entities`
            : `${latestRun.result_count || 0} items`;
          const agoMs = latestRun.completed_at ? Date.now() - new Date(latestRun.completed_at).getTime() : 0;
          const agoText = agoMs < 60000 ? 'just now'
            : agoMs < 3600000 ? `${Math.floor(agoMs / 60000)}m ago`
            : agoMs < 86400000 ? `${Math.floor(agoMs / 3600000)}h ago`
            : `${Math.floor(agoMs / 86400000)}d ago`;

          let label = '';
          let statusIcon = '';
          if (status === 'approved') {
            label = `Last run: ${countLabel} \u00b7 Approved`;
            statusIcon = '\u2713';
          } else if (status === 'completed') {
            label = `Last run: ${countLabel} \u00b7 Completed`;
            statusIcon = '\u25cb';
          } else if (status === 'failed') {
            label = `Last run: Failed`;
            statusIcon = '\u2717';
          }

          return (
            <div className="mx-3 mt-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded text-xs text-gray-600 flex items-center justify-between flex-shrink-0">
              <span>
                {label} {statusIcon} \u00b7 {agoText}
              </span>
              <button
                onClick={() => {
                  setActiveSubmoduleRunId(latestRun.id);
                  setPanelAccordion('results');
                }}
                className="text-[#0891B2] hover:underline"
              >
                View results
              </button>
            </div>
          );
        })()}

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
                projectId={projectId}
                submoduleId={submodule.id}
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
            {perEntityMode && batchRun ? (
              <PerEntityResultsContent
                batchRun={batchRun}
                renderSchema={renderSchema}
                itemKey={itemKey}
                isSelectable={isSelectable}
                entityCheckedKeys={entityCheckedKeys}
                onEntityCheckedKeysChange={setEntityCheckedKeys}
                resultsLabel={resultsLabel}
                onChangeInput={handleChangeInput}
                onChangeOptions={handleChangeOptions}
                onTryAgain={handleTryAgain}
                onAbort={handleAbort}
              />
            ) : (
              <ResultsContent
                submoduleRun={submoduleRun ?? null}
                flatItems={mergedFlatItems}
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
                onAbort={handleAbort}
                submoduleId={submodule.id}
                submoduleRunStatus={submoduleRun?.status ?? null}
                onRequestFullData={handleRequestFullData}
              />
            )}
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
              disabled={!isCompleted || approveMutation.isPending || approvePerEntityMutation.isPending}
              onClick={handleApprove}
              className={`px-8 py-3 rounded text-sm font-medium transition-colors ${
                isCompleted && !approveMutation.isPending && !approvePerEntityMutation.isPending
                  ? 'bg-green-600 text-white hover:bg-green-700'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              }`}
            >
              {(approveMutation.isPending || approvePerEntityMutation.isPending) ? 'APPROVING...' : 'APPROVE'}
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
  onAbort,
  submoduleId,
  submoduleRunStatus,
  onRequestFullData,
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
  onAbort?: () => void;
  submoduleId: string;
  submoduleRunStatus: string | null;
  onRequestFullData?: () => void;
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
        {onAbort && (
          <button onClick={onAbort} className="ml-auto text-xs text-red-500 hover:underline">Abort</button>
        )}
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
          {onAbort && (
            <button onClick={onAbort} className="ml-auto text-xs text-red-500 hover:underline">Abort</button>
          )}
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
          {(Array.isArray(summary.errors) ? summary.errors.length : summary.errors) > 0 && (
            <span className="text-red-500 ml-2">{Array.isArray(summary.errors) ? summary.errors.length : summary.errors} errors</span>
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
          onRequestFullData={onRequestFullData}
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
        submoduleId={submoduleId}
        checkedKeys={checkedKeys}
        itemKey={itemKey}
        submoduleRunStatus={submoduleRunStatus}
        onRequestFullData={onRequestFullData}
      />
    </div>
  );
}


// --- Per-Entity Results Content ---

function PerEntityResultsContent({
  batchRun,
  renderSchema,
  itemKey,
  isSelectable,
  entityCheckedKeys,
  onEntityCheckedKeysChange,
  resultsLabel,
  onChangeInput,
  onChangeOptions,
  onTryAgain,
  onAbort,
}: {
  batchRun: SubmoduleRunBatch;
  renderSchema: RenderSchema | null;
  itemKey: string;
  isSelectable: boolean;
  entityCheckedKeys: Map<string, Set<string>>;
  onEntityCheckedKeysChange: (keys: Map<string, Set<string>>) => void;
  resultsLabel: string | undefined;
  onChangeInput: () => void;
  onChangeOptions: () => void;
  onTryAgain: () => void;
  onAbort?: () => void;
}) {
  const [expandedEntity, setExpandedEntity] = useState<string | null>(null);

  // No entities yet
  if (!batchRun.entities || batchRun.entities.length === 0) {
    return <p className="text-sm text-gray-400">No results yet. Configure input and click RUN TASK.</p>;
  }

  // All pending
  if (batchRun.status === 'pending') {
    return (
      <div className="flex items-center gap-3 py-4">
        <Spinner />
        <p className="text-sm text-gray-500">Waiting to start...</p>
        {onAbort && (
          <button onClick={onAbort} className="ml-auto text-xs text-red-500 hover:underline">Abort</button>
        )}
      </div>
    );
  }

  // Failed at batch level
  if (batchRun.status === 'failed' && batchRun.completed_count === 0) {
    return (
      <div className="space-y-3">
        <div className="bg-red-50 border border-red-200 rounded p-3">
          <p className="text-sm text-red-700 font-medium">Execution failed</p>
          <p className="text-xs text-red-600 mt-1">{batchRun.error || 'Unknown error'}</p>
        </div>
        <ResultsActionCTAs onChangeInput={onChangeInput} onChangeOptions={onChangeOptions} onTryAgain={onTryAgain} />
      </div>
    );
  }

  // Running or completed/approved — show entity rows with mixed status
  const handleEntityCheckedChange = (entityName: string, keys: Set<string>) => {
    const next = new Map(entityCheckedKeys);
    next.set(entityName, keys);
    onEntityCheckedKeysChange(next);
  };

  return (
    <div className="flex flex-col gap-2 h-full">
      {resultsLabel && (
        <div className="flex-shrink-0 text-xs text-gray-600">{resultsLabel}</div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
        {batchRun.entities.map((entity) => (
          <EntityAccordionItem
            key={entity.id}
            entity={entity}
            batchRunId={batchRun.id}
            isExpanded={expandedEntity === entity.entity_name}
            onToggle={() => setExpandedEntity(expandedEntity === entity.entity_name ? null : entity.entity_name)}
            renderSchema={renderSchema}
            itemKey={itemKey}
            isSelectable={isSelectable}
            checkedKeys={entityCheckedKeys.get(entity.entity_name)}
            onCheckedKeysChange={(keys) => handleEntityCheckedChange(entity.entity_name, keys)}
            batchStatus={batchRun.status}
          />
        ))}
      </div>

      <ResultsActionCTAs
        onChangeInput={onChangeInput}
        onChangeOptions={onChangeOptions}
        onTryAgain={onTryAgain}
        showDownload
        renderSchema={renderSchema}
        submoduleId={batchRun.submodule_id}
        itemKey={itemKey}
        batchRunId={batchRun.id}
      />
      {onAbort && batchRun.entities.some(e => e.status === 'running' || e.status === 'pending') && (
        <div className="flex items-center gap-2 flex-shrink-0 pt-2 border-t border-gray-100">
          <button onClick={onAbort} className="text-xs text-red-500 hover:underline ml-auto">Abort</button>
        </div>
      )}
    </div>
  );
}


// --- Entity Accordion Item (lazy-loads detail on expand) ---

function EntityAccordionItem({
  entity,
  batchRunId,
  isExpanded,
  onToggle,
  renderSchema,
  itemKey,
  isSelectable,
  checkedKeys,
  onCheckedKeysChange,
  batchStatus,
}: {
  entity: EntityRunStatus;
  batchRunId: string;
  isExpanded: boolean;
  onToggle: () => void;
  renderSchema: RenderSchema | null;
  itemKey: string;
  isSelectable: boolean;
  checkedKeys: Set<string> | undefined;
  onCheckedKeysChange: (keys: Set<string>) => void;
  batchStatus: string;
}) {
  // Lazy-load entity detail only when expanded
  const { data: detail, isLoading } = useEntityRunDetail(batchRunId, entity.id, isExpanded);

  // Initialize checked keys when detail loads (only once per detail+renderSchema)
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!detail || !isSelectable || initializedRef.current) return;
    const items = detail.output_data?.items || [];
    if (detail.status === 'approved' && detail.approved_items) {
      onCheckedKeysChange(new Set(detail.approved_items));
      initializedRef.current = true;
    } else {
      // Pre-select non-flagged items using manifest-declared flagged_when rules
      const flaggedWhen = (renderSchema as Record<string, unknown>)?.flagged_when as Record<string, string[]> | undefined;
      const keys = items
        .filter((item) => {
          if (!flaggedWhen) return true;
          return !Object.entries(flaggedWhen).some(
            ([field, values]) => values.includes(String(item[field] ?? ''))
          );
        })
        .map((item) => String(item[itemKey] ?? ''))
        .filter(Boolean);
      onCheckedKeysChange(new Set(keys));
      // Only mark initialized if renderSchema was available (so flaggedWhen could apply).
      // If renderSchema is null, re-run when it arrives to apply flagging rules.
      if (renderSchema) initializedRef.current = true;
    }
  }, [detail, isSelectable, renderSchema]);

  // Status indicator
  const statusIcon = entity.status === 'completed' || entity.status === 'approved'
    ? '\u2713'
    : entity.status === 'failed'
      ? '\u2717'
      : entity.status === 'running'
        ? null // spinner
        : '\u25cb'; // pending

  const itemCount = detail?.output_data?.items?.length;
  const checkedCount = checkedKeys?.size;

  return (
    <div className={`border rounded ${isExpanded ? 'border-pink-300' : 'border-gray-200'}`}>
      {/* Entity header row */}
      <button
        onClick={onToggle}
        disabled={entity.status === 'pending'}
        className={`w-full flex items-center justify-between px-3 py-2 text-left ${
          entity.status === 'pending' ? 'opacity-50 cursor-default' : 'hover:bg-gray-50 cursor-pointer'
        }`}
      >
        <div className="flex items-center gap-2">
          {entity.status === 'running' ? (
            <span className="inline-block w-3 h-3 border-2 border-sky-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
          ) : (
            <span className={`text-xs flex-shrink-0 ${
              entity.status === 'failed' ? 'text-red-500' :
              entity.status === 'completed' || entity.status === 'approved' ? 'text-emerald-500' :
              'text-gray-400'
            }`}>{statusIcon}</span>
          )}
          <span className="text-sm text-gray-700 font-medium">{entity.entity_name}</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-gray-500">
          {entity.status === 'running' && entity.progress && (
            <span>{entity.progress.current}/{entity.progress.total}</span>
          )}
          {entity.status === 'running' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                api.abortEntityRun(entity.id).catch(() => {});
              }}
              className="px-1.5 py-0.5 bg-red-100 text-red-600 rounded text-[10px] hover:bg-red-200 font-medium"
              title="Stop this entity and save partial results"
            >Stop</button>
          )}
          {itemCount != null && isSelectable && checkedCount != null && (
            <span>{checkedCount}/{itemCount}{itemCount > checkedCount ? ` · ${itemCount - checkedCount} rejected` : ''}</span>
          )}
          {itemCount != null && !isSelectable && (
            <span>{itemCount} items</span>
          )}
          {entity.error && (
            <span className="text-red-500" title={entity.error}>error</span>
          )}
          <span className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}>{'\u25B6'}</span>
        </div>
      </button>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="border-t border-gray-200 p-3">
          {isLoading && (
            <div className="flex items-center gap-2 py-2">
              <Spinner />
              <span className="text-xs text-gray-500">Loading...</span>
            </div>
          )}
          {!isLoading && !detail?.error && detail?.output_data?.items && detail.output_data.items.length > 0 && (
            <ContentRenderer
              entities={detail.output_data.items}
              renderSchema={renderSchema}
              itemKey={itemKey}
              checkedKeys={isSelectable ? checkedKeys : undefined}
              onCheckedKeysChange={isSelectable ? onCheckedKeysChange : undefined}
              fullHeight
            />
          )}
          {!isLoading && detail && (!detail.output_data?.items || detail.output_data.items.length === 0) && !detail.error && (
            <p className="text-xs text-gray-400">No items returned for this entity.</p>
          )}
          {!isLoading && detail?.error && (
            <div className="bg-red-50 border border-red-200 rounded p-2 mt-2">
              <p className="text-xs text-red-600 font-medium">Failed: {detail.error}</p>
            </div>
          )}
        </div>
      )}
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
  submoduleId,
  checkedKeys,
  itemKey,
  submoduleRunStatus,
  onRequestFullData,
  batchRunId,
}: {
  onChangeInput: () => void;
  onChangeOptions: () => void;
  onTryAgain: () => void;
  showDownload?: boolean;
  entities?: Record<string, unknown>[];
  renderSchema?: RenderSchema | null;
  submoduleId?: string;
  checkedKeys?: Set<string>;
  itemKey?: string;
  submoduleRunStatus?: string | null;
  onRequestFullData?: () => void;
  batchRunId?: string;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [zipping, setZipping] = useState(false);
  const [downloadPending, setDownloadPending] = useState(false);

  const downloadableFields = renderSchema?.downloadable_fields as DownloadableField[] | undefined;

  // Check if entities have full downloadable field data loaded
  const hasFullData = !!(downloadableFields?.length && entities?.some(
    (e) => e[downloadableFields[0].field] != null && String(e[downloadableFields[0].field]).length > 0
  ));

  const handleDownload = () => {
    if (!entities || entities.length === 0) return;
    const metaFields = new Set(['display_type', 'selectable', 'detail_schema', 'downloadable_fields', 'flagged_when']);
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

  // Core zip creation logic — works with any items array
  const generateZip = useCallback(async (items: Record<string, unknown>[]) => {
    if (!items.length || !downloadableFields?.length) return;
    try {
      setZipping(true);
      const zip = new JSZip();
      // Track used filenames per folder to avoid collisions
      const usedSlugs = new Map<string, Map<string, number>>();

      for (const entity of items) {
        const entityName = String(entity.entity_name || 'entity');
        const safeName = sanitizeFilename(entityName);
        const isRejected = submoduleRunStatus === 'approved'
          && checkedKeys
          && !checkedKeys.has(String(entity[itemKey ?? 'url'] ?? ''));
        const folderName = isRejected ? `REJECTED-${safeName}` : safeName;
        const folder = zip.folder(folderName);
        if (!folder) continue;

        if (!usedSlugs.has(folderName)) usedSlugs.set(folderName, new Map());
        const folderSlugs = usedSlugs.get(folderName)!;

        // Derive unique filename per item from full URL path (not just last segment)
        const keyVal = String(entity[itemKey ?? 'url'] ?? '');
        let itemSlug = safeName;
        if (keyVal.startsWith('http')) {
          try {
            const pathParts = new URL(keyVal).pathname.split('/').filter(Boolean);
            // Use full path joined with underscores to avoid collisions
            // e.g. /de/games/reactoonz → de_games_reactoonz
            itemSlug = sanitizeFilename(pathParts.join('_').slice(0, 120)) || safeName;
          } catch { /* keep safeName */ }
        }

        // Deduplicate: append counter if slug already used in this folder
        const count = folderSlugs.get(itemSlug) || 0;
        folderSlugs.set(itemSlug, count + 1);
        const finalSlug = count > 0 ? `${itemSlug}_${count}` : itemSlug;

        for (const df of downloadableFields) {
          const raw = entity[df.field];
          if (!raw) continue;
          const content = typeof raw === 'object' && raw !== null
            ? JSON.stringify(raw, null, 2)
            : String(raw);
          folder.file(
            `${finalSlug}.${df.extension}`,
            content
          );
        }
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${submoduleId || 'results'}-content.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Zip generation failed:', err);
      showToast('Zip generation failed', 'error');
    } finally {
      setZipping(false);
    }
  }, [downloadableFields, submoduleId, checkedKeys, itemKey, submoduleRunStatus, showToast]);

  // Auto-trigger download when pending and full data arrives (legacy mode)
  useEffect(() => {
    if (downloadPending && hasFullData && entities?.length) {
      setDownloadPending(false);
      generateZip(entities);
    }
  }, [downloadPending, hasFullData, entities, generateZip]);

  const handleDownloadAll = async () => {
    if (!downloadableFields?.length) return;

    // Batch mode: fetch all items from the batch endpoint
    if (batchRunId) {
      try {
        setZipping(true);
        showToast('Loading full content...', 'info');
        const { items } = await api.getBatchAllItems(batchRunId, true);
        if (items.length === 0) {
          showToast('No items to download', 'error');
          setZipping(false);
          return;
        }
        await generateZip(items);
      } catch (err) {
        console.error('Batch download failed:', err);
        showToast('Download failed', 'error');
        setZipping(false);
      }
      return;
    }

    // Legacy mode: use pre-loaded entities
    if (!entities?.length) return;
    if (hasFullData) {
      generateZip(entities);
    } else {
      onRequestFullData?.();
      setDownloadPending(true);
      showToast('Loading full content...', 'info');
    }
  };

  // Batch mode: CSV download fetches from endpoint too
  const handleBatchDownload = async () => {
    if (!batchRunId) return;
    try {
      const { items } = await api.getBatchAllItems(batchRunId, false);
      if (items.length === 0) {
        showToast('No items to download', 'error');
        return;
      }
      const metaFields = new Set(['display_type', 'selectable', 'detail_schema', 'downloadable_fields', 'flagged_when']);
      const columns = renderSchema
        ? Object.keys(renderSchema).filter((k) => !metaFields.has(k))
        : Object.keys(items[0]);
      const headerRow = columns.map((c) => `"${c}"`).join(',');
      const rows = items.map((item) =>
        columns
          .map((col) => {
            const val = String(item[col] ?? '');
            return `"${val.replace(/"/g, '""')}"`;
          })
          .join(',')
      );
      const csv = [headerRow, ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `results-${items.length}-rows.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Batch CSV download failed:', err);
      showToast('Download failed', 'error');
    }
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
          onClick={batchRunId ? handleBatchDownload : handleDownload}
          className="text-xs text-gray-500 hover:underline"
        >
          Download
        </button>
      )}
      {showDownload && downloadableFields && downloadableFields.length > 0 && (
        <button
          onClick={handleDownloadAll}
          disabled={zipping}
          className="text-xs text-gray-500 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {zipping ? 'Generating...' : 'Download All'}
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
