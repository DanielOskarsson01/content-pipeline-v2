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

    // Per-entity mode: enrich stages with entity pool summaries where working_pool is empty
    const stagesWithPools = stages || [];
    const emptyPoolSteps = stagesWithPools
      .filter(s => !s.working_pool || (Array.isArray(s.working_pool) && s.working_pool.length === 0))
      .map(s => s.step_index);

    if (emptyPoolSteps.length > 0) {
      const { data: entityPools } = await db
        .from('entity_stage_pool')
        .select('step_index, entity_name, pool_items')
        .eq('run_id', req.params.id)
        .in('step_index', emptyPoolSteps);

      if (entityPools && entityPools.length > 0) {
        const poolsByStep = {};
        for (const ep of entityPools) {
          if (!poolsByStep[ep.step_index]) poolsByStep[ep.step_index] = [];
          poolsByStep[ep.step_index].push(ep);
        }

        for (const stage of stagesWithPools) {
          const stepPools = poolsByStep[stage.step_index];
          if (stepPools) {
            stage.working_pool = stepPools.map(ep => ({
              name: ep.entity_name,
              item_count: ep.pool_items?.length || 0,
            }));
            stage.entity_count = stepPools.length;
            stage.total_item_count = stepPools.reduce((sum, ep) => sum + (ep.pool_items?.length || 0), 0);
          }
        }
      }
    }

    res.json({ ...run, stages: stagesWithPools });
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

    // Per-entity mode: if working_pool is empty, populate from entity_stage_pool
    // Put entity summaries in a SEPARATE field (entity_pool_summary) so the UI
    // can fall through to input_data for actual item display.
    if (!stage.working_pool || (Array.isArray(stage.working_pool) && stage.working_pool.length === 0)) {
      const { data: entityPools } = await db
        .from('entity_stage_pool')
        .select('entity_name, pool_items')
        .eq('run_id', runId)
        .eq('step_index', parseInt(stepIndex));

      if (entityPools && entityPools.length > 0) {
        const totalItems = entityPools.reduce((sum, ep) => sum + (ep.pool_items?.length || 0), 0);
        // Flatten entity pool items into working_pool so the UI can display actual items
        const flatItems = [];
        for (const ep of entityPools) {
          for (const item of (ep.pool_items || [])) {
            flatItems.push({ ...item, entity_name: item.entity_name || ep.entity_name });
          }
        }
        stage.working_pool = flatItems;
        stage.entity_pool_summary = entityPools.map(ep => ({
          name: ep.entity_name,
          item_count: ep.pool_items?.length || 0,
        }));
        stage.entity_count = entityPools.length;
        stage.total_item_count = totalItems;
      }
    }

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

      // Forward data to next step (two destinations):
      //   1. entity_stage_pool at nextStep — for per-entity execution
      //   2. pipeline_stages.input_data at nextStep — for UI display and legacy code
      //
      // The RPC approve_step_v2 handles (1) via INSERT ... ON CONFLICT DO NOTHING.
      // But if pools already existed (e.g. stale from a previous attempt), the
      // INSERT is skipped. We verify and fix here.
      if (nextStep !== null) {
        // Read current step's approved pools (guaranteed to exist & have data)
        const { data: approvedPools } = await db
          .from('entity_stage_pool')
          .select('entity_name, pool_items')
          .eq('run_id', runId)
          .eq('step_index', stepIndex)
          .eq('status', 'approved');

        if (approvedPools && approvedPools.length > 0) {
          // Verify next step pools were created with data by the RPC
          const { data: nextPools } = await db
            .from('entity_stage_pool')
            .select('entity_name, pool_items')
            .eq('run_id', runId)
            .eq('step_index', nextStep);

          const nextPoolsEmpty = !nextPools || nextPools.length === 0 ||
            nextPools.every(p => !p.pool_items || p.pool_items.length === 0);

          if (nextPoolsEmpty) {
            logger.warn(`RPC did not populate next step pools — manually forwarding from step ${stepIndex}`);
            // Delete any stale empty pools and re-create with actual data
            if (nextPools && nextPools.length > 0) {
              await db
                .from('entity_stage_pool')
                .delete()
                .eq('run_id', runId)
                .eq('step_index', nextStep);
            }
            const forwardRows = approvedPools.map(p => ({
              run_id: runId,
              step_index: nextStep,
              entity_name: p.entity_name,
              pool_items: p.pool_items || [],
              status: 'pending',
            }));
            await db
              .from('entity_stage_pool')
              .insert(forwardRows);
            logger.info(`Manually forwarded ${forwardRows.length} entity pools to step ${nextStep}`);
          }

          // Flatten all items for input_data (UI display)
          const flatItems = [];
          for (const pool of approvedPools) {
            for (const item of (pool.pool_items || [])) {
              flatItems.push({ ...item, entity_name: item.entity_name || pool.entity_name });
            }
          }
          logger.info(`Forwarding ${flatItems.length} items from step ${stepIndex} to step ${nextStep} input_data`);
          await db
            .from('pipeline_stages')
            .update({ input_data: flatItems, input_render_schema: stageOutputRenderSchema })
            .eq('run_id', runId)
            .eq('step_index', nextStep);
        } else {
          logger.warn(`No approved pools found at step ${stepIndex} for run ${runId} — data not forwarded`);
        }
      }

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
 * Reopen a completed step — HARD RESET from this step onwards.
 * Deletes all submodule runs, entity runs, pools, and stage data for this
 * step AND every downstream step. Only the reopened step is set to 'active';
 * downstream steps revert to 'pending'.
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

    // Get ALL stages from this step onwards
    const { data: allStages } = await db
      .from('pipeline_stages')
      .select('id, step_index, status')
      .eq('run_id', runId)
      .gte('step_index', stepIndex)
      .order('step_index');

    const stageIds = (allStages || []).map(s => s.id);
    const downstreamStageIds = (allStages || []).filter(s => s.step_index > stepIndex).map(s => s.id);
    const downstreamSteps = (allStages || []).filter(s => s.step_index > stepIndex).map(s => s.step_index);

    // --- HARD DELETE: wipe all run data from this step onwards ---

    // 1. Delete submodule_run_item_data (downloadable field storage)
    if (stageIds.length > 0) {
      // Get submodule_run IDs for bulk deletion
      const { data: subRunIds } = await db
        .from('submodule_runs')
        .select('id')
        .in('stage_id', stageIds);
      const srIds = (subRunIds || []).map(r => r.id);
      if (srIds.length > 0) {
        await db.from('submodule_run_item_data').delete().in('submodule_run_id', srIds);
      }

      // Also entity_submodule_runs item data
      const { data: entityRunIds } = await db
        .from('entity_submodule_runs')
        .select('id')
        .in('stage_id', stageIds);
      const erIds = (entityRunIds || []).map(r => r.id);
      if (erIds.length > 0) {
        await db.from('submodule_run_item_data').delete().in('submodule_run_id', erIds);
      }
    }

    // 2. Delete entity_submodule_runs for ALL affected steps
    await db
      .from('entity_submodule_runs')
      .delete()
      .eq('run_id', runId)
      .gte('step_index', stepIndex);

    // 3. Delete submodule_runs for ALL affected stages
    if (stageIds.length > 0) {
      await db
        .from('submodule_runs')
        .delete()
        .in('stage_id', stageIds);
    }

    // 4. Delete entity_stage_pool for ALL affected steps
    await db
      .from('entity_stage_pool')
      .delete()
      .eq('run_id', runId)
      .gte('step_index', stepIndex);

    // 5. Delete step_context for ALL affected steps (uploaded CSV data)
    await db
      .from('step_context')
      .delete()
      .eq('run_id', runId)
      .gte('step_index', stepIndex);

    // 6. Delete run_submodule_config for ALL affected steps
    await db
      .from('run_submodule_config')
      .delete()
      .eq('run_id', runId)
      .gte('step_index', stepIndex);

    // 7. Reset the reopened step to 'active' with clean state
    await db
      .from('pipeline_stages')
      .update({
        status: 'active',
        completed_at: null,
        working_pool: null,
        output_data: null,
        approved_count: 0,
      })
      .eq('id', stage.id);

    // 8. Reset downstream stages to 'pending'
    if (downstreamStageIds.length > 0) {
      await db
        .from('pipeline_stages')
        .update({
          status: 'pending',
          completed_at: null,
          working_pool: null,
          output_data: null,
          input_data: null,
          approved_count: 0,
        })
        .in('id', downstreamStageIds);
    }

    // 9. Log
    await db
      .from('decision_log')
      .insert({
        run_id: runId,
        step_index: stepIndex,
        decision: 'step_reopened',
        context: {
          previous_status: stage.status,
          hard_reset: true,
          steps_wiped: [stepIndex, ...downstreamSteps],
        },
      });

    console.log(`[reopen] Step ${stepIndex}: hard reset — wiped steps ${stepIndex}-${Math.max(stepIndex, ...downstreamSteps)}, deleted ${stageIds.length} stages' data`);

    res.json({ step_reopened: stepIndex, steps_wiped: [stepIndex, ...downstreamSteps] });
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
