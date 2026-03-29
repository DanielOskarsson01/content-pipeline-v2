import { Router } from 'express';
import multer from 'multer';
import { parseSeedCsv } from '../utils/seedParser.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const PREVIEW_LIMIT = 500;

/**
 * POST /api/seed/preview
 * Parse a CSV file and return entity preview without creating a run.
 * Used by CsvUploadInput in use_template mode.
 */
router.post('/preview', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'CSV file required (file field)' });
    }

    const requiredColumns = req.body.required_columns
      ? JSON.parse(req.body.required_columns)
      : [];

    const { entities, columns_found, all_columns } = await parseSeedCsv(req.file.buffer);

    const columns_missing = requiredColumns.filter(c => !columns_found.includes(c) && !all_columns.includes(c));
    const truncated = entities.length > PREVIEW_LIMIT;

    res.json({
      entity_count: entities.length,
      entities: truncated ? entities.slice(0, PREVIEW_LIMIT) : entities,
      columns_found,
      columns_missing,
      all_columns,
      filename: req.file.originalname,
      truncated,
    });
  } catch (err) { next(err); }
});

export default router;
