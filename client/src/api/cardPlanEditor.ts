// cardPlanEditor.ts — the SIX canonical, pure, immutable builders for the Multi-Card execution_plan.
//
// The card UI builds a corrected-shape plan with these and PUTs it via
// api.updateTemplate(id, { execution_plan }) (client/src/api/client.ts). The UI must NEVER
// hand-edit execution_plan JSON — every card mutation routes through here so the atomic
// dual-write (card_definitions + submodules_per_step) can never desync.
//
// Invariants held by ALL six functions:
//   • Immutable — the input plan is never mutated; a new plan is returned.
//   • Unknown plan keys pass through untouched (spread `...plan`) — forward-compatible.
//   • Legacy string entries in submodules_per_step are preserved (only card UUIDs are touched).
//
// Contracts locked as code:
//   1  card_id is minted CLIENT-SIDE at clone time (mintCardId).
//   2  ATOMIC dual-write — a Round-1 card lives in BOTH card_definitions and
//      submodules_per_step[String(step)]; a retry-only card lives in card_definitions only.
//      addCard / setCardPlacement / removeCard own both keys in one transform.

import type {
  TemplateExecutionPlan,
  CardDefinition,
  CardRoundOverrides,
  RoutingTarget,
} from '../types/step';

/** Contract 1 — mint the card_id client-side at clone time. Stable identity; rename changes card_name only. */
export function mintCardId(): string {
  return crypto.randomUUID();
}

export interface NewCardInput {
  card_name: string;
  submodule_id: string;
  step: number;
  /** v6 scalar: the round this card IS (1 = placed first-pass, >1 = routing-only retry). */
  round: number;
  /** v6 scalar: this round's flat option overrides (defaults to {}). */
  overrides?: CardRoundOverrides;
  description?: string;
  /** Pre-minted id (deterministic tests / cloning a known card); defaults to mintCardId(). */
  cardId?: string;
}

// ── internal helpers (submodules_per_step is the shared, two-vocabulary array) ──

/** Add cardId to submodules_per_step[stepKey] (idempotent); returns a new sps object. */
function placeCardId(
  sps: Record<string, string[]> | undefined,
  stepKey: string,
  cardId: string,
): Record<string, string[]> {
  const existing = sps?.[stepKey] ?? [];
  return {
    ...(sps ?? {}),
    [stepKey]: existing.includes(cardId) ? existing : [...existing, cardId],
  };
}

/** Remove cardId from EVERY step list (leaves legacy string entries intact); returns a new sps object. */
function unplaceCardId(
  sps: Record<string, string[]> | undefined,
  cardId: string,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [stepKey, entries] of Object.entries(sps ?? {})) {
    out[stepKey] = entries.filter((e) => e !== cardId);
  }
  return out;
}

/**
 * Add (or replace) a card. Atomic dual-write: writes card_definitions[cardId] always, and —
 * for a Round-1 card (`round1: true`) — places the card_id in submodules_per_step[String(step)]
 * in the SAME new plan. A retry-only card (`round1: false`) is written to card_definitions only.
 */
