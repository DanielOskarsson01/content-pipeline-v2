import { parse } from 'csv-parse';
import XLSX from 'xlsx';

/**
 * Canonical column aliases — superset from stepContext.js.
 * Template `column_aliases` in seed_config extend these additively.
 */
export const SEED_COLUMN_ALIASES = {
  // name
  'company name': 'name', 'company_name': 'name', 'companyname': 'name',
  'company': 'name', 'entity': 'name', 'entity name': 'name',
  'entity_name': 'name', 'brand': 'name', 'brand name': 'name',
  'brand_name': 'name', 'brandname': 'name',
  'operator': 'name', 'operator name': 'name', 'operator_name': 'name',
  'provider': 'name', 'provider name': 'name', 'provider_name': 'name',
  // website
  'url': 'website', 'urls': 'website', 'site': 'website',
  'site url': 'website', 'site_url': 'website', 'siteurl': 'website',
  'web': 'website', 'www': 'website',
  'webpage': 'website', 'web page': 'website', 'web_page': 'website',
  'web site': 'website', 'web_site': 'website',
  'website url': 'website', 'website_url': 'website', 'websiteurl': 'website',
  'company url': 'website', 'company_url': 'website', 'companyurl': 'website',
  'company website': 'website', 'company_website': 'website', 'companywebsite': 'website',
  'company site': 'website', 'company_site': 'website',
  'company web': 'website', 'company_web': 'website',
  'homepage': 'website', 'home page': 'website', 'home_page': 'website',
  'domain': 'website', 'domain name': 'website', 'domain_name': 'website',
  'link': 'website',
  // youtube
  'youtube': 'youtube', 'youtube url': 'youtube', 'youtube_url': 'youtube', 'youtubeurl': 'youtube',
  'youtube channel': 'youtube', 'youtube_channel': 'youtube', 'youtubechannel': 'youtube',
  'youtube link': 'youtube', 'youtube_link': 'youtube',
  'yt': 'youtube', 'yt url': 'youtube', 'yt_url': 'youtube',
  'yt channel': 'youtube', 'yt_channel': 'youtube',
  // linkedin
  'linkedin': 'linkedin', 'linkedin url': 'linkedin', 'linkedin_url': 'linkedin', 'linkedinurl': 'linkedin',
  'linkedin page': 'linkedin', 'linkedin_page': 'linkedin', 'linkedinpage': 'linkedin',
  'linkedin link': 'linkedin', 'linkedin_link': 'linkedin',
  'linkedin profile': 'linkedin', 'linkedin_profile': 'linkedin',
  'li': 'linkedin',
};

/** Promisified csv-parse */
function parseCsvAsync(content, options) {
  return new Promise((resolve, reject) => {
    parse(content, options, (err, records) => {
      if (err) reject(err);
      else resolve(records);
    });
  });
}

/**
 * Parse a CSV or Excel buffer into entities with column alias resolution and name contract enforcement.
 * @param {Buffer} buffer - File buffer (CSV or XLSX/XLS)
 * @param {Object} [templateAliases] - Additional aliases from template seed_config
 * @param {string} [filename] - Original filename to detect format (defaults to CSV)
 * @returns {{ entities: Object[], columns_found: string[], all_columns: string[] }}
 */
export async function parseSeedFile(buffer, templateAliases, filename) {
  const ext = filename ? filename.split('.').pop()?.toLowerCase() : 'csv';

  let records;
  if (ext === 'xlsx' || ext === 'xls') {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
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
  } else {
    // CSV parsing with double-encode detection (same as stepContext.js)
    let content = buffer.toString('utf-8');

    const firstLine = content.split(/\r?\n/)[0];
    const testParse = await parseCsvAsync(firstLine + '\n', { columns: false, skip_empty_lines: true, bom: true, relax_column_count: true });
    if (testParse.length > 0 && testParse[0].length === 1 && testParse[0][0].includes(',')) {
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

    // Auto-detect delimiter: semicolon-delimited CSVs common in European Excel exports
    const headerLine = content.split(/\r?\n/).find(l => l.trim()) || '';
    const commaCount = (headerLine.match(/,/g) || []).length;
    const semicolonCount = (headerLine.match(/;/g) || []).length;
    const delimiter = semicolonCount > commaCount ? ';' : ',';

    records = await parseCsvAsync(content, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
      relax_column_count: true,
      delimiter,
    });
  }

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

  // Extract column metadata
  const all_columns = records.length > 0 ? Object.keys(records[0]).map(k => k.toLowerCase().trim()) : [];
  const columns_found = all_columns.filter(c => {
    const canon = aliases[c];
    return canon || c === 'name' || c === 'website';
  });

  return { entities, columns_found, all_columns };
}

// Backward-compatible alias
export const parseSeedCsv = parseSeedFile;
