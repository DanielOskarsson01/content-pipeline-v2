/**
 * Submodule Run Routes — execution, polling, approval, re-approval.
 *
 * Routes:
 *   POST /api/runs/:runId/steps/:stepIndex/submodules/:submoduleId/run
 *   GET  /api/submodule-runs/:id
 *   POST /api/submodule-runs/:id/approve
 *   GET  /api/runs/:runId/steps/:stepIndex/submodule-runs/latest
 */

import { Router } from 'express';
import db from '../services/db.js';
import { getSubmoduleById, getSubmodules } from '../services/moduleLoader.js';
import { enqueueSubmoduleJob } from '../services/queue.js';

// --- Execute router (mounted at /api/runs/:runId/steps/:stepIndex/submodules/:submoduleId) ---
export const executeRouter = Router({ mergeParams: true });

/**
 * POST /api/runs/:runId/steps/:stepIndex/submodules/:submoduleId/run
 * Create a BullMQ job to execute the submodule.
 */
executeRouter.post('/run', async (req, res) => {
  try {
    const { runId, stepIndex, submoduleId } = req.params;
    const stepIdx = parseInt(stepIndex, 10);

    // 1. Validate manifest exists
    const manifest = getSubmoduleById(submoduleId);
    if (!manifest) {
      return res.status(404).json({ error: `Submodule not found: ${submoduleId}` });
    }

    // 2. Get stage row
    const { data: stage, error: stageErr } = await db
      .from('pipeline_stages')
      .select('id')
      .eq('run_id', runId)
      .eq('step_index', stepIdx)
      .single();

    if (stageErr || !stage) {
      return res.status(404).json({ error: 'Pipeline stage not found' });
    }

    // 3. Check no active run (409 if pending/running exists)
    const { data: activeRuns } = await db
      .from('submodule_runs')
      .select('id, status')
      .eq('run_id', runId)
      .eq('submodule_id', submoduleId)
      .in('status', ['pending', 'running']);

    if (activeRuns && activeRuns.length > 0) {
      return res.status(409).json({ error: 'Submodule already has an active run', active_run_id: activeRuns[0].id });
    }

    // 4. Resolve input — auto-resolution priority:
    //    0. Request body entities (sent directly from client — no DB roundtrip)
    //    1. Saved input_config (textarea entities or csv reference)
    //    2. Previous step output (step_index > 0)
    //    3. step_context (shared CSV upload, may exist without explicit save)
    let inputData = null;

    // Priority 0: Entities sent directly in request body (most reliable — no save-then-read)
    if (req.body?.entities?.length > 0) {
      inputData = { entities: req.body.entities, run_id: runId, step_index: stepIdx, submodule_id: submoduleId };
    }

    // Priority 1: Check saved input_config (user explicitly saved via SAVE INPUT)
    if (!inputData) {
      const { data: savedConfig } = await db
        .from('run_submodule_config')
        .select('input_config')
        .eq('run_id', runId)
        .eq('step_index', stepIdx)
        .eq('submodule_id', submoduleId)
        .maybeSingle();

      if (savedConfig?.input_config) {
        const inputConfig = savedConfig.input_config;

        if (inputConfig.source === 'textarea' && inputConfig.entities?.length > 0) {
          // Textarea: entities stored directly in input_config
          inputData = { entities: inputConfig.entities, run_id: runId, step_index: stepIdx, submodule_id: submoduleId };
        } else if (inputConfig.source === 'csv') {
          // CSV: load parsed entities from step_context
          const { data: ctx } = await db
            .from('step_context')
            .select('entities')
            .eq('run_id', runId)
            .eq('step_index', stepIdx)
            .maybeSingle();

          if (ctx?.entities) {
            inputData = { entities: ctx.entities, run_id: runId, step_index: stepIdx, submodule_id: submoduleId };
          }
        }
      }
    }

    // Priority 2: Previous step output
    if (!inputData && stepIdx > 0) {
      const { data: prevStage } = await db
        .from('pipeline_stages')
        .select('output_data')
        .eq('run_id', runId)
        .eq('step_index', stepIdx - 1)
        .maybeSingle();

      if (prevStage?.output_data) {
        inputData = { entities: prevStage.output_data, run_id: runId, step_index: stepIdx, submodule_id: submoduleId };
      }
    }

    // Priority 3: step_context (shared CSV upload — may exist without SAVE INPUT)
    if (!inputData) {
      const { data: ctx } = await db
        .from('step_context')
        .select('entities')
        .eq('run_id', runId)
        .eq('step_index', stepIdx)
        .maybeSingle();

      if (ctx?.entities) {
        inputData = { entities: ctx.entities, run_id: runId, step_index: stepIdx, submodule_id: submoduleId };
      }
    }

    if (!inputData) {
      return res.status(400).json({ error: 'No input data available. Upload data or ensure previous step has output.' });
    }

    // 5. Resolve options
    const { data: optConfig } = await db
      .from('run_submodule_config')
      .select('options')
      .eq('run_id', runId)
      .eq('step_index', stepIdx)
      .eq('submodule_id', submoduleId)
      .maybeSingle();

    const options = optConfig?.options || manifest.options_defaults || {};

    // 6. Create submodule_runs row
    const { data: subRun, error: insertErr } = await db
      .from('submodule_runs')
      .insert({
        stage_id: stage.id,
        run_id: runId,
        submodule_id: submoduleId,
        status: 'pending',
        input_data: inputData,
        options,
        output_render_schema: manifest.output_schema || null,
      })
      .select()
      .single();

    if (insertErr) {
      // Unique constraint violation from partial index = concurrent duplicate request
      if (insertErr.code === '23505') {
        return res.status(409).json({ error: 'Submodule already has an active run (concurrent request)' });
      }
      console.error('[execute] Failed to create submodule_runs row:', insertErr);
      return res.status(500).json({ error: 'Failed to create execution record' });
    }

    // 7. Enqueue BullMQ job
    await enqueueSubmoduleJob({
      submoduleRunId: subRun.id,
      submoduleId,
      stepIndex: stepIdx,
      cost: manifest.cost || 'medium',
    });

    res.json({ submodule_run_id: subRun.id, status: 'pending' });
  } catch (err) {
    console.error('[execute] Error:', err);
    res.status(500).json({ error: err.message });
  }
});


