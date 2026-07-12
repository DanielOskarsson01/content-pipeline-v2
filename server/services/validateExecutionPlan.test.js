// Card save-path validation — v6 SCALAR-ROUND model (master-plan unit 2.4).
// validateExecutionPlan(plan, { isRegisteredSubmodule }) -> { errors, warnings }
// Pure + dependency-injected registry so it's testable and pipeline-agnostic
// (structural validation only, zero content-type assumptions).
//
// v6 reshape (V6-§1.2, DECISION_CARD_MODEL_V6 §5): the per-round `rounds` MAP is dropped;
// a card carries a SCALAR `round` + FLAT `overrides`. Multiple cards sharing (submodule,step)
// — one per round — is the VALID shape (D8). Rules under test:
//   1  card_id valid UUID
//   2  submodule_id present + registered
//   3  step present + integer
//   4  round present + integer ≥ 1           (was: rounds present + object)
//   4b overrides (if present) is a plain object
//   6  round ≤ MAX_ROUNDS (4)                (scalar bound; rule 7 map-bound DELETED)
//   8  every UUID entry in submodules_per_step ∈ card_definitions
//   9  card.step matches its submodules_per_step placement
//  10  every routing_rules card_id ∈ card_definitions
//  11  every routing_rules-referenced card has round > 1
//  12/13 legacy `cards` / object-form routing_rules rejected (unchanged)
//  GROUP RULE (D7/D8, Q3 option (e)): per (submodule,step) group — retry rounds (round>1) UNIQUE;
//    Round-1 clones (round===1) ALLOWED; a PLACED group must be contiguous FROM 1 (round 1
//    present, no gap); a ROUTING-ONLY group MAY START AT ROUND 2 (option (e)) — interior gaps
//    there are NOT author-time errors (they hit the V6-§3 run-time flag-and-continue terminus).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExecutionPlan } from '../services/executionPlanUtils.js';

const U = {
  a: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  b: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  w: 'c9d0e1f2-a3b4-5678-cdef-901234567890',   // content-writer, round 1, placed @5
  w2: 'd0e1f2a3-b4c5-6789-def0-123456789abc',  // content-writer-v2, round 2, routing-only
  w3: 'e1f2a3b4-c5d6-7890-ef01-23456789abcd',  // content-writer-v3, round 3, routing-only
};
const REGISTERED = new Set(['google-pse-curated-search', 'sitemap-parser', 'content-writer']);
const isRegisteredSubmodule = (id) => REGISTERED.has(id);
const opts = { isRegisteredSubmodule };

// A canonical v6 scalar plan: two placed Round-1 cards + one routing-only Round-2 escalation.
function validPlan() {
  return {
    submodules_per_step: {
      '1': [U.a, 'sitemap-parser'],          // a Round-1 card + a legacy string entry (mixed allowed)
      '2': ['url-dedup'],                     // legacy entries untouched
      '5': [U.w],                             // Round-1 content-writer placed
    },
    card_definitions: {
      [U.a]:  { card_name: 'pse-directories',  submodule_id: 'google-pse-curated-search', step: 1, round: 1, overrides: { curated_list: 'directories' } },
      [U.w]:  { card_name: 'content-writer',   submodule_id: 'content-writer',            step: 5, round: 1, overrides: {} },
      [U.w2]: { card_name: 'content-writer-v2', submodule_id: 'content-writer',           step: 5, round: 2, overrides: { temperature: 0.3 } }, // routing-only
    },
    routing_rules: {
      'hallucination:fail': [{ step: 5, card_id: U.w2 }],  // escalate to the Round-2 different-config card
    },
  };
}

const errs = (plan) => validateExecutionPlan(plan, opts).errors;

test('valid v6 scalar plan → no errors', () => {
  assert.deepEqual(errs(validPlan()), []);
});

test('null / empty execution_plan → no errors', () => {
  assert.deepEqual(validateExecutionPlan(null, opts).errors, []);
  assert.deepEqual(validateExecutionPlan(undefined, opts).errors, []);
  assert.deepEqual(validateExecutionPlan({}, opts).errors, []);
});

