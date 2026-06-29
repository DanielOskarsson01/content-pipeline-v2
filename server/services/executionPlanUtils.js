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

const VALID_ROUND_KEYS = ['1', '2', '3', '4'];
const MAX_ROUNDS_PER_CARD = 4;

/**
 * Validate an execution_plan's card config at TEMPLATE SAVE time (PHASE_3B §9
 * acceptance table). Pure + registry-injected so it is testable and fully
 * pipeline-agnostic (structural validation only — no content-type assumptions).
 *
 * Fail-loud-before-UI contract: the save path calls this and rejects (HTTP 400)
 * any malformed card config before it can be persisted, so the card-stacking UI
 * (#16) and routing-rules UI (#17) build on a save path that cannot store a
 * corrupt execution_plan.
 *
 * Rules (all → errors[], HTTP 400):
 *   1  card_id (map key) is a valid UUID                         (§9)
 *   2  submodule_id present AND registered                      (§1.2)
 *   3  step present AND integer                                 (§1.2)
 *   4  rounds present AND a plain object                        (§1.2)
 *   5  round "1" always present                                 (§9)
 *   6  round keys ∈ {1,2,3,4}                                   (§9)
 *   7  ≤ MAX_ROUNDS_PER_CARD (4) rounds                         (§9)
 *   8  every UUID entry in submodules_per_step ∈ card_definitions (§9)
 *   9  card.step matches its submodules_per_step placement step (§9)
 *  10  every routing_rules card_id ∈ card_definitions           (§9)
 *  11  every routing_rules-referenced card has a round > 1      (§9 / §2.1)
 *
 * DEFERRED (returned in warnings[] only once buildable): QA-check-name →
 * manifest `qa_outputs` matching (§2.2, non-blocking warning). No manifest
 * declares `qa_outputs` yet (§6.6 not built), so there is nothing to match
 * against — implementing it now would be a no-op. Wire it when qa_outputs ships.
 *
 * Legacy plans (no card_definitions, kebab-case submodules_per_step entries)
 * validate clean — the card rules only engage when cards/UUIDs are present.
 *
 * @param {object} executionPlan  the execution_plan being saved
 * @param {object} deps
 * @param {(submoduleId: string) => boolean} [deps.isRegisteredSubmodule]
 *        registry lookup; when omitted, the registration check (rule 2b) is skipped
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateExecutionPlan(executionPlan, { isRegisteredSubmodule } = {}) {
  const errors = [];
  const warnings = [];
  if (!executionPlan || typeof executionPlan !== 'object' || Array.isArray(executionPlan)) {
    return { errors, warnings };
  }

  const cardDefs = executionPlan.card_definitions;
  // card_definitions, if present at all, must be a plain object keyed by card_id.
  // (Without this, an array/scalar shape would silently skip rules 1–7.)
  if (cardDefs !== undefined && cardDefs !== null && (typeof cardDefs !== 'object' || Array.isArray(cardDefs))) {
    errors.push('card_definitions must be an object keyed by card_id');
  }
  const hasCards = cardDefs && typeof cardDefs === 'object' && !Array.isArray(cardDefs) && Object.keys(cardDefs).length > 0;

  // Rules 1–7: per-card shape
  if (hasCards) {
    for (const [cardId, card] of Object.entries(cardDefs)) {
      const at = `card_definitions["${cardId}"]`;
      if (!UUID_REGEX.test(cardId)) {                                    // 1
        errors.push(`${at}: card_id is not a valid UUID`);
      }
      if (!card || typeof card !== 'object' || Array.isArray(card)) {
        errors.push(`${at}: card definition must be an object`);
        continue;
      }
      if (!card.submodule_id || typeof card.submodule_id !== 'string') { // 2a
        errors.push(`${at}: submodule_id is required`);
      } else if (typeof isRegisteredSubmodule === 'function' && !isRegisteredSubmodule(card.submodule_id)) { // 2b
        errors.push(`${at}: submodule_id "${card.submodule_id}" is not a registered submodule`);
      }
      if (!Number.isInteger(card.step)) {                               // 3
        errors.push(`${at}: step is required and must be an integer`);
      }
      const rounds = card.rounds;
      if (!rounds || typeof rounds !== 'object' || Array.isArray(rounds)) { // 4
        errors.push(`${at}: rounds is required and must be an object`);
      } else {
        const keys = Object.keys(rounds);
        if (!Object.prototype.hasOwnProperty.call(rounds, '1')) {       // 5
          errors.push(`${at}: round "1" must always be present`);
        }
        const invalid = keys.filter((k) => !VALID_ROUND_KEYS.includes(k)); // 6
        if (invalid.length) {
          errors.push(`${at}: round keys must be integers 1-4; invalid: ${invalid.join(', ')}`);
        }
        if (keys.length > MAX_ROUNDS_PER_CARD) {                        // 7
          errors.push(`${at}: MAX_ROUNDS_PER_CARD=${MAX_ROUNDS_PER_CARD} exceeded (${keys.length} rounds)`);
        }
        for (const [rk, rv] of Object.entries(rounds)) {                // 4b: each round's overrides must be an object
          if (rv === null || typeof rv !== 'object' || Array.isArray(rv)) {
            errors.push(`${at}: round "${rk}" overrides must be an object`);
          }
        }
      }
    }
  }

  // Rules 8–9: submodules_per_step ↔ card_definitions consistency
  const sps = executionPlan.submodules_per_step;
  if (sps && typeof sps === 'object' && !Array.isArray(sps)) {
    for (const [stepKey, entries] of Object.entries(sps)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry !== 'string' || !UUID_REGEX.test(entry)) continue; // legacy string entries untouched
        const card = hasCards ? cardDefs[entry] : undefined;
        if (!card) {                                                    // 8
          errors.push(`submodules_per_step["${stepKey}"]: card_id ${entry} not found in card_definitions`);
        } else if (Number.isInteger(card.step) && card.step !== Number(stepKey)) { // 9
          errors.push(`submodules_per_step["${stepKey}"]: card ${entry} has step ${card.step}, does not match placement step ${stepKey}`);
        }
      }
    }
  }

  // Rules 10–11: routing_rules integrity
  const rr = executionPlan.routing_rules;
  if (rr && typeof rr === 'object' && !Array.isArray(rr)) {
    for (const [ruleKey, targets] of Object.entries(rr)) {
      if (!Array.isArray(targets)) continue;
      for (const target of targets) {
        const cid = target?.card_id;
        if (!cid) {                                                     // routing target must name a card
          errors.push(`routing_rules["${ruleKey}"]: target is missing card_id`);
          continue;
        }
        const card = hasCards ? cardDefs[cid] : undefined;
        if (!card) {                                                    // 10
          errors.push(`routing_rules["${ruleKey}"]: card_id ${cid} not found in card_definitions`);
        } else {
          const hasEscalation = card.rounds && typeof card.rounds === 'object' &&
            Object.keys(card.rounds).some((k) => Number(k) > 1);
          if (!hasEscalation) {                                         // 11
            errors.push(`routing_rules["${ruleKey}"]: card ${cid} has no round > 1 (routing can never escalate)`);
          }
        }
      }
    }
  }

  return { errors, warnings };
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
