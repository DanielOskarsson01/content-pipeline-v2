/**
 * Tests for routingHandler.resolveCards + validateCards against the CANONICAL
 * Multi-Card schema (PHASE_3B spec §1.2 / §2.1):
 *   - cards stored UUID-keyed under execution_plan.card_definitions
 *   - routing_rules["<check>:fail"] = [{ step, card_id }]   (array of targets)
 *
 * Before the 2026-06-15 fix, both functions read the LEGACY shape
 * (execution_plan.cards + routing_rules[key].target_cards of string names).
 * On a real card_definitions template that drift made resolveCards THROW a
 * TypeError (for…of over rule.target_cards === undefined) and made validateCards
 * silently pass invalid configs. These tests pin the canonical shape so the
 * drift cannot silently return (Pattern I).
 *
 * Pure functions, no DB — routingHandler only imports cardInstructions.js, which
 * has no imports of its own, so this loads without SUPABASE env.
 *
 * Run via: npm test   (the package.json "test" script discovers this file)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCards, validateCards } from './routingHandler.js';

const CARD_ID = 'a8f4d2c1-7e57-4001-8001-deadbeef0001';

// Canonical v6 execution_plan fixture (scalar `round` + flat `overrides`; the
// `rounds` MAP is dropped — unit 2.4/2.5). CARD_ID is a round-2 retry variant.
function plan(overrides = {}) {
  return {
    card_definitions: {
      [CARD_ID]: {
        step: 5,
        submodule_id: 'content-writer',
        card_name: 'writer-v2-placeholder',
        round: 2,
        overrides: { _placeholder_marker: 'sub-plan-1-ship-gate' },
      },
    },
    routing_rules: {
      'citation:fail': [{ step: 5, card_id: CARD_ID }],
      'hallucination:fail': [{ step: 5, card_id: CARD_ID }],
    },
    ...overrides,
  };
}

// A round-3 sibling card for INV-ROUND selection tests.
const CARD_R3_ID = 'a8f4d2c1-7e57-4001-8001-deadbeef0003';
function planWithR3(overrides = {}) {
  const p = plan();
  p.card_definitions[CARD_R3_ID] = {
    step: 5, submodule_id: 'content-writer', card_name: 'writer-v3', round: 3, overrides: {},
  };
  p.routing_rules['citation:fail'] = [
    { step: 5, card_id: CARD_ID },     // round 2
    { step: 5, card_id: CARD_R3_ID },  // round 3
  ];
  return { ...p, ...overrides };
}

// ── resolveCards (v6 partition-by-round; 3rd arg is the entity's PRE-BUMP loop_count) ──

test('resolveCards: INV-ROUND — loop_count=0 selects the round-2 card by card_id (targetRound = 0+2)', () => {
  const result = resolveCards({ citation: 'fail', hallucination: 'pass' }, plan(), 0);
  assert.ok(result, 'expected a resolution, got null');
  assert.deepEqual(result.active_cards, { '5': [CARD_ID] }, 'active_cards keyed by step, valued by round-matched card_id');
  assert.deepEqual(result.triggered_by, ['citation:fail']);
  assert.equal(result.missing_reason, null, 'a round-matched card carries missing_reason=null');
});

test('resolveCards: INV-ROUND — loop_count=1 selects the round-3 sibling, NOT round 2 (targetRound = 1+2)', () => {
  const result = resolveCards({ citation: 'fail' }, planWithR3(), 1);
  assert.ok(result, 'expected a resolution');
  assert.deepEqual(result.active_cards, { '5': [CARD_R3_ID] }, 'round-3 card selected; round-2 card NOT re-selected');
});

test('resolveCards: step comes from the rule target (kept equal to the card step)', () => {
  const result = resolveCards({ citation: 'fail' }, plan(), 0);
  assert.deepEqual(Object.keys(result.active_cards), ['5']);
});

test('resolveCards: no failures → null', () => {
  assert.equal(resolveCards({ citation: 'pass', hallucination: 'pass' }, plan(), 0), null);
});

test('resolveCards: no routing_rules → null', () => {
  assert.equal(resolveCards({ citation: 'fail' }, { card_definitions: plan().card_definitions }, 0), null);
});

test('resolveCards: OVERFLOW — a real card at the WRONG round → missing_reason=no_card_for_round (V6-§3 flag-and-continue)', () => {
  // Only a round-2 card exists; at loop_count=1 the entity wants round 3 → overflow.
  const result = resolveCards({ citation: 'fail' }, plan(), 1);
  assert.ok(result, 'overflow returns a non-null result (so the caller can flag-and-continue, not silently drop)');
  assert.deepEqual(result.active_cards, {}, 'no round-matched card');
  assert.equal(result.missing_reason, 'no_card_for_round');
});

test('resolveCards: CORRUPTION — rule targets a card_id absent from card_definitions → missing_reason=card_not_in_definitions', () => {
  const p = plan({ routing_rules: { 'citation:fail': [{ step: 5, card_id: 'ffffffff-0000-0000-0000-000000000000' }] } });
  const result = resolveCards({ citation: 'fail' }, p, 0);
  assert.ok(result, 'corruption returns a non-null result');
  assert.deepEqual(result.active_cards, {}, 'no card selected');
  assert.equal(result.missing_reason, 'card_not_in_definitions', 'absent card → corruption (→ terminal failed), NOT overflow');
});

test('resolveCards: corruption DOMINATES overflow — absent + wrong-round targets → card_not_in_definitions', () => {
  // One target names an absent card (corruption), another names a real card at the
  // wrong round (overflow). Corruption must win so it is not masked as needs-review.
  const p = plan({
    routing_rules: {
      'citation:fail': [
        { step: 5, card_id: 'ffffffff-0000-0000-0000-000000000000' }, // absent
        { step: 5, card_id: CARD_ID },                                 // round 2, but targetRound=3
      ],
    },
  });
  const result = resolveCards({ citation: 'fail' }, p, 1);
  assert.equal(result.missing_reason, 'card_not_in_definitions');
});

test('resolveCards: malformed rule (not an array) is skipped, never throws → null', () => {
  const p = plan({ routing_rules: { 'citation:fail': { target_cards: [CARD_ID] } } }); // the OLD legacy shape
  assert.doesNotThrow(() => resolveCards({ citation: 'fail' }, p, 0));
  assert.equal(resolveCards({ citation: 'fail' }, p, 0), null, 'legacy {target_cards} shape resolves nothing (not overflow)');
});

test('resolveCards: target missing card_id is skipped, never throws → null (malformed ≠ overflow)', () => {
  const p = plan({ routing_rules: { 'citation:fail': [{ step: 5 }] } });
  assert.doesNotThrow(() => resolveCards({ citation: 'fail' }, p, 0));
  assert.equal(resolveCards({ citation: 'fail' }, p, 0), null);
});

// ── validateCards ────────────────────────────────────────────────────────────

test('validateCards: canonical valid config → no warnings', () => {
  assert.deepEqual(validateCards(plan()), []);
});

test('validateCards: rule targeting an unknown card_id warns (legacy code MISSED this)', () => {
  const badId = 'ffffffff-0000-0000-0000-000000000000';
  const p = plan({ routing_rules: { 'citation:fail': [{ step: 5, card_id: badId }] } });
  const warnings = validateCards(p);
  assert.ok(warnings.some(w => w.includes(badId)), `expected a warning naming ${badId}, got: ${JSON.stringify(warnings)}`);
});

test('validateCards: card missing submodule_id warns', () => {
  const p = plan();
  delete p.card_definitions[CARD_ID].submodule_id;
  assert.ok(validateCards(p).some(w => /submodule_id/.test(w)));
});

test('validateCards: card missing step warns', () => {
  const p = plan();
  delete p.card_definitions[CARD_ID].step;
  assert.ok(validateCards(p).some(w => /step/.test(w)));
});
