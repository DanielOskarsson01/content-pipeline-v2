// mergeCardWorkFromSourcePlan — the from-run "item 3" fix.
// The from-run handler (templates.js) rebuilds submodules_per_step from run_submodule_config
// (submodule-id STRINGS) and DROPPED everything else from the source template's execution_plan.
// This pure helper carries the card work + the also-dropped structural fields back in, reconciles
// card placements, and gates the result through the same §9 validator as PUT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCardWorkFromSourcePlan } from './executionPlanUtils.js';

const W = 'c9d0e1f2-a3b4-5678-cdef-901234567890'; // content-writer card (step 5, has round 2)
const P = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'; // pse card (step 1, round-1 only)
const DANGLING = 'deadbeef-0000-4000-8000-000000000001'; // UUID in source sps but NOT in card_definitions
const REGISTERED = new Set(['content-writer', 'google-pse-curated-search', 'sitemap-parser', 'page-links']);
const opts = { isRegisteredSubmodule: (id) => REGISTERED.has(id) };

function sourcePlan() {
  return {
    cards: { 'legacy-x': { submodule_id: 'content-writer', step: 5, options_overrides: {} } }, // legacy — must NOT be carried
    card_definitions: {
      [W]: { card_name: 'content-writer-v2', submodule_id: 'content-writer', step: 5, rounds: { '1': {}, '2': { temperature: 0.3 } } },
      [P]: { card_name: 'pse-directories', submodule_id: 'google-pse-curated-search', step: 1, rounds: { '1': { curated_list: 'directories' } } },
    },
    routing_rules: { 'citation:fail': [{ step: 5, card_id: W }] },
    escalation_rules: { '2': { volume_threshold: 10, fail_threshold: 3, escalation_submodules: [] } },
    skip_steps: [3],
    failure_thresholds: { '6': 0.2 },
    submodules_per_step: { '1': [P, 'sitemap-parser', DANGLING], '5': [W] },
  };
}
// From-run rebuild (strings only, B046-ordered) + an unknown key to prove passthrough.
function targetPlan() {
  return { submodules_per_step: { '1': ['sitemap-parser', 'page-links'], '5': ['content-writer'] }, extra_target_key: { z: 1 } };
}

test('carries card work + the also-dropped structural fields from source', () => {
  const { executionPlan } = mergeCardWorkFromSourcePlan(targetPlan(), sourcePlan(), opts);
  assert.deepEqual(executionPlan.card_definitions, sourcePlan().card_definitions);
  assert.deepEqual(executionPlan.routing_rules, { 'citation:fail': [{ step: 5, card_id: W }] });
  assert.deepEqual(executionPlan.escalation_rules, { '2': { volume_threshold: 10, fail_threshold: 3, escalation_submodules: [] } });
  assert.deepEqual(executionPlan.skip_steps, [3]);
  assert.deepEqual(executionPlan.failure_thresholds, { '6': 0.2 });
});

test('never re-emits the legacy `cards` key', () => {
  const { executionPlan } = mergeCardWorkFromSourcePlan(targetPlan(), sourcePlan(), opts);
  assert.equal('cards' in executionPlan, false);
});

test('passes unknown target keys through untouched', () => {
  const { executionPlan } = mergeCardWorkFromSourcePlan(targetPlan(), sourcePlan(), opts);
  assert.deepEqual(executionPlan.extra_target_key, { z: 1 });
});

test('keeps placed card UUIDs in running order; drops dangling UUIDs; B046 order for non-card entries', () => {
  const { executionPlan } = mergeCardWorkFromSourcePlan(targetPlan(), sourcePlan(), opts);
  // step 1: P (placed card, source order) → sitemap-parser (source+target) → page-links (new target string). DANGLING dropped.
  assert.deepEqual(executionPlan.submodules_per_step['1'], [P, 'sitemap-parser', 'page-links']);
  // step 5: W restored; the redundant 'content-writer' string (== W's submodule_id) is NOT double-emitted.
  assert.deepEqual(executionPlan.submodules_per_step['5'], [W]);
});

test('does not mutate its inputs (pure)', () => {
  const t = targetPlan(), s = sourcePlan();
  const tSnap = structuredClone(t), sSnap = structuredClone(s);
  mergeCardWorkFromSourcePlan(t, s, opts);
  assert.deepEqual(t, tSnap);
  assert.deepEqual(s, sSnap);
});

test('carried fields are deep-copied — mutating the output cannot corrupt the source plan', () => {
  const s = sourcePlan();
  const { executionPlan } = mergeCardWorkFromSourcePlan(targetPlan(), s, opts);
  executionPlan.skip_steps.push(99);
  executionPlan.card_definitions[W].rounds['2'].temperature = 999;
  assert.deepEqual(s.skip_steps, [3]);                               // source unchanged
  assert.equal(s.card_definitions[W].rounds['2'].temperature, 0.3);  // source unchanged
});

test('gates the merged output through §9 — valid source → no errors', () => {
  const { errors } = mergeCardWorkFromSourcePlan(targetPlan(), sourcePlan(), opts);
  assert.deepEqual(errors, []);
});

test('gates the merged output through §9 — invalid card work surfaces errors (rule 11)', () => {
  const s = sourcePlan();
  // route to P which is round-1-only → §9 rule 11 violation must surface in the merged output
  s.routing_rules = { 'keyword:fail': [{ step: 1, card_id: P }] };
  const { errors } = mergeCardWorkFromSourcePlan(targetPlan(), s, opts);
  assert.ok(errors.some((e) => /no round > 1/i.test(e)), `expected rule-11 error, got: ${errors.join(' | ')}`);
});

test('no source card work → target passed through unchanged (only submodules_per_step)', () => {
  const t = { submodules_per_step: { '1': ['sitemap-parser'] } };
  const { executionPlan, errors } = mergeCardWorkFromSourcePlan(t, { submodules_per_step: { '1': ['sitemap-parser'] } }, opts);
  assert.equal('card_definitions' in executionPlan, false);
  assert.equal('cards' in executionPlan, false);
  assert.deepEqual(executionPlan.submodules_per_step['1'], ['sitemap-parser']);
  assert.deepEqual(errors, []);
});
