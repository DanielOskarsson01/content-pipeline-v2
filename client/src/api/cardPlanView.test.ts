import { describe, it, expect } from 'vitest';
import { cardsForSubmodule, cardIsRound1, cardRoutingInfo, roundKeys, nextRoundKey, cardActiveInRun, runEntries, availableRuns, routableCardsForSubmodule } from './cardPlanView.ts';
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

describe('run-tab derivation', () => {
  // Fixture: a legacy string (step1) + a Round-1 card (step1) + a routed retry-only card (step5, rounds{1,2})
  // + an UNROUTED retry-only card (step5, rounds{1,2}).
  function mk() {
    let plan: any = { submodules_per_step: { '1': ['sitemap-parser'] } };
    const pse = addCard(plan, { card_name: 'pse-dir', submodule_id: 'google-pse-curated-search', step: 1, rounds: { '1': {} } }, { round1: true }); plan = pse.plan;
    const writer = addCard(plan, { card_name: 'writer-v2', submodule_id: 'content-writer', step: 5, rounds: { '1': {}, '2': {} } }, { round1: false }); plan = writer.plan;
    const unrouted = addCard(plan, { card_name: 'seo-v2', submodule_id: 'seo-planner', step: 5, rounds: { '1': {}, '2': {} } }, { round1: false }); plan = unrouted.plan;
    plan = setRoutingTargets(plan, 'citation:fail', [{ step: 5, card_id: writer.cardId }]);
    return { plan, pse: pse.cardId, writer: writer.cardId, unrouted: unrouted.cardId };
  }

  it('cardActiveInRun: Run 1 = placement; Run N>1 = routed AND declares round N', () => {
    const { plan, pse, writer, unrouted } = mk();
    expect(cardActiveInRun(plan, pse, 1)).toBe(true);        // placed in Round 1
    expect(cardActiveInRun(plan, writer, 1)).toBe(false);    // retry-only → not Run 1
    expect(cardActiveInRun(plan, writer, 2)).toBe(true);     // routed + declares round 2
    expect(cardActiveInRun(plan, writer, 3)).toBe(false);    // no round 3
    expect(cardActiveInRun(plan, unrouted, 2)).toBe(false);  // declares round 2 but NOT routed
    expect(cardActiveInRun(plan, 'nope', 2)).toBe(false);    // unknown card
  });

  it('runEntries Run 1: card + legacy string, both tagged, in order', () => {
    const { plan, pse } = mk();
    const e1 = runEntries(plan, 1);
    expect(e1).toContainEqual({ kind: 'legacy', submoduleId: 'sitemap-parser' });
    expect(e1.some((x) => x.kind === 'card' && x.cardId === pse)).toBe(true);
    expect(e1.every((x) => x.kind === 'legacy' || (x.kind === 'card' && x.cardId === pse))).toBe(true); // no retry-only cards
  });

  it('runEntries Run 2: only the routed round-2 card (cards only, no legacy, unrouted excluded)', () => {
    const { plan, writer, unrouted } = mk();
    const e2 = runEntries(plan, 2);
    expect(e2.map((x) => (x.kind === 'card' ? x.cardId : x.submoduleId))).toEqual([writer]);
    expect(e2.some((x) => x.kind === 'card' && x.cardId === unrouted)).toBe(false);
  });

  it('a card BOTH placed AND routed with round 2 appears in Run 1 AND Run 2', () => {
    const { plan, writer } = mk();
    const placed = setCardPlacement(plan, writer, { round1: true });
    expect(cardActiveInRun(placed, writer, 1)).toBe(true);
    expect(cardActiveInRun(placed, writer, 2)).toBe(true);
  });

  it('availableRuns: [1] always; adds N only when ≥1 card active; never a zero-card run', () => {
    expect(availableRuns(undefined)).toEqual([1]);
    expect(availableRuns({ submodules_per_step: { '1': ['sitemap-parser'] } })).toEqual([1]); // no cards
    expect(availableRuns(mk().plan)).toEqual([1, 2]); // writer active on run 2, nothing on 3/4
  });

  it('routableCardsForSubmodule: only cards with a round > 1 (rule 11 gate)', () => {
    const { plan, writer } = mk();
    // content-writer has the round-2 writer card → routable; google-pse-curated-search's pse card is round-1-only → not
    expect(routableCardsForSubmodule(plan, 'content-writer').map((c) => c.cardId)).toEqual([writer]);
    expect(routableCardsForSubmodule(plan, 'google-pse-curated-search')).toEqual([]);
  });
});
