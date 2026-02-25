import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useProjects, useDeleteProject } from '../../hooks/useProjects';
import { useAppStore } from '../../stores/appStore';
import type { Project } from '../../types/step';

export function ProjectsList() {
  const { data: projects = [], isLoading, error } = useProjects();

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
        <Link to="/new" className="text-brand-600 hover:underline text-sm mt-2 inline-block">
          Create your first project
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">Projects</h2>
        <Link
          to="/new"
          className="px-3 py-1.5 bg-sky-600 hover:bg-sky-700 text-white text-sm rounded-lg font-medium transition-colors"
        >
          New Project
        </Link>
      </div>

      <div className="space-y-2">
        {projects.map((project) => (
          <ProjectRow key={project.id} project={project} />
        ))}
      </div>
    </div>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteMutation = useDeleteProject();
  const showToast = useAppStore((s) => s.showToast);

  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    deleteMutation.mutate(project.id, {
      onSuccess: () => {
        showToast(`Deleted "${project.name}"`, 'success');
      },
    });
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setConfirmDelete(false);
  };

  return (
    <Link
      to={`/projects/${project.id}/runs/latest`}
      className="block bg-white border border-gray-200 rounded-lg p-4 hover:border-gray-300 transition-colors"
    >
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-900">{project.name}</h3>
          {project.description && (
            <p className="text-xs text-gray-500 mt-0.5">{project.description}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className={`status-badge ${project.status === 'active' ? 'approved' : 'pending'}`}>
            {project.status}
          </span>
          <span className="text-xs text-gray-400">
            {new Date(project.created_at).toLocaleDateString()}
          </span>
          {confirmDelete ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
                className="px-2 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded disabled:opacity-50"
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Confirm'}
              </button>
              <button
                onClick={handleCancelDelete}
                className="px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded"
              >
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
        </div>
      </div>
    </Link>
  );
}
