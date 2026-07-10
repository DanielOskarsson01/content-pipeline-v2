// cardPlanView — pure scalar-round derivations (v6, unit 2.6). The round-map helpers
// (roundKeys/nextRoundKey/cardActiveInRun/runEntries) were deleted; every derivation now reads the
// scalar `card.round`. Run: `npm test` (client) or `npx vitest run`.
import { describe, it, expect } from 'vitest';
import {
  cardsForSubmodule, cardIsRound1, cardRoutingInfo, cardRound, cardsAt, submoduleActiveInRound,
  activeInOtherRounds, cardIsDormant, routableCardsForSubmodule, deadRungRounds, placedEntriesForStep,
} from './cardPlanView.ts';
import { addCard, setRoutingTargets, setCardPlacement } from './cardPlanEditor.ts';

// v6 scalar inputs: a placed round-1 pse; a routing-only round-2 writer; a routing-only round-2 seo.
const pse = { card_name: 'pse-directories', submodule_id: 'google-pse-curated-search', step: 1, round: 1, overrides: {} };
const writer2 = { card_name: 'content-writer-v2', submodule_id: 'content-writer', step: 5, round: 2, overrides: { temperature: 0.3 } };

describe('cardsForSubmodule', () => {
  it('returns only the cards whose submodule_id matches, with their ids', () => {
    let plan: any = {};
    const w = addCard(plan, writer2, { round1: false }); plan = w.plan;
    const p = addCard(plan, pse, { round1: true }); plan = p.plan;
    expect(cardsForSubmodule(plan, 'content-writer').map((c) => c.cardId)).toEqual([w.cardId]);
    expect(cardsForSubmodule(plan, 'google-pse-curated-search').map((c) => c.cardId)).toEqual([p.cardId]);
    expect(cardsForSubmodule(plan, 'sitemap-parser')).toEqual([]);
  });
  it('is empty for a plan with no card_definitions', () => {
    expect(cardsForSubmodule({ submodules_per_step: { '1': ['sitemap-parser'] } }, 'sitemap-parser')).toEqual([]);
  });
});

describe('cardRound (scalar authority, D10)', () => {
  it('reads the scalar round; absent ⇒ 1 (placed first-pass default)', () => {
    expect(cardRound({ card_name: 'x', submodule_id: 's', step: 1, round: 3 })).toBe(3);
    expect(cardRound({ card_name: 'x', submodule_id: 's', step: 1 } as any)).toBe(1);
    expect(cardRound(undefined)).toBe(1);
  });
});

describe('cardIsRound1', () => {
  it('true when placed in submodules_per_step[card.step]; false for retry-only; follows the toggle', () => {
    const w = addCard({}, writer2, { round1: false });   // retry-only
    const p = addCard(w.plan, pse, { round1: true });     // round-1 placed
    expect(cardIsRound1(p.plan, w.cardId)).toBe(false);
    expect(cardIsRound1(p.plan, p.cardId)).toBe(true);
    const placed = setCardPlacement(w.plan, w.cardId, { round1: true });
    expect(cardIsRound1(placed, w.cardId)).toBe(true);
  });
  it('false for an unknown card', () => {
    expect(cardIsRound1({ card_definitions: {} }, 'nope')).toBe(false);
  });
});

describe('cardRoutingInfo', () => {
  it('reports the fail keys that route to a card', () => {
    const w = addCard({}, writer2, { round1: false });
    let plan = setRoutingTargets(w.plan, 'citation:fail', [{ step: 5, card_id: w.cardId }]);
    plan = setRoutingTargets(plan, 'hallucination:fail', [{ step: 5, card_id: w.cardId }]);
    const info = cardRoutingInfo(plan, w.cardId);
    expect(info.routed).toBe(true);
    expect(info.failKeys.sort()).toEqual(['citation:fail', 'hallucination:fail']);
  });
  it('routed=false with no fail keys when unrouted', () => {
    const w = addCard({}, writer2, { round1: false });
    expect(cardRoutingInfo(w.plan, w.cardId)).toEqual({ routed: false, failKeys: [] });
  });
});

describe('cardsAt — cards at exactly (submodule, step, round)', () => {
  it('separates a round-1 clone-pair from a round-2 card at the same (submodule, step)', () => {
    let plan: any = { submodules_per_step: {} };
    const a = addCard(plan, { card_name: 'writer-a', submodule_id: 'content-writer', step: 5, round: 1, overrides: {} }, { round1: true }); plan = a.plan;
    const b = addCard(plan, { card_name: 'writer-b', submodule_id: 'content-writer', step: 5, round: 1, overrides: {} }, { round1: true }); plan = b.plan;
    const r2 = addCard(plan, writer2, { round1: false }); plan = r2.plan;
    expect(cardsAt(plan, 'content-writer', 5, 1).map((c) => c.cardId).sort()).toEqual([a.cardId, b.cardId].sort());
    expect(cardsAt(plan, 'content-writer', 5, 2).map((c) => c.cardId)).toEqual([r2.cardId]);
    expect(cardsAt(plan, 'content-writer', 5, 3)).toEqual([]);
    expect(cardsAt(plan, 'content-writer', 1, 1)).toEqual([]); // wrong step
  });
});

