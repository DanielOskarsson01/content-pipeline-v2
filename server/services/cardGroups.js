/**
 * cardGroups.js — Multi-Card Pattern: per-step grouping of entities by card_id
 *
 * Source spec: PHASE_3B_PER_ENTITY_INSTRUCTIONS_SPEC.md §3.2 + §5.1c
 *              Plan v5 (noble-wandering-graham) Data model commitment 8
 *              Brutal-critic Round 2 Fix #5 (read/write split) + Fix #6 (batch helper)
 *              Sub-plan 1 execution plan §ii section A
 *
 * Responsibility (distinct from sibling service-layer files):
 *   cardInstructions.js   — INSTRUCTION LIFECYCLE (per-entity create/consume/skip RPCs)
 *   executionPlanUtils.js — STEP-ENTRY RESOLUTION (template entry → submodule/card)
 *   cardGroups.js (here)  — GROUP EXPANSION (per step+submodule, partition all entities
 *                            into card-instructed groups + a default group for
 *                            non-routed ones; orchestration glue for autoExecutor)
 *
 *   Called by autoExecutor.processStep to drive per-card batch dispatch.
 */

import {
  findPendingInstructionsForRun,
  cleanupDeletedCardInstructions,
  markSkipped,
  SKIP_REASONS,
} from './cardInstructions.js';

/**
 * For a given (step, submodule_id), group entities by card_id based on pending
 * card_instructions. Default group (card_id=null) holds entities with NO
 * pending instruction for this submodule (these get the default Round 1 path).
 *
 * Per-group invariant: ONE card_id per entity per (step, submodule_id). If an
 * entity has multiple pending instructions for the same submodule at the same
 * step (shouldn't happen post Brutal-critic Round 2 Fix #1 atomic target-level
 * dedup in append_card_instruction; defensive check for pre-Fix-#1 state), the
 * first wins (FIFO by array position) and the rest get markSkipped'd.
 *
 * Orphaned card_ids (instruction references a card_id not in card_definitions —
 * card was deleted from the template after the instruction was written) are
 * cleaned up via cleanupDeletedCardInstructions per spec §3.3.
 *
 * Per Daniel handoff decision 2026-06-02: db is an explicit first parameter
 * matching cardInstructions.js convention. Enables hermetic unit testing
 * with a mock db and matches the established service-layer pattern.
 *
 * @param {object} db                   Supabase client (explicit, mockable)
 * @param {string} runId                pipeline_runs.id
 * @param {number} stepIndex            current step
 * @param {string} submoduleId          submodule being triggered
 * @param {Array<string>} allEntities   all entity names for this run
 * @param {object} cardDefinitions      execution_plan_snapshot.card_definitions
 * @returns {Promise<Array<{
 *   card_id: string|null,
 *   entities: string[],
 *   round_overrides: object,
 *   prompt_overrides: object
 * }>>}
 */
