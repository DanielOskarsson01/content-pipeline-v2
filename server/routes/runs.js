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
 *
 * Per-entity mode: detected by presence of entity_stage_pool rows.
 * Uses approve_step_v2 RPC — pools forwarded via entity_stage_pool, not output_data.
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

    // Detect per-entity mode: check if entity_stage_pool rows exist for this step
    const { data: entityPools, error: poolCheckErr } = await db
      .from('entity_stage_pool')
      .select('entity_name, status')
      .eq('run_id', runId)
      .eq('step_index', stepIndex);

    if (poolCheckErr) throw poolCheckErr;

    const isPerEntity = entityPools && entityPools.length > 0;

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

    // ===== PER-ENTITY STEP APPROVAL =====
    if (isPerEntity) {
      // Prune entity pools after Step 5 (same logic as legacy)
      if (stepIndex >= 5) {
        const { data: allPools } = await db
          .from('entity_stage_pool')
          .select('id, pool_items')
          .eq('run_id', runId)
          .eq('step_index', stepIndex);

        for (const pool of (allPools || [])) {
          if (Array.isArray(pool.pool_items)) {
            const pruned = pool.pool_items.map(item => {
              const p = { ...item };
              delete p.text_content;
              if (p.content_markdown && p.section_count === undefined) {
                delete p.content_markdown;
              }
              return p;
            });
            await db
              .from('entity_stage_pool')
              .update({ pool_items: pruned })
              .eq('id', pool.id);
          }
        }
      }

      // Mark all entity pools at this step as 'approved'
      await db
        .from('entity_stage_pool')
        .update({ status: 'approved', updated_at: new Date().toISOString() })
        .eq('run_id', runId)
        .eq('step_index', stepIndex)
        .neq('status', 'failed');

      const approvedCount = entityPools.filter(p => p.status !== 'failed').length;
      const entityCount = entityPools.length;

      // Use approve_step_v2 — pools forwarded in the RPC function itself
      const { data: rpcResult, error: rpcErr } = await db
        .rpc('approve_step_v2', {
          p_stage_id: stage.id,
          p_output_render_schema: stageOutputRenderSchema,
          p_entity_count: entityCount,
          p_approved_count: approvedCount,
        })
        .single();

      if (rpcErr) throw rpcErr;

      const nextStep = rpcResult.next_step;

      await db
        .from('decision_log')
        .insert({
          run_id: runId,
          step_index: stepIndex,
          decision: 'step_approved',
          context: {
            mode: 'per_entity',
            approved_submodule_count: approvedRuns.length,
            entity_count: entityCount,
            approved_entity_count: approvedCount,
            next_step: nextStep,
          },
        });

      return res.json({
        step_completed: stepIndex,
        next_step: nextStep,
        entity_count: entityCount,
        approved_entity_count: approvedCount,
        mode: 'per_entity',
      });
    }

    // ===== LEGACY STEP APPROVAL =====
    // Finalize pool → output_data
    let outputData = stage.working_pool || [];
    if (stepIndex >= 5 && Array.isArray(outputData)) {
      outputData = outputData.map(item => {
        const pruned = { ...item };
        delete pruned.text_content;
        if (pruned.content_markdown && pruned.section_count === undefined) {
          delete pruned.content_markdown;
        }
        return pruned;
      });
    }
    const itemsForwarded = Array.isArray(outputData) ? outputData.length : 0;

    const { data: rpcResult, error: rpcErr } = await db
      .rpc('approve_step', {
        p_stage_id: stage.id,
        p_output_data: outputData,
        p_output_render_schema: stageOutputRenderSchema,
      })
      .single();

    if (rpcErr) throw rpcErr;

    const nextStep = rpcResult.next_step;

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
 * Skip step — pass input_data -> output_data unchanged, advance.
 * Per-entity mode: forward entity_stage_pool rows unchanged to next step.
 */