export function addCard(
  plan: TemplateExecutionPlan,
  input: NewCardInput,
  opts: { round1: boolean },
): { plan: TemplateExecutionPlan; cardId: string } {
  const cardId = input.cardId ?? mintCardId();
  const card: CardDefinition = {
    card_name: input.card_name,
    submodule_id: input.submodule_id,
    step: input.step,
    round: input.round,
    // deep-copy so a caller mutating its own `overrides` object after the call can't alias stored state
    overrides: structuredClone(input.overrides ?? {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
  const next: TemplateExecutionPlan = {
    ...plan,
    card_definitions: { ...(plan.card_definitions ?? {}), [cardId]: card },
  };
  if (opts.round1) {
    next.submodules_per_step = placeCardId(next.submodules_per_step, String(input.step), cardId);
  }
  return { plan: next, cardId };
}

/**
 * The sixth function — the Round-1 ⇄ retry-only TOGGLE, as an atomic dual-write.
 * `round1: true`  → place the card_id in submodules_per_step[String(card.step)] (idempotent).
 * `round1: false` → remove the card_id from every step list (retry-only).
 * No-op if the card is not in card_definitions. This is the single control that flips a card
 * between Round-1 and retry-only, so the UI never edits submodules_per_step directly.
 */
export function setCardPlacement(
  plan: TemplateExecutionPlan,
  cardId: string,
  opts: { round1: boolean },
): TemplateExecutionPlan {
  const card = plan.card_definitions?.[cardId];
  if (!card) return plan; // unknown card → no-op
  const sps = opts.round1
    ? placeCardId(plan.submodules_per_step, String(card.step), cardId)
    : unplaceCardId(plan.submodules_per_step, cardId);
  return { ...plan, submodules_per_step: sps };
}

/**
 * Atomic removal — drops the card from card_definitions AND every submodules_per_step list AND
 * every routing_rules target (pruning rule keys left empty), in one immutable transform. Idempotent
 * (removing an absent card is a stable no-op). Prevents the dangling-UUID corruption §9 rejects.
 */
export function removeCard(plan: TemplateExecutionPlan, cardId: string): TemplateExecutionPlan {
  const cardDefs = { ...(plan.card_definitions ?? {}) };
  delete cardDefs[cardId];

  const routing: Record<string, RoutingTarget[]> = {};
  for (const [failKey, targets] of Object.entries(plan.routing_rules ?? {})) {
    if (!Array.isArray(targets)) continue; // defensive: skip malformed non-array values (server rejects them anyway)
    const kept = targets.filter((t) => t.card_id !== cardId);
    if (kept.length) routing[failKey] = kept; // drop emptied rule keys
  }

  return {
    ...plan,
    card_definitions: cardDefs,
    submodules_per_step: unplaceCardId(plan.submodules_per_step, cardId),
    routing_rules: routing,
  };
}

/**
 * Set the routing targets for a "{qa_check}:fail" key (§2.1 array form). Empty list removes the key.
 * Enforces §9 rules 10 & 11 CLIENT-SIDE with messages IDENTICAL to the server validator
 * (executionPlanUtils.validateExecutionPlan), so the UI fails fast with the same text the PUT would 400 with.
 */
export function setRoutingTargets(
  plan: TemplateExecutionPlan,
  failKey: string,
  targets: RoutingTarget[],
): TemplateExecutionPlan {
  const cardDefs = plan.card_definitions ?? {};
  for (const target of targets) {
    const cid = target.card_id;
    const card = cardDefs[cid];
    if (!card) {
      // §9 rule 10 — verbatim server message
      throw new Error(`routing_rules["${failKey}"]: card_id ${cid} not found in card_definitions`);
    }
    // §9 rule 11 (v6 scalar) — a routing target must be a retry variant (round > 1).
    if (!(Number.isInteger(card.round) && (card.round as number) > 1)) {
      // §9 rule 11 — verbatim server message
      throw new Error(`routing_rules["${failKey}"]: card ${cid} has no round > 1 (routing can never escalate)`);
    }
  }
  const routing = { ...(plan.routing_rules ?? {}) };
  if (targets.length === 0) delete routing[failKey];
  else routing[failKey] = targets;
  return { ...plan, routing_rules: routing };
}

/**
 * Replace a card's FLAT overrides (v6 scalar model — card identity + `round` unchanged). Semantics
 * changed in unit 2.4: a card is exactly ONE round now, so there is no `rounds` map and no round-1
 * presence check — this just sets the single `overrides` object. No-op if the card is absent.
 */
export function setCardRounds(
  plan: TemplateExecutionPlan,
  cardId: string,
  overrides: CardRoundOverrides,
): TemplateExecutionPlan {
  const existing = plan.card_definitions?.[cardId];
  if (!existing) return plan; // unknown card → no-op
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error(`setCardRounds: overrides must be an object (card ${cardId})`);
  }
  return {
    ...plan,
    // deep-copy so the stored card can't alias the caller's object (see addCard)
    card_definitions: { ...plan.card_definitions, [cardId]: { ...existing, overrides: structuredClone(overrides) } },
  };
}

/** Rename a card (display name only; card_id identity unchanged). No-op if the card is absent. */
export function renameCard(
  plan: TemplateExecutionPlan,
  cardId: string,
  cardName: string,
): TemplateExecutionPlan {
  const existing = plan.card_definitions?.[cardId];
  if (!existing) return plan;
  return {
    ...plan,
    card_definitions: { ...plan.card_definitions, [cardId]: { ...existing, card_name: cardName } },
  };
}

/**
 * APPEND a routing target to a "{check}:fail" key — the spread-not-replace contract.
 * `setRoutingTargets` REPLACES the whole target list, so an "+ add target" handler MUST pass the
 * existing targets too; this wrapper enforces that (passing only the new target would silently drop
 * the others). Re-runs the §9 rule 10/11 checks via setRoutingTargets.
 */
export function addRoutingTarget(
  plan: TemplateExecutionPlan,
  failKey: string,
  existingTargets: RoutingTarget[],
  newTarget: RoutingTarget,
): TemplateExecutionPlan {
  return setRoutingTargets(plan, failKey, [...existingTargets, newTarget]);
}

/**
 * Create a retry-only variant AND route a QA failure to it, in ONE plan transform (one PUT at the
 * call site). The card is `round1: false` (retry-only — absent from submodules_per_step) with the
 * v6 scalar `round: 2` so it satisfies rule 11 (round > 1). This is option (e): a routing-only card
 * that starts at round 2 with no round-1 sibling. Returns the plan + the new cardId (open its pane).
 */
export function createAndRoute(
  plan: TemplateExecutionPlan,
  input: { card_name: string; submodule_id: string; step: number },
  failKey: string,
  existingTargets: RoutingTarget[],
): { plan: TemplateExecutionPlan; cardId: string } {
  const { plan: p1, cardId } = addCard(
    plan,
    { card_name: input.card_name, submodule_id: input.submodule_id, step: input.step, round: 2, overrides: {} },
    { round1: false },
  );
  const p2 = setRoutingTargets(p1, failKey, [...existingTargets, { step: input.step, card_id: cardId }]);
  return { plan: p2, cardId };
}
