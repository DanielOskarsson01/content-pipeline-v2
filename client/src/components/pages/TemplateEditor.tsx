import { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAppStore } from '../../stores/appStore';
import type { TemplateDetail, TemplatePresetMapping, SubmoduleManifest, SubmoduleOption, OptionPreset } from '../../types/step';

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
    mutationFn: (data: { name?: string; description?: string }) => api.updateTemplate(templateId!, data),
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

      {/* Preset mappings + docs only shown in edit mode */}
      {isEdit && template && (
        <>
          <PresetMappingsSection template={template} />
          <ReferenceDocsSection template={template} />
        </>
      )}
    </div>
  );
}

// ── Preset Mappings Section ────────────────────────────────────

function PresetMappingsSection({ template }: { template: TemplateDetail }) {
  const queryClient = useQueryClient();
  const { showToast } = useAppStore();

  // Fetch all submodules with full detail to find preset-enabled options
  const { data: allSubmodules } = useQuery({
    queryKey: ['submodules-full'],
    queryFn: api.getSubmodulesFull,
  });

  // Find all submodules with preset-enabled options
  const presetOptions: { submodule: SubmoduleManifest; option: SubmoduleOption }[] = [];
  if (allSubmodules) {
    for (const sub of allSubmodules) {
      for (const opt of sub.options || []) {
        if (opt.presets_enabled) {
          presetOptions.push({ submodule: sub, option: opt });
        }
      }
    }
  }

  const addMutation = useMutation({
    mutationFn: (data: { submodule_id: string; option_name: string; preset_id: string }) =>
      api.addTemplatePreset(template.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['template', template.id] });
      showToast('Preset mapping added', 'success');
    },
  });

  const removeMutation = useMutation({
    mutationFn: (mappingId: string) => api.removeTemplatePreset(template.id, mappingId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['template', template.id] });
      showToast('Preset mapping removed', 'success');
    },
  });

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">Preset Mappings</h3>

      {/* Current mappings */}
      {template.presets.length > 0 && (
        <div className="space-y-1 mb-4">
          {template.presets.map((m: TemplatePresetMapping) => (
            <div key={m.id} className="flex items-center justify-between bg-gray-50 rounded px-3 py-2">
              <div>
                <span className="text-xs font-medium text-gray-700">{m.submodule_id}</span>
                <span className="text-gray-400 mx-1">/</span>
                <span className="text-xs text-gray-600">{m.option_name}</span>
                <span className="text-gray-400 mx-1">=</span>
                <span className="text-xs text-sky-600 font-medium">{m.preset_name}</span>
              </div>
              <button
                onClick={() => removeMutation.mutate(m.id)}
                className="text-xs text-gray-400 hover:text-red-500"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add new mapping */}
      {presetOptions.length > 0 ? (
        <PresetSelector
          presetOptions={presetOptions}
          existingMappings={template.presets}
          onAdd={(data) => addMutation.mutate(data)}
          isPending={addMutation.isPending}
        />
      ) : (
        <p className="text-xs text-gray-400">No submodule options with presets enabled</p>
      )}
    </div>
  );
}

function PresetSelector({
  presetOptions,
  existingMappings,
  onAdd,
  isPending,
}: {
  presetOptions: { submodule: SubmoduleManifest; option: SubmoduleOption }[];
  existingMappings: TemplatePresetMapping[];
  onAdd: (data: { submodule_id: string; option_name: string; preset_id: string }) => void;
  isPending: boolean;
}) {
  const [selectedOption, setSelectedOption] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState('');

  // Parse selected option
  const [selSubmoduleId, selOptionName] = selectedOption.split('::');

  // Fetch presets for selected option
  const { data: presetsData } = useQuery({
    queryKey: ['presets', selSubmoduleId, selOptionName],
    queryFn: () => api.getPresets(selSubmoduleId, selOptionName),
    enabled: !!selSubmoduleId && !!selOptionName,
  });

  const presets = presetsData?.presets || [];

  // Filter out options that already have a mapping
  const availableOptions = presetOptions.filter(
    (po) => !existingMappings.some((m) => m.submodule_id === po.submodule.id && m.option_name === po.option.name)
  );

  return (
    <div className="flex gap-2 items-end">
      <div className="flex-1">
        <label className="block text-[10px] text-gray-400 mb-1">Option</label>
        <select
          value={selectedOption}
          onChange={(e) => { setSelectedOption(e.target.value); setSelectedPresetId(''); }}
          className="w-full bg-white border border-gray-300 rounded px-2 py-1.5 text-xs"
        >
          <option value="">Select option...</option>
          {availableOptions.map((po) => (
            <option key={`${po.submodule.id}::${po.option.name}`} value={`${po.submodule.id}::${po.option.name}`}>
              {po.submodule.name} / {po.option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex-1">
        <label className="block text-[10px] text-gray-400 mb-1">Preset</label>
        <select
          value={selectedPresetId}
          onChange={(e) => setSelectedPresetId(e.target.value)}
          disabled={!selectedOption || presets.length === 0}
          className="w-full bg-white border border-gray-300 rounded px-2 py-1.5 text-xs disabled:bg-gray-100"
        >
          <option value="">{presets.length === 0 && selectedOption ? 'No presets' : 'Select preset...'}</option>
          {presets.map((p: OptionPreset) => (
            <option key={p.id} value={p.id}>{p.preset_name}</option>
          ))}
        </select>
      </div>
      <button
        onClick={() => {
          if (selSubmoduleId && selOptionName && selectedPresetId) {
            onAdd({ submodule_id: selSubmoduleId, option_name: selOptionName, preset_id: selectedPresetId });
            setSelectedOption('');
            setSelectedPresetId('');
          }
        }}
        disabled={!selectedPresetId || isPending}
        className="px-3 py-1.5 text-xs bg-sky-600 text-white rounded hover:bg-sky-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
      >
        Add
      </button>
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