export async function expandCardGroups(db, runId, stepIndex, submoduleId, allEntities, cardDefinitions, placedCardId = null) {
  // Batch-read all entities' instructions in one query (Brutal-critic Fix #6 —
  // kills the N+1 pattern of per-entity getPendingInstructions calls).
  const perEntity = await findPendingInstructionsForRun(db, runId, stepIndex, cardDefinitions);

  // The "default" group holds entities with NO pending instruction for this
  // submodule (the first-pass path). v6 PLACEMENT-AWARENESS (W3, V6-§1.4): when the
  // placed submodules_per_step entry carries a card_id (a placed round-1 card /
  // clone), those entities belong to THAT placed card's batch — NOT a null default
  // group. This is what makes two round-1 CLONES of one submodule (two placed
  // entries, each with its own card_id) execute as DISTINCT card-scoped batches
  // instead of collapsing to a single null default group (Q2d / Codex-4, test #3).
  // Falls back to null for a legacy submodule-id string entry (no card).
  const placedCard = placedCardId ? cardDefinitions?.[placedCardId] : null;
  const defaultGroup = {
    card_id: placedCardId ?? null,
    entities: [],
    // v6 collapse: a placed card IS round 1 — its flat `overrides` are round-1's
    // config (legacy rounds["1"] fallback for a not-yet-migrated card).
    round_overrides: placedCard ? (placedCard.overrides ?? placedCard.rounds?.['1'] ?? {}) : {},
    prompt_overrides: placedCard?.prompt_overrides || {},
  };
  const groups = new Map();
  // Key the default group by the placed card_id (or a sentinel for the null/legacy
  // case) so a non-pending entity lands in the placed card's group.
  groups.set(placedCardId ?? '__default__', defaultGroup);

  for (const entityName of (allEntities || [])) {
    const entry = perEntity.get(entityName) || { pending: [], orphaned: [] };

    // Explicit orphan cleanup (Brutal-critic Fix #5): mark instructions targeting
    // cards no longer in card_definitions as skipped with reason 'card_deleted'.
    if (entry.orphaned.length > 0) {
      await cleanupDeletedCardInstructions(db, runId, entityName, entry.orphaned);
    }

    const matching = entry.pending.filter(p => p.submodule_id === submoduleId);

    if (matching.length === 0) {
      defaultGroup.entities.push(entityName);
      continue;
    }

    // Per Brutal-critic Fix #1 (atomic target-level dedup in append_card_instruction),
    // matching.length === 1 in well-formed state. matching.length > 1 ⇒ invariant
    // violation; defensively skip the extras so progress isn't blocked.
    const winner = matching[0];
    const duplicates = matching.slice(1);
    for (const dup of duplicates) {
      console.warn(
        `[expandCardGroups] Duplicate pending instruction for ${entityName} ` +
        `step ${stepIndex} card ${dup.card_id} — Brutal-critic Fix #1 invariant violation. ` +
        `Skipping with reason '${SKIP_REASONS.QA_PASSED_ON_RECHECK}' (closest existing enum; ` +
        `if this fires in production, consider adding a DUPLICATE_INSTRUCTION reason).`
      );
      await markSkipped(db, runId, entityName, stepIndex, dup.card_id,
                        SKIP_REASONS.QA_PASSED_ON_RECHECK);
    }

    const key = winner.card_id;
    if (!groups.has(key)) {
      groups.set(key, {
        card_id: winner.card_id,
        entities: [],
        round_overrides: winner.round_overrides || {},
        prompt_overrides: cardDefinitions?.[winner.card_id]?.prompt_overrides || {},
      });
    }
    groups.get(key).entities.push(entityName);
  }

  // Drop empty groups (default group with 0 entities means every entity is card-routed),
  // then emit in a DETERMINISTIC order.
  //
  // INV-ORDER (V6-§4): the authored order must NOT be lost here. The pre-v6 code
  // returned `Array.from(groups.values())` — Map/entity-INSERTION order — so once a
  // single (step, submodule) yielded more than one group (a routed submodule with
  // entities on different cards), the relative order of those groups followed
  // entity-discovery order, NOT authored config. Emit deterministically instead:
  // the placed/default group first (the authored entry for this call), then any
  // pending (routed) card groups by card_id. This is entity-permutation-invariant
  // (T-ORDER-2) — the guard against the `cardGroups.js` Map-iteration hazard.
  const defaultKey = placedCardId ?? null;
  const nonEmpty = Array.from(groups.values()).filter(g => g.entities.length > 0);
  nonEmpty.sort((a, b) => {
    const aDefault = a.card_id === defaultKey;
    const bDefault = b.card_id === defaultKey;
    if (aDefault !== bDefault) return aDefault ? -1 : 1;                 // placed/default first
    return String(a.card_id).localeCompare(String(b.card_id));          // then card_id tiebreak
  });
  return nonEmpty;
}

