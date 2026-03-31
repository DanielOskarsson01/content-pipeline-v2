// Phase 12b: Project modes
export type ProjectMode = 'single_run' | 'use_template' | 'update_template' | 'new_template' | 'fork_template';

export interface Project {
  id: string;
  name: string;
  description: string | null;
  timing: string | null;
  template_id: string | null;
  mode: ProjectMode;
  status: 'draft' | 'active' | 'archived';
  created_at: string;
}

export interface PipelineRun {
  id: string;
  project_id: string;
  status: 'running' | 'completed' | 'failed' | 'paused' | 'auto_executing' | 'halted';
  current_step: number;
  auto_execute_state?: AutoExecuteState | null;
  started_at: string;
  completed_at: string | null;
}

// Phase 12c: Auto-execute state stored in pipeline_runs.auto_execute_state JSONB
export interface AutoExecuteState {
  started_at: string;
  current_step: number | null;
  steps_completed: number[];
  steps_skipped: number[];
  failure_thresholds: Record<string, number>;
  step_timeouts: Record<string, number>;
  per_step_results: Record<string, AutoExecuteStepResult>;
  halt_reason?: string;
  halted_at?: string;
  halted_step?: number;
}

export interface AutoExecuteStepResult {
  status: string;
  completed: number;
  failed: number;
  total: number;
  failureRate: number;
  duration_ms: number;
  errorSummary: Record<string, number>;
}

export interface PipelineStage {
  id: string;
  run_id: string;
  step_index: number;
  step_name: string;
  status: 'pending' | 'active' | 'completed' | 'skipped' | 'approved';
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
  template_id?: string;
  mode?: ProjectMode;
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
  sort_order?: number;
  active?: boolean;
}

export interface SubmoduleOption {
  name: string;
  type: 'boolean' | 'number' | 'text' | 'select' | 'textarea' | 'doc_selector';
  label: string;
  description: string;
  default: unknown;
  min?: number;
  max?: number;
  values?: string[];
  maxLength?: number;
  presets_enabled?: boolean;
}

