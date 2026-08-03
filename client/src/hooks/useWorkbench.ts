import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { CreateWorkbenchExperimentInput, RunWorkbenchChainInput } from '../types/step';

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
