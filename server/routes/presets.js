import { Router } from 'express';
import db from '../services/db.js';

const router = Router();

/**
 * GET /api/presets?submodule_id=X&option_name=Y&project_id=Z
 * List presets for a specific submodule option.
 * Returns global presets (project_id IS NULL) + project-scoped presets.
 */
router.get('/', async (req, res, next) => {
  try {
    const { submodule_id, option_name, project_id } = req.query;
    if (!submodule_id || !option_name) {
      return res.status(400).json({ error: 'submodule_id and option_name are required' });
    }

    let query = db
      .from('option_presets')
      .select('*')
      .eq('submodule_id', submodule_id)
      .eq('option_name', option_name)
      .order('preset_name');

    if (project_id) {
      // Return global + project-scoped presets
      query = query.or(`project_id.is.null,project_id.eq.${project_id}`);
    } else {
      // Return only global presets
      query = query.is('project_id', null);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ presets: data || [] });
  } catch (err) { next(err); }
});

/**
 * POST /api/presets
 * Create a new preset.
 */
router.post('/', async (req, res, next) => {
  try {
    const { submodule_id, option_name, preset_name, preset_value, project_id } = req.body;
    if (!submodule_id || !option_name || !preset_name || preset_value === undefined) {
      return res.status(400).json({ error: 'submodule_id, option_name, preset_name, and preset_value are required' });
    }

    const row = {
      submodule_id,
      option_name,
      preset_name,
      preset_value,
      ...(project_id ? { project_id } : {}),
    };

    const { data, error } = await db
      .from('option_presets')
      .insert(row)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Preset with this name already exists' });
      }
      throw error;
    }

    res.status(201).json({ preset: data });
  } catch (err) { next(err); }
});

/**
 * PUT /api/presets/:id
 * Update an existing preset's value or name.
 */
router.put('/:id', async (req, res, next) => {
  try {
    const updates = {};
    if (req.body.preset_name !== undefined) updates.preset_name = req.body.preset_name;
    if (req.body.preset_value !== undefined) updates.preset_value = req.body.preset_value;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await db
      .from('option_presets')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'Preset not found' });
      if (error.code === '23505') return res.status(409).json({ error: 'Preset name conflict' });
      throw error;
    }

    res.json({ preset: data });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/presets/:id
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await db
      .from('option_presets')
      .delete()
      .eq('id', req.params.id);

    if (error) {
      if (error.code === '23503') {
        return res.status(409).json({ error: 'Cannot delete preset: it is used by one or more templates. Remove it from templates first.' });
      }
      throw error;
    }
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

/**
 * POST /api/presets/:id/set-default
 * Mark a preset as the default for its submodule/option combo.
 * Clears is_default on all other presets for the same combo.
 */
router.post('/:id/set-default', async (req, res, next) => {
  try {
    // Fetch the preset to know its scope
    const { data: preset, error: fetchErr } = await db
      .from('option_presets')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchErr) {
      if (fetchErr.code === 'PGRST116') return res.status(404).json({ error: 'Preset not found' });
      throw fetchErr;
    }

    // Clear is_default for all presets of same submodule/option/scope
    let clearQuery = db
      .from('option_presets')
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq('submodule_id', preset.submodule_id)
      .eq('option_name', preset.option_name);

    if (preset.project_id) {
      clearQuery = clearQuery.eq('project_id', preset.project_id);
    } else {
      clearQuery = clearQuery.is('project_id', null);
    }

    await clearQuery;

    // Set this one as default
    const { data: updated, error: updateErr } = await db
      .from('option_presets')
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();

    if (updateErr) throw updateErr;

    res.json({ preset: updated });
  } catch (err) { next(err); }
});

export default router;
