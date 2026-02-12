import { useEffect } from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useRunData, useApproveStep, useSkipStep } from '../../hooks/useRun';
import { usePipelineStore } from '../../stores/pipelineStore';
import { STEP_CONFIG } from '../../config/stepConfig';
import { StepContainer } from '../steps/StepContainer';
import { Step0View } from '../steps/Step0View';
import { UniversalStepTemplate } from '../steps/UniversalStepTemplate';
import type { PipelineStage, ProjectWithRuns } from '../../types/step';

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

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
    enabled: !!projectId,
  });

  // Known: isPending is shared across all steps — resolves when steps get per-step queries (Phase 4+)
  const approveStep = useApproveStep(runId);
  const skipStep = useSkipStep(runId);

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
                  isApproving={approveStep.isPending}
                  isSkipping={skipStep.isPending}
                />
              ) : stage ? (
                <UniversalStepTemplate
                  stage={stage}
                  onApprove={() => approveStep.mutate(stepCfg.index)}
                  onSkip={() => skipStep.mutate(stepCfg.index)}
                  isApproving={approveStep.isPending}
                  isSkipping={skipStep.isPending}
                />
              ) : null}
            </StepContainer>
          );
        })}
      </div>
    </div>
  );
}
