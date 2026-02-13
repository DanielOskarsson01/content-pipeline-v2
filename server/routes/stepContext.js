import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import supabase from '../services/db.js';
import { getSubmodules } from '../services/moduleLoader.js';

const router = Router({ mergeParams: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * Compute the union of requires_columns for all submodules in a step.
 */
function getStepRequiredColumns(stepIndex) {
  const subs = getSubmodules(stepIndex);
  const cols = new Set();
  for (const sub of subs) {
    for (const col of sub.requires_columns || []) {
      cols.add(col);
    }
  }
  return [...cols].sort((a, b) => {
    if (a === 'name') return -1;
    if (b === 'name') return 1;
    return a.localeCompare(b);
  });
}

/**
 * POST /api/runs/:runId/steps/:stepIndex/context
 * Upload a CSV file, parse server-side, validate columns, store in step_context.
 */
router.post('/', upload.single('file'), async (req, res) => {
  const { runId, stepIndex } = req.params;
  const step = parseInt(stepIndex, 10);
  const submoduleId = req.body?.submodule_id || null;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const ext = req.file.originalname.split('.').pop()?.toLowerCase();
  if (ext !== 'csv') {
    return res.status(415).json({ error: 'Unsupported file type. Supported: CSV' });
  }

  // Parse CSV
  let records;
  try {
    const content = req.file.buffer.toString('utf-8');
    records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    });
  } catch (err) {
    return res.status(400).json({ error: `CSV parse error: ${err.message}` });
  }

  if (records.length === 0) {
    return res.status(400).json({ error: 'CSV contains no data rows' });
  }

  if (records.length > 10000) {
    return res.status(400).json({ error: `Too many rows (${records.length}). Maximum: 10,000` });
  }

  // Validate columns against step's union of requires_columns
  const requiredColumns = getStepRequiredColumns(step);
  const foundColumns = Object.keys(records[0]);
  const normalizedFound = foundColumns.map(c => c.toLowerCase().trim());
  const columnsMissing = requiredColumns.filter(c => !normalizedFound.includes(c.toLowerCase()));
  const columnsFound = requiredColumns.filter(c => normalizedFound.includes(c.toLowerCase()));

  // Normalize column names to lowercase
  const entities = records.map(row => {
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[key.toLowerCase().trim()] = value;
    }
    return normalized;
  });

  // Upsert into step_context (one per run + step)
  const { data, error } = await supabase
    .from('step_context')
    .upsert({
      run_id: runId,
      step_index: step,
      entities,
      filename: req.file.originalname,
      source_submodule: submoduleId,
      created_at: new Date().toISOString(),
    }, { onConflict: 'run_id,step_index' })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({
    entity_count: entities.length,
    columns_found: columnsFound,
    columns_missing: columnsMissing,
    all_columns: foundColumns,
    filename: req.file.originalname,
  });
});

/**
 * GET /api/runs/:runId/steps/:stepIndex/context
 * Returns stored step context or null.
 */
router.get('/', async (req, res) => {
  const { runId, stepIndex } = req.params;
  const step = parseInt(stepIndex, 10);

  const { data, error } = await supabase
    .from('step_context')
    .select('*')
    .eq('run_id', runId)
    .eq('step_index', step)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

export default router;
