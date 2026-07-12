// cardPlanEditor — the canonical atomic execution_plan builders (v6 SCALAR-round model, unit 2.4).
// Run: `npm test` (client) or `npx vitest run`. NOT in the server `npm test` gate; NOT in tsc -b.
// Cross-checks the client's rule-10/11 messages against the REAL server validator.
//
// v6 reshape: a card carries a SCALAR `round` + FLAT `overrides` (the per-round `rounds` MAP is
// dropped). addCard/setCardRounds/createAndRoute all write scalar-only cards. A Round-1 card is
// placed (submodules_per_step); a routing-only card starts at round 2 (option (e)).
import { describe, it, expect } from 'vitest';
import {
  mintCardId, addCard, setCardPlacement, removeCard, setRoutingTargets, setCardRounds, renameCard,
  addRoutingTarget, createAndRoute,
} from './cardPlanEditor.ts';
// The exact gate PUT /api/templates/:id runs — proves "server-matching messages" + acceptance:
import { validateExecutionPlan } from '../../../server/services/executionPlanUtils.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GHOST = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const opts = { isRegisteredSubmodule: (id: string) => ['google-pse-curated-search', 'content-writer', 'sitemap-parser'].includes(id) };

// Round-1 (placed) content-writer; a Round-2 (routing-only) escalation; a Round-1 pse.
const writer1Input = { card_name: 'content-writer', submodule_id: 'content-writer', step: 5, round: 1, overrides: {} };
const writer2Input = { card_name: 'content-writer-v2', submodule_id: 'content-writer', step: 5, round: 2, overrides: { temperature: 0.3, prompt: 'stricter' } };
const pseInput = { card_name: 'pse-directories', submodule_id: 'google-pse-curated-search', step: 1, round: 1, overrides: { curated_list: 'directories' } };

describe('mintCardId', () => {
  it('returns a fresh valid UUID (contract 1: client-side mint)', () => {
    expect(mintCardId()).toMatch(UUID_RE);
    expect(mintCardId()).not.toBe(mintCardId());
  });
});

describe('addCard (v6 scalar-only)', () => {
  it('round1: writes a SCALAR card + placement at String(step) in one transform', () => {
    const { plan, cardId } = addCard({}, pseInput, { round1: true });
    expect(cardId).toMatch(UUID_RE);
    expect(plan.card_definitions?.[cardId]).toEqual({ card_name: 'pse-directories', submodule_id: 'google-pse-curated-search', step: 1, round: 1, overrides: { curated_list: 'directories' } });
    expect(plan.card_definitions?.[cardId]).not.toHaveProperty('rounds'); // scalar-only: no rounds map
    expect(plan.submodules_per_step?.['1']).toEqual([cardId]);
  });
  it('retry-only (round 2): card_definitions only, no placement', () => {
    const { plan, cardId } = addCard({}, writer2Input, { round1: false });
    expect(plan.card_definitions?.[cardId]?.round).toBe(2);
    expect(plan.submodules_per_step?.['5']).toBeUndefined();
  });
  it('defaults overrides to {} when omitted', () => {
    const { plan, cardId } = addCard({}, { card_name: 'x', submodule_id: 'content-writer', step: 5, round: 1 }, { round1: true });
    expect(plan.card_definitions?.[cardId]?.overrides).toEqual({});
  });
  it('honours a pre-minted cardId', () => {
    const id = mintCardId();
    expect(addCard({}, { ...writer2Input, cardId: id }, { round1: false }).cardId).toBe(id);
  });
  it('preserves description only when provided', () => {
    const noDesc = addCard({}, writer2Input, { round1: false });
    expect('description' in noDesc.plan.card_definitions![noDesc.cardId]).toBe(false);
    const withDesc = addCard({}, { ...writer2Input, description: 'note' }, { round1: false });
    expect(withDesc.plan.card_definitions![withDesc.cardId].description).toBe('note');
  });
  it('deep-copies overrides — mutating the caller\'s object after the call cannot alias stored state', () => {
    const overrides = { prompt: 'orig' };
    const { plan, cardId } = addCard({}, { ...writer2Input, overrides }, { round1: false });
    (overrides as any).prompt = 'MUTATED';
    expect((plan.card_definitions![cardId].overrides as any).prompt).toBe('orig');
  });
  it('is immutable and passes unknown plan keys through untouched', () => {
    const orig = { skip_steps: [3], failure_thresholds: { '6': 0.2 }, weird_future_key: { a: 1 }, submodules_per_step: { '1': ['sitemap-parser'] } };
    const snap = structuredClone(orig);
    const { plan } = addCard(orig, pseInput, { round1: true });
    expect(orig).toEqual(snap);
    expect(plan.skip_steps).toEqual([3]);
    expect((plan as any).weird_future_key).toEqual({ a: 1 });
    expect(plan.submodules_per_step!['1']).toContain('sitemap-parser');
  });
});