// ── the FIVE required 2.4 coverage cases ─────────────────────────────────────────
test('REQUIRED 1 — a routing-only round-2 card with NO round-1 sibling VALIDATES (rule 5 scoped to placed; option (e))', () => {
  // The (content-writer, step 5) group is ONLY the round-2 routing-only card — no round-1 sibling
  // anywhere. This isolates the (e) relaxation: rule 5 (round-1 presence) is scoped to PLACED groups.
  const p = {
    submodules_per_step: { '1': [U.a] },   // an unrelated placed round-1 card
    card_definitions: {
      [U.a]:  { card_name: 'pse',       submodule_id: 'google-pse-curated-search', step: 1, round: 1, overrides: {} },
      [U.w2]: { card_name: 'writer-v2', submodule_id: 'content-writer',            step: 5, round: 2, overrides: {} }, // routing-only, no round-1 sibling
    },
    routing_rules: { 'citation:fail': [{ step: 5, card_id: U.w2 }] },
  };
  assert.deepEqual(errs(p), [], `routing-only round-2 with no round-1 sibling must validate; got: ${errs(p).join(' | ')}`);
});

test('REQUIRED 2 — a PLACED card missing round 1 FAILS (contiguity-from-1 preserved for placed groups)', () => {
  const p = validPlan();
  p.card_definitions[U.w].round = 2; // now the placed content-writer group @5 = {round 2} only (no round 1)
  assert.ok(errs(p).some((e) => /must include round 1/i.test(e)),
    `expected placed-group round-1 requirement, got: ${errs(p).join(' | ')}`);
});

test('REQUIRED 3 — two Round-1 clones of the same submodule both validate as distinct cards (D8)', () => {
  const p = {
    submodules_per_step: { '5': [U.w, U.w2] },      // both placed at step 5, array order
    card_definitions: {
      [U.w]:  { card_name: 'writer-a', submodule_id: 'content-writer', step: 5, round: 1, overrides: { prompt: 'a' } },
      [U.w2]: { card_name: 'writer-b', submodule_id: 'content-writer', step: 5, round: 1, overrides: { prompt: 'b' } }, // second round-1 clone
    },
  };
  assert.deepEqual(errs(p), [], `two round-1 clones must validate; got: ${errs(p).join(' | ')}`);
});

test('REQUIRED 4a — a DUPLICATE retry round in a group errors', () => {
  const p = validPlan();
  // add a second round-2 card for the same (content-writer, step 5) group → duplicate retry round 2
  p.card_definitions[U.w3] = { card_name: 'dup-r2', submodule_id: 'content-writer', step: 5, round: 2, overrides: {} };
  p.routing_rules['tone:fail'] = [{ step: 5, card_id: U.w3 }];
  assert.ok(errs(p).some((e) => /duplicate retry round 2/i.test(e)),
    `expected duplicate-retry-round error, got: ${errs(p).join(' | ')}`);
});

test('REQUIRED 4b — a GAP in a PLACED group errors (round 1 then 3, no 2)', () => {
  const p = {
    submodules_per_step: { '5': [U.w] },                 // placed group
    card_definitions: {
      [U.w]:  { card_name: 'writer',    submodule_id: 'content-writer', step: 5, round: 1, overrides: {} },
      [U.w3]: { card_name: 'writer-v3', submodule_id: 'content-writer', step: 5, round: 3, overrides: {} }, // gap: no round 2
    },
    routing_rules: { 'citation:fail': [{ step: 5, card_id: U.w3 }] },
  };
  assert.ok(errs(p).some((e) => /contiguous from 1|gap before round 3/i.test(e)),
    `expected placed-group gap error, got: ${errs(p).join(' | ')}`);
});

test('REQUIRED 5 — a legacy card-less plan (kebab entries, no card_definitions) still validates clean', () => {
  assert.deepEqual(errs({ submodules_per_step: { '1': ['sitemap-parser', 'url-dedup'], '2': ['url-filter'] } }), []);
});

// A routing-only group MAY have an interior gap (V6-§3 terminus) — NOT an author-time error under (e).
test('option (e): a ROUTING-ONLY group gap is tolerated author-time (V6-§3 run-time terminus owns it)', () => {
  const p = {
    submodules_per_step: { '5': ['content-writer'] },     // legacy string; the group below is routing-only
    card_definitions: {
      [U.w2]: { card_name: 'v2', submodule_id: 'content-writer', step: 5, round: 2, overrides: {} },
      [U.w3]: { card_name: 'v4', submodule_id: 'content-writer', step: 5, round: 4, overrides: {} }, // gap 3, but routing-only
    },
    routing_rules: { 'citation:fail': [{ step: 5, card_id: U.w2 }, { step: 5, card_id: U.w3 }] },
  };
  assert.deepEqual(errs(p), [], `routing-only gap must not error author-time; got: ${errs(p).join(' | ')}`);
});

