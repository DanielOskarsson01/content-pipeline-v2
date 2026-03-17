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

    // Downloadable fields (e.g. text_content) are stored in a separate table
    // (submodule_run_item_data) to avoid row-size limits.
    // Normal poll: return as-is (already stripped by worker). Safety strip for old data.
    // ?full=true: merge from separate table for detail modal / download.
    if (req.query.full === 'true' && data.output_data?.results && data.output_render_schema?.downloadable_fields) {
      // Merge downloadable fields from separate table
      const manifest = getSubmoduleById(data.submodule_id);
      const itemKeyField = manifest?.item_key || 'url';

      const { data: itemData } = await db
        .from('submodule_run_item_data')
        .select('item_key, field_name, content')
        .eq('submodule_run_id', req.params.id);

      if (itemData?.length > 0) {
        // Build lookup: item_key → { field_name: content }
        const lookup = new Map();
        for (const row of itemData) {
          if (!lookup.has(row.item_key)) lookup.set(row.item_key, {});
          lookup.get(row.item_key)[row.field_name] = row.content;
        }
        // Merge into result items
        for (const entity of data.output_data.results) {
          for (const item of (entity.items || [])) {
            const key = String(item[itemKeyField] ?? '');
            const extra = lookup.get(key);
            if (extra) Object.assign(item, extra);
          }
        }
      }
    } else if (data.output_data?.results && data.output_render_schema?.downloadable_fields) {
      // Safety strip for normal poll (handles old runs where worker didn't strip)
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
    if (approved_item_keys.length > 50000) {
      return res.status(400).json({ error: 'approved_item_keys exceeds maximum length (50000)' });
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
          source_submodule: subRun.submodule_id,
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

    // Pool dedup key: use each item's SOURCE submodule's item_key for the base,
    // so URL-level items (keyed by url) don't collapse when an entity-level
    // submodule (keyed by entity_name) runs an add operation.
    const poolKey = (item) => {
      const src = item.source_submodule;
      if (src) {
        const srcManifest = getSubmoduleById(src);
        const srcKey = srcManifest?.item_key || 'url';
        return `${src}:${item[srcKey] ?? ''}`;
      }
      // No source_submodule → use current submodule's item_key
      return String(item[itemKey] ?? '');
    };

    if (dataOperation === 'add') {
      // Merge approved items into pool, deduplicate by pool key (later wins)
      const poolMap = new Map();
      for (const item of currentPool) {
        poolMap.set(poolKey(item), item);
      }
      for (const item of approvedItems) {
        poolMap.set(poolKey(item), item);
      }
      currentPool = Array.from(poolMap.values());
    } else if (dataOperation === 'remove') {
      // Filter pool: keep only items whose key was approved, AND deduplicate.
      // The pool may contain multiple items with the same key (e.g. same URL
      // discovered by two Step 1 submodules). The remove filter keeps only
      // the first occurrence per approved key — matching dedup behavior.
      const seen = new Set();
      currentPool = currentPool.filter((item) => {
        const keyVal = String(item[itemKey] ?? '');
        if (!approvedKeySet.has(keyVal)) return false;
        if (seen.has(keyVal)) return false;
        seen.add(keyVal);
        return true;
      });
    } else if (dataOperation === 'transform') {
      // Granularity-aware replace:
      // 1. Previous-step items: only remove if they share the same item_key
      //    (url→url OK, but entity_name transform keeps url-level items)
      // 2. Siblings: only remove if sibling also uses transform with same item_key
      //    (browser-scraper replaces page-scraper, but content-analyzer
      //    doesn't clobber seo-planner/content-writer)
      const currentSubmoduleId = subRun.submodule_id;
      const stepIndex = subRun.input_data?.step_index;
      const stepSubmoduleIds = new Set(getSubmodules(stepIndex).map(m => m.id));
      const approvedBaseKeys = new Set(
        approvedItems.map(item => String(item[itemKey] ?? ''))
      );

      const remaining = currentPool.filter(item => {
        const baseKey = String(item[itemKey] ?? '');
        if (!approvedBaseKeys.has(baseKey)) return true; // no conflict

        const src = item.source_submodule;

        // Re-approval of same submodule → replace
        if (src === currentSubmoduleId) return false;

        // From outside this step (previous step or unknown)
        if (!src || !stepSubmoduleIds.has(src)) {
          // Only replace if source used the same item_key granularity
          // e.g. content-analyzer (entity_name) keeps page-scraper (url) items
          const srcManifest = src ? getSubmoduleById(src) : null;
          const srcItemKey = srcManifest?.item_key || 'url';
          return srcItemKey !== itemKey;
        }

        // Sibling at this step — only replace transform siblings with same item_key
        const sibManifest = getSubmoduleById(src);
        const sibItemKey = sibManifest?.item_key || 'url';
        const sibDataOp = sibManifest?.data_operation_default || 'add';
        if (sibItemKey === itemKey && sibDataOp === 'transform') return false;

        // Keep all other siblings (add/remove siblings coexist)
        return true;
      });

      currentPool = [...remaining, ...approvedItems];
    }

    // 6. Write updated pool back
    const { error: poolUpdateErr } = await db
      .from('pipeline_stages')
      .update({ working_pool: currentPool })
      .eq('id', subRun.stage_id);

    if (poolUpdateErr) {
      console.error(`[approve] POOL UPDATE FAILED:`, poolUpdateErr);
    }

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
      .select('id, submodule_id, status, progress, approved_items, output_data, completed_at, error')
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

    res.json(latest);
  } catch (err) {
    console.error('[latest-runs] Error:', err);
    res.status(500).json({ error: err.message });
  }
});