describe('setCardPlacement (the Round-1/retry toggle)', () => {
  it('round1:true places an existing card at its step; idempotent (no duplicate)', () => {
    const a = addCard({}, writer2Input, { round1: false });
    let plan = setCardPlacement(a.plan, a.cardId, { round1: true });
    expect(plan.submodules_per_step?.['5']).toEqual([a.cardId]);
    plan = setCardPlacement(plan, a.cardId, { round1: true });
    expect(plan.submodules_per_step?.['5']).toEqual([a.cardId]);
  });
  it('round1:false removes the card from placement (retry-only)', () => {
    const a = addCard({}, writer1Input, { round1: true });
    const plan = setCardPlacement(a.plan, a.cardId, { round1: false });
    expect(plan.submodules_per_step?.['5'] ?? []).not.toContain(a.cardId);
  });
  it('unknown card is a no-op', () => {
    const before = { card_definitions: {}, submodules_per_step: { '1': ['sitemap-parser'] } };
    expect(setCardPlacement(before, GHOST, { round1: true })).toEqual(before);
  });
});

describe('removeCard', () => {
  it('cascades to card_definitions, placement, and routing; drops emptied rule keys; leaves legacy strings', () => {
    let plan: any = { submodules_per_step: { '5': ['content-writer'] } };
    const w1 = addCard(plan, writer1Input, { round1: true }); plan = w1.plan;
    const w2 = addCard(plan, writer2Input, { round1: false }); plan = w2.plan;
    plan = setRoutingTargets(plan, 'citation:fail', [{ step: 5, card_id: w2.cardId }]);
    plan = removeCard(plan, w2.cardId);
    expect(plan.card_definitions[w2.cardId]).toBeUndefined();
    expect(plan.routing_rules['citation:fail']).toBeUndefined();       // emptied rule pruned
    expect(plan.card_definitions[w1.cardId]).toBeTruthy();              // other card intact
  });
  it('is idempotent (removing a non-existent card is a stable no-op)', () => {
    const a = addCard({}, writer1Input, { round1: true }).plan;
    const once = removeCard(a, GHOST);
    expect(removeCard(once, GHOST)).toEqual(once);
  });
});

describe('setRoutingTargets', () => {
  it('emits §2.1 array form; empty list removes the key', () => {
    const w = addCard({}, writer2Input, { round1: false });
    let plan = setRoutingTargets(w.plan, 'citation:fail', [{ step: 5, card_id: w.cardId }]);
    expect(plan.routing_rules?.['citation:fail']).toEqual([{ step: 5, card_id: w.cardId }]);
    plan = setRoutingTargets(plan, 'citation:fail', []);
    expect(plan.routing_rules?.['citation:fail']).toBeUndefined();
  });
  it('rule 10: throws on a card_id not in card_definitions — message matches the server validator verbatim', () => {
    const w = addCard({}, writer2Input, { round1: false });
    let clientMsg = '';
    try { setRoutingTargets(w.plan, 'citation:fail', [{ step: 5, card_id: GHOST }]); } catch (e) { clientMsg = (e as Error).message; }
    const serverErrs = validateExecutionPlan({ ...w.plan, routing_rules: { 'citation:fail': [{ step: 5, card_id: GHOST }] } }, opts).errors;
    expect(clientMsg).toBeTruthy();
    expect(serverErrs).toContain(clientMsg);
  });
  it('rule 11: throws when the target card has round not > 1 — message matches the server validator verbatim', () => {
    const a = addCard({}, pseInput, { round1: true }); // pse is round 1
    let clientMsg = '';
    try { setRoutingTargets(a.plan, 'keyword:fail', [{ step: 1, card_id: a.cardId }]); } catch (e) { clientMsg = (e as Error).message; }
    const serverErrs = validateExecutionPlan({ ...a.plan, routing_rules: { 'keyword:fail': [{ step: 1, card_id: a.cardId }] } }, opts).errors;
    expect(clientMsg).toBeTruthy();
    expect(serverErrs).toContain(clientMsg);
  });
});

describe('setCardRounds (v6 scalar — replaces the card\'s flat overrides)', () => {
  it('replaces overrides (identity + round unchanged)', () => {
    const w = addCard({}, writer2Input, { round1: false });
    const plan = setCardRounds(w.plan, w.cardId, { ai_model: 'opus' });
    expect(plan.card_definitions?.[w.cardId].overrides).toEqual({ ai_model: 'opus' });
    expect(plan.card_definitions?.[w.cardId].round).toBe(2);           // scalar round preserved
    expect(plan.card_definitions?.[w.cardId].card_name).toBe('content-writer-v2');
  });
  it('throws when overrides is not an object', () => {
    const w = addCard({}, writer2Input, { round1: false });
    expect(() => setCardRounds(w.plan, w.cardId, 'nope' as never)).toThrow(/overrides must be an object/i);
  });
  it('unknown card is a no-op', () => {
    const before = { card_definitions: {} };
    expect(setCardRounds(before, GHOST, {})).toEqual(before);
  });
});

