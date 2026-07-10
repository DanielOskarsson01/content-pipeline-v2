/**
 * Unit 2.7 — 30-april fixture migration: local validate + resolve proof.
 *
 * Drives the REAL v6 validator (2.4, executionPlanUtils.validateExecutionPlan)
 * and the REAL v6 engine (2.5, routingHandler.resolveCards) against the captured
 * before/after execution_plan JSONB. This is the semantic half of the round-trip
 * proof (the Supabase branch dry-run proves the SQL mechanics separately):
 *
 *   before (old rounds-map shape) -> INVALID under the new validator  (migration necessary)
 *   after  (scalar-round shape)   -> VALID, and RESOLVES to the round-2 card
 *
 * Artifacts: supabase/artifacts/unit-2.7/30april.execution_plan.{before,after}.json
 * Spec: noble-wandering-graham.md V6-§1.1/§1.2/§1.3/§2/§8; DECISION_CARD_MODEL_V6.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateExecutionPlan, resolveStepEntry } from '../services/executionPlanUtils.js';
import { resolveCards } from '../services/routingHandler.js';

const CARD_ID = 'a8f4d2c1-7e57-4001-8001-deadbeef0001';
const dir = new URL('../../supabase/artifacts/unit-2.7/', import.meta.url);
const before = JSON.parse(readFileSync(new URL('30april.execution_plan.before.json', dir)));
const after = JSON.parse(readFileSync(new URL('30april.execution_plan.after.json', dir)));

// Faithful registry: every plain-string submodule in the plan + every card's
// submodule_id is "registered" (exercises validator rule 2b for real, without
// needing the modules repo). The only card submodule is content-writer.
function registryFor(plan) {
  const allow = new Set();
  for (const entries of Object.values(plan.submodules_per_step || {})) {
    for (const e of entries || []) if (!/^[0-9a-f]{8}-/i.test(e)) allow.add(e);
  }
  for (const c of Object.values(plan.card_definitions || {})) if (c?.submodule_id) allow.add(c.submodule_id);
  return (id) => allow.has(id);
}

test('BEFORE (old rounds-map shape) is REJECTED by the new validator — migration is necessary', () => {
  const { errors } = validateExecutionPlan(before, { isRegisteredSubmodule: registryFor(before) });
  assert.ok(errors.length > 0, 'expected the old rounds-map shape to fail the v6 validator');
  // The card carries no scalar `round`, only a `rounds` map: rule 4 (round required) fires, and
  // because it has no round > 1 the routing reference is rejected too (rule 11). Both prove the
  // old shape cannot survive the new validator — the migration is necessary. (The group-contiguity
  // rule does NOT fire: a card with no scalar `round` is skipped from grouping — rule 4 owns it.)
  assert.ok(errors.some((e) => /round is required/.test(e)), `missing rule-4 error; got: ${JSON.stringify(errors)}`);
  assert.ok(
    errors.some((e) => /has no round > 1|can never escalate/.test(e)),
    `missing rule-11 error; got: ${JSON.stringify(errors)}`
  );
});

test('AFTER (scalar-round shape) VALIDATES clean under the new validator', () => {
  const { errors } = validateExecutionPlan(after, { isRegisteredSubmodule: registryFor(after) });
  assert.deepEqual(errors, [], `expected zero errors; got: ${JSON.stringify(errors)}`);
});

test('AFTER: the card is de-placed (routing-only) — not in submodules_per_step', () => {
  const step5 = after.submodules_per_step['5'];
  assert.ok(!step5.includes(CARD_ID), 'card UUID must be removed from submodules_per_step[5]');
  assert.ok(step5.includes('content-writer'), 'plain content-writer round-1 entry must remain placed');
});

test('AFTER: resolveCards selects the round-2 card on citation+hallucination fail (INV-ROUND: loop_count 0 -> round 2)', () => {
  const qa = { citation: 'fail', hallucination: 'fail' };
  const res = resolveCards(qa, after, 0); // pre-bump loop_count = 0 -> selection round 2
  assert.ok(res, 'expected a resolution');
  assert.equal(res.missing_reason, null, `expected a clean round-match; got ${JSON.stringify(res)}`);
  assert.deepEqual(res.active_cards, { 5: [CARD_ID] }, 'expected the round-2 card active at step 5');
  // Two rules -> same card: deduped to a single active card (ship-gate dedup).
  assert.equal(res.active_cards['5'].length, 1, 'the two rules must dedupe to one active card');
});

test('AFTER: the flat `overrides` collapse resolves (resolveStepEntry reads card.overrides)', () => {
  const resolved = resolveStepEntry(CARD_ID, after.card_definitions);
  assert.equal(resolved.submodule_id, 'content-writer');
  assert.deepEqual(resolved.round_1_overrides, { _placeholder_marker: 'sub-plan-1-ship-gate' },
    'flat overrides must resolve from card.overrides (no rounds[N] indirection)');
});

test('AFTER: overflow past the authored round hits the flag-and-continue terminus (no_card_for_round), never a crash', () => {
  const qa = { citation: 'fail' };
  const res = resolveCards(qa, after, 1); // loop_count 1 -> selection round 3; only round 2 authored
  assert.ok(res, 'expected a resolution object, not null');
  assert.deepEqual(res.active_cards, {}, 'no round-3 card exists');
  assert.equal(res.missing_reason, 'no_card_for_round', `expected overflow terminus; got ${JSON.stringify(res)}`);
});
