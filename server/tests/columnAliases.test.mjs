/**
 * Column alias tests — verifies CSV headers are correctly mapped to canonical columns.
 * Run: node server/tests/columnAliases.test.mjs
 */
import { parseSeedFile, SEED_COLUMN_ALIASES } from '../utils/seedParser.js';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

// Helper: build a CSV buffer from header + rows
function csvBuf(header, rows, delimiter = ',') {
  const lines = [header, ...rows].map(r => (Array.isArray(r) ? r.join(delimiter) : r));
  return Buffer.from(lines.join('\n'), 'utf-8');
}

// ── Test 1: "company website" semicolon-delimited (the exact bug) ──
console.log('\nTest 1: Semicolon CSV with "company name" + "company website"');
{
  const buf = csvBuf(
    'company name;company website',
    [
      'Conversion Gurus;https://conversiongurus.io',
      'Pronet Gaming;https://www.pronetgaming.com',
      'Tecpinion;http://tecpinion.com',
    ],
    ';'
  );
  const { entities, columns_found } = await parseSeedFile(buf, null, 'company list.csv');
  assert(entities.length === 3, `Parsed 3 entities (got ${entities.length})`);
  assert(entities[0].name === 'Conversion Gurus', `name = "Conversion Gurus" (got "${entities[0].name}")`);
  assert(entities[0].website === 'https://conversiongurus.io', `website = correct URL (got "${entities[0].website}")`);
  assert(entities[2].website === 'http://tecpinion.com', `3rd entity website correct (got "${entities[2].website}")`);
}

// ── Test 2: Comma-delimited with "url" header ──
console.log('\nTest 2: Comma CSV with "name" + "url"');
{
  const buf = csvBuf('name,url', ['Acme,https://acme.com', 'Beta,https://beta.io']);
  const { entities } = await parseSeedFile(buf, null, 'test.csv');
  assert(entities[0].name === 'Acme', `name = "Acme"`);
  assert(entities[0].website === 'https://acme.com', `url → website alias works (got "${entities[0].website}")`);
}

// ── Test 3: "www" header ──
console.log('\nTest 3: "www" as website alias');
{
  const buf = csvBuf('name,www', ['TestCo,https://testco.com']);
  const { entities } = await parseSeedFile(buf, null, 'test.csv');
  assert(entities[0].website === 'https://testco.com', `www → website (got "${entities[0].website}")`);
}

// ── Test 4: "Company Website" (capitalized) ──
console.log('\nTest 4: "Company Website" capitalized header');
{
  const buf = csvBuf('Company Website,Company Name', ['https://example.com,Example Inc']);
  const { entities } = await parseSeedFile(buf, null, 'test.csv');
  assert(entities[0].website === 'https://example.com', `Company Website → website (got "${entities[0].website}")`);
  assert(entities[0].name === 'Example Inc', `Company Name → name (got "${entities[0].name}")`);
}

// ── Test 5: "domain name" header ──
console.log('\nTest 5: "domain name" as website alias');
{
  const buf = csvBuf('name,domain name', ['FooCo,foo.com']);
  const { entities } = await parseSeedFile(buf, null, 'test.csv');
  assert(entities[0].website === 'foo.com', `domain name → website (got "${entities[0].website}")`);
}

// ── Test 6: "webpage" header ──
console.log('\nTest 6: "webpage" as website alias');
{
  const buf = csvBuf('brand,webpage', ['BarBrand,https://bar.com']);
  const { entities } = await parseSeedFile(buf, null, 'test.csv');
  assert(entities[0].name === 'BarBrand', `brand → name (got "${entities[0].name}")`);
  assert(entities[0].website === 'https://bar.com', `webpage → website (got "${entities[0].website}")`);
}

// ── Test 7: "operator" + "homepage" ──
console.log('\nTest 7: "operator" + "homepage"');
{
  const buf = csvBuf('operator,homepage', ['BetOp,https://betop.com']);
  const { entities } = await parseSeedFile(buf, null, 'test.csv');
  assert(entities[0].name === 'BetOp', `operator → name (got "${entities[0].name}")`);
  assert(entities[0].website === 'https://betop.com', `homepage → website (got "${entities[0].website}")`);
}

// ── Test 8: YouTube and LinkedIn aliases ──
console.log('\nTest 8: YouTube ("yt") and LinkedIn ("li") shorthand');
{
  const buf = csvBuf('name,yt,li', ['TestCo,https://youtube.com/c/test,https://linkedin.com/company/test']);
  const { entities } = await parseSeedFile(buf, null, 'test.csv');
  assert(entities[0].youtube === 'https://youtube.com/c/test', `yt → youtube (got "${entities[0].youtube}")`);
  assert(entities[0].linkedin === 'https://linkedin.com/company/test', `li → linkedin (got "${entities[0].linkedin}")`);
}

// ── Test 9: No "website" column but has "name" — no false alias ──
console.log('\nTest 9: Canonical "name" + "website" headers pass through unchanged');
{
  const buf = csvBuf('name,website', ['Direct,https://direct.com']);
  const { entities } = await parseSeedFile(buf, null, 'test.csv');
  assert(entities[0].name === 'Direct', `canonical name preserved`);
  assert(entities[0].website === 'https://direct.com', `canonical website preserved`);
}

// ── Test 10: Name derived from website when missing ──
console.log('\nTest 10: Name auto-derived from website when no name column');
{
  const buf = csvBuf('url', ['https://www.coolsite.com', 'https://another.io']);
  const { entities } = await parseSeedFile(buf, null, 'test.csv');
  assert(entities[0].name === 'Coolsite', `name derived from hostname (got "${entities[0].name}")`);
  assert(entities[0].website === 'https://www.coolsite.com', `url → website (got "${entities[0].website}")`);
}

// ── Test 11: Both alias maps in sync ──
console.log('\nTest 11: stepContext.js and seedParser.js alias maps are in sync');
{
  // Import stepContext aliases by reading the file (can't import Express router)
  const fs = await import('fs');
  const path = await import('path');
  const stepCtxPath = path.default.join(import.meta.dirname, '..', 'routes', 'stepContext.js');
  const stepCtxSrc = fs.default.readFileSync(stepCtxPath, 'utf-8');

  // Extract alias keys from stepContext.js source
  const aliasBlock = stepCtxSrc.match(/const COLUMN_ALIASES = \{([\s\S]*?)\};/)?.[1] || '';
  const stepKeys = [...aliasBlock.matchAll(/'([^']+)':\s*'/g)].map(m => m[1]);

  // Compare with seedParser keys
  const seedKeys = Object.keys(SEED_COLUMN_ALIASES);

  const missingInSeed = stepKeys.filter(k => !seedKeys.includes(k));
  const missingInStep = seedKeys.filter(k => !stepKeys.includes(k));

  assert(missingInSeed.length === 0, `All stepContext aliases exist in seedParser${missingInSeed.length ? ` (missing: ${missingInSeed.join(', ')})` : ''}`);
  assert(missingInStep.length === 0, `All seedParser aliases exist in stepContext${missingInStep.length ? ` (missing: ${missingInStep.join(', ')})` : ''}`);
}

// ── Summary ──
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
