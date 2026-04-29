#!/usr/bin/env node
/**
 * Seed a global "iGaming" preset for url-filter.exclude_patterns.
 *
 * Adds keyword-based URL patterns that match common iGaming page types
 * unlikely to contain company-level content (individual reviews, game pages,
 * bonus listings, complaints, etc.).
 *
 * Idempotent: will NOT overwrite if preset already exists.
 *
 * Run: node scripts/seed-igaming-preset.js
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
const PRESET_NAME = 'iGaming';

const PRESET_VALUE = [
  // --- Individual listing / review pages ---
  '/review/',
  '/reviews/',
  '-review$',
  '-review/',
  '/complaint',
  '/complaints/',

  // --- Bonus & promotion pages ---
  '/bonus',
  '/bonuses/',
  '/bonus-code',
  '/free-spins',
  '/no-deposit',
  '/welcome-bonus',
  '/promo/',
  '/promotions/',
  '/coupon',
  '/offer/',
  '/offers/',
  '/deal/',
  '/deals/',

  // --- Game / slot / provider listing pages ---
  '/slots/',
  '/slot/',
  '/games/',
  '/game/',
  '/roulette/',
  '/blackjack/',
  '/baccarat/',
  '/poker/',
  '/live-casino/',
  '/live-dealer/',
  '/table-games/',
  '/jackpot/',
  '/scratch-card',
  '/bingo/',
  '/lottery/',
  '/keno/',

  // --- Betting / odds pages ---
  '/odds/',
  '/betting-tips/',
  '/predictions/',
  '/picks/',
  '/bet-builder/',
  '/accumulator/',

  // --- Payment method pages ---
  '/payment/',
  '/payments/',
  '/deposit/',
  '/withdrawal/',
  '/payout/',
  '/banking/',

  // --- User account / transactional ---
  '/signup',
  '/sign-up',
  '/register',
  '/login',
  '/account/',
  '/my-account/',
  '/profile/',
  '/cart/',
  '/checkout/',

  // --- Legal / boilerplate ---
  '/terms-and-conditions',
  '/terms-of-service',
  '/privacy-policy',
  '/cookie-policy',
  '/responsible-gaming',
  '/responsible-gambling',
  '/self-exclusion',
  '/gdpr',
  '/aml-policy',
  '/kyc',

  // --- Social media domains ---
  'facebook\\.com',
  'instagram\\.com',
  'twitter\\.com',
  'x\\.com/',
  'linkedin\\.com',
  'youtube\\.com',
  'tiktok\\.com',
  'pinterest\\.com',

  // --- Forum / community noise ---
  '/forum/',
  '/forums/',
  '/thread/',
  '/topic/',
  '/community/',

  // --- CMS / admin ---
  '/wp-admin',
  '/wp-login',
  '/wp-content/',
  '/wp-json/',
  '/feed/',
  '/tag/',
  '/author/',
  '/page/\\d+',
].join('\n');

async function main() {
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
    console.log('iGaming preset already exists, skipping');
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

  console.log('Created iGaming preset for url-filter.exclude_patterns');
}

main().catch(e => { console.error(e); process.exit(1); });
