import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { OptionPreset } from '../types/step';

/**
 * Fetch presets for a specific submodule option.
 * Returns global + project-scoped presets when projectId is provided.
 */
export function usePresets(submoduleId: string | null, optionName: string | null, projectId?: string) {
  return useQuery<OptionPreset[]>({
    queryKey: ['presets', submoduleId, optionName, projectId],
    queryFn: async () => {
      const { presets } = await api.getPresets(submoduleId!, optionName!, projectId);
      return presets;
    },
    enabled: !!submoduleId && !!optionName,
    staleTime: 60_000,
  });
}

/** Create a new preset. */
export function useCreatePreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.createPreset,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['presets', variables.submodule_id, variables.option_name] });
    },
  });
}

/** Update an existing preset. */
export function useUpdatePreset(submoduleId: string, optionName: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; preset_name?: string; preset_value?: unknown }) =>
      api.updatePreset(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['presets', submoduleId, optionName] });
    },
  });
}

/** Delete a preset. */
export function useDeletePreset(submoduleId: string, optionName: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.deletePreset,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['presets', submoduleId, optionName] });
    },
  });
}

/** Set a preset as default. */
export function useSetDefaultPreset(submoduleId: string, optionName: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.setDefaultPreset,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['presets', submoduleId, optionName] });
    },
  });
}
