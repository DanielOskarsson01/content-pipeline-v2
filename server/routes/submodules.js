import { Router } from 'express';
import { getSubmodulesGroupedByCategory, getSubmodules } from '../services/moduleLoader.js';

const router = Router();

/**
 * GET /api/submodules
 * GET /api/submodules?step=1
 * GET /api/submodules?detail=full
 *
 * Returns submodules from the module registry.
 * If ?step is provided, returns only submodules for that step grouped by category.
 * Without ?step, returns all submodules as a flat array.
 * Add ?detail=full to include complete manifest data (options, requires_columns,
 * output_schema, depends_on, usage_notes) — useful for AI agents choosing modules.
 */
router.get('/', (req, res) => {
  const stepParam = req.query.step;

  if (stepParam !== undefined) {
    const stepIndex = parseInt(stepParam, 10);
    if (isNaN(stepIndex) || stepIndex < 0 || stepIndex > 10) {
      return res.status(400).json({ error: 'step must be 0-10' });
    }

    const grouped = getSubmodulesGroupedByCategory(stepIndex);
    return res.json(grouped);
  }

  // No step filter — return flat list
  const all = getSubmodules();
  const detail = req.query.detail === 'full';
  const flat = all.map(m => {
    const base = {
      id: m.id,
      name: m.name,
      description: m.description,
      step: m.step,
      category: m.category,
      cost: m.cost,
      data_operation_default: m.data_operation_default,
    };
    if (detail) {
      base.depends_on = m.depends_on || [];
      base.usage_notes = m.usage_notes || '';
      base.requires_columns = m.requires_columns || [];
      base.item_key = m.item_key;
      base.options = m.options || [];
      base.options_defaults = m.options_defaults || {};
      base.output_schema = m.output_schema;
    }
    return base;
  });

  res.json(flat);
});

export default router;
