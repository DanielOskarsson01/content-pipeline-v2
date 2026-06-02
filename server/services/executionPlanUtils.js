/**
 * executionPlanUtils.js — Execution plan entry resolution
 *
 * Source spec: PHASE_3B_PER_ENTITY_INSTRUCTIONS_SPEC.md §1.3 + §5.6
 *              Plan v5 Daniel decision 2 (2026-05-31): KEEP SEPARATE from cardInstructions.js
 *
 * Responsibility (distinct concern from cardInstructions.js):
 *   This file owns STEP-ENTRY RESOLUTION: given an entry in submodules_per_step,
 *   what submodule_id + card metadata does it resolve to? cardInstructions.js
 *   owns instruction lifecycle (creation, consumption, skipping).
 *   Two distinct concerns. Keep separate per spec §5.6.
 *
 * Backward compatibility:
 *   Legacy templates have submodules_per_step entries that are submodule_id
 *   strings (e.g., "sitemap-parser"). New templates have UUID entries
 *   referencing card_definitions. Resolver checks card_definitions first,
 *   falls back to treating entry as legacy submodule_id.
 *
 * Corruption detection:
 *   If an entry LOOKS like a UUID but is NOT in card_definitions, logs a
 *   warning. Catches template corruption (card removed from definitions but
 *   left in submodules_per_step) early — produces clear log instead of
 *   confusing 404 at trigger time.
 */

// UUID regex (8-4-4-4-12 hex pattern). Used for corruption detection.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a single submodules_per_step entry to its submodule + card metadata.
 *
 * @param {string} entry             entry from submodules_per_step (UUID or submodule_id)
 * @param {object} cardDefinitions   execution_plan_snapshot.card_definitions (UUID-keyed) or null/undefined
 * @returns {object} { submodule_id, card_id, card_name, round_1_overrides, _corrupt? }
 */
export function resolveStepEntry(entry, cardDefinitions) {
  if (typeof entry !== 'string' || !entry) {
    throw new Error(`resolveStepEntry: entry must be non-empty string, got ${typeof entry}: ${entry}`);
  }

  const card = cardDefinitions?.[entry];
  if (card) {
    return {
      submodule_id: card.submodule_id,
      card_id: entry,
      card_name: card.card_name || card.name || null,
      round_1_overrides: card.rounds?.['1'] || {},
    };
  }

  // Corruption detection: entry looks like a UUID but not found in card_definitions
  if (UUID_REGEX.test(entry)) {
    console.warn(
      `[executionPlanUtils] Entry looks like card_id but not found in card_definitions: ${entry}. ` +
      `Likely template corruption (card removed from card_definitions but left in submodules_per_step). ` +
      `Treating as missing submodule — caller will produce a clear failure.`
    );
    return {
      submodule_id: null,
      card_id: entry,
      card_name: null,
      round_1_overrides: {},
      _corrupt: true,
    };
  }

  // Legacy: entry IS the submodule_id string
  return {
    submodule_id: entry,
    card_id: null,
    card_name: null,
    round_1_overrides: {},
  };
}

/**
 * Resolve all entries in a submodules_per_step list for a given step.
 *
 * @param {Array<string>} stepEntries   submodules_per_step[stepIndex]
 * @param {object} cardDefinitions      execution_plan_snapshot.card_definitions
 * @returns {Array<object>}             array of {submodule_id, card_id, card_name, round_1_overrides}
 */
export function resolveStepEntries(stepEntries, cardDefinitions) {
  return (stepEntries || []).map(e => resolveStepEntry(e, cardDefinitions));
}

/**
 * Detect whether an execution_plan uses card_definitions (new format)
 * or only string-keyed `cards` (legacy format).
 *
 * Used during sub-plan 1 rollout to decide which code path applies.
 *
 * @param {object} executionPlan        execution_plan or execution_plan_snapshot
 * @returns {'new' | 'legacy' | 'empty'}
 */
export function detectExecutionPlanFormat(executionPlan) {
  if (!executionPlan) return 'empty';
  if (executionPlan.card_definitions && Object.keys(executionPlan.card_definitions).length > 0) {
    return 'new';
  }
  if (executionPlan.cards && Object.keys(executionPlan.cards).length > 0) {
    return 'legacy';
  }
  return 'empty';
}
