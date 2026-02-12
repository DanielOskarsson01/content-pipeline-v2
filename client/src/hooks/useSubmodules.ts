import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { CategoryGroups } from '../types/step';

/**
 * Fetch submodules for a specific step, grouped by category.
 * Returns CategoryGroups: Record<categoryName, SubmoduleManifest[]>
 */
export function useStepSubmodules(stepIndex: number) {
  return useQuery<CategoryGroups>({
    queryKey: ['submodules', stepIndex],
    queryFn: () => api.getSubmodules(stepIndex),
    staleTime: 5 * 60 * 1000, // 5 min — manifests rarely change
  });
}
