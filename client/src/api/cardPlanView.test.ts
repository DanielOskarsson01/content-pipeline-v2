import { describe, it, expect } from 'vitest';
import { cardsForSubmodule, cardIsRound1, cardRoutingInfo, roundKeys, nextRoundKey } from './cardPlanView.ts';
import { addCard, setRoutingTargets, setCardPlacement } from './cardPlanEditor.ts';

const writer = { card_name: 'content-writer-v2', submodule_id: 'content-writer', step: 5, rounds: { '1': {}, '2': { temperature: 0.3 } } };
const pse = { card_name: 'pse-directories', submodule_id: 'google-pse-curated-search', step: 1, rounds: { '1': {} } };

describe('cardsForSubmodule', () => {
  it('returns only the cards whose submodule_id matches, with their ids', () => {
    let plan = {};
    const w = addCard(plan, writer, { round1: false }); plan = w.plan;
    const p = addCard(plan, pse, { round1: true }); plan = p.plan;
    const forWriter = cardsForSubmodule(plan, 'content-writer');
    expect(forWriter.map((c) => c.cardId)).toEqual([w.cardId]);
    expect(forWriter[0].card.card_name).toBe('content-writer-v2');
    expect(cardsForSubmodule(plan, 'google-pse-curated-search').map((c) => c.cardId)).toEqual([p.cardId]);
    expect(cardsForSubmodule(plan, 'sitemap-parser')).toEqual([]);
  });
  it('is empty for a plan with no card_definitions', () => {
    expect(cardsForSubmodule({ submodules_per_step: { '1': ['sitemap-parser'] } }, 'sitemap-parser')).toEqual([]);
  });
});

describe('cardIsRound1', () => {
  it('true when the card_id is placed in submodules_per_step[card.step]; false for retry-only', () => {
    const w = addCard({}, writer, { round1: false });   // retry-only
    const p = addCard(w.plan, pse, { round1: true });    // round-1 placed
    expect(cardIsRound1(p.plan, w.cardId)).toBe(false);
    expect(cardIsRound1(p.plan, p.cardId)).toBe(true);
  });
  it('follows a setCardPlacement toggle', () => {
    const w = addCard({}, writer, { round1: false });
    const placed = setCardPlacement(w.plan, w.cardId, { round1: true });
    expect(cardIsRound1(placed, w.cardId)).toBe(true);
    const unplaced = setCardPlacement(placed, w.cardId, { round1: false });
    expect(cardIsRound1(unplaced, w.cardId)).toBe(false);
  });
  it('false for an unknown card', () => {
    expect(cardIsRound1({ card_definitions: {} }, 'nope')).toBe(false);
  });
});

describe('cardRoutingInfo', () => {
  it('reports the fail keys that route to a card', () => {
    const w = addCard({}, writer, { round1: false });
    let plan = setRoutingTargets(w.plan, 'citation:fail', [{ step: 5, card_id: w.cardId }]);
    plan = setRoutingTargets(plan, 'hallucination:fail', [{ step: 5, card_id: w.cardId }]);
    const info = cardRoutingInfo(plan, w.cardId);
    expect(info.routed).toBe(true);
    expect(info.failKeys.sort()).toEqual(['citation:fail', 'hallucination:fail']);
  });
  it('routed=false with no fail keys when unrouted', () => {
    const w = addCard({}, writer, { round1: false });
    expect(cardRoutingInfo(w.plan, w.cardId)).toEqual({ routed: false, failKeys: [] });
  });
});

describe('roundKeys / nextRoundKey', () => {
  it('roundKeys returns sorted 1-4 round keys present', () => {
    expect(roundKeys({ rounds: { '1': {}, '3': {}, '2': {} } })).toEqual(['1', '2', '3']);
  });
  it('nextRoundKey is the next contiguous round, or null at max 4', () => {
    expect(nextRoundKey({ rounds: { '1': {} } })).toBe('2');
    expect(nextRoundKey({ rounds: { '1': {}, '2': {} } })).toBe('3');
    expect(nextRoundKey({ rounds: { '1': {}, '2': {}, '3': {}, '4': {} } })).toBe(null);
  });
});
