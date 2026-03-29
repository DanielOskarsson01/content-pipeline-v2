import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse';
import db from '../services/db.js';
import { getSubmoduleById } from '../services/moduleLoader.js';
import { STEP_CONFIG } from '../../shared/stepConfig.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const ALLOWED_EXTENSIONS = new Set(['md', 'txt', 'csv', 'json']);

// Column aliases for CSV seed parsing in launch endpoint
// (mirrors core set from stepContext.js — template column_aliases extend these additively)
const SEED_COLUMN_ALIASES = {
  'company name': 'name', 'company_name': 'name', 'brand': 'name',
  'brand name': 'name', 'operator': 'name', 'entity': 'name',
  'url': 'website', 'domain': 'website', 'company url': 'website',
  'website url': 'website', 'homepage': 'website',
};

/** Promisified csv-parse (non-blocking, same pattern as stepContext.js) */
function parseCsvAsync(content, options) {
  return new Promise((resolve, reject) => {
    parse(content, options, (err, records) => {
      if (err) reject(err);
      else resolve(records);
    });
  });
}

// ── Template CRUD ──────────────────────────────────────────────

/**
 * GET /api/templates
 * List all templates. preset_count derived from preset_map JSONB keys.
 */
router.get('/', async (_req, res, next) => {
  try {
    const { data: templates, error } = await db
      .from('templates')
      .select('*')
      .order('name');
    if (error) throw error;

    // Doc counts from reference docs table
    const ids = (templates || []).map(t => t.id);
    let docCounts = {};
    if (ids.length > 0) {
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
      preset_count: Object.keys(t.preset_map || {}).length,
      doc_count: docCounts[t.id] || 0,
    }));

    res.json(result);
  } catch (err) { next(err); }
});

/**
 * GET /api/templates/:id
 * Template detail with JSONB config + backward-compat presets array + doc metadata.
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

    // Fetch reference doc metadata (no content)
    const { data: docs } = await db
      .from('template_reference_docs')
      .select('id, filename, content_type, size_bytes, created_at')
      .eq('template_id', template.id)
      .order('filename');

    // Build backward-compat presets array from preset_map JSONB
    const presets = [];
    for (const [submoduleId, config] of Object.entries(template.preset_map || {})) {
      for (const [optionName, value] of Object.entries(config.fallback_values || {})) {
        presets.push({
          submodule_id: submoduleId,
          option_name: optionName,
          preset_name: config.preset_name || '',
          preset_value: value,
        });
      }
    }

    res.json({
      ...template,
      preset_count: Object.keys(template.preset_map || {}).length,
      doc_count: (docs || []).length,
      presets,
      reference_docs: docs || [],
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/templates
 * Create a new template with optional JSONB config.
 */
