// Card-write Step 1 — round-trip + 400 integration test (PHASE_3B card save path).
//
// Proves the REAL save path's decision for a corrected-shape execution_plan:
//   PUT /api/templates/:id  ->  validateExecutionPlan(execution_plan)  ->  if errors: 400
//                                                                          else: upsert JSONB verbatim
// validateExecutionPlan is the EXACT gate both the POST and PUT handlers call before
// persisting (templates.js), so testing it deterministically covers the persist/400
// decision with zero DB. The handler assigns `req.body.execution_plan` VERBATIM to the
// upsert (updates.execution_plan = req.body.execution_plan), and the validator never
// mutates the plan — together that is the "persists and reads back intact" property at
// the code layer. (A real Postgres JSONB round-trip is verified out-of-band against the
// live DB; the handler itself is not offline-unit-testable — it statically imports the
// db.js singleton with no injection point.)
//
// ALSO closes the gap the three reviews surfaced: the validator previously passed the
// LEGACY card-authoring shapes the dead CardsSection/RoutingRulesSection emit
// (`cards` string-keyed, `routing_rules` {target_cards} object form) with ZERO errors —
// so "the gate" did not gate what the UI produced. The corrected validator rejects them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateExecutionPlan } from './executionPlanUtils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const U = {
  pse: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  writer: 'c9d0e1f2-a3b4-5678-cdef-901234567890',   // Round-1 content-writer, placed @5
  writer2: 'd0e1f2a3-b4c5-6789-def0-123456789abc',  // Round-2 content-writer, routing-only escalation
  ghost: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
};
const REGISTERED = new Set(['google-pse-curated-search', 'content-writer', 'sitemap-parser', 'url-dedup']);
const opts = { isRegisteredSubmodule: (id) => REGISTERED.has(id) };
const errs = (plan) => validateExecutionPlan(plan, opts).errors;

// A correctly-shaped v6 card plan — canonical runtime shape (card_definitions UUID-keyed, SCALAR
// `round` + flat `overrides`, array-form routing_rules). Exactly what cardPlanEditor.ts builds and
// api.updateTemplate PUTs: a placed Round-1 card + a routing-only Round-2 escalation card.
function correctedPlan() {
  return {
    submodules_per_step: {
      '1': [U.pse, 'sitemap-parser'], // a Round-1 card UUID + a legacy string entry (mixed is allowed)
      '2': ['url-dedup'],
      '5': [U.writer],
    },
    card_definitions: {
      [U.pse]:     { card_name: 'pse-directories',  submodule_id: 'google-pse-curated-search', step: 1, round: 1, overrides: { curated_list: 'directories' } },
      [U.writer]:  { card_name: 'content-writer',   submodule_id: 'content-writer',            step: 5, round: 1, overrides: {} },
      [U.writer2]: { card_name: 'content-writer-v2', submodule_id: 'content-writer',           step: 5, round: 2, overrides: { temperature: 0.3, prompt: 'stricter citation rules' } },
    },
    routing_rules: {
      'citation:fail': [{ step: 5, card_id: U.writer2 }],
      'hallucination:fail': [{ step: 5, card_id: U.writer2 }],
    },
  };
}

// ── persist branch ────────────────────────────────────────────────────────────
test('valid corrected-shape plan → errors:[] (route persists it)', () => {
  assert.deepEqual(errs(correctedPlan()), []);
});

test('validator does NOT mutate the plan → JSONB stored == sent (round-trips intact)', () => {
  const plan = correctedPlan();
  const before = structuredClone(plan);
  validateExecutionPlan(plan, opts);
  assert.deepEqual(plan, before, 'execution_plan must be unchanged by validation (handler stores it verbatim)');
});

// ── 400 branch: gap close — legacy card-authoring shapes must be REJECTED ────────
test('legacy `cards` key (dead CardsSection shape) → 400', () => {
  const plan = { cards: { 'writer-v2': { submodule_id: 'content-writer', step: 5, options_overrides: {} } } };
  assert.ok(errs(plan).some((e) => /legacy `cards` key is not supported/i.test(e)),
    `expected legacy-cards rejection, got: ${errs(plan).join(' | ')}`);
});

test('legacy object-form routing_rules ({target_cards}) → 400', () => {
  const plan = {
    card_definitions: correctedPlan().card_definitions,
    routing_rules: { 'citation:fail': { target_cards: ['content-writer-v2'] } }, // dead RoutingRulesSection shape
  };
  assert.ok(errs(plan).some((e) => /must be an array of \{step, card_id\}/i.test(e)),
    `expected object-form routing_rules rejection, got: ${errs(plan).join(' | ')}`);
});

// ── no over-rejection: empty routing_rules / empty target arrays are tolerated ───
test('empty routing_rules ({} and empty target arrays) → errors:[] (rule 13 tolerates arrays incl. empty)', () => {
  assert.deepEqual(errs({ routing_rules: {} }), []);
  assert.deepEqual(errs({
    card_definitions: correctedPlan().card_definitions,
    submodules_per_step: correctedPlan().submodules_per_step,
    routing_rules: { 'citation:fail': [] },
  }), []);
});

// ── 400 branch: representative §9 violation still fires ──────────────────────────
test('§9 rule 10: routing_rules card_id absent from card_definitions → 400', () => {
  const plan = correctedPlan();
  plan.routing_rules['keyword:fail'] = [{ step: 5, card_id: U.ghost }];
  assert.ok(errs(plan).some((e) => new RegExp(`${U.ghost}.*not found in card_definitions`, 'i').test(e)));
});

// ── plain legacy pipeline plans are NOT card plans → must still pass ─────────────
test('plain card-less legacy plan (kebab submodules_per_step, no cards) → errors:[] (not broken by the gap close)', () => {
  assert.deepEqual(errs({ submodules_per_step: { '1': ['sitemap-parser', 'url-dedup'], '2': ['url-dedup'] } }), []);
});

// ── structural wiring: the save path stores execution_plan verbatim + 400s on errors ──
test('templates.js stores execution_plan verbatim and 400s on validation errors', () => {
  const src = readFileSync(join(__dirname, '..', 'routes', 'templates.js'), 'utf8');
  assert.match(src, /updates\.execution_plan\s*=\s*req\.body\.execution_plan/, 'PUT must store execution_plan verbatim (intact JSONB)');
  assert.match(src, /status\(400\)[\s\S]*Invalid execution_plan/, 'must 400 with "Invalid execution_plan" when validation fails');
});
