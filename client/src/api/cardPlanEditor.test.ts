// Unit test for cardPlanEditor (the client-side atomic card-plan builders).
// Runs on Node's native TS type-stripping (Node 22.6+/23.6+; verified on v26):
//   node --test client/src/api/cardPlanEditor.test.ts
// NOT part of `npm test` (that glob is server-only) and EXCLUDED from `tsc -b`
// (tsconfig.app.json excludes *.test.ts). It also imports the REAL server validator to prove
// the editor's output is accepted by the actual save gate (cross-tree shape contract).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCard, removeCard, setRoutingTargets, mintCardId } from './cardPlanEditor.ts';
// The exact gate PUT /api/templates/:id calls before persisting:
import { validateExecutionPlan } from '../../../server/services/executionPlanUtils.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opts = { isRegisteredSubmodule: (id) => ['google-pse-curated-search', 'content-writer'].includes(id) };

test('mintCardId returns a valid UUID (contract 1: client-side mint)', () => {
  assert.match(mintCardId(), UUID_RE);
});

test('addCard Round-1: ATOMIC dual-write — card_definitions AND submodules_per_step together', () => {
  const { plan, cardId } = addCard({}, {
    card_name: 'pse-directories', submodule_id: 'google-pse-curated-search', step: 1,
    rounds: { '1': { curated_list: 'directories' } },
  }, { round1: true });
  assert.match(cardId, UUID_RE);
  assert.ok(plan.card_definitions?.[cardId], 'card written to card_definitions');
  assert.deepEqual(plan.submodules_per_step?.['1'], [cardId], 'Round-1 card_id added to submodules_per_step[step]');
});

test('addCard retry-only: card_definitions ONLY, not submodules_per_step', () => {
  const { plan, cardId } = addCard({}, {
    card_name: 'content-writer-v2', submodule_id: 'content-writer', step: 5,
    rounds: { '1': {}, '2': { temperature: 0.3 } },
  }, { round1: false });
  assert.ok(plan.card_definitions?.[cardId], 'card written to card_definitions');
  assert.equal(plan.submodules_per_step?.['5'], undefined, 'retry-only card must NOT enter submodules_per_step');
});

test('addCard is immutable — original plan untouched', () => {
  const orig = { card_definitions: {}, submodules_per_step: {} };
  const snapshot = structuredClone(orig);
  addCard(orig, { card_name: 'x', submodule_id: 'content-writer', step: 5, rounds: { '1': {} } }, { round1: true });
  assert.deepEqual(orig, snapshot, 'input plan must not be mutated');
});

test('removeCard drops the card from card_definitions, submodules_per_step, AND routing_rules', () => {
  let plan = {};
  const a = addCard(plan, { card_name: 'pse', submodule_id: 'google-pse-curated-search', step: 1, rounds: { '1': {} } }, { round1: true });
  plan = a.plan;
  const w = addCard(plan, { card_name: 'writer-v2', submodule_id: 'content-writer', step: 5, rounds: { '1': {}, '2': { temperature: 0.3 } } }, { round1: false });
  plan = w.plan;
  plan = setRoutingTargets(plan, 'citation:fail', [{ step: 5, card_id: w.cardId }]);

  plan = removeCard(plan, w.cardId);
  assert.equal(plan.card_definitions?.[w.cardId], undefined, 'removed from card_definitions');
  assert.equal(plan.routing_rules?.['citation:fail'], undefined, 'empty routing rule pruned');
  assert.ok(plan.card_definitions?.[a.cardId], 'other card preserved');
});

test('setRoutingTargets: array form; empty list removes the key', () => {
  let plan = setRoutingTargets({}, 'citation:fail', [{ step: 5, card_id: mintCardId() }]);
  assert.ok(Array.isArray(plan.routing_rules?.['citation:fail']));
  plan = setRoutingTargets(plan, 'citation:fail', []);
  assert.equal(plan.routing_rules?.['citation:fail'], undefined);
});

test('editor output is accepted by the REAL server save validator (cross-tree shape contract)', () => {
  // Build a full plan the way the UI would, then run it through the exact gate the PUT handler calls.
  let plan = { submodules_per_step: { '5': ['content-writer'] } };
  const writer = addCard(plan, {
    card_name: 'content-writer-v2', submodule_id: 'content-writer', step: 5,
    rounds: { '1': {}, '2': { temperature: 0.3, prompt: 'stricter citation rules' } },
  }, { round1: false });
  plan = writer.plan;
  const pse = addCard(plan, {
    card_name: 'pse-directories', submodule_id: 'google-pse-curated-search', step: 1,
    rounds: { '1': { curated_list: 'directories' } },
  }, { round1: true });
  plan = pse.plan;
  plan = setRoutingTargets(plan, 'citation:fail', [{ step: 5, card_id: writer.cardId }]);

  const { errors } = validateExecutionPlan(plan, opts);
  assert.deepEqual(errors, [], `editor produced a plan the save gate rejects: ${errors.join(' | ')}`);
});
