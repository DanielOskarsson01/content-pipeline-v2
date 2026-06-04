/**
 * cardInstructions.js — Multi-Card Pattern instruction lifecycle
 *
 * Source spec: PHASE_3B_PER_ENTITY_INSTRUCTIONS_SPEC.md §5.1-§5.5
 *              Plan v5 (noble-wandering-graham) Gemini amendment 1d (skip_reason vocabulary)
 *              CTO Round 1 Fix #1 (2026-06-01): loop_iteration explicit on targets at write time
 *              Brutal-critic Round 2 (2026-06-02): Fixes #3 (FIFO align), #4 (defensive guards),
 *                                                  #5 (read/write split), #6 (batch helper)
 *              Section C pre-flight (2026-06-03): card_round required on pending targets at write
 *                                                 time (C↔B.5 seam — submoduleRuns.js:663-664 defaults
 *                                                 to "1" when card_round is missing, silently running
 *                                                 Round 1 overrides on every retry; loud-fail at
 *                                                 write catches every future caller)
 *
 * Responsibility (Daniel decision 2 — KEEP SEPARATE from executionPlanUtils.js):
 *   This file owns the INSTRUCTION LIFECYCLE: creation, consumption, skipping,
 *   round-tracking. executionPlanUtils.js owns step-entry RESOLUTION (what runs
 *   at a step). Distinct concerns. Do not merge.
 *
 * Skip reason vocabulary (5 total — load-bearing for sub-plan 1 correctness):
 *   - qa_passed_on_recheck      (spec §3.4 — routingHandler when QA passes for entity with pending instructions)
 *   - card_deleted              (spec §3.3 — auto-skip via cleanupDeletedCardInstructions when card_definitions missing)
 *   - rounds_exhausted          (spec §4.3 — routingHandler when all rounds of all cards consumed)
 *   - pool_precondition_not_met (NEW Plan v5 — autoExecutor.expandCardGroups when pool fails precondition)
 *   - max_loops_backstop        (NEW Plan v5 — routingHandler when MAX_LOOPS=3 would be exceeded)
 *
 * Shared invariant (carries the Brutal-critic Fix #1 + Fix #3 design):
 *   All mutation of entity_run_meta.card_instructions MUST go through the 3 RPCs
 *   under SELECT FOR UPDATE row lock. The FIFO-by-position safety of markConsumed
 *   AND the markSkipped FIFO design BOTH depend on this — concurrent writes
 *   bypassing the RPCs would violate the "one pending per (step, card_id,
 *   loop_iteration, entity)" invariant that makes FIFO equivalent to id-targeted
 *   skip.
 */

export const SKIP_REASONS = Object.freeze({
  QA_PASSED_ON_RECHECK: 'qa_passed_on_recheck',
  CARD_DELETED: 'card_deleted',
  ROUNDS_EXHAUSTED: 'rounds_exhausted',
  POOL_PRECONDITION_NOT_MET: 'pool_precondition_not_met',
  MAX_LOOPS_BACKSTOP: 'max_loops_backstop',
});

// ---------------------------------------------------------------------------
// Defensive validation (Brutal-critic Round 2 Fix #4 — Edge Case 1)
// ---------------------------------------------------------------------------
/**
 * Validate that a card_instructions JSONB value matches the expected shape.
 * Throws with descriptive context on malformed data — fail loud, not silent.
 *
 * Pending targets MUST have card_id (string), step (number), loop_iteration (number),
 * card_round (number).
 * Consumed/skipped targets are NOT re-validated for those fields — they represent
 * historical state and may have been written before stricter validation.
 *
 * @param {*} instructions    value from entity_run_meta.card_instructions
 * @param {string} contextMsg context for error message (e.g., entity name)
 * @returns {Array}           validated instructions array (or empty array if null)
 * @throws {Error}            if malformed
 */