router.post('/:runId/steps/:stepIndex/skip', async (req, res, next) => {
  try {
    const { runId, stepIndex: stepIndexStr } = req.params;
    const stepIndex = parseInt(stepIndexStr);

    const { data: stage, error: stageErr } = await db
      .from('pipeline_stages')
      .select('*')
      .eq('run_id', runId)
      .eq('step_index', stepIndex)
      .single();

    if (stageErr) throw stageErr;
    if (!stage) return res.status(404).json({ error: 'Step not found' });
    if (stage.status !== 'active') return res.status(400).json({ error: 'Step is not active' });

    // Detect per-entity mode
    const { data: entityPools } = await db
      .from('entity_stage_pool')
      .select('entity_name, pool_items')
      .eq('run_id', runId)
      .eq('step_index', stepIndex);

    const isPerEntity = entityPools && entityPools.length > 0;
    const isLastStep = stepIndex >= 10;
    let nextStep = isLastStep ? null : stepIndex + 1;

    // Mark skipped
    const { error: skipErr } = await db
      .from('pipeline_stages')
      .update({
        status: 'skipped',
        output_data: isPerEntity ? null : stage.input_data,
        output_render_schema: stage.input_render_schema,
        completed_at: new Date().toISOString(),
      })
      .eq('id', stage.id);

    if (skipErr) throw skipErr;

    if (!isLastStep) {
      if (isPerEntity) {
        // Forward entity pools to next step (UPSERT for idempotency)
        for (const pool of entityPools) {
          await db
            .from('entity_stage_pool')
            .upsert({
              run_id: runId,
              step_index: nextStep,
              entity_name: pool.entity_name,
              pool_items: pool.pool_items,
              status: 'pending',
            }, { onConflict: 'run_id,step_index,entity_name', ignoreDuplicates: true });
        }

        // Activate next step
        await db
          .from('pipeline_stages')
          .update({
            status: 'active',
            entity_count: entityPools.length,
            completed_count: 0,
            failed_count: 0,
            approved_count: 0,
            started_at: new Date().toISOString(),
          })
          .eq('run_id', runId)
          .eq('step_index', nextStep);
      } else {
        // Legacy: copy input_data to next step
        await db
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
      }

      await db
        .from('pipeline_runs')
        .update({ current_step: nextStep })
        .eq('id', runId);
    } else {
      await db
        .from('pipeline_runs')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', runId);
    }

    await db
      .from('decision_log')
      .insert({
        run_id: runId,
        step_index: stepIndex,
        decision: 'step_skipped',
        context: {
          mode: isPerEntity ? 'per_entity' : 'legacy',
          entity_count: isPerEntity ? entityPools.length : undefined,
          items_passed_through: isPerEntity ? undefined : (Array.isArray(stage.input_data) ? stage.input_data.length : 0),
          next_step: nextStep,
        },
      });

    res.json({
      step_skipped: stepIndex,
      next_step: nextStep,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/runs/:runId/steps/:stepIndex/reopen
 * Reopen a completed step so the user can re-run submodules and re-approve.
 * Per-entity mode: reset entity_stage_pool rows, delete forwarded pools at next step.
 */
router.post('/:runId/steps/:stepIndex/reopen', async (req, res, next) => {
  try {
    const { runId, stepIndex: stepIndexStr } = req.params;
    const stepIndex = parseInt(stepIndexStr);

    const { data: stage, error: stageErr } = await db
      .from('pipeline_stages')
      .select('id, status, input_data')
      .eq('run_id', runId)
      .eq('step_index', stepIndex)
      .single();

    if (stageErr) throw stageErr;
    if (!stage) return res.status(404).json({ error: 'Step not found' });
    if (stage.status === 'active') return res.json({ message: 'Step is already active' });
    if (stage.status !== 'completed' && stage.status !== 'skipped') {
      return res.status(400).json({ error: `Cannot reopen step with status: ${stage.status}` });
    }

    // Detect per-entity mode
    const { data: entityPools } = await db
      .from('entity_stage_pool')
      .select('entity_name')
      .eq('run_id', runId)
      .eq('step_index', stepIndex);

    const isPerEntity = entityPools && entityPools.length > 0;

    if (isPerEntity) {
      // 1. Reset entity pools at this step: reload from previous step's approved pools
      const prevStep = stepIndex - 1;
      if (prevStep >= 0) {
        const { data: prevPools } = await db
          .from('entity_stage_pool')
          .select('entity_name, pool_items')
          .eq('run_id', runId)
          .eq('step_index', prevStep)
          .eq('status', 'approved');

        for (const pool of (prevPools || [])) {
          await db
            .from('entity_stage_pool')
            .update({
              pool_items: pool.pool_items,
              status: 'pending',
              error: null,
              updated_at: new Date().toISOString(),
            })
            .eq('run_id', runId)
            .eq('step_index', stepIndex)
            .eq('entity_name', pool.entity_name);
        }
      } else {
        // Step 0 — reset to pending
        await db
          .from('entity_stage_pool')
          .update({ status: 'pending', error: null, updated_at: new Date().toISOString() })
          .eq('run_id', runId)
          .eq('step_index', stepIndex);
      }

      // 2. Delete forwarded entity pools at next step (they'll be recreated on next approval)
      const nextStep = stepIndex + 1;
      if (nextStep <= 10) {
        await db
          .from('entity_stage_pool')
          .delete()
          .eq('run_id', runId)
          .eq('step_index', nextStep);
      }

      // 3. Reset stage
      await db
        .from('pipeline_stages')
        .update({
          status: 'active',
          completed_at: null,
          output_data: null,
          approved_count: 0,
        })
        .eq('id', stage.id);

      // 4. Revert approved entity_submodule_runs
      await db
        .from('entity_submodule_runs')
        .update({ status: 'completed' })
        .eq('run_id', runId)
        .eq('step_index', stepIndex)
        .eq('status', 'approved');
    } else {
      // Legacy: reinitialize pool from input_data
      await db
        .from('pipeline_stages')
        .update({
          status: 'active',
          completed_at: null,
          working_pool: stage.input_data || [],
          output_data: null,
        })
        .eq('id', stage.id);
    }

    // Revert approved submodule_runs back to 'completed'
    await db
      .from('submodule_runs')
      .update({ status: 'completed' })
      .eq('stage_id', stage.id)
      .eq('status', 'approved');

    await db
      .from('decision_log')
      .insert({
        run_id: runId,
        step_index: stepIndex,
        decision: 'step_reopened',
        context: {
          previous_status: stage.status,
          mode: isPerEntity ? 'per_entity' : 'legacy',
        },
      });

    res.json({ step_reopened: stepIndex });
  } catch (err) { next(err); }
});

/**
 * GET /api/runs/:runId/decisions
 * Returns decision log entries for a run, newest first.
 */
router.get('/:runId/decisions', async (req, res, next) => {
  try {
    const { data, error } = await db
      .from('decision_log')
      .select('*')
      .eq('run_id', req.params.runId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) { next(err); }
});

export default router;
