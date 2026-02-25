import { Router } from 'express';
import db from '../services/db.js';
import { STEP_CONFIG } from '../../shared/stepConfig.js';

const router = Router();

/**
 * GET /api/projects
 * List all projects
 */
router.get('/', async (_req, res, next) => {
  try {
    const { data, error } = await db
      .from('projects')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
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

    const { data: runs, error: runsErr } = await db
      .from('pipeline_runs')
      .select('id, status, current_step, started_at, completed_at')
      .eq('project_id', req.params.id)
      .order('started_at', { ascending: false })
      .limit(10);

    if (runsErr) throw runsErr;

    res.json({ ...project, runs: runs || [] });
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
    const { name, intent } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    // 1. Create project
    const { data: project, error: projErr } = await db
      .from('projects')
      .insert({
        name: name.trim(),
        description: intent || null,
        status: 'active',
      })
      .select()
      .single();

    if (projErr) throw projErr;

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

    res.status(201).json({ project, run });
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
      await db.from('decision_log').delete().in('run_id', runIds);
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
