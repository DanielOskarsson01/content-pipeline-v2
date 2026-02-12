import { Link } from 'react-router-dom';
import { useProjects } from '../../hooks/useProjects';
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
        </div>
      </div>
    </Link>
  );
}
