import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiFetch } from '../api/client';
import { useAppStore } from '../stores/appStore';
import type { SubmoduleRun, SubmoduleLatestRunMap, ApproveSubmoduleRunResponse } from '../types/step';

/**
 * Poll a submodule run by ID.
 * Polls every 2s while status is "pending" or "running".
 * Stops polling on "completed", "failed", or "approved".
 * Pass enabled=false to pause polling (e.g. when panel is closed).
 */
export function useSubmoduleRun(submoduleRunId: string | null, enabled = true) {
  return useQuery<SubmoduleRun | null>({
    queryKey: ['submoduleRun', submoduleRunId],
    queryFn: () => {
      if (!submoduleRunId) return null;
      return api.getSubmoduleRun(submoduleRunId);
    },
    enabled: enabled && !!submoduleRunId,
    refetchInterval: (query) => {
      if (!enabled) return false;
      const status = query.state.data?.status;
      if (status === 'pending' || status === 'running') return 2000;
      return false; // stop polling
    },
    staleTime: 1000,
  });
}

/**
 * Fetch full submodule run data (including downloadable fields like text_content).
 * Only fetches when enabled=true — use on-demand when detail modal opens or download is clicked.
 * Cached for 5 minutes since the data rarely changes after completion.
 */
export function useSubmoduleRunFull(submoduleRunId: string | null, enabled = false) {
  return useQuery<SubmoduleRun | null>({
    queryKey: ['submoduleRunFull', submoduleRunId],
    queryFn: () => {
      if (!submoduleRunId) return null;
      return api.getSubmoduleRunFull(submoduleRunId);
    },
    enabled: enabled && !!submoduleRunId,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Trigger submodule execution.
 * Returns { submodule_run_id, status: "pending" }.
 */
export function useExecuteSubmodule() {
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);

  return useMutation({
    mutationFn: ({ runId, stepIndex, submoduleId, entities, fromPreviousStep }: { runId: string; stepIndex: number; submoduleId: string; entities?: Record<string, unknown>[]; fromPreviousStep?: boolean }) =>
      api.executeSubmodule(runId, stepIndex, submoduleId, entities?.length ? { entities, from_previous_step: fromPreviousStep || false } : undefined),
    onSuccess: (_data, vars) => {
      // Invalidate latest runs so CategoryCardGrid updates
      queryClient.invalidateQueries({ queryKey: ['latestSubmoduleRuns', vars.runId, vars.stepIndex] });
      showToast('Task started', 'success');
    },
    onError: (error: Error) => {
      showToast(error.message || 'Failed to start task', 'error');
    },
  });
}

/**
 * Approve (or re-approve) a submodule run.
 * Sends approved item keys, server updates working pool.
 */
export function useApproveSubmoduleRun() {
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);

  return useMutation({
    mutationFn: ({ submoduleRunId, approvedItemKeys }: { submoduleRunId: string; approvedItemKeys: string[]; runId: string; stepIndex: number }) =>
      api.approveSubmoduleRun(submoduleRunId, approvedItemKeys),
    onSuccess: (data, vars) => {
      // R004 fix: scope invalidation to current run/step only
      queryClient.invalidateQueries({ queryKey: ['latestSubmoduleRuns', vars.runId, vars.stepIndex] });
      queryClient.invalidateQueries({ queryKey: ['submoduleRun', vars.submoduleRunId] });
      // Refresh stage data so sibling submodules see updated working_pool
      queryClient.invalidateQueries({ queryKey: ['run', vars.runId] });
      showToast(`Approved — ${data.approved_count} items, pool: ${data.pool_count}`, 'success');
    },
    onError: (error: Error) => {
      showToast(error.message || 'Failed to approve', 'error');
    },
  });
}

/**
 * Fetch latest submodule run per submodule for a step.
 * Used by CategoryCardGrid to show status badges.
 */
export function useLatestSubmoduleRuns(runId: string | undefined, stepIndex: number) {
  return useQuery<SubmoduleLatestRunMap>({
    queryKey: ['latestSubmoduleRuns', runId, stepIndex],
    queryFn: () => api.getLatestSubmoduleRuns(runId!, stepIndex),
    enabled: !!runId,
    refetchInterval: 5000, // refresh every 5s to catch background job completions
    staleTime: 2000,
  });
}
