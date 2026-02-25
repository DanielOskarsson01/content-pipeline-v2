import { useEffect, useState } from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useRunData, useApproveStep, useSkipStep, useReopenStep } from '../../hooks/useRun';
import { usePipelineStore } from '../../stores/pipelineStore';
import { usePanelStore } from '../../stores/panelStore';
import { STEP_CONFIG } from '../../config/stepConfig';
import { StepContainer } from '../steps/StepContainer';
import { Step0View } from '../steps/Step0View';
import { UniversalStepTemplate } from '../steps/UniversalStepTemplate';
import type { PipelineStage, ProjectWithRuns, DecisionLogEntry } from '../../types/step';

export function RunView() {
  const { projectId, runId } = useParams<{ projectId: string; runId: string }>();

  // Resolve "latest" to the actual latest run ID
  const { data: projectWithRuns } = useQuery({
    queryKey: ['project-with-runs', projectId],
    queryFn: () => api.getProject(projectId!) as Promise<ProjectWithRuns>,
    enabled: !!projectId && runId === 'latest',
  });

  if (runId === 'latest' && projectWithRuns?.runs?.length) {
    const latestRun = projectWithRuns.runs[0];
    return <Navigate to={`/projects/${projectId}/runs/${latestRun.id}`} replace />;
  }

  if (runId === 'latest') {
    return <div className="text-center py-12 text-gray-500 text-sm">Resolving latest run...</div>;
  }

  return <RunViewInner projectId={projectId!} runId={runId!} />;
}

function RunViewInner({ projectId, runId }: { projectId: string; runId: string }) {
  const { data: run, isLoading, error } = useRunData(runId);
  const { setExpandedStep } = usePipelineStore();
  const { resetPanel } = usePanelStore();

  // Reset panel state when navigating to a different run
  useEffect(() => { resetPanel(); }, [runId, resetPanel]);

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
    enabled: !!projectId,
  });

  // Known: isPending is shared across all steps — resolves when steps get per-step queries (Phase 4+)
  const approveStep = useApproveStep(runId);
  const skipStep = useSkipStep(runId);
  const reopenStep = useReopenStep(runId);

  // Auto-expand the active step when run data loads
  useEffect(() => {
    if (run?.stages) {
      const activeStage = run.stages.find((s: PipelineStage) => s.status === 'active');
      if (activeStage) {
        setExpandedStep(activeStage.step_index);
      }
    }
  }, [run?.stages, setExpandedStep]);

  if (isLoading) {
    return <div className="text-center py-12 text-gray-500 text-sm">Loading run...</div>;
  }

  if (error || !run) {
    return (
      <div className="text-center py-12">
        <p className="text-red-500 text-sm">{error?.message || 'Run not found'}</p>
        <Link to="/projects" className="text-brand-600 hover:underline text-sm mt-2 inline-block">
          Back to Projects
        </Link>
      </div>
    );
  }

  const stages: PipelineStage[] = run.stages || [];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            {project?.name || 'Loading...'}
          </h2>
          <p className="text-xs text-gray-500">
            Run {runId.slice(0, 8)} · Step {run.current_step} of 10 · {run.status}
          </p>
        </div>
        <Link to="/projects" className="text-sm text-gray-500 hover:text-gray-700">
          ← Projects
        </Link>
      </div>

      <div className="space-y-2">
        {STEP_CONFIG.map((stepCfg) => {
          const stage = stages.find((s) => s.step_index === stepCfg.index);
          const status = stage?.status || 'pending';

          return (
            <StepContainer
              key={stepCfg.index}
              step={stepCfg.index}
              title={stepCfg.name}
              description={stepCfg.description}
              status={status as 'pending' | 'active' | 'completed' | 'skipped'}
            >
              {stage && stepCfg.index === 0 && project ? (
                <Step0View
                  stage={stage}
                  project={project}
                  onApprove={() => approveStep.mutate(0)}
                  onSkip={() => skipStep.mutate(0)}
                  onReopen={() => reopenStep.mutate(0)}
                  isApproving={approveStep.isPending}
                  isSkipping={skipStep.isPending}
                  isReopening={reopenStep.isPending}
                />
              ) : stage ? (
                <UniversalStepTemplate
                  stage={stage}
                  projectId={projectId}
                  onApprove={() => approveStep.mutate(stepCfg.index)}
                  onSkip={() => skipStep.mutate(stepCfg.index)}
                  onReopen={() => reopenStep.mutate(stepCfg.index)}
                  isApproving={approveStep.isPending}
                  isSkipping={skipStep.isPending}
                  isReopening={reopenStep.isPending}
                />
              ) : null}
            </StepContainer>
          );
        })}
      </div>

      <DecisionLog runId={runId} />
    </div>
  );
}

function DecisionLog({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const { data: decisions } = useQuery({
    queryKey: ['decisions', runId],
    queryFn: () => api.getDecisions(runId),
    enabled: open,
  });

  const DECISION_LABELS: Record<string, string> = {
    approved: 'Submodule approved',
    step_approved: 'Step approved',
    step_skipped: 'Step skipped',
    step_reopened: 'Step reopened',
  };

  return (
    <div className="mt-4 border border-gray-200 rounded">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-gray-500 hover:bg-gray-50"
      >
        <span className="font-medium">Decision Log</span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-gray-200 max-h-60 overflow-auto">
          {!decisions || decisions.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-3">No decisions recorded yet</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-3 py-1.5 text-left text-gray-500 font-medium">Time</th>
                  <th className="px-3 py-1.5 text-left text-gray-500 font-medium">Step</th>
                  <th className="px-3 py-1.5 text-left text-gray-500 font-medium">Decision</th>
                  <th className="px-3 py-1.5 text-left text-gray-500 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((d: DecisionLogEntry) => {
                  const time = new Date(d.created_at).toLocaleString(undefined, {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  });
                  const details: string[] = [];
                  if (d.submodule_id) details.push(d.submodule_id);
                  if (d.context.approved_count != null) details.push(`${d.context.approved_count} approved`);
                  if (d.context.items_forwarded != null) details.push(`${d.context.items_forwarded} forwarded`);
                  if (d.context.pool_count != null) details.push(`pool: ${d.context.pool_count}`);

                  return (
                    <tr key={d.id} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-1.5 text-gray-400 whitespace-nowrap">{time}</td>
                      <td className="px-3 py-1.5 text-gray-600">{d.step_index}</td>
                      <td className="px-3 py-1.5 text-gray-700">{DECISION_LABELS[d.decision] || d.decision}</td>
                      <td className="px-3 py-1.5 text-gray-500 truncate max-w-[200px]">{details.join(' · ')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
