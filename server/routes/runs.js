import { Router } from 'express';
import db from '../services/db.js';
import { extractToBlob } from '../services/poolBlobs.js';
import { executeRun, isAutoExecuting, abortAutoExecute } from '../services/autoExecutor.js';
import { getSubmodules, getSubmodulesGroupedByCategory } from '../services/moduleLoader.js';

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

    // Enrich stages with entity counts from entity_stage_pool
    const stagesWithPools = stages || [];
    const stepIndices = stagesWithPools.map(s => s.step_index);

    if (stepIndices.length > 0) {
      const { data: entityPools } = await db
        .from('entity_stage_pool')
        .select('step_index, entity_name, pool_items')
        .eq('run_id', req.params.id)
        .in('step_index', stepIndices);

      if (entityPools && entityPools.length > 0) {
        const poolsByStep = {};
        for (const ep of entityPools) {
          if (!poolsByStep[ep.step_index]) poolsByStep[ep.step_index] = [];
          poolsByStep[ep.step_index].push(ep);
        }

        for (const stage of stagesWithPools) {
          const stepPools = poolsByStep[stage.step_index];
          if (stepPools) {
            stage.entity_count = stage.entity_count || stepPools.length;
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

    // Per-entity mode: populate input_data from entity_stage_pool if missing.
    // Populate entity pool summary from entity_stage_pool.
    // Also lazy-populate input_data if it's empty (e.g. crash during approval).
    const hasInputData = Array.isArray(stage.input_data) && stage.input_data.length > 0;

    {
      const { data: entityPools } = await db
        .from('entity_stage_pool')
        .select('entity_name, pool_items')
        .eq('run_id', runId)
        .eq('step_index', parseInt(stepIndex));

      if (entityPools && entityPools.length > 0) {
        const totalItems = entityPools.reduce((sum, ep) => sum + (ep.pool_items?.length || 0), 0);
        stage.entity_pool_summary = entityPools.map(ep => ({
          name: ep.entity_name,
          item_count: ep.pool_items?.length || 0,
        }));
        stage.entity_count = entityPools.length;
        stage.total_item_count = totalItems;

        // Lazy-populate input_data if it's empty but entity pools have items
        if (!hasInputData && totalItems > 0) {
          const flatItems = [];
          for (const ep of entityPools) {
            for (const item of (ep.pool_items || [])) {
              flatItems.push({ ...item, entity_name: item.entity_name || ep.entity_name });
            }
          }
          stage.input_data = flatItems;
          // Persist so subsequent GETs don't re-flatten
          db.from('pipeline_stages')
            .update({ input_data: flatItems })
            .eq('run_id', runId)
            .eq('step_index', parseInt(stepIndex))
            .then(() => {})
            .catch(err => console.error('[get-stage] Failed to persist input_data:', err));
        }
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
 * Approve step — per-entity mode.
 * Step 0: unconditional advance. Steps 1-10: require at least one approved submodule.
 * Uses approve_step_v2 RPC — pools forwarded via entity_stage_pool.
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

    // Load entity pools for this step
    const { data: entityPools, error: poolCheckErr } = await db
      .from('entity_stage_pool')
      .select('entity_name, status')
      .eq('run_id', runId)
      .eq('step_index', stepIndex);

    if (poolCheckErr) throw poolCheckErr;

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

    // Extract large fields to blobs before forwarding (prevents OOM on pool copies).
    // Previously these fields were deleted — now they're stored in pool_item_blobs
    // and replaced with _blob_ref UUIDs so downstream consumers can hydrate them.
    if (stepIndex >= 5) {
      const PRUNE_FIELDS = ['text_content', 'content_markdown', 'analysis_json', 'seo_plan_json'];
      const { data: allPools } = await db
        .from('entity_stage_pool')
        .select('id, pool_items')
        .eq('run_id', runId)
        .eq('step_index', stepIndex);

      for (const pool of (allPools || [])) {
        if (!Array.isArray(pool.pool_items)) continue;
        let modified = false;
        for (const item of pool.pool_items) {
          // Skip content_markdown for AI-written items (have section_count)
          const fieldsToCheck = PRUNE_FIELDS.filter(f => {
            if (f === 'content_markdown' && item.section_count !== undefined) return false;
            return item[f] != null;
          });
          if (fieldsToCheck.length > 0) {
            const ref = await extractToBlob(item, fieldsToCheck);
            if (ref) modified = true;
          }
        }
        if (modified) {
          await db
            .from('entity_stage_pool')
            .update({ pool_items: pool.pool_items })
            .eq('id', pool.id);
        }
      }
    }

    // Mark completed entity pools at this step as 'approved'
    // Guard: only transition 'completed' → 'approved' (idempotent on retry)
    await db
      .from('entity_stage_pool')
      .update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('run_id', runId)
      .eq('step_index', stepIndex)
      .eq('status', 'completed');

    const approvedCount = entityPools ? entityPools.filter(p => p.status !== 'failed').length : 0;
    const entityCount = entityPools ? entityPools.length : 0;

    // Approve via RPC — pools forwarded in the RPC function itself
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

    // Populate input_data on the next stage so the UI can display forwarded items.
    // The RPC approve_step_v2 handles entity_stage_pool forwarding (the execution
    // source of truth). input_data is a denormalized copy for UI display only.
    if (nextStep !== null) {
      const { data: approvedPools } = await db
        .from('entity_stage_pool')
        .select('entity_name, pool_items')
        .eq('run_id', runId)
        .eq('step_index', stepIndex)
        .eq('status', 'approved');

      if (approvedPools && approvedPools.length > 0) {
        const flatItems = [];
        for (const pool of approvedPools) {
          for (const item of (pool.pool_items || [])) {
            flatItems.push({ ...item, entity_name: item.entity_name || pool.entity_name });
          }
        }
        console.log(`[approve] Populating step ${nextStep} input_data with ${flatItems.length} items from step ${stepIndex}`);
        await db
          .from('pipeline_stages')
          .update({ input_data: flatItems, input_render_schema: stageOutputRenderSchema })
          .eq('run_id', runId)
          .eq('step_index', nextStep);
      }
    }

    await db
      .from('decision_log')
      .insert({
        run_id: runId,
        step_index: stepIndex,
        decision: 'step_approved',
        context: {
          approved_submodule_count: approvedRuns.length,
          entity_count: entityCount,
          approved_entity_count: approvedCount,
          next_step: nextStep,
        },
      });

    // Phase 12b: Progressive save — merge approved config back to template
    // Fires for update_template, new_template, fork_template modes
    try {
      const { data: runRow } = await db
        .from('pipeline_runs')
        .select('project_id')
        .eq('id', runId)
        .single();

      const { data: project } = runRow ? await db
        .from('projects')
        .select('mode, template_id')
        .eq('id', runRow.project_id)
        .single() : { data: null };

      const saveableModes = ['update_template', 'new_template', 'fork_template'];
      if (project?.template_id && saveableModes.includes(project.mode)) {
        // Read run_submodule_config rows for the approved step
        const { data: stepConfigs } = await db
          .from('run_submodule_config')
          .select('submodule_id, options')
          .eq('run_id', runId)
          .eq('step_index', stepIndex);

        if (stepConfigs?.length) {
          // Fetch current template preset_map + execution_plan
          const { data: tpl } = await db
            .from('templates')
            .select('preset_map, execution_plan')
            .eq('id', project.template_id)
            .single();

          const presetMap = { ...(tpl?.preset_map || {}) };
          const execPlan = { ...(tpl?.execution_plan || {}) };
          const submodulesPerStep = { ...(execPlan.submodules_per_step || {}) };
          const stepSubs = [];

          for (const cfg of stepConfigs) {
            if (!cfg.options || typeof cfg.options !== 'object') continue;
            stepSubs.push(cfg.submodule_id);

            // Merge options into preset_map fallback_values
            const existing = presetMap[cfg.submodule_id] || { preset_name: '', fallback_values: {} };
            presetMap[cfg.submodule_id] = {
              preset_name: existing.preset_name,
              fallback_values: { ...existing.fallback_values, ...cfg.options },
            };
          }

          // Update execution_plan with submodules used at this step
          submodulesPerStep[String(stepIndex)] = stepSubs;
          execPlan.submodules_per_step = submodulesPerStep;

          // TODO: Add row locking if multi-user access is needed (single-operator system today)
          await db
            .from('templates')
            .update({ preset_map: presetMap, execution_plan: execPlan, updated_at: new Date().toISOString() })
            .eq('id', project.template_id);

          console.log(`[progressive-save] Updated template ${project.template_id} from step ${stepIndex} (${stepSubs.length} submodules)`);
        }
      }
    } catch (saveErr) {
      // Progressive save failure should not block step approval
      console.error('[progressive-save] Failed:', saveErr.message);
    }

    res.json({
      step_completed: stepIndex,
      next_step: nextStep,
      entity_count: entityCount,
      approved_entity_count: approvedCount,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/runs/:runId/steps/:stepIndex/skip
 * Skip step — forward entity_stage_pool rows unchanged to next step.
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

    const { data: entityPools } = await db
      .from('entity_stage_pool')
      .select('entity_name, pool_items')
      .eq('run_id', runId)
      .eq('step_index', stepIndex);

    const isLastStep = stepIndex >= 10;
    let nextStep = isLastStep ? null : stepIndex + 1;

    // Mark skipped
    const { error: skipErr } = await db
      .from('pipeline_stages')
      .update({
        status: 'skipped',
        output_render_schema: stage.input_render_schema,
        completed_at: new Date().toISOString(),
      })
      .eq('id', stage.id);

    if (skipErr) throw skipErr;

    if (!isLastStep) {
      // Forward entity pools to next step (UPSERT for idempotency)
      for (const pool of (entityPools || [])) {
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
          entity_count: (entityPools || []).length,
          completed_count: 0,
          failed_count: 0,
          approved_count: 0,
          started_at: new Date().toISOString(),
        })
        .eq('run_id', runId)
        .eq('step_index', nextStep);

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
          entity_count: (entityPools || []).length,
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
 * POST /api/runs/:id/complete
 * Explicitly mark a run as completed. The user decides when the run is "done"
 * rather than relying on automatic completion after the last step.
 */
router.post('/:id/complete', async (req, res, next) => {
  try {
    const { data: run, error: runErr } = await db
      .from('pipeline_runs')
      .select('id, status')
      .eq('id', req.params.id)
      .single();

    if (runErr) throw runErr;
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status === 'completed') return res.json({ message: 'Run is already completed' });
    if (run.status !== 'running') {
      return res.status(400).json({ error: `Cannot complete run with status: ${run.status}` });
    }

    await db
      .from('pipeline_runs')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', req.params.id);

    await db
      .from('decision_log')
      .insert({
        run_id: req.params.id,
        step_index: 0,
        decision: 'run_completed',
        context: { completed_by: 'user' },
      });

    res.json({ status: 'completed' });
  } catch (err) { next(err); }
});

/**
 * POST /api/runs/:id/abandon
 * Mark a run as abandoned — used for runs that were started but never finished.
 * Abandoned runs are excluded from active run lists but preserved for audit.
 */
router.post('/:id/abandon', async (req, res, next) => {
  try {
    const { data: run, error: runErr } = await db
      .from('pipeline_runs')
      .select('id, status')
      .eq('id', req.params.id)
      .single();

    if (runErr) throw runErr;
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status === 'abandoned') return res.json({ message: 'Run is already abandoned' });
    if (run.status === 'completed') {
      return res.status(400).json({ error: 'Cannot abandon a completed run' });
    }
    if (run.status === 'auto_executing') {
      return res.status(400).json({ error: 'Abort auto-execute first before abandoning' });
    }

    await db
      .from('pipeline_runs')
      .update({ status: 'abandoned', completed_at: new Date().toISOString() })
      .eq('id', req.params.id);

    await db
      .from('decision_log')
      .insert({
        run_id: req.params.id,
        step_index: 0,
        decision: 'run_abandoned',
        context: { reason: req.body?.reason || 'User abandoned run' },
      });

    res.json({ status: 'abandoned' });
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

/**
 * GET /api/runs/:runId/report
 * Aggregated run report — per-step summary with entity counts,
 * submodule breakdown, success/failure rates, and timing.
 */
router.get('/:runId/report', async (req, res, next) => {
  try {
    const { runId } = req.params;

    // Fetch run + stages
    const [runResult, stagesResult] = await Promise.all([
      db.from('pipeline_runs').select('*').eq('id', runId).single(),
      db.from('pipeline_stages').select('*').eq('run_id', runId).order('step_index'),
    ]);
    if (runResult.error) throw runResult.error;
    if (!runResult.data) return res.status(404).json({ error: 'Run not found' });

    // Fetch entity runs (status/entity tracking) and metrics (items/words/duration)
    const [entityRunsResult, metricsResult] = await Promise.all([
      db.from('entity_submodule_runs')
        .select('submodule_id, entity_name, status, step_index, error')
        .eq('run_id', runId)
        .order('step_index'),
      db.from('pipeline_metrics')
        .select('submodule_id, entity_name, status, duration_ms, step_index')
        .eq('run_id', runId),
    ]);
    if (entityRunsResult.error) throw entityRunsResult.error;
    const entityRuns = entityRunsResult.data || [];
    const metrics = metricsResult.data || [];

    // Build per-step report
    const STEP_NAMES = [
      'Project Start', 'Discovery', 'Validation', 'Scraping',
      'Filtering & Assembly', 'Analysis & Generation', 'Quality Assurance',
      'Routing', 'Bundling', 'Distribution', 'Review',
    ];

    const steps = [];
    for (const stage of (stagesResult.data || [])) {
      const stepRuns = entityRuns.filter(r => r.step_index === stage.step_index);
      const stepMetrics = metrics.filter(m => m.step_index === stage.step_index);
      const bySubmodule = {};
      for (const r of stepRuns) {
        if (!bySubmodule[r.submodule_id]) {
          bySubmodule[r.submodule_id] = { total: 0, completed: 0, failed: 0, duration: 0, entities: new Set(), errors: [] };
        }
        const s = bySubmodule[r.submodule_id];
        s.total++;
        s.entities.add(r.entity_name);
        if (r.status === 'completed' || r.status === 'approved') {
          s.completed++;
        } else if (r.status === 'failed' || r.status === 'error') {
          s.failed++;
          if (r.error) s.errors.push({ entity: r.entity_name, error: r.error });
        }
      }

      // Enrich with duration from metrics
      for (const m of stepMetrics) {
        if (bySubmodule[m.submodule_id]) {
          bySubmodule[m.submodule_id].duration += m.duration_ms || 0;
        }
      }

      const submodules = Object.entries(bySubmodule).map(([id, s]) => ({
        submodule_id: id,
        entities: s.entities.size,
        completed: s.completed,
        failed: s.failed,
        total: s.total,
        items: s.completed, // one item per completed entity run
        words: 0, // not tracked per-entity; kept for schema compat
        success_rate: s.total > 0 ? Math.round((s.completed / s.total) * 1000) / 10 : null,
        errors: s.errors.slice(0, 10),
      }));

      const totalEntities = new Set(stepRuns.map(r => r.entity_name)).size;
      const totalCompleted = stepRuns.filter(r => r.status === 'completed' || r.status === 'approved').length;
      const totalFailed = stepRuns.filter(r => r.status === 'failed' || r.status === 'error').length;

      steps.push({
        step_index: stage.step_index,
        step_name: STEP_NAMES[stage.step_index] || `Step ${stage.step_index}`,
        status: stage.status,
        entities: totalEntities,
        completed: totalCompleted,
        failed: totalFailed,
        items: totalCompleted,
        words: 0,
        submodules,
      });
    }

    // Overall stats
    const totalDuration = metrics.reduce((sum, m) => sum + (m.duration_ms || 0), 0);
    const uniqueEntities = new Set(entityRuns.map(r => r.entity_name)).size;

    res.json({
      run: {
        id: runResult.data.id,
        project_id: runResult.data.project_id,
        status: runResult.data.status,
        current_step: runResult.data.current_step,
        created_at: runResult.data.created_at,
        completed_at: runResult.data.completed_at,
      },
      summary: {
        entities: uniqueEntities,
        total_words: 0,
        total_duration_ms: totalDuration,
        total_cost: 0,
        steps_completed: steps.filter(s => s.status === 'completed' || s.status === 'skipped').length,
        steps_total: steps.length,
      },
      steps,
    });
  } catch (err) { next(err); }
});

// ============================================================
// Phase 12c: Auto-Execute endpoints
// ============================================================

/**
 * POST /api/runs/:runId/auto-execute
 * Start hands-free pipeline execution.
 * Body (optional overrides): { failure_thresholds, step_timeouts }
 */
router.post('/:runId/auto-execute', async (req, res, next) => {
  try {
    const { runId } = req.params;

    const { data: run, error: runErr } = await db
      .from('pipeline_runs')
      .select('id, status, project_id')
      .eq('id', runId)
      .single();

    if (runErr && runErr.code !== 'PGRST116') throw runErr;
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status !== 'running') {
      return res.status(400).json({ error: `Cannot auto-execute run with status "${run.status}"` });
    }
    if (isAutoExecuting(runId)) {
      return res.status(409).json({ error: 'Auto-execute already in progress for this run' });
    }

    // Resolve template execution_plan
    const { data: project } = await db
      .from('projects')
      .select('template_id')
      .eq('id', run.project_id)
      .single();

    let executionPlan = {};
    if (project?.template_id) {
      const { data: template } = await db
        .from('templates')
        .select('execution_plan')
        .eq('id', project.template_id)
        .single();
      executionPlan = template?.execution_plan || {};
    }

    let submodulesPerStep = executionPlan.submodules_per_step || {};

    // Fallback: derive from registered modules if template has no explicit config
    // Uses category + sort_order to match UI display order (not alphabetical)
    if (Object.keys(submodulesPerStep).length === 0) {
      const CATEGORY_ORDER = {
        crawling: 1, news: 2, filtering: 3, scraping: 4, analysis: 5,
        planning: 6, generation: 7, seo: 8, review: 9, qa: 10,
        formatting: 11, bundling: 12, media: 13, data: 14, website: 15, testing: 16,
      };
      for (let step = 0; step <= 10; step++) {
        const grouped = getSubmodulesGroupedByCategory(step);
        // Sort categories by CATEGORY_ORDER, then flatten submodules within each
        const orderedIds = Object.entries(grouped)
          .sort(([a], [b]) => (CATEGORY_ORDER[a] ?? 99) - (CATEGORY_ORDER[b] ?? 99))
          .flatMap(([, subs]) => subs.filter(s => s.active !== false && s.id !== 'test-dummy').map(s => s.id));
        if (orderedIds.length > 0) {
          submodulesPerStep[String(step)] = orderedIds;
        }
      }
      if (Object.keys(submodulesPerStep).length === 0) {
        return res.status(400).json({ error: 'No submodules registered — cannot auto-execute' });
      }
      console.log(`[auto-execute] No submodules_per_step in template — derived from registry (category+sort_order): ${JSON.stringify(submodulesPerStep)}`);
    }

    // Build config: steps 0-10, with overrides from body
    const config = {
      steps: Array.from({ length: 11 }, (_, i) => i),
      skipSteps: (executionPlan.skip_steps || []).map(Number),
      submodulesPerStep,
      failure_thresholds: { ...(executionPlan.failure_thresholds || {}), ...(req.body?.failure_thresholds || {}) },
      step_timeouts: { ...(executionPlan.step_timeouts || {}), ...(req.body?.step_timeouts || {}) },
    };

    // Fire-and-forget
    executeRun(runId, config);

    res.json({ status: 'auto_executing', started_at: new Date().toISOString(), config });
  } catch (err) { next(err); }
});

/**
 * POST /api/runs/:runId/auto-execute/resume
 * Resume from halted state.
 * Body: { override_threshold?: { "3": 0.8 }, skip_step?: number }
 */
router.post('/:runId/auto-execute/resume', async (req, res, next) => {
  try {
    const { runId } = req.params;

    const { data: run, error: runErr } = await db
      .from('pipeline_runs')
      .select('id, status, auto_execute_state, project_id')
      .eq('id', runId)
      .single();

    if (runErr && runErr.code !== 'PGRST116') throw runErr;
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status !== 'halted') {
      return res.status(400).json({ error: `Cannot resume run with status "${run.status}"` });
    }
    if (isAutoExecuting(runId)) {
      return res.status(409).json({ error: 'Auto-execute already in progress for this run' });
    }

    const state = run.auto_execute_state || {};
    const haltedStep = state.halted_step ?? state.current_step ?? 0;

    // Resolve template execution_plan
    const { data: project } = await db
      .from('projects')
      .select('template_id')
      .eq('id', run.project_id)
      .single();

    let executionPlan = {};
    if (project?.template_id) {
      const { data: template } = await db
        .from('templates')
        .select('execution_plan')
        .eq('id', project.template_id)
        .single();
      executionPlan = template?.execution_plan || {};
    }

    // Merge thresholds: original → template → body overrides
    const mergedThresholds = {
      ...(state.failure_thresholds || {}),
      ...(executionPlan.failure_thresholds || {}),
      ...(req.body?.override_threshold || {}),
    };

    // Build skip list from original + body
    const skipSteps = [...(executionPlan.skip_steps || []).map(Number)];
    if (req.body?.skip_step != null) {
      skipSteps.push(Number(req.body.skip_step));
    }

    const config = {
      steps: Array.from({ length: 11 }, (_, i) => i).filter(i => i >= haltedStep),
      skipSteps,
      submodulesPerStep: executionPlan.submodules_per_step || {},
      failure_thresholds: mergedThresholds,
      step_timeouts: { ...(state.step_timeouts || {}), ...(executionPlan.step_timeouts || {}), ...(req.body?.step_timeouts || {}) },
    };

    executeRun(runId, config, state);

    res.json({ status: 'auto_executing', resumed_from_step: haltedStep });
  } catch (err) { next(err); }
});

/**
 * POST /api/runs/:runId/auto-execute/abort
 * Abort in-progress auto-execution. Run reverts to 'running' for manual control.
 */
router.post('/:runId/auto-execute/abort', async (req, res, next) => {
  try {
    const { runId } = req.params;

    const aborted = abortAutoExecute(runId);
    if (!aborted) {
      return res.status(400).json({ error: 'No auto-execute in progress for this run' });
    }

    // The orchestrator will handle status revert on next signal check
    res.json({ aborted: true });
  } catch (err) { next(err); }
});

export default router;
