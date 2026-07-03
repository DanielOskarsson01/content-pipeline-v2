// cardPlanEditor — the six canonical atomic execution_plan builders.
// Run: `npm test` (client) or `npx vitest run`. NOT in the server `npm test` gate; NOT in tsc -b.
// Cross-checks the client's rule-10/11 messages against the REAL server validator.
import { describe, it, expect } from 'vitest';
import {
  mintCardId, addCard, setCardPlacement, removeCard, setRoutingTargets, setCardRounds,
} from './cardPlanEditor.ts';
// The exact gate PUT /api/templates/:id runs — proves "server-matching messages" + acceptance:
import { validateExecutionPlan } from '../../../server/services/executionPlanUtils.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GHOST = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const opts = { isRegisteredSubmodule: (id: string) => ['google-pse-curated-search', 'content-writer', 'sitemap-parser'].includes(id) };

const writerInput = { card_name: 'content-writer-v2', submodule_id: 'content-writer', step: 5, rounds: { '1': {}, '2': { temperature: 0.3, prompt: 'stricter' } } };
const pseInput = { card_name: 'pse-directories', submodule_id: 'google-pse-curated-search', step: 1, rounds: { '1': { curated_list: 'directories' } } };

describe('mintCardId', () => {
  it('returns a fresh valid UUID (contract 1: client-side mint)', () => {
    expect(mintCardId()).toMatch(UUID_RE);
    expect(mintCardId()).not.toBe(mintCardId());
  });
});

describe('addCard', () => {
  it('round1: writes card_definitions AND placement at String(step) in one transform', () => {
    const { plan, cardId } = addCard({}, pseInput, { round1: true });
    expect(cardId).toMatch(UUID_RE);
    expect(plan.card_definitions?.[cardId]).toEqual({ card_name: 'pse-directories', submodule_id: 'google-pse-curated-search', step: 1, rounds: { '1': { curated_list: 'directories' } } });
    expect(plan.submodules_per_step?.['1']).toEqual([cardId]); // String("1") key
  });
  it('retry-only: card_definitions only, no placement', () => {
    const { plan, cardId } = addCard({}, writerInput, { round1: false });
    expect(plan.card_definitions?.[cardId]).toBeTruthy();
    expect(plan.submodules_per_step?.['5']).toBeUndefined();
  });
  it('honours a pre-minted cardId', () => {
    const id = mintCardId();
    expect(addCard({}, { ...writerInput, cardId: id }, { round1: false }).cardId).toBe(id);
  });
  it('preserves description only when provided', () => {
    const noDesc = addCard({}, writerInput, { round1: false });
    expect('description' in noDesc.plan.card_definitions![noDesc.cardId]).toBe(false);
    const withDesc = addCard({}, { ...writerInput, description: 'note' }, { round1: false });
    expect(withDesc.plan.card_definitions![withDesc.cardId].description).toBe('note');
  });
  it('deep-copies rounds — mutating the caller\'s rounds object after the call cannot alias stored state', () => {
    const rounds = { '1': {}, '2': { prompt: 'orig' } };
    const { plan, cardId } = addCard({}, { ...writerInput, rounds }, { round1: false });
    (rounds['2'] as any).prompt = 'MUTATED';
    expect((plan.card_definitions![cardId].rounds['2'] as any).prompt).toBe('orig');
  });
  it('is immutable and passes unknown plan keys through untouched', () => {
    const orig = { skip_steps: [3], failure_thresholds: { '6': 0.2 }, weird_future_key: { a: 1 }, submodules_per_step: { '1': ['sitemap-parser'] } };
    const snap = structuredClone(orig);
    const { plan } = addCard(orig, pseInput, { round1: true });
    expect(orig).toEqual(snap); // input untouched
    expect(plan.skip_steps).toEqual([3]);
    expect((plan as any).weird_future_key).toEqual({ a: 1 });
    expect(plan.submodules_per_step!['1']).toContain('sitemap-parser'); // legacy string kept
  });
});

describe('setCardPlacement (the sixth fn — Round-1/retry toggle)', () => {
  it('round1:true places an existing card at its step; idempotent (no duplicate)', () => {
    const a = addCard({}, writerInput, { round1: false });
    let plan = setCardPlacement(a.plan, a.cardId, { round1: true });
    expect(plan.submodules_per_step?.['5']).toEqual([a.cardId]);
    plan = setCardPlacement(plan, a.cardId, { round1: true }); // again
    expect(plan.submodules_per_step?.['5']).toEqual([a.cardId]); // no dup
  });
  it('round1:false removes the card from placement (retry-only)', () => {
    const a = addCard({}, writerInput, { round1: true });
    const plan = setCardPlacement(a.plan, a.cardId, { round1: false });
    expect(plan.submodules_per_step?.['5'] ?? []).not.toContain(a.cardId);
  });
  it('unknown card is a no-op', () => {
    const before = { card_definitions: {}, submodules_per_step: { '1': ['sitemap-parser'] } };
    expect(setCardPlacement(before, GHOST, { round1: true })).toEqual(before);
  });
  it('is immutable, keeps legacy strings, passes unknown keys through', () => {
    const a = addCard({ weird: 1, submodules_per_step: { '5': ['content-writer'] } } as any, writerInput, { round1: false });
    const snap = structuredClone(a.plan);
    const plan = setCardPlacement(a.plan, a.cardId, { round1: true });
    expect(a.plan).toEqual(snap);
    expect((plan as any).weird).toBe(1);
    expect(plan.submodules_per_step?.['5']).toEqual(['content-writer', a.cardId]); // legacy string intact
  });
});

