#!/usr/bin/env node
/**
 * Phase 12b migration: Populate templates.preset_map from template_preset_mappings bridge table.
 *
 * For each template, reads its bridge table mappings (joined with option_presets),
 * builds the JSONB preset_map, and UPDATEs the template row.
 *
 * Run: node scripts/migrate-template-preset-map.js [--dry-run]
 *
 * Prerequisites:
 *   - ALTER TABLE templates ADD COLUMN preset_map JSONB DEFAULT '{}'::jsonb;
 *   - ALTER TABLE templates ADD COLUMN execution_plan JSONB DEFAULT '{}'::jsonb;
 *   - ALTER TABLE templates ADD COLUMN seed_config JSONB DEFAULT '{"seed_type":"csv"}'::jsonb;
 *   - ALTER TABLE projects ADD COLUMN mode TEXT DEFAULT 'single_run';
 */

import { createClient } from '@supabase/supabase-js';

const DRY_RUN = process.argv.includes('--dry-run');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY environment variables');
  process.exit(1);
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function main() {
  // 1. Fetch all templates
  const { data: templates, error: tErr } = await db
    .from('templates')
    .select('id, name, preset_map')
    .order('name');

  if (tErr) { console.error('Failed to fetch templates:', tErr); process.exit(1); }
  if (!templates || templates.length === 0) {
    console.log('No templates found. Nothing to migrate.');
    return;
  }

  console.log(`Found ${templates.length} template(s) to process\n`);

  // 2. Fetch all bridge table mappings with joined preset data
  const { data: mappings, error: mErr } = await db
    .from('template_preset_mappings')
    .select('template_id, submodule_id, option_name, preset_id, option_presets(preset_name, preset_value)');

  if (mErr) { console.error('Failed to fetch mappings:', mErr); process.exit(1); }
  console.log(`Found ${(mappings || []).length} bridge table mapping(s)\n`);

  // Group mappings by template_id
  const byTemplate = new Map();
  for (const m of (mappings || [])) {
    if (!byTemplate.has(m.template_id)) byTemplate.set(m.template_id, []);
    byTemplate.get(m.template_id).push(m);
  }

  let updated = 0;
  let skipped = 0;

  for (const template of templates) {
    const existing = template.preset_map || {};
    if (Object.keys(existing).length > 0) {
      console.log(`  SKIP  ${template.name} — preset_map already populated (${Object.keys(existing).length} entries)`);
      skipped++;
      continue;
    }

    const tmMappings = byTemplate.get(template.id) || [];
    if (tmMappings.length === 0) {
      console.log(`  SKIP  ${template.name} — no bridge table mappings`);
      skipped++;
      continue;
    }

    // Build preset_map JSONB
    const presetMap = {};
    for (const m of tmMappings) {
      const preset = m.option_presets;
      if (!preset) continue;

      if (!presetMap[m.submodule_id]) {
        presetMap[m.submodule_id] = {
          preset_name: preset.preset_name,
          fallback_values: {},
        };
      }
      presetMap[m.submodule_id].fallback_values[m.option_name] = preset.preset_value;
    }

    console.log(`  UPDATE  ${template.name} — ${Object.keys(presetMap).length} submodule(s): ${Object.keys(presetMap).join(', ')}`);

    if (!DRY_RUN) {
      const { error: uErr } = await db
        .from('templates')
        .update({ preset_map: presetMap, updated_at: new Date().toISOString() })
        .eq('id', template.id);

      if (uErr) {
        console.error(`    FAILED: ${uErr.message}`);
      }
    }
    updated++;
  }

  console.log(`\n--- Summary ${DRY_RUN ? '(DRY RUN)' : ''} ---`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
}

main().catch(e => { console.error(e); process.exit(1); });
