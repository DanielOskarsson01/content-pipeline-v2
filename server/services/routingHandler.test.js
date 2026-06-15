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

// Canonical execution_plan fixture (mirrors the live `30 april` template).
function plan(overrides = {}) {
  return {
    card_definitions: {
      [CARD_ID]: {
        step: 5,
        submodule_id: 'content-writer',
        card_name: 'writer-v2-placeholder',
        rounds: { '1': {}, '2': { _placeholder_marker: 'sub-plan-1-ship-gate' } },
      },
    },
    routing_rules: {
      'citation:fail': [{ step: 5, card_id: CARD_ID }],
      'hallucination:fail': [{ step: 5, card_id: CARD_ID }],
    },
    ...overrides,
  };
}

// ── resolveCards ─────────────────────────────────────────────────────────────

test('resolveCards: citation:fail resolves the card_definitions card by card_id (legacy code THREW on this input)', () => {
  const result = resolveCards({ citation: 'fail', hallucination: 'pass' }, plan(), {});
  assert.ok(result, 'expected a resolution, got null');
  assert.deepEqual(result.active_cards, { '5': [CARD_ID] }, 'active_cards keyed by step, valued by card_id');
  assert.deepEqual(result.triggered_by, ['citation:fail']);
  assert.deepEqual(result.consumed_cards, [CARD_ID]);
});

test('resolveCards: step comes from the rule target (PHASE_3B §2.1 keeps it equal to the card step)', () => {
  // Rule target step wins; here it equals the card step (5).
  const result = resolveCards({ citation: 'fail' }, plan(), {});
  assert.deepEqual(Object.keys(result.active_cards), ['5']);
});

test('resolveCards: no failures → null', () => {
  assert.equal(resolveCards({ citation: 'pass', hallucination: 'pass' }, plan(), {}), null);
});

test('resolveCards: no routing_rules → null', () => {
  assert.equal(resolveCards({ citation: 'fail' }, { card_definitions: plan().card_definitions }, {}), null);
});

test('resolveCards: respects consumed_cards (card already assigned → not re-activated)', () => {
  const result = resolveCards({ citation: 'fail' }, plan(), { consumed_cards: [CARD_ID] });
  assert.equal(result, null, 'an already-consumed card must not re-activate');
});

test('resolveCards: rule targets a card_id absent from card_definitions → skipped, no throw', () => {
  const p = plan({ routing_rules: { 'citation:fail': [{ step: 5, card_id: 'ffffffff-0000-0000-0000-000000000000' }] } });
  assert.equal(resolveCards({ citation: 'fail' }, p, {}), null);
});

test('resolveCards: malformed rule (not an array) is skipped, never throws', () => {
  const p = plan({ routing_rules: { 'citation:fail': { target_cards: [CARD_ID] } } }); // the OLD legacy shape
  assert.doesNotThrow(() => resolveCards({ citation: 'fail' }, p, {}));
  assert.equal(resolveCards({ citation: 'fail' }, p, {}), null, 'legacy {target_cards} shape resolves nothing now');
});

test('resolveCards: target missing card_id is skipped, never throws', () => {
  const p = plan({ routing_rules: { 'citation:fail': [{ step: 5 }] } });
  assert.doesNotThrow(() => resolveCards({ citation: 'fail' }, p, {}));
  assert.equal(resolveCards({ citation: 'fail' }, p, {}), null);
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
