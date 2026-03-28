import { Router } from 'express';
import multer from 'multer';
import db from '../services/db.js';
import { getSubmoduleById } from '../services/moduleLoader.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const ALLOWED_EXTENSIONS = new Set(['md', 'txt', 'csv', 'json']);

// ── Template CRUD ──────────────────────────────────────────────

/**
 * GET /api/templates
 * List all templates with preset and doc counts.
 */
router.get('/', async (_req, res, next) => {
  try {
    const { data: templates, error } = await db
      .from('templates')
      .select('*')
      .order('name');
    if (error) throw error;

    // Aggregate counts
    const ids = (templates || []).map(t => t.id);
    let presetCounts = {};
    let docCounts = {};

    if (ids.length > 0) {
      const { data: mappings } = await db
        .from('template_preset_mappings')
        .select('template_id')
        .in('template_id', ids);
      for (const m of (mappings || [])) {
        presetCounts[m.template_id] = (presetCounts[m.template_id] || 0) + 1;
      }

      const { data: docs } = await db
        .from('template_reference_docs')
        .select('template_id')
        .in('template_id', ids);
      for (const d of (docs || [])) {
        docCounts[d.template_id] = (docCounts[d.template_id] || 0) + 1;
      }
    }

    const result = (templates || []).map(t => ({
      ...t,
      preset_count: presetCounts[t.id] || 0,
      doc_count: docCounts[t.id] || 0,
    }));

    res.json(result);
  } catch (err) { next(err); }
});

/**
 * GET /api/templates/:id
 * Template detail with preset mappings (joined to preset names/values) and doc metadata.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { data: template, error } = await db
      .from('templates')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error?.code === 'PGRST116' || !template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    if (error) throw error;

    // Fetch preset mappings with joined preset data
    const { data: mappings } = await db
      .from('template_preset_mappings')
      .select('id, submodule_id, option_name, preset_id, option_presets(preset_name, preset_value)')
      .eq('template_id', template.id)
      .order('submodule_id');

    // Fetch reference doc metadata (no content)
    const { data: docs } = await db
      .from('template_reference_docs')
      .select('id, filename, content_type, size_bytes, created_at')
      .eq('template_id', template.id)
      .order('filename');

    const presets = (mappings || []).map(m => ({
      id: m.id,
      submodule_id: m.submodule_id,
      option_name: m.option_name,
      preset_id: m.preset_id,
      preset_name: m.option_presets?.preset_name || '',
      preset_value: m.option_presets?.preset_value,
    }));

    res.json({
      ...template,
      preset_count: presets.length,
      doc_count: (docs || []).length,
      presets,
      reference_docs: docs || [],
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/templates
 * Create a new template.
 */
router.post('/', async (req, res, next) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const { data, error } = await db
      .from('templates')
      .insert({ name: name.trim(), description: description || null })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Template name already exists' });
      throw error;
    }

    res.status(201).json({ template: data });
  } catch (err) { next(err); }
});

/**
 * PUT /api/templates/:id
 * Update template name/description.
 */
router.put('/:id', async (req, res, next) => {
  try {
    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name.trim();
    if (req.body.description !== undefined) updates.description = req.body.description;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await db
      .from('templates')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'Template not found' });
      if (error.code === '23505') return res.status(409).json({ error: 'Template name conflict' });
      throw error;
    }

    res.json({ template: data });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/templates/:id
 * Delete template (CASCADE removes mappings + docs).
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await db
      .from('templates')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ── Preset Mappings ────────────────────────────────────────────

/**
 * POST /api/templates/:id/presets
 * Add a preset mapping to this template.
 * Body: { submodule_id, option_name, preset_id }
 */
