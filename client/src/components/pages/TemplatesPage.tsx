import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAppStore } from '../../stores/appStore';
import type { Template } from '../../types/step';

export function TemplatesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useAppStore();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

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
    },
  });

  if (isLoading) {
    return <div className="text-center py-12 text-gray-500 text-sm">Loading templates...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-gray-900">Templates</h2>
        <Link
          to="/templates/new"
          className="px-3 py-1.5 bg-sky-600 hover:bg-sky-700 text-white text-sm rounded-lg transition-colors"
        >
          New Template
        </Link>
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
            <div
              key={t.id}
              className="bg-white border border-gray-200 rounded-lg px-4 py-3 flex items-center justify-between hover:border-gray-300 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <Link
                  to={`/templates/${t.id}`}
                  className="text-sm font-medium text-gray-900 hover:text-sky-600"
                >
                  {t.name}
                </Link>
                {t.description && (
                  <p className="text-xs text-gray-500 truncate mt-0.5">{t.description}</p>
                )}
                <div className="flex gap-3 mt-1 text-[10px] text-gray-400">
                  <span>{t.preset_count} preset{t.preset_count !== 1 ? 's' : ''}</span>
                  <span>{t.doc_count} doc{t.doc_count !== 1 ? 's' : ''}</span>
                </div>
              </div>

              <div className="flex items-center gap-2 ml-4">
                <button
                  onClick={() => navigate(`/new?templateId=${t.id}`)}
                  className="px-2 py-1 text-xs text-sky-600 hover:bg-sky-50 rounded transition-colors"
                >
                  Use
                </button>
                <Link
                  to={`/templates/${t.id}`}
                  className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded transition-colors"
                >
                  Edit
                </Link>
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
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
