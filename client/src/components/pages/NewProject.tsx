import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreateProject } from '../../hooks/useProjects';
import { useAppStore } from '../../stores/appStore';

export function NewProject() {
  const navigate = useNavigate();
  const { showToast } = useAppStore();
  const createProject = useCreateProject();

  const [name, setName] = useState('');
  const [intent, setIntent] = useState('');

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      showToast('Please enter a project name', 'error');
      return;
    }

    createProject.mutate(
      { name: trimmed, intent: intent.trim() || undefined },
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

        {/* Template (disabled placeholder) */}
        <div>
          <label className="block text-xs text-gray-600 mb-1 font-medium">Template</label>
          <select
            disabled
            className="w-full bg-gray-100 border border-gray-200 rounded-lg px-3 py-2 text-gray-400 text-sm cursor-not-allowed"
          >
            <option>Coming in v2</option>
          </select>
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
