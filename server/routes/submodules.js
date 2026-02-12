import { Router } from 'express';
import { getSubmodulesGroupedByCategory, getSubmodules } from '../services/moduleLoader.js';

const router = Router();

/**
 * GET /api/submodules
 * GET /api/submodules?step=1
 *
 * Returns submodules from the module registry.
 * If ?step is provided, returns only submodules for that step grouped by category.
 * Without ?step, returns all submodules as a flat array.
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
  const flat = all.map(m => ({
    id: m.id,
    name: m.name,
    description: m.description,
    step: m.step,
    category: m.category,
    cost: m.cost,
    data_operation_default: m.data_operation_default,
  }));

  res.json(flat);
});

export default router;
