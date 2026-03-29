import { useState, useRef, type DragEvent } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useCreateProject } from '../../hooks/useProjects';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../api/client';
import type { Template, ProjectMode, TemplateSeedConfig } from '../../types/step';

const MODE_OPTIONS: { value: ProjectMode; label: string; description: string }[] = [
  { value: 'use_template', label: 'Use Template', description: 'Apply template config as-is' },
  { value: 'update_template', label: 'Update Template', description: 'Run & save changes back to template' },
  { value: 'new_template', label: 'New Template', description: 'Build a new template from this run' },
  { value: 'fork_template', label: 'Fork Template', description: 'Copy template, customize independently' },
  { value: 'single_run', label: 'Single Run', description: 'One-off project, no template link' },
];

export function NewProject() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { showToast } = useAppStore();
  const createProject = useCreateProject();

  const [name, setName] = useState('');
  const [intent, setIntent] = useState('');
  const [templateId, setTemplateId] = useState(searchParams.get('templateId') || '');
  const [mode, setMode] = useState<ProjectMode>('use_template');

  // Seed state
  const [seedFile, setSeedFile] = useState<File | null>(null);
  const [urlsText, setUrlsText] = useState('');
  const [promptText, setPromptText] = useState('');

  // Fetch templates for dropdown
  const { data: templates } = useQuery({
    queryKey: ['templates'],
    queryFn: api.getTemplates,
  });

  // Fetch selected template detail for preview
  const { data: templateDetail } = useQuery({
    queryKey: ['template', templateId],
    queryFn: () => api.getTemplate(templateId),
    enabled: !!templateId,
  });

  const seedConfig: TemplateSeedConfig = templateDetail?.seed_config || { seed_type: 'csv' };
  const seedType = seedConfig.seed_type || 'csv';
  const hasTemplate = !!templateId;

  // Launch mutation (template-based)
  const launchMutation = useMutation({
    mutationFn: async () => {
      if (!templateId) throw new Error('No template selected');

      if (seedType === 'csv') {
        if (!seedFile) throw new Error('Please upload a CSV file');
        const formData = new FormData();
        formData.append('project_name', name.trim());
        if (intent.trim()) formData.append('project_description', intent.trim());
        formData.append('mode', mode);
        formData.append('seed_file', seedFile);
        return api.launchTemplate(templateId, formData);
      }

      return api.launchTemplate(templateId, {
        project_name: name.trim(),
        project_description: intent.trim() || undefined,
        mode,
        urls: seedType === 'url' ? urlsText.trim() : undefined,
        prompt: seedType === 'prompt' ? promptText.trim() : undefined,
      });
    },
    onSuccess: (data) => {
      showToast(`Project "${name.trim()}" launched`, 'success');
      navigate(`/projects/${data.project.id}/runs/${data.run.id}`);
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : 'Launch failed', 'error');
    },
  });

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      showToast('Please enter a project name', 'error');
      return;
    }

    if (hasTemplate) {
      launchMutation.mutate();
    } else {
      createProject.mutate(
        { name: trimmed, intent: intent.trim() || undefined },
        {
          onSuccess: (data) => {
            showToast(`Project "${trimmed}" created`, 'success');
            navigate(`/projects/${data.project.id}/runs/${data.run.id}`);
          },
        }
      );
    }
  };

  const isPending = createProject.isPending || launchMutation.isPending;

  const hasSeedData =
    (seedType === 'csv' && !!seedFile) ||
    (seedType === 'url' && !!urlsText.trim()) ||
    (seedType === 'prompt' && !!promptText.trim());

  const canSubmit = !!name.trim() && !isPending && (!hasTemplate || hasSeedData);

  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-lg font-semibold text-gray-900 mb-6">New Project</h2>

      <div className="space-y-4">
        {/* Project Name */}
        <div>
          <label className="block text-xs text-gray-600 mb-1 font-medium">
            Project Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Nordic Operators Q1 2026"
            className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
            onKeyDown={(e) => e.key === 'Enter' && canSubmit && handleSubmit()}
          />
        </div>

        {/* Template Selection */}
        <div>
          <label className="block text-xs text-gray-600 mb-1 font-medium">Template</label>
          <select
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
          >
            <option value="">No template (blank project)</option>
            {(templates || []).map((t: Template) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.preset_count > 0 ? ` (${t.preset_count} presets)` : ''}
              </option>
            ))}
          </select>

          {/* Template preview */}
          {templateDetail && (
            <div className="mt-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              {templateDetail.description && (
                <p className="text-xs text-gray-500 mb-1">{templateDetail.description}</p>
              )}
              <div className="flex gap-3 text-[10px] text-gray-400">
                <span className="inline-flex items-center gap-1">
                  <SeedBadge seedType={seedType} />
                </span>
                <span>{templateDetail.preset_count} preset{templateDetail.preset_count !== 1 ? 's' : ''}</span>
                <span>{templateDetail.doc_count} doc{templateDetail.doc_count !== 1 ? 's' : ''}</span>
              </div>
            </div>
          )}

          <Link to="/templates" className="text-[10px] text-sky-600 hover:underline mt-1 inline-block">
            Manage templates
          </Link>
        </div>

        {/* Mode Selector (only when template selected) */}
        {hasTemplate && (
          <div>
            <label className="block text-xs text-gray-600 mb-1 font-medium">Mode</label>
            <div className="grid grid-cols-1 gap-1.5">
              {MODE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`flex items-start gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                    mode === opt.value
                      ? 'border-sky-500 bg-sky-50'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="mode"
                    value={opt.value}
                    checked={mode === opt.value}
                    onChange={() => setMode(opt.value)}
                    className="mt-0.5 accent-sky-600"
                  />
                  <div>
                    <span className="text-sm font-medium text-gray-900">{opt.label}</span>
                    <p className="text-[10px] text-gray-500">{opt.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Seed Input (only when template selected) */}
        {hasTemplate && (
          <div>
            <label className="block text-xs text-gray-600 mb-1 font-medium">
              Seed Data <span className="text-red-500">*</span>
              <span className="ml-1 text-gray-400 font-normal">({seedType})</span>
            </label>

            {seedType === 'csv' && (
              <CsvFileInput
                file={seedFile}
                onFileSelect={setSeedFile}
                requiredColumns={seedConfig.required_columns}
              />
            )}

            {seedType === 'url' && (
              <textarea
                value={urlsText}
                onChange={(e) => setUrlsText(e.target.value)}
                rows={4}
                placeholder="https://example.com&#10;https://another.com&#10;..."
                className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
              />
            )}

            {seedType === 'prompt' && (
              <textarea
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                rows={3}
                placeholder="Describe what you want to research..."
                className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
              />
            )}
          </div>
        )}

        {/* Intent (optional) */}
        <div>
          <label className="block text-xs text-gray-600 mb-1 font-medium">Description</label>
          <textarea
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            rows={2}
            placeholder="What is the goal of this project?"
            className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
          />
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={`w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            canSubmit
              ? 'bg-sky-600 hover:bg-sky-700 text-white'
              : 'bg-gray-300 text-gray-500 cursor-not-allowed'
          }`}
        >
          {isPending
            ? (hasTemplate ? 'Launching...' : 'Creating...')
            : (hasTemplate ? 'Launch from Template' : 'Create & Start Run')}
        </button>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────

function SeedBadge({ seedType }: { seedType: string }) {
  const colors: Record<string, string> = {
    csv: 'bg-emerald-100 text-emerald-700',
    url: 'bg-blue-100 text-blue-700',
    prompt: 'bg-purple-100 text-purple-700',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium uppercase ${colors[seedType] || 'bg-gray-100 text-gray-600'}`}>
      {seedType}
    </span>
  );
}

