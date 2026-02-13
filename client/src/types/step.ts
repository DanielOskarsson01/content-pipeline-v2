export interface Project {
  id: string;
  name: string;
  description: string | null;
  timing: string | null;
  template_id: string | null;
  status: 'active' | 'archived';
  created_at: string;
}

export interface PipelineRun {
  id: string;
  project_id: string;
  status: 'running' | 'completed' | 'failed' | 'paused';
  current_step: number;
  started_at: string;
  completed_at: string | null;
}

export interface PipelineStage {
  id: string;
  run_id: string;
  step_index: number;
  step_name: string;
  status: 'pending' | 'active' | 'completed' | 'skipped';
  input_data: unknown;
  input_render_schema: unknown;
  output_data: unknown;
  output_render_schema: unknown;
  working_pool: unknown;
  working_pool_render_schema: unknown;
  started_at: string | null;
  completed_at: string | null;
}

export interface ProjectWithRuns extends Project {
  runs: PipelineRun[];
}

export interface RunWithStages extends PipelineRun {
  stages: PipelineStage[];
}

export interface CreateProjectInput {
  name: string;
  intent?: string;
}

export interface CreateProjectResponse {
  project: Project;
  run: PipelineRun;
}

export interface StepApproveResponse {
  step_completed: number;
  next_step: number | null;
  items_forwarded: number;
}

export interface StepSkipResponse {
  step_skipped: number;
  next_step: number | null;
}

// Submodule types (from manifest.json)
export interface SubmoduleManifest {
  id: string;
  name: string;
  description: string;
  category: string;
  cost: 'cheap' | 'medium' | 'expensive';
  data_operation_default: 'add' | 'remove' | 'transform';
  requires_columns: string[];
  item_key: string;
  options: SubmoduleOption[];
  options_defaults: Record<string, unknown>;
  output_schema: Record<string, string>;
}

export interface SubmoduleOption {
  name: string;
  type: 'boolean' | 'number' | 'text' | 'select' | 'textarea';
  label: string;
  description: string;
  default: unknown;
  min?: number;
  max?: number;
  values?: string[];
  maxLength?: number;
}

// CategoryGroups: Record<categoryName, SubmoduleManifest[]>
export type CategoryGroups = Record<string, SubmoduleManifest[]>;

// Persisted submodule configuration per run/step/submodule
export interface SubmoduleConfig {
  id?: string;
  run_id: string;
  step_index: number;
  submodule_id: string;
  input_config: unknown;
  options: Record<string, unknown> | null;
  data_operation: 'add' | 'remove' | 'transform' | null;
  updated_at?: string;
}

// Phase 7: Submodule run — one execution of one submodule
export interface SubmoduleRun {
  id: string;
  submodule_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'approved';
  progress: { current: number; total: number; message: string } | null;
  output_data: SubmoduleOutput | null;
  output_render_schema: { display_type?: string; selectable?: boolean; [field: string]: unknown } | null;
  approved_items: string[] | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
}

// Output shape from execute() — per-entity results + summary
export interface SubmoduleOutput {
  results: SubmoduleEntityResult[];
  summary: { total_entities: number; total_items: number; errors: string[] };
}

export interface SubmoduleEntityResult {
  entity_name: string;
  items: Record<string, unknown>[];
  meta?: Record<string, unknown>;
  error?: string;
}

// Latest run status per submodule (from /submodule-runs/latest endpoint)
export interface SubmoduleLatestRun {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'approved';
  progress: { current: number; total: number; message: string } | null;
  result_count: number;
  approved_count: number;
}

export type SubmoduleLatestRunMap = Record<string, SubmoduleLatestRun>;

// Approval response
export interface ApproveSubmoduleRunResponse {
  status: 'approved';
  pool_count: number;
  approved_count: number;
}
