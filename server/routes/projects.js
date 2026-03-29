import { Router } from 'express';
import db from '../services/db.js';
import { STEP_CONFIG } from '../../shared/stepConfig.js';
import { buildConfigRowsFromPresetMap, resolvePresetMap } from './templates.js';
import { getSubmoduleById } from '../services/moduleLoader.js';

const router = Router();

/**
 * GET /api/projects
 * List all projects
 */
router.get('/', async (_req, res, next) => {
  try {
    const { data, error } = await db
      .from('projects')
      .select('*, templates(name)')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Enrich with template_name and run_count
    const projects = (data || []).map(p => ({
      ...p,
      template_name: p.templates?.name || null,
      templates: undefined, // remove nested object
    }));

    // Batch fetch run counts
    const ids = projects.map(p => p.id);
    if (ids.length > 0) {
      const { data: runs } = await db
        .from('pipeline_runs')
        .select('project_id')
        .in('project_id', ids);

      const countMap = {};
      for (const r of (runs || [])) {
        countMap[r.project_id] = (countMap[r.project_id] || 0) + 1;
      }
      for (const p of projects) {
        p.run_count = countMap[p.id] || 0;
      }
    }

    res.json(projects);
  } catch (err) { next(err); }
});

/**
 * GET /api/projects/:id
 * Project details with latest run
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { data: project, error: projErr } = await db
      .from('projects')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (projErr && projErr.code !== 'PGRST116') throw projErr;
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Template name
    let template_name = null;
    if (project.template_id) {
      const { data: tpl } = await db.from('templates').select('name').eq('id', project.template_id).single();
      template_name = tpl?.name || null;
    }

    const { data: runs, error: runsErr } = await db
      .from('pipeline_runs')
      .select('id, status, current_step, started_at, completed_at')
      .eq('project_id', req.params.id)
      .order('started_at', { ascending: false })
      .limit(10);

    if (runsErr) throw runsErr;

    // Enrich runs with entity_count and success_rate
    const enrichedRuns = [];
    for (const run of (runs || [])) {
      // Entity count from step_context step 0
      const { data: ctx } = await db.from('step_context').select('entities').eq('run_id', run.id).eq('step_index', 0).single();
      const entity_count = Array.isArray(ctx?.entities) ? ctx.entities.length : 0;

      // Success rate from stages
      const { data: stages } = await db.from('pipeline_stages').select('status').eq('run_id', run.id);
      const total = (stages || []).filter(s => s.status !== 'pending').length;
      const completed = (stages || []).filter(s => s.status === 'completed' || s.status === 'approved').length;
      const success_rate = total > 0 ? Math.round((completed / total) * 100) : 0;

      enrichedRuns.push({ ...run, entity_count, success_rate });
    }

    res.json({ ...project, template_name, runs: enrichedRuns });
  } catch (err) { next(err); }
});

/**
 * POST /api/projects
 * Create project + pipeline_run + 11 pipeline_stages
 * Body: { name, intent? }
 * Returns: { project, run }
 */
router.post('/', async (req, res, next) => {
  try {
    const { name, intent, template_id, mode } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    // 1. Create project
    const { data: project, error: projErr } = await db
      .from('projects')
      .insert({
        name: name.trim(),
        description: intent || null,
        template_id: template_id || null,
        mode: mode || 'single_run',
        status: 'active',
      })
      .select()
      .single();

    if (projErr) {
      if (projErr.code === '23503') return res.status(400).json({ error: 'Template not found' });
      throw projErr;
    }

    // 2. Create pipeline_run
    const { data: run, error: runErr } = await db
      .from('pipeline_runs')
      .insert({
        project_id: project.id,
        status: 'running',
        current_step: 0,
      })
      .select()
      .single();

    if (runErr) throw runErr;

    // 3. Create 11 pipeline_stages (step 0 = active, steps 1-10 = pending)
    const stages = STEP_CONFIG.map((step) => ({
      run_id: run.id,
      step_index: step.index,
      step_name: step.name,
      status: step.index === 0 ? 'active' : 'pending',
    }));

    const { error: stagesErr } = await db
      .from('pipeline_stages')
      .insert(stages);

    if (stagesErr) throw stagesErr;

    // 4. Apply template if provided — copy docs + pre-populate configs from preset_map JSONB
    if (template_id) {
      // Fetch template preset_map
      const { data: tpl } = await db
        .from('templates')
        .select('preset_map')
        .eq('id', template_id)
        .single();

      // Copy template reference docs → project_reference_docs (with ID mapping)
      const docIdMap = {}; // templateDocId → projectDocId
      const { data: tDocs } = await db
        .from('template_reference_docs')
        .select('id, filename, content, content_type, size_bytes')
        .eq('template_id', template_id);
      if (tDocs?.length) {
        for (const tDoc of tDocs) {
          const { data: pDoc } = await db
            .from('project_reference_docs')
            .insert({ project_id: project.id, filename: tDoc.filename, content: tDoc.content, content_type: tDoc.content_type, size_bytes: tDoc.size_bytes })
            .select('id')
            .single();
          if (pDoc) docIdMap[tDoc.id] = pDoc.id;
        }
      }

      // Pre-populate run_submodule_config from preset_map JSONB
      const presetMap = tpl?.preset_map || {};
      if (Object.keys(presetMap).length > 0) {
        const resolved = await resolvePresetMap(presetMap, project.id);
        const configRows = buildConfigRowsFromPresetMap(run.id, resolved, docIdMap);
        if (configRows.length > 0) {
          await db.from('run_submodule_config').insert(configRows);
        }
      }
    }

    res.status(201).json({ project, run });
  } catch (err) { next(err); }
});

