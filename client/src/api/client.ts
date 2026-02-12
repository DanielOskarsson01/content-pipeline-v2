import { QueryClient } from '@tanstack/react-query';
import { useAppStore } from '../stores/appStore';

// Base API URL - defaults to same origin
const API_BASE = import.meta.env.VITE_API_URL || '';

// Create QueryClient with global config
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 3,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
      staleTime: 30_000, // 30 seconds
    },
    mutations: {
      retry: 0, // No auto-retry for mutations
      onError: (error) => {
        const errorMessage = error instanceof Error ? error.message : 'An error occurred';
        useAppStore.getState().showToast(errorMessage, 'error');
      },
    },
  },
});

// Generic fetch wrapper with error handling
export async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// API methods
import type {
  Project, CreateProjectInput, CreateProjectResponse,
  RunWithStages, PipelineStage, StepApproveResponse, StepSkipResponse,
  CategoryGroups,
} from '../types/step';

export const api = {
  // Projects
  getProjects: () => apiFetch<Project[]>('/api/projects'),
  getProject: (id: string) => apiFetch<Project>(`/api/projects/${id}`),
  createProject: (data: CreateProjectInput) =>
    apiFetch<CreateProjectResponse>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Runs
  getRun: (id: string) => apiFetch<RunWithStages>(`/api/runs/${id}`),

  // Steps
  getStep: (runId: string, stepIndex: number) =>
    apiFetch<PipelineStage>(`/api/runs/${runId}/steps/${stepIndex}`),
  approveStep: (runId: string, stepIndex: number) =>
    apiFetch<StepApproveResponse>(`/api/runs/${runId}/steps/${stepIndex}/approve`, { method: 'POST' }),
  skipStep: (runId: string, stepIndex: number) =>
    apiFetch<StepSkipResponse>(`/api/runs/${runId}/steps/${stepIndex}/skip`, { method: 'POST' }),

  // Submodules
  getSubmodules: (stepIndex: number) =>
    apiFetch<CategoryGroups>(`/api/submodules?step=${stepIndex}`),
};
