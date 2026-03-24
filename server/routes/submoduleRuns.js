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
import { randomUUID } from 'crypto';
import db from '../services/db.js';
import { getSubmoduleById, getSubmodules } from '../services/moduleLoader.js';
import { enqueueEntityBatch } from '../services/queue.js';

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
      .select('id, status, started_at')
      .eq('run_id', runId)
      .eq('submodule_id', submoduleId)
      .in('status', ['pending', 'running']);

    if (activeRuns && activeRuns.length > 0) {
      // Auto-clear runs stuck for >10 minutes (server restart, Redis blip, worker crash)
      const STUCK_THRESHOLD_MS = 10 * 60 * 1000;
      const now = Date.now();
      let allCleared = true;
      for (const run of activeRuns) {
        const startedAt = run.started_at ? new Date(run.started_at).getTime() : 0;
        if (now - startedAt > STUCK_THRESHOLD_MS) {
          console.warn(`[execute] Auto-failing stuck run ${run.id} (status: ${run.status}, started: ${run.started_at})`);
          await db
            .from('submodule_runs')
            .update({ status: 'failed', error: 'Auto-cleared: stuck for >10 minutes', completed_at: new Date().toISOString() })
            .eq('id', run.id);
        } else {
          allCleared = false;
        }
      }
      if (!allCleared) {
        return res.status(409).json({ error: 'Submodule already has an active run', active_run_id: activeRuns[0].id });
      }
    }

    // 4. Resolve input — auto-resolution priority:
    //    0. Request body entities (sent directly from client — no DB roundtrip)
    //    1. Saved input_config (textarea entities or csv reference)
    //    2. Previous step output (step_index > 0)
    //    3. step_context (shared CSV upload, may exist without explicit save)
    let inputData = null;
    let inputFromPool = false; // true when entities are flat pool items that need re-grouping

    const { data: opConfig } = await db
      .from('run_submodule_config')
      .select('data_operation')
      .eq('run_id', runId)
      .eq('step_index', stepIdx)
      .eq('submodule_id', submoduleId)
      .maybeSingle();
    // Priority 0: Entities sent directly in request body
    if (!inputData && req.body?.entities?.length > 0) {
      let entities = req.body.entities;
      inputFromPool = !!req.body.from_previous_step;

      // When entities come from previous step pool, they're flat items that need re-grouping
      // into { name, items: [] } format expected by submodule execute functions
      if (inputFromPool && entities.length > 0 && !entities[0].items) {
        const entityMap = new Map();
        for (const item of entities) {
          const name = item.entity_name || 'unknown';
          if (!entityMap.has(name)) entityMap.set(name, { name, items: [] });
          entityMap.get(name).items.push(item);
        }
        entities = Array.from(entityMap.values());
      }

      inputData = { entities, run_id: runId, step_index: stepIdx, submodule_id: submoduleId };
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
          inputData = { entities: inputConfig.entities, run_id: runId, step_index: stepIdx, submodule_id: submoduleId };
        } else if (inputConfig.source === 'csv') {
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

    // Priority 2: Previous step output (re-group flat pool items into entity format)
    if (!inputData && stepIdx > 0) {
      const { data: prevStage } = await db
        .from('pipeline_stages')
        .select('output_data')
        .eq('run_id', runId)
        .eq('step_index', stepIdx - 1)
        .maybeSingle();

      if (prevStage?.output_data && Array.isArray(prevStage.output_data) && prevStage.output_data.length > 0) {
        // Working pool is a flat array of items with entity_name.
        // Re-group into entity format: [{ name, items: [...] }]
        const poolItems = prevStage.output_data;
        const entityMap = new Map();
        for (const item of poolItems) {
          const name = item.entity_name || 'unknown';
          if (!entityMap.has(name)) {
            entityMap.set(name, { name, items: [] });
          }
          entityMap.get(name).items.push(item);
        }
        const groupedEntities = Array.from(entityMap.values());
        inputData = { entities: groupedEntities, run_id: runId, step_index: stepIdx, submodule_id: submoduleId };
        inputFromPool = true;
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

    // 5b. Resolve doc_selector options: replace doc ID arrays with {filename: content} maps
    for (const optDef of (manifest.options || [])) {
      if (optDef.type === 'doc_selector' && Array.isArray(options[optDef.name])) {
        const docIds = options[optDef.name];
        if (docIds.length > 0) {
          const { data: docs } = await db
            .from('project_reference_docs')
            .select('filename, content')
            .in('id', docIds);
          const docMap = {};
          for (const doc of (docs || [])) {
            docMap[doc.filename] = doc.content;
          }
          options[optDef.name] = docMap;
        } else {
          options[optDef.name] = {};
        }
      }
    }

    // 6. Bulk-read entity pools for this step (MANDATORY: 1 query, not N)
    const { data: entityPools, error: poolErr } = await db
      .from('entity_stage_pool')
      .select('entity_name, pool_items')
      .eq('run_id', runId)
      .eq('step_index', stepIdx);

    if (poolErr) throw poolErr;

    // If no entity pools exist yet (Step 0/1), create them from inputData entities
    let entities;
    let originalEntities = null; // Keep full entity objects for input_data
    if (entityPools && entityPools.length > 0) {
      entities = entityPools;
    } else if (inputData?.entities?.length > 0) {
      // First submodule at this step — initialize entity_stage_pool from input entities
      originalEntities = inputData.entities;
      const poolRows = inputData.entities.map(e => ({
        run_id: runId,
        step_index: stepIdx,
        entity_name: e.name || e.entity_name || 'unknown',
        pool_items: e.items || [],
        status: 'pending',
      }));

      const { error: initErr } = await db
        .from('entity_stage_pool')
        .upsert(poolRows, { onConflict: 'run_id,step_index,entity_name', ignoreDuplicates: true });

      if (initErr) throw initErr;

      entities = poolRows.map(r => ({ entity_name: r.entity_name, pool_items: r.pool_items }));

      // Update stage entity_count
      await db
        .from('pipeline_stages')
        .update({ entity_count: entities.length })
        .eq('id', stage.id);
    } else {
      return res.status(400).json({ error: 'No entities available for execution' });
    }

    // Build a lookup for original entity data (Step 1: entities have properties like website, linkedin)
    // Use originalEntities (set when pools are first created) or fall back to step_context
    // (which preserves the original CSV entity fields).
    const originalEntityMap = new Map();
    let entitySource = originalEntities || [];
    if (entitySource.length === 0) {
      // Pools already existed — load original entity properties from step_context
      const { data: ctx } = await db
        .from('step_context')
        .select('entities')
        .eq('run_id', runId)
        .eq('step_index', stepIdx)
        .maybeSingle();
      if (ctx?.entities) {
        entitySource = ctx.entities;
      } else {
        // Last resort: use inputData.entities (may be pool-derived, missing entity fields)
        entitySource = inputData?.entities || [];
      }
    }
    for (const e of entitySource) {
      const name = e.name || e.entity_name || 'unknown';
      originalEntityMap.set(name, e);
    }

    // 7. Create batch record in submodule_runs
    const batchId = randomUUID();
    const { data: batchRun, error: batchErr } = await db
      .from('submodule_runs')
      .insert({
        stage_id: stage.id,
        run_id: runId,
        submodule_id: submoduleId,
        status: 'pending',
        options,
        batch_id: batchId,
        entity_count: entities.length,
        completed_count: 0,
        input_data: { step_index: stepIdx, submodule_id: submoduleId },
        output_render_schema: manifest.output_schema || null,
      })
      .select()
      .single();

    if (batchErr) {
      if (batchErr.code === '23505') {
        return res.status(409).json({ error: 'Submodule already has an active run (concurrent request)' });
      }
      throw batchErr;
    }

    // 8. Bulk-insert entity_submodule_runs (MANDATORY: 1 insert, not N)
    const entityRunRows = entities.map(ep => {
      // Merge full entity properties (website, linkedin, etc.) with pool items
      const orig = originalEntityMap.get(ep.entity_name) || {};
      const entity = {
        ...orig,
        name: ep.entity_name,
        items: ep.pool_items || [],
      };

      return {
        stage_id: stage.id,
        run_id: runId,
        batch_id: batchId,
        entity_name: ep.entity_name,
        submodule_id: submoduleId,
        step_index: stepIdx,
        status: 'pending',
        options,
        input_data: {
          entity,
          run_id: runId,
          step_index: stepIdx,
          submodule_id: submoduleId,
        },
        output_render_schema: manifest.output_schema || null,
      };
    });

    const { data: insertedRuns, error: entityInsertErr } = await db
      .from('entity_submodule_runs')
      .insert(entityRunRows)
      .select('id, entity_name');

    if (entityInsertErr) throw entityInsertErr;

    // 9. Enqueue via FlowProducer (MANDATORY: 1 Redis call, not N)
    try {
      await enqueueEntityBatch({
        batchId,
        submoduleRunId: batchRun.id,
        submoduleId,
        stepIndex: stepIdx,
        cost: manifest.cost || 'medium',
        entityRuns: insertedRuns.map(r => ({
          entitySubmoduleRunId: r.id,
          entityName: r.entity_name,
        })),
      });
    } catch (enqueueErr) {
      console.error(`[execute] FlowProducer enqueue failed for batch ${batchId}:`, enqueueErr);
      await db.from('submodule_runs').update({ status: 'failed', error: `Enqueue failed: ${enqueueErr.message}` }).eq('id', batchRun.id);
      await db.from('entity_submodule_runs').update({ status: 'failed', error: 'Batch enqueue failed' }).eq('batch_id', batchId);
      return res.status(500).json({ error: `Failed to enqueue entity batch: ${enqueueErr.message}` });
    }

    // Update submodule_runs to running
    await db.from('submodule_runs').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', batchRun.id);

    res.json({
      submodule_run_id: batchRun.id,
      batch_id: batchId,
      entity_count: entities.length,
      status: 'running',
    });
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
 * Per-entity mode: lightweight (MANDATORY) — no output_data in batch poll.
 * Use /api/submodule-runs/:id/entities for entity-level detail.
 */
submoduleRunRouter.get('/:id', async (req, res) => {
  try {
    const { data, error } = await db
      .from('submodule_runs')
      .select('id, submodule_id, status, progress, output_data, output_render_schema, approved_items, error, batch_id, entity_count, completed_count, started_at, completed_at')
      .eq('id', req.params.id)
      .single();

    if (error?.code === 'PGRST116' || !data) {
      return res.status(404).json({ error: 'Submodule run not found' });
    }
    if (error) throw error;

    // Per-entity batch run: lightweight polling (MANDATORY — no output_data)
    if (data.batch_id) {
      // Compute live progress from entity_submodule_runs
      const { data: entityStatuses } = await db
        .from('entity_submodule_runs')
        .select('id, entity_name, status, progress, error')
        .eq('batch_id', data.batch_id);

      const entities = (entityStatuses || []).map(e => ({
        id: e.id,
        entity_name: e.entity_name,
        status: e.status,
        progress: e.progress,
        error: e.error,
      }));

      const completed = entities.filter(e => e.status === 'completed' || e.status === 'approved').length;
      const failed = entities.filter(e => e.status === 'failed').length;

      return res.json({
        id: data.id,
        submodule_id: data.submodule_id,
        status: data.status,
        batch_id: data.batch_id,
        entity_count: data.entity_count || entities.length,
        completed_count: completed,
        failed_count: failed,
        progress: null,
        output_render_schema: data.output_render_schema,
        approved_items: data.approved_items,
        error: data.error,
        started_at: data.started_at,
        completed_at: data.completed_at,
        entities,
        mode: 'per_entity',
      });
    }

    res.json(data);
  } catch (err) {
    console.error('[submodule-runs] GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/submodule-runs/:id/entities/:entityRunId
 * Per-entity detail — returns full output_data for a single entity run.
 * Loaded lazily when user expands an entity in the UI.
 */
submoduleRunRouter.get('/:id/entities/:entityRunId', async (req, res) => {
  try {
    const { data, error } = await db
      .from('entity_submodule_runs')
      .select('id, entity_name, submodule_id, status, progress, output_data, output_render_schema, approved_items, error, logs, started_at, completed_at')
      .eq('id', req.params.entityRunId)
      .single();

    if (error?.code === 'PGRST116' || !data) {
      return res.status(404).json({ error: 'Entity submodule run not found' });
    }
    if (error) throw error;

    // Merge downloadable fields if requested
    if (req.query.full === 'true' && data.output_data?.items && data.output_render_schema?.downloadable_fields) {
      const manifest = getSubmoduleById(data.submodule_id);
      const itemKeyField = manifest?.item_key || 'url';

      const { data: itemData } = await db
        .from('submodule_run_item_data')
        .select('item_key, field_name, content')
        .eq('submodule_run_id', req.params.entityRunId);

      if (itemData?.length > 0) {
        const lookup = new Map();
        for (const row of itemData) {
          if (!lookup.has(row.item_key)) lookup.set(row.item_key, {});
          lookup.get(row.item_key)[row.field_name] = row.content;
        }
        for (const item of (data.output_data.items || [])) {
          const key = String(item[itemKeyField] ?? '');
          const extra = lookup.get(key);
          if (extra) Object.assign(item, extra);
        }
      }
    }

    res.json(data);
  } catch (err) {
    console.error('[entity-submodule-runs] GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/submodule-runs/:id/all-items
 * Returns aggregated items across ALL entity runs for a batch.
 * Used by the Download All CTA in per-entity mode.
 * Supports ?full=true to merge downloadable fields (text_content etc.).
 */
submoduleRunRouter.get('/:id/all-items', async (req, res) => {
  try {
    // 1. Load the batch run to get submodule_id
    const { data: batchRun, error: batchErr } = await db
      .from('submodule_runs')
      .select('id, submodule_id, batch_id')
      .eq('id', req.params.id)
      .single();

    if (batchErr?.code === 'PGRST116' || !batchRun) {
      return res.status(404).json({ error: 'Batch run not found' });
    }
    if (batchErr) throw batchErr;

    const manifest = getSubmoduleById(batchRun.submodule_id);
    const itemKeyField = manifest?.item_key || 'url';

    // 2. Load all completed/approved entity runs for this batch
    const { data: entityRuns, error: entityErr } = await db
      .from('entity_submodule_runs')
      .select('id, entity_name, output_data')
      .eq('batch_id', batchRun.batch_id)
      .in('status', ['completed', 'approved']);

    if (entityErr) throw entityErr;

    // 3. Flatten all items across entities
    const allItems = [];
    const entityRunIds = [];
    for (const er of (entityRuns || [])) {
      entityRunIds.push(er.id);
      for (const item of (er.output_data?.items || [])) {
        allItems.push({ ...item, entity_name: item.entity_name || er.entity_name });
      }
    }

    // 4. Merge downloadable fields if requested
    if (req.query.full === 'true' && entityRunIds.length > 0) {
      const { data: itemData } = await db
        .from('submodule_run_item_data')
        .select('item_key, field_name, content')
        .in('submodule_run_id', entityRunIds);

      if (itemData?.length > 0) {
        const lookup = new Map();
        for (const row of itemData) {
          if (!lookup.has(row.item_key)) lookup.set(row.item_key, {});
          lookup.get(row.item_key)[row.field_name] = row.content;
        }
        for (const item of allItems) {
          const key = String(item[itemKeyField] ?? '');
          const extra = lookup.get(key);
          if (extra) Object.assign(item, extra);
        }
      }
    }

    res.json({ items: allItems, total: allItems.length });
  } catch (err) {
    console.error('[submodule-runs] GET all-items error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/submodule-runs/:id/abort
 * Abort a running or pending submodule run.
 * Marks the batch run + all pending/running entity runs as 'failed'.
 * Running worker jobs will check for abort status before writing results.
 */
submoduleRunRouter.post('/:id/abort', async (req, res) => {
  try {
    const { data: subRun, error: getErr } = await db
      .from('submodule_runs')
      .select('id, status, batch_id')
      .eq('id', req.params.id)
      .single();

    if (getErr?.code === 'PGRST116' || !subRun) {
      return res.status(404).json({ error: 'Submodule run not found' });
    }
    if (getErr) throw getErr;

    if (subRun.status !== 'pending' && subRun.status !== 'running') {
      return res.status(400).json({ error: `Cannot abort run with status "${subRun.status}"` });
    }

    const now = new Date().toISOString();

    // Mark pending entity runs as failed (they haven't started, nothing to save).
    // Running entity runs are left alone — the worker will finish, save results,
    // and the batch worker will finalize the parent status.
    let abortedCount = 0;
    let runningCount = 0;
    if (subRun.batch_id) {
      const { data: aborted } = await db.from('entity_submodule_runs')
        .update({ status: 'failed', error: 'Aborted by user', completed_at: now })
        .eq('status', 'pending')
        .eq('batch_id', subRun.batch_id)
        .select('id');
      abortedCount = aborted?.length || 0;

      // Check if any entities are still running
      const { count } = await db.from('entity_submodule_runs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'running')
        .eq('batch_id', subRun.batch_id);
      runningCount = count || 0;
    }

    if (runningCount > 0) {
      // Don't mark parent as failed yet — running entities will finish and
      // the batch worker will set the correct final status with approve enabled.
      console.log(`[submodule-runs] Aborted run ${subRun.id}: ${abortedCount} pending cancelled, ${runningCount} still running — waiting for completion`);
    } else {
      // No running entities — mark parent as failed immediately
      await db.from('submodule_runs')
        .update({ status: 'failed', error: 'Aborted by user', completed_at: now })
        .eq('id', subRun.id);
      console.log(`[submodule-runs] Aborted run ${subRun.id}, ${abortedCount} entity runs cancelled`);
    }

    res.json({ aborted: true, entity_runs_cancelled: abortedCount, still_running: runningCount });
  } catch (err) {
    console.error('[submodule-runs] POST abort error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/submodule-runs/:id/approve
 * Approve (or re-approve) a submodule run.
 * Body: { approved_item_keys: [...] }
 *
 * Per-entity mode: Body: { entity_approvals: { entityName: [item_keys], ... } }
 * Bulk-updates entity_submodule_runs + entity_stage_pool.
 *
 * Re-approval: if status is already "approved", updates approved_items
 * and re-runs the working pool update.
 */
submoduleRunRouter.post('/:id/approve', async (req, res) => {
  try {
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

    if (subRun.status !== 'completed' && subRun.status !== 'approved') {
      return res.status(400).json({ error: `Cannot approve run with status "${subRun.status}"` });
    }

    const manifest = getSubmoduleById(subRun.submodule_id);
    const itemKey = manifest?.item_key || 'url';

    if (!subRun.batch_id) {
      return res.status(400).json({ error: 'Legacy runs without batch_id are no longer supported' });
    }

    {
      const { entity_approvals } = req.body;
      if (!entity_approvals || typeof entity_approvals !== 'object') {
        return res.status(400).json({ error: 'Per-entity mode requires entity_approvals: { entityName: [item_keys] }' });
      }

      // Read data_operation
      const { data: savedConfig } = await db
        .from('run_submodule_config')
        .select('data_operation')
        .eq('run_id', subRun.run_id)
        .eq('step_index', subRun.input_data?.step_index ?? 0)
        .eq('submodule_id', subRun.submodule_id)
        .maybeSingle();

      const dataOperation = savedConfig?.data_operation || manifest?.data_operation_default || 'add';

      // Bulk-load all entity runs for this batch
      const { data: entityRuns, error: entityErr } = await db
        .from('entity_submodule_runs')
        .select('id, entity_name, output_data, status')
        .eq('batch_id', subRun.batch_id)
        .in('status', ['completed', 'approved']);

      if (entityErr) throw entityErr;

      // Bulk-load current entity pools
      const { data: currentPools, error: poolErr } = await db
        .from('entity_stage_pool')
        .select('entity_name, pool_items')
        .eq('run_id', subRun.run_id)
        .eq('step_index', subRun.input_data?.step_index ?? 0);

      if (poolErr) throw poolErr;

      const poolMap = new Map();
      for (const pool of (currentPools || [])) {
        poolMap.set(pool.entity_name, pool.pool_items || []);
      }

      let totalApproved = 0;

      // Process each entity's approval
      for (const [entityName, approvedKeys] of Object.entries(entity_approvals)) {
        const entityRun = entityRuns.find(r => r.entity_name === entityName);
        if (!entityRun) continue;

        const outputItems = entityRun.output_data?.items || [];

        // __all__ sentinel: approve every item without the client needing to fetch detail
        // BUT respect flagged_when rules — flagged items (e.g. DROP) are excluded
        let resolvedKeys;
        if (approvedKeys === '__all__') {
          const flaggedWhen = manifest?.output_schema?.flagged_when;
          resolvedKeys = outputItems
            .filter(item => {
              if (!flaggedWhen) return true;
              return !Object.entries(flaggedWhen).some(
                ([field, values]) => values.includes(String(item[field] ?? ''))
              );
            })
            .map(item => String(item[itemKey] ?? ''))
            .filter(Boolean);
        } else {
          resolvedKeys = approvedKeys;
        }

        const approvedKeySet = new Set(resolvedKeys.map(String));
        const approvedItems = outputItems.filter(item => {
          const keyVal = String(item[itemKey] ?? '');
          return approvedKeySet.has(keyVal);
        }).map(item => ({
          ...item,
          entity_name: entityName,
          source_submodule: subRun.submodule_id,
        }));

        totalApproved += approvedItems.length;

        // Update entity pool based on data_operation
        let entityPool = poolMap.get(entityName) || [];

        if (dataOperation === 'add') {
          // Use composite key (itemKey + source_submodule) so different submodules
          // can each contribute items with the same item_key (e.g. entity_name)
          const compositeKey = (item) => `${String(item[itemKey] ?? '')}::${item.source_submodule || ''}`;
          const existingKeys = new Set(entityPool.map(compositeKey));
          for (const item of approvedItems) {
            const key = compositeKey(item);
            if (!existingKeys.has(key)) {
              entityPool.push(item);
              existingKeys.add(key);
            }
          }
        } else if (dataOperation === 'remove') {
          entityPool = entityPool.filter(item => {
            const keyVal = String(item[itemKey] ?? '');
            return approvedKeySet.has(keyVal);
          });
        } else if (dataOperation === 'transform') {
          // Transform replaces items with matching keys — remove ALL existing
          // items that share a key with the approved items (regardless of source).
          // Original input items (no source_submodule) and sibling submodule items
          // are both replaced by the enriched versions.
          const approvedUrlSet = new Set(approvedItems.map(item => String(item[itemKey] ?? '')));
          entityPool = entityPool.filter(item => {
            const key = String(item[itemKey] ?? '');
            return !approvedUrlSet.has(key);
          });
          entityPool.push(...approvedItems);
        }

        poolMap.set(entityName, entityPool);

        // Update entity_submodule_runs status
        await db
          .from('entity_submodule_runs')
          .update({ status: 'approved', approved_items: resolvedKeys })
          .eq('id', entityRun.id);
      }

      // Bulk update entity_stage_pool (UPSERT for idempotency)
      for (const [entityName, poolItems] of poolMap) {
        await db
          .from('entity_stage_pool')
          .update({ pool_items: poolItems, updated_at: new Date().toISOString() })
          .eq('run_id', subRun.run_id)
          .eq('step_index', subRun.input_data?.step_index ?? 0)
          .eq('entity_name', entityName);
      }

      // Update batch record
      await db
        .from('submodule_runs')
        .update({ status: 'approved' })
        .eq('id', req.params.id);

      // Log decision
      await db
        .from('decision_log')
        .insert({
          run_id: subRun.run_id,
          step_index: subRun.input_data?.step_index ?? 0,
          submodule_id: subRun.submodule_id,
          decision: 'approved',
          context: {
            submodule_run_id: subRun.id,
            mode: 'per_entity',
            entity_count: Object.keys(entity_approvals).length,
            total_approved: totalApproved,
            data_operation: dataOperation,
          },
        });

      return res.json({
        status: 'approved',
        mode: 'per_entity',
        entity_count: Object.keys(entity_approvals).length,
        total_approved: totalApproved,
      });
    }
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
      .select('id, submodule_id, status, progress, approved_items, output_data, batch_id, entity_count, completed_count, completed_at, error')
      .eq('stage_id', stage.id)
      .order('completed_at', { ascending: false, nullsFirst: false });

    if (error) throw error;

    // For per-entity batch runs, aggregate item counts from entity_submodule_runs
    const batchIds = (runs || []).filter(r => r.batch_id).map(r => r.batch_id);
    const batchCounts = {};
    if (batchIds.length > 0) {
      const { data: entityRuns } = await db
        .from('entity_submodule_runs')
        .select('batch_id, output_data, approved_items')
        .in('batch_id', batchIds);

      for (const er of entityRuns || []) {
        if (!batchCounts[er.batch_id]) batchCounts[er.batch_id] = { result: 0, approved: 0 };
        batchCounts[er.batch_id].result += er.output_data?.items?.length || 0;
        batchCounts[er.batch_id].approved += er.approved_items?.length || 0;
      }
    }

    // Group by submodule_id, take the latest (first in desc order)
    const latest = {};
    for (const run of runs || []) {
      if (!latest[run.submodule_id]) {
        const counts = batchCounts[run.batch_id] || { result: 0, approved: 0 };
        latest[run.submodule_id] = {
          id: run.id,
          status: run.status,
          progress: run.progress,
          batch_id: run.batch_id,
          entity_count: run.entity_count || 0,
          completed_count: run.completed_count || 0,
          result_count: counts.result,
          approved_count: counts.approved,
          description: counts.approved > 0
            ? `${counts.approved} items approved across ${run.entity_count || 0} entities`
            : null,
          completed_at: run.completed_at || null,
          error: run.error || null,
          mode: 'per_entity',
        };
      }
    }

    res.json(latest);
  } catch (err) {
    console.error('[latest-runs] Error:', err);
    res.status(500).json({ error: err.message });
  }
});
