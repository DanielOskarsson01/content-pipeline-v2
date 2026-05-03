/**
 * CSV/XLSX Upload for csv-discovery.
 *
 * Saves uploaded files to a per-project directory on disk.
 * XLSX/XLS files are converted to CSV on upload using the xlsx package.
 * csv-discovery then reads these files via the upload_dir option.
 *
 * Routes:
 *   POST   /api/projects/:projectId/csv-upload   — Upload file(s)
 *   GET    /api/projects/:projectId/csv-upload   — List uploaded files
 *   DELETE /api/projects/:projectId/csv-upload/:filename — Remove a file
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import XLSX from 'xlsx';

const router = Router({ mergeParams: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const ALLOWED_EXTENSIONS = new Set(['.csv', '.xlsx', '.xls']);

/** Base directory for all CSV uploads. Per-project subdirectories are created automatically. */
const CSV_UPLOAD_BASE = process.env.CSV_UPLOAD_DIR || path.join(process.cwd(), 'data', 'csv-uploads');

function getProjectDir(projectId) {
  return path.join(CSV_UPLOAD_BASE, projectId);
}

/**
 * POST /api/projects/:projectId/csv-upload
 * Upload one or more CSV/XLSX files. XLSX is converted to CSV on upload.
 */
router.post('/', upload.array('files', 20), async (req, res) => {
  const { projectId } = req.params;

  // Validate projectId is a UUID (prevent path traversal via route param)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    return res.status(400).json({ error: 'Invalid project ID' });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  const projectDir = getProjectDir(projectId);
  fs.mkdirSync(projectDir, { recursive: true });

  const results = [];
  const errors = [];

  for (const file of req.files) {
    // Sanitize filename: strip path components, reject traversal
    const safeName = path.basename(file.originalname);
    if (safeName !== file.originalname || safeName.includes('..')) {
      errors.push(`${file.originalname}: invalid filename`);
      continue;
    }

    const ext = path.extname(safeName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      errors.push(`${safeName}: unsupported type. Allowed: .csv, .xlsx, .xls`);
      continue;
    }

    try {
      let csvFilename;
      let rowCount = 0;

      if (ext === '.xlsx' || ext === '.xls') {
        // Convert to CSV
        const workbook = XLSX.read(file.buffer);
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) {
          errors.push(`${safeName}: no sheets found`);
          continue;
        }
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
        csvFilename = safeName.replace(/\.(xlsx|xls)$/i, '.csv');
        fs.writeFileSync(path.join(projectDir, csvFilename), csv, 'utf-8');
        rowCount = csv.split('\n').filter(l => l.trim()).length - 1; // minus header
      } else {
        // Plain CSV — write as-is
        csvFilename = safeName;
        fs.writeFileSync(path.join(projectDir, csvFilename), file.buffer);
        const content = file.buffer.toString('utf-8');
        rowCount = content.split('\n').filter(l => l.trim()).length - 1;
      }

      const stat = fs.statSync(path.join(projectDir, csvFilename));
      results.push({
        filename: csvFilename,
        original_filename: safeName,
        rows: Math.max(0, rowCount),
        size_bytes: stat.size,
        converted: ext !== '.csv',
      });
    } catch (err) {
      errors.push(`${safeName}: ${err.message}`);
    }
  }

  res.json({
    files: results,
    upload_dir: projectDir,
    errors,
  });
});

/**
 * GET /api/projects/:projectId/csv-upload
 * List all uploaded CSV files for a project.
 */
router.get('/', (req, res) => {
  const { projectId } = req.params;
  const projectDir = getProjectDir(projectId);

  if (!fs.existsSync(projectDir)) {
    return res.json({ files: [], upload_dir: projectDir });
  }

  const files = fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.csv'))
    .map(f => {
      const stat = fs.statSync(path.join(projectDir, f));
      return {
        filename: f,
        size_bytes: stat.size,
        uploaded_at: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));

  res.json({ files, upload_dir: projectDir });
});

/**
 * DELETE /api/projects/:projectId/csv-upload/:filename
 * Remove an uploaded file.
 */
router.delete('/:filename', (req, res) => {
  const { projectId, filename } = req.params;
  const filePath = path.join(getProjectDir(projectId), filename);

  // Prevent path traversal
  if (filename.includes('/') || filename.includes('..') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  fs.unlinkSync(filePath);

  // Also remove .processed entry if it references this file
  const processedPath = path.join(getProjectDir(projectId), '.processed');
  if (fs.existsSync(processedPath)) {
    const lines = fs.readFileSync(processedPath, 'utf-8').split('\n');
    const filtered = lines.filter(l => l.trim() !== filename);
    fs.writeFileSync(processedPath, filtered.join('\n'));
  }

  res.json({ deleted: true, filename });
});

export default router;
