import { Router } from 'express';
import supabase from '../services/db.js';

const router = Router({ mergeParams: true });

/**
 * GET /api/runs/:runId/steps/:stepIndex/submodules/:submoduleId/config
 * Returns saved config for a submodule in a run/step, or defaults if none saved.
 */
router.get('/', async (req, res) => {
  const { runId, stepIndex, submoduleId } = req.params;

  const { data, error } = await supabase
    .from('run_submodule_config')
    .select('*')
    .eq('run_id', runId)
    .eq('step_index', parseInt(stepIndex, 10))
    .eq('submodule_id', submoduleId)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Return saved config or empty defaults
  res.json(data || {
    run_id: runId,
    step_index: parseInt(stepIndex, 10),
    submodule_id: submoduleId,
    input_config: null,
    options: null,
    data_operation: null,
  });
});

/**
 * PUT /api/runs/:runId/steps/:stepIndex/submodules/:submoduleId/config
 * Upsert config for a submodule. Body may contain: data_operation, input_config, options.
 */
router.put('/', async (req, res) => {
  const { runId, stepIndex, submoduleId } = req.params;
  const { data_operation, input_config, options } = req.body;

  const row = {
    run_id: runId,
    step_index: parseInt(stepIndex, 10),
    submodule_id: submoduleId,
    updated_at: new Date().toISOString(),
  };

  // Only include fields that were sent
  if (data_operation !== undefined) row.data_operation = data_operation;
  if (input_config !== undefined) row.input_config = input_config;
  if (options !== undefined) row.options = options;

  const { data, error } = await supabase
    .from('run_submodule_config')
    .upsert(row, { onConflict: 'run_id,step_index,submodule_id' })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Share textarea entities to step_context so sibling submodules can access them
  // (mirrors what CSV upload does — both input methods share via step_context)
  if (input_config?.source === 'textarea' && Array.isArray(input_config.entities) && input_config.entities.length > 0) {
    const step = parseInt(stepIndex, 10);
    await supabase
      .from('step_context')
      .upsert({
        run_id: runId,
        step_index: step,
        entities: input_config.entities,
        filename: null,
        source_submodule: submoduleId,
        created_at: new Date().toISOString(),
      }, { onConflict: 'run_id,step_index' });
  }

  res.json(data);
});

export default router;
