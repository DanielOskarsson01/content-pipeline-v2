/**
 * Routing Handler — Section C rewrite (2026-06-04)
 *
 * Reads loop-router decisions from entity_submodule_runs, resolves routing_rules
 * into card-based per-entity instructions, enforces max_loops backstop, and
 * writes pending card instructions to entity_run_meta.card_instructions via
 * the Multi-Card Pattern (append_card_instruction RPC with atomic loop_count
 * bump). Per-entity try/catch isolates failures.
 *
 * Section C replaces the pre-2026-06-04 model:
 * - Cascade-delete of entity_submodule_runs + submodule_runs → REMOVED
 * - apply_entity_routing RPC call → REMOVED (stub dropped in
 *   sql/drop_apply_entity_routing_tripwire.sql)
 * - pipeline_stages.is_loop_pass side-channel → retired in submoduleRuns.js
 *   (request cardId is now the routed-retry signal)
 *
 * Closes BACKLOG #7 (cascade-delete partial-state damage on RPC failure).
 *
 * Called by the approval handler in runs.js when routing is detected.
 */

import {
  SKIP_REASONS,
  writeInstructions,
  markSkipped,
  getConsumedRoundsForRun,
  findPendingInstructionsForRun,
} from './cardInstructions.js';

const MAX_LOOPS = 3;

// Decision → target_step mapping — FALLBACK for templates without routing_rules.
// Templates WITH routing_rules use card-based resolution (resolveCards) instead.
const DECISION_TARGET_MAP = {
  loop_discovery: 1,
  loop_tone: 5,
  loop_generation: 5,
};

// ---------------------------------------------------------------------------
// Card resolution helpers (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Resolve QA failures into card-based per-entity instructions using routing_rules.
 *
 * @param {object} qaScores - { keyword: 'pass'|'fail'|'missing', ... } from loop-router
 * @param {object} executionPlan - Template execution_plan with cards + routing_rules
 * @param {object} existingLoopConfig - Entity's current loop_config (consumed_cards)
 * @returns {object|null} { active_cards, consumed_cards, triggered_by } or null if no cards resolved
 */
function resolveCards(qaScores, executionPlan, existingLoopConfig) {
  const rules = executionPlan?.routing_rules || {};
  const cards = executionPlan?.cards || {};
  // "consumed" means "assigned to this entity at least once" — NOT "executed."
  // Cards are marked consumed at routing time (when assigned), not at execution time.
  // This prevents the same card from being re-assigned on subsequent routing passes.
  const consumed = existingLoopConfig?.consumed_cards || [];
  const activeCards = {};  // step → [cardName, ...]
  const triggeredBy = [];
  const newlyActivated = [];

  for (const [check, result] of Object.entries(qaScores || {})) {
    if (result !== 'fail') continue;
    const rule = rules[`${check}:fail`];
    if (!rule) continue;
    triggeredBy.push(`${check}:fail`);
    for (const cardName of rule.target_cards) {
      if (consumed.includes(cardName)) continue;
      const card = cards[cardName];
      if (!card) continue;
      const step = String(card.step);
      if (!activeCards[step]) activeCards[step] = [];
      if (!activeCards[step].includes(cardName)) {
        activeCards[step].push(cardName);
        newlyActivated.push(cardName);
      }
    }
  }

  // All cards consumed, no new variants available → return null.
  // Caller keeps decision as flag_manual (needs manual check).
  // Don't retry with the same consumed card — it already failed.
  // max_loops backstop also catches this, but this is cleaner.
  if (!Object.keys(activeCards).length) return null;
  return {
    active_cards: activeCards,
    consumed_cards: [...consumed, ...newlyActivated],
    triggered_by: triggeredBy,
  };
}

/**
 * Validate card and routing_rules configuration at template save time.
 * Returns an array of warning strings (empty = valid).
 *
 * @param {object} executionPlan - Template execution_plan
 * @param {string[]} [registeredSubmodules] - Known submodule IDs (optional)
 * @returns {string[]} Validation warnings
 */