describe('removeCard', () => {
  it('cascades to card_definitions, placement, and routing; drops emptied rule keys; leaves legacy strings', () => {
    let plan: any = { submodules_per_step: { '5': ['content-writer'] } }; // a legacy string at step 5
    const w = addCard(plan, writerInput, { round1: true }); plan = w.plan;
    const pse = addCard(plan, pseInput, { round1: true }); plan = pse.plan;
    plan = setRoutingTargets(plan, 'citation:fail', [{ step: 5, card_id: w.cardId }]);
    plan = removeCard(plan, w.cardId);
    expect(plan.card_definitions[w.cardId]).toBeUndefined();
    expect(plan.submodules_per_step['5']).toEqual(['content-writer']); // card gone, legacy string kept
    expect(plan.routing_rules['citation:fail']).toBeUndefined();       // emptied rule pruned
    expect(plan.card_definitions[pse.cardId]).toBeTruthy();            // other card intact
  });
  it('is idempotent (removing a non-existent card is a stable no-op)', () => {
    const a = addCard({}, writerInput, { round1: true }).plan;
    const once = removeCard(a, GHOST);
    const twice = removeCard(once, GHOST);
    expect(twice).toEqual(once);
  });
  it('is immutable and passes unknown keys through', () => {
    const a = addCard({ future: [1] } as any, writerInput, { round1: true });
    const snap = structuredClone(a.plan);
    const plan = removeCard(a.plan, a.cardId);
    expect(a.plan).toEqual(snap);
    expect((plan as any).future).toEqual([1]);
  });
});

describe('setRoutingTargets', () => {
  it('emits §2.1 array form; empty list removes the key', () => {
    const w = addCard({}, writerInput, { round1: false });
    let plan = setRoutingTargets(w.plan, 'citation:fail', [{ step: 5, card_id: w.cardId }]);
    expect(plan.routing_rules?.['citation:fail']).toEqual([{ step: 5, card_id: w.cardId }]);
    plan = setRoutingTargets(plan, 'citation:fail', []);
    expect(plan.routing_rules?.['citation:fail']).toBeUndefined();
  });
  it('rule 10: throws on a card_id not in card_definitions — message matches the server validator verbatim', () => {
    const w = addCard({}, writerInput, { round1: false });
    let clientMsg = '';
    try { setRoutingTargets(w.plan, 'citation:fail', [{ step: 5, card_id: GHOST }]); } catch (e) { clientMsg = (e as Error).message; }
    const serverErrs = validateExecutionPlan({ ...w.plan, routing_rules: { 'citation:fail': [{ step: 5, card_id: GHOST }] } }, opts).errors;
    expect(clientMsg).toBeTruthy();
    expect(serverErrs).toContain(clientMsg);
  });
  it('rule 11: throws when the target card has no round > 1 — message matches the server validator verbatim', () => {
    const a = addCard({}, pseInput, { round1: true }); // pse is round-1-only
    let clientMsg = '';
    try { setRoutingTargets(a.plan, 'keyword:fail', [{ step: 1, card_id: a.cardId }]); } catch (e) { clientMsg = (e as Error).message; }
    const serverErrs = validateExecutionPlan({ ...a.plan, routing_rules: { 'keyword:fail': [{ step: 1, card_id: a.cardId }] } }, opts).errors;
    expect(clientMsg).toBeTruthy();
    expect(serverErrs).toContain(clientMsg);
  });
  it('is immutable and passes unknown keys through', () => {
    const w = addCard({ future: 9 } as any, writerInput, { round1: false });
    const snap = structuredClone(w.plan);
    const plan = setRoutingTargets(w.plan, 'citation:fail', [{ step: 5, card_id: w.cardId }]);
    expect(w.plan).toEqual(snap);
    expect((plan as any).future).toBe(9);
  });
});

describe('setCardRounds', () => {
  it('replaces a card\'s rounds (identity unchanged)', () => {
    const w = addCard({}, writerInput, { round1: false });
    const plan = setCardRounds(w.plan, w.cardId, { '1': {}, '2': { ai_model: 'opus' } });
    expect(plan.card_definitions?.[w.cardId].rounds).toEqual({ '1': {}, '2': { ai_model: 'opus' } });
    expect(plan.card_definitions?.[w.cardId].card_name).toBe('content-writer-v2'); // identity preserved
  });
  it('is strict: rounds missing "1" throws', () => {
    const w = addCard({}, writerInput, { round1: false });
    expect(() => setCardRounds(w.plan, w.cardId, { '2': { temperature: 0.2 } } as any)).toThrow(/round "1"/i);
  });
  it('unknown card is a no-op', () => {
    const before = { card_definitions: {} };
    expect(setCardRounds(before, GHOST, { '1': {} })).toEqual(before);
  });
});

describe('editor output is accepted by the REAL server save validator (cross-tree contract)', () => {
  it('a full plan built via the editor validates clean (§9)', () => {
    let plan: any = { submodules_per_step: { '5': ['content-writer'] } };
    const w = addCard(plan, writerInput, { round1: false }); plan = w.plan;
    const pse = addCard(plan, pseInput, { round1: true }); plan = pse.plan;
    plan = setRoutingTargets(plan, 'citation:fail', [{ step: 5, card_id: w.cardId }]);
    expect(validateExecutionPlan(plan, opts).errors).toEqual([]);
  });
});