router.post('/:id/presets', async (req, res, next) => {
  try {
    const { submodule_id, option_name, preset_id } = req.body;
    if (!submodule_id || !option_name || !preset_id) {
      return res.status(400).json({ error: 'submodule_id, option_name, and preset_id are required' });
    }

    const { data, error } = await db
      .from('template_preset_mappings')
      .upsert({
        template_id: req.params.id,
        submodule_id,
        option_name,
        preset_id,
      }, { onConflict: 'template_id,submodule_id,option_name' })
      .select('id, submodule_id, option_name, preset_id')
      .single();

    if (error) {
      if (error.code === '23503') return res.status(404).json({ error: 'Template or preset not found' });
      throw error;
    }

    res.status(201).json({ mapping: data });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/templates/:id/presets/:mappingId
 * Remove a preset mapping.
 */
router.delete('/:id/presets/:mappingId', async (req, res, next) => {
  try {
    const { error } = await db
      .from('template_preset_mappings')
      .delete()
      .eq('id', req.params.mappingId)
      .eq('template_id', req.params.id);

    if (error) throw error;
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ── Reference Docs ─────────────────────────────────────────────

/**
 * POST /api/templates/:id/reference-docs
 * Upload reference docs to a template.
 */
router.post('/:id/reference-docs', upload.array('files', 10), async (req, res, next) => {
  try {
    const templateId = req.params.id;
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const results = [];
    const errors = [];

    for (const file of req.files) {
      const ext = file.originalname.split('.').pop()?.toLowerCase();
      if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
        errors.push(`${file.originalname}: unsupported type`);
        continue;
      }

      const content = file.buffer.toString('utf-8');
      const contentType = { md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json' }[ext] || 'text/plain';

      const { data, error } = await db
        .from('template_reference_docs')
        .upsert({
          template_id: templateId,
          filename: file.originalname,
          content,
          content_type: contentType,
          size_bytes: file.size,
        }, { onConflict: 'template_id,filename' })
        .select('id, filename, content_type, size_bytes, created_at')
        .single();

      if (error) {
        if (error.code === '23503') return res.status(404).json({ error: 'Template not found' });
        errors.push(`${file.originalname}: ${error.message}`);
      } else {
        results.push(data);
      }
    }

    res.json({ uploaded: results, errors });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/templates/:id/reference-docs/:docId
 * Remove a reference doc from a template.
 */
router.delete('/:id/reference-docs/:docId', async (req, res, next) => {
  try {
    const { error } = await db
      .from('template_reference_docs')
      .delete()
      .eq('id', req.params.docId)
      .eq('template_id', req.params.id);

    if (error) throw error;
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ── Save Run as Template ──────────────────────────────────────

/**
 * POST /api/templates/from-run/:runId
 * Create a template from a run's current configuration.
 * Captures all run_submodule_config option values as presets.
 * Body: { name, description? }
 */
router.post('/from-run/:runId', async (req, res, next) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const runId = req.params.runId;

    // 1. Look up run → get project_id
    const { data: run, error: runErr } = await db
      .from('pipeline_runs')
      .select('id, project_id')
      .eq('id', runId)
      .single();
    if (runErr?.code === 'PGRST116' || !run) {
      return res.status(404).json({ error: 'Run not found' });
    }
    if (runErr) throw runErr;

    // 2. Create template
    const { data: template, error: tplErr } = await db
      .from('templates')
      .insert({ name: name.trim(), description: description || null })
      .select()
      .single();
    if (tplErr) {
      if (tplErr.code === '23505') return res.status(409).json({ error: 'Template name already exists' });
      throw tplErr;
    }

    // 3. Copy project_reference_docs → template_reference_docs (build ID map)
    const docIdMap = {}; // projectDocId → templateDocId
    const { data: projDocs } = await db
      .from('project_reference_docs')
      .select('id, filename, content, content_type, size_bytes')
      .eq('project_id', run.project_id);

    if (projDocs?.length) {
      for (const doc of projDocs) {
        const { data: tDoc, error: docErr } = await db
          .from('template_reference_docs')
          .insert({
            template_id: template.id,
            filename: doc.filename,
            content: doc.content,
            content_type: doc.content_type,
            size_bytes: doc.size_bytes,
          })
          .select('id')
          .single();
        if (!docErr && tDoc) {
          docIdMap[doc.id] = tDoc.id;
        }
      }
    }

    // 4. Read all run_submodule_config rows for this run
    const { data: configs } = await db
      .from('run_submodule_config')
      .select('submodule_id, options')
      .eq('run_id', runId);

    // 5. For each config, create presets + mappings
    const templateName = name.trim();
    if (configs?.length) {
      for (const cfg of configs) {
        if (!cfg.options || typeof cfg.options !== 'object') continue;

        const manifest = getSubmoduleById(cfg.submodule_id);
        const manifestOptions = manifest?.options || [];

        for (const [optName, optValue] of Object.entries(cfg.options)) {
          if (optValue === null || optValue === undefined) continue;

          // Find manifest option definition
          const optDef = manifestOptions.find(o => o.name === optName);

          // Skip if value matches default (use JSON.stringify for array/object defaults)
          if (optDef && JSON.stringify(optValue) === JSON.stringify(optDef.default)) continue;

          // Remap doc_selector IDs from project → template
          let presetValue = optValue;
          if (optDef?.type === 'doc_selector' && Array.isArray(optValue)) {
            presetValue = optValue.map(id => docIdMap[id] || id);
          }

          // Create preset (try with template name, then with suffix on conflict)
          let presetId = null;
          let presetName = templateName;
          for (let attempt = 0; attempt < 3; attempt++) {
            const tryName = attempt === 0 ? presetName : `${presetName} (${attempt + 1})`;
            const { data: preset, error: presetErr } = await db
              .from('option_presets')
              .insert({
                submodule_id: cfg.submodule_id,
                option_name: optName,
                preset_name: tryName,
                preset_value: presetValue,
              })
              .select('id')
              .single();

            if (!presetErr && preset) {
              presetId = preset.id;
              break;
            }
            if (presetErr?.code !== '23505') {
              // Non-conflict error — skip this option
              break;
            }
          }

          if (!presetId) continue;

          // Create template_preset_mapping
          await db
            .from('template_preset_mappings')
            .insert({
              template_id: template.id,
              submodule_id: cfg.submodule_id,
              option_name: optName,
              preset_id: presetId,
            });
        }
      }
    }

    // 6. Return template detail (same shape as GET /:id)
    const { data: mappings } = await db
      .from('template_preset_mappings')
      .select('id, submodule_id, option_name, preset_id, option_presets(preset_name, preset_value)')
      .eq('template_id', template.id)
      .order('submodule_id');

    const { data: tplDocs } = await db
      .from('template_reference_docs')
      .select('id, filename, content_type, size_bytes, created_at')
      .eq('template_id', template.id)
      .order('filename');

    const presets = (mappings || []).map(m => ({
      id: m.id,
      submodule_id: m.submodule_id,
      option_name: m.option_name,
      preset_id: m.preset_id,
      preset_name: m.option_presets?.preset_name || '',
      preset_value: m.option_presets?.preset_value,
    }));

    res.status(201).json({
      template: {
        ...template,
        preset_count: presets.length,
        doc_count: (tplDocs || []).length,
        presets,
        reference_docs: tplDocs || [],
      },
    });
  } catch (err) { next(err); }
});

// ── Helper: Build run_submodule_config rows from template mappings ──

/**
 * Given a run_id and template preset mappings (with joined preset_value),
 * build run_submodule_config rows grouped by (step_index, submodule_id).
 */
export function buildConfigRows(runId, mappings) {
  // Group by submodule_id → merge option values into one options object
  const bySubmodule = {};
  for (const m of mappings) {
    if (!bySubmodule[m.submodule_id]) {
      bySubmodule[m.submodule_id] = {};
    }
    const presetValue = m.option_presets?.preset_value ?? m.preset_value;
    bySubmodule[m.submodule_id][m.option_name] = presetValue;
  }

  const rows = [];
  for (const [submoduleId, options] of Object.entries(bySubmodule)) {
    const manifest = getSubmoduleById(submoduleId);
    const stepIndex = manifest?.step ?? 0;
    rows.push({
      run_id: runId,
      step_index: stepIndex,
      submodule_id: submoduleId,
      options,
    });
  }
  return rows;
}

export default router;
