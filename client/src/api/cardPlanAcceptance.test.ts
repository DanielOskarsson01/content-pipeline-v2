// Unit 2.6 acceptance tests — the behaviors the prompt's TESTS section names, asserted as pure logic
// over the scalar derivations + mutations, cross-checked against the REAL server validator (the exact
// gate PUT /api/templates/:id runs). The repo's client tests are Node-env pure-logic (no DOM), so the
// two "renders" cases (pill, full options) are asserted at the derivation the UI renders, not the DOM.
import { describe, it, expect } from 'vitest';
import {
  addCard, setCardPlacement, removeCard, setRoutingTargets, addRoutingTarget, moveEntryInStep, createAndRoute,
} from './cardPlanEditor.ts';
import {
  cardRound, submoduleActiveInRound, activeInOtherRounds, cardIsDormant, deadRungRounds,
  cardRoutingInfo, optionsForEditor, placedEntriesForStep,
} from './cardPlanView.ts';
import { validateExecutionPlan } from '../../../server/services/executionPlanUtils.js';
import type { SubmoduleManifest } from '../types/step';

const opts = { isRegisteredSubmodule: (id: string) => [
  'content-writer', 'google-pse-curated-search', 'sitemap-parser', 'page-scraper', 'perplexity-finder', 'seo-planner',
].includes(id) };
const clean = (plan: unknown) => validateExecutionPlan(plan, opts).errors;

// 1 ── Toggle-on semantics + client-server parity round-trip.
describe('1. toggle-on round → placement; round-trip validates (client-server parity)', () => {
  it('Round-2 toggle = routing-only card (round 2, NOT placed); Round-1 toggle = placed card', () => {
    const r2 = addCard({}, { card_name: 'writer-r2', submodule_id: 'content-writer', step: 5, round: 2, overrides: {} }, { round1: false });
    expect(r2.plan.card_definitions?.[r2.cardId]?.round).toBe(2);
    expect(r2.plan.submodules_per_step?.['5'] ?? []).not.toContain(r2.cardId); // routing-only

    const r1 = addCard({}, { card_name: 'pse', submodule_id: 'google-pse-curated-search', step: 1, round: 1, overrides: {} }, { round1: true });
    expect(r1.plan.submodules_per_step?.['1']).toContain(r1.cardId);           // placed
  });
  it('a full editor-built plan (round-1 placed + round-2 routed) passes the REAL validator', () => {
    let plan: any = { submodules_per_step: {} };
    const p = addCard(plan, { card_name: 'pse', submodule_id: 'google-pse-curated-search', step: 1, round: 1, overrides: {} }, { round1: true }); plan = p.plan;
    const cr = createAndRoute(plan, { card_name: 'writer-v2', submodule_id: 'content-writer', step: 5 }, 'citation:fail', []); plan = cr.plan;
    expect(clean(plan)).toEqual([]);
  });
});

// 2 ── Two Round-1 clones → two distinct placed cards; order follows the reorder arrows.
describe('2. two Round-1 clones → distinct placed cards, ordered by the arrows (INV-ORDER)', () => {
  it('creates two distinct placed cards in authored array order; reorder swaps them; validates', () => {
    let plan: any = { submodules_per_step: {} };
    const a = addCard(plan, { card_name: 'writer-a', submodule_id: 'content-writer', step: 5, round: 1, overrides: { prompt: 'a' } }, { round1: true }); plan = a.plan;
    const b = addCard(plan, { card_name: 'writer-b', submodule_id: 'content-writer', step: 5, round: 1, overrides: { prompt: 'b' } }, { round1: true }); plan = b.plan;
    expect(a.cardId).not.toBe(b.cardId);                                        // distinct cards
    expect(placedEntriesForStep(plan, 5)).toEqual([a.cardId, b.cardId]);        // authored order
    const moved = moveEntryInStep(plan, 5, b.cardId, -1);                       // arrow: move b earlier
    expect(placedEntriesForStep(moved, 5)).toEqual([b.cardId, a.cardId]);       // order follows the arrow
    expect(clean(moved)).toEqual([]);
  });
});

// 3 ── "Active in Round N" pill on a round-2-only BASE submodule from the Round-1 tab.
describe('3. active-in-round pill (S3.2b)', () => {
  it('a round-2-only base submodule is greyed in round 1 but carries a [Round 2] pill', () => {
    const w = addCard({}, { card_name: 'writer-r2', submodule_id: 'content-writer', step: 5, round: 2, overrides: {} }, { round1: false });
    expect(submoduleActiveInRound(w.plan, 'content-writer', 5, 1)).toBe(false); // greyed in the round-1 tab
    expect(activeInOtherRounds(w.plan, 'content-writer', 5, 1)).toEqual([2]);   // → "Active in Round 2" pill
    expect(submoduleActiveInRound(w.plan, 'content-writer', 5, 2)).toBe(true);  // active in its own tab
  });
});

// 4 ── Unreachable escalation card amber; routing clears it; removing the card cascades the rule.
describe('4. D9 unreachable amber + cascade (S3.4 / S4.f)', () => {
  it('dormant when unrouted; routing clears amber; removing the card drops its rule key', () => {
    const w = addCard({}, { card_name: 'writer-r2', submodule_id: 'content-writer', step: 5, round: 2, overrides: {} }, { round1: false });
    expect(cardIsDormant(w.plan, w.cardId)).toBe(true);                         // amber
    const routed = setRoutingTargets(w.plan, 'citation:fail', [{ step: 5, card_id: w.cardId }]);
    expect(cardIsDormant(routed, w.cardId)).toBe(false);                        // amber cleared
    const removed = removeCard(routed, w.cardId);                              // cascade
    expect(removed.card_definitions?.[w.cardId]).toBeUndefined();
    expect(removed.routing_rules?.['citation:fail']).toBeUndefined();          // emptied rule pruned
  });
});

