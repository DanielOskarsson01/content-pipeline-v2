import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useCreateProject } from '../../hooks/useProjects';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../api/client';
import { CreateDropdown } from '../shared/CreateDropdown';
import { SeedBadge } from '../shared/SeedBadge';
import { CsvUploadInput } from '../primitives/CsvUploadInput';
import { UrlTextarea, parseTextareaToEntities } from '../primitives/UrlTextarea';
import type { Template, TemplateDetail, ProjectMode, TemplateSeedConfig, SeedPreviewResult } from '../../types/step';

// ── Mode metadata ──────────────────────────────────────────

const MODE_LABELS: Record<ProjectMode, string> = {
  single_run: 'Single run',
  use_template: 'Use template',
  update_template: 'Change template',
  new_template: 'New template',
  fork_template: 'Fork template',
};

const NEEDS_TEMPLATE: ProjectMode[] = ['use_template', 'update_template', 'fork_template'];
const SEEDLESS_MODES: ProjectMode[] = ['update_template', 'fork_template', 'new_template'];

// ── Main component ─────────────────────────────────────────

export function NewProject() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { showToast } = useAppStore();
  const createProject = useCreateProject();

  // URL params for deep linking
  const paramMode = searchParams.get('mode') as ProjectMode | null;
  const paramTemplateId = searchParams.get('templateId') || '';
  const paramProjectId = searchParams.get('projectId') || '';

  // State
  const [mode, setMode] = useState<ProjectMode | null>(paramMode);
  const [templateId, setTemplateId] = useState(paramTemplateId);
  const [projectName, setProjectName] = useState('');
  const [description, setDescription] = useState('');
  const [forkName, setForkName] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');

  // Seed state (use_template only)
  const [seedTab, setSeedTab] = useState<'file' | 'url'>('file');
  const [seedFile, setSeedFile] = useState<File | null>(null);
  const [seedPreview, setSeedPreview] = useState<SeedPreviewResult | null>(null);
  const [urlsText, setUrlsText] = useState('');
  const [promptText, setPromptText] = useState('');
  const [isNewTemplateSubmitting, setIsNewTemplateSubmitting] = useState(false);

  // Queries
  const { data: templates } = useQuery({
    queryKey: ['templates'],
    queryFn: api.getTemplates,
  });

  const { data: templateDetail } = useQuery({
    queryKey: ['template', templateId],
    queryFn: () => api.getTemplate(templateId),
    enabled: !!templateId,
  });

  // Fetch project if deep-linked from project detail
  const { data: linkedProject } = useQuery({
    queryKey: ['project', paramProjectId],
    queryFn: () => api.getProject(paramProjectId),
    enabled: !!paramProjectId,
  });

  // Auto-fill from linked project
  useEffect(() => {
    if (linkedProject && !projectName) {
      setProjectName(linkedProject.name);
      if (linkedProject.template_id && !templateId) {
        setTemplateId(linkedProject.template_id);
      }
    }
  }, [linkedProject]); // eslint-disable-line react-hooks/exhaustive-deps

  const seedConfig: TemplateSeedConfig = templateDetail?.seed_config || { seed_type: 'csv' };
  const seedType = seedConfig.seed_type || 'csv';

  // Default seed tab to template's seed_type when template loads
  useEffect(() => {
    setSeedTab(seedType === 'url' || seedType === 'prompt' ? 'url' : 'file');
  }, [seedType]);

  const needsTemplate = mode ? NEEDS_TEMPLATE.includes(mode) : false;
  const isSeedless = mode ? SEEDLESS_MODES.includes(mode) : false;

  // Mode selection handler
  const handleModeSelect = (selected: ProjectMode) => {
    setMode(selected);
    // Reset template if switching to non-template mode
    if (!NEEDS_TEMPLATE.includes(selected) && selected !== 'new_template') {
      // keep templateId for new_template (not needed but harmless)
    }
  };

  // ── Submit logic ───────────────────────────────────────────

  const launchMutation = useMutation({
    mutationFn: async () => {
      if (!templateId) throw new Error('No template selected');
      if (!mode) throw new Error('No mode selected');

      const name = projectName.trim();

      // use_template with file seed
      if (mode === 'use_template' && seedTab === 'file') {
        if (!seedFile) throw new Error('Please upload a CSV or Excel file');
        const formData = new FormData();
        formData.append('project_name', name);
        if (description.trim()) formData.append('project_description', description.trim());
        formData.append('mode', mode);
        formData.append('file', seedFile);
        if (paramProjectId) formData.append('project_id', paramProjectId);
        return api.launchTemplate(templateId, formData);
      }

      // use_template with URL seed
      if (mode === 'use_template' && seedTab === 'url') {
        if (!urlsText.trim()) throw new Error('Please enter at least one URL');
        return api.launchTemplate(templateId, {
          project_name: name,
          project_description: description.trim() || undefined,
          mode,
          urls: urlsText.trim(),
          project_id: paramProjectId || undefined,
        });
      }

      // All other template modes
      return api.launchTemplate(templateId, {
        project_name: name,
        project_description: description.trim() || undefined,
        mode,
        fork_name: mode === 'fork_template' ? forkName.trim() || undefined : undefined,
        project_id: paramProjectId || undefined,
      });
    },
    onSuccess: (data) => {
      showToast(`Project launched`, 'success');
      navigate(`/projects/${data.project.id}/runs/${data.run.id}`);
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : 'Launch failed', 'error');
    },
  });

  const handleSubmit = () => {
    if (!mode) return;

    if (mode === 'single_run') {
      const name = projectName.trim();
      if (!name) { showToast('Please enter a project name', 'error'); return; }
      createProject.mutate(
        { name, intent: description.trim() || undefined, mode: 'single_run' },
        {
          onSuccess: (data) => {
            showToast(`Project "${name}" created`, 'success');
            navigate(`/projects/${data.project.id}/runs/${data.run.id}`);
          },
        },
      );
      return;
    }

    if (mode === 'new_template') {
      const tplName = templateName.trim();
      if (!tplName) { showToast('Please enter a template name', 'error'); return; }
      setIsNewTemplateSubmitting(true);
      api.createTemplate({ name: tplName, description: templateDescription.trim() || undefined })
        .then(({ template }) => {
          setTemplateId(template.id);
          return api.launchTemplate(template.id, {
            project_name: projectName.trim() || `${tplName} test`,
            project_description: description.trim() || undefined,
            mode: 'new_template',
          });
        })
        .then((data) => {
          showToast('Template and project created', 'success');
          navigate(`/projects/${data.project.id}/runs/${data.run.id}`);
        })
        .catch((err) => showToast(err instanceof Error ? err.message : 'Failed', 'error'))
        .finally(() => setIsNewTemplateSubmitting(false));
      return;
    }

    // Template-based modes
    if (!templateId) { showToast('Please select a template', 'error'); return; }
    if (!projectName.trim()) { showToast('Please enter a project name', 'error'); return; }

    if (mode === 'use_template') {
      const hasSeed =
        (seedTab === 'file' && !!seedFile) ||
        (seedTab === 'url' && !!urlsText.trim());
      if (!hasSeed) { showToast('Please provide seed data', 'error'); return; }
    }

    if (mode === 'fork_template' && !forkName.trim()) {
      showToast('Please enter a name for the new template', 'error');
      return;
    }

    launchMutation.mutate();
  };

  const isPending = createProject.isPending || launchMutation.isPending || isNewTemplateSubmitting;

  // ── Render ─────────────────────────────────────────────────

  // No mode selected → show hero dropdown
  if (!mode) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <h2 className="text-2xl font-semibold text-gray-900 mb-2">Create a project</h2>
        <p className="text-sm text-gray-500 mb-8">Choose how you want to start</p>
        <CreateDropdown variant="hero" onSelect={handleModeSelect} />
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      {/* Header with back button */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => setMode(null)} className="text-gray-400 hover:text-gray-600 text-sm">
          &larr;
        </button>
        <h2 className="text-lg font-semibold text-gray-900">{MODE_LABELS[mode]}</h2>
      </div>

      <div className="space-y-4">
        {/* ── Template selector (for modes that need one) ── */}
        {needsTemplate && (
          <div>
            <label className="block text-xs text-gray-600 mb-1 font-medium">
              {mode === 'fork_template' ? 'Source template' : 'Template'} <span className="text-red-500">*</span>
            </label>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
            >
              <option value="">Select a template...</option>
              {(templates || []).map((t: Template) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            {templateDetail && <TemplatePreviewCard detail={templateDetail} seedType={seedType} />}
          </div>
        )}

        {/* ── Fork: new template name ── */}
        {mode === 'fork_template' && (
          <div>
            <label className="block text-xs text-gray-600 mb-1 font-medium">
              New template name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={forkName}
              onChange={(e) => setForkName(e.target.value)}
              placeholder="e.g. Company Profile (iGaming)"
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
            />
          </div>
        )}

        {/* ── New template: template name + description ── */}
        {mode === 'new_template' && (
          <>
            <div>
              <label className="block text-xs text-gray-600 mb-1 font-medium">
                Template name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="e.g. Company Profile Research"
                className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1 font-medium">
                Template description <span className="text-red-500">*</span>
              </label>
              <textarea
                value={templateDescription}
                onChange={(e) => setTemplateDescription(e.target.value)}
                rows={2}
                placeholder="What does this template do?"
                className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>
          </>
        )}

        {/* ── Project name ── */}
        <div>
          <label className="block text-xs text-gray-600 mb-1 font-medium">
            Project name {mode !== 'new_template' && <span className="text-red-500">*</span>}
          </label>
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder={mode === 'new_template' ? `Defaults to "{template name} test"` : 'e.g. Nordic Operators Q1 2026'}
            className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
          />
        </div>

        {/* ── Description ── */}
        <div>
          <label className="block text-xs text-gray-600 mb-1 font-medium">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What is the goal of this project?"
            className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
          />
        </div>

        {/* ── Seed input (use_template only) ── */}
        {mode === 'use_template' && templateId && (
          <div>
            <label className="block text-xs text-gray-600 mb-1 font-medium">
              Seed data <span className="text-red-500">*</span>
            </label>

            {/* Tab toggle */}
            <div className="flex gap-1 mb-2">
              <button
                type="button"
                onClick={() => setSeedTab('file')}
                className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${
                  seedTab === 'file' ? 'bg-gray-200 text-gray-900' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                Upload file
              </button>
              <button
                type="button"
                onClick={() => setSeedTab('url')}
                className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${
                  seedTab === 'url' ? 'bg-gray-200 text-gray-900' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                Paste URLs or data
              </button>
            </div>

            {seedTab === 'file' && (
              <>
                <CsvUploadInput
                  uploadUrl="/api/seed/preview"
                  onUploadComplete={(result) => setSeedPreview(result as unknown as SeedPreviewResult)}
                  onFileSelected={(file) => setSeedFile(file)}
                  onError={(msg) => showToast(msg, 'error')}
                  currentFileName={seedPreview?.filename || null}
                  currentEntityCount={seedPreview?.entity_count || 0}
                  requiredColumns={seedConfig.required_columns || []}
                />
                {seedPreview && (
                  <EntityPreview
                    entities={seedPreview.entities}
                    total={seedPreview.entity_count}
                    truncated={seedPreview.truncated}
                  />
                )}
              </>
            )}

            {seedTab === 'url' && (
              <>
                <UrlTextarea value={urlsText} onChange={setUrlsText} />
                {urlsText.trim() && (
                  <EntityPreview
                    entities={parseTextareaToEntities(urlsText, 'website').map(e => ({ name: (e.name as string) || '', ...e }))}
                    total={parseTextareaToEntities(urlsText, 'website').length}
                    truncated={false}
                  />
                )}
              </>
            )}
          </div>
        )}

        {/* ── Info note for seedless modes ── */}
        {isSeedless && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5 text-xs text-blue-700">
            {mode === 'update_template' && 'Seed upload happens in Step 1 inside the run. Changes to presets, prompts, and settings are saved back to the template on completion.'}
            {mode === 'fork_template' && 'Seed upload happens in Step 1 inside the run. Changes saved as a new template, original untouched.'}
            {mode === 'new_template' && 'No seed upload here. Creates the template and a project. Configure steps, submodules, presets, and upload seed inside the run.'}
          </div>
        )}

        {/* ── Defaults panel (single_run and new_template) ── */}
        {(mode === 'single_run' || mode === 'new_template') && <DefaultsPanel />}

        {/* ── Review box (use_template with seed) ── */}
        {mode === 'use_template' && templateDetail && seedPreview && (
          <ReviewBox
            templateName={templateDetail.name}
            projectName={projectName}
            entityCount={seedPreview.entity_count}
            truncated={seedPreview.truncated}
            seedType={seedType}
          />
        )}

        {/* ── Submit ── */}
        <button
          onClick={handleSubmit}
          disabled={isPending}
          className={`w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            !isPending
              ? 'bg-sky-600 hover:bg-sky-700 text-white'
              : 'bg-gray-300 text-gray-500 cursor-not-allowed'
          }`}
        >
          {isPending ? 'Creating...' : (
            mode === 'single_run' ? 'Create and start run' :
            mode === 'new_template' ? 'Create template and run' :
            mode === 'use_template' ? 'Save and run' :
            'Create run'
          )}
        </button>
      </div>
    </div>
  );
}

// ── Inline sub-components ──────────────────────────────────

function TemplatePreviewCard({ detail, seedType }: { detail: TemplateDetail; seedType: string }) {
  return (
    <div className="mt-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
      {detail.description && (
        <p className="text-xs text-gray-500 mb-1">{detail.description}</p>
      )}
      <div className="flex gap-3 text-[10px] text-gray-400 items-center">
        <SeedBadge seedType={seedType} />
        <span>{detail.preset_count} preset{detail.preset_count !== 1 ? 's' : ''}</span>
        <span>{detail.doc_count} doc{detail.doc_count !== 1 ? 's' : ''}</span>
      </div>
    </div>
  );
}

function DefaultsPanel() {
  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5">
      <p className="text-xs font-medium text-gray-700 mb-1.5">Defaults</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-gray-500">
        <span>Steps</span><span className="text-gray-700">1-8 (all)</span>
        <span>Submodules</span><span className="text-gray-700">All defaults per step</span>
        <span>Presets</span><span className="text-gray-700">System defaults</span>
        <span>Seed type</span><span className="text-gray-700">CSV</span>
        <span>Thresholds</span><span className="text-gray-700">Standard per-step</span>
      </div>
      <p className="text-[10px] text-gray-400 mt-1.5">Configure in run after creation</p>
    </div>
  );
}

