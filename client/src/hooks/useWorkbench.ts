import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type {
  CreateWorkbenchExperimentInput, RunWorkbenchChainInput,
  AcceptExperimentInput, PromoteSettingsInput,
} from '../types/step';

export function useWorkbenchSourceRuns() {
  return useQuery({
    queryKey: ['workbench', 'source-runs'],
    queryFn: api.getWorkbenchSourceRuns,
  });
}

export function useWorkbenchSourceRun(runId: string | null) {
  return useQuery({
    queryKey: ['workbench', 'source-runs', runId],
    queryFn: () => api.getWorkbenchSourceRun(runId!),
    enabled: !!runId,
  });
}

export function useCreateWorkbenchExperiment() {
  return useMutation({
    mutationFn: (data: CreateWorkbenchExperimentInput) => api.createWorkbenchExperiment(data),
  });
}

export function usePinWorkbenchRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.pinWorkbenchRun(runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workbench', 'source-runs'] }),
  });
}

// ---- A2 forward chains ----

export function useRunWorkbenchChain() {
  return useMutation({
    mutationFn: (data: RunWorkbenchChainInput) => api.runWorkbenchChain(data),
  });
}

/** Polls the linked-list reconstruction while a chain POST is in flight. */
export function useWorkbenchChainTree(startExperimentId: string | null, polling: boolean) {
  return useQuery({
    queryKey: ['workbench', 'chains', startExperimentId],
    queryFn: () => api.getWorkbenchChainTree(startExperimentId!),
    enabled: !!startExperimentId && polling,
    refetchInterval: polling ? 3000 : false,
  });
}

// ---- Tuning sessions (T2/T3/T6) ----

export function useTuningSession(runId: string | null | undefined, entityName: string | null | undefined) {
  return useQuery({
    queryKey: ['tuning', 'session', runId, entityName],
    queryFn: () => api.getTuningSession(runId!, entityName!),
    enabled: !!runId && !!entityName,
  });
}

export function useTuningSummary(runId: string | null | undefined, entityName: string | null | undefined) {
  return useQuery({
    queryKey: ['tuning', 'summary', runId, entityName],
    queryFn: () => api.getTuningSummary(runId!, entityName!),
    enabled: !!runId && !!entityName,
  });
}

/** Accept invalidates both the accepted chain AND the summary for that (run, entity). */
export function useAcceptExperiment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: AcceptExperimentInput) => api.acceptExperiment(data),
    onSuccess: (_res, vars) => {
      queryClient.invalidateQueries({ queryKey: ['tuning', 'session', vars.source_run_id, vars.entity_name] });
      queryClient.invalidateQueries({ queryKey: ['tuning', 'summary', vars.source_run_id, vars.entity_name] });
    },
  });
}

export function usePromoteSettings() {
  return useMutation({
    mutationFn: (data: PromoteSettingsInput) => api.promoteSettings(data),
  });
}
