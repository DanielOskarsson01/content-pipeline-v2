import { useState, useRef, useMemo, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAppStore } from '../../stores/appStore';
import { STEP_CONFIG } from '../../config/stepConfig';
import { SubmoduleOptions } from '../primitives/SubmoduleOptions';
import type {
  TemplateDetail, SubmoduleManifest,
  TemplatePresetMap, TemplatePresetMapEntry, TemplateExecutionPlan, TemplateSeedConfig,
} from '../../types/step';

export function TemplateEditor() {
  const { templateId } = useParams<{ templateId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useAppStore();
  const isEdit = !!templateId;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [initialized, setInitialized] = useState(false);

  // Fetch template detail in edit mode
  const { data: template, isLoading: templateLoading } = useQuery({
    queryKey: ['template', templateId],
    queryFn: () => api.getTemplate(templateId!),
    enabled: isEdit,
  });

  // Initialize form from fetched data
  if (template && !initialized) {
    setName(template.name);
    setDescription(template.description || '');
    setInitialized(true);
  }

  // Create template
  const createMutation = useMutation({
    mutationFn: (data: { name: string; description?: string }) => api.createTemplate(data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      showToast(`Template "${result.template.name}" created`, 'success');
      navigate(`/templates/${result.template.id}`);
    },
  });

  // Update template
  const updateMutation = useMutation({
    mutationFn: (data: Parameters<typeof api.updateTemplate>[1]) => api.updateTemplate(templateId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['template', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      showToast('Template updated', 'success');
    },
  });

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      showToast('Template name is required', 'error');
      return;
    }
    if (isEdit) {
      updateMutation.mutate({ name: trimmed, description: description.trim() || undefined });
    } else {
      createMutation.mutate({ name: trimmed, description: description.trim() || undefined });
    }
  };

  if (isEdit && templateLoading) {
    return <div className="text-center py-12 text-gray-500 text-sm">Loading template...</div>;
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-gray-900">
          {isEdit ? 'Edit Template' : 'New Template'}
        </h2>
        <button
          onClick={() => navigate('/templates')}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          Back to Templates
        </button>
      </div>

      {/* Name + Description */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-600 mb-1 font-medium">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Nordic Operators Standard"
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1 font-medium">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What is this template for?"
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>
          <button
            onClick={handleSave}
            disabled={!name.trim() || createMutation.isPending || updateMutation.isPending}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              name.trim() ? 'bg-sky-600 hover:bg-sky-700 text-white' : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
          >
            {createMutation.isPending || updateMutation.isPending
              ? 'Saving...'
              : isEdit ? 'Update' : 'Create Template'}
          </button>
        </div>
      </div>

      {/* JSONB config sections (edit mode only) */}
      {isEdit && template && (
        <>
          <SeedConfigSection
            template={template}
            onSave={(seed_config) => updateMutation.mutate({ seed_config })}
            isPending={updateMutation.isPending}
          />
          <PresetMapSection template={template} />
          <ExecutionPlanSection
            template={template}
            onSave={(execution_plan, addedSubmoduleId) => {
              const update: Record<string, unknown> = { execution_plan };
              if (addedSubmoduleId) {
                const pm = template.preset_map || {};
                if (!pm[addedSubmoduleId]) {
                  update.preset_map = { ...pm, [addedSubmoduleId]: { fallback_values: {} } };
                }
              }
              updateMutation.mutate(update);
            }}
            isPending={updateMutation.isPending}
          />
          <CardsSection
            template={template}
            onSave={(execution_plan) => updateMutation.mutate({ execution_plan })}
            isPending={updateMutation.isPending}
          />
          <RoutingRulesSection
            template={template}
            onSave={(execution_plan) => updateMutation.mutate({ execution_plan })}
            isPending={updateMutation.isPending}
          />
          <EscalationRulesSection
            template={template}
            onSave={(execution_plan) => updateMutation.mutate({ execution_plan })}
            isPending={updateMutation.isPending}
          />
          <ReferenceDocsSection template={template} />
        </>
      )}
    </div>
  );
}

// ── Seed Config Section ──────────────────────────────────────

function SeedConfigSection({
  template,
  onSave,
  isPending,
}: {
  template: TemplateDetail;
  onSave: (config: TemplateSeedConfig) => void;
  isPending: boolean;
}) {
  const seedConfig = template.seed_config || { seed_type: 'csv' as const };
  const [seedType, setSeedType] = useState(seedConfig.seed_type || 'csv');
  const [requiredCols, setRequiredCols] = useState(
    (seedConfig.required_columns || []).join(', ')
  );

  const dirty =
    seedType !== (seedConfig.seed_type || 'csv') ||
    requiredCols !== (seedConfig.required_columns || []).join(', ');

  const handleSave = () => {
    const config: TemplateSeedConfig = { seed_type: seedType as 'csv' | 'url' | 'prompt' };
    if (seedType === 'csv' && requiredCols.trim()) {
      config.required_columns = requiredCols.split(',').map(s => s.trim()).filter(Boolean);
    }
    onSave(config);
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">Seed Config</h3>
      <div className="flex gap-4 mb-3">
        {(['csv', 'url', 'prompt'] as const).map(type => (
          <label key={type} className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="seedType"
              value={type}
              checked={seedType === type}
              onChange={() => setSeedType(type)}
              className="accent-sky-600"
            />
            <span className="text-xs text-gray-700 uppercase">{type}</span>
          </label>
        ))}
      </div>
      {seedType === 'csv' && (
        <div className="mb-3">
          <label className="block text-[10px] text-gray-500 mb-1">Required Columns (comma-separated)</label>
          <input
            type="text"
            value={requiredCols}
            onChange={(e) => setRequiredCols(e.target.value)}
            placeholder="name, website"
            className="w-full bg-white border border-gray-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
        </div>
      )}
      {dirty && (
        <button
          onClick={handleSave}
          disabled={isPending}
          className="px-3 py-1.5 text-xs bg-sky-600 text-white rounded hover:bg-sky-700 disabled:bg-gray-300"
        >
          Save Seed Config
        </button>
      )}
    </div>
  );
}

// ── Preset Map Section (JSONB) ───────────────────────────────

function PresetMapSection({ template }: { template: TemplateDetail }) {
  const queryClient = useQueryClient();
  const { showToast } = useAppStore();
  const presetMap = template.preset_map || {};

  // Fetch all submodules for display names
  const { data: allSubmodules } = useQuery({
    queryKey: ['submodules-full'],
    queryFn: api.getSubmodulesFull,
  });

  const submoduleName = (id: string) => {
    const sub = (allSubmodules || []).find(s => s.id === id);
    return sub?.name || id;
  };

  const updateMutation = useMutation({
    mutationFn: (newMap: TemplatePresetMap) => api.updateTemplate(template.id, { preset_map: newMap }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['template', template.id] });
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      showToast('Preset map updated', 'success');
    },
  });

  const handleRemoveSubmodule = (submoduleId: string) => {
    const updated = { ...presetMap };
    delete updated[submoduleId];
    updateMutation.mutate(updated);
  };

  const handleUpdateEntry = (submoduleId: string, entry: TemplatePresetMapEntry) => {
    updateMutation.mutate({ ...presetMap, [submoduleId]: entry });
  };

  const entries = Object.entries(presetMap);

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">
        Preset Map
        <span className="text-gray-400 font-normal ml-1 text-xs">({entries.length} submodule{entries.length !== 1 ? 's' : ''})</span>
      </h3>

      {entries.length === 0 ? (
        <p className="text-xs text-gray-400">No preset map entries. Save a run as template or add entries manually.</p>
      ) : (
        <div className="space-y-3">
          {entries.map(([subId, config]) => (
            <PresetMapEntry
              key={subId}
              submoduleId={subId}
              submoduleName={submoduleName(subId)}
              entry={config}
              allSubmodules={allSubmodules || []}
              onUpdate={(entry) => handleUpdateEntry(subId, entry)}
              onRemove={() => handleRemoveSubmodule(subId)}
              isPending={updateMutation.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PresetMapEntry({
  submoduleId,
  submoduleName,
  entry,
  allSubmodules,
  onUpdate,
  onRemove,
  isPending,
}: {
  submoduleId: string;
  submoduleName: string;
  entry: TemplatePresetMapEntry;
  allSubmodules: SubmoduleManifest[];
  onUpdate: (entry: TemplatePresetMapEntry) => void;
  onRemove: () => void;
  isPending: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const manifestOptions = useMemo(() => {
    return allSubmodules.find(s => s.id === submoduleId)?.options || [];
  }, [allSubmodules, submoduleId]);

  // Merge manifest defaults with saved fallback_values — shows ALL options
  const initialValues = useMemo(() => {
    const vals: Record<string, unknown> = {};
    for (const opt of manifestOptions) {
      vals[opt.name] = entry.fallback_values?.[opt.name] ?? opt.default;
    }
    return vals;
  }, [manifestOptions, entry.fallback_values]);

  const [localValues, setLocalValues] = useState<Record<string, unknown>>(initialValues);

  // Sync local state when saved values change (e.g. after save round-trip)
  useEffect(() => {
    setLocalValues(initialValues);
  }, [initialValues]);

  const optionCount = manifestOptions.length;

  // Check if local values differ from initial (saved + defaults)
  const dirty = useMemo(() => {
    return JSON.stringify(localValues) !== JSON.stringify(initialValues);
  }, [localValues, initialValues]);

  const handleSave = () => {
    // Only persist values that differ from manifest defaults (keep fallback_values lean)
    const nonDefault: Record<string, unknown> = {};
    for (const opt of manifestOptions) {
      const val = localValues[opt.name];
      if (JSON.stringify(val) !== JSON.stringify(opt.default)) {
        nonDefault[opt.name] = val;
      }
    }
    onUpdate({ ...entry, fallback_values: nonDefault });
  };

  const handleOptionChange = (name: string, value: unknown) => {
    setLocalValues(prev => ({ ...prev, [name]: value }));
  };

  return (
    <div className="border border-gray-200 rounded-lg">
      <div
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-gray-50"
        onClick={() => setExpanded(!expanded)}
      >
        <div>
          <span className="text-xs font-medium text-gray-800">{submoduleName}</span>
          <span className="text-[10px] text-gray-400 ml-2">{optionCount} option{optionCount !== 1 ? 's' : ''}</span>
          {entry.preset_name && (
            <span className="text-[10px] text-sky-600 ml-2">preset: {entry.preset_name}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            disabled={isPending}
            className="text-[10px] text-gray-400 hover:text-red-500"
          >
            Remove
          </button>
          <span className="text-gray-400 text-xs">{expanded ? '▼' : '▶'}</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-200 px-3 py-2 space-y-2">
          {manifestOptions.length > 0 ? (
            <SubmoduleOptions
              options={manifestOptions}
              values={localValues}
              onChange={handleOptionChange}
              projectId=""
              submoduleId={submoduleId}
            />
          ) : (
            <p className="text-[10px] text-gray-400">No options defined in manifest</p>
          )}
          {dirty && (
            <button
              onClick={handleSave}
              disabled={isPending}
              className="px-3 py-1 text-[10px] bg-sky-600 text-white rounded hover:bg-sky-700 disabled:bg-gray-300"
            >
              Save Changes
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Execution Plan Section ───────────────────────────────────

function ExecutionPlanSection({
  template,
  onSave,
  isPending,
}: {
  template: TemplateDetail;
  onSave: (plan: TemplateExecutionPlan, addedSubmoduleId?: string) => void;
  isPending: boolean;
}) {
  const plan = template.execution_plan || {};
  const submodulesPerStep = plan.submodules_per_step || {};

  // Fetch all registered submodules (with full manifest incl. step field)
  const { data: allSubmodules } = useQuery({
    queryKey: ['submodules-full'],
    queryFn: api.getSubmodulesFull,
  });

  const submoduleName = (id: string) => {
    const sub = (allSubmodules || []).find(s => s.id === id);
    return sub?.name || id;
  };

  // Local state for dropdowns
  const [selectedPause, setSelectedPause] = useState('');
  const [selectedAdd, setSelectedAdd] = useState<Record<number, string>>({});

  // ── Submodule add/remove per step ──

  const addToStep = (stepIndex: number, subId: string) => {
    if (!subId) return;
    const current = submodulesPerStep[String(stepIndex)] || [];
    if (current.includes(subId)) return;
    const updated = { ...submodulesPerStep, [String(stepIndex)]: [...current, subId] };
    onSave({ ...plan, submodules_per_step: updated }, subId);
    setSelectedAdd(prev => ({ ...prev, [stepIndex]: '' }));
  };

  const removeFromStep = (stepIndex: number, subId: string) => {
    const current = (submodulesPerStep[String(stepIndex)] || []).filter((id: string) => id !== subId);
    const updated = { ...submodulesPerStep };
    if (current.length === 0) delete updated[String(stepIndex)];
    else updated[String(stepIndex)] = current;
    onSave({ ...plan, submodules_per_step: updated });
  };

  // ── Pause after submodules ──

  const allConfiguredIds = [...new Set(Object.values(submodulesPerStep).flat() as string[])];
  const pauseAfter = plan.pause_after_submodules || [];
  const availableForPause = allConfiguredIds.filter(id => !pauseAfter.includes(id));

  const addPause = (subId: string) => {
    if (!subId) return;
    onSave({ ...plan, pause_after_submodules: [...pauseAfter, subId] });
    setSelectedPause('');
  };

  const removePause = (subId: string) => {
    onSave({ ...plan, pause_after_submodules: pauseAfter.filter(id => id !== subId) });
  };

  // ── Skip steps ──

  const skipSteps = plan.skip_steps || [];
  const toggleSkip = (step: number) => {
    const updated = skipSteps.includes(step)
      ? skipSteps.filter(s => s !== step)
      : [...skipSteps, step].sort((a, b) => a - b);
    onSave({ ...plan, skip_steps: updated });
  };

  // ── Pause before steps ──

  const pauseBefore = plan.pause_before_steps || [];
  const togglePauseBefore = (step: number) => {
    const updated = pauseBefore.includes(step)
      ? pauseBefore.filter(s => s !== step)
      : [...pauseBefore, step].sort((a, b) => a - b);
    onSave({ ...plan, pause_before_steps: updated });
  };

  // ── Failure thresholds ──

  const thresholds = plan.failure_thresholds || {};
  const updateThreshold = (stepIdx: string, value: string) => {
    const updated = { ...thresholds };
    if (value === '' || value === undefined) {
      delete updated[stepIdx];
    } else {
      updated[stepIdx] = parseFloat(value);
    }
    onSave({ ...plan, failure_thresholds: updated });
  };

  // Steps that have submodules configured (for skip/pause/threshold controls)
  const configuredSteps = STEP_CONFIG
    .filter(s => (submodulesPerStep[String(s.index)] || []).length > 0)
    .map(s => s.index);

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">Execution Plan</h3>

      {/* ── Submodules per step ── */}
      <p className="text-[10px] text-gray-400 mb-2">Select which submodules run at each step</p>
      <div className="space-y-1 mb-4">
        {STEP_CONFIG.map((stepCfg) => {
          const configured = (submodulesPerStep[String(stepCfg.index)] || []) as string[];
          const available = (allSubmodules || [])
            .filter(s => s.step === stepCfg.index && !configured.includes(s.id));
          const addValue = selectedAdd[stepCfg.index] || '';

          return (
            <div key={stepCfg.index} className="flex items-start gap-2 bg-gray-50 rounded px-3 py-1.5">
              <span className="text-[10px] text-gray-500 font-medium w-28 shrink-0 pt-0.5">
                {stepCfg.index}. {stepCfg.name}
              </span>
              <div className="flex flex-wrap items-center gap-1 flex-1 min-w-0">
                {configured.map(subId => (
                  <span key={subId} className="inline-flex items-center gap-0.5 text-[10px] bg-white border border-gray-200 rounded px-1.5 py-0.5 text-gray-600">
                    {submoduleName(subId)}
                    <button
                      onClick={() => removeFromStep(stepCfg.index, subId)}
                      disabled={isPending}
                      className="text-gray-400 hover:text-red-500 ml-0.5"
                    >
                      &times;
                    </button>
                  </span>
                ))}
                {available.length > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <select
                      value={addValue}
                      onChange={e => setSelectedAdd(prev => ({ ...prev, [stepCfg.index]: e.target.value }))}
                      className="text-[10px] border border-gray-200 rounded px-1 py-0.5 text-gray-500 bg-white"
                    >
                      <option value="">+ add...</option>
                      {available.map(s => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                    {addValue && (
                      <button
                        onClick={() => addToStep(stepCfg.index, addValue)}
                        disabled={isPending}
                        className="text-[10px] px-1.5 py-0.5 bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-50"
                      >
                        Add
                      </button>
                    )}
                  </span>
                )}
                {configured.length === 0 && available.length === 0 && (
                  <span className="text-[10px] text-gray-300 italic">no modules registered</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Pause after submodule ── */}
      <div className="pt-3 border-t border-gray-100">
        <h4 className="text-xs font-medium text-gray-700 mb-2">Pause after submodule</h4>
        <p className="text-[10px] text-gray-400 mb-2">Auto-executor pauses after these submodules so you can review and approve results before continuing.</p>

        {pauseAfter.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {pauseAfter.map(subId => (
              <span key={subId} className="inline-flex items-center gap-1 text-[10px] bg-blue-50 border border-blue-200 rounded px-2 py-0.5 text-blue-700">
                {submoduleName(subId)}
                <button
                  onClick={() => removePause(subId)}
                  disabled={isPending}
                  className="text-blue-400 hover:text-red-500 ml-0.5"
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}

        {availableForPause.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={selectedPause}
              onChange={e => setSelectedPause(e.target.value)}
              className="text-xs border border-gray-200 rounded px-2 py-1 text-gray-600"
            >
              <option value="">Select submodule...</option>
              {availableForPause.map(subId => (
                <option key={subId} value={subId}>{submoduleName(subId)}</option>
              ))}
            </select>
            <button
              onClick={() => addPause(selectedPause)}
              disabled={!selectedPause || isPending}
              className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              + Add pause
            </button>
          </div>
        )}
      </div>

      {/* ── Skip steps ── */}
      {configuredSteps.length > 0 && (
        <div className="mt-4 pt-3 border-t border-gray-100">
          <h4 className="text-xs font-medium text-gray-700 mb-2">Skip steps</h4>
          <p className="text-[10px] text-gray-400 mb-2">Checked steps will be skipped during auto-execute.</p>
          <div className="flex flex-wrap gap-3">
            {configuredSteps.map(step => (
              <label key={step} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skipSteps.includes(step)}
                  onChange={() => toggleSkip(step)}
                  disabled={isPending}
                  className="accent-sky-600"
                />
                <span className="text-[10px] text-gray-600">Step {step}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* ── Pause before steps ── */}
      {configuredSteps.length > 0 && (
        <div className="mt-4 pt-3 border-t border-gray-100">
          <h4 className="text-xs font-medium text-gray-700 mb-2">Pause before steps</h4>
          <p className="text-[10px] text-gray-400 mb-2">Auto-executor pauses before entering these steps for manual review.</p>
          <div className="flex flex-wrap gap-3">
            {configuredSteps.map(step => (
              <label key={step} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={pauseBefore.includes(step)}
                  onChange={() => togglePauseBefore(step)}
                  disabled={isPending}
                  className="accent-blue-600"
                />
                <span className="text-[10px] text-gray-600">Step {step}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* ── Failure thresholds ── */}
      {configuredSteps.length > 0 && (
        <div className="mt-4 pt-3 border-t border-gray-100">
          <h4 className="text-xs font-medium text-gray-700 mb-2">Failure thresholds</h4>
          <p className="text-[10px] text-gray-400 mb-2">Max failure rate (0.0–1.0) before auto-execute halts. Leave blank for default.</p>
          <div className="space-y-1">
            {configuredSteps.map(step => (
              <ThresholdInput
                key={step}
                step={step}
                value={thresholds[String(step)]}
                onCommit={(value) => updateThreshold(String(step), value)}
                isPending={isPending}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Cards Section ─────────────────────────────────────────────

/** Number input that only saves on blur, avoiding API call per keystroke */
function ThresholdInput({ step, value, onCommit, isPending }: {
  step: number;
  value: number | undefined;
  onCommit: (value: string) => void;
  isPending: boolean;
}) {
  const [local, setLocal] = useState(value != null ? String(value) : '');

  useEffect(() => {
    setLocal(value != null ? String(value) : '');
  }, [value]);

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-500 w-16 shrink-0">Step {step}</span>
      <input
        type="number"
        min="0"
        max="1"
        step="0.05"
        value={local}
        onChange={e => setLocal(e.target.value)}
        onBlur={() => {
          const saved = value != null ? String(value) : '';
          if (local !== saved) onCommit(local);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        disabled={isPending}
        placeholder="default"
        className="w-24 bg-white border border-gray-200 rounded px-2 py-1 text-[10px] text-gray-700 focus:outline-none focus:ring-1 focus:ring-sky-500"
      />
    </div>
  );
}

function CardsSection({
  template,
  onSave,
  isPending,
}: {
  template: TemplateDetail;
  onSave: (plan: TemplateExecutionPlan) => void;
  isPending: boolean;
}) {
  const plan = template.execution_plan || {};
  const cards = plan.cards || {};
  const cardCount = Object.keys(cards).length;

  const [json, setJson] = useState(() => JSON.stringify(cards, null, 2));
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);

  const dirty = json !== JSON.stringify(cards, null, 2);

  const handleSave = () => {
    try {
      const parsed = JSON.parse(json);
      // Basic validation
      const warns: string[] = [];
      for (const [name, card] of Object.entries(parsed) as [string, Record<string, unknown>][]) {
        if (!card.submodule_id) warns.push(`Card "${name}": missing submodule_id`);
        if (card.step === undefined) warns.push(`Card "${name}": missing step`);
      }
      setWarnings(warns);
      setError('');
      onSave({ ...plan, cards: parsed });
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-1">
        Cards
        <span className="text-gray-400 font-normal ml-1 text-xs">({cardCount} card{cardCount !== 1 ? 's' : ''})</span>
      </h3>
      <p className="text-[10px] text-gray-400 mb-2">
        Named option overrides activated on routing loops. Each card targets a submodule at a specific step.
      </p>
      <textarea
        value={json}
        onChange={(e) => { setJson(e.target.value); setError(''); }}
        rows={Math.min(20, Math.max(6, json.split('\n').length + 1))}
        spellCheck={false}
        className="w-full bg-gray-50 border border-gray-200 rounded px-3 py-2 text-[11px] font-mono text-gray-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
      />
      {error && <p className="text-[10px] text-red-500 mt-1">{error}</p>}
      {warnings.map((w, i) => <p key={i} className="text-[10px] text-amber-600 mt-0.5">{w}</p>)}
      {dirty && (
        <button
          onClick={handleSave}
          disabled={isPending}
          className="mt-2 px-3 py-1.5 text-xs bg-sky-600 text-white rounded hover:bg-sky-700 disabled:bg-gray-300"
        >
          Save Cards
        </button>
      )}
    </div>
  );
}

// ── Routing Rules Section ─────────────────────────────────────

function RoutingRulesSection({
  template,
  onSave,
  isPending,
}: {
  template: TemplateDetail;
  onSave: (plan: TemplateExecutionPlan) => void;
  isPending: boolean;
}) {
  const plan = template.execution_plan || {};
  const rules = plan.routing_rules || {};
  const ruleCount = Object.keys(rules).length;
  const cardNames = Object.keys(plan.cards || {});

  const [json, setJson] = useState(() => JSON.stringify(rules, null, 2));
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);

  const dirty = json !== JSON.stringify(rules, null, 2);

  const handleSave = () => {
    try {
      const parsed = JSON.parse(json);
      const warns: string[] = [];
      for (const [ruleKey, rule] of Object.entries(parsed) as [string, { target_cards?: string[] }][]) {
        for (const cardName of rule.target_cards || []) {
          if (!cardNames.includes(cardName)) {
            warns.push(`Rule "${ruleKey}": targets unknown card "${cardName}"`);
          }
        }
      }
      setWarnings(warns);
      setError('');
      onSave({ ...plan, routing_rules: parsed });
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`);
    }
  };

  const FAILURE_TYPES = ['hallucination:fail', 'citation:fail', 'keyword:fail', 'meta:fail', 'structural:fail'];

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-1">
        Routing Rules
        <span className="text-gray-400 font-normal ml-1 text-xs">({ruleCount} rule{ruleCount !== 1 ? 's' : ''})</span>
      </h3>
      <p className="text-[10px] text-gray-400 mb-1">
        Map QA failure types to target cards. Available failure types:
      </p>
      <div className="flex flex-wrap gap-1 mb-2">
        {FAILURE_TYPES.map(ft => (
          <span key={ft} className="text-[10px] bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5 text-gray-500 font-mono">{ft}</span>
        ))}
      </div>
      <textarea
        value={json}
        onChange={(e) => { setJson(e.target.value); setError(''); }}
        rows={Math.min(15, Math.max(4, json.split('\n').length + 1))}
        spellCheck={false}
        className="w-full bg-gray-50 border border-gray-200 rounded px-3 py-2 text-[11px] font-mono text-gray-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
      />
      {error && <p className="text-[10px] text-red-500 mt-1">{error}</p>}
      {warnings.map((w, i) => <p key={i} className="text-[10px] text-amber-600 mt-0.5">{w}</p>)}
      {dirty && (
        <button
          onClick={handleSave}
          disabled={isPending}
          className="mt-2 px-3 py-1.5 text-xs bg-sky-600 text-white rounded hover:bg-sky-700 disabled:bg-gray-300"
        >
          Save Routing Rules
        </button>
      )}
    </div>
  );
}

// ── Escalation Rules Section ──────────────────────────────────

function EscalationRulesSection({
  template,
  onSave,
  isPending,
}: {
  template: TemplateDetail;
  onSave: (plan: TemplateExecutionPlan) => void;
  isPending: boolean;
}) {
  const plan = template.execution_plan || {};
  const rules = plan.escalation_rules || {};

  const [json, setJson] = useState(() => JSON.stringify(rules, null, 2));
  const [error, setError] = useState('');

  const dirty = json !== JSON.stringify(rules, null, 2);
  const ruleCount = Object.keys(rules).length;

  const handleSave = () => {
    try {
      const parsed = JSON.parse(json);
      setError('');
      onSave({ ...plan, escalation_rules: parsed });
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-1">
        Escalation Rules
        <span className="text-gray-400 font-normal ml-1 text-xs">({ruleCount} rule{ruleCount !== 1 ? 's' : ''})</span>
      </h3>
      <p className="text-[10px] text-gray-400 mb-2">
        Threshold gates after specific steps. Step 2: volume (URL count). Step 4: quality (word count). Entities below fail_threshold are marked as failed.
      </p>
      <textarea
        value={json}
        onChange={(e) => { setJson(e.target.value); setError(''); }}
        rows={Math.min(12, Math.max(4, json.split('\n').length + 1))}
        spellCheck={false}
        className="w-full bg-gray-50 border border-gray-200 rounded px-3 py-2 text-[11px] font-mono text-gray-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
      />
      {error && <p className="text-[10px] text-red-500 mt-1">{error}</p>}
      {dirty && (
        <button
          onClick={handleSave}
          disabled={isPending}
          className="mt-2 px-3 py-1.5 text-xs bg-sky-600 text-white rounded hover:bg-sky-700 disabled:bg-gray-300"
        >
          Save Escalation Rules
        </button>
      )}
    </div>
  );
}

// ── Reference Docs Section ─────────────────────────────────────

function ReferenceDocsSection({ template }: { template: TemplateDetail }) {
  const queryClient = useQueryClient();
  const { showToast } = useAppStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadMutation = useMutation({
    mutationFn: (formData: FormData) => api.uploadTemplateDoc(template.id, formData),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['template', template.id] });
      const count = result.uploaded.length;
      if (result.errors.length > 0) {
        showToast(`${count} uploaded, ${result.errors.length} failed`, 'error');
      } else {
        showToast(`${count} doc${count !== 1 ? 's' : ''} uploaded`, 'success');
      }
    },
  });

  const removeMutation = useMutation({
    mutationFn: (docId: string) => api.removeTemplateDoc(template.id, docId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['template', template.id] });
      showToast('Document removed', 'success');
    },
  });

  const handleUpload = (files: FileList | null) => {
    if (!files?.length) return;
    const formData = new FormData();
    for (const f of files) {
      formData.append('files', f);
    }
    uploadMutation.mutate(formData);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">Reference Documents</h3>

      {template.reference_docs.length > 0 && (
        <div className="space-y-1 mb-3">
          {template.reference_docs.map((doc) => (
            <div key={doc.id} className="flex items-center justify-between bg-gray-50 rounded px-3 py-2">
              <div>
                <span className="text-xs font-medium text-gray-700">{doc.filename}</span>
                <span className="text-[10px] text-gray-400 ml-2">
                  {doc.content_type} · {(doc.size_bytes / 1024).toFixed(1)}KB
                </span>
              </div>
              <button
                onClick={() => removeMutation.mutate(doc.id)}
                className="text-xs text-gray-400 hover:text-red-500"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".md,.txt,.csv,.json"
          onChange={(e) => handleUpload(e.target.files)}
          className="hidden"
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadMutation.isPending}
          className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 text-gray-600"
        >
          {uploadMutation.isPending ? 'Uploading...' : 'Upload Documents'}
        </button>
        <span className="text-[10px] text-gray-400 ml-2">.md, .txt, .csv, .json (max 5MB)</span>
      </div>
    </div>
  );
}
