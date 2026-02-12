import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAppStore } from '../stores/appStore';

export function useRunData(runId: string | undefined) {
  return useQuery({
    queryKey: ['run', runId],
    queryFn: () => api.getRun(runId!),
    enabled: !!runId,
  });
}

export function useApproveStep(runId: string) {
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);

  return useMutation({
    mutationFn: (stepIndex: number) => api.approveStep(runId, stepIndex),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['run', runId] });
      showToast(
        data.next_step !== null
          ? `Step ${data.step_completed} approved — advancing to Step ${data.next_step}`
          : `Step ${data.step_completed} approved — run complete!`,
        'success'
      );
    },
  });
}

export function useSkipStep(runId: string) {
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);

  return useMutation({
    mutationFn: (stepIndex: number) => api.skipStep(runId, stepIndex),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['run', runId] });
      showToast(
        data.next_step !== null
          ? `Step ${data.step_skipped} skipped — advancing to Step ${data.next_step}`
          : `Step ${data.step_skipped} skipped — run complete!`,
        'info'
      );
    },
  });
}