// Phase 12a: Option presets
export interface OptionPreset {
  id: string;
  submodule_id: string;
  option_name: string;
  preset_name: string;
  preset_value: unknown;
  project_id: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

// Phase 12a: Run report
export interface RunReportStep {
  step_index: number;
  step_name: string;
  status: string;
  entities: number;
  completed: number;
  failed: number;
  items: number;
  words: number;
  submodules: {
    submodule_id: string;
    entities: number;
    completed: number;
    failed: number;
    total: number;
    items: number;
    words: number;
    success_rate: number | null;
    errors: { entity: string; error: string }[];
  }[];
}

export interface RunReport {
  run: {
    id: string;
    project_id: string;
    status: string;
    current_step: number;
    created_at: string;
    completed_at: string | null;
  };
  summary: {
    entities: number;
    total_words: number;
    total_duration_ms: number;
    total_cost: number;
    steps_completed: number;
    steps_total: number;
  };
  steps: RunReportStep[];
}

// Phase 12b: Template JSONB config types
export interface TemplatePresetMapEntry {
  preset_name: string;
  fallback_values: Record<string, unknown>;
}
export type TemplatePresetMap = Record<string, TemplatePresetMapEntry>;

export interface TemplateExecutionPlan {
  submodules_per_step?: Record<string, string[]>;
  skip_steps?: number[];
  failure_thresholds?: Record<string, number>;
  step_timeouts?: Record<string, number>;
}

export interface TemplateSeedConfig {
  seed_type: 'csv' | 'url' | 'prompt';
  required_columns?: string[];
  column_aliases?: Record<string, string>;
}

// Phase 12b: Pipeline Templates
export interface Template {
  id: string;
  name: string;
  description: string | null;
  preset_map: TemplatePresetMap;
  execution_plan: TemplateExecutionPlan;
  seed_config: TemplateSeedConfig;
  preset_count: number;
  doc_count: number;
  usage_count?: number;
  created_at: string;
}

/** DEPRECATED: Backward-compat flat preset from preset_map JSONB */
export interface TemplatePresetMapping {
  submodule_id: string;
  option_name: string;
  preset_name: string;
  preset_value: unknown;
}

export interface TemplateDetail extends Template {
  presets: TemplatePresetMapping[];
  reference_docs: { id: string; filename: string; content_type: string; size_bytes: number }[];
}

export interface SeedPreviewResult {
  entity_count: number;
  entities: Array<{ name: string; [key: string]: unknown }>;
  columns_found: string[];
  columns_missing: string[];
  all_columns: string[];
  filename: string;
  truncated: boolean;
}

export interface LaunchTemplateInput {
  project_name: string;
  project_description?: string;
  mode: ProjectMode;
  urls?: string;
  prompt?: string;
  fork_name?: string;
  project_id?: string;
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
  summary: { total_entities: number; total_items: number; errors: string[]; description?: string; [key: string]: unknown };
}

export interface SubmoduleEntityResult {
  entity_name: string;
  items: Record<string, unknown>[];
  meta?: Record<string, unknown>;
  error?: string;
}

// Per-entity batch poll response (lightweight — no output_data)
export interface SubmoduleRunBatch {
  id: string;
  submodule_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'approved';
  batch_id: string;
  entity_count: number;
  completed_count: number;
  failed_count: number;
  progress: null;
  output_data?: undefined;
  output_render_schema: { display_type?: string; selectable?: boolean; [field: string]: unknown } | null;
  approved_items: string[] | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  entities: EntityRunStatus[];
  mode: 'per_entity';
}

export interface EntityRunStatus {
  id: string;
  entity_name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'approved';
  progress: { current: number; total: number; message: string } | null;
  error: string | null;
}

// Full entity detail (lazy-loaded on expand)
export interface EntityRunDetail {
  id: string;
  entity_name: string;
  submodule_id: string;
  status: string;
  output_data: { items: Record<string, unknown>[] } | null;
  output_render_schema: { display_type?: string; selectable?: boolean; [field: string]: unknown } | null;
  approved_items: string[] | null;
  error: string | null;
  logs: unknown;
  started_at: string | null;
  completed_at: string | null;
}

// Union type for polling — server sets mode: 'per_entity' on batch responses
export type SubmoduleRunPolled = SubmoduleRun | SubmoduleRunBatch;

export function isPerEntityRun(run: SubmoduleRunPolled): run is SubmoduleRunBatch {
  return 'mode' in run && (run as SubmoduleRunBatch).mode === 'per_entity';
}

// Execute response — per-entity adds batch_id, entity_count, mode
export type ExecuteSubmoduleResponse =
  | { submodule_run_id: string; status: string }
  | { submodule_run_id: string; batch_id: string; entity_count: number; status: string; mode: 'per_entity' };

// Per-entity approval response
export interface ApproveSubmoduleRunPerEntityResponse {
  status: string;
  mode: string;
  entity_count: number;
  total_approved: number;
}

// Latest run status per submodule (from /submodule-runs/latest endpoint)
export interface SubmoduleLatestRun {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'approved';
  progress: { current: number; total: number; message: string } | null;
  result_count: number;
  approved_count: number;
  description?: string;
  error?: string | null;
  completed_at?: string | null;
  mode?: 'per_entity';
  batch_id?: string;
  entity_count?: number;
  completed_count?: number;
}

export type SubmoduleLatestRunMap = Record<string, SubmoduleLatestRun>;

// Downloadable field declaration (from manifest output_schema)
export interface DownloadableField {
  field: string;
  extension: string;
  label: string;
}

// Approval response
export interface ApproveSubmoduleRunResponse {
  status: 'approved';
  pool_count: number;
  approved_count: number;
}

// Decision log entry (from /api/runs/:runId/decisions)
export interface DecisionLogEntry {
  id: string;
  run_id: string;
  step_index: number;
  submodule_id?: string | null;
  decision: string;
  context: Record<string, unknown>;
  created_at: string;
}
