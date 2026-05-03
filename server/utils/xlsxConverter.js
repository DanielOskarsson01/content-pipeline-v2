/**
 * XLSX → CSV converter for csv-discovery pre-processing.
 *
 * Called by stageWorker before execute() when options contain source_dir
 * or upload_dir. Converts .xlsx/.xls files to .csv alongside the originals.
 * Idempotent — skips if the .csv already exists.
 *
 * Uses the xlsx package (already installed in the skeleton).
 * Modules stay dependency-free — conversion happens at the skeleton layer.
 */

import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

const XLSX_EXTENSIONS = new Set(['.xlsx', '.xls']);

/**
 * Convert all .xlsx/.xls files in a directory to .csv.
 * @param {string} dirPath - Absolute path to directory
 * @returns {{ converted: number, skipped: number, errors: string[] }}
 */
export function convertXlsxInDir(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return { converted: 0, skipped: 0, errors: [] };
  }

  const files = fs.readdirSync(dirPath);
  let converted = 0;
  let skipped = 0;
  const errors = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!XLSX_EXTENSIONS.has(ext)) continue;

    const csvName = file.replace(/\.(xlsx|xls)$/i, '.csv');
    const csvPath = path.join(dirPath, csvName);

    // Idempotent — skip if CSV already exists
    if (fs.existsSync(csvPath)) {
      skipped++;
      continue;
    }

    try {
      const xlsxPath = path.join(dirPath, file);
      const workbook = XLSX.readFile(xlsxPath);
      // Use the first sheet
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) {
        errors.push(`${file}: no sheets found`);
        continue;
      }
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
      fs.writeFileSync(csvPath, csv, 'utf-8');
      converted++;
    } catch (err) {
      errors.push(`${file}: ${err.message}`);
    }
  }

  return { converted, skipped, errors };
}
