// Card save-path validation (PHASE_3B §9 acceptance table).
// validateExecutionPlan(plan, { isRegisteredSubmodule }) -> { errors, warnings }
// Pure + dependency-injected registry so it's testable and pipeline-agnostic
// (Rule 13: structural validation only, zero content-type assumptions).
//
// Rules under test (all HTTP 400 / errors[]):
//   1 card_id valid UUID                                   (§9 L1040)
//   2 submodule_id present + registered                    (§1.2 L77)
//   3 step present + integer                               (§1.2 L78)
//   4 rounds present + object                              (§1.2 L79)
//   5 round "1" always present                             (§9 L1035)
//   6 round keys must be integers 1-4                      (§9 L1034)
//   7 MAX_ROUNDS_PER_CARD = 4                              (§9 L1033)
//   8 every UUID entry in submodules_per_step ∈ card_defs  (§9 L1038)
//   9 card.step matches its submodules_per_step placement  (§9 L1041)
//  10 every routing_rules card_id ∈ card_definitions       (§9 L1036)
//  11 every routing_rules card has a round > 1             (§9 L1037 / §2.1 L250)
// DEFERRED: QA-check-name → manifest qa_outputs (§2.2, Warning) — 0 manifests declare
//           qa_outputs yet (§6.6 not built); validator returns it in warnings[] when buildable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExecutionPlan } from '../services/executionPlanUtils.js';

const U = {
  a: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  b: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  w: 'c9d0e1f2-a3b4-5678-cdef-901234567890',
};
const REGISTERED = new Set(['google-pse-curated-search', 'sitemap-parser', 'content-writer']);
const isRegisteredSubmodule = (id) => REGISTERED.has(id);
const opts = { isRegisteredSubmodule };

function validPlan() {
  return {
    submodules_per_step: {
      '1': [U.a, 'sitemap-parser'],          // a card + a legacy string entry
      '2': ['url-dedup'],                     // legacy entries untouched
      '5': [U.w],
    },
    card_definitions: {
      [U.a]: { card_name: 'pse-directories', submodule_id: 'google-pse-curated-search', step: 1, rounds: { '1': { curated_list: 'directories' } } },
      [U.w]: { card_name: 'content-writer', submodule_id: 'content-writer', step: 5, rounds: { '1': {}, '2': { temperature: 0.3 } } },
    },
    routing_rules: {
      'hallucination:fail': [{ step: 5, card_id: U.w }],
    },
  };
}

const errs = (plan) => validateExecutionPlan(plan, opts).errors;

test('valid new-format plan → no errors', () => {
  assert.deepEqual(errs(validPlan()), []);
});

test('legacy plan (no card_definitions, kebab entries) → no errors', () => {
  assert.deepEqual(errs({ submodules_per_step: { '1': ['sitemap-parser', 'url-dedup'], '2': ['url-filter'] } }), []);
});

test('null / empty execution_plan → no errors', () => {
  assert.deepEqual(validateExecutionPlan(null, opts).errors, []);
  assert.deepEqual(validateExecutionPlan(undefined, opts).errors, []);
  assert.deepEqual(validateExecutionPlan({}, opts).errors, []);
});

test('rule 1: non-UUID card_id key → error', () => {
  const p = validPlan();
  p.card_definitions['not-a-uuid'] = { card_name: 'x', submodule_id: 'sitemap-parser', step: 1, rounds: { '1': {} } };
  assert.ok(errs(p).some((e) => /not a valid UUID/i.test(e)));
});

test('rule 2: unregistered submodule_id → error', () => {
  const p = validPlan();
  p.card_definitions[U.a].submodule_id = 'ghost-module';
  assert.ok(errs(p).some((e) => /not a registered submodule/i.test(e)));
});

test('rule 2: missing submodule_id → error', () => {
  const p = validPlan();
  delete p.card_definitions[U.a].submodule_id;
  assert.ok(errs(p).some((e) => /submodule_id is required/i.test(e)));
});

test('rule 3: non-integer / missing step → error', () => {
  const p = validPlan();
  delete p.card_definitions[U.a].step;
  assert.ok(errs(p).some((e) => /step is required/i.test(e)));
});

test('rule 4: rounds not an object → error', () => {
  const p = validPlan();
  p.card_definitions[U.a].rounds = 'nope';
  assert.ok(errs(p).some((e) => /rounds is required/i.test(e)));
});

