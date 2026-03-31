import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useProjects, useDeleteProject } from '../../hooks/useProjects';
import { useAppStore } from '../../stores/appStore';
import { CreateDropdown } from '../shared/CreateDropdown';
import { api } from '../../api/client';
import type { Project, ProjectMode } from '../../types/step';

// Extended project type with enriched fields from GET /api/projects
interface ProjectListItem extends Project {
  template_name?: string | null;
  run_count?: number;
}

export function ProjectsList() {
  const navigate = useNavigate();
  const { data: projects = [], isLoading, error } = useProjects() as {
    data: ProjectListItem[] | undefined;
    isLoading: boolean;
    error: Error | null;
  };
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleModeSelect = (mode: ProjectMode) => {
    navigate(`/new?mode=${mode}`);
  };

  if (isLoading) {
    return <div className="text-center py-12 text-gray-500 text-sm">Loading projects...</div>;
  }

  if (error) {
    return (
      <div className="text-center py-12 text-red-500 text-sm">
        Failed to load projects: {error.message}
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 text-sm">No projects yet</p>
        <Link to="/new" className="text-sky-600 hover:underline text-sm mt-2 inline-block">
          Create your first project
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">Projects</h2>
        <CreateDropdown variant="inline" onSelect={handleModeSelect} />
      </div>

      <div className="space-y-2">
        {projects.map((project) => (
          <div key={project.id}>
            <ProjectRow
              project={project}
              isExpanded={expandedId === project.id}
              onToggle={() => setExpandedId(expandedId === project.id ? null : project.id)}
            />
            {expandedId === project.id && <ProjectDetailPanel project={project} />}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Project row ────────────────────────────────────────────

function ProjectRow({ project, isExpanded, onToggle }: {
  project: ProjectListItem;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteMutation = useDeleteProject();
  const showToast = useAppStore((s) => s.showToast);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    deleteMutation.mutate(project.id, {
      onSuccess: () => showToast(`Deleted "${project.name}"`, 'success'),
    });
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  };

  const timeAgo = getTimeAgo(project.created_at);

  return (
    <div
      onClick={onToggle}
      className={`bg-white border rounded-lg p-4 cursor-pointer transition-colors ${
        isExpanded ? 'border-sky-300 ring-1 ring-sky-100' : 'border-gray-200 hover:border-gray-300'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-gray-900">{project.name}</h3>
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-gray-400">
            <span>{project.template_name || 'Single run'}</span>
            <span>&middot;</span>
            <span>{project.run_count ?? 0} run{(project.run_count ?? 0) !== 1 ? 's' : ''}</span>
            <span>&middot;</span>
            <span>{timeAgo}</span>
          </div>
        </div>
        <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
          <span className={`text-[10px] px-2 py-0.5 rounded-full ${
            project.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
          }`}>
            {project.status}
          </span>
          {confirmDelete ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
                className="px-2 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded disabled:opacity-50"
              >
                {deleteMutation.isPending ? '...' : 'Confirm'}
              </button>
              <button onClick={handleCancelDelete} className="px-2 py-1 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded">
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={handleDelete}
              className="p-1 text-gray-300 hover:text-red-500 rounded hover:bg-red-50 transition-colors"
              title="Delete project"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
          <span className="text-gray-400 text-xs">{isExpanded ? '▲' : '▼'}</span>
        </div>
      </div>
    </div>
  );
}

// ── Project detail panel ───────────────────────────────────

interface ProjectDetailData extends Project {
  template_name?: string | null;
  runs?: Array<{
    id: string;
    status: string;
    current_step: number;
    started_at: string;
    completed_at: string | null;
    entity_count?: number;
    success_rate?: number;
  }>;
}

function ProjectDetailPanel({ project }: { project: ProjectListItem }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useAppStore();

  const { data: detail, isLoading } = useQuery({
    queryKey: ['project', project.id],
    queryFn: () => api.getProject(project.id) as Promise<ProjectDetailData>,
  });

  const createRunMutation = useMutation({
    mutationFn: () => api.createRun(project.id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', project.id] });
      showToast('New run created', 'success');
      navigate(`/projects/${project.id}/runs/${data.run.id}`);
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : 'Failed to create run', 'error');
    },
  });

  if (isLoading || !detail) {
    return (
      <div className="bg-gray-50 border border-t-0 border-gray-200 rounded-b-lg px-4 py-3 text-xs text-gray-400">
        Loading...
      </div>
    );
  }

  const runs = (detail as ProjectDetailData).runs || [];
  const latestRun = runs[0];

  return (
    <div className="bg-gray-50 border border-t-0 border-gray-200 rounded-b-lg px-4 py-3 space-y-3">
      {/* Meta */}
      <div className="flex gap-4 text-xs text-gray-500">
        {(detail as ProjectDetailData).template_name && (
          <span>Template: <span className="text-gray-700">{(detail as ProjectDetailData).template_name}</span></span>
        )}
        <span>Created: {new Date(detail.created_at).toLocaleDateString()}</span>
      </div>

      {/* Runs list */}
      {runs.length > 0 ? (
        <div>
          <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Runs</p>
          <div className="space-y-1">
            {runs.map((run) => (
              <Link
                key={run.id}
                to={`/projects/${project.id}/runs/${run.id}`}
                className="flex items-center justify-between bg-white border border-gray-200 rounded px-3 py-1.5 hover:border-gray-300 transition-colors"
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    run.status === 'completed' ? 'bg-green-500' :
                    run.status === 'running' ? 'bg-sky-500' :
                    run.status === 'auto_executing' ? 'bg-indigo-500' :
                    run.status === 'halted' ? 'bg-amber-500' :
                    run.status === 'failed' ? 'bg-red-500' : 'bg-gray-300'
                  }`} />
                  <span className="text-gray-700 font-medium">Step {run.current_step}</span>
                  <span className="text-gray-400">{run.status}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-gray-400">
                  {(run.entity_count ?? 0) > 0 && <span>{run.entity_count} entities</span>}
                  {(run.success_rate ?? 0) > 0 && <span>{run.success_rate}%</span>}
                  <span>{getTimeAgo(run.started_at)}</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-gray-400">No runs yet</p>
      )}

      {/* CTAs */}
      <div className="flex items-center gap-2 pt-1 border-t border-gray-200">
        {project.template_id ? (
          <button
            onClick={() => navigate(`/new?mode=use_template&projectId=${project.id}&templateId=${project.template_id}`)}
            className="px-3 py-1.5 bg-sky-600 hover:bg-sky-700 text-white text-xs rounded-lg transition-colors"
            disabled={createRunMutation.isPending}
          >
            New run in this project
          </button>
        ) : (
          <button
            onClick={() => createRunMutation.mutate()}
            className="px-3 py-1.5 bg-sky-600 hover:bg-sky-700 text-white text-xs rounded-lg transition-colors"
            disabled={createRunMutation.isPending}
          >
            {createRunMutation.isPending ? 'Creating...' : 'New run'}
          </button>
        )}
        {latestRun && (
          <Link
            to={`/projects/${project.id}/runs/${latestRun.id}/report`}
            className="px-3 py-1.5 bg-white border border-gray-300 hover:border-gray-400 text-gray-700 text-xs rounded-lg transition-colors"
          >
            View report
          </Link>
        )}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}