function ReviewBox({ templateName, projectName, entityCount, truncated, seedType }: {
  templateName: string;
  projectName: string;
  entityCount: number;
  truncated: boolean;
  seedType: string;
}) {
  return (
    <div className="bg-sky-50 border border-sky-200 rounded-lg px-3 py-2.5">
      <p className="text-xs font-medium text-sky-800 mb-1.5">Review</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        <span className="text-sky-600">Template</span><span className="text-sky-900">{templateName}</span>
        <span className="text-sky-600">Project</span><span className="text-sky-900">{projectName || '(unnamed)'}</span>
        <span className="text-sky-600">Seed</span>
        <span className="text-sky-900">
          {truncated ? `~${entityCount}` : entityCount} entities ({seedType})
        </span>
      </div>
    </div>
  );
}

function EntityPreview({ entities, total, truncated }: {
  entities: Array<{ name: string; [key: string]: unknown }>;
  total: number;
  truncated: boolean;
}) {
  const show = entities.slice(0, 5);
  const remaining = total - show.length;

  if (show.length === 0) return null;

  return (
    <div className="mt-2 text-[11px] text-gray-600">
      <div className="flex flex-wrap gap-1">
        {show.map((e, i) => (
          <span key={i} className="bg-gray-100 px-1.5 py-0.5 rounded">{e.name}</span>
        ))}
      </div>
      {remaining > 0 && (
        <p className="text-gray-400 mt-1">
          {truncated ? `... and ~${remaining} more` : `... and ${remaining} more`}
        </p>
      )}
    </div>
  );
}
