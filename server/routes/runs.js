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
 * GET /api/runs/:runId/steps/:stepIndex/submodule-configs
 * Returns all saved submodule configs for this step as a map { submoduleId: config }.
 */
router.get('/:runId/steps/:stepIndex/submodule-configs', async (req, res, next) => {
  try {
    const { runId, stepIndex } = req.params;

    const { data, error } = await db
      .from('run_submodule_config')
      .select('*')
      .eq('run_id', runId)
      .eq('step_index', parseInt(stepIndex));

    if (error) throw error;

    const map = {};
    for (const row of data || []) {
      map[row.submodule_id] = row;
    }
    res.json(map);
  } catch (err) { next(err); }
});

/**
 * POST /api/runs/:runId/steps/:stepIndex/approve
 * Approve step — full version (Phase 8).
 * Step 0: unconditional advance. Steps 1-10: require at least one approved submodule.
 * Finalizes working_pool → output_data, flows data to next step.
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

    // For steps with submodules (step > 0): validate at least one approved submodule_run
    let approvedRuns = [];
    if (stepIndex > 0) {
      const { data, error } = await db
        .from('submodule_runs')
        .select('id, submodule_id, approved_items, output_render_schema')
        .eq('stage_id', stage.id)
        .eq('status', 'approved');

      if (error) throw error;
      approvedRuns = data || [];

      if (approvedRuns.length === 0) {
        return res.status(400).json({ error: 'At least one submodule must be approved before approving the step' });
      }
    }

    // Compute output_render_schema (union of approved submodule schemas)
    let stageOutputRenderSchema = stage.output_render_schema;
    if (approvedRuns.length > 0) {
      const mergedSchema = {};
      for (const run of approvedRuns) {
        if (run.output_render_schema) {
          Object.assign(mergedSchema, run.output_render_schema);
        }
      }
      if (!mergedSchema.display_type) {
        mergedSchema.display_type = 'table';
      }
      stageOutputRenderSchema = mergedSchema;
    }

    // Finalize pool → output_data
    const outputData = stage.working_pool || [];
    const itemsForwarded = Array.isArray(outputData) ? outputData.length : 0;

    // K003 fix: atomic step approval via Postgres function (single transaction)
    const { data: rpcResult, error: rpcErr } = await db
      .rpc('approve_step', {
        p_stage_id: stage.id,
        p_output_data: outputData,
        p_output_render_schema: stageOutputRenderSchema,
      })
      .single();

    if (rpcErr) throw rpcErr;

    const nextStep = rpcResult.next_step;

    // Log decision
    await db
      .from('decision_log')
      .insert({
        run_id: runId,
        step_index: stepIndex,
        decision: 'step_approved',
        context: {
          approved_submodule_count: approvedRuns.length,
          items_forwarded: itemsForwarded,
          next_step: nextStep,
        },
      });

    res.json({
      step_completed: stepIndex,
      next_step: nextStep,
      items_forwarded: itemsForwarded,
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

    // Log decision
    await db
      .from('decision_log')
      .insert({
        run_id: runId,
        step_index: stepIndex,
        decision: 'step_skipped',
        context: {
          items_passed_through: Array.isArray(stage.input_data) ? stage.input_data.length : 0,
          next_step: nextStep,
        },
      });

    res.json({
      step_skipped: stepIndex,
      next_step: nextStep,
    });
  } catch (err) { next(err); }
});

export default router;
