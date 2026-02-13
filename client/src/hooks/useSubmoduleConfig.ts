import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { SubmoduleConfig } from '../types/step';

/**
 * Fetch saved config for a submodule in a run/step.
 * Returns defaults (all nulls) if no config saved yet.
 */
export function useSubmoduleConfig(runId: string | undefined, stepIndex: number, submoduleId: string | null) {
  return useQuery<SubmoduleConfig>({
    queryKey: ['submoduleConfig', runId, stepIndex, submoduleId],
    queryFn: () => api.getSubmoduleConfig(runId!, stepIndex, submoduleId!),
    enabled: !!runId && !!submoduleId,
    staleTime: 30_000,
  });
}

/**
 * Fetch all saved configs for a step as a map { submoduleId: SubmoduleConfig }.
 * Used by CategoryCardGrid to show per-submodule data operations.
 */
export function useSubmoduleConfigs(runId: string | undefined, stepIndex: number) {
  return useQuery<Record<string, SubmoduleConfig>>({
    queryKey: ['submoduleConfigs', runId, stepIndex],
    queryFn: () => api.getSubmoduleConfigs(runId!, stepIndex),
    enabled: !!runId,
    staleTime: 30_000,
  });
}

/**
 * Mutation to save submodule config (data_operation, input_config, options).
 * Optimistically updates the query cache.
 */
export function useSaveSubmoduleConfig(runId: string | undefined, stepIndex: number, submoduleId: string | null) {
  const queryClient = useQueryClient();
  const queryKey = ['submoduleConfig', runId, stepIndex, submoduleId];

  return useMutation({
    mutationFn: (config: Partial<SubmoduleConfig>) =>
      api.saveSubmoduleConfig(runId!, stepIndex, submoduleId!, config),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
    },
  });
}