test('rule 5: missing round "1" → error', () => {
  const p = validPlan();
  p.card_definitions[U.w].rounds = { '2': { temperature: 0.3 } };
  assert.ok(errs(p).some((e) => /round "1" must always be present/i.test(e)));
});

test('rule 6: round key outside 1-4 → error', () => {
  const p = validPlan();
  p.card_definitions[U.w].rounds = { '1': {}, '5': {} };
  assert.ok(errs(p).some((e) => /round keys must be integers 1-4/i.test(e)));
});

test('rule 7: more than 4 rounds → error', () => {
  const p = validPlan();
  p.card_definitions[U.w].rounds = { '1': {}, '2': {}, '3': {}, '4': {}, '5': {} };
  const e = errs(p);
  assert.ok(e.some((x) => /MAX_ROUNDS_PER_CARD=4/i.test(x)) || e.some((x) => /round keys must be integers 1-4/i.test(x)));
});

test('rule 8: UUID entry in submodules_per_step not in card_definitions → error', () => {
  const p = validPlan();
  p.submodules_per_step['1'].push(U.b); // U.b has no card definition
  assert.ok(errs(p).some((e) => new RegExp(`${U.b}.*not found in card_definitions`, 'i').test(e)));
});

test('rule 9: card.step mismatched vs placement step → error', () => {
  const p = validPlan();
  p.card_definitions[U.a].step = 3; // placed under step "1"
  assert.ok(errs(p).some((e) => /does not match placement step/i.test(e)));
});

test('rule 10: routing_rules card_id not in card_definitions → error', () => {
  const p = validPlan();
  p.routing_rules['keyword:fail'] = [{ step: 5, card_id: U.b }];
  assert.ok(errs(p).some((e) => new RegExp(`${U.b}.*not found in card_definitions`, 'i').test(e)));
});

test('rule 11: routing_rules card with no round > 1 → error', () => {
  const p = validPlan();
  // U.a is round-1-only; routing to it can never escalate
  p.routing_rules['keyword:fail'] = [{ step: 1, card_id: U.a }];
  assert.ok(errs(p).some((e) => /no round > 1/i.test(e)));
});

test('hardening: card_definitions present but not a plain object → error', () => {
  assert.ok(errs({ card_definitions: [{ junk: true }] }).some((e) => /card_definitions must be an object/i.test(e)));
  assert.ok(errs({ card_definitions: 'nope' }).some((e) => /card_definitions must be an object/i.test(e)));
});

test('hardening: a round override value that is not an object → error', () => {
  const p = validPlan();
  p.card_definitions[U.w].rounds = { '1': {}, '2': 'stricter rules' };
  assert.ok(errs(p).some((e) => /round "2" overrides must be an object/i.test(e)));
});

test('hardening: routing target missing card_id → error', () => {
  const p = validPlan();
  p.routing_rules['keyword:fail'] = [{ step: 5 }];
  assert.ok(errs(p).some((e) => /target is missing card_id/i.test(e)));
});

test('multiple violations are all reported (not just the first)', () => {
  const p = validPlan();
  p.card_definitions[U.a].submodule_id = 'ghost-module';
  p.card_definitions[U.w].rounds = { '2': {} }; // missing round 1
  const e = errs(p);
  assert.ok(e.length >= 2, `expected ≥2 errors, got ${e.length}: ${e.join(' | ')}`);
});

test('works without an injected registry (skips only the registration check)', () => {
  const p = validPlan();
  p.card_definitions[U.a].submodule_id = 'anything-goes';
  // No isRegisteredSubmodule → registration not checked, other rules still apply
  assert.deepEqual(validateExecutionPlan(p, {}).errors, []);
});

// Structural guard: both template save handlers must call the validator and reject
// with HTTP 400 before persisting (the fail-loud-before-UI contract).
test('templates.js save path wires validateExecutionPlan into both handlers with a 400', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'routes', 'templates.js'), 'utf8');
  assert.match(src, /import\s*\{\s*validateExecutionPlan\s*\}/, 'must import validateExecutionPlan');
  const calls = src.match(/validateExecutionPlan\(/g) || [];
  assert.ok(calls.length >= 2, `expected ≥2 validateExecutionPlan calls (POST + PUT), got ${calls.length}`);
  assert.match(src, /status\(400\)[\s\S]*Invalid execution_plan/, 'must 400 with "Invalid execution_plan" on errors');
});
