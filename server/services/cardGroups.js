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
export async function expandCardGroups(db, runId, stepIndex, submoduleId, allEntities, cardDefinitions) {
  // Batch-read all entities' instructions in one query (Brutal-critic Fix #6 —
  // kills the N+1 pattern of per-entity getPendingInstructions calls).
  const perEntity = await findPendingInstructionsForRun(db, runId, stepIndex, cardDefinitions);

  const defaultGroup = {
    card_id: null,
    entities: [],
    round_overrides: {},
    prompt_overrides: {},
  };
  const groups = new Map();
  groups.set('default', defaultGroup);

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

  // Drop empty groups (default group with 0 entities means every entity is card-routed).
  return Array.from(groups.values()).filter(g => g.entities.length > 0);
}
