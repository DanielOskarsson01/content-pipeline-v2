import { useQuery } from '@tanstack/react-query';
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
