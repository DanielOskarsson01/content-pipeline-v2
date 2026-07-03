// cardPlanView.ts — pure READ/derivation helpers over a TemplateExecutionPlan.
// The write side is cardPlanEditor.ts; this side answers the questions the variant rows + pane
// need to render (which cards belong to a submodule, is a card placed in Round 1, what routes to it).
// Pure + immutable — never mutates the plan.

import type { TemplateExecutionPlan, CardDefinition } from '../types/step';

const VALID_ROUND_KEYS = ['1', '2', '3', '4'];

/** The canonical QA-failure routing keys (display/convention set for the routing editor). The runtime
 *  derives keys generically as `${check}:fail`; the routing editor also shows any extra keys present
 *  in routing_rules. One home for this list (the dead RoutingRulesSection's copy is deleted in item 9). */
export const FAILURE_TYPES = ['hallucination:fail', 'citation:fail', 'keyword:fail', 'meta:fail', 'structural:fail'] as const;

/** All cards (variants) defined for a submodule, in card_name order (stable display). */
export function cardsForSubmodule(
  plan: TemplateExecutionPlan | undefined,
  submoduleId: string,
): Array<{ cardId: string; card: CardDefinition }> {
  const defs = plan?.card_definitions ?? {};
  return Object.entries(defs)
    .filter(([, card]) => card?.submodule_id === submoduleId)
    .map(([cardId, card]) => ({ cardId, card }))
    .sort((a, b) => (a.card.card_name || '').localeCompare(b.card.card_name || ''));
}

/** Is the card placed in submodules_per_step[card.step] (Round-1), vs retry-only? */
export function cardIsRound1(plan: TemplateExecutionPlan | undefined, cardId: string): boolean {
  const card = plan?.card_definitions?.[cardId];
  if (!card) return false;
  const entries = plan?.submodules_per_step?.[String(card.step)] ?? [];
  return entries.includes(cardId);
}

/** Which "{check}:fail" routing keys target this card, and whether any do. */
export function cardRoutingInfo(
  plan: TemplateExecutionPlan | undefined,
  cardId: string,
): { routed: boolean; failKeys: string[] } {
  const rules = plan?.routing_rules ?? {};
  const failKeys: string[] = [];
  for (const [failKey, targets] of Object.entries(rules)) {
    if (Array.isArray(targets) && targets.some((t) => t?.card_id === cardId)) failKeys.push(failKey);
  }
  return { routed: failKeys.length > 0, failKeys };
}

/** The card's present round keys ("1".."4"), sorted ascending. (`object` so it accepts both the
 *  `CardRounds` interface and a plain `Record` — interfaces aren't assignable to `Record<string,…>`.) */
export function roundKeys(card: { rounds?: object } | undefined): string[] {
  const rounds = card?.rounds ?? {};
  return Object.keys(rounds).filter((k) => VALID_ROUND_KEYS.includes(k)).sort();
}

/** The next contiguous retry round to add ("2".."4"), or null once round 4 exists (max 4). */
export function nextRoundKey(card: { rounds?: object } | undefined): string | null {
  const nums = roundKeys(card).map(Number);
  const max = nums.length ? Math.max(...nums) : 0;
  return max >= 4 ? null : String(max + 1);
}

// ── Run-tab (view-only) derivation ──────────────────────────────────────────────
// The run index is a STATIC plan-capability view ("does this card DECLARE round N + is it
// routed"), NOT a per-entity live round counter. Run 1 = placed entries (cards + legacy strings);
// Run N>1 = routed cards that declare round N.

export type RunEntry =
  | { kind: 'card'; cardId: string; card: CardDefinition }
  | { kind: 'legacy'; submoduleId: string };

/** Is a card active on run N? Run 1 = placed in submodules_per_step; Run N>1 = routed AND declares round N. */
export function cardActiveInRun(plan: TemplateExecutionPlan | undefined, cardId: string, runN: number): boolean {
  if (runN === 1) return cardIsRound1(plan, cardId);
  const card = plan?.card_definitions?.[cardId];
  return Boolean(card) && cardRoutingInfo(plan, cardId).routed && roundKeys(card).includes(String(runN));
}

/** What executes on run N. Run 1 = every submodules_per_step entry (cards tagged vs legacy strings,
 *  in order); Run N>1 = the routed cards that declare round N (cards only; sorted by card_name). */
export function runEntries(plan: TemplateExecutionPlan | undefined, runN: number): RunEntry[] {
  const defs = plan?.card_definitions ?? {};
  if (runN === 1) {
    const out: RunEntry[] = [];
    const seen = new Set<string>();
    for (const entries of Object.values(plan?.submodules_per_step ?? {})) {
      for (const e of entries) {
        if (typeof e !== 'string' || seen.has(e)) continue;
        seen.add(e);
        if (defs[e]) out.push({ kind: 'card', cardId: e, card: defs[e] });
        else out.push({ kind: 'legacy', submoduleId: e });
      }
    }
    return out;
  }
  return Object.entries(defs)
    .filter(([cardId]) => cardActiveInRun(plan, cardId, runN))
    .map(([cardId, card]) => ({ kind: 'card' as const, cardId, card }))
    .sort((a, b) => (a.card.card_name || '').localeCompare(b.card.card_name || ''));
}

/** The run tabs to show: always [1]; N∈[2,4] only when ≥1 card is active on run N. Never a zero-card run. */
export function availableRuns(plan: TemplateExecutionPlan | undefined): number[] {
  const runs = [1];
  for (const n of [2, 3, 4]) if (runEntries(plan, n).length > 0) runs.push(n);
  return runs;
}

/** Cards of a submodule that are VALID routing targets (§9 rule 11: at least one round > 1). Rule 10
 *  (exists in card_definitions) holds by construction. Used to gate the "+ add target" dropdown so an
 *  invalid PUT is impossible. */
export function routableCardsForSubmodule(
  plan: TemplateExecutionPlan | undefined,
  submoduleId: string,
): Array<{ cardId: string; card: CardDefinition }> {
  return cardsForSubmodule(plan, submoduleId).filter(({ card }) => roundKeys(card).some((k) => Number(k) > 1));
}
