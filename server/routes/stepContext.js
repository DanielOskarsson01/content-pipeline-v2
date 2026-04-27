import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse';
import XLSX from 'xlsx';
import supabase from '../services/db.js';
import { getSubmodules } from '../services/moduleLoader.js';

const router = Router({ mergeParams: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * Column alias map: common header variations → canonical column name.
 * Keys are lowercase. First match wins.
 */
const COLUMN_ALIASES = {
  // name
  'company name': 'name',
  'company_name': 'name',
  'companyname': 'name',
  'company': 'name',
  'entity': 'name',
  'entity name': 'name',
  'entity_name': 'name',
  'brand': 'name',
  'brand name': 'name',
  'brand_name': 'name',
  'brandname': 'name',
  'operator': 'name',
  'operator name': 'name',
  'operator_name': 'name',
  'provider': 'name',
  'provider name': 'name',
  'provider_name': 'name',
  // website
  'url': 'website',
  'urls': 'website',
  'site': 'website',
  'site url': 'website',
  'site_url': 'website',
  'siteurl': 'website',
  'web': 'website',
  'www': 'website',
  'webpage': 'website',
  'web page': 'website',
  'web_page': 'website',
  'web site': 'website',
  'web_site': 'website',
  'website url': 'website',
  'website_url': 'website',
  'websiteurl': 'website',
  'company url': 'website',
  'company_url': 'website',
  'companyurl': 'website',
  'company website': 'website',
  'company_website': 'website',
  'companywebsite': 'website',
  'company site': 'website',
  'company_site': 'website',
  'company web': 'website',
  'company_web': 'website',
  'homepage': 'website',
  'home page': 'website',
  'home_page': 'website',
  'domain': 'website',
  'domain name': 'website',
  'domain_name': 'website',
  'link': 'website',
  // youtube
  'youtube': 'youtube',
  'youtube url': 'youtube',
  'youtube_url': 'youtube',
  'youtubeurl': 'youtube',
  'youtube channel': 'youtube',
  'youtube_channel': 'youtube',
  'youtubechannel': 'youtube',
  'youtube link': 'youtube',
  'youtube_link': 'youtube',
  'yt': 'youtube',
  'yt url': 'youtube',
  'yt_url': 'youtube',
  'yt channel': 'youtube',
  'yt_channel': 'youtube',
  // linkedin
  'linkedin': 'linkedin',
  'linkedin url': 'linkedin',
  'linkedin_url': 'linkedin',
  'linkedinurl': 'linkedin',
  'linkedin page': 'linkedin',
  'linkedin_page': 'linkedin',
  'linkedinpage': 'linkedin',
  'linkedin link': 'linkedin',
  'linkedin_link': 'linkedin',
  'linkedin profile': 'linkedin',
  'linkedin_profile': 'linkedin',
  'li': 'linkedin',
};

/**
 * Rename columns in a record using the alias map.
 * Only renames if the canonical column isn't already present.
 */
function applyColumnAliases(row) {
  const result = {};
  const lowered = {};
  // First pass: lowercase all keys
  for (const [key, value] of Object.entries(row)) {
    lowered[key.toLowerCase().trim()] = value;
  }
  // Second pass: apply aliases (only if canonical target not already present)
  for (const [key, value] of Object.entries(lowered)) {
    const canonical = COLUMN_ALIASES[key];
    if (canonical && !(canonical in result) && !(canonical in lowered)) {
      result[canonical] = value;
    }
    // Always keep the original (possibly overwritten by canonical above)
    if (!(key in result)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * R008 fix: async CSV parse wrapper (non-blocking).
 * Uses csv-parse callback API instead of csv-parse/sync.
 */
function parseCsvAsync(content, options) {
  return new Promise((resolve, reject) => {
    parse(content, options, (err, records) => {
      if (err) reject(err);
      else resolve(records);
    });
  });
}

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
 * Upload a CSV/Excel file OR send JSON entities, validate columns, store in step_context.
 * Accepts multipart file upload (file field) or JSON body with { entities: [...] }.
 */
router.post('/', upload.single('file'), async (req, res) => {
  const { runId, stepIndex } = req.params;
  const step = parseInt(stepIndex, 10);
  const submoduleId = req.body?.submodule_id || null;

  // JSON entities path (URL/data paste from step-level seed input)
  if (!req.file && req.body?.entities) {
    let entities;
    try {
      entities = typeof req.body.entities === 'string' ? JSON.parse(req.body.entities) : req.body.entities;
    } catch (err) {
      return res.status(400).json({ error: 'Invalid entities JSON' });
    }
    if (!Array.isArray(entities) || entities.length === 0) {
      return res.status(400).json({ error: 'entities must be a non-empty array' });
    }
    // Enforce name contract + sanitize URL fields
    entities = entities.map((e, i) => {
      if (!e.name) {
        const firstVal = Object.values(e).find(v => typeof v === 'string' && v.length > 0);
        e.name = firstVal || `Entity ${i + 1}`;
      }
      // Strip trailing semicolons/commas from URL-like fields (common paste artifacts)
      for (const field of ['website', 'url', 'linkedin', 'youtube']) {
        if (typeof e[field] === 'string') {
          e[field] = e[field].trim().replace(/[;,]+$/, '');
        }
      }
      return e;
    });

    const { error } = await supabase
      .from('step_context')
      .upsert({
        run_id: runId,
        step_index: step,
        entities,
        filename: null,
        source_submodule: submoduleId,
        created_at: new Date().toISOString(),
      }, { onConflict: 'run_id,step_index' });

    if (error) return res.status(500).json({ error: error.message });

    return res.json({
      entity_count: entities.length,
      columns_found: [],
      columns_missing: [],
      all_columns: Object.keys(entities[0] || {}),
      filename: null,
    });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded and no entities provided' });
  }

  const ext = req.file.originalname.split('.').pop()?.toLowerCase();
  const SUPPORTED_EXTS = ['csv', 'xlsx', 'xls'];
  if (!SUPPORTED_EXTS.includes(ext)) {
    return res.status(415).json({ error: `Unsupported file type. Supported: ${SUPPORTED_EXTS.join(', ')}` });
  }

  // Parse file — CSV or XLSX/XLS
  let records;
  try {
    if (ext === 'xlsx' || ext === 'xls') {
      // Parse Excel with SheetJS — first sheet only, header row auto-detected
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error('Workbook has no sheets');
      records = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
      // Convert all values to strings (sheet_to_json returns numbers/dates as native types)
      records = records.map(row => {
        const stringRow = {};
        for (const [key, value] of Object.entries(row)) {
          stringRow[key] = value == null ? '' : String(value);
        }
        return stringRow;
      });
      console.log(`[stepContext] Parsed ${ext.toUpperCase()}: ${records.length} rows from sheet "${sheetName}"`);
    } else {
      // Parse CSV
      let content = req.file.buffer.toString('utf-8');

      // Detect double-encoded CSV: when a spreadsheet app (Numbers/Excel) re-saves a CSV,
      // it can wrap each row as a single quoted field with doubled internal quotes.
      const firstLine = content.split(/\r?\n/)[0];
      const testParse = await parseCsvAsync(firstLine + '\n', { columns: false, skip_empty_lines: true, bom: true, relax_column_count: true });
      if (testParse.length > 0 && testParse[0].length === 1 && testParse[0][0].includes(',')) {
        console.log('[stepContext] Detected double-encoded CSV — stripping outer quoting layer');
        const lines = content.split(/\r?\n/);
        const fixed = lines.map((line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
            return trimmed.slice(1, -1).replace(/""/g, '"');
          }
          return trimmed;
        });
        content = fixed.join('\n');
      }

      // Auto-detect delimiter: semicolon-delimited CSVs are common in European Excel exports
      const headerLine = content.split(/\r?\n/).find(l => l.trim()) || '';
      const commaCount = (headerLine.match(/,/g) || []).length;
      const semicolonCount = (headerLine.match(/;/g) || []).length;
      const delimiter = semicolonCount > commaCount ? ';' : ',';
      if (delimiter === ';') {
        console.log('[stepContext] Detected semicolon-delimited CSV');
      }

      records = await parseCsvAsync(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
        delimiter,
      });
    }
  } catch (err) {
    return res.status(400).json({ error: `Parse error: ${err.message}` });
  }

  if (records.length === 0) {
    return res.status(400).json({ error: 'CSV contains no data rows' });
  }

  if (records.length > 10000) {
    return res.status(400).json({ error: `Too many rows (${records.length}). Maximum: 10,000` });
  }

  // Apply column aliases to determine what canonical columns are present
  const sampleAliased = applyColumnAliases(records[0]);
  const requiredColumns = getStepRequiredColumns(step);
  const foundColumns = Object.keys(records[0]);
  const aliasedKeys = Object.keys(sampleAliased);
  const columnsMissing = requiredColumns.filter(c => !aliasedKeys.includes(c.toLowerCase()));
  const columnsFound = requiredColumns.filter(c => aliasedKeys.includes(c.toLowerCase()));

  // Normalize column names to lowercase + apply aliases
  const entities = records.map((row, i) => {
    const normalized = applyColumnAliases(row);
    // Auto-derive name from website URL if still missing
    if (!normalized.name && normalized.website) {
      try {
        const url = normalized.website.startsWith('http') ? normalized.website : `https://${normalized.website}`;
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        normalized.name = hostname.split('.')[0].charAt(0).toUpperCase() + hostname.split('.')[0].slice(1);
      } catch { /* ignore parse errors */ }
    }
    // Contract: every entity must have a name
    if (!normalized.name) {
      const firstVal = Object.values(normalized).find(v => typeof v === 'string' && v.length > 0);
      normalized.name = firstVal || `Entity ${i + 1}`;
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