// ── per-card rules ───────────────────────────────────────────────────────────────
test('rule 1: non-UUID card_id key → error', () => {
  const p = validPlan();
  p.card_definitions['not-a-uuid'] = { card_name: 'x', submodule_id: 'sitemap-parser', step: 1, round: 1, overrides: {} };
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

test('rule 4 (scalar): round not an integer ≥ 1 → error', () => {
  const p = validPlan();
  p.card_definitions[U.a].round = '1';
  assert.ok(errs(p).some((e) => /round is required and must be an integer/i.test(e)));
  const p2 = validPlan();
  p2.card_definitions[U.a].round = 0;
  assert.ok(errs(p2).some((e) => /round is required and must be an integer/i.test(e)));
});

test('rule 6 (scalar bound): round above MAX_ROUNDS (4) → error', () => {
  const p = validPlan();
  p.card_definitions[U.w2].round = 5;
  assert.ok(errs(p).some((e) => /round must be ≤ 4/i.test(e)));
});

test('rule 4b: overrides present but not a plain object → error', () => {
  const p = validPlan();
  p.card_definitions[U.w2].overrides = 'stricter rules';
  assert.ok(errs(p).some((e) => /overrides must be an object/i.test(e)));
});

test('rule 4b: overrides is OPTIONAL (absent → no error)', () => {
  const p = validPlan();
  delete p.card_definitions[U.a].overrides;
  assert.deepEqual(errs(p), []);
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

test('rule 11 (scalar): routing target whose card has round not > 1 → error', () => {
  const p = validPlan();
  p.routing_rules['keyword:fail'] = [{ step: 1, card_id: U.a }]; // U.a is round 1
  assert.ok(errs(p).some((e) => /no round > 1/i.test(e)));
});

// ── legacy card-authoring shapes rejected (rules 12/13, unchanged) ────────────────
test('rule 12: legacy `cards` key → error', () => {
  assert.ok(errs({ cards: { 'writer-v2': { submodule_id: 'content-writer', step: 5 } } }).some((e) => /legacy `cards` key is not supported/i.test(e)));
});

test('rule 13: object-form routing_rules ({target_cards}) → error', () => {
  const p = { card_definitions: validPlan().card_definitions, routing_rules: { 'citation:fail': { target_cards: ['x'] } } };
  assert.ok(errs(p).some((e) => /must be an array of \{step, card_id\}/i.test(e)));
});

// ── hardening / structural ────────────────────────────────────────────────────────
test('hardening: card_definitions present but not a plain object → error', () => {
  assert.ok(errs({ card_definitions: [{ junk: true }] }).some((e) => /card_definitions must be an object/i.test(e)));
  assert.ok(errs({ card_definitions: 'nope' }).some((e) => /card_definitions must be an object/i.test(e)));
});

test('hardening: routing target missing card_id → error', () => {
  const p = validPlan();
  p.routing_rules['keyword:fail'] = [{ step: 5 }];
  assert.ok(errs(p).some((e) => /target is missing card_id/i.test(e)));
});

test('empty routing_rules ({} and empty target arrays) → no errors', () => {
  assert.deepEqual(errs({ routing_rules: {} }), []);
  assert.deepEqual(errs({ card_definitions: validPlan().card_definitions, submodules_per_step: validPlan().submodules_per_step, routing_rules: { 'citation:fail': [] } }), []);
});

test('multiple violations are all reported (not just the first)', () => {
  const p = validPlan();
  p.card_definitions[U.a].submodule_id = 'ghost-module';
  p.card_definitions[U.w].round = 2; // placed group @5 loses round 1
  const e = errs(p);
  assert.ok(e.length >= 2, `expected ≥2 errors, got ${e.length}: ${e.join(' | ')}`);
});

test('validator does NOT mutate the plan (handler stores it verbatim)', () => {
  const plan = validPlan();
  const before = structuredClone(plan);
  validateExecutionPlan(plan, opts);
  assert.deepEqual(plan, before);
});

test('works without an injected registry (skips only the registration check)', () => {
  const p = validPlan();
  p.card_definitions[U.a].submodule_id = 'anything-goes';
  assert.deepEqual(validateExecutionPlan(p, {}).errors, []);
});

// Structural guard: both template save handlers must call the validator and reject with 400.
test('templates.js save path wires validateExecutionPlan into both handlers with a 400', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'routes', 'templates.js'), 'utf8');
  assert.match(src, /import\s*\{[^}]*\bvalidateExecutionPlan\b[^}]*\}\s*from\s*['"][^'"]*executionPlanUtils/, 'must import validateExecutionPlan');
  const calls = src.match(/validateExecutionPlan\(/g) || [];
  assert.ok(calls.length >= 2, `expected ≥2 validateExecutionPlan calls (POST + PUT), got ${calls.length}`);
  assert.match(src, /status\(400\)[\s\S]*Invalid execution_plan/, 'must 400 with "Invalid execution_plan" on errors');
});
