#!/usr/bin/env node
/**
 * Seed a global "Recommended" preset for url-filter.exclude_patterns.
 *
 * Idempotent: checks for existing preset by (submodule_id, option_name, preset_name)
 * where project_id IS NULL. Will NOT overwrite if user has already edited it.
 *
 * Run: node scripts/seed-url-filter-preset.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY environment variables');
  process.exit(1);
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const SUBMODULE_ID = 'url-filter';
const OPTION_NAME = 'exclude_patterns';
const PRESET_NAME = 'Recommended';

const PRESET_VALUE = [
  'facebook\\.com',
  'instagram\\.com',
  'twitter\\.com',
  'x\\.com/',
  'linkedin\\.com',
  'youtube\\.com',
  'tiktok\\.com',
  'pinterest\\.com',
  'glassdoor\\.com',
  '/wp-admin',
  '/wp-login',
  '/cart',
  '/checkout',
  '/login',
  '/register',
].join('\n');

async function main() {
  // Check if preset already exists (global, project_id IS NULL)
  const { data: existing, error: fetchErr } = await db
    .from('option_presets')
    .select('id')
    .eq('submodule_id', SUBMODULE_ID)
    .eq('option_name', OPTION_NAME)
    .eq('preset_name', PRESET_NAME)
    .is('project_id', null)
    .maybeSingle();

  if (fetchErr) {
    console.error('Failed to check for existing preset:', fetchErr.message);
    process.exit(1);
  }

  if (existing) {
    console.log('Recommended preset already exists, skipping');
    return;
  }

  const { error: insertErr } = await db
    .from('option_presets')
    .insert({
      submodule_id: SUBMODULE_ID,
      option_name: OPTION_NAME,
      preset_name: PRESET_NAME,
      preset_value: PRESET_VALUE,
      project_id: null,
      is_default: false,
    });

  if (insertErr) {
    console.error('Failed to create preset:', insertErr.message);
    process.exit(1);
  }

  console.log('Created Recommended preset for url-filter.exclude_patterns');
}

main().catch(e => { console.error(e); process.exit(1); });
