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
  CategoryGroups, SubmoduleConfig, SubmoduleManifest,
  SubmoduleRun, SubmoduleRunPolled, SubmoduleLatestRunMap,
  ApproveSubmoduleRunResponse, ApproveSubmoduleRunPerEntityResponse,
  EntityRunDetail, ExecuteSubmoduleResponse,
  DecisionLogEntry, OptionPreset, RunReport,
  Template, TemplateDetail,
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
  deleteProject: (id: string) =>
    apiFetch<{ deleted: boolean; runs_deleted: number }>(`/api/projects/${id}`, {
      method: 'DELETE',
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
  reopenStep: (runId: string, stepIndex: number) =>
    apiFetch<{ step_reopened: number }>(`/api/runs/${runId}/steps/${stepIndex}/reopen`, { method: 'POST' }),

  // Submodules
  getSubmodules: (stepIndex: number) =>
    apiFetch<CategoryGroups>(`/api/submodules?step=${stepIndex}`),

  // Submodule config
  getSubmoduleConfig: (runId: string, stepIndex: number, submoduleId: string) =>
    apiFetch<SubmoduleConfig>(`/api/runs/${runId}/steps/${stepIndex}/submodules/${submoduleId}/config`),
  getSubmoduleConfigs: (runId: string, stepIndex: number) =>
    apiFetch<Record<string, SubmoduleConfig>>(`/api/runs/${runId}/steps/${stepIndex}/submodule-configs`),
  saveSubmoduleConfig: (runId: string, stepIndex: number, submoduleId: string, config: Partial<SubmoduleConfig>) =>
    apiFetch<SubmoduleConfig>(`/api/runs/${runId}/steps/${stepIndex}/submodules/${submoduleId}/config`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  // Submodule execution (Phase 7)
  executeSubmodule: (runId: string, stepIndex: number, submoduleId: string, body?: { entities?: Record<string, unknown>[]; from_previous_step?: boolean }) =>
    apiFetch<ExecuteSubmoduleResponse>(
      `/api/runs/${runId}/steps/${stepIndex}/submodules/${submoduleId}/run`,
      { method: 'POST', body: JSON.stringify(body || {}) }
    ),
  getSubmoduleRun: (submoduleRunId: string) =>
    apiFetch<SubmoduleRunPolled>(`/api/submodule-runs/${submoduleRunId}`),
  getSubmoduleRunFull: (submoduleRunId: string) =>
    apiFetch<SubmoduleRun>(`/api/submodule-runs/${submoduleRunId}?full=true`),
  approveSubmoduleRun: (submoduleRunId: string, approvedItemKeys: string[]) =>
    apiFetch<ApproveSubmoduleRunResponse>(`/api/submodule-runs/${submoduleRunId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approved_item_keys: approvedItemKeys }),
    }),
  approveSubmoduleRunPerEntity: (submoduleRunId: string, entityApprovals: Record<string, string[] | string>) =>
    apiFetch<ApproveSubmoduleRunPerEntityResponse>(`/api/submodule-runs/${submoduleRunId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ entity_approvals: entityApprovals }),
    }),
  abortSubmoduleRun: (submoduleRunId: string) =>
    apiFetch<{ aborted: boolean; entity_runs_cancelled: number }>(`/api/submodule-runs/${submoduleRunId}/abort`, {
      method: 'POST',
    }),
  abortEntityRun: (entityRunId: string) =>
    apiFetch<{ aborted: boolean; entity_name: string }>(`/api/submodule-runs/entity/${entityRunId}/abort`, {
      method: 'POST',
    }),
  getEntityRunDetail: (batchRunId: string, entityRunId: string) =>
    apiFetch<EntityRunDetail>(`/api/submodule-runs/${batchRunId}/entities/${entityRunId}?full=true`),
  getBatchAllItems: (batchRunId: string, full = false) =>
    apiFetch<{ items: Record<string, unknown>[]; total: number }>(
      `/api/submodule-runs/${batchRunId}/all-items${full ? '?full=true' : ''}`
    ),
  getLatestSubmoduleRuns: (runId: string, stepIndex: number) =>
    apiFetch<SubmoduleLatestRunMap>(`/api/runs/${runId}/steps/${stepIndex}/submodule-runs/latest`),

  // Run report (Phase 12a)
  getRunReport: (runId: string) =>
    apiFetch<RunReport>(`/api/runs/${runId}/report`),

  // Decision log
  getDecisions: (runId: string) =>
    apiFetch<DecisionLogEntry[]>(`/api/runs/${runId}/decisions`),

  // Presets (Phase 12a)
  getPresets: (submoduleId: string, optionName: string, projectId?: string) =>
    apiFetch<{ presets: OptionPreset[] }>(
      `/api/presets?submodule_id=${encodeURIComponent(submoduleId)}&option_name=${encodeURIComponent(optionName)}${projectId ? `&project_id=${projectId}` : ''}`
    ),
  createPreset: (data: { submodule_id: string; option_name: string; preset_name: string; preset_value: unknown; project_id?: string }) =>
    apiFetch<{ preset: OptionPreset }>('/api/presets', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updatePreset: (id: string, data: { preset_name?: string; preset_value?: unknown }) =>
    apiFetch<{ preset: OptionPreset }>(`/api/presets/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deletePreset: (id: string) =>
    apiFetch<{ deleted: boolean }>(`/api/presets/${id}`, {
      method: 'DELETE',
    }),
  setDefaultPreset: (id: string) =>
    apiFetch<{ preset: OptionPreset }>(`/api/presets/${id}/set-default`, {
      method: 'POST',
    }),

  // Templates (Phase 12b)
  getTemplates: () => apiFetch<Template[]>('/api/templates'),
  getTemplate: (id: string) => apiFetch<TemplateDetail>(`/api/templates/${id}`),
  createTemplate: (data: { name: string; description?: string }) =>
    apiFetch<{ template: Template }>('/api/templates', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateTemplate: (id: string, data: { name?: string; description?: string }) =>
    apiFetch<{ template: Template }>(`/api/templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteTemplate: (id: string) =>
    apiFetch<{ deleted: boolean }>(`/api/templates/${id}`, {
      method: 'DELETE',
    }),
  addTemplatePreset: (templateId: string, data: { submodule_id: string; option_name: string; preset_id: string }) =>
    apiFetch<{ mapping: unknown }>(`/api/templates/${templateId}/presets`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  removeTemplatePreset: (templateId: string, mappingId: string) =>
    apiFetch<{ deleted: boolean }>(`/api/templates/${templateId}/presets/${mappingId}`, {
      method: 'DELETE',
    }),
  uploadTemplateDoc: (templateId: string, formData: FormData) =>
    fetch(`${API_BASE}/api/templates/${templateId}/reference-docs`, {
      method: 'POST',
      body: formData,
    }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ uploaded: { id: string; filename: string; content_type: string; size_bytes: number }[]; errors: string[] }>;
    }),
  removeTemplateDoc: (templateId: string, docId: string) =>
    apiFetch<{ deleted: boolean }>(`/api/templates/${templateId}/reference-docs/${docId}`, {
      method: 'DELETE',
    }),

  // Save run as template
  saveRunAsTemplate: (runId: string, data: { name: string; description?: string }) =>
    apiFetch<{ template: TemplateDetail }>(`/api/templates/from-run/${runId}`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Submodules with full detail (for template editor) — returns flat array
  getSubmodulesFull: () =>
    apiFetch<SubmoduleManifest[]>('/api/submodules?detail=full'),
};
