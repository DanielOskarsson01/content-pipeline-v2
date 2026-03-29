import { parse } from 'csv-parse';

/**
 * Canonical column aliases — superset from stepContext.js.
 * Template `column_aliases` in seed_config extend these additively.
 */
export const SEED_COLUMN_ALIASES = {
  // name
  'company name': 'name', 'company_name': 'name', 'companyname': 'name',
  'company': 'name', 'entity': 'name', 'entity name': 'name',
  'entity_name': 'name', 'brand': 'name', 'brand name': 'name',
  'brand_name': 'name', 'operator': 'name', 'provider': 'name',
  // website
  'url': 'website', 'site': 'website', 'site url': 'website',
  'site_url': 'website', 'company url': 'website', 'company_url': 'website',
  'homepage': 'website', 'home page': 'website', 'domain': 'website',
  'web': 'website', 'link': 'website',
  // youtube
  'youtube url': 'youtube', 'youtube_url': 'youtube',
  'youtube channel': 'youtube', 'youtube_channel': 'youtube',
  // linkedin
  'linkedin url': 'linkedin', 'linkedin_url': 'linkedin',
  'linkedin page': 'linkedin', 'linkedin_page': 'linkedin',
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
 * Parse a CSV buffer into entities with column alias resolution and name contract enforcement.
 * @param {Buffer} buffer - CSV file buffer
 * @param {Object} [templateAliases] - Additional aliases from template seed_config
 * @returns {{ entities: Object[], columns_found: string[], all_columns: string[] }}
 */
export async function parseSeedCsv(buffer, templateAliases) {
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

  // Extract column metadata
  const all_columns = records.length > 0 ? Object.keys(records[0]).map(k => k.toLowerCase().trim()) : [];
  const columns_found = all_columns.filter(c => {
    const canon = aliases[c];
    return canon || c === 'name' || c === 'website';
  });

  return { entities, columns_found, all_columns };
}
