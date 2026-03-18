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
import { enqueueSubmoduleJob, enqueueEntityBatch } from '../services/queue.js';

const PER_ENTITY_MODE = process.env.PER_ENTITY_MODE === 'true';

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
      .select('id, working_pool')
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
    let inputFromPool = false; // true when entities are derived from pool data (skip enrichment)
    const workingPool = stage.working_pool;

    // 4a. Resolve data_operation FIRST — it determines input routing
    //     ➖/➕ = chaining (use working pool), ＝ = independent (use original input)
    const { data: opConfig } = await db
      .from('run_submodule_config')
      .select('data_operation')
      .eq('run_id', runId)
      .eq('step_index', stepIdx)
      .eq('submodule_id', submoduleId)
      .maybeSingle();
    const dataOperation = opConfig?.data_operation || manifest.data_operation_default || 'transform';
    const isChaining = dataOperation === 'remove' || dataOperation === 'add';
    const hasWorkingPool = Array.isArray(workingPool) && workingPool.length > 0;

    // HIGHEST PRIORITY: Working pool for chaining operations (➖ remove / ➕ add)
    //   When data_operation is 'remove' or 'add' AND the working pool has items,
    //   always use the pool (updated by previous sibling approvals).
    //   This takes precedence over client-sent entities to ensure correct data flow.
    if (isChaining && hasWorkingPool) {
      const entityMap = new Map();
      for (const item of workingPool) {
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

    // Priority 0: Entities sent directly in request body (for ＝ operations or first chaining submodule)
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

    // 4b. Enrich entities with working pool items (sibling submodule support)
    //     Only when entities come from user input (CSV/textarea), NOT when they
    //     already came from pool data (previous step output). Enriching pool-derived
    //     entities with the same pool causes N² data inflation.
    if (!inputFromPool && Array.isArray(workingPool) && workingPool.length > 0) {
      const poolByEntity = new Map();
      for (const item of workingPool) {
        const name = item.entity_name || 'unknown';
        if (!poolByEntity.has(name)) {
          poolByEntity.set(name, []);
        }
        poolByEntity.get(name).push(item);
      }

      let enrichedCount = 0;
      for (const entity of inputData.entities) {
        const entityName = entity.name || entity.entity_name;
        const poolItems = poolByEntity.get(entityName) || [];
        if (poolItems.length > 0) {
          // Append to existing items (don't replace if entity already has items)
          entity.items = (entity.items || []).concat(poolItems);
          enrichedCount += poolItems.length;
        } else if (!entity.items) {
          entity.items = [];
        }
      }
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

    // ===== PER-ENTITY MODE =====
    if (PER_ENTITY_MODE) {
      // 6e. Bulk-read entity pools for this step (MANDATORY: 1 query, not N)
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
        return res.status(400).json({ error: 'No entities available for per-entity execution' });
      }

      // Build a lookup for original entity data (Step 1: entities have properties like website, linkedin)
      // Use originalEntities (set when pools are first created) or fall back to step_context
      // (which preserves the original CSV entity fields). inputData.entities may be pool-derived
      // (re-grouped URL items from working_pool) and lack fields like website/linkedin.
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

      // 7e. Create batch record in submodule_runs
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

      // 8e. Bulk-insert entity_submodule_runs (MANDATORY: 1 insert, not N)
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

      // 9e. Enqueue via FlowProducer (MANDATORY: 1 Redis call, not N)
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

      return res.json({
        submodule_run_id: batchRun.id,
        batch_id: batchId,
        entity_count: entities.length,
        status: 'running',
        mode: 'per_entity',
      });
    }

    // ===== LEGACY MODE =====
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

    // 7. Enqueue BullMQ job (R002 fix: clean up pending row if enqueue fails)
    try {
      await enqueueSubmoduleJob({
        submoduleRunId: subRun.id,
        submoduleId,
        stepIndex: stepIdx,
        cost: manifest.cost || 'medium',
      });
    } catch (enqueueErr) {
      // Enqueue failed (Redis down, BullMQ error) — mark row as failed to avoid orphaned pending
      console.error(`[execute] BullMQ enqueue failed for submodule_run ${subRun.id}:`, enqueueErr);
      await db
        .from('submodule_runs')
        .update({ status: 'failed', error: `Enqueue failed: ${enqueueErr.message}` })
        .eq('id', subRun.id);
      return res.status(500).json({ error: `Failed to enqueue job: ${enqueueErr.message}` });
    }

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

    // Legacy mode: return full output_data
    // Downloadable fields (e.g. text_content) are stored in a separate table
    if (req.query.full === 'true' && data.output_data?.results && data.output_render_schema?.downloadable_fields) {
      const manifest = getSubmoduleById(data.submodule_id);
      const itemKeyField = manifest?.item_key || 'url';

      const { data: itemData } = await db
        .from('submodule_run_item_data')
        .select('item_key, field_name, content')
        .eq('submodule_run_id', req.params.id);

      if (itemData?.length > 0) {
        const lookup = new Map();
        for (const row of itemData) {
          if (!lookup.has(row.item_key)) lookup.set(row.item_key, {});
          lookup.get(row.item_key)[row.field_name] = row.content;
        }
        for (const entity of data.output_data.results) {
          for (const item of (entity.items || [])) {
            const key = String(item[itemKeyField] ?? '');
            const extra = lookup.get(key);
            if (extra) Object.assign(item, extra);
          }
        }
      }
    } else if (data.output_data?.results && data.output_render_schema?.downloadable_fields) {
      const downloadFields = new Set(
        data.output_render_schema.downloadable_fields.map((d) => d.field)
      );
      for (const entity of data.output_data.results) {
        for (const item of (entity.items || [])) {
          for (const field of downloadFields) {
            delete item[field];
          }
        }
      }
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

    // ===== PER-ENTITY APPROVAL =====
    if (subRun.batch_id) {
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
        const resolvedKeys = approvedKeys === '__all__'
          ? outputItems.map(item => String(item[itemKey] ?? '')).filter(Boolean)
          : approvedKeys;

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
          const existingKeys = new Set(entityPool.map(item => String(item[itemKey] ?? '')));
          for (const item of approvedItems) {
            const key = String(item[itemKey] ?? '');
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

    // ===== LEGACY APPROVAL =====
    const { approved_item_keys } = req.body;

    if (!Array.isArray(approved_item_keys)) {
      return res.status(400).json({ error: 'approved_item_keys must be an array' });
    }
    if (approved_item_keys.length > 50000) {
      return res.status(400).json({ error: 'approved_item_keys exceeds maximum length (50000)' });
    }
    if (approved_item_keys.some((k) => typeof k !== 'string' && typeof k !== 'number')) {
      return res.status(400).json({ error: 'approved_item_keys must contain only strings or numbers' });
    }

    // 2. Get data_operation
    const { data: savedConfig } = await db
      .from('run_submodule_config')
      .select('data_operation')
      .eq('run_id', subRun.run_id)
      .eq('step_index', subRun.input_data?.step_index)
      .eq('submodule_id', subRun.submodule_id)
      .maybeSingle();

    const dataOperation = savedConfig?.data_operation || manifest?.data_operation_default || 'add';

    // 3. Filter output_data to approved items only
    const outputResults = subRun.output_data?.results || [];
    const approvedKeySet = new Set(req.body.approved_item_keys.map(String));
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
          source_submodule: subRun.submodule_id,
        })));
      }
    }

    // 4. Update working pool
    const { data: stageRow, error: stageErr } = await db
      .from('pipeline_stages')
      .select('id, working_pool')
      .eq('id', subRun.stage_id)
      .single();

    if (stageErr) throw stageErr;

    let currentPool = stageRow.working_pool || [];

    const poolKey = (item) => {
      const src = item.source_submodule;
      if (src) {
        const srcManifest = getSubmoduleById(src);
        const srcKey = srcManifest?.item_key || 'url';
        return `${src}:${item[srcKey] ?? ''}`;
      }
      return String(item[itemKey] ?? '');
    };

    if (dataOperation === 'add') {
      const poolMap = new Map();
      for (const item of currentPool) {
        poolMap.set(poolKey(item), item);
      }
      for (const item of approvedItems) {
        poolMap.set(poolKey(item), item);
      }
      currentPool = Array.from(poolMap.values());
    } else if (dataOperation === 'remove') {
      const seen = new Set();
      currentPool = currentPool.filter((item) => {
        const keyVal = String(item[itemKey] ?? '');
        if (!approvedKeySet.has(keyVal)) return false;
        if (seen.has(keyVal)) return false;
        seen.add(keyVal);
        return true;
      });
    } else if (dataOperation === 'transform') {
      const currentSubmoduleId = subRun.submodule_id;
      const stepIndex = subRun.input_data?.step_index;
      const stepSubmoduleIds = new Set(getSubmodules(stepIndex).map(m => m.id));
      const approvedBaseKeys = new Set(
        approvedItems.map(item => String(item[itemKey] ?? ''))
      );

      const remaining = currentPool.filter(item => {
        const baseKey = String(item[itemKey] ?? '');
        if (!approvedBaseKeys.has(baseKey)) return true;

        const src = item.source_submodule;
        if (src === currentSubmoduleId) return false;

        if (!src || !stepSubmoduleIds.has(src)) {
          const srcManifest = src ? getSubmoduleById(src) : null;
          const srcItemKey = srcManifest?.item_key || 'url';
          return srcItemKey !== itemKey;
        }

        const sibManifest = getSubmoduleById(src);
        const sibItemKey = sibManifest?.item_key || 'url';
        const sibDataOp = sibManifest?.data_operation_default || 'add';
        if (sibItemKey === itemKey && sibDataOp === 'transform') return false;

        return true;
      });

      currentPool = [...remaining, ...approvedItems];
    }

    // 5. Write updated pool back
    const { error: poolUpdateErr } = await db
      .from('pipeline_stages')
      .update({ working_pool: currentPool })
      .eq('id', subRun.stage_id);

    if (poolUpdateErr) {
      console.error(`[approve] POOL UPDATE FAILED:`, poolUpdateErr);
    }

    // 6. Update submodule_runs
    await db
      .from('submodule_runs')
      .update({
        status: 'approved',
        approved_items: approved_item_keys,
      })
      .eq('id', req.params.id);

    // 7. Log decision
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
        // Per-entity batch run
        if (run.batch_id) {
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
        } else {
          // Legacy run
          const outputResults = run.output_data?.results || [];
          const resultCount = outputResults.reduce((sum, r) => sum + (r.items?.length || 0), 0);
          const approvedCount = run.approved_items?.length || 0;
          const outputSummary = run.output_data?.summary || {};

          latest[run.submodule_id] = {
            id: run.id,
            status: run.status,
            progress: run.progress,
            result_count: resultCount,
            approved_count: approvedCount,
            description: outputSummary.description || null,
            completed_at: run.completed_at || null,
            error: run.error || null,
          };
        }
      }
    }

    res.json(latest);
  } catch (err) {
    console.error('[latest-runs] Error:', err);
    res.status(500).json({ error: err.message });
  }
});
