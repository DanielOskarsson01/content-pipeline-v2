// cardPlanEditor.ts — pure, immutable builders for the Multi-Card execution_plan.
//
// This is the API-client-side companion to `api.updateTemplate(id, { execution_plan })`
// (client/src/api/client.ts): the UI builds a corrected-shape plan with these functions, then
// PUTs it with api.updateTemplate. Step 2 (the card UI) consumes this module — it must NOT
// hand-edit execution_plan JSON.
//
// LOCKS two Step-1 contracts as code (not prose):
//   • Contract 1 — card_id is minted CLIENT-SIDE at clone time (mintCardId).
//   • Contract 2 — ATOMIC dual-write. A card touches TWO execution_plan keys:
//       card_definitions[cardId]  (always)  +  submodules_per_step[step]  (Round-1 cards only).
//     They must move together or the plan corrupts (a Round-1 card missing from
//     submodules_per_step never runs; a UUID left in submodules_per_step with no
//     card_definitions entry trips the §9 validator / corruption detector). The hazard the
//     reviews flagged: two UI editors mutating the one submodules_per_step array in two
//     vocabularies (submodule-id strings vs card_id UUIDs).
//     MECHANISM: this module is the SINGLE OWNER of those writes. Every function takes the whole
//     plan and returns a NEW whole plan with both keys updated in one immutable transform; the
//     UI then makes ONE api.updateTemplate PUT. Never setState+save card_definitions and
//     submodules_per_step on independent paths — always route through here.

import type {
  TemplateExecutionPlan,
  CardDefinition,
  CardRounds,
  RoutingTarget,
} from '../types/step';

/** Contract 1 — mint the card_id client-side at clone time. The UUID is the card's stable
 *  identity; renames change card_name only, never the id. */
export function mintCardId(): string {
  return crypto.randomUUID();
}

export interface NewCardInput {
  card_name: string;
  submodule_id: string;
  step: number;
  rounds: CardRounds;
  description?: string;
  /** Pre-minted id (e.g. deterministic tests / cloning a known card); defaults to mintCardId(). */
  cardId?: string;
}

/**
 * Add (or replace) a card. Atomic dual-write: writes card_definitions[cardId] always, and —
 * for a Round-1 card (`round1: true`) — appends the card_id to submodules_per_step[step] in the
 * SAME new plan. A retry-only card (`round1: false`) is written to card_definitions only.
 * Returns the new plan plus the cardId (mint it once, reuse for routing targets).
 */
export function addCard(
  plan: TemplateExecutionPlan,
  input: NewCardInput,
  opts: { round1: boolean }
): { plan: TemplateExecutionPlan; cardId: string } {
  const cardId = input.cardId ?? mintCardId();
  const card: CardDefinition = {
    card_name: input.card_name,
    submodule_id: input.submodule_id,
    step: input.step,
    rounds: input.rounds,
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
  const next: TemplateExecutionPlan = {
    ...plan,
    card_definitions: { ...(plan.card_definitions ?? {}), [cardId]: card },
  };
  if (opts.round1) {
    const stepKey = String(input.step);
    const existing = next.submodules_per_step?.[stepKey] ?? [];
    next.submodules_per_step = {
      ...(next.submodules_per_step ?? {}),
      [stepKey]: existing.includes(cardId) ? existing : [...existing, cardId],
    };
  }
  return { plan: next, cardId };
}

/**
 * Atomic removal — drops the card from card_definitions AND every submodules_per_step list AND
 * every routing_rules target (pruning rule keys left empty), in one immutable transform. Prevents
 * the dangling-UUID corruption the §9 validator rejects.
 */
export function removeCard(plan: TemplateExecutionPlan, cardId: string): TemplateExecutionPlan {
  const cardDefs = { ...(plan.card_definitions ?? {}) };
  delete cardDefs[cardId];

  const sps: Record<string, string[]> = {};
  for (const [stepKey, entries] of Object.entries(plan.submodules_per_step ?? {})) {
    sps[stepKey] = entries.filter((e) => e !== cardId);
  }

  const routing: Record<string, RoutingTarget[]> = {};
  for (const [failKey, targets] of Object.entries(plan.routing_rules ?? {})) {
    const kept = targets.filter((t) => t.card_id !== cardId);
    if (kept.length) routing[failKey] = kept;
  }

  return { ...plan, card_definitions: cardDefs, submodules_per_step: sps, routing_rules: routing };
}

/** Set the routing targets for a "{qa_check}:fail" key (array form). An empty list removes the key. */
export function setRoutingTargets(
  plan: TemplateExecutionPlan,
  failKey: string,
  targets: RoutingTarget[]
): TemplateExecutionPlan {
  const routing = { ...(plan.routing_rules ?? {}) };
  if (targets.length === 0) delete routing[failKey];
  else routing[failKey] = targets;
  return { ...plan, routing_rules: routing };
}

/** Replace a card's per-round overrides (card identity unchanged). No-op if the card is absent. */
export function setCardRounds(
  plan: TemplateExecutionPlan,
  cardId: string,
  rounds: CardRounds
): TemplateExecutionPlan {
  const existing = plan.card_definitions?.[cardId];
  if (!existing) return plan;
  return {
    ...plan,
    card_definitions: { ...plan.card_definitions, [cardId]: { ...existing, rounds } },
  };
}
