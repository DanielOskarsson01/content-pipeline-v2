import { Router } from 'express';
import db from '../services/db.js';

const router = Router();

/**
 * GET /api/runs/:id
 * Run status, current step, all stages
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { data: run, error: runErr } = await db
      .from('pipeline_runs')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (runErr && runErr.code !== 'PGRST116') throw runErr;
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const { data: stages, error: stagesErr } = await db
      .from('pipeline_stages')
      .select('*')
      .eq('run_id', req.params.id)
      .order('step_index', { ascending: true });

    if (stagesErr) throw stagesErr;

    res.json({ ...run, stages: stages || [] });
  } catch (err) { next(err); }
});

/**
 * GET /api/runs/:runId/steps/:stepIndex
 * Get step data for a specific step
 */
router.get('/:runId/steps/:stepIndex', async (req, res, next) => {
  try {
    const { runId, stepIndex } = req.params;

    const { data: stage, error } = await db
      .from('pipeline_stages')
      .select('*')
      .eq('run_id', runId)
      .eq('step_index', parseInt(stepIndex))
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    if (!stage) return res.status(404).json({ error: 'Step not found' });

    res.json(stage);
  } catch (err) { next(err); }
});

/**
 * POST /api/runs/:runId/steps/:stepIndex/approve
 * Approve step — basic version (Phase 3)
 * Step 0: just advance. Steps 1-10: require approved submodules (Phase 7+).
 * For Phase 3, Step 0 approval is unconditional.
 */
router.post('/:runId/steps/:stepIndex/approve', async (req, res, next) => {
  try {
    const { runId, stepIndex: stepIndexStr } = req.params;
    const stepIndex = parseInt(stepIndexStr);

    // Load the stage
    const { data: stage, error: stageErr } = await db
      .from('pipeline_stages')
      .select('*')
      .eq('run_id', runId)
      .eq('step_index', stepIndex)
      .single();

    if (stageErr) throw stageErr;
    if (!stage) return res.status(404).json({ error: 'Step not found' });
    if (stage.status !== 'active') return res.status(400).json({ error: 'Step is not active' });

    // Mark current step completed
    const { error: completeErr } = await db
      .from('pipeline_stages')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', stage.id);

    if (completeErr) throw completeErr;

    const isLastStep = stepIndex >= 10;
    let nextStep = null;

    if (!isLastStep) {
      nextStep = stepIndex + 1;

      // Activate next step + copy output_data -> input_data
      const { error: nextErr } = await db
        .from('pipeline_stages')
        .update({
          status: 'active',
          input_data: stage.output_data || stage.working_pool,
          input_render_schema: stage.output_render_schema,
          working_pool: stage.output_data || stage.working_pool,
          started_at: new Date().toISOString(),
        })
        .eq('run_id', runId)
        .eq('step_index', nextStep);

      if (nextErr) throw nextErr;

      // Update run's current_step
      const { error: runErr } = await db
        .from('pipeline_runs')
        .update({ current_step: nextStep })
        .eq('id', runId);

      if (runErr) throw runErr;
    } else {
      // Last step — complete the run
      const { error: runErr } = await db
        .from('pipeline_runs')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', runId);

      if (runErr) throw runErr;
    }

    res.json({
      step_completed: stepIndex,
      next_step: nextStep,
      items_forwarded: 0,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/runs/:runId/steps/:stepIndex/skip
 * Skip step — pass input_data -> output_data unchanged, advance
 */
router.post('/:runId/steps/:stepIndex/skip', async (req, res, next) => {
  try {
    const { runId, stepIndex: stepIndexStr } = req.params;
    const stepIndex = parseInt(stepIndexStr);

    // Load the stage
    const { data: stage, error: stageErr } = await db
      .from('pipeline_stages')
      .select('*')
      .eq('run_id', runId)
      .eq('step_index', stepIndex)
      .single();

    if (stageErr) throw stageErr;
    if (!stage) return res.status(404).json({ error: 'Step not found' });
    if (stage.status !== 'active') return res.status(400).json({ error: 'Step is not active' });

    // Mark skipped — pass input_data through as output_data
    const { error: skipErr } = await db
      .from('pipeline_stages')
      .update({
        status: 'skipped',
        output_data: stage.input_data,
        output_render_schema: stage.input_render_schema,
        completed_at: new Date().toISOString(),
      })
      .eq('id', stage.id);

    if (skipErr) throw skipErr;

    const isLastStep = stepIndex >= 10;
    let nextStep = null;

    if (!isLastStep) {
      nextStep = stepIndex + 1;

      // Activate next step
      const { error: nextErr } = await db
        .from('pipeline_stages')
        .update({
          status: 'active',
          input_data: stage.input_data,
          input_render_schema: stage.input_render_schema,
          working_pool: stage.input_data,
          started_at: new Date().toISOString(),
        })
        .eq('run_id', runId)
        .eq('step_index', nextStep);

      if (nextErr) throw nextErr;

      // Update run's current_step
      const { error: runErr } = await db
        .from('pipeline_runs')
        .update({ current_step: nextStep })
        .eq('id', runId);

      if (runErr) throw runErr;
    } else {
      // Last step — complete the run
      const { error: runErr } = await db
        .from('pipeline_runs')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', runId);

      if (runErr) throw runErr;
    }

    res.json({
      step_skipped: stepIndex,
      next_step: nextStep,
    });
  } catch (err) { next(err); }
});

export default router;
