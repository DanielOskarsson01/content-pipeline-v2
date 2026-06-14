/**
 * Tests for deriveEntityRunStatus — un-masks per-entity submodule failures.
 *
 * Run: node server/tests/entityRunStatus.test.mjs   (from content-pipeline-v2/)
 *
 * Background: stageWorker wrote entity_submodule_runs.status = 'completed'
 * whenever execute() RETURNED without throwing. But content-writer / seo-planner
 * / content-analyzer signal a per-entity failure by RETURNING an error result
 * (meta.status==='error'), not by throwing — so failures were labeled 'completed'
 * ("N completed, 0 failed") and the auto-executor's failure-rate threshold never
 * counted them. This helper distinguishes a real submodule failure from a valid
 * QA verdict (qa_pass:false is NOT a failure) so the worker can mark 'failed'.
 */

import { deriveEntityRunStatus } from '../utils/entityRunStatus.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  PASS: ${msg}`); pass++; }
  else { console.log(`  FAIL: ${msg}`); fail++; }
}

// --- real submodule failures (the masked cases) → 'failed' ---
console.log('\n=== submodule failures → failed (un-masked) ===');
{
  // content-writer fetch-fail / seo-planner parse-fail shape
  const r = { entity_name: 'Wazdan', items: [{ entity_name: 'Wazdan', status: 'error', error: 'content writing failed — fetch failed', content_markdown: '' }], meta: { status: 'error' } };
  const d = deriveEntityRunStatus(r);
  assert(d.status === 'failed', 'meta.status==="error" → failed');
  assert(/fetch failed/.test(d.error), 'captures the item error message');
}
{
  // error item without meta.status set, but all items error
  const r = { items: [{ status: 'error', error: 'boom' }] };
  const d = deriveEntityRunStatus(r);
  assert(d.status === 'failed', 'all items status==="error" → failed (secondary signal)');
}

// --- valid QA verdicts → 'completed' (MUST NOT be flagged failed) ---
console.log('\n=== QA verdicts → completed (not failed) ===');
{
  // keyword-sufficiency / citation / hallucination: qa_pass:false is a VALID result
  const r = { entity_name: 'X', items: [{ entity_name: 'X', qa_pass: false, keyword_score: 0, error: 'empty_keyword_plan' }], meta: { qa_pass: false, keyword_score: 0, error: 'empty_keyword_plan' } };
  const d = deriveEntityRunStatus(r);
  assert(d.status === 'completed', 'qa_pass:false (meta has error but status!=="error") → completed, NOT failed');
}
{
  // QA pass
  const r = { items: [{ qa_pass: true, keyword_score: 0.9 }], meta: { qa_pass: true } };
  assert(deriveEntityRunStatus(r).status === 'completed', 'qa_pass:true → completed');
}

// --- normal success / skip → 'completed' ---
console.log('\n=== success / skip → completed ===');
{
  const r = { items: [{ status: 'written', word_count: 6744 }], meta: { status: 'success', word_count: 6744 } };
  assert(deriveEntityRunStatus(r).status === 'completed', 'generation success (meta.status==="success") → completed');
}
{
  const r = { items: [], meta: { status: 'skipped', pages_analyzed: 0 } };
  assert(deriveEntityRunStatus(r).status === 'completed', 'skip (no items, meta.status==="skipped") → completed (not failed)');
}
{
  // mixed items (one error, one ok) — do NOT over-fail; only ALL-error counts
  const r = { items: [{ status: 'error' }, { status: 'written' }], meta: { status: 'success' } };
  assert(deriveEntityRunStatus(r).status === 'completed', 'partial (not all items error, meta not error) → completed');
}

// --- defensive ---
console.log('\n=== defensive ===');
assert(deriveEntityRunStatus({ items: [] }).status === 'completed', 'empty items, no meta → completed');
assert(deriveEntityRunStatus(undefined).status === 'completed', 'undefined result → completed (no false failure)');

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