function validateCards(executionPlan, registeredSubmodules) {
  const warnings = [];
  const cards = executionPlan?.cards || {};
  const rules = executionPlan?.routing_rules || {};

  // Card definition validation
  for (const [name, card] of Object.entries(cards)) {
    if (!card.submodule_id) warnings.push(`Card "${name}": missing submodule_id`);
    else if (registeredSubmodules && !registeredSubmodules.includes(card.submodule_id))
      warnings.push(`Card "${name}": submodule "${card.submodule_id}" not found`);
    if (card.step === undefined) warnings.push(`Card "${name}": missing step`);
  }

  // Routing rule → card reference validation
  for (const [ruleKey, rule] of Object.entries(rules)) {
    for (const cardName of rule.target_cards || []) {
      if (!cards[cardName]) warnings.push(`Rule "${ruleKey}": targets unknown card "${cardName}"`);
    }
  }

  // Same-submodule collision detection: warn when different routing rules
  // can activate multiple cards targeting the same submodule at the same step.
  // Only the first card wins at execution time (break in submoduleRuns.js),
  // but all are marked consumed — silently wasting card variants.
  const allRuleCards = new Set();
  for (const rule of Object.values(rules)) {
    for (const cardName of rule.target_cards || []) allRuleCards.add(cardName);
  }
  const slotMap = {};  // "step:submodule_id" → [cardName, ...]
  for (const cardName of allRuleCards) {
    const card = cards[cardName];
    if (!card) continue;
    const slot = `${card.step}:${card.submodule_id}`;
    if (!slotMap[slot]) slotMap[slot] = [];
    slotMap[slot].push(cardName);
  }
  for (const [slot, names] of Object.entries(slotMap)) {
    if (names.length > 1) {
      warnings.push(
        `Cards [${names.join(', ')}] target the same submodule at the same step (${slot}). ` +
        `Only the first activated card will be used; others are marked consumed but never executed. ` +
        `Consider merging into a single card or targeting different submodules.`
      );
    }
  }

  // Belt-and-suspenders: warn if any cardId appears at multiple steps.
  // getConsumedRoundsForRun keys consumed rounds by (entity, card_id) only, so a
  // cardId reused across steps would silently cross-contaminate round derivation.
  // Today's data model doesn't reuse cardIds across steps; this warning surfaces
  // the latent shape if a future template ever does.
  const cardIdStepMap = {};
  for (const [name, card] of Object.entries(cards)) {
    if (card.step === undefined) continue;
    if (!cardIdStepMap[name]) cardIdStepMap[name] = new Set();
    cardIdStepMap[name].add(card.step);
  }
  for (const [name, steps] of Object.entries(cardIdStepMap)) {
    if (steps.size > 1) {
      warnings.push(
        `Card "${name}" is configured at multiple steps [${[...steps].join(', ')}]. ` +
        `getConsumedRoundsForRun keys consumed rounds by (entity, card_id) only — ` +
        `reusing a cardId across steps will cross-contaminate round derivation. ` +
        `Use distinct cardIds per step.`
      );
    }
  }

  return warnings;
}

/**
 * Set entity_run_meta.terminal_state, logging (never swallowing) a DB error.
 *
 * This is the load-bearing write for the Step-8 forward: runs.js:494 selects
 * `terminal_state IS NOT NULL`, so an entity stuck at NULL is silently dropped
 * from bundling — exactly the Bug-1 corruption this fix closes. supabase-js
 * does NOT throw on a constraint violation or a zero-row match; it RETURNS
 * `{error}`. The Section C rewrite ignored that return, so a silent write
 * failure would re-open Bug 1 with no trace. We surface it loudly in logs.
 *
 * We log rather than re-throw the `{error}` case: a transient single-row
 * meta-write failure must not abort the whole routing batch (a prior
 * instruction write may already have succeeded). A genuinely THROWN error
 * (network outage) still propagates out of the await and aborts applyRouting —
 * that contract is intentional and unchanged.
 *
 * @param {object} db - Supabase client
 * @param {string} runId - The run UUID
 * @param {string} entityName - Entity to flip
 * @param {'approved'|'failed'|'flagged'} terminalState - terminal_state value
 * @param {string|null} [failureReason=null] - failure_reason value
 */
async function setTerminalState(db, runId, entityName, terminalState, failureReason = null) {
  const { error } = await db.from('entity_run_meta').update({
    terminal_state: terminalState,
    failure_reason: failureReason ?? null,
  }).eq('run_id', runId).eq('entity_name', entityName);
  if (error) {
    console.error(
      `[routingHandler] FAILED to set terminal_state='${terminalState}' for ` +
      `${entityName} (run ${runId}): ${error.message || error}. Entity may be ` +
      `dropped from the Step-8 forward (runs.js selects terminal_state IS NOT ` +
      `NULL) — investigate.`
    );
  }
}