export function validateCardInstructions(instructions, contextMsg) {
  if (instructions === null || instructions === undefined) {
    return [];
  }
  if (!Array.isArray(instructions)) {
    throw new Error(`Malformed card_instructions for ${contextMsg}: expected array, got ${typeof instructions}`);
  }
  for (let i = 0; i < instructions.length; i++) {
    const record = instructions[i];
    if (typeof record !== 'object' || record === null) {
      throw new Error(`Malformed card_instructions record[${i}] for ${contextMsg}: expected object, got ${typeof record}`);
    }
    if (record.targets !== undefined && !Array.isArray(record.targets)) {
      throw new Error(`Malformed card_instructions record[${i}].targets for ${contextMsg}: expected array, got ${typeof record.targets}`);
    }
    const targets = record.targets || [];
    for (let j = 0; j < targets.length; j++) {
      const target = targets[j];
      if (typeof target !== 'object' || target === null) {
        throw new Error(`Malformed card_instructions record[${i}].targets[${j}] for ${contextMsg}: expected object, got ${typeof target}`);
      }
      if (target.status === 'pending') {
        if (typeof target.card_id !== 'string' || !target.card_id) {
          throw new Error(`Malformed pending target[${i}][${j}] for ${contextMsg}: missing or non-string card_id`);
        }
        if (typeof target.step !== 'number') {
          throw new Error(`Malformed pending target[${i}][${j}] for ${contextMsg}: missing or non-number step`);
        }
        if (typeof target.loop_iteration !== 'number') {
          throw new Error(`Malformed pending target[${i}][${j}] for ${contextMsg}: missing or non-number loop_iteration (CTO Finding 1 requires explicit field)`);
        }
        // Section C pre-flight (2026-06-03): card_round must be explicit on pending targets.
        // Without this, submoduleRuns.js:663-664 silently defaults cardRound to "1" and runs
        // Round 1 overrides on every retry — the "same settings that just failed" silent no-op
        // that B.5 was designed to eliminate. Fail loud at write time, catch every future caller.
        if (typeof target.card_round !== 'number') {
          throw new Error(`Malformed pending target[${i}][${j}] for ${contextMsg}: missing or non-number card_round (Section C pre-flight requires explicit field for B.5 rounds[N] merge)`);
        }
      }
    }
  }
  return instructions;
}

// ---------------------------------------------------------------------------
// §5.1 findPendingInstructions (pure read — Brutal-critic Round 2 Fix #5)
// ---------------------------------------------------------------------------
/**
 * Read pending card instructions for an entity at a given step.
 * PURE READ — no side effects. Returns both resolved pending instructions
 * AND a list of orphaned card_ids (caller must invoke cleanupDeletedCardInstructions
 * to mark them skipped per spec §3.3).
 *
 * @param {object} db                   Supabase client
 * @param {string} runId                pipeline_runs.id
 * @param {string} entityName           entity identifier
 * @param {number|null} stepIndex       current step, or null for ALL steps
 *                                      (used by routingHandler QA-passed cleanup)
 * @param {object} cardDefinitions      execution_plan_snapshot.card_definitions (UUID-keyed)
 * @returns {Promise<{pending: Array, orphaned: Array<{step, card_id}>}>}
 */
export async function findPendingInstructions(db, runId, entityName, stepIndex, cardDefinitions) {
  const { data: meta } = await db
    .from('entity_run_meta')
    .select('card_instructions')
    .eq('run_id', runId)
    .eq('entity_name', entityName)
    .maybeSingle();

  const instructions = validateCardInstructions(meta?.card_instructions, `entity ${entityName}`);
  const pending = [];
  const orphaned = [];

  for (const record of instructions) {
    for (const target of (record.targets || [])) {
      if ((stepIndex === null || target.step === stepIndex) && target.status === 'pending') {
        const card = cardDefinitions?.[target.card_id];
        if (card) {
          pending.push({
            step: target.step,
            card_id: target.card_id,
            card_name: target.card_name,
            submodule_id: card.submodule_id,
            card_round: target.card_round,
            round_overrides: card.rounds?.[String(target.card_round)] || {},
            loop_iteration: target.loop_iteration,
            instruction_round: record.routing_round,
          });
        } else {
          orphaned.push({ step: target.step, card_id: target.card_id });
        }
      }
    }
  }

  return { pending, orphaned };
}

// ---------------------------------------------------------------------------
// §5.1b cleanupDeletedCardInstructions (explicit write — Brutal-critic Fix #5)
// ---------------------------------------------------------------------------
/**
 * Mark orphaned instructions (card_id not in card_definitions) as skipped.
 * Explicit write — caller must invoke after findPendingInstructions when
 * processing a step.
 *
 * @param {object} db                                Supabase client
 * @param {string} runId                             pipeline_runs.id
 * @param {string} entityName                        entity identifier
 * @param {Array<{step, card_id}>} orphaned          result from findPendingInstructions
 * @returns {Promise<void>}
 */
