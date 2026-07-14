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
import { enqueueEntityBatch, redis } from '../services/queue.js';
import { applyDataOperation, isFailedRun } from '../lib/applyDataOperation.js';
import { resolveBatchLoopIteration } from '../utils/loopIteration.js';

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
    // Multi-Card Pattern: NULL = default Round 1; UUID scopes the batch to a
    // retry card so different cards can run concurrently per the new partial
    // unique index. PHASE_3B_SPEC §6.2.
    const cardId = req.query.card_id || null;

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

    // 3. Check no active run (409 if pending/running exists for this card).
    // Scoping by card_id mirrors the partial unique index so a Round 1 batch
    // can coexist with retry batches on different cards.
    let activeRunsQuery = db
      .from('submodule_runs')
      .select('id, status, started_at')
      .eq('run_id', runId)
      .eq('submodule_id', submoduleId)
      .in('status', ['pending', 'running']);
    if (cardId === null) {
      activeRunsQuery = activeRunsQuery.is('card_id', null);
    } else {
      activeRunsQuery = activeRunsQuery.eq('card_id', cardId);
    }
    const { data: activeRuns } = await activeRunsQuery;

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
    //    2. Previous step output_data (step_index > 0)
    //    3. Current step input_data (populated by approve_step_v2 forwarding)
    //    4. step_context (shared CSV upload, may exist without explicit save)
    //    5. entity_stage_pool at this step (re-run / existing pools)
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

    // Priority 3: Current step's input_data (populated by approve_step_v2 forwarding)
    if (!inputData) {
      const { data: currentStage } = await db
        .from('pipeline_stages')
        .select('input_data')
        .eq('run_id', runId)
        .eq('step_index', stepIdx)
        .maybeSingle();

      if (currentStage?.input_data && Array.isArray(currentStage.input_data) && currentStage.input_data.length > 0) {
        const poolItems = currentStage.input_data;
        const entityMap = new Map();
        for (const item of poolItems) {
          const name = item.entity_name || 'unknown';
          if (!entityMap.has(name)) entityMap.set(name, { name, items: [] });
          entityMap.get(name).items.push(item);
        }
        inputData = { entities: Array.from(entityMap.values()), run_id: runId, step_index: stepIdx, submodule_id: submoduleId };
        inputFromPool = true;
      }
    }

    // Priority 4: step_context (shared CSV upload — may exist without SAVE INPUT)
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

    // Priority 5: entity_stage_pool already exists for this step (re-run scenario)
    // When a submodule re-runs at a step where pools were already initialized,
    // the previous priorities may fail (e.g. Step N-1 output_data empty in per-entity mode).
    // The pools themselves are the source of truth.
    if (!inputData) {
      const { data: existingPools } = await db
        .from('entity_stage_pool')
        .select('entity_name, pool_items')
        .eq('run_id', runId)
        .eq('step_index', stepIdx);

      if (existingPools && existingPools.length > 0) {
        const entities = existingPools.map(p => ({
          name: p.entity_name,
          items: p.pool_items || [],
        }));
        inputData = { entities, run_id: runId, step_index: stepIdx, submodule_id: submoduleId };
        inputFromPool = true;
      }
    }

    if (!inputData) {
      console.error(`[submoduleRuns] No input data for ${submoduleId} at step ${stepIdx} run ${runId}`);
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

    const options = { ...(manifest.options_defaults || {}), ...(optConfig?.options || {}) };

    // 5a. Persist resolved options so progressive save / from-run template creation
    // can pick them up. Must happen BEFORE doc_selector expansion (which replaces
    // doc ID arrays with {filename: content} maps that shouldn't be stored).
    // Note: PostgREST upsert only updates specified columns on conflict —
    // existing input_config and data_operation are preserved.
    try {
      await db.from('run_submodule_config').upsert({
        run_id: runId,
        step_index: stepIdx,
        submodule_id: submoduleId,
        options,
        updated_at: new Date().toISOString(),
        // B052: card_id in the conflict target so PostgREST can infer the live
        // (run_id, step_index, submodule_id, card_id) NULLS NOT DISTINCT index.
      }, { onConflict: 'run_id,step_index,submodule_id,card_id' });
    } catch (persistErr) {
      console.warn(`[submoduleRuns] Failed to persist resolved options for ${submoduleId}:`, persistErr.message);
    }

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

    // Section C (2026-06-04): is_loop_pass flag retired. Request cardId is now
    // the routed-retry signal. Section C dropped apply_entity_routing (the sole
    // setter of is_loop_pass=TRUE), so a fresh read here would always return
    // FALSE on new runs and become a misleading branch on legacy data. The
    // cardId invariant is structural-plumbing through the writer chain:
    // runs.js → autoExecutor → cardGroups.js → batchWorker → /run with cardId.

    // Prefer execution_plan_snapshot so mid-run template edits cannot poison
    // routing decisions; fall back to live template for runs created before
    // the snapshot column was wired.
    let cardDefinitions = {};
    if (cardId) {
      const { data: runRow } = await db.from('pipeline_runs')
        .select('project_id, execution_plan_snapshot').eq('id', runId).single();
      if (runRow?.execution_plan_snapshot?.card_definitions) {
        cardDefinitions = runRow.execution_plan_snapshot.card_definitions;
      } else if (runRow) {
        const { data: proj } = await db.from('projects')
          .select('template_id').eq('id', runRow.project_id).single();
        if (proj?.template_id) {
          const { data: tpl } = await db.from('templates')
            .select('execution_plan').eq('id', proj.template_id).single();
          cardDefinitions = tpl?.execution_plan?.card_definitions || {};
        }
      }
    }

    // On card-routed retries: reset 'completed' pools back to 'pending' before
    // loading. stageWorker sets pool status to 'completed' after each submodule
    // run, but subsequent submodules at the same step still need to process
    // these entities. Only 'failed' pools stay excluded.
    if (cardId) {
      await db
        .from('entity_stage_pool')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('run_id', runId)
        .eq('step_index', stepIdx)
        .eq('status', 'completed');
    }

    // Bulk-read entity pools for this step (MANDATORY: 1 query, not N)
    // On card-routed retries: only process pending entities (routed entities)
    let poolQuery = db
      .from('entity_stage_pool')
      .select('entity_name, pool_items, status')
      .eq('run_id', runId)
      .eq('step_index', stepIdx);
    if (cardId) {
      poolQuery = poolQuery.eq('status', 'pending');
    }
    const { data: entityPools, error: poolErr } = await poolQuery;

    if (poolErr) throw poolErr;

    // Filter out terminal entities on card-routed retries — they already
    // passed QA and shouldn't re-process (saves ~9x LLM cost per retry step)
    let filteredPools = entityPools || [];
    if (cardId) {
      const { data: terminalEntities } = await db
        .from('entity_run_meta')
        .select('entity_name')
        .eq('run_id', runId)
        .not('terminal_state', 'is', null);

      const terminalSet = new Set((terminalEntities || []).map(e => e.entity_name));
      if (terminalSet.size > 0) {
        filteredPools = filteredPools.filter(p => !terminalSet.has(p.entity_name));
        console.log(`[submoduleRuns] Card-routed retry: filtered out ${terminalSet.size} terminal entities, ${filteredPools.length} remaining`);
      }
    }

    // Load entity_run_meta loop metadata for ALL groups — default (card_id=null)
    // AND card-routed. The default group needs loop_count too: after a backward
    // route, default-group submodules (content-analyzer/seo-planner/tone-seo-editor)
    // re-execute in Round 2+ and MUST be stamped with the bumped loop_iteration so
    // autoExecutor's iteration-scoped completion wait + resume-safety check match.
    // Gating this load on `if (cardId)` stamped default-group Round-2 rows with a
    // stale 0 → the iter=1 wait never matched → false 120s "batchWorker may be down"
    // timeout → halt before the routed card ran (sub-plan 4 task 2, fixed 2026-06-27).
    // Section C pre-flight (2026-06-03): dropped loop_config from select
    // — verified unused in this file (grep loopMeta.loop_config returns 0).
    const { data: entityMeta } = await db
      .from('entity_run_meta')
      .select('entity_name, loop_count, card_instructions')
      .eq('run_id', runId);
    const metaMap = new Map((entityMeta || []).map(m => [m.entity_name, m]));

    // If no entity pools exist yet (Step 0/1), create them from inputData entities
    let entities;
    let originalEntities = null; // Keep full entity objects for input_data
    if (filteredPools.length > 0) {
      entities = filteredPools;

      // Card-routed: scope to body entities only. Without this, a card group
      // of [Wazdan] would batch every entity in the pool — violating the
      // "one card_id per entity per submodule per batch" invariant.
      if (cardId) {
        if (!inputData?.entities?.length) {
          return res.status(400).json({
            error: `Card-routed run requires body.entities. card_id=${cardId} step=${stepIdx} submodule=${submoduleId}`,
          });
        }
        const bodyNames = new Set(inputData.entities.map(e => e.name || e.entity_name).filter(Boolean));
        entities = filteredPools.filter(p => bodyNames.has(p.entity_name));
        if (entities.length === 0) {
          return res.status(400).json({
            error: `Card-routed run: no body entities ([${[...bodyNames].join(',')}]) found in pool at step ${stepIdx}/${submoduleId}. card_id=${cardId}`,
          });
        }
      }

      // Defensive merge: if inputData has entities not in the pool (e.g. stale pool from a
      // previous partial run where fewer entities were processed), add the missing ones.
      // This prevents valid entities from being silently dropped when auto-execute re-runs
      // a step that was partially initialized by a previous manual or partial run.
      // Card-routed batches handled above with body-only scoping — execution only
      // reaches this branch when cardId is falsy (if/else-if exclusivity).
      // Section C (2026-06-04): dropped the `!isLoopPass &&` guard. Under the
      // Multi-Card Pattern, routed retries always carry cardId; a non-card-routed
      // step-rerun with widened entities is a legitimate re-execution that should
      // respect the wider entity set (the OLD silently-drop behavior under
      // isLoopPass=true was load-bearing only in the deprecated routing model).
      else if (inputData?.entities?.length > filteredPools.length) {
        const existingNames = new Set(filteredPools.map(p => p.entity_name));
        const missingEntities = inputData.entities.filter(e => {
          const name = e.name || e.entity_name || 'unknown';
          return !existingNames.has(name);
        });

        if (missingEntities.length > 0) {
          const newPoolRows = missingEntities.map(e => ({
            run_id: runId,
            step_index: stepIdx,
            entity_name: e.name || e.entity_name || 'unknown',
            pool_items: e.items || [],
            status: 'pending',
          }));

          const { error: mergeErr } = await db
            .from('entity_stage_pool')
            .upsert(newPoolRows, { onConflict: 'run_id,step_index,entity_name', ignoreDuplicates: true });

          if (!mergeErr) {
            entities = [...filteredPools, ...newPoolRows.map(r => ({ entity_name: r.entity_name, pool_items: r.pool_items, status: r.status }))];
            console.log(`[submoduleRuns] Merged ${missingEntities.length} missing entities into pool at step ${stepIdx} (was ${filteredPools.length}, now ${entities.length})`);

            // Update stage entity_count to reflect actual count
            await db
              .from('pipeline_stages')
              .update({ entity_count: entities.length })
              .eq('id', stage.id);
          }
        }
      }
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

    // ── PRECONDITION CHECK ─────────────────────────────────────────────────
    // Before fanning out per-entity work, evaluate each entity's pool against
    // the module's pool_precondition. Entities that don't meet the precondition
    // are marked skipped_no_input directly (no BullMQ job). This catches the
    // empty-pool bug class at runtime instead of silently dropping output later.
    const precondition = manifest?.pool_precondition;
    if (!precondition) {
      // Defensive — moduleLoader validation (Task 8) should already reject
      // manifests without this field. Never trust past one layer.
      return res.status(500).json({
        error: `Module ${submoduleId} has no pool_precondition declared. Cannot evaluate execution readiness.`,
      });
    }

    const executableEntities = [];
    const skippedEntities = [];
    for (const entity of entities) {
      const poolItems = Array.isArray(entity.pool_items) ? entity.pool_items : [];
      if (precondition === 'requires_items' && poolItems.length === 0) {
        skippedEntities.push(entity);
      } else {
        executableEntities.push(entity);
      }
    }

    if (skippedEntities.length > 0) {
      console.warn(`[execute] ${submoduleId}: ${skippedEntities.length}/${entities.length} entities skipped — pool empty, module pool_precondition=requires_items`);
    }
    // ── END PRECONDITION CHECK ─────────────────────────────────────────────

    // loop_iteration is the entity's current round (entity_run_meta.loop_count),
    // card-agnostic — see resolveBatchLoopIteration. Default groups after routing
    // may legitimately mix per-entity loop_counts; the helper picks the first
    // (matches autoExecutor.processStep:230-238).
    const batchLoopIteration = resolveBatchLoopIteration(entities, metaMap);

    // 7. Create batch record in submodule_runs
    const batchId = randomUUID();

    // All-skipped fast path: create completed submodule_run, insert skipped rows, return early.
    if (executableEntities.length === 0) {
      const { data: skippedBatchRun, error: skippedBatchErr } = await db
        .from('submodule_runs')
        .insert({
          stage_id: stage.id,
          run_id: runId,
          submodule_id: submoduleId,
          status: 'completed',
          options,
          batch_id: batchId,
          card_id: cardId,
          loop_iteration: batchLoopIteration,
          entity_count: entities.length,
          completed_count: 0,
          completed_at: new Date().toISOString(),
          input_data: { step_index: stepIdx, submodule_id: submoduleId },
          output_render_schema: manifest.output_schema || null,
          progress: {
            current: 0,
            total: 0,
            message: `Skipped — 0 of ${entities.length} entities had pool items (precondition: ${precondition})`,
          },
        })
        .select()
        .single();

      if (skippedBatchErr) {
        if (skippedBatchErr.code === '23505') {
          return res.status(409).json({ error: 'Submodule already has an active run (concurrent request)' });
        }
        throw skippedBatchErr;
      }

      const skippedRows = skippedEntities.map(e => ({
        stage_id: stage.id,
        run_id: runId,
        batch_id: batchId,
        entity_name: e.entity_name,
        submodule_id: submoduleId,
        step_index: stepIdx,
        status: 'skipped_no_input',
        card_id: cardId,
        loop_iteration: batchLoopIteration,
        error: `Submodule ${submoduleId} requires items in pool; pool is empty for this entity. Check pipeline composition — a prior step may have removed all items, or no discovery module ran upstream.`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        output_render_schema: manifest.output_schema || null,
      }));

      if (skippedRows.length > 0) {
        const { error: skipInsertErr } = await db.from('entity_submodule_runs').insert(skippedRows);
        if (skipInsertErr) throw skipInsertErr;
      }

      return res.json({
        submodule_run_id: skippedBatchRun.id,
        batch_id: batchId,
        entity_count: entities.length,
        skipped_count: skippedEntities.length,
        status: 'completed',
      });
    }

    const { data: batchRun, error: batchErr } = await db
      .from('submodule_runs')
      .insert({
        stage_id: stage.id,
        run_id: runId,
        submodule_id: submoduleId,
        status: 'pending',
        options,
        batch_id: batchId,
        card_id: cardId,
        loop_iteration: batchLoopIteration,
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
    // Build executable rows, then skipped rows (if any mixed scenario — partial skips), concat and insert.
    // Section C pre-flight (2026-06-03): per-batch aggregate of card-round merges
    // (downgraded from per-entity log to a single summary line below).
    const cardMergeAggregate = [];
    const entityRunRows = executableEntities.map(ep => {
      // Merge full entity properties (website, linkedin, etc.) with pool items
      const orig = originalEntityMap.get(ep.entity_name) || {};
      const loopMeta = metaMap.get(ep.entity_name);
      const entity = {
        ...orig,
        name: ep.entity_name,
        items: ep.pool_items || [],
      };

      // Inject loop_count into entity data for submodules that need it (e.g. loop-router).
      // Section C (2026-06-04): gated on cardId instead of the retired isLoopPass —
      // routed retries always carry cardId; loopMeta was only loaded in the cardId
      // branch above so this conjunction holds only on card-routed batches.
      if (cardId && loopMeta) {
        entity.loop_count = loopMeta.loop_count || 0;
      }

      // Merge this card's round overrides on top of base options when the batch
      // is scoped to a card. Without this merge, a routed Round 2 retry runs BASE
      // options identical to Round 1 — silent no-op (spec §1.2).
      let entityOptions = options;
      if (cardId && cardDefinitions[cardId]) {
        const card = cardDefinitions[cardId];
        // v6 (unit 2.5): a scalar card IS one round — its FLAT `overrides` are the
        // config to merge. cardRound below is provenance only (the aggregate log +
        // the legacy `rounds[N]` fallback for a not-yet-migrated card). Default is
        // Round 1 ("1"); the matching pending instruction's card_round wins (retry).
        let cardRound = '1';
        for (const record of loopMeta?.card_instructions || []) {
          const match = (record.targets || []).find(t =>
            t.step === stepIdx &&
            t.card_id === cardId &&
            t.loop_iteration === batchLoopIteration &&
            t.status === 'pending'
          );
          if (match?.card_round) {
            cardRound = String(match.card_round);
            break;
          }
        }
        // Prefer the scalar flat `overrides`; fall back to the legacy `rounds[N]`
        // map (transition-safe, matches resolveStepEntry:50). `rounds` removed at 3.1.
        const roundOverrides = card.overrides ?? card.rounds?.[cardRound] ?? {};
        entityOptions = { ...options, ...roundOverrides };
        if (Object.keys(roundOverrides).length > 0) {
          cardMergeAggregate.push({ entity: ep.entity_name, round: cardRound, overrides: Object.keys(roundOverrides).length });
        }
      }

      return {
        stage_id: stage.id,
        run_id: runId,
        batch_id: batchId,
        entity_name: ep.entity_name,
        submodule_id: submoduleId,
        step_index: stepIdx,
        status: 'pending',
        options: entityOptions,
        card_id: cardId,
        loop_iteration: loopMeta?.loop_count || 0,
        input_data: {
          entity,
          run_id: runId,
          step_index: stepIdx,
          submodule_id: submoduleId,
        },
        output_render_schema: manifest.output_schema || null,
      };
    });

    // Emit per-batch aggregate of card-round merges (downgraded from per-entity log).
    // One line per batch instead of one per entity — survives multi-card runs without
    // flooding stdout. Silent when no overrides applied (Round 1 horizontal cards).
    if (cardMergeAggregate.length > 0) {
      const byRound = cardMergeAggregate.reduce((acc, m) => {
        acc[m.round] = (acc[m.round] || 0) + 1;
        return acc;
      }, {});
      const summary = Object.entries(byRound).map(([r, n]) => `round=${r}×${n}`).join(' ');
      console.log(`[submoduleRuns] batch=${batchId} card=${cardId} merges ${summary}`);
    }

    // Build skipped rows for partial-skip scenario (some entities execute, some skip)
    const partialSkippedRows = skippedEntities.map(e => ({
      stage_id: stage.id,
      run_id: runId,
      batch_id: batchId,
      entity_name: e.entity_name,
      submodule_id: submoduleId,
      step_index: stepIdx,
      status: 'skipped_no_input',
      card_id: cardId,
      loop_iteration: batchLoopIteration,
      error: `Submodule ${submoduleId} requires items in pool; pool is empty for this entity. Check pipeline composition — a prior step may have removed all items, or no discovery module ran upstream.`,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      output_render_schema: manifest.output_schema || null,
    }));

    const { data: insertedRuns, error: entityInsertErr } = await db
      .from('entity_submodule_runs')
      .insert([...entityRunRows, ...partialSkippedRows])
      .select('id, entity_name, status');

    if (entityInsertErr) throw entityInsertErr;

    // Only enqueue BullMQ jobs for executable (non-skipped) entities
    const executableInserted = insertedRuns.filter(r => r.status === 'pending');

    // 9. Enqueue via FlowProducer (MANDATORY: 1 Redis call, not N)
    try {
      await enqueueEntityBatch({
        batchId,
        submoduleRunId: batchRun.id,
        submoduleId,
        stepIndex: stepIdx,
        cost: manifest.cost || 'medium',
        entityRuns: executableInserted.map(r => ({
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
      skipped_count: skippedEntities.length,
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
      const skipped = entities.filter(e => e.status === 'skipped_no_input').length;

      return res.json({
        id: data.id,
        submodule_id: data.submodule_id,
        status: data.status,
        batch_id: data.batch_id,
        entity_count: data.entity_count || entities.length,
        completed_count: completed,
        failed_count: failed,
        skipped_count: skipped,
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
 * POST /api/entity-submodule-runs/:id/abort
 * Abort a single running entity within a submodule run.
 * Sets a Redis signal that the worker polls every 2s. When detected,
 * the worker saves partial results (_partialItems) and marks the entity
 * as completed so results can be approved.
 */
submoduleRunRouter.post('/entity/:id/abort', async (req, res) => {
  try {
    const { data: entityRun, error: getErr } = await db
      .from('entity_submodule_runs')
      .select('id, status, entity_name, submodule_id')
      .eq('id', req.params.id)
      .single();

    if (getErr?.code === 'PGRST116' || !entityRun) {
      return res.status(404).json({ error: 'Entity submodule run not found' });
    }
    if (getErr) throw getErr;

    if (entityRun.status !== 'running') {
      return res.status(400).json({ error: `Cannot abort entity run with status "${entityRun.status}"` });
    }

    // Set Redis abort signal — worker polls this every 2s
    await redis.set(`abort:entity:${entityRun.id}`, '1', 'EX', 300);

    console.log(`[submodule-runs] Entity abort signal set for ${entityRun.entity_name} (${entityRun.submodule_id})`);
    res.json({ aborted: true, entity_name: entityRun.entity_name });
  } catch (err) {
    console.error('[submodule-runs] POST entity abort error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Resolve entity name from a template string with {field} placeholders.
 * E.g. "{title} - {company}" → "Senior Developer - Betsson"
 * Falls back to item title → item url → parentName-item
 */
function resolveEntityNameTemplate(template, item, parentName) {
  let name = template.replace(/\{(\w+)\}/g, (_, field) => {
    const val = item[field];
    return (val != null && val !== '') ? String(val).trim() : '';
  });
  if (!name.trim()) name = item.title || item.url || `${parentName}-item`;
  return name.replace(/[\x00-\x1f]/g, '').trim().slice(0, 200);
}

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
        // BUT respect flagged_when rules — flagged items (e.g. DROP) are excluded.
        // EXCEPTION: QA submodules (Step 6+) skip flagged_when during auto-execute.
        // QA failures MUST reach the pool so loop-router can route them.
        let resolvedKeys;
        if (approvedKeys === '__all__') {
          const flaggedWhen = manifest?.output_schema?.flagged_when;
          const submoduleStep = manifest?.step ?? 0;
          const skipFlagFilter = submoduleStep >= 6;

          resolvedKeys = outputItems
            .filter(item => {
              if (skipFlagFilter || !flaggedWhen) return true;
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

        // Check if entity_production is enabled (each item → new entity)
        const entityProduction = subRun.options?.entity_production === true;

        if (entityProduction && approvedItems.length > 0) {
          // ── ENTITY PRODUCTION MODE ──
          // Each approved item becomes a new entity for DOWNSTREAM steps (step+1).
          // The parent entity stays at the current step so other submodules
          // (e.g. api-search) can still process it independently.
          const entityNameTemplate = subRun.options?.entity_name_template || '{title}';
          const currentStep = subRun.input_data?.step_index ?? 0;
          const targetStep = Math.min(currentStep + 1, 10);

          const producedEntities = [];
          for (const item of approvedItems) {
            const newEntityName = resolveEntityNameTemplate(entityNameTemplate, item, entityName);
            producedEntities.push({
              run_id: subRun.run_id,
              step_index: targetStep,
              entity_name: newEntityName,
              pool_items: [item],
              status: 'pending',
            });
          }

          // Disambiguate duplicate entity names
          const nameCount = new Map();
          for (const pe of producedEntities) {
            const count = (nameCount.get(pe.entity_name) || 0) + 1;
            nameCount.set(pe.entity_name, count);
            if (count > 1) pe.entity_name += ` (${count})`;
          }

          // Batch upsert produced entities into entity_stage_pool
          const { error: prodErr } = await db
            .from('entity_stage_pool')
            .upsert(producedEntities, { onConflict: 'run_id,step_index,entity_name' });
          if (prodErr) throw prodErr;

          // Create entity_run_meta rows for produced entities
          try {
            await db.from('entity_run_meta').upsert(
              producedEntities.map(pe => ({ run_id: subRun.run_id, entity_name: pe.entity_name })),
              { onConflict: 'run_id,entity_name', ignoreDuplicates: true }
            );
          } catch (metaErr) {
            console.warn('[approve:entity_production] entity_run_meta upsert skipped:', metaErr.message);
          }

          // Keep parent entity at current step (clear its pool so subsequent
          // submodules like api-search start fresh for this entity).
          poolMap.set(entityName, []);

          console.log(`[approve:entity_production] ${entityName}: produced ${producedEntities.length} entities at step ${targetStep}`);

        } else if (isFailedRun(entityRun.output_data)) {
          // ── PRESERVE-ON-FAILURE ──
          // Replace-on-success, preserve-on-failure. A module-level execution
          // failure (e.g. a round-2 content-writer Anthropic 400) emits a
          // contentless placeholder item with meta.status='error'. Under `add`
          // (keyed by entity+source_submodule) that placeholder would EVICT the
          // prior round's good content, leaving the bundler with nothing. Skip
          // the supersede: poolMap already holds the prior pool for this entity,
          // so leaving it untouched keeps the good content.
          //
          // REACHABILITY: deriveEntityRunStatus marks a meta.status='error' run
          // as 'failed', which the bulk-load filter (`status in completed/approved`,
          // ~line 1145) would exclude — EXCEPT autoExecutor.autoApproveSingleSubmodule
          // has a rescue block that re-marks failed-with-output rows back to
          // 'completed' so they reach this endpoint. That rescue flips row status
          // but NOT output_data.meta.status, so a failed run arrives here as
          // 'completed' with meta.status still 'error'. This branch is that case.
          // (meta.status='error' fires only on genuine module failure — QA-fail
          // verdicts and normal outputs leave it unset, so routing is untouched.)
          console.log(`[preserve-on-failure] ${entityName}: ${subRun.submodule_id} run failed (meta.status=error) — keeping prior pool content, not superseding`);
        } else {
          // ── NORMAL MODE ──
          // Update entity pool based on data_operation
          let entityPool = poolMap.get(entityName) || [];

          const { pool: newPool, ops } = applyDataOperation(entityPool, approvedItems, dataOperation, itemKey, approvedKeySet);
          entityPool = newPool;
          console.log(`[${dataOperation}] ${entityName}: added=${ops.added} kept=${ops.kept} removed=${ops.removed} replaced=${ops.replaced}`);

          poolMap.set(entityName, entityPool);
        }

        // Update entity_submodule_runs status
        await db
          .from('entity_submodule_runs')
          .update({ status: 'approved', approved_items: resolvedKeys })
          .eq('id', entityRun.id);
      }

      // Update pipeline_stages.entity_count (produced entities go to step+1)
      if (subRun.options?.entity_production === true) {
        const currentStep = subRun.input_data?.step_index ?? 0;
        const targetStep = Math.min(currentStep + 1, 10);

        // Update target step entity_count (where produced entities now live)
        const { count: targetCount } = await db
          .from('entity_stage_pool')
          .select('*', { count: 'exact', head: true })
          .eq('run_id', subRun.run_id)
          .eq('step_index', targetStep);

        if (targetCount > 0) {
          await db
            .from('pipeline_stages')
            .update({ entity_count: targetCount })
            .eq('run_id', subRun.run_id)
            .eq('step_index', targetStep);
        }
      }

      // Bulk update entity_stage_pool in batches to avoid DB write storms on large runs.
      // Reset status to 'pending' so next submodule at this step can process
      // these entities (critical for card-routed retry steps where only 'pending' pools are loaded)
      {
        const POOL_BATCH = 5;
        const poolEntries = [...poolMap];
        for (let i = 0; i < poolEntries.length; i += POOL_BATCH) {
          await Promise.all(poolEntries.slice(i, i + POOL_BATCH).map(([entityName, poolItems]) =>
            db.from('entity_stage_pool')
              .update({ pool_items: poolItems, status: 'pending', updated_at: new Date().toISOString() })
              .eq('run_id', subRun.run_id)
              .eq('step_index', subRun.input_data?.step_index ?? 0)
              .eq('entity_name', entityName)
          ));
          if (i + POOL_BATCH < poolEntries.length) await new Promise(r => setTimeout(r, 300));
        }
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
