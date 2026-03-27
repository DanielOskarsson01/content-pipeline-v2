import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { RunReport as RunReportType, RunReportStep } from '../../types/step';

export function RunReport() {
  const { projectId, runId } = useParams<{ projectId: string; runId: string }>();

  const { data: report, isLoading, error } = useQuery({
    queryKey: ['run-report', runId],
    queryFn: () => api.getRunReport(runId!),
    enabled: !!runId,
  });

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId!),
    enabled: !!projectId,
  });

  if (isLoading) {
    return <div className="text-center py-12 text-gray-500 text-sm">Loading report...</div>;
  }

  if (error || !report) {
    return (
      <div className="text-center py-12">
        <p className="text-red-500 text-sm">{error instanceof Error ? error.message : 'Failed to load report'}</p>
        <Link to={`/projects/${projectId}/runs/${runId}`} className="text-brand-600 hover:underline text-sm mt-2 inline-block">
          Back to Run
        </Link>
      </div>
    );
  }

  const { run, summary, steps } = report;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            {project?.name || 'Run'} — Report
          </h2>
          <p className="text-xs text-gray-500">
            Run {run.id.slice(0, 8)} · {run.status}
            {run.completed_at && ` · completed ${new Date(run.completed_at).toLocaleDateString()}`}
          </p>
        </div>
        <Link
          to={`/projects/${projectId}/runs/${runId}`}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← Back to Run
        </Link>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <SummaryCard label="Entities" value={summary.entities} />
        <SummaryCard label="Total Words" value={summary.total_words.toLocaleString()} />
        <SummaryCard label="Steps" value={`${summary.steps_completed} / ${summary.steps_total}`} />
        <SummaryCard
          label="Duration"
          value={summary.total_duration_ms > 0 ? formatDuration(summary.total_duration_ms) : '—'}
        />
      </div>

      {/* Per-step breakdown */}
      <div className="space-y-2">
        {steps.map((step) => (
          <StepRow key={step.step_index} step={step} />
        ))}
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg px-4 py-3">
      <p className="text-[10px] text-gray-400 uppercase tracking-wider">{label}</p>
      <p className="text-lg font-semibold text-gray-900 mt-0.5">{value}</p>
    </div>
  );
}

function StepRow({ step }: { step: RunReportStep }) {
  const [open, setOpen] = useState(false);

  const statusColors: Record<string, string> = {
    completed: 'bg-green-100 text-green-700',
    active: 'bg-blue-100 text-blue-700',
    skipped: 'bg-gray-100 text-gray-500',
    pending: 'bg-gray-50 text-gray-400',
  };

  return (
    <div className="border border-gray-200 rounded-lg bg-white">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-gray-400 w-4">{step.step_index}</span>
          <span className="text-sm font-medium text-gray-900">{step.step_name}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${statusColors[step.status] || statusColors.pending}`}>
            {step.status}
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs text-gray-500">
          {step.entities > 0 && <span>{step.entities} entities</span>}
          {step.items > 0 && <span>{step.items} items</span>}
          {step.words > 0 && <span>{step.words.toLocaleString()} words</span>}
          <svg
            className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {open && step.submodules.length > 0 && (
        <div className="border-t border-gray-100 px-4 py-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400">
                <th className="text-left py-1 font-medium">Submodule</th>
                <th className="text-right py-1 font-medium">Entities</th>
                <th className="text-right py-1 font-medium">Items</th>
                <th className="text-right py-1 font-medium">Words</th>
                <th className="text-right py-1 font-medium">Success</th>
              </tr>
            </thead>
            <tbody>
              {step.submodules.map((sub) => (
                <tr key={sub.submodule_id} className="border-t border-gray-50">
                  <td className="py-1.5 text-gray-700 font-medium">{sub.submodule_id}</td>
                  <td className="py-1.5 text-right text-gray-600">
                    {sub.completed}/{sub.total}
                    {sub.failed > 0 && <span className="text-red-500 ml-1">({sub.failed} failed)</span>}
                  </td>
                  <td className="py-1.5 text-right text-gray-600">{sub.items}</td>
                  <td className="py-1.5 text-right text-gray-600">{sub.words.toLocaleString()}</td>
                  <td className="py-1.5 text-right">
                    {sub.success_rate != null ? (
                      <span className={sub.success_rate >= 90 ? 'text-green-600' : sub.success_rate >= 50 ? 'text-yellow-600' : 'text-red-600'}>
                        {sub.success_rate}%
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Show errors if any */}
          {step.submodules.some((s) => s.errors.length > 0) && (
            <div className="mt-3 pt-2 border-t border-gray-100">
              <p className="text-[10px] text-red-500 font-medium mb-1">Errors</p>
              {step.submodules
                .filter((s) => s.errors.length > 0)
                .flatMap((s) =>
                  s.errors.map((e, i) => (
                    <p key={`${s.submodule_id}-${i}`} className="text-[10px] text-red-400 truncate">
                      {s.submodule_id} / {e.entity}: {e.error}
                    </p>
                  ))
                )}
            </div>
          )}
        </div>
      )}

      {open && step.submodules.length === 0 && (
        <div className="border-t border-gray-100 px-4 py-3">
          <p className="text-xs text-gray-400 text-center">No submodule data for this step</p>
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}