// 5 ── Dead-rung: Round-3 target with no Round-2 rung → amber; adding a Round-2 target clears it.
describe('5. dead-rung nudge (S3.6)', () => {
  it('round-3 target without a round-2 rung is a dead rung; adding round 2 clears it', () => {
    let plan: any = { submodules_per_step: {} };
    const r3 = addCard(plan, { card_name: 'w3', submodule_id: 'content-writer', step: 5, round: 3, overrides: {} }, { round1: false }); plan = r3.plan;
    plan = setRoutingTargets(plan, 'citation:fail', [{ step: 5, card_id: r3.cardId }]);
    expect(deadRungRounds(plan, 'citation:fail')).toEqual([3]);
    const r2 = addCard(plan, { card_name: 'w2', submodule_id: 'content-writer', step: 5, round: 2, overrides: {} }, { round1: false }); plan = r2.plan;
    plan = addRoutingTarget(plan, 'citation:fail', plan.routing_rules['citation:fail'], { step: 5, card_id: r2.cardId });
    expect(deadRungRounds(plan, 'citation:fail')).toEqual([]);
  });
});

// 6 ── Two checks → same (submodule, step, round): ONE card, two rules; save does not 400.
describe('6. two checks, one card, two rules (S4.e)', () => {
  it('routing two failKeys to the same round-2 card keeps ONE card + two keys and validates clean', () => {
    const w = addCard({}, { card_name: 'writer-r2', submodule_id: 'content-writer', step: 5, round: 2, overrides: {} }, { round1: false });
    let plan = setRoutingTargets(w.plan, 'citation:fail', [{ step: 5, card_id: w.cardId }]);
    plan = setRoutingTargets(plan, 'keyword:fail', [{ step: 5, card_id: w.cardId }]);
    expect(Object.keys(plan.card_definitions ?? {})).toEqual([w.cardId]);       // ONE card
    expect(cardRoutingInfo(plan, w.cardId).failKeys.sort()).toEqual(['citation:fail', 'keyword:fail']); // two rules
    expect(clean(plan)).toEqual([]);                                            // no 400
  });
  it('the NEGATIVE (why the clone dialog disables occupied retry rounds): two cards at (submodule, step, round≥2) IS a 400', () => {
    let plan: any = { submodules_per_step: {} };
    const a = addCard(plan, { card_name: 'w-a', submodule_id: 'content-writer', step: 5, round: 2, overrides: {} }, { round1: false }); plan = a.plan;
    const b = addCard(plan, { card_name: 'w-b', submodule_id: 'content-writer', step: 5, round: 2, overrides: {} }, { round1: false }); plan = b.plan;
    expect(clean(plan).length).toBeGreaterThan(0); // duplicate retry round → validator error (the UI prevents this)
  });
});

// 7 ── Legacy card-less template renders and saves unchanged (no regression).
describe('7. legacy card-less template (no regression)', () => {
  it('a plan with only legacy string placements derives + validates cleanly', () => {
    const legacy = { submodules_per_step: { '1': ['sitemap-parser'], '3': ['page-scraper'] } };
    expect(submoduleActiveInRound(legacy, 'sitemap-parser', 1, 1)).toBe(true);  // legacy string = round-1 active
    expect(submoduleActiveInRound(legacy, 'page-scraper', 3, 1)).toBe(true);
    expect(activeInOtherRounds(legacy, 'sitemap-parser', 1, 1)).toEqual([]);     // no cards → no pills
    expect(placedEntriesForStep(legacy, 1)).toEqual(['sitemap-parser']);         // unchanged
    expect(clean(legacy)).toEqual([]);                                           // validates
  });
});

// 8 ── Full options editor: the slide-over renders the COMPLETE manifest — never a reduced subset.
describe('8. full options editor renders the complete panel (S4.h)', () => {
  // A content-writer-shaped manifest (multi-field, incl. the big prompt textarea).
  const contentWriter = {
    id: 'content-writer', name: 'Content Writer', step: 5,
    options: [
      { name: 'prompt', type: 'textarea', label: 'Prompt' },
      { name: 'ai_model', type: 'select', label: 'Model', values: ['sonnet', 'opus'] },
      { name: 'temperature', type: 'number', label: 'Temperature' },
      { name: 'max_tokens', type: 'number', label: 'Max tokens' },
      { name: 'system_prompt', type: 'textarea', label: 'System prompt' },
      { name: 'reference_docs', type: 'doc_selector', label: 'Reference docs' },
    ],
  } as unknown as SubmoduleManifest;

  it('optionsForEditor returns EVERY manifest field (not a subset) for content-writer', () => {
    const rendered = optionsForEditor(contentWriter);
    expect(rendered.length).toBe(contentWriter.options.length);                 // full, not reduced
    expect(rendered.map((o) => o.name)).toEqual(['prompt', 'ai_model', 'temperature', 'max_tokens', 'system_prompt', 'reference_docs']);
    expect(rendered.some((o) => o.name === 'prompt' && o.type === 'textarea')).toBe(true); // the big field survives
  });
  it('is stable regardless of which fields the card overrides (overrides ≠ visible-field filter)', () => {
    // The old ladder bug: only overridden fields rendered. Here the panel is the full manifest
    // irrespective of the card's sparse overrides.
    expect(optionsForEditor(contentWriter).length).toBe(6);
    expect(optionsForEditor(undefined)).toEqual([]);                            // no manifest → empty, no crash
  });
});