describe('addRoutingTarget (append-not-replace)', () => {
  it('appends to a fail key without dropping the existing targets', () => {
    const a = addCard({}, { card_name: 'a', submodule_id: 'content-writer', step: 5, round: 2, overrides: {} }, { round1: false });
    const b = addCard(a.plan, { card_name: 'b', submodule_id: 'content-writer', step: 5, round: 3, overrides: {} }, { round1: false });
    let plan = setRoutingTargets(b.plan, 'citation:fail', [{ step: 5, card_id: a.cardId }]);
    const existing = plan.routing_rules!['citation:fail'];
    plan = addRoutingTarget(plan, 'citation:fail', existing, { step: 5, card_id: b.cardId });
    expect(plan.routing_rules!['citation:fail']).toEqual([{ step: 5, card_id: a.cardId }, { step: 5, card_id: b.cardId }]);
  });
  it('re-enforces rule 10 (unknown target card throws)', () => {
    const a = addCard({}, writer2Input, { round1: false });
    expect(() => addRoutingTarget(a.plan, 'citation:fail', [], { step: 5, card_id: GHOST })).toThrow(/not found in card_definitions/i);
  });
});

describe('createAndRoute (v6: a routing-only round-2 card — option (e))', () => {
  it('creates a retry-only scalar round-2 card AND routes to it, in one plan; passes §9', () => {
    const { plan, cardId } = createAndRoute({}, { card_name: 'writer-v2', submodule_id: 'content-writer', step: 5 }, 'citation:fail', []);
    const card = plan.card_definitions![cardId];
    expect(card.round).toBe(2);                                          // scalar round 2 (rule 11)
    expect(card).not.toHaveProperty('rounds');                          // scalar-only
    expect(plan.submodules_per_step?.['5'] ?? []).not.toContain(cardId); // routing-only (not placed)
    expect(plan.routing_rules!['citation:fail']).toEqual([{ step: 5, card_id: cardId }]);
    expect(validateExecutionPlan(plan, opts).errors).toEqual([]);
  });
  it('preserves existing targets on the same fail key (append)', () => {
    const first = createAndRoute({}, { card_name: 'a', submodule_id: 'content-writer', step: 5 }, 'citation:fail', []);
    const second = createAndRoute(first.plan, { card_name: 'b', submodule_id: 'content-writer', step: 5 }, 'citation:fail', first.plan.routing_rules!['citation:fail']);
    expect(second.plan.routing_rules!['citation:fail'].map((t) => t.card_id)).toEqual([first.cardId, second.cardId]);
  });
});

describe('renameCard', () => {
  it('changes card_name, preserves identity + round + overrides; immutable', () => {
    const w = addCard({}, writer2Input, { round1: false });
    const snap = structuredClone(w.plan);
    const plan = renameCard(w.plan, w.cardId, 'content-writer-v3');
    expect(plan.card_definitions?.[w.cardId].card_name).toBe('content-writer-v3');
    expect(plan.card_definitions?.[w.cardId].round).toBe(2);
    expect(plan.card_definitions?.[w.cardId].overrides).toEqual(writer2Input.overrides);
    expect(w.plan).toEqual(snap);
  });
  it('unknown card is a no-op', () => {
    const before = { card_definitions: {} };
    expect(renameCard(before, GHOST, 'x')).toEqual(before);
  });
});

describe('editor output is accepted by the REAL server save validator (cross-tree contract)', () => {
  it('a full v6 scalar plan built via the editor validates clean (§9)', () => {
    let plan: any = { submodules_per_step: {} };
    const pse = addCard(plan, pseInput, { round1: true }); plan = pse.plan;           // r1 placed @1
    const w1 = addCard(plan, writer1Input, { round1: true }); plan = w1.plan;         // r1 placed @5
    const cr = createAndRoute(plan, { card_name: 'content-writer-v2', submodule_id: 'content-writer', step: 5 }, 'citation:fail', []); // r2 routing-only @5
    plan = cr.plan;
    expect(validateExecutionPlan(plan, opts).errors).toEqual([]);
  });
  it('the two-Round-1-clones shape validates (D8)', () => {
    let plan: any = { submodules_per_step: {} };
    const a = addCard(plan, { card_name: 'writer-a', submodule_id: 'content-writer', step: 5, round: 1, overrides: { prompt: 'a' } }, { round1: true }); plan = a.plan;
    const b = addCard(plan, { card_name: 'writer-b', submodule_id: 'content-writer', step: 5, round: 1, overrides: { prompt: 'b' } }, { round1: true }); plan = b.plan;
    expect(plan.submodules_per_step['5']).toEqual([a.cardId, b.cardId]); // both placed, array order
    expect(validateExecutionPlan(plan, opts).errors).toEqual([]);
  });
});
