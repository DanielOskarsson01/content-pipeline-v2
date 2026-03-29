import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client';

export interface StepContextData {
  id: string;
  run_id: string;
  step_index: number;
  entities: Record<string, unknown>[];
  filename: string | null;
  source_submodule: string | null;
  status?: string;
  created_at: string;
}

/**
 * Fetch stored step context (uploaded CSV data) for a run + step.
 * Returns null if no context has been uploaded yet.
 */
export function useStepContext(runId: string | undefined, stepIndex: number) {
  return useQuery<StepContextData | null>({
    queryKey: ['stepContext', runId, stepIndex],
    queryFn: () =>
      apiFetch<StepContextData | null>(
        `/api/runs/${runId}/steps/${stepIndex}/context`
      ),
    enabled: !!runId,
    staleTime: 30_000,
  });
}