export async function cleanupDeletedCardInstructions(db, runId, entityName, orphaned) {
  for (const { step, card_id } of (orphaned || [])) {
    await markSkipped(db, runId, entityName, step, card_id, SKIP_REASONS.CARD_DELETED);
  }
}

// ---------------------------------------------------------------------------
// §5.1c findPendingInstructionsForRun (batch — Brutal-critic Round 2 Fix #6)
// ---------------------------------------------------------------------------
/**
 * Batch version of findPendingInstructions for ALL entities in a run.
 * Returns a Map keyed by entityName. Used by autoExecutor.expandCardGroups
 * to kill the N+1 query pattern.
 *
 * @param {object} db                   Supabase client
 * @param {string} runId                pipeline_runs.id
 * @param {number|null} stepIndex       current step, or null for ALL steps
 *                                      (used by routingHandler QA-passed cleanup)
 * @param {object} cardDefinitions      execution_plan_snapshot.card_definitions
 * @returns {Promise<Map<string, {pending: Array, orphaned: Array}>>}  keyed by entityName
 */
export async function findPendingInstructionsForRun(db, runId, stepIndex, cardDefinitions) {
  const { data: rows } = await db
    .from('entity_run_meta')
    .select('entity_name, card_instructions')
    .eq('run_id', runId);

  const result = new Map();
  for (const row of (rows || [])) {
    const instructions = validateCardInstructions(row.card_instructions, `entity ${row.entity_name}`);
    const pending = [];
    const orphaned = [];

    for (const record of instructions) {
      for (const target of (record.targets || [])) {
        if ((stepIndex === null || target.step === stepIndex) && target.status === 'pending') {
          const card = cardDefinitions?.[target.card_id];
          if (card) {
            pending.push({
              step: target.step,
              card_id: target.card_id,
              card_name: target.card_name,
              submodule_id: card.submodule_id,
              card_round: target.card_round,
              round_overrides: card.rounds?.[String(target.card_round)] || {},
              loop_iteration: target.loop_iteration,
              instruction_round: record.routing_round,
            });
          } else {
            orphaned.push({ step: target.step, card_id: target.card_id });
          }
        }
      }
    }

    result.set(row.entity_name, { pending, orphaned });
  }
  return result;
}

// ---------------------------------------------------------------------------
// §5.2 writeInstructions (atomic via append_card_instruction RPC)
// ---------------------------------------------------------------------------
/**
 * Append a new instruction record to entity_run_meta.card_instructions.
 *
 * Brutal-critic Round 2 Fix #1: the RPC performs target-level dedup atomically
 * (WHERE NOT EXISTS on matching pending (step, card_id, loop_iteration)). RPC
 * returns BOOLEAN: TRUE if appended, FALSE if dedup blocked.
 *
 * CTO Round 1 Fix #1: loop_iteration is explicit on every target at write time
 * (no derive-at-read).
 *
 * @param {object} db                   Supabase client
 * @param {string} runId                pipeline_runs.id
 * @param {string} entityName           entity identifier
 * @param {object} options              { routingRound, createdBy, qaFailures, targets, incrementLoopCount }
 * @returns {Promise<boolean>}          true if appended; false if dedup blocked
 */
export async function writeInstructions(db, runId, entityName, {
  routingRound, createdBy, qaFailures, targets,
  incrementLoopCount = false,
}) {
  const newRecord = {
    routing_round: routingRound,
    created_at: new Date().toISOString(),
    created_by: createdBy,
    qa_failures: qaFailures || [],
    targets: (targets || []).map(t => ({
      ...t,
      loop_iteration: routingRound,
      status: 'pending',
      consumed_at: null,
      skip_reason: null,
    })),
  };

  // Section C (2026-06-04): p_increment_loop_count opts into atomic
  // entity_run_meta.loop_count bump inside the same UPDATE. routingHandler
  // passes TRUE; other callers (sub-plan 2 gate writer) default to FALSE.
  const { data, error } = await db.rpc('append_card_instruction', {
    p_run_id: runId,
    p_entity_name: entityName,
    p_instruction: newRecord,
    p_increment_loop_count: incrementLoopCount,
  });

  if (error) {
    throw new Error(`append_card_instruction RPC failed for ${entityName}: ${error.message}`);
  }

  return data === true;
}

