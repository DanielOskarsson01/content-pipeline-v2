import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAppStore } from '../../stores/appStore';
import { CreateDropdown } from '../shared/CreateDropdown';
import { SeedBadge } from '../shared/SeedBadge';
import { STEP_CONFIG } from '../../config/stepConfig';
import type { Template, ProjectMode } from '../../types/step';

export function TemplatesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useAppStore();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: templates, isLoading } = useQuery({
    queryKey: ['templates'],
    queryFn: api.getTemplates,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteTemplate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      showToast('Template deleted', 'success');
      setConfirmDelete(null);
      setExpandedId(null);
    },
  });

  const handleModeSelect = (mode: ProjectMode) => {
    navigate(`/new?mode=${mode}`);
  };

  if (isLoading) {
    return <div className="text-center py-12 text-gray-500 text-sm">Loading templates...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-gray-900">Templates</h2>
        <CreateDropdown variant="inline" onSelect={handleModeSelect} />
      </div>

      {!templates?.length ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-12 text-center">
          <p className="text-gray-400 text-sm mb-3">No templates yet</p>
          <Link to="/templates/new" className="text-sky-600 hover:underline text-sm">
            Create your first template
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map((t: Template) => (
            <div key={t.id}>
              {/* Row */}
              <div
                onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                className={`bg-white border rounded-lg px-4 py-3 flex items-center justify-between cursor-pointer transition-colors ${
                  expandedId === t.id ? 'border-sky-300 ring-1 ring-sky-100' : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-gray-900">{t.name}</span>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {t.description ? `${t.description}. ` : ''}
                    {(() => {
                      const skip = t.execution_plan?.skip_steps || [];
                      const active = STEP_CONFIG.filter(s => s.index >= 1 && s.index <= 8 && !skip.includes(s.index));
                      if (active.length === 8) return 'Steps 1-8.';
                      return `Steps ${active.map(s => s.index).join(', ')}.`;
                    })()}
                    <span className="ml-2 inline-flex items-center"><SeedBadge seedType={t.seed_config?.seed_type || 'csv'} /></span>
                    {(t.usage_count ?? 0) > 0 && (
                      <span className="ml-2 text-gray-400">Used {t.usage_count} time{t.usage_count !== 1 ? 's' : ''}</span>
                    )}
                  </p>
                </div>

                <div className="flex items-center gap-2 ml-4" onClick={(e) => e.stopPropagation()}>
                  {confirmDelete === t.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => deleteMutation.mutate(t.id)}
                        className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="px-2 py-1 text-xs text-gray-400 hover:bg-gray-100 rounded"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(t.id)}
                      className="px-2 py-1 text-xs text-gray-400 hover:text-red-500 rounded transition-colors"
                    >
                      Delete
                    </button>
                  )}
                  <span className="text-gray-400 text-xs">{expandedId === t.id ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* Inline detail panel */}
              {expandedId === t.id && <TemplateDetailPanel templateId={t.id} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Detail panel (lazy-loaded) ─────────────────────────────

function TemplateDetailPanel({ templateId }: { templateId: string }) {
  const navigate = useNavigate();

  const { data: detail, isLoading } = useQuery({
    queryKey: ['template', templateId],
    queryFn: () => api.getTemplate(templateId),
  });

  if (isLoading || !detail) {
    return (
      <div className="bg-gray-50 border border-t-0 border-gray-200 rounded-b-lg px-4 py-3 text-xs text-gray-400">
        Loading...
      </div>
    );
  }

  const presetEntries = Object.entries(detail.preset_map || {});

  const handleCta = (mode: ProjectMode) => {
    navigate(`/new?mode=${mode}&templateId=${templateId}`);
  };

  const skipSteps = detail.execution_plan?.skip_steps || [];
  // Steps 1-8 for the flow display (skip step 0 = Project Start)
  const flowSteps = STEP_CONFIG.filter(s => s.index >= 1 && s.index <= 8);

  return (
    <div className="bg-gray-50 border border-t-0 border-gray-200 rounded-b-lg px-4 py-4 space-y-4">
      {/* Header: name + description */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900">{detail.name}</h3>
        {detail.description && (
          <p className="text-xs text-gray-500 mt-0.5">{detail.description}</p>
        )}
      </div>

      {/* Seed config */}
      <div>
        <p className="text-[10px] text-gray-500 uppercase tracking-wide font-medium mb-1">Seed Config</p>
        <div className="flex items-center gap-2 text-xs text-gray-600">
          <SeedBadge seedType={detail.seed_config?.seed_type || 'csv'} />
          {detail.seed_config?.required_columns?.length ? (
            <span>Required: {detail.seed_config.required_columns.join(', ')}</span>
          ) : null}
        </div>
      </div>

      {/* Step flow */}
      <div>
        <p className="text-[10px] text-gray-500 uppercase tracking-wide font-medium mb-1">Step Flow</p>
        <div className="flex flex-wrap items-center gap-1">
          {flowSteps.map((step, i) => {
            const isSkipped = skipSteps.includes(step.index);
            return (
              <span key={step.index} className="flex items-center gap-1">
                <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                  isSkipped
                    ? 'bg-gray-100 text-gray-400 line-through'
                    : 'bg-green-50 text-green-700 border border-green-200'
                }`}>
                  {step.index} {step.name}
                </span>
                {i < flowSteps.length - 1 && (
                  <span className="text-gray-300 text-[10px]">&gt;</span>
                )}
              </span>
            );
          })}
        </div>
      </div>

      {/* Preset map */}
      {presetEntries.length > 0 && (
        <div>
          <p className="text-[10px] text-gray-500 uppercase tracking-wide font-medium mb-1">Preset Map</p>
          <div className="space-y-1">
            {presetEntries.map(([subId, entry]) => (
              <div key={subId} className="flex items-center justify-between bg-white border border-gray-200 rounded px-3 py-1.5">
                <span className="text-xs font-medium text-gray-700">{subId}</span>
                <span className="text-xs text-sky-600 font-medium">{entry.preset_name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reference docs */}
      {detail.reference_docs?.length > 0 && (
        <div>
          <p className="text-[10px] text-gray-500 uppercase tracking-wide font-medium mb-1">Reference Docs</p>
          <div className="flex flex-wrap gap-1">
            {detail.reference_docs.map((doc) => (
              <span key={doc.id} className="text-[11px] bg-white border border-gray-200 px-1.5 py-0.5 rounded">
                {doc.filename}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* CTAs */}
      <div className="flex items-center gap-2 pt-2 border-t border-gray-200">
        <button onClick={() => handleCta('use_template')} className="px-4 py-1.5 bg-sky-600 hover:bg-sky-700 text-white text-xs font-medium rounded-lg transition-colors">
          Use
        </button>
        <button onClick={() => handleCta('update_template')} className="px-4 py-1.5 bg-white border border-gray-300 hover:border-gray-400 text-gray-700 text-xs font-medium rounded-lg transition-colors">
          Change
        </button>
        <button onClick={() => handleCta('fork_template')} className="px-4 py-1.5 bg-white border border-gray-300 hover:border-gray-400 text-gray-700 text-xs font-medium rounded-lg transition-colors">
          Fork
        </button>
        <div className="flex-1" />
        <Link to={`/templates/${templateId}`} className="text-xs text-gray-500 hover:text-gray-700">
          Edit
        </Link>
      </div>
    </div>
  );
}