// unit-separator group-key join (submodule_id ␟ card_id) — collision-proof vs both.
const UNPLACED_SEP = '␟';

/**
 * WF-1 / V6-§1.5 — build the UNPLACED routing-only dispatch groups for a step.
 *
 * The COMPLEMENT of expandCardGroups: expandCardGroups partitions a PLACED
 * submodule's entities by pending instruction; this builds groups for pending
 * instructions whose submodule is NOT placed (∉ submodules_per_step), which the
 * placed-entry loop can never dispatch (its `cardGroups.js:81` filter is
 * placement-scoped by construction). The two are complementary and non-overlapping
 * (placed set vs its complement — V6-§1.5).
 *
 * PURE — operates on the already-fetched pending map; no db / IO, so it is
 * unit-testable in isolation (the autoExecutor dispatch pass around it is not).
 *
 * INV-DISPATCH-ORDER (V6-§1.5): groups are ordered deterministically by
 *   (a) the position of the card in routing_rules' target arrays, then
 *   (b) card_id as a stable tiebreak
 * — a pure function of authored config + the pending set, NEVER of allEntities /
 * Map iteration (the V6-§4 order-loss hazard, one layer over). Entities within a
 * group are sorted for the same determinism (a group dispatches as ONE batch, so
 * intra-group order is cosmetic, but byte-identical output guards T-ORDER-2).
 *
 * @param {Map<string,{pending:Array,orphaned:Array}>} perEntityPending
 *        findPendingInstructionsForRun(db, runId, stepIndex, cardDefinitions) output
 *        (already step-scoped when a numeric stepIndex was passed).
 * @param {Array<string>} placedSubmoduleIds  the step's submodules_per_step (placed set)
 * @param {object} routingRules               execution_plan.routing_rules (for INV-DISPATCH-ORDER)
 * @returns {Array<{submodule_id:string, card_id:string, loop_iteration:number, entities:string[]}>}
 *          ordered unplaced dispatch groups
 */
export function collectUnplacedDispatchGroups(perEntityPending, placedSubmoduleIds, routingRules = {}) {
  const placed = new Set(placedSubmoduleIds || []);

  // card_id → ordinal from routing_rules (rules in insertion order, targets in
  // array order; first occurrence wins). A pure function of authored config.
  const cardOrdinal = new Map();
  let ord = 0;
  for (const targets of Object.values(routingRules || {})) {
    if (!Array.isArray(targets)) continue;
    for (const t of targets) {
      const cid = t?.card_id;
      if (cid && !cardOrdinal.has(cid)) cardOrdinal.set(cid, ord++);
    }
  }

  // Group pending UNPLACED instructions by (submodule_id, card_id).
  const groups = new Map();
  for (const [entityName, entry] of (perEntityPending || new Map())) {
    for (const p of (entry?.pending || [])) {
      if (!p || !p.submodule_id || placed.has(p.submodule_id)) continue;  // placed → expandCardGroups owns it
      const key = `${p.submodule_id}${UNPLACED_SEP}${p.card_id}`;
      let g = groups.get(key);
      if (!g) {
        g = { submodule_id: p.submodule_id, card_id: p.card_id, loop_iteration: p.loop_iteration ?? 0, entities: [] };
        groups.set(key, g);
      }
      if (!g.entities.includes(entityName)) g.entities.push(entityName);
    }
  }

  const ordered = Array.from(groups.values());
  for (const g of ordered) g.entities.sort();  // intra-group determinism
  ordered.sort((a, b) => {
    const oa = cardOrdinal.has(a.card_id) ? cardOrdinal.get(a.card_id) : Infinity;
    const ob = cardOrdinal.has(b.card_id) ? cardOrdinal.get(b.card_id) : Infinity;
    if (oa !== ob) return oa - ob;                        // (a) routing_rules target order
    return String(a.card_id).localeCompare(String(b.card_id));  // (b) card_id tiebreak
  });
  return ordered;
}
