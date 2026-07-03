// cardPlanView.ts — pure READ/derivation helpers over a TemplateExecutionPlan.
// The write side is cardPlanEditor.ts; this side answers the questions the variant rows + pane
// need to render (which cards belong to a submodule, is a card placed in Round 1, what routes to it).
// Pure + immutable — never mutates the plan.

import type { TemplateExecutionPlan, CardDefinition } from '../types/step';

const VALID_ROUND_KEYS = ['1', '2', '3', '4'];

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

/** The card's present round keys ("1".."4"), sorted ascending. */
export function roundKeys(card: { rounds?: Record<string, unknown> } | undefined): string[] {
  const rounds = card?.rounds ?? {};
  return Object.keys(rounds).filter((k) => VALID_ROUND_KEYS.includes(k)).sort();
}

/** The next contiguous retry round to add ("2".."4"), or null once round 4 exists (max 4). */
export function nextRoundKey(card: { rounds?: Record<string, unknown> } | undefined): string | null {
  const nums = roundKeys(card).map(Number);
  const max = nums.length ? Math.max(...nums) : 0;
  return max >= 4 ? null : String(max + 1);
}