/**
 * Apply routing for a run. Reads loop-router output, builds decisions for
 * ALL entities, enforces max_loops, then writes per-entity pending card
 * instructions to entity_run_meta.card_instructions via the Multi-Card
 * Pattern (append_card_instruction RPC with atomic loop_count bump). Each
 * entity is processed independently — a failure for one does not block
 * the others.
 *
 * Section C (2026-06-04) replaced the pre-2026-06-04 cascade-delete +
 * apply_entity_routing RPC flow. See module docstring above.
 *
 * @param {object} db - Supabase client
 * @param {string} runId - The run UUID
 * @param {number} routingStep - The step index where routing runs (default 10)
 * @param {object} [executionPlan={}] - Template execution_plan (cards + routing_rules)
 * @returns {object} { decisions_sent, instructions_written, per_entity: [...] }
 * @throws {Error} If no router output found (always a bug)
 */
export async function applyRouting(db, runId, routingStep = 10, executionPlan = {}) {
  // ── a) Read loop-router output ──────────────────────────────────────
  const { data: routerRuns, error: routerErr } = await db
    .from('entity_submodule_runs')
    .select('entity_name, output_data')
    .eq('run_id', runId)
    .eq('step_index', routingStep)
    .like('submodule_id', '%loop-router%')
    .in('status', ['completed', 'approved']);

  if (routerErr) {
    throw new Error(`Failed to read loop-router output: ${routerErr.message}`);
  }

  if (!routerRuns || routerRuns.length === 0) {
    throw new Error(
      `No loop-router output found for run ${runId}. ` +
      `routing_pending=true means hasRouting found loop-router rows, ` +
      `so output must exist. This is a bug.`
    );
  }

  // Build a map of entity_name → decision from router output
  const routerDecisions = new Map();
  for (const run of routerRuns) {
    const items = run.output_data?.items || [];
    for (const item of items) {
      if (item.entity_name && item.decision) {
        routerDecisions.set(item.entity_name, item);
      }
    }
  }

  // ── b) Build decisions for ALL entities ─────────────────────────────
  // Safety net: ensure entity_run_meta rows exist for all entities in this run.
  // Normally created at Step 0 approval, but Step 0 may be skipped.
  const entityNames = [...routerDecisions.keys()];
  if (entityNames.length > 0) {
    await db.from('entity_run_meta').upsert(
      entityNames.map(name => ({ run_id: runId, entity_name: name })),
      { onConflict: 'run_id,entity_name', ignoreDuplicates: true }
    );
  }

  const { data: allEntities, error: metaErr } = await db
    .from('entity_run_meta')
    .select('entity_name, loop_count, terminal_state, loop_config')
    .eq('run_id', runId);

  if (metaErr) {
    throw new Error(`Failed to read entity_run_meta: ${metaErr.message}`);
  }

  const loopCounts = new Map(
    (allEntities || []).map(m => [m.entity_name, m.loop_count || 0])
  );

  const decisions = [];
  for (const meta of (allEntities || [])) {
    // Skip entities already in terminal state from a previous routing pass
    if (meta.terminal_state) continue;

    const entityName = meta.entity_name;
    const routerItem = routerDecisions.get(entityName);

    if (routerItem) {
      // Entity has router output — use its decision
      decisions.push({
        entity_name: entityName,
        decision: routerItem.decision,
        route_reason: routerItem.route_reason || null,
        failure_reason: routerItem.failure_reason || null,
        qa_scores: routerItem.qa_scores || null,
        config_overrides: routerItem.config_overrides || null,
      });
    } else {
      // Entity missing router output — default to flag_manual
      decisions.push({
        entity_name: entityName,
        decision: 'flag_manual',
        route_reason: 'No loop-router output for this entity',
        failure_reason: null,
        qa_scores: null,
        config_overrides: null,
      });
    }
  }

  // Bind once for the whole function — used by b2 (resolveCards) and by the
  // per-entity instruction-write loop (e). Empty {} when no cards configured.
  const cardDefinitions = executionPlan?.cards || {};

  // ── b2) Resolve routing_rules → cards for each decision ─────────────
  const hasRoutingRules = executionPlan?.routing_rules && Object.keys(executionPlan.routing_rules).length > 0;
  if (hasRoutingRules) {
    // Log validation warnings (non-blocking — template author sees these in UI on save)
    const warnings = validateCards(executionPlan);
    if (warnings.length > 0) {
      console.warn(`[routingHandler] Card validation warnings: ${warnings.join('; ')}`);
    }

    // Pre-build entity meta map for O(1) lookups
    const metaByName = new Map((allEntities || []).map(m => [m.entity_name, m]));

    for (const d of decisions) {
      const routerItem = routerDecisions.get(d.entity_name);
      if (!routerItem?.qa_scores) continue;

      const meta = metaByName.get(d.entity_name);
      const cardResult = resolveCards(routerItem.qa_scores, executionPlan, meta?.loop_config);
      if (!cardResult) continue;

      d.config_overrides = cardResult;

      // Compute target_step from earliest card step
      const cardSteps = Object.keys(cardResult.active_cards).map(Number);
      d.target_step = Math.min(...cardSteps);

      // Upgrade flag_manual → loop_* when cards resolved
      // (Loop-router Rule 2 sends 2+ failures to flag_manual, but routing_rules
      //  knows which cards to activate — so we override the decision)
      if (d.decision === 'flag_manual') {
        d.decision = d.target_step <= 1 ? 'loop_discovery' : 'loop_generation';
        d.route_reason = `Upgraded from flag_manual: routing_rules resolved ${cardResult.triggered_by.join(', ')} → cards [${Object.values(cardResult.active_cards).flat().join(', ')}]`;
      }
    }
  }

  // ── c) Enforce max_loops backstop ───────────────────────────────────
  for (const d of decisions) {
    if (d.decision.startsWith('loop_') &&
        (loopCounts.get(d.entity_name) || 0) >= MAX_LOOPS) {
      d.decision = 'failed';
      d.failure_reason = 'max_loops_exceeded';
      d.route_reason = `Max loops exceeded (${loopCounts.get(d.entity_name)}/${MAX_LOOPS}). Backstop enforced by routingHandler.`;
      delete d.target_step;
    }
  }

  // ── d) Map decisions to RPC format (add target_step) ────────────────
  // DECISION_TARGET_MAP is the fallback for templates without routing_rules.
  // Skip entities that already got a target_step from card resolution (b2).
  for (const d of decisions) {
    if (d.target_step !== undefined) continue; // Already resolved by routing_rules
    const targetStep = DECISION_TARGET_MAP[d.decision];
    if (targetStep !== undefined) {
      d.target_step = targetStep;
    }
  }

  // ── e) Per-entity instruction-write (Section C — Multi-Card Pattern) ─
  // Replaces the pre-2026-06-04 cascade-delete + apply_entity_routing RPC flow.
  // Each entity is processed independently: a writeInstructions failure for one
  // entity marks that entity terminal_state='failed' but does NOT block the
  // others. The failure-isolation property is the whole point of this rewrite
  // (closes BACKLOG #7 partial-state-on-RPC-failure damage class).
  const writeResults = [];
  const consumedRoundsByEntity = await getConsumedRoundsForRun(db, runId);

  // Pre-load pending instructions for the QA-passed cleanup branch.
  // stepIndex=null means "all steps" — Section C extension of the helper
  // (cardInstructions.js findPendingInstructionsForRun). Real cardDefinitions
  // MUST be passed; empty {} would silently classify everything as orphaned.
  const pendingByEntity = await findPendingInstructionsForRun(
    db, runId, null, cardDefinitions
  );

  for (const d of decisions) {
    if (d.decision === 'completed' || d.decision === 'approve') {
      // Terminal success. loop-router emits 'approve' on the all-pass path (it
      // never emits 'completed'); both are terminal-success. The dropped
      // apply_entity_routing RPC used to set terminal_state — Section C must set
      // it here in JS, or runs.js's Step-8 forward (which selects terminal_state
      // IS NOT NULL, runs.js:494) silently drops approved entities → empty
      // bundling. Set it BEFORE the cleanup/push and before the !target_step
      // branch so 'approve' can never fall through to terminal_state='failed'.
      await setTerminalState(db, runId, d.entity_name, 'approved', null);
      // QA-passed cleanup: mark any stale pending from prior rounds as skipped
      // with reason QA_PASSED_ON_RECHECK. Non-fatal — a passed entity has
      // already passed; cleanup failure is logged but doesn't warrant a
      // terminal_state flip.
      const entityPending = pendingByEntity.get(d.entity_name)?.pending || [];
      for (const p of entityPending) {
        try {
          await markSkipped(
            db, runId, d.entity_name, p.step, p.card_id,
            SKIP_REASONS.QA_PASSED_ON_RECHECK
          );
        } catch (err) {
          console.error(
            `[routingHandler] markSkipped QA-passed cleanup failed for ` +
            `${d.entity_name} step=${p.step} card=${p.card_id}: ${err.message}`
          );
        }
      }
      writeResults.push({
        entity_name: d.entity_name,
        decision: d.decision,
        terminal: 'approved',
        instructions_skipped: entityPending.length,
      });
      continue;
    }

    if (d.decision === 'flag_manual' || d.decision === 'failed') {
      // Terminal non-success. Must set terminal_state or these vanish from the
      // runs.js:494 Step-8 forward exactly as approved entities did before the
      // fix (decision='failed' is emitted for dead_site / max_loops_exceeded;
      // flag_manual needs human review).
      const terminal = d.decision === 'failed' ? 'failed' : 'flagged';
      await setTerminalState(db, runId, d.entity_name, terminal, d.failure_reason || null);
      writeResults.push({
        entity_name: d.entity_name,
        decision: d.decision,
        terminal,
        instructions_written: 0,
      });
      continue;
    }

    if (!d.target_step) {
      await setTerminalState(db, runId, d.entity_name, 'failed', 'routing_no_target_step');
      writeResults.push({
        entity_name: d.entity_name,
        decision: d.decision,
        terminal: 'failed',
        error: 'no_target_step',
      });
      continue;
    }

    // Build pending targets. For each active card, derive nextRound from
    // consumed rounds, then BOUND-CHECK card.rounds[String(nextRound)] before
    // emitting the target. Without the bound check, validateCardInstructions
    // would accept the write but the B.5 merge in submoduleRuns.js would
    // silently fall back to base options for the missing round.
    const targets = [];
    const activeCards = d.config_overrides?.active_cards || {};
    const consumedRounds = consumedRoundsByEntity[d.entity_name] || {};
    const exhaustedCards = []; // {step, card_id, reason} triples

    for (const [stepStr, cardIds] of Object.entries(activeCards)) {
      const step = Number(stepStr);
      for (const cardId of cardIds) {
        const card = cardDefinitions[cardId];
        if (!card) {
          exhaustedCards.push({ step, card_id: cardId, reason: 'card_not_in_definitions' });
          continue;
        }
        const alreadyConsumed = new Set((consumedRounds[cardId] || []).map(Number));
        let nextRound = 2;
        while (alreadyConsumed.has(nextRound)) nextRound++;

        // Bound check — required for the B.5 merge contract. Without it,
        // routedHandler would emit a target with card_round=N where
        // card.rounds[String(N)] is undefined, and submoduleRuns.js would
        // silently merge the base options (the "same settings that just
        // failed" silent no-op the Multi-Card Pattern exists to eliminate).
        if (!card.rounds || !card.rounds[String(nextRound)]) {
          exhaustedCards.push({ step, card_id: cardId, reason: 'rounds_exhausted' });
          continue;
        }

        targets.push({
          step,
          card_id: cardId,
          card_round: nextRound,
        });
      }
    }

    // markSkipped each exhausted (step, card_id) pair with the appropriate
    // reason. Loop on real (step, card_id) pairs — no placeholder iteration.
    for (const { step, card_id, reason } of exhaustedCards) {
      try {
        const skipReason = reason === 'card_not_in_definitions'
          ? SKIP_REASONS.CARD_DELETED
          : SKIP_REASONS.ROUNDS_EXHAUSTED;
        await markSkipped(db, runId, d.entity_name, step, card_id, skipReason);
      } catch (err) {
        console.error(
          `[routingHandler] markSkipped exhausted failed for ${d.entity_name} ` +
          `step=${step} card=${card_id}: ${err.message}`
        );
      }
    }

    // If NO viable targets remain after the bound check, the entity is
    // exhausted at the cards level. Flip to terminal_state='failed' with the
    // most informative failure_reason and skip the writeInstructions call.
    if (targets.length === 0) {
      await setTerminalState(
        db, runId, d.entity_name, 'failed',
        exhaustedCards.some(e => e.reason === 'card_not_in_definitions')
          ? 'card_not_in_definitions'
          : 'rounds_exhausted'
      );
      writeResults.push({
        entity_name: d.entity_name,
        decision: d.decision,
        terminal: 'failed',
        instructions_written: 0,
        exhausted_cards: exhaustedCards.length,
      });
      continue;
    }

    // Per-entity try/catch. loop_count bump is ATOMIC inside the RPC via the
    // new p_increment_loop_count parameter — no separate UPDATE means no
    // silent-orphan partial-state shape (a separate UPDATE that failed after
    // the RPC succeeded would persist the instruction with a stale loop_count,
    // letting the next routing pass undercount and grant one extra retry past
    // MAX_LOOPS).
    try {
      const newLoopCount = (loopCounts.get(d.entity_name) || 0) + 1;
      const written = await writeInstructions(db, runId, d.entity_name, {
        routingRound: newLoopCount,
        createdBy: 'routingHandler',
        qaFailures: d.config_overrides?.triggered_by || [],
        targets,
        incrementLoopCount: true,
      });
      writeResults.push({
        entity_name: d.entity_name,
        decision: d.decision,
        target_step: d.target_step,
        instructions_written: targets.length,
        dedup_blocked: !written,
      });
    } catch (err) {
      console.error(
        `[routingHandler] writeInstructions failed for ${d.entity_name}: ${err.message}`
      );
      await setTerminalState(db, runId, d.entity_name, 'failed', 'instruction_write_failed');
      writeResults.push({
        entity_name: d.entity_name,
        decision: d.decision,
        terminal: 'failed',
        instructions_written: 0,
        error: err.message,
      });
    }
  }

  // ── f) Return summary ──────────────────────────────────────────────
  // runs.js (:486,:536) and autoExecutor.js (:404,:418-422) READ all_terminal /
  // routed_count / earliest_step — the Section C rewrite dropped them, which is
  // why an all-approved run halted at 7→8. Derive them defensively from
  // writeResults (single source of truth), never throwing (one malformed row
  // must not poison the batch summary and re-introduce all-or-nothing failure).
  //
  // routed = entities that received an ACTUAL backward-routing write: a write was
  // attempted (instructions_written>0) AND not dedup-blocked (dedup_blocked!==true
  // means a real append happened + loop_count bumped). Counting a dedup-blocked
  // row would feed a too-low earliest_step and re-route an entity with no pending
  // card. earliest_step is the MIN per-entity target_step among genuinely-routed
  // rows — NOT step+1, NOT a global plan minimum (a wrong value silently mis-routes
  // real loop-backs, worse than the loud halt this replaces).
  //
  // Excluding dedup-blocked rows cannot strand a still-pending entity: loop_count
  // is monotonic and read fresh per call, and the bump is atomic with the write
  // (incrementLoopCount inside writeInstructions), so the dedup key advances
  // between passes — a genuinely-routed entity never dedup-blocks within the
  // normal flow. A dedup block means the identical pending card already exists
  // (the entity is ALREADY queued to loop), so it is correctly not re-counted.
  //
  // approved/failed/flagged counts are CURRENT-PASS best-effort (prior-pass
  // terminals are skipped before the loop) and are read only for logging
  // (autoExecutor routing_events), never control flow — the pool-forward decision
  // uses all_terminal/routed_count, which are exact for this pass.
  const routedRows = writeResults.filter(
    (r) => (r.instructions_written || 0) > 0 && r.dedup_blocked !== true && r.target_step != null
  );
  const routed_count = routedRows.length;
  const earliest_step = routed_count > 0
    ? Math.min(...routedRows.map((r) => r.target_step))
    : null;
  return {
    decisions_sent: decisions.length,
    instructions_written: writeResults.reduce(
      (n, r) => n + (r.instructions_written || 0), 0
    ),
    routed_count,
    earliest_step,
    all_terminal: routed_count === 0,
    approved_count: writeResults.filter((r) => r.terminal === 'approved').length,
    failed_count: writeResults.filter((r) => r.terminal === 'failed').length,
    flagged_count: writeResults.filter((r) => r.terminal === 'flagged').length,
    per_entity: writeResults,
  };
}

export { validateCards };
