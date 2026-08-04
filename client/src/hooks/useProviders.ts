import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ProvidersResponse } from '../types/step';

/**
 * LLM providers/models availability for the model picker (BACKLOG #49).
 * Which providers are configured on the box, their models, and prices per Mtok.
 */
export function useProviders() {
  return useQuery<ProvidersResponse>({
    queryKey: ['providers'],
    queryFn: () => api.getProviders(),
    staleTime: 5 * 60 * 1000, // 5 min — provider availability rarely changes
  });
}

/** Unit 7: save a DB-stored key for a provider, then refresh availability. */
export function useSetProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, apiKey }: { id: string; apiKey: string }) => api.setProviderKey(id, apiKey),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });
}

/** Unit 7: remove a DB-stored key for a provider, then refresh availability. */
export function useDeleteProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteProviderKey(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });
}
