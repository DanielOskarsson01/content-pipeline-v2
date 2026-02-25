import { Router } from 'express';
import multer from 'multer';
import supabase from '../services/db.js';

const router = Router({ mergeParams: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const ALLOWED_EXTENSIONS = new Set(['md', 'txt', 'csv', 'json']);

/**
 * POST /api/projects/:projectId/reference-docs
 * Upload 1+ reference documents. Accepts .md, .txt, .csv, .json.
 * Upserts by (project_id, filename).
 */
router.post('/', upload.array('files', 10), async (req, res) => {
  const { projectId } = req.params;

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  const results = [];
  const errors = [];

  for (const file of req.files) {
    const ext = file.originalname.split('.').pop()?.toLowerCase();
    if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
      errors.push(`${file.originalname}: unsupported type. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
      continue;
    }

    const content = file.buffer.toString('utf-8');
    const contentType = {
      md: 'text/markdown',
      txt: 'text/plain',
      csv: 'text/csv',
      json: 'application/json',
    }[ext] || 'text/plain';

    const { data, error } = await supabase
      .from('project_reference_docs')
      .upsert({
        project_id: projectId,
        filename: file.originalname,
        content,
        content_type: contentType,
        size_bytes: file.size,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'project_id,filename' })
      .select('id, filename, content_type, size_bytes, created_at, updated_at')
      .single();

    if (error) {
      errors.push(`${file.originalname}: ${error.message}`);
    } else {
      results.push(data);
    }
  }

  res.json({ uploaded: results, errors });
});

/**
 * GET /api/projects/:projectId/reference-docs
 * List all reference docs for a project (metadata only, no content).
 */
router.get('/', async (req, res) => {
  const { projectId } = req.params;

  const { data, error } = await supabase
    .from('project_reference_docs')
    .select('id, filename, content_type, size_bytes, created_at, updated_at')
    .eq('project_id', projectId)
    .order('filename');

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

/**
 * GET /api/projects/:projectId/reference-docs/:docId
 * Get full content of one reference doc.
 */
router.get('/:docId', async (req, res) => {
  const { projectId, docId } = req.params;

  const { data, error } = await supabase
    .from('project_reference_docs')
    .select('*')
    .eq('id', docId)
    .eq('project_id', projectId)
    .single();

  if (error) {
    return res.status(404).json({ error: 'Document not found' });
  }

  res.json(data);
});

/**
 * DELETE /api/projects/:projectId/reference-docs/:docId
 * Remove one reference doc.
 */
router.delete('/:docId', async (req, res) => {
  const { projectId, docId } = req.params;

  const { error } = await supabase
    .from('project_reference_docs')
    .delete()
    .eq('id', docId)
    .eq('project_id', projectId);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ deleted: true });
});

export default router;
