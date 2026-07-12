// cardPlanView.ts — pure READ/derivation helpers over a TemplateExecutionPlan (v6 SCALAR model).
// The write side is cardPlanEditor.ts; this side answers the questions the round-tabbed step panel,
// variant rows, and Step-7 routing editor need to render. Pure + immutable — never mutates the plan.
//
// v6 (unit 2.6): the per-round `rounds` MAP is gone. Every derivation reads the SCALAR `card.round`
// (D10). "Active at (submodule, step, round N)" ≡ a card exists with round===N for that
// (submodule, step) — a pure derivation, NOT a stored flag (V6-§2.5 DATA MAPPING). The round-map
// helpers (roundKeys / nextRoundKey / cardActiveInRun / runEntries) were deleted in 2.6.

import type { TemplateExecutionPlan, CardDefinition, SubmoduleManifest, SubmoduleOption } from '../types/step';

/** Round tabs the step panel always shows (S2.1 — fixed 1..4, never dynamic). */
export const ROUND_TABS = [1, 2, 3, 4] as const;
/** Highest authored round (validator MAX_ROUNDS). */
export const MAX_ROUND = 4;

/** The canonical QA-failure routing keys (display/convention set for the routing editor). The runtime
 *  derives keys generically as `${check}:fail`; the routing editor also shows any extra keys present
 *  in routing_rules. One home for this list. */
export const FAILURE_TYPES = ['hallucination:fail', 'citation:fail', 'keyword:fail', 'meta:fail', 'structural:fail'] as const;

/** The scalar round a card IS (D10 authority). Absent ⇒ 1 (the placed first-pass default; a card with
 *  no scalar `round` is treated as Round 1, never fabricated from a rounds map — V6-§1.1). */
export function cardRound(card: CardDefinition | undefined): number {
  return Number.isInteger(card?.round) ? (card!.round as number) : 1;
}

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

// ── Scalar round derivations (V6-§2.5 DATA MAPPING) ──────────────────────────────

/** The cards at EXACTLY (submodule, step, round). Round 1 may hold several (clones, S4.d);
 *  round ≥ 2 holds at most one (duplicate-round is a 400, S4.e). Card_name order. */
export function cardsAt(
  plan: TemplateExecutionPlan | undefined,
  submoduleId: string,
  step: number,
  round: number,
): Array<{ cardId: string; card: CardDefinition }> {
  return cardsForSubmodule(plan, submoduleId).filter(
    ({ card }) => card.step === step && cardRound(card) === round,
  );
}

/** Is a submodule ACTIVE in round N at this step? (S2.1 active-vs-greyed.) A card at (submodule, step, N)
 *  makes it active; in round 1 a legacy STRING placement (a submodules_per_step entry that is not a
 *  card_id) also counts — a placed base submodule with no card is still Round-1 active. */
export function submoduleActiveInRound(
  plan: TemplateExecutionPlan | undefined,
  submoduleId: string,
  step: number,
  round: number,
): boolean {
  if (cardsAt(plan, submoduleId, step, round).length > 0) return true;
  if (round === 1) {
    const placed = plan?.submodules_per_step?.[String(step)] ?? [];
    const defs = plan?.card_definitions ?? {};
    // a legacy string entry equal to the submodule id (not a card_id) = placed base submodule
    return placed.some((e) => e === submoduleId && !defs[e]);
  }
  return false;
}

/** The rounds (≠ currentRound) in which this submodule holds a card at this step. Drives the S3.2b
 *  cross-round "Active in Round N" pill on a greyed BASE submodule row. Same step only (cross-step
 *  pills are out of scope). */
export function activeInOtherRounds(
  plan: TemplateExecutionPlan | undefined,
  submoduleId: string,
  step: number,
  currentRound: number,
): number[] {
  const rounds = new Set<number>();
  for (const { card } of cardsForSubmodule(plan, submoduleId)) {
    if (card.step === step) {
      const r = cardRound(card);
      if (r !== currentRound) rounds.add(r);
    }
  }
  return [...rounds].sort((a, b) => a - b);
}

/** D9 dormant (S3.4 amber): a round ≥ 2 (authored escalation) card that NO routing rule can reach.
 *  NEVER true for a round-1 (placed) card — amber is scoped to unreachable escalation cards only,
 *  never a merely-unplaced submodule (D9). */
export function cardIsDormant(plan: TemplateExecutionPlan | undefined, cardId: string): boolean {
  const card = plan?.card_definitions?.[cardId];
  if (!card) return false;
  return cardRound(card) > 1 && !cardRoutingInfo(plan, cardId).routed;
}

/** Cards of a submodule that are VALID routing targets (§9 rule 11: scalar round > 1). Rule 10
 *  (exists in card_definitions) holds by construction. Gates the "+ add target" dropdown so an
 *  invalid PUT is impossible. */
export function routableCardsForSubmodule(
  plan: TemplateExecutionPlan | undefined,
  submoduleId: string,
): Array<{ cardId: string; card: CardDefinition }> {
  return cardsForSubmodule(plan, submoduleId).filter(({ card }) => cardRound(card) > 1);
}

/** Dead-rung rounds (S3.6): rounds N ≥ 3 that this check targets while it has NO target at N-1.
 *  The editor warns because the validator defers interior gaps to the runtime terminus (flag-and-
 *  continue, V6-§3) — "Round N targets will not fire unless a Round N-1 rung exists for this check." */
export function deadRungRounds(plan: TemplateExecutionPlan | undefined, failKey: string): number[] {
  const targets = plan?.routing_rules?.[failKey];
  if (!Array.isArray(targets)) return [];
  const defs = plan?.card_definitions ?? {};
  const roundsWithTarget = new Set<number>();
  for (const t of targets) {
    const c = defs[t?.card_id];
    if (c) roundsWithTarget.add(cardRound(c));
  }
  const dead: number[] = [];
  for (const n of roundsWithTarget) {
    if (n >= 3 && !roundsWithTarget.has(n - 1)) dead.push(n);
  }
  return dead.sort((a, b) => a - b);
}

/** The options a card's Edit slide-over renders: the COMPLETE manifest options — every field the
 *  submodule declares (S4.h). NEVER a subset — the reduced panel is the failure mode that killed the
 *  old ladder design. Content-Writer's full option set is the acceptance case. */
export function optionsForEditor(manifest: SubmoduleManifest | undefined): SubmoduleOption[] {
  return manifest?.options ?? [];
}

/** The submodules_per_step[step] entries in authored ARRAY ORDER (INV-ORDER, V6-§4). Each entry is a
 *  card_id (a placed card, incl. Round-1 clones) or a legacy submodule-id string. The step panel and
 *  the reorder arrows read this order; it is execution order. */
export function placedEntriesForStep(
  plan: TemplateExecutionPlan | undefined,
  step: number,
): string[] {
  return [...(plan?.submodules_per_step?.[String(step)] ?? [])];
}
