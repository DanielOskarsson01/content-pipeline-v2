import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAppStore } from '../stores/appStore';

export function useRunData(runId: string | undefined) {
  return useQuery({
    queryKey: ['run', runId],
    queryFn: () => api.getRun(runId!),
    enabled: !!runId,
    staleTime: 5_000,
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'auto_executing') return 10_000;
      if (status === 'running') return 15_000;
      return false;
    },
  });
}

export function useApproveStep(runId: string) {
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);

  return useMutation({
    mutationFn: (stepIndex: number) => api.approveStep(runId, stepIndex),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['run', runId] });
      if (data.routing_pending) {
        const r = data.routing || {};
        const parts: string[] = [];
        if (r.routed_count) parts.push(`${r.routed_count} looped`);
        if (r.approved_count) parts.push(`${r.approved_count} approved`);
        if (r.failed_count) parts.push(`${r.failed_count} failed`);
        if (r.flagged_count) parts.push(`${r.flagged_count} flagged`);
        showToast(
          `Step ${data.step_completed} routing: ${parts.join(', ')}`,
          'info'
        );
      } else {
        showToast(
          data.next_step !== null
            ? `Step ${data.step_completed} approved — advancing to Step ${data.next_step}`
            : `Step ${data.step_completed} approved — run complete!`,
          'success'
        );
      }
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

export function useReopenStep(runId: string) {
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);

  return useMutation({
    mutationFn: (stepIndex: number) => api.reopenStep(runId, stepIndex),
    onSuccess: (data) => {
      // Hard reset — invalidate everything since downstream steps are wiped
      queryClient.invalidateQueries({ queryKey: ['run', runId] });
      queryClient.invalidateQueries({ queryKey: ['latestSubmoduleRuns'] });
      queryClient.invalidateQueries({ queryKey: ['stepContext'] });
      const wiped = data.steps_wiped || [data.step_reopened];
      const msg = wiped.length > 1
        ? `Step ${data.step_reopened} reopened — all data from step ${wiped[0]} onwards erased`
        : `Step ${data.step_reopened} reopened — all run data erased`;
      showToast(msg, 'info');
    },
  });
}
