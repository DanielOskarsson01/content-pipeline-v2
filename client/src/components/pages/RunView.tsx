import { useEffect, useState } from 'react';
import { useParams, Link, Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useRunData, useApproveStep, useSkipStep, useReopenStep } from '../../hooks/useRun';
import { usePipelineStore } from '../../stores/pipelineStore';
import { usePanelStore } from '../../stores/panelStore';
import { useAppStore } from '../../stores/appStore';
import { STEP_CONFIG } from '../../config/stepConfig';
import { StepContainer } from '../steps/StepContainer';
import { Step0View } from '../steps/Step0View';
import { UniversalStepTemplate } from '../steps/UniversalStepTemplate';
import { queryClient } from '../../api/client';
import type { PipelineStage, ProjectWithRuns, DecisionLogEntry, AutoExecuteState } from '../../types/step';

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
            Run {runId.slice(0, 8)} · Step {run.current_step} of 10 · {
              run.status === 'auto_executing' ? 'Auto-Executing' :
              run.status === 'halted' ? 'Halted' :
              run.status
            }
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SaveAsTemplateButton runId={runId} />
          <Link
            to={`/projects/${projectId}/runs/${runId}/report`}
            className="text-sm text-brand-600 hover:text-brand-700"
          >
            Report
          </Link>
          <Link to="/projects" className="text-sm text-gray-500 hover:text-gray-700">
            ← Projects
          </Link>
        </div>
      </div>

      {run.status === 'auto_executing' && (
        <AutoExecuteBanner runId={runId} state={run.auto_execute_state} />
      )}
      {run.status === 'halted' && (
        <HaltedBanner runId={runId} state={run.auto_execute_state} />
      )}

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
              status={status as 'pending' | 'active' | 'completed' | 'skipped' | 'approved'}
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
                  runStatus={run.status}
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

function SaveAsTemplateButton({ runId }: { runId: string }) {
  const navigate = useNavigate();
  const { showToast } = useAppStore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [seedType, setSeedType] = useState<'csv' | 'url' | 'prompt'>('csv');

  const saveMutation = useMutation({
    mutationFn: (data: Parameters<typeof api.saveRunAsTemplate>[1]) =>
      api.saveRunAsTemplate(runId, data),
    onSuccess: (result) => {
      showToast(`Template "${result.template.name}" created`, 'success');
      setOpen(false);
      setName('');
      navigate(`/templates/${result.template.id}`);
    },
  });

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    saveMutation.mutate({ name: trimmed, seed_config: { seed_type: seedType } });
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-sm text-gray-500 hover:text-gray-700"
      >
        Save as Template
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Template name"
        className="bg-white border border-gray-300 rounded px-2 py-1 text-sm w-48 focus:outline-none focus:ring-1 focus:ring-sky-500"
        onKeyDown={(e) => e.key === 'Enter' && handleSave()}
        autoFocus
      />
      <select
        value={seedType}
        onChange={(e) => setSeedType(e.target.value as 'csv' | 'url' | 'prompt')}
        className="bg-white border border-gray-300 rounded px-1.5 py-1 text-xs text-gray-600"
      >
        <option value="csv">CSV</option>
        <option value="url">URL</option>
        <option value="prompt">Prompt</option>
      </select>
      <button
        onClick={handleSave}
        disabled={!name.trim() || saveMutation.isPending}
        className="px-2.5 py-1 text-xs bg-sky-600 text-white rounded hover:bg-sky-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
      >
        {saveMutation.isPending ? 'Saving...' : 'Save'}
      </button>
      <button
        onClick={() => { setOpen(false); setName(''); }}
        className="text-xs text-gray-400 hover:text-gray-600"
      >
        Cancel
      </button>
    </div>
  );
}

function AutoExecuteBanner({ runId, state }: { runId: string; state?: AutoExecuteState | null }) {
  const { showToast } = useAppStore();
  const abortMutation = useMutation({
    mutationFn: () => api.abortAutoExecute(runId),
    onSuccess: () => {
      showToast('Auto-execute aborted', 'info');
      queryClient.invalidateQueries({ queryKey: ['run', runId] });
    },
  });

  return (
    <div className="mb-3 flex items-center justify-between bg-indigo-50 border border-indigo-200 rounded-lg px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
        <span className="text-sm font-medium text-indigo-800">
          Auto-executing — Step {state?.current_step ?? '?'} in progress
        </span>
      </div>
      <button
        onClick={() => abortMutation.mutate()}
        disabled={abortMutation.isPending}
        className="px-3 py-1 text-xs font-medium text-red-600 bg-white border border-red-200 rounded hover:bg-red-50 disabled:opacity-50"
      >
        {abortMutation.isPending ? 'Aborting...' : 'Abort'}
      </button>
    </div>
  );
}

function HaltedBanner({ runId, state }: { runId: string; state?: AutoExecuteState | null }) {
  const { showToast } = useAppStore();
  const resumeMutation = useMutation({
    mutationFn: (config?: { override_threshold?: Record<string, number>; skip_step?: number }) =>
      api.resumeAutoExecute(runId, config),
    onSuccess: () => {
      showToast('Auto-execute resumed', 'success');
      queryClient.invalidateQueries({ queryKey: ['run', runId] });
    },
  });

  return (
    <div className="mb-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            <span className="text-sm font-medium text-amber-800">Halted at Step {state?.halted_step ?? '?'}</span>
          </div>
          {state?.halt_reason && (
            <p className="text-xs text-amber-600 mt-1 ml-4">{state.halt_reason}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => resumeMutation.mutate()}
            disabled={resumeMutation.isPending}
            className="px-3 py-1 text-xs font-medium text-white bg-amber-600 rounded hover:bg-amber-700 disabled:opacity-50"
          >
            {resumeMutation.isPending ? 'Resuming...' : 'Resume'}
          </button>
          <button
            onClick={() => resumeMutation.mutate({ skip_step: state?.halted_step })}
            disabled={resumeMutation.isPending || !state?.halted_step}
            className="px-3 py-1 text-xs font-medium text-amber-700 bg-white border border-amber-300 rounded hover:bg-amber-50 disabled:opacity-50"
          >
            Skip Step
          </button>
          <button
            onClick={() => {
              const step = state?.halted_step;
              if (step != null) resumeMutation.mutate({ override_threshold: { [step]: 1.0 } });
            }}
            disabled={resumeMutation.isPending || !state?.halted_step}
            className="px-3 py-1 text-xs font-medium text-amber-700 bg-white border border-amber-300 rounded hover:bg-amber-50 disabled:opacity-50"
          >
            Override Threshold
          </button>
        </div>
      </div>
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