// ---------------------------------------------------------------------------
// §5.3 markConsumed (atomic via mark_card_instruction_consumed RPC)
// ---------------------------------------------------------------------------
/**
 * Mark the earliest pending target for (step, card_id) as consumed.
 * FIFO order by array position. SELECT FOR UPDATE serializes concurrent workers.
 *
 * @param {object} db                   Supabase client
 * @param {string} runId                pipeline_runs.id
 * @param {string} entityName           entity identifier
 * @param {number} step                 step index
 * @param {string} cardId               card UUID
 * @param {string} [consumedAt]         ISO timestamp (defaults to now)
 */
export async function markConsumed(db, runId, entityName, step, cardId, consumedAt = null) {
  const { error } = await db.rpc('mark_card_instruction_consumed', {
    p_run_id: runId,
    p_entity_name: entityName,
    p_step: step,
    p_card_id: cardId,
    p_consumed_at: consumedAt || new Date().toISOString(),
  });

  if (error) {
    throw new Error(`mark_card_instruction_consumed RPC failed for ${entityName} step ${step} card ${cardId}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// §5.4 markSkipped (atomic via mark_card_instruction_skipped RPC)
// ---------------------------------------------------------------------------
/**
 * Mark earliest pending target for (step, card_id) as skipped with reason.
 * FIFO by array position — same pattern as markConsumed per spec §5.4.
 *
 * Brutal-critic Round 2 Fix #3: removed loop_iteration filter. Verified safe
 * because append_card_instruction's target-level dedup (Fix #1) enforces
 * "one pending per (step, card_id, loop_iteration, entity)" invariant, so
 * FIFO and loop_iteration-filtered behavior are identical. Aligned to spec.
 *
 * @param {object} db                   Supabase client
 * @param {string} runId                pipeline_runs.id
 * @param {string} entityName           entity identifier
 * @param {number} step                 step index
 * @param {string} cardId               card UUID
 * @param {string} skipReason           one of SKIP_REASONS values
 */
export async function markSkipped(db, runId, entityName, step, cardId, skipReason) {
  if (!Object.values(SKIP_REASONS).includes(skipReason)) {
    throw new Error(`Invalid skip_reason: ${skipReason}. Allowed: ${Object.values(SKIP_REASONS).join(', ')}`);
  }

  const { error } = await db.rpc('mark_card_instruction_skipped', {
    p_run_id: runId,
    p_entity_name: entityName,
    p_step: step,
    p_card_id: cardId,
    p_skip_reason: skipReason,
    p_skipped_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`mark_card_instruction_skipped RPC failed for ${entityName} step ${step} card ${cardId}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// §5.5 getConsumedRoundsForRun (batched read, NOT an RPC)
// ---------------------------------------------------------------------------
/**
 * For each entity in the run, build a map of card_id → consumed round numbers.
 * Used by routingHandler to determine next available round per card per entity.
 *
 * @param {object} db                   Supabase client
 * @param {string} runId                pipeline_runs.id
 * @returns {Promise<object>}           { [entityName]: { [card_id]: number[] } }
 */
export async function getConsumedRoundsForRun(db, runId) {
  const { data: rows } = await db
    .from('entity_run_meta')
    .select('entity_name, card_instructions')
    .eq('run_id', runId);

  const result = {};
  for (const row of (rows || [])) {
    const instructions = validateCardInstructions(row.card_instructions, `entity ${row.entity_name}`);
    const entityConsumed = {};
    for (const record of instructions) {
      for (const target of (record.targets || [])) {
        if (target.status === 'consumed') {
          if (!entityConsumed[target.card_id]) entityConsumed[target.card_id] = [];
          entityConsumed[target.card_id].push(target.card_round);
        }
      }
    }
    result[row.entity_name] = entityConsumed;
  }
  return result;
}

// NOTE: hasPendingInstruction helper removed (Brutal-critic Round 2 Fix #1).
// Caller-side dedup was TOCTOU-broken. Idempotency now enforced atomically inside
// append_card_instruction RPC via WHERE NOT EXISTS. Callers can inspect the
// BOOLEAN return value from writeInstructions to log dedup events.
