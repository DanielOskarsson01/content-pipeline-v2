import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveBatchLoopIteration } from './loopIteration.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Regression: backward-routing Round-2 default-group submodules were stamped
// loop_iteration=0 instead of the entity's bumped loop_count, because
// submoduleRuns.js only loaded entity_run_meta `if (cardId)`. autoExecutor then
// waited for loop_iteration=1 → false 120s timeout → halt before the routed card
// ran. The loop_iteration of a batch is a property of the ENTITY's round, not of
// which card (or no card) targets it — so resolution must be card-AGNOSTIC.
// (Found 2026-06-27, sub-plan 4 task 2 mechanism test.)
// ─────────────────────────────────────────────────────────────────────────────

// --- core behavior: derive the entity's loop_count, regardless of card ---

test('Round-2 default-group entity (loop_count=1) is stamped loop_iteration=1', () => {
  // THE regression: default group (no card_id) after a backward route.
  const meta = new Map([['Acme', { loop_count: 1 }]]);
  assert.equal(resolveBatchLoopIteration([{ entity_name: 'Acme' }], meta), 1);
});

test('Round-1 entity (loop_count=0) → 0 (no change to the forward path)', () => {
  const meta = new Map([['Acme', { loop_count: 0 }]]);
  assert.equal(resolveBatchLoopIteration([{ entity_name: 'Acme' }], meta), 0);
});

test('Round-3 entity (loop_count=2) → 2', () => {
  const meta = new Map([['Acme', { loop_count: 2 }]]);
  assert.equal(resolveBatchLoopIteration([{ entity_name: 'Acme' }], meta), 2);
});

// --- defensive guards (match the old inline IIFE semantics) ---

test('entity missing from meta → 0', () => {
  assert.equal(resolveBatchLoopIteration([{ entity_name: 'Ghost' }], new Map()), 0);
});

test('empty entities → 0', () => {
  assert.equal(resolveBatchLoopIteration([], new Map([['Acme', { loop_count: 5 }]])), 0);
});

test('non-array / null entities → 0', () => {
  assert.equal(resolveBatchLoopIteration(null, new Map()), 0);
  assert.equal(resolveBatchLoopIteration(undefined, new Map()), 0);
});

test('null meta map → 0 (no throw)', () => {
  assert.equal(resolveBatchLoopIteration([{ entity_name: 'Acme' }], null), 0);
});

test('mixed loop_counts → first entity wins (matches batch-level pick)', () => {
  const meta = new Map([['A', { loop_count: 1 }], ['B', { loop_count: 0 }]]);
  assert.equal(resolveBatchLoopIteration([{ entity_name: 'A' }, { entity_name: 'B' }], meta), 1);
});

test('loop_count of 0 is preserved (not coerced via a falsy default bug)', () => {
  const meta = new Map([['A', { loop_count: 0 }]]);
  assert.equal(resolveBatchLoopIteration([{ entity_name: 'A' }], meta), 0);
});

// --- structural guard: submoduleRuns.js must load entity_run_meta for ALL
//     groups (the load must NOT be gated on cardId) and use the helper, so the
//     fix can't silently rot back to the cardId-gated load. ---

test('submoduleRuns.js loads entity_run_meta loop metadata UNCONDITIONALLY (not if(cardId))', () => {
  const src = readFileSync(join(__dirname, '../routes/submoduleRuns.js'), 'utf8');

  // the buggy structure: the loop-metadata select wrapped in `if (cardId) {`
  assert.doesNotMatch(
    src,
    /if\s*\(\s*cardId\s*\)\s*\{\s*const\s*\{\s*data:\s*entityMeta\s*\}/,
    'entity_run_meta loop-metadata load must NOT be gated on cardId',
  );
  // the load itself must still be present (selecting loop_count + card_instructions)
  assert.match(
    src,
    /from\('entity_run_meta'\)\s*\.select\('entity_name,\s*loop_count,\s*card_instructions'\)/,
    'submoduleRuns must still load loop_count + card_instructions from entity_run_meta',
  );
});

test('submoduleRuns.js imports and uses resolveBatchLoopIteration for batch loop_iteration', () => {
  const src = readFileSync(join(__dirname, '../routes/submoduleRuns.js'), 'utf8');
  assert.match(
    src,
    /import\s*\{\s*resolveBatchLoopIteration\s*\}\s*from\s*['"]\.\.\/utils\/loopIteration\.js['"]/,
    'submoduleRuns must import resolveBatchLoopIteration',
  );
  assert.match(
    src,
    /resolveBatchLoopIteration\(\s*entities\s*,\s*metaMap\s*\)/,
    'submoduleRuns must compute batchLoopIteration via the helper',
  );
});