function CsvFileInput({
  file,
  onFileSelect,
  requiredColumns,
}: {
  file: File | null;
  onFileSelect: (f: File | null) => void;
  requiredColumns?: string[];
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped && dropped.name.endsWith('.csv')) {
      onFileSelect(dropped);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) onFileSelect(selected);
  };

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-lg px-4 py-6 text-center cursor-pointer transition-colors ${
          isDragging
            ? 'border-sky-400 bg-sky-50'
            : file
              ? 'border-emerald-300 bg-emerald-50'
              : 'border-gray-300 bg-white hover:border-gray-400'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          onChange={handleFileChange}
          className="hidden"
        />
        {file ? (
          <div>
            <p className="text-sm font-medium text-emerald-700">{file.name}</p>
            <p className="text-[10px] text-gray-500 mt-0.5">
              {(file.size / 1024).toFixed(1)} KB — click or drop to replace
            </p>
          </div>
        ) : (
          <div>
            <p className="text-sm text-gray-500">Drop CSV file here or click to browse</p>
            <p className="text-[10px] text-gray-400 mt-0.5">Supported: .csv</p>
          </div>
        )}
      </div>
      {requiredColumns && requiredColumns.length > 0 && (
        <p className="text-[10px] text-gray-400 mt-1">
          Required columns: {requiredColumns.join(', ')}
        </p>
      )}
      {file && (
        <button
          onClick={(e) => { e.stopPropagation(); onFileSelect(null); }}
          className="text-[10px] text-red-500 hover:underline mt-1"
        >
          Remove file
        </button>
      )}
    </div>
  );
}