// --- Submodule run router (mounted at /api/submodule-runs) ---
export const submoduleRunRouter = Router();

/**
 * GET /api/submodule-runs/:id
 * Polling endpoint — returns status, progress, output_data, approved_items.
 */
submoduleRunRouter.get('/:id', async (req, res) => {
  try {
    const { data, error } = await db
      .from('submodule_runs')
      .select('id, submodule_id, status, progress, output_data, output_render_schema, approved_items, error, started_at, completed_at')
      .eq('id', req.params.id)
      .single();

    if (error?.code === 'PGRST116' || !data) {
      return res.status(404).json({ error: 'Submodule run not found' });
    }
    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('[submodule-runs] GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/submodule-runs/:id/approve
 * Approve (or re-approve) a submodule run.
 * Body: { approved_item_keys: [...] }
 *
 * Re-approval: if status is already "approved", updates approved_items
 * and re-runs the working pool update.
 */
submoduleRunRouter.post('/:id/approve', async (req, res) => {
  try {
    const { approved_item_keys } = req.body;

    if (!Array.isArray(approved_item_keys)) {
      return res.status(400).json({ error: 'approved_item_keys must be an array' });
    }
    if (approved_item_keys.length > 10000) {
      return res.status(400).json({ error: 'approved_item_keys exceeds maximum length (10000)' });
    }
    if (approved_item_keys.some((k) => typeof k !== 'string' && typeof k !== 'number')) {
      return res.status(400).json({ error: 'approved_item_keys must contain only strings or numbers' });
    }

    // 1. Load submodule run
    const { data: subRun, error: getErr } = await db
      .from('submodule_runs')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (getErr?.code === 'PGRST116' || !subRun) {
      return res.status(404).json({ error: 'Submodule run not found' });
    }
    if (getErr) throw getErr;

    // Allow approval from "completed" or re-approval from "approved"
    if (subRun.status !== 'completed' && subRun.status !== 'approved') {
      return res.status(400).json({ error: `Cannot approve run with status "${subRun.status}"` });
    }

    // 2. Get manifest for item_key and data_operation
    const manifest = getSubmoduleById(subRun.submodule_id);
    const itemKey = manifest?.item_key || 'url';

    // 3. Read data_operation from saved config or manifest default
    const { data: savedConfig } = await db
      .from('run_submodule_config')
      .select('data_operation')
      .eq('run_id', subRun.run_id)
      .eq('step_index', subRun.input_data?.step_index)
      .eq('submodule_id', subRun.submodule_id)
      .maybeSingle();

    const dataOperation = savedConfig?.data_operation || manifest?.data_operation_default || 'add';

    // 4. Filter output_data to approved items only
    const outputResults = subRun.output_data?.results || [];
    const approvedKeySet = new Set(approved_item_keys.map(String));
    const approvedItems = [];

    for (const entityResult of outputResults) {
      const items = entityResult.items || [];
      const approved = items.filter((item) => {
        const keyVal = String(item[itemKey] ?? '');
        return approvedKeySet.has(keyVal);
      });
      if (approved.length > 0) {
        approvedItems.push(...approved.map((item) => ({
          ...item,
          entity_name: entityResult.entity_name,
        })));
      }
    }

    // 5. Update working pool (with row-level lock via RPC or sequential update)
    //    Load current pool → apply operation → write back
    const { data: stageRow, error: stageErr } = await db
      .from('pipeline_stages')
      .select('id, working_pool')
      .eq('id', subRun.stage_id)
      .single();

    if (stageErr) throw stageErr;

    let currentPool = stageRow.working_pool || [];

    if (dataOperation === 'add') {
      // Merge approved items into pool, deduplicate by item_key (later wins)
      const poolMap = new Map();
      for (const item of currentPool) {
        poolMap.set(item[itemKey], item);
      }
      for (const item of approvedItems) {
        poolMap.set(item[itemKey], item);
      }
      currentPool = Array.from(poolMap.values());
    } else if (dataOperation === 'remove') {
      // Replace pool with approved items only (filter operation)
      currentPool = approvedItems;
    } else if (dataOperation === 'transform') {
      // Replace pool with approved items (same items, different shape)
      currentPool = approvedItems;
    }

    // 6. Write updated pool back
    await db
      .from('pipeline_stages')
      .update({ working_pool: currentPool })
      .eq('id', subRun.stage_id);

    // 7. Update submodule_runs
    await db
      .from('submodule_runs')
      .update({
        status: 'approved',
        approved_items: approved_item_keys,
      })
      .eq('id', req.params.id);

    // 8. Log decision
    await db
      .from('decision_log')
      .insert({
        run_id: subRun.run_id,
        step_index: subRun.input_data?.step_index ?? 0,
        submodule_id: subRun.submodule_id,
        decision: 'approved',
        context: {
          submodule_run_id: subRun.id,
          approved_count: approved_item_keys.length,
          total_count: outputResults.reduce((sum, r) => sum + (r.items?.length || 0), 0),
          data_operation: dataOperation,
          pool_count: currentPool.length,
        },
      });

    res.json({
      status: 'approved',
      pool_count: currentPool.length,
      approved_count: approved_item_keys.length,
    });
  } catch (err) {
    console.error('[submodule-runs] approve error:', err);
    res.status(500).json({ error: err.message });
  }
});


// --- Latest runs router (mounted at /api/runs/:runId/steps/:stepIndex/submodule-runs) ---
export const latestRunsRouter = Router({ mergeParams: true });

/**
 * GET /api/runs/:runId/steps/:stepIndex/submodule-runs/latest
 * Returns the latest submodule_run per submodule for this step.
 * Used by CategoryCardGrid to show status per submodule row.
 */
latestRunsRouter.get('/latest', async (req, res) => {
  try {
    const { runId, stepIndex } = req.params;
    const stepIdx = parseInt(stepIndex, 10);

    // Get stage_id for this run+step
    const { data: stage } = await db
      .from('pipeline_stages')
      .select('id')
      .eq('run_id', runId)
      .eq('step_index', stepIdx)
      .maybeSingle();

    if (!stage) {
      return res.json({});
    }

    // Get all submodule runs for this stage, ordered by creation (latest first)
    const { data: runs, error } = await db
      .from('submodule_runs')
      .select('id, submodule_id, status, progress, approved_items, output_data, completed_at')
      .eq('stage_id', stage.id)
      .order('completed_at', { ascending: false, nullsFirst: false });

    if (error) throw error;

    // Group by submodule_id, take the latest (first in desc order)
    const latest = {};
    for (const run of runs || []) {
      if (!latest[run.submodule_id]) {
        // Count results
        const outputResults = run.output_data?.results || [];
        const resultCount = outputResults.reduce((sum, r) => sum + (r.items?.length || 0), 0);
        const approvedCount = run.approved_items?.length || 0;

        latest[run.submodule_id] = {
          id: run.id,
          status: run.status,
          progress: run.progress,
          result_count: resultCount,
          approved_count: approvedCount,
        };
      }
    }

    res.json(latest);
  } catch (err) {
    console.error('[latest-runs] Error:', err);
    res.status(500).json({ error: err.message });
  }
});
