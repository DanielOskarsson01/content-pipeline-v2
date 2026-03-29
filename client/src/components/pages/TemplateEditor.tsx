import { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAppStore } from '../../stores/appStore';
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
  // Local state for editing — only saves on explicit button click
  const [localValues, setLocalValues] = useState<Record<string, string>>(() => {
    const vals: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry.fallback_values || {})) {
      vals[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return vals;
  });

  const manifest = allSubmodules.find(s => s.id === submoduleId);
  const optionCount = Object.keys(entry.fallback_values || {}).length;

  // Check if local values differ from saved entry
  const dirty = Object.entries(localValues).some(([k, v]) => {
    const saved = entry.fallback_values?.[k];
    const savedStr = typeof saved === 'string' ? saved : JSON.stringify(saved);
    return v !== savedStr;
  });

  const handleSave = () => {
    const parsed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(localValues)) {
      parsed[k] = tryParseJson(v);
    }
    onUpdate({ ...entry, fallback_values: parsed });
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
          {Object.entries(localValues).map(([optName, value]) => {
            const optDef = manifest?.options?.find(o => o.name === optName);
            return (
              <div key={optName} className="flex items-center gap-2">
                <span className="text-[10px] text-gray-600 w-32 shrink-0 truncate" title={optName}>
                  {optDef?.label || optName}
                </span>
                <input
                  type="text"
                  value={value}
                  onChange={(e) => {
                    setLocalValues(prev => ({ ...prev, [optName]: e.target.value }));
                  }}
                  className="flex-1 bg-white border border-gray-200 rounded px-2 py-1 text-[10px] text-gray-700 font-mono"
                />
              </div>
            );
          })}
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

function tryParseJson(value: string): unknown {
  try {
    const parsed = JSON.parse(value);
    return parsed;
  } catch {
    return value;
  }
}

// ── Execution Plan Section ───────────────────────────────────

function ExecutionPlanSection({
  template,
  onSave,
  isPending,
}: {
  template: TemplateDetail;
  onSave: (plan: TemplateExecutionPlan) => void;
  isPending: boolean;
}) {
  const plan = template.execution_plan || {};
  const submodulesPerStep = plan.submodules_per_step || {};
  const entries = Object.entries(submodulesPerStep).sort(([a], [b]) => Number(a) - Number(b));

  // Fetch submodule names
  const { data: allSubmodules } = useQuery({
    queryKey: ['submodules-full'],
    queryFn: api.getSubmodulesFull,
  });

  const submoduleName = (id: string) => {
    const sub = (allSubmodules || []).find(s => s.id === id);
    return sub?.name || id;
  };

  if (entries.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Execution Plan</h3>
        <p className="text-xs text-gray-400">No execution plan. Will be populated when template is saved from a run.</p>
        <p className="text-[10px] text-gray-400 mt-1">Auto-execute is 12c scope — metadata only in 12b.</p>
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">Execution Plan</h3>
      <p className="text-[10px] text-gray-400 mb-2">Submodules used per step (metadata only — auto-execute in 12c)</p>
      <div className="space-y-1">
        {entries.map(([stepIdx, subs]) => (
          <div key={stepIdx} className="flex items-start gap-2 bg-gray-50 rounded px-3 py-1.5">
            <span className="text-[10px] text-gray-500 font-medium w-16 shrink-0">Step {stepIdx}</span>
            <div className="flex flex-wrap gap-1">
              {(subs as string[]).map(subId => (
                <span key={subId} className="text-[10px] bg-white border border-gray-200 rounded px-1.5 py-0.5 text-gray-600">
                  {submoduleName(subId)}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
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
