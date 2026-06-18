import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { widenStepRange } from './stepRange.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- core behavior: widen when the route target is below the range ---

test('widens a clamped resume range down to the routing target', () => {
  // resumed run clamped to [7..10], route back to step 5
  assert.deepEqual(widenStepRange([7, 8, 9, 10], 5), [5, 6, 7, 8, 9, 10]);
});

test('widens all the way down to step 0', () => {
  assert.deepEqual(widenStepRange([7, 8, 9, 10], 0), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('widens by a single step', () => {
  assert.deepEqual(widenStepRange([7, 8, 9, 10], 6), [6, 7, 8, 9, 10]);
});

// --- no-op: target already within range (returns same reference) ---

test('no-op (same reference) when earliestStep equals min', () => {
  const steps = [5, 6, 7, 8, 9, 10];
  assert.equal(widenStepRange(steps, 5), steps);
});

test('no-op (same reference) when earliestStep is above min', () => {
  const steps = [5, 6, 7, 8, 9, 10];
  assert.equal(widenStepRange(steps, 7), steps);
});

test('non-paused full range is never widened (production no-op)', () => {
  const steps = Array.from({ length: 11 }, (_, i) => i); // [0..10]
  // any backward route target >= 0 is already in range
  assert.equal(widenStepRange(steps, 5), steps);
  assert.equal(widenStepRange(steps, 0), steps);
});

// --- defensive guards ---

test('null/undefined earliestStep is a no-op', () => {
  const steps = [7, 8, 9, 10];
  assert.equal(widenStepRange(steps, null), steps);
  assert.equal(widenStepRange(steps, undefined), steps);
});

test('empty or non-array steps returned unchanged', () => {
  const empty = [];
  assert.equal(widenStepRange(empty, 5), empty);
  assert.equal(widenStepRange(null, 5), null);
  assert.equal(widenStepRange(undefined, 5), undefined);
});

test('result is always contiguous ascending from earliestStep to max', () => {
  const out = widenStepRange([7, 8, 9, 10], 3);
  for (let i = 0; i < out.length; i++) assert.equal(out[i], 3 + i);
  assert.equal(out[out.length - 1], 10);
});

// --- structural guard: autoExecutor actually imports & calls the helper
//     inside the backward-routing branch (so the fix can't silently rot) ---

test('autoExecutor imports and calls widenStepRange in the routing branch', () => {
  const src = readFileSync(join(__dirname, '../services/autoExecutor.js'), 'utf8');
  assert.match(src, /import\s*\{\s*widenStepRange\s*\}\s*from\s*['"]\.\.\/utils\/stepRange\.js['"]/,
    'autoExecutor must import widenStepRange');
  assert.match(src, /widenStepRange\(config\.steps,\s*earliestStep\)/,
    'autoExecutor must widen config.steps by earliestStep on a backward route');
  // must run BEFORE the per_step_results cleanup so the cleanup covers the widened range
  const callIdx = src.indexOf('widenStepRange(config.steps, earliestStep)');
  const cleanupIdx = src.indexOf('state.steps_completed = state.steps_completed.filter(s => s < earliestStep)');
  assert.ok(callIdx > 0 && cleanupIdx > 0 && callIdx < cleanupIdx,
    'widenStepRange must be called before the steps_completed/per_step_results cleanup');
});
