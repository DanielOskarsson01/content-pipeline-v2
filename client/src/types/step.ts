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
  per_step_results: Record<string, AutoExecuteStepResult>;
  halt_reason?: string;
  halted_at?: string;
  halted_step?: number;
  paused_at_steps?: number[];
  paused_after_submodules?: string[];
  routing_loops?: number;
  routing_events?: Array<{
    loop: number;
    earliest_step: number;
    routed: number;
    approved: number;
    failed: number;
    flagged: number;
    timestamp: string;
  }>;
}

export interface AutoExecuteStepResult {
  status: string;
  completed: number;
  failed: number;
  /** Entities skipped (e.g. no input). Part of the real persisted per_step_results shape —
   *  added in unit 2.4 (2.3 §5b drift W2: step.ts omitted it). */
  skipped: number;
  total: number;
  /** total minus skipped — the denominator the failure rate is actually computed against
   *  (autoExecutor.js). Added in unit 2.4 (2.3 §5b drift W2: step.ts omitted it). */
  effectiveTotal: number;
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
  step: number;
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
  type: 'boolean' | 'number' | 'text' | 'select' | 'textarea' | 'doc_selector' | 'json' | 'file_upload';
  label: string;
  description: string;
  default: unknown;
  min?: number;
  max?: number;
  values?: string[];
  maxLength?: number;
  presets_enabled?: boolean;
  accept?: string;
  upload_endpoint?: string;
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

// ── Multi-Card Pattern (PHASE_3B) — canonical card config ─────────────────────
// Runtime-faithful shapes. Source of truth: server routingHandler.js + executionPlanUtils.js
// + the live 30-april template (verified 2026-06-30). These intentionally DIVERGE from
// PHASE_3B's abstract §1 schema (no separate options_overrides/prompt_overrides object;
// routing_rules is array-form, not {target_cards}); the deployed runtime wins.
// The dead CardsSection/RoutingRulesSection textareas + their legacy types were deleted (item 9);
// cards + routing are edited in the run view (Step-7 routing body + variant panes).

/** Sparse per-round option overrides. Any submodule option (prompt, ai_model, temperature,
 *  curated_list, max_results, …) is just a key here — there is NO separate options_overrides
 *  object; overrides are spread shallowly over base options at execution ({ ...base, ...rounds[N] }). */
export type CardRoundOverrides = Record<string, unknown>;

/** Round overrides keyed by the STRING digits "1".."4" (NOT an array, NOT numeric keys).
 *  Round "1" is always present (validator rule 5); max 4 rounds (rule 7). For a Round-1 card
 *  "1" carries its differentiating config; for a retry-only card "1" is typically {} and
 *  "2"/"3"/"4" carry escalation overrides. */
export interface CardRounds {
  '1': CardRoundOverrides;
  '2'?: CardRoundOverrides;
  '3'?: CardRoundOverrides;
  '4'?: CardRoundOverrides;
}

/** A card = a named, configured instance of a submodule. Stored UUID-keyed in
 *  execution_plan.card_definitions; the map key is the card_id (stable, never changes on rename).
 *
 *  v6 (unit 2.4): the per-round `rounds` MAP is dropped in favour of a SCALAR `round` + a single
 *  FLAT `overrides` object — one card IS exactly one round (D10). `round === 1` ⇒ a first-pass
 *  (placed) variant; `round > 1` ⇒ a retry/escalation variant (routing-only). Multiple cards
 *  sharing (submodule, step) — one per round — is the normal, valid shape (D8). */
export interface CardDefinition {
  /** Display name. Cosmetic only — identity is always the card_id (the map key). The runtime
   *  tolerates its absence (validator does not require it), but the UI should always set it. */
  card_name: string;
  /** Which submodule this card invokes. Must be a registered submodule. */
  submodule_id: string;
  /** Which pipeline step the card executes at. Must equal its submodules_per_step placement. */
  step: number;
  /** v6 CANONICAL — the scalar round this card is (integer 1..4). round===1 ⇒ placed first-pass;
   *  round>1 ⇒ routing-only retry. Validator (executionPlanUtils.validateExecutionPlan) enforces it. */
  round?: number;
  /** v6 CANONICAL — this round's FLAT option overrides (no `rounds[N]` nesting). */
  overrides?: CardRoundOverrides;
  /** @deprecated v6 (unit 2.4): superseded by scalar `round` + flat `overrides`. NOT removed here —
   *  the 2.5 engine (submoduleRuns.js / routingHandler.js / cardInstructions.js) still reads
   *  `rounds` at runtime, and the 30-april prod fixture is still map-shaped until unit 2.7. Removed
   *  together with the 2.5 engine reshape + 2.6 UI rewrite at the atomic 3.1 deploy. */
  rounds?: CardRounds;
  /** Optional operator note. */
  description?: string;
}

/** One routing target: run `card_id` at `step` when a QA check fails. `step` is optional at
 *  runtime (falls back to the card's own step) but the UI should set it = card.step. */
export interface RoutingTarget {
  step: number;
  card_id: string;
}

export interface EscalationRule {
  volume_threshold?: number;
  fail_threshold?: number;
  quality_threshold_words?: number;
  quality_fail_threshold?: number;
  escalation_submodules: string[];
}

export interface TemplateExecutionPlan {
  submodules_per_step?: Record<string, string[]>;
  skip_steps?: number[];
  pause_before_steps?: number[];
  pause_after_submodules?: string[];
  failure_thresholds?: Record<string, number>;
  /** Canonical card config — UUID-keyed. Round-1 cards ALSO appear (by card_id) in
   *  submodules_per_step; retry-only cards appear here only. */
  card_definitions?: Record<string, CardDefinition>;
  /** Canonical routing — keyed by "{qa_check}:fail"; each value is the target array. */
  routing_rules?: Record<string, RoutingTarget[]>;
  escalation_rules?: Record<string, EscalationRule>;
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

// ── Workbench (U6) ────────────────────────────────────────────────

export interface WorkbenchSourceRun {
  id: string;
  status: string;
  project_id: string | null;
  project_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  entity_names: string[];
}

export interface WorkbenchRunStep {
  step_index: number;
  submodules: { submodule_id: string; options: Record<string, unknown>; ran: boolean }[];
  entities: string[];
}

export interface WorkbenchRunTree {
  run_id: string;
  status: string;
  project_id: string | null;
  steps: WorkbenchRunStep[];
}

export interface WorkbenchAiCall {
  provider: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  stop_reason: string | null;
}

export interface WorkbenchAiUsage {
  calls: WorkbenchAiCall[];
  tokens_in_total: number;
  tokens_out_total: number;
  cache_write_tokens_total: number;
  cache_read_tokens_total: number;
}

export interface WorkbenchExperiment {
  id: string;
  source_run_id: string;
  step_index: number;
  submodule_id: string;
  entity_name: string;
  overrides: Record<string, unknown>;
  resolved_config: Record<string, unknown> | null;
  output_data: {
    items?: Record<string, unknown>[];
    meta?: { status?: string; error?: string; truncated?: boolean; ai_usage?: WorkbenchAiUsage };
  } | null;
  ai_usage: WorkbenchAiUsage | null;
  duration_ms: number | null;
  status: 'completed' | 'error' | 'timeout';
  error: string | null;
  /** U8: set when this experiment chained from a previous experiment's output */
  parent_experiment_id?: string | null;
  created_at: string;
}

export interface WorkbenchExperimentResponse {
  experiment: WorkbenchExperiment;
  replay_fidelity: string;
  /** set when the server answered non-2xx but still recorded the experiment */
  error?: string;
  /** U8: what the run read — always present on current servers ('pool' when unchained) */
  source?: 'chained' | 'pool';
  /** U8: overlay stats when chained; explicit null when the run scored the pool */
  chain?: { parent_experiment_id: string; pool_items_dropped: number; pool_items_kept: number } | null;
}

export interface CreateWorkbenchExperimentInput {
  source_run_id: string;
  step_index: number;
  submodule_id: string;
  entity_name: string;
  overrides?: Record<string, unknown>;
  /** U8: run with a completed experiment's output overlaid onto the frozen pool */
  parent_experiment_id?: string;
}

// ---- A2 forward chains ----

export interface WorkbenchChainHop {
  step_index: number;
  submodule_id: string;
  experiment_id: string | null;
  parent_experiment_id: string;
  read_from: string[];
  status: string;
  error: string | null;
  duration_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  pool_items_dropped: number | null;
  pool_items_kept: number | null;
  overlay_warning?: string | null;
  summary: Record<string, unknown>;
  /** full row minus frozen_input — renderable via ExperimentResultView */
  experiment: WorkbenchExperiment | null;
}

export interface WorkbenchChainResponse {
  chain_status: 'completed' | 'stopped_error' | 'refused_cost_cap' | 'dry_run';
  stop: {
    reason: string;
    refused_hop?: { step_index: number; submodule_id: string; estimate_usd: number };
    failed_hop_experiment_id?: string | null;
  } | null;
  start_experiment_id: string;
  source_run_id: string;
  entity_name: string;
  from_step: number;
  to_step: number;
  planned_hops: { step_index: number; submodule_id: string; estimate_usd: number }[];
  warnings?: string[];
  estimate_total_usd: number;
  max_cost_usd: number;
  max_hops: number;
  hops: WorkbenchChainHop[];
  totals: { cost_usd: number; tokens_in: number; tokens_out: number; duration_ms: number };
}

export interface RunWorkbenchChainInput {
  start_experiment_id: string;
  from_step: number;
  to_step: number;
  overrides_per_submodule?: Record<string, Record<string, unknown>>;
  max_cost_usd?: number;
  max_hops?: number;
  dry_run?: boolean;
}

export interface WorkbenchChainTree {
  start: { experiment_id: string; submodule_id: string; step_index: number; status: string };
  hops: {
    experiment_id: string;
    submodule_id: string;
    step_index: number;
    status: string;
    parent_experiment_id: string;
    duration_ms: number | null;
    cost_usd: number;
    created_at: string;
    summary: Record<string, unknown>;
  }[];
}