describe('submoduleActiveInRound — active-vs-greyed (S2.1)', () => {
  it('a round-2 routing-only card is active in round 2, greyed in round 1', () => {
    const w = addCard({}, writer2, { round1: false });
    expect(submoduleActiveInRound(w.plan, 'content-writer', 5, 2)).toBe(true);
    expect(submoduleActiveInRound(w.plan, 'content-writer', 5, 1)).toBe(false);
  });
  it('a legacy STRING placement makes a base submodule Round-1 active (no card)', () => {
    const plan = { submodules_per_step: { '3': ['page-scraper'] } };
    expect(submoduleActiveInRound(plan, 'page-scraper', 3, 1)).toBe(true);
    expect(submoduleActiveInRound(plan, 'page-scraper', 3, 2)).toBe(false); // strings never imply round 2
  });
});

describe('activeInOtherRounds — the cross-round pill (S3.2b)', () => {
  it('a round-2-only BASE submodule shows "Active in Round 2" from the Round-1 tab', () => {
    const w = addCard({}, writer2, { round1: false }); // content-writer active only in round 2 @ step 5
    // viewing round 1: greyed here, but a card exists in round 2 → pill [2]
    expect(activeInOtherRounds(w.plan, 'content-writer', 5, 1)).toEqual([2]);
    // viewing round 2: it IS the current round → no cross-round pill for round 2
    expect(activeInOtherRounds(w.plan, 'content-writer', 5, 2)).toEqual([]);
    // a submodule with no card anywhere → no pills
    expect(activeInOtherRounds(w.plan, 'seo-planner', 5, 1)).toEqual([]);
  });
});

describe('cardIsDormant — D9 amber, scoped (S3.4)', () => {
  it('a round≥2 card no rule reaches is dormant; routing it clears it', () => {
    const w = addCard({}, writer2, { round1: false });
    expect(cardIsDormant(w.plan, w.cardId)).toBe(true);              // authored escalation, unrouted
    const routed = setRoutingTargets(w.plan, 'citation:fail', [{ step: 5, card_id: w.cardId }]);
    expect(cardIsDormant(routed, w.cardId)).toBe(false);            // rule now reaches it
  });
  it('NEVER dormant for a round-1 (placed) card — amber is escalation-only', () => {
    const p = addCard({}, pse, { round1: true });                  // round 1, placed, unrouted
    expect(cardIsDormant(p.plan, p.cardId)).toBe(false);
  });
});

describe('routableCardsForSubmodule — rule-11 gate (scalar round > 1)', () => {
  it('only cards with round > 1', () => {
    let plan: any = { submodules_per_step: {} };
    const p = addCard(plan, pse, { round1: true }); plan = p.plan;          // round 1
    const w = addCard(plan, writer2, { round1: false }); plan = w.plan;     // round 2
    expect(routableCardsForSubmodule(plan, 'content-writer').map((c) => c.cardId)).toEqual([w.cardId]);
    expect(routableCardsForSubmodule(plan, 'google-pse-curated-search')).toEqual([]);
  });
});

describe('deadRungRounds — dead-rung nudge (S3.6)', () => {
  it('a round-3 target with no round-2 rung is a dead rung; adding round 2 clears it', () => {
    let plan: any = { submodules_per_step: {} };
    const r3 = addCard(plan, { card_name: 'w3', submodule_id: 'content-writer', step: 5, round: 3, overrides: {} }, { round1: false }); plan = r3.plan;
    plan = setRoutingTargets(plan, 'citation:fail', [{ step: 5, card_id: r3.cardId }]);
    expect(deadRungRounds(plan, 'citation:fail')).toEqual([3]);           // round 3 targeted, no round-2 rung
    const r2 = addCard(plan, writer2, { round1: false }); plan = r2.plan; // round 2
    plan = setRoutingTargets(plan, 'citation:fail', [{ step: 5, card_id: r3.cardId }, { step: 5, card_id: r2.cardId }]);
    expect(deadRungRounds(plan, 'citation:fail')).toEqual([]);            // rung filled
  });
  it('round 2 alone is never a dead rung (round 1 is the placed pass below it)', () => {
    const w = addCard({}, writer2, { round1: false });
    const plan = setRoutingTargets(w.plan, 'citation:fail', [{ step: 5, card_id: w.cardId }]);
    expect(deadRungRounds(plan, 'citation:fail')).toEqual([]);
  });
});

describe('placedEntriesForStep — INV-ORDER array read', () => {
  it('returns submodules_per_step[step] in authored array order (cards + legacy strings)', () => {
    let plan: any = { submodules_per_step: { '5': ['sitemap-parser'] } };
    const a = addCard(plan, { card_name: 'writer-a', submodule_id: 'content-writer', step: 5, round: 1, overrides: {} }, { round1: true }); plan = a.plan;
    const b = addCard(plan, { card_name: 'writer-b', submodule_id: 'content-writer', step: 5, round: 1, overrides: {} }, { round1: true }); plan = b.plan;
    expect(placedEntriesForStep(plan, 5)).toEqual(['sitemap-parser', a.cardId, b.cardId]);
    expect(placedEntriesForStep(plan, 9)).toEqual([]);
  });
});
