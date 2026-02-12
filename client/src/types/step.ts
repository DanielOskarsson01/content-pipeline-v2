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