router.post('/', async (req, res, next) => {
  try {
    const { name, description, preset_map, execution_plan, seed_config } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const insert = { name: name.trim(), description: description || null };
    if (preset_map) insert.preset_map = preset_map;
    if (execution_plan) insert.execution_plan = execution_plan;
    if (seed_config) insert.seed_config = seed_config;

    const { data, error } = await db
      .from('templates')
      .insert(insert)
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
 * Update template fields including JSONB config columns.
 */
router.put('/:id', async (req, res, next) => {
  try {
    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name.trim();
    if (req.body.description !== undefined) updates.description = req.body.description;
    if (req.body.preset_map !== undefined) updates.preset_map = req.body.preset_map;
    if (req.body.execution_plan !== undefined) updates.execution_plan = req.body.execution_plan;
    if (req.body.seed_config !== undefined) updates.seed_config = req.body.seed_config;
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

// ── Preset Mappings (DEPRECATED — use preset_map JSONB instead) ──

/**
 * DEPRECATED: POST /api/templates/:id/presets
 * Bridge table pass-through. Use PUT /:id with preset_map instead.
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
 * DEPRECATED: DELETE /api/templates/:id/presets/:mappingId
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
 * Builds preset_map JSONB directly from run_submodule_config rows.
 * Body: { name, description?, seed_config? }
 */
router.post('/from-run/:runId', async (req, res, next) => {
  try {
    const { name, description, seed_config } = req.body;
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

    // 2. Create template (JSONB fields added after doc copy for ID remapping)
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

    // 4. Read all run_submodule_config rows
    const { data: configs } = await db
      .from('run_submodule_config')
      .select('submodule_id, step_index, options')
      .eq('run_id', runId);

    // 5. Build preset_map JSONB + execution_plan from configs
    const templateName = name.trim();
    const presetMap = {};
    const submodulesPerStep = {};

    if (configs?.length) {
      for (const cfg of configs) {
        if (!cfg.options || typeof cfg.options !== 'object') continue;

        const manifest = getSubmoduleById(cfg.submodule_id);
        const manifestOptions = manifest?.options || [];
        const stepIdx = cfg.step_index ?? manifest?.step ?? 0;

        // Track submodules per step for execution_plan
        if (!submodulesPerStep[stepIdx]) submodulesPerStep[stepIdx] = [];
        submodulesPerStep[stepIdx].push(cfg.submodule_id);

        const fallbackValues = {};
        for (const [optName, optValue] of Object.entries(cfg.options)) {
          if (optValue === null || optValue === undefined) continue;

          const optDef = manifestOptions.find(o => o.name === optName);
          // Skip if value matches default
          if (optDef && JSON.stringify(optValue) === JSON.stringify(optDef.default)) continue;

          // Remap doc_selector IDs from project → template
          let finalValue = optValue;
          if (optDef?.type === 'doc_selector' && Array.isArray(optValue)) {
            finalValue = optValue.map(id => docIdMap[id] || id);
          }
          fallbackValues[optName] = finalValue;
        }

        if (Object.keys(fallbackValues).length > 0) {
          presetMap[cfg.submodule_id] = {
            preset_name: templateName,
            fallback_values: fallbackValues,
          };
        }
      }
    }

    const executionPlan = { submodules_per_step: submodulesPerStep };
    const finalSeedConfig = seed_config || { seed_type: 'csv' };

    // 6. Update template with JSONB fields
    const { error: updateErr } = await db
      .from('templates')
      .update({
        preset_map: presetMap,
        execution_plan: executionPlan,
        seed_config: finalSeedConfig,
        updated_at: new Date().toISOString(),
      })
      .eq('id', template.id);
    if (updateErr) throw updateErr;

    // 7. Return template detail
    const { data: tplDocs } = await db
      .from('template_reference_docs')
      .select('id, filename, content_type, size_bytes, created_at')
      .eq('template_id', template.id)
      .order('filename');

    const presets = [];
    for (const [submoduleId, config] of Object.entries(presetMap)) {
      for (const [optionName, value] of Object.entries(config.fallback_values || {})) {
        presets.push({
          submodule_id: submoduleId,
          option_name: optionName,
          preset_name: config.preset_name || '',
          preset_value: value,
        });
      }
    }

    res.status(201).json({
      template: {
        ...template,
        preset_map: presetMap,
        execution_plan: executionPlan,
        seed_config: finalSeedConfig,
        preset_count: Object.keys(presetMap).length,
        doc_count: (tplDocs || []).length,
        presets,
        reference_docs: tplDocs || [],
      },
    });
  } catch (err) { next(err); }
});

// ── Apply Template ────────────────────────────────────────────

/**
 * POST /api/templates/:id/apply
 * Apply template preset_map to an existing run.
 * Resolves presets: project-scoped → global → fallback_values.
 * Copies template docs to project if needed, remaps doc_selector IDs.
 * Body: { run_id }
 */
router.post('/:id/apply', async (req, res, next) => {
  try {
    const templateId = req.params.id;
    const { run_id } = req.body;
    if (!run_id) {
      return res.status(400).json({ error: 'run_id is required' });
    }

    // 1. Fetch template
    const { data: template, error: tErr } = await db
      .from('templates')
      .select('id, preset_map')
      .eq('id', templateId)
      .single();
    if (tErr?.code === 'PGRST116' || !template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    if (tErr) throw tErr;

    const presetMap = template.preset_map || {};
    if (Object.keys(presetMap).length === 0) {
      return res.json({ applied: 0, message: 'Template has no preset_map' });
    }

    // 2. Fetch run → project_id
    const { data: run, error: rErr } = await db
      .from('pipeline_runs')
      .select('id, project_id')
      .eq('id', run_id)
      .single();
    if (rErr?.code === 'PGRST116' || !run) {
      return res.status(404).json({ error: 'Run not found' });
    }
    if (rErr) throw rErr;

    // 3. Copy template docs → project docs (skip existing by filename)
    const docIdMap = await copyTemplateDocs(templateId, run.project_id);

    // 4. Resolve presets (project → global → fallback)
    const resolved = await resolvePresetMap(presetMap, run.project_id);

    // 5. Build + upsert run_submodule_config rows
    const configRows = buildConfigRowsFromPresetMap(run_id, resolved, docIdMap);
    for (const row of configRows) {
      await db.from('run_submodule_config').upsert(row, {
        onConflict: 'run_id,step_index,submodule_id',
      });
    }

    res.json({ applied: configRows.length });
  } catch (err) { next(err); }
});

// ── Launch Template ───────────────────────────────────────────

/**
 * POST /api/templates/:id/launch
 * Atomic: create project (draft) + run + stages + copy docs + apply presets + seed + auto-approve step 0.
 * Accepts multipart (CSV seed) or JSON (URL/prompt seed).
 * Fields: { project_name, project_description?, mode }
 * For csv: seed_file (multipart file field)
 * For url: urls (newline-separated string)
 * For prompt: prompt (string)
 */
router.post('/:id/launch', upload.single('seed_file'), async (req, res, next) => {
  try {
    const templateId = req.params.id;
    const { project_name, project_description, mode } = req.body;

    if (!project_name?.trim()) {
      return res.status(400).json({ error: 'project_name is required' });
    }
    const validModes = ['single_run', 'use_template', 'update_template', 'new_template', 'fork_template'];
    if (!mode || !validModes.includes(mode)) {
      return res.status(400).json({ error: `mode must be one of: ${validModes.join(', ')}` });
    }

    // 1. Fetch template
    const { data: template, error: tErr } = await db
      .from('templates')
      .select('*')
      .eq('id', templateId)
      .single();
    if (tErr?.code === 'PGRST116' || !template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    if (tErr) throw tErr;

    const seedConfig = template.seed_config || { seed_type: 'csv' };
    const seedType = seedConfig.seed_type || 'csv';

    // 2. Parse seed data before creating anything (fail fast)
    let entities = [];
    let seedFilename = null;

    if (seedType === 'csv') {
      if (!req.file) {
        return res.status(400).json({ error: 'CSV seed file required (seed_file field)' });
      }
      const parsed = await parseSeedCsv(req.file.buffer, seedConfig.column_aliases);
      entities = parsed.entities;
      seedFilename = req.file.originalname;
    } else if (seedType === 'url') {
      const urls = req.body.urls;
      if (!urls?.trim()) {
        return res.status(400).json({ error: 'urls field required for url seed type' });
      }
      entities = urls.trim().split(/\r?\n/).filter(Boolean).map(line => {
        const url = line.trim();
        let entityName = url;
        try {
          const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
          entityName = parsed.hostname.replace(/^www\./, '').split('.')[0];
          entityName = entityName.charAt(0).toUpperCase() + entityName.slice(1);
        } catch { /* use raw url as name */ }
        return { name: entityName, website: url };
      });
    } else if (seedType === 'prompt') {
      const prompt = req.body.prompt;
      if (!prompt?.trim()) {
        return res.status(400).json({ error: 'prompt field required for prompt seed type' });
      }
      entities = [{ name: 'prompt', text: prompt.trim() }];
    }

    if (entities.length === 0) {
      return res.status(400).json({ error: 'No entities parsed from seed data' });
    }

    // 3. Mode-specific template setup
    let linkedTemplateId = templateId;
    let sourceTemplateId = templateId; // where to copy docs from

    if (mode === 'fork_template') {
      // Deep-copy template
      let forkName = `${template.name} (fork)`;
      let { data: fork, error: forkErr } = await db
        .from('templates')
        .insert({
          name: forkName,
          description: template.description,
          preset_map: template.preset_map,
          execution_plan: template.execution_plan,
          seed_config: template.seed_config,
        })
        .select()
        .single();
      if (forkErr?.code === '23505') {
        forkName = `${template.name} (fork ${Date.now()})`;
        ({ data: fork, error: forkErr } = await db
          .from('templates')
          .insert({ name: forkName, description: template.description, preset_map: template.preset_map, execution_plan: template.execution_plan, seed_config: template.seed_config })
          .select()
          .single());
      }
      if (forkErr) throw forkErr;
      linkedTemplateId = fork.id;

      // Copy docs to fork + remap doc_selector IDs in fork's preset_map
      const forkDocMap = await copyTemplateDocsToTemplate(templateId, fork.id);
      if (Object.keys(forkDocMap).length > 0) {
        const remapped = remapPresetMapDocIds(template.preset_map || {}, forkDocMap);
        await db.from('templates').update({ preset_map: remapped, updated_at: new Date().toISOString() }).eq('id', fork.id);
      }
      sourceTemplateId = fork.id;
    } else if (mode === 'new_template') {
      // Create empty template — progressive save populates it
      let newName = `${project_name.trim()} template`;
      let { data: newTpl, error: newTplErr } = await db
        .from('templates')
        .insert({ name: newName, description: `Auto-created from project "${project_name.trim()}"`, seed_config: seedConfig })
        .select()
        .single();
      if (newTplErr?.code === '23505') {
        newName = `${project_name.trim()} template (${Date.now()})`;
        ({ data: newTpl, error: newTplErr } = await db
          .from('templates')
          .insert({ name: newName, description: `Auto-created from project "${project_name.trim()}"`, seed_config: seedConfig })
          .select()
          .single());
      }
      if (newTplErr) throw newTplErr;
      linkedTemplateId = newTpl.id;
      // sourceTemplateId stays as original — copy docs & config from source
    }

    // 4. Create project with draft status
    const { data: project, error: projErr } = await db
      .from('projects')
      .insert({
        name: project_name.trim(),
        description: project_description || null,
        template_id: linkedTemplateId,
        mode,
        status: 'draft',
      })
      .select()
      .single();
    if (projErr) throw projErr;

    // 5. Create run (step 0 auto-approved → start at step 1)
    const { data: run, error: runErr } = await db
      .from('pipeline_runs')
      .insert({ project_id: project.id, status: 'running', current_step: 1 })
      .select()
      .single();
    if (runErr) throw runErr;

    // 6. Create 11 stages (step 0 = approved, step 1 = active, rest pending)
    const stages = STEP_CONFIG.map((step) => ({
      run_id: run.id,
      step_index: step.index,
      step_name: step.name,
      status: step.index === 0 ? 'approved' : step.index === 1 ? 'active' : 'pending',
    }));
    const { error: stagesErr } = await db.from('pipeline_stages').insert(stages);
    if (stagesErr) throw stagesErr;

    // 7. Copy docs from source template → project
    const docIdMap = await copyTemplateDocs(sourceTemplateId, project.id);

    // 8. Apply source template's preset_map → run_submodule_config
    // For fork_template, re-fetch preset_map from the fork (doc IDs were remapped)
    let presetMap = template.preset_map || {};
    if (sourceTemplateId !== templateId) {
      const { data: srcTpl } = await db.from('templates').select('preset_map').eq('id', sourceTemplateId).single();
      if (srcTpl?.preset_map) presetMap = srcTpl.preset_map;
    }
    if (Object.keys(presetMap).length > 0) {
      const resolved = await resolvePresetMap(presetMap, project.id);
      const configRows = buildConfigRowsFromPresetMap(run.id, resolved, docIdMap);
      if (configRows.length > 0) {
        await db.from('run_submodule_config').insert(configRows);
      }
    }

    // 9. Write seed data to step_context for step 0
    await db.from('step_context').upsert({
      run_id: run.id,
      step_index: 0,
      entities,
      filename: seedFilename,
      created_at: new Date().toISOString(),
    }, { onConflict: 'run_id,step_index' });

    // 10. Flip project to active
    await db.from('projects').update({ status: 'active' }).eq('id', project.id);

    res.status(201).json({ project: { ...project, status: 'active' }, run });
  } catch (err) { next(err); }
});

// ── Helpers ───────────────────────────────────────────────────

/**
 * Copy template_reference_docs → project_reference_docs.
 * Returns docIdMap: { templateDocId → projectDocId }.
 */
async function copyTemplateDocs(templateId, projectId) {
  const docIdMap = {};
  const { data: tDocs } = await db
    .from('template_reference_docs')
    .select('id, filename, content, content_type, size_bytes')
    .eq('template_id', templateId);

  if (!tDocs?.length) return docIdMap;

  for (const doc of tDocs) {
    const { data: pDoc, error: docErr } = await db
      .from('project_reference_docs')
      .insert({
        project_id: projectId,
        filename: doc.filename,
        content: doc.content,
        content_type: doc.content_type,
        size_bytes: doc.size_bytes,
      })
      .select('id')
      .single();

    if (!docErr && pDoc) {
      docIdMap[doc.id] = pDoc.id;
    } else if (docErr?.code === '23505') {
      // Already exists — fetch existing
      const { data: existing } = await db
        .from('project_reference_docs')
        .select('id')
        .eq('project_id', projectId)
        .eq('filename', doc.filename)
        .single();
      if (existing) docIdMap[doc.id] = existing.id;
    }
  }
  return docIdMap;
}

/**
 * Copy template_reference_docs from one template to another (for fork_template).
 * Returns docIdMap: { sourceDocId → targetDocId }.
 */
async function copyTemplateDocsToTemplate(sourceTemplateId, targetTemplateId) {
  const docIdMap = {};
  const { data: tDocs } = await db
    .from('template_reference_docs')
    .select('id, filename, content, content_type, size_bytes')
    .eq('template_id', sourceTemplateId);

  if (!tDocs?.length) return docIdMap;

  for (const doc of tDocs) {
    const { data: newDoc, error } = await db
      .from('template_reference_docs')
      .insert({
        template_id: targetTemplateId,
        filename: doc.filename,
        content: doc.content,
        content_type: doc.content_type,
        size_bytes: doc.size_bytes,
      })
      .select('id')
      .single();
    if (!error && newDoc) {
      docIdMap[doc.id] = newDoc.id;
    }
  }
  return docIdMap;
}

/**
 * Remap doc_selector IDs in a preset_map using a docIdMap.
 */
function remapPresetMapDocIds(presetMap, docIdMap) {
  const remapped = {};
  for (const [subId, config] of Object.entries(presetMap || {})) {
    const manifest = getSubmoduleById(subId);
    const remappedFallbacks = { ...config.fallback_values };
    for (const opt of (manifest?.options || [])) {
      if (opt.type === 'doc_selector' && Array.isArray(remappedFallbacks[opt.name])) {
        remappedFallbacks[opt.name] = remappedFallbacks[opt.name].map(id => docIdMap[id] || id);
      }
    }
    remapped[subId] = { ...config, fallback_values: remappedFallbacks };
  }
  return remapped;
}

/**
 * Resolve preset_map option values using preset resolution order:
 * 1. Project-scoped preset (option_presets WHERE project_id = X)
 * 2. Global preset (option_presets WHERE project_id IS NULL)
 * 3. Fallback values from preset_map
 * Returns: { submoduleId: { optionName: resolvedValue } }
 */
export async function resolvePresetMap(presetMap, projectId) {
  const submoduleIds = Object.keys(presetMap);
  const presetNames = [...new Set(submoduleIds.map(id => presetMap[id].preset_name).filter(Boolean))];

  // Batch-fetch matching presets
  let presetRows = [];
  if (presetNames.length > 0 && submoduleIds.length > 0) {
    const { data } = await db
      .from('option_presets')
      .select('submodule_id, option_name, preset_name, preset_value, project_id')
      .in('submodule_id', submoduleIds)
      .in('preset_name', presetNames);
    presetRows = data || [];
  }

  // Index: "submoduleId::optionName" → { project: value, global: value }
  const presetIndex = {};
  for (const row of presetRows) {
    const key = `${row.submodule_id}::${row.option_name}`;
    if (!presetIndex[key]) presetIndex[key] = {};
    if (row.project_id === projectId) {
      presetIndex[key].project = row.preset_value;
    } else if (!row.project_id) {
      presetIndex[key].global = row.preset_value;
    }
  }

  // Resolve each option
  const resolved = {};
  for (const [subId, config] of Object.entries(presetMap)) {
    resolved[subId] = {};
    for (const [optName, fallbackVal] of Object.entries(config.fallback_values || {})) {
      const key = `${subId}::${optName}`;
      const idx = presetIndex[key] || {};
      resolved[subId][optName] = idx.project ?? idx.global ?? fallbackVal;
    }
  }

  return resolved;
}

/**
 * Build run_submodule_config rows from resolved preset_map options.
 * Handles doc_selector ID remapping via docIdMap.
 */
export function buildConfigRowsFromPresetMap(runId, resolvedOptions, docIdMap = {}) {
  const rows = [];
  for (const [submoduleId, options] of Object.entries(resolvedOptions)) {
    const manifest = getSubmoduleById(submoduleId);
    const stepIndex = manifest?.step ?? 0;

    // Remap doc_selector IDs
    const remapped = { ...options };
    for (const opt of (manifest?.options || [])) {
      if (opt.type === 'doc_selector' && Array.isArray(remapped[opt.name])) {
        remapped[opt.name] = remapped[opt.name].map(id => docIdMap[id] || id);
      }
    }

    rows.push({
      run_id: runId,
      step_index: stepIndex,
      submodule_id: submoduleId,
      options: remapped,
    });
  }
  return rows;
}

/**
 * Parse CSV buffer for seed data. Applies column aliases + entity name contract.
 */
async function parseSeedCsv(buffer, templateAliases) {
  const content = buffer.toString('utf-8');
  const records = await parseCsvAsync(content, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
    relax_column_count: true,
  });

  // Merge template aliases (additive) with base aliases
  const aliases = { ...SEED_COLUMN_ALIASES };
  if (templateAliases && typeof templateAliases === 'object') {
    for (const [alias, canonical] of Object.entries(templateAliases)) {
      aliases[alias.toLowerCase()] = canonical;
    }
  }

  const entities = records.map((row, i) => {
    // Lowercase keys + apply aliases
    const normalized = {};
    const lowered = {};
    for (const [key, value] of Object.entries(row)) {
      lowered[key.toLowerCase().trim()] = value;
    }
    for (const [key, value] of Object.entries(lowered)) {
      const canonical = aliases[key];
      if (canonical && !(canonical in normalized) && !(canonical in lowered)) {
        normalized[canonical] = value;
      }
      if (!(key in normalized)) {
        normalized[key] = value;
      }
    }

    // Entity name contract: derive name from website if missing
    if (!normalized.name && normalized.website) {
      try {
        const url = normalized.website.startsWith('http') ? normalized.website : `https://${normalized.website}`;
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        normalized.name = hostname.split('.')[0].charAt(0).toUpperCase() + hostname.split('.')[0].slice(1);
      } catch { /* ignore */ }
    }
    if (!normalized.name) {
      const firstVal = Object.values(normalized).find(v => typeof v === 'string' && v.length > 0);
      normalized.name = firstVal || `Entity ${i + 1}`;
    }
    return normalized;
  });

  return { entities };
}

/**
 * DEPRECATED: Build run_submodule_config from bridge table mappings.
 * Kept for backward compat with projects.js until it's updated to use buildConfigRowsFromPresetMap.
 */
export function buildConfigRows(runId, mappings) {
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
