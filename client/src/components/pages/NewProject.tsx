import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useCreateProject } from '../../hooks/useProjects';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../api/client';
import type { Template } from '../../types/step';

export function NewProject() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { showToast } = useAppStore();
  const createProject = useCreateProject();

  const [name, setName] = useState('');
  const [intent, setIntent] = useState('');
  const [templateId, setTemplateId] = useState(searchParams.get('templateId') || '');

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

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      showToast('Please enter a project name', 'error');
      return;
    }

    createProject.mutate(
      { name: trimmed, intent: intent.trim() || undefined, template_id: templateId || undefined },
      {
        onSuccess: (data) => {
          showToast(`Project "${trimmed}" created`, 'success');
          navigate(`/projects/${data.project.id}/runs/${data.run.id}`);
        },
      }
    );
  };

  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-lg font-semibold text-gray-900 mb-6">New Project</h2>

      <div className="space-y-4">
        {/* Project Name (required) */}
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
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          />
        </div>

        {/* Template */}
        <div>
          <label className="block text-xs text-gray-600 mb-1 font-medium">Template</label>
          <select
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
          >
            <option value="">No template</option>
            {(templates || []).map((t: Template) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {templateDetail && (
            <div className="mt-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              {templateDetail.description && (
                <p className="text-xs text-gray-500 mb-1">{templateDetail.description}</p>
              )}
              <div className="flex gap-3 text-[10px] text-gray-400">
                <span>{templateDetail.presets.length} preset{templateDetail.presets.length !== 1 ? 's' : ''}</span>
                <span>{templateDetail.reference_docs.length} doc{templateDetail.reference_docs.length !== 1 ? 's' : ''}</span>
              </div>
              {templateDetail.presets.length > 0 && (
                <div className="mt-1.5 space-y-0.5">
                  {templateDetail.presets.map((p) => (
                    <p key={p.id} className="text-[10px] text-gray-500">
                      {p.submodule_id} / {p.option_name}: <span className="text-sky-600">{p.preset_name}</span>
                    </p>
                  ))}
                </div>
              )}
              {templateDetail.reference_docs.length > 0 && (
                <div className="mt-1.5 space-y-0.5">
                  {templateDetail.reference_docs.map((d) => (
                    <p key={d.id} className="text-[10px] text-gray-500">{d.filename}</p>
                  ))}
                </div>
              )}
            </div>
          )}
          <Link to="/templates" className="text-[10px] text-sky-600 hover:underline mt-1 inline-block">
            Manage templates
          </Link>
        </div>

        {/* Parent Project (disabled placeholder) */}
        <div>
          <label className="block text-xs text-gray-600 mb-1 font-medium">Parent Project</label>
          <select
            disabled
            className="w-full bg-gray-100 border border-gray-200 rounded-lg px-3 py-2 text-gray-400 text-sm cursor-not-allowed"
          >
            <option>Not available yet</option>
          </select>
        </div>

        {/* Intent (optional freeform) */}
        <div>
          <label className="block text-xs text-gray-600 mb-1 font-medium">Intent</label>
          <textarea
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            rows={2}
            placeholder="What is the goal of this project?"
            className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
          />
        </div>

        {/* Timing (disabled placeholder) */}
        <div>
          <label className="block text-xs text-gray-600 mb-1 font-medium">Timing</label>
          <select
            disabled
            className="w-full bg-gray-100 border border-gray-200 rounded-lg px-3 py-2 text-gray-400 text-sm cursor-not-allowed"
          >
            <option>Not available yet</option>
          </select>
        </div>

        {/* Create & Start Run */}
        <button
          onClick={handleSubmit}
          disabled={!name.trim() || createProject.isPending}
          className={`w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            name.trim() && !createProject.isPending
              ? 'bg-sky-600 hover:bg-sky-700 text-white'
              : 'bg-gray-300 text-gray-500 cursor-not-allowed'
          }`}
        >
          {createProject.isPending ? 'Creating...' : 'Create & Start Run'}
        </button>
      </div>
    </div>
  );
}
