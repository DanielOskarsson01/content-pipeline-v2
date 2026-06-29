// B052 — run_submodule_config onConflict must match the live unique index.
//
// The Multi-Card migration (376022d) replaced the plain (run_id, step_index,
// submodule_id) unique constraint with a COALESCE-EXPRESSION index on
// (run_id, step_index, submodule_id, COALESCE(card_id::text,'')). PostgREST's
// onConflict can only infer PLAIN-COLUMN indexes, so every supabase-js upsert
// that still passed the bare 'run_id,step_index,submodule_id' failed at runtime
// with "no unique or exclusion constraint matching the ON CONFLICT specification".
//
// Fix: a plain 4-column NULLS NOT DISTINCT index + the onConflict string
// 'run_id,step_index,submodule_id,card_id' at all three call sites.
//
// These are STRUCTURAL guards (source-text assertions) — the same pattern the
// repo already uses for stageWorker/entityRunStatus, because the fix is a
// config-string + DDL change with no natural pure-function seam. The runtime
// proof (a real upsert round-trip) is gated on applying the migration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');

// The three call sites that upsert run_submodule_config (B052 scope).
const CALL_SITES = [
  'routes/submoduleConfig.js',
  'routes/submoduleRuns.js',
  'routes/templates.js',
];

const BARE_3COL = "onConflict: 'run_id,step_index,submodule_id'";
const FIXED_4COL = "onConflict: 'run_id,step_index,submodule_id,card_id'";

for (const rel of CALL_SITES) {
  test(`${rel}: no run_submodule_config upsert uses the stale bare 3-column onConflict`, () => {
    const src = readFileSync(join(SERVER, rel), 'utf8');
    assert.ok(
      !src.includes(BARE_3COL),
      `${rel} still contains ${BARE_3COL} — PostgREST cannot infer the live COALESCE index with this string`
    );
  });

  test(`${rel}: run_submodule_config upsert uses the card-aware 4-column onConflict`, () => {
    const src = readFileSync(join(SERVER, rel), 'utf8');
    assert.ok(
      src.includes(FIXED_4COL),
      `${rel} must use ${FIXED_4COL} so both legacy (card_id NULL) and card rows resolve via one inferable index`
    );
  });
}

test('migration replaces the expression index with a plain NULLS NOT DISTINCT index', () => {
  const sql = readFileSync(join(SERVER, '..', 'sql', 'migration_b052_run_submodule_config_onconflict.sql'), 'utf8');
  // drops the old (expression) index by name
  assert.match(sql, /DROP INDEX IF EXISTS\s+run_submodule_config_run_step_sm_card_uniq/i, 'must drop the stale expression index');
  // recreates as a plain 4-column unique index
  assert.match(
    sql,
    /CREATE UNIQUE INDEX\s+run_submodule_config_run_step_sm_card_uniq\s+ON\s+run_submodule_config\s*\(\s*run_id\s*,\s*step_index\s*,\s*submodule_id\s*,\s*card_id\s*\)/i,
    'must create a plain 4-column unique index on (run_id, step_index, submodule_id, card_id)'
  );
  // NULLS NOT DISTINCT so legacy NULL card_id rows still dedupe on the other three
  assert.match(sql, /NULLS NOT DISTINCT/i, 'must declare NULLS NOT DISTINCT (PG15+; prod is 17.6)');
  // must NOT reintroduce a COALESCE expression (the thing PostgREST cannot infer)
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX[\s\S]*COALESCE/i, 'must not recreate a COALESCE expression index');
});