/**
 * POST /api/projects/:id/runs
 * Create a new run within an existing project.
 * Used by "New run in this project" CTA in project detail panel.
 */
router.post('/:id/runs', async (req, res, next) => {
  try {
    const projectId = req.params.id;

    // 1. Fetch project
    const { data: project, error: projErr } = await db
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (projErr?.code === 'PGRST116' || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (projErr) throw projErr;

    // 2. Fetch template if project has one
    let template = null;
    if (project.template_id) {
      const { data: tpl, error: tplErr } = await db
        .from('templates')
        .select('*')
        .eq('id', project.template_id)
        .single();

      if (tplErr?.code === 'PGRST116' || !tpl) {
        return res.status(400).json({ error: 'Template no longer exists — create a new project instead' });
      }
      if (tplErr) throw tplErr;
      template = tpl;
    }

    // 3. Create run (step 0 already done — user enters at step 1)
    const { data: run, error: runErr } = await db
      .from('pipeline_runs')
      .insert({ project_id: projectId, status: 'running', current_step: 1 })
      .select()
      .single();
    if (runErr) throw runErr;

    // 4. Create 11 stages (step 0 = completed, step 1 = active, rest pending)
    const stages = STEP_CONFIG.map((step) => ({
      run_id: run.id,
      step_index: step.index,
      step_name: step.name,
      status: step.index === 0 ? 'approved' : step.index === 1 ? 'active' : 'pending',
    }));
    const { error: stagesErr } = await db.from('pipeline_stages').insert(stages);
    if (stagesErr) throw stagesErr;

    // 5. If template exists: copy docs + apply preset_map
    let docIdMap = {};
    if (template) {
      // Copy template docs → project docs
      const { data: tDocs } = await db
        .from('template_reference_docs')
        .select('id, filename, content, content_type, size_bytes')
        .eq('template_id', template.id);
      if (tDocs?.length) {
        for (const tDoc of tDocs) {
          const { data: pDoc } = await db
            .from('project_reference_docs')
            .insert({ project_id: projectId, filename: tDoc.filename, content: tDoc.content, content_type: tDoc.content_type, size_bytes: tDoc.size_bytes })
            .select('id')
            .single();
          if (pDoc) docIdMap[tDoc.id] = pDoc.id;
        }
      }

      // Apply preset_map → run_submodule_config
      const presetMap = template.preset_map || {};
      if (Object.keys(presetMap).length > 0) {
        const resolved = await resolvePresetMap(presetMap, projectId);
        const configRows = buildConfigRowsFromPresetMap(run.id, resolved, docIdMap);
        if (configRows.length > 0) {
          await db.from('run_submodule_config').insert(configRows);
        }
      }
    }

    // 6. Write pending_seed step_context for step 1
    await db.from('step_context').upsert({
      run_id: run.id,
      step_index: 0,
      entities: [],
      status: 'pending_seed',
      created_at: new Date().toISOString(),
    }, { onConflict: 'run_id,step_index' });

    res.status(201).json({ run: { id: run.id, status: run.status, current_step: run.current_step } });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/projects/:id
 * Delete project and ALL related data (runs, stages, configs, results, docs)
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const projectId = req.params.id;

    // 1. Verify project exists
    const { data: project, error: projErr } = await db
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .single();

    if (projErr?.code === 'PGRST116' || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (projErr) throw projErr;

    // 2. Get all run IDs for this project
    const { data: runs, error: runsErr } = await db
      .from('pipeline_runs')
      .select('id')
      .eq('project_id', projectId);

    if (runsErr) throw runsErr;
    const runIds = (runs || []).map((r) => r.id);

    // 3. Delete child tables in dependency order (no CASCADE on these FKs)
    if (runIds.length > 0) {
      // Item data (references submodule_run IDs from both tables)
      const { data: subRunRows } = await db.from('submodule_runs').select('id').in('run_id', runIds);
      const { data: entityRunRows } = await db.from('entity_submodule_runs').select('id').in('run_id', runIds);
      const allItemRunIds = [...(subRunRows || []).map(r => r.id), ...(entityRunRows || []).map(r => r.id)];
      if (allItemRunIds.length > 0) {
        await db.from('submodule_run_item_data').delete().in('submodule_run_id', allItemRunIds);
      }

      await db.from('decision_log').delete().in('run_id', runIds);
      await db.from('entity_submodule_runs').delete().in('run_id', runIds);
      await db.from('entity_stage_pool').delete().in('run_id', runIds);
      await db.from('submodule_runs').delete().in('run_id', runIds);
      await db.from('run_submodule_config').delete().in('run_id', runIds);
      await db.from('step_context').delete().in('run_id', runIds);
      await db.from('pipeline_stages').delete().in('run_id', runIds);
      await db.from('pipeline_runs').delete().eq('project_id', projectId);
    }

    // 4. project_reference_docs (has CASCADE but explicit is cleaner)
    await db.from('project_reference_docs').delete().eq('project_id', projectId);

    // 5. Delete the project itself
    const { error: deleteErr } = await db
      .from('projects')
      .delete()
      .eq('id', projectId);

    if (deleteErr) throw deleteErr;

    console.log(`[projects] Deleted project ${projectId} with ${runIds.length} run(s)`);
    res.json({ deleted: true, runs_deleted: runIds.length });
  } catch (err) { next(err); }
});

export default router;
