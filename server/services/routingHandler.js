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

// WF-2 (V6-§3, Daniel-confirmed 2026-07-09) — failure_reason → terminal_state.
// Escalation-overflow reasons FLAG-and-CONTINUE: the entity is NOT stopped at
// Step 7 — it still flows to steps 8/9 carrying its failure tags, and a human
// adjudicates at the Step-9 delivery gate (§9.3). Corruption / misconfiguration
// reasons stay 'failed' (not publishable — must never read as "needs review").
// The value change is inert against every current terminal_state reader (none
// branches on the value — 2.3c §3, re-verified in unit 2.5); it becomes
// meaningful only at the Step-9 exclusion gate (unit 5.x).
const FLAG_AND_CONTINUE_REASONS = new Set([
  'rounds_exhausted',
  'no_card_for_round',
  'max_loops_exceeded',
]);
function terminalStateForReason(reason) {
  return FLAG_AND_CONTINUE_REASONS.has(reason) ? 'flagged' : 'failed';
}

// ---------------------------------------------------------------------------
// Card resolution helpers (Phase 3)
// ---------------------------------------------------------------------------

/**
 * INV-ROUND (V6-§1.5, W4) — the loop_count → escalation-round contract.
 *
 * An entity's selection round = loop_count + 2. Round 1 is the first pass
 * (loop_count = 0, executed via placement — no routing instruction). The first
 * routing pass observes the PRE-BUMP loop_count = 0 and selects round 2; the
 * atomic loop_count bump (writeInstructions incrementLoopCount) advances it for
 * the NEXT pass. Reachable rounds are {2,3,4} across the MAX_LOOPS=3 budget,
 * consistent with MAX_ROUNDS=4. A selection round with no matching card.round
 * hits the V6-§3 flag-and-continue terminus (no_card_for_round).
 *
 * Single NAMED contract (never inline `loop_count + 2` at a call site).
 *
 * @param {number} loopCount - the entity's PRE-BUMP loop_count snapshot
 * @returns {number} the scalar card.round to select this pass
 */
function selectionRound(loopCount) {
  return (Number(loopCount) || 0) + 2;
}

/**
 * Resolve QA failures into card-based per-entity instructions using routing_rules.
 *
 * v6 engine inversion (unit 2.5): cards carry a SCALAR `round` (not a `rounds`
 * map). resolveCards PARTITIONS a failing check's rule targets by `card.round`
 * and SELECTS the single card whose round matches the entity's escalation round
 * (INV-ROUND = loop_count + 2). The pre-v6 `nextRound` ascending walk + the
 * `card.rounds[nextRound]` bound-check are DELETED — selection is a direct
 * partition-and-match, and card_round becomes fixed = the selected card's round.
 * (Canonical schema is UUID-keyed `card_definitions` + array-form routing_rules;
 * the legacy `cards`/`{target_cards}` shape resolves nothing — see routingHandler.test.js.)
 *
 * Return contract:
 *   - null                                          → nothing selectable (no rule
 *       fired, malformed target, or missing card_id); caller keeps the router decision.
 *   - { active_cards, triggered_by, missing_reason:null }
 *                                                   → one or more round-matched cards.
 *   - { active_cards:{}, triggered_by, missing_reason }
 *                                                   → an escalation candidate existed but
 *       produced no round-match: 'card_not_in_definitions' (a target references an absent
 *       card — corruption → terminal 'failed'), or 'no_card_for_round' (a real card exists
 *       at the WRONG round — overflow/gap → V6-§3 flag-and-continue 'flagged'). Corruption
 *       DOMINATES overflow so it is never masked as publishable-needs-review (WF-2).
 *
 * @param {object} qaScores      - { <check>: 'pass'|'fail'|'missing', ... } from loop-router
 * @param {object} executionPlan - Template execution_plan (card_definitions + routing_rules)
 * @param {number} loopCount     - the entity's PRE-BUMP loop_count (INV-ROUND input)
 * @returns {object|null} see return contract above
 */
function resolveCards(qaScores, executionPlan, loopCount = 0) {
  const rules = executionPlan?.routing_rules || {};
  const cards = executionPlan?.card_definitions || {};
  const targetRound = selectionRound(loopCount);

  const activeCards = {};  // step → [card_id, ...]
  const triggeredBy = [];
  let sawAbsentCard = false;  // a rule target names a card absent from card_definitions (corruption)
  let sawWrongRound = false;  // a real card exists but at a round ≠ targetRound (overflow / gap)

  for (const [check, result] of Object.entries(qaScores || {})) {
    if (result !== 'fail') continue;
    const targets = rules[`${check}:fail`];
    if (!Array.isArray(targets) || targets.length === 0) continue;  // no rule → nothing to escalate
    triggeredBy.push(`${check}:fail`);
    for (const target of targets) {
      const cardId = target?.card_id;
      if (!cardId) continue;  // malformed target — ignore (never signals overflow)
      const card = cards[cardId];
      if (!card) { sawAbsentCard = true; continue; }  // rule references a card_id absent from card_definitions
      // INV-ROUND partition-and-match: select this card iff it IS the entity's round.
      if (Number(card.round) !== targetRound) { sawWrongRound = true; continue; }
      // The rule target carries the routing step (kept equal to the card's own
      // step); fall back to the card definition's step.
      const step = String(target.step ?? card.step);
      if (!activeCards[step]) activeCards[step] = [];
      if (!activeCards[step].includes(cardId)) activeCards[step].push(cardId);
    }
  }

  if (Object.keys(activeCards).length > 0) {
    return { active_cards: activeCards, triggered_by: triggeredBy, missing_reason: null };
  }
  // No round-matched card. Corruption (absent card) DOMINATES overflow so it is
  // never masked as "publishable-needs-review" (WF-2: card_not_in_definitions → failed).
  if (sawAbsentCard) {
    return { active_cards: {}, triggered_by: triggeredBy, missing_reason: 'card_not_in_definitions' };
  }
  if (sawWrongRound) {
    return { active_cards: {}, triggered_by: triggeredBy, missing_reason: 'no_card_for_round' };
  }
  // No selectable candidate at all → keep the router decision (existing flag_manual path).
  return null;
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
  // Canonical schema (PHASE_3B §1.2 / §2.1): UUID-keyed card_definitions +
  // routing_rules["<check>:fail"] = [{ step, card_id }]. (Pre-2026-06-15 this
  // read the legacy `cards` + `rule.target_cards` shape and silently passed
  // every real card_definitions config — see routingHandler.test.js.)
  const cards = executionPlan?.card_definitions || {};
  const rules = executionPlan?.routing_rules || {};
  // Targets of a routing rule, tolerating a malformed (non-array) value.
  const ruleTargets = (rule) => (Array.isArray(rule) ? rule : []);

  // Card definition validation
  for (const [cardId, card] of Object.entries(cards)) {
    if (!card.submodule_id) warnings.push(`Card "${cardId}": missing submodule_id`);
    else if (registeredSubmodules && !registeredSubmodules.includes(card.submodule_id))
      warnings.push(`Card "${cardId}": submodule "${card.submodule_id}" not found`);
    if (card.step === undefined) warnings.push(`Card "${cardId}": missing step`);
  }

  // Routing rule → card reference validation
  for (const [ruleKey, rule] of Object.entries(rules)) {
    for (const target of ruleTargets(rule)) {
      const cardId = target?.card_id;
      if (!cardId || !cards[cardId]) {
        warnings.push(`Rule "${ruleKey}": targets unknown card_id "${cardId}"`);
      }
    }
  }

  // Same-submodule collision detection: warn when different routing rules
  // can activate multiple cards targeting the same submodule at the same step.
  // Only the first card wins at execution time (break in submoduleRuns.js),
  // but all are marked consumed — silently wasting card variants.
  const allRuleCardIds = new Set();
  for (const rule of Object.values(rules)) {
    for (const target of ruleTargets(rule)) {
      if (target?.card_id) allRuleCardIds.add(target.card_id);
    }
  }
  const slotMap = {};  // "step:submodule_id" → [card_id, ...]
  for (const cardId of allRuleCardIds) {
    const card = cards[cardId];
    if (!card) continue;
    const slot = `${card.step}:${card.submodule_id}`;
    if (!slotMap[slot]) slotMap[slot] = [];
    slotMap[slot].push(cardId);
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
 * Persist one entity's QA scores to entity_run_meta:
 *   - last_qa_scores   ← latest scores object (overwrite)
 *   - qa_score_history ← APPEND { iteration, scores, timestamp } (never overwrite)
 *
 * Restores the write DROPPED when Section C (2026-06-04, commit be07509)
 * replaced the apply_entity_routing RPC with JS routing. That RPC recorded
 * exactly this shape (migration_move_routing_to_step7.sql:169-180) for every
 * decision carrying qa_scores, keyed by the current loop_count. The columns
 * still exist (migration_routing.sql:18-19); only the writer was lost, so QA
 * quality history has silently stopped accumulating since that rewrite.
 *
 * PURELY ADDITIVE. This records quality history and nothing else — it never
 * reads or alters terminal_state, the routing decision, target_step, or the
 * loop_count bump. It is called once per decision at the TOP of the applyRouting
 * per-entity loop (the same pre-dispatch position the dropped RPC used), so
 * routed entities accrue per-iteration history, not just terminal ones.
 *
 * DEFENSIVE BY CONTRACT (this fix must never destabilise routing):
 *   - a missing / null / malformed score is a no-op (no partial or garbage row);
 *   - no failure here — a read {error}, a write {error}, or a thrown exception —
 *     is allowed to abort the routing batch. Quality history is a side-record,
 *     never load-bearing the way the terminal_state write is.
 *
 * supabase-js has no server-side JSONB `||` append, and this file's persistence
 * idiom is select + update (not raw SQL), so history is appended read-modify-
 * write. Safe here: each entity is processed exactly once per applyRouting pass,
 * sequentially, and only this function writes these two columns.
 *
 * @param {object} db - Supabase client
 * @param {string} runId - The run UUID
 * @param {string} entityName - Entity whose scores to record
 * @param {*} qaScores - Scores object from loop-router output (e.g. { citation: 0.72 })
 * @param {number} iteration - Current loop_count (the round these scores rate)
 */
async function recordQaScores(db, runId, entityName, qaScores, iteration) {
  // Only a non-null, non-array object with at least one key is a valid score
  // set. null / undefined / string / number / array / {} → skip. (The dropped
  // RPC gated on `qa_scores IS NOT NULL`; we additionally reject shapes that
  // would write garbage into the history array.)
  if (
    !qaScores ||
    typeof qaScores !== 'object' ||
    Array.isArray(qaScores) ||
    Object.keys(qaScores).length === 0
  ) {
    return;
  }

  try {
    const { data: current, error: readErr } = await db
      .from('entity_run_meta')
      .select('qa_score_history')
      .eq('run_id', runId)
      .eq('entity_name', entityName)
      .maybeSingle();

    if (readErr) {
      console.error(
        `[routingHandler] FAILED to read qa_score_history for ${entityName} ` +
        `(run ${runId}): ${readErr.message || readErr}. Skipping QA-score ` +
        `record for this round (non-fatal).`
      );
      return;
    }

    const history = Array.isArray(current?.qa_score_history)
      ? current.qa_score_history
      : [];
    history.push({
      iteration: iteration ?? 0,
      scores: qaScores,
      timestamp: new Date().toISOString(),
    });

    const { error: writeErr } = await db
      .from('entity_run_meta')
      .update({
        last_qa_scores: qaScores,
        qa_score_history: history,
        updated_at: new Date().toISOString(),
      })
      .eq('run_id', runId)
      .eq('entity_name', entityName);

    if (writeErr) {
      console.error(
        `[routingHandler] FAILED to persist qa_score_history for ${entityName} ` +
        `(run ${runId}): ${writeErr.message || writeErr}. Quality history not ` +
        `updated for this round (non-fatal).`
      );
    }
  } catch (err) {
    // A quality-history write must never abort the routing batch.
    console.error(
      `[routingHandler] Unexpected error recording QA scores for ${entityName} ` +
      `(run ${runId}): ${err?.message || err}. Non-fatal.`
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
  // Canonical UUID-keyed card_definitions (PHASE_3B §1.2); was `cards` (legacy)
  // pre-2026-06-15 — which left this {} for every real template, starving the
  // routed-target build below (cardDefinitions[cardId]).
  const cardDefinitions = executionPlan?.card_definitions || {};

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
      const loopCount = meta?.loop_count || 0;  // PRE-BUMP snapshot (INV-ROUND)
      const cardResult = resolveCards(routerItem.qa_scores, executionPlan, loopCount);
      if (!cardResult) continue;

      d.config_overrides = cardResult;

      // No round-matched card (INV-ROUND = loop_count+2): escalation overflow or
      // template corruption. Route into the terminal write (§3/W5) rather than a
      // silent continue. Corruption → 'card_not_in_definitions' (→ 'failed') ALWAYS;
      // overflow → 'no_card_for_round' (→ flag-and-continue 'flagged') UNLESS the
      // loop budget is already spent, in which case the MAX_LOOPS backstop below
      // owns the terminus (max_loops_exceeded) so the loop-ceiling reason is kept.
      const cardSteps = Object.keys(cardResult.active_cards).map(Number);
      if (cardSteps.length === 0) {
        if (cardResult.missing_reason === 'card_not_in_definitions') {
          d.card_terminus = 'card_not_in_definitions';
          delete d.target_step;
        } else if (loopCount < MAX_LOOPS) {
          d.card_terminus = 'no_card_for_round';
          delete d.target_step;
        }
        continue;
      }

      // Compute target_step from earliest card step
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

  // Pre-load pending instructions for the QA-passed cleanup branch.
  // stepIndex=null means "all steps" — Section C extension of the helper
  // (cardInstructions.js findPendingInstructionsForRun). Real cardDefinitions
  // MUST be passed; empty {} would silently classify everything as orphaned.
  const pendingByEntity = await findPendingInstructionsForRun(
    db, runId, null, cardDefinitions
  );

  for (const d of decisions) {
    // Persist QA scores BEFORE dispatch (restores the Section-C-dropped RPC
    // write). Additive only — never touches terminal_state/routing. Done here,
    // once per decision, so routed AND terminal entities accrue per-iteration
    // history; iteration = current loop_count (the round these scores rate),
    // matching the dropped RPC. Awaited but self-guarded to never throw.
    await recordQaScores(db, runId, d.entity_name, d.qa_scores, loopCounts.get(d.entity_name) || 0);

    // Escalation-overflow / corruption terminus (V6-§3 flag-and-continue / WF-2).
    // resolveCards found no card at the entity's round (INV-ROUND). Reuse the
    // existing setTerminalState write and BRANCH THE VALUE on the reason:
    //   no_card_for_round        → 'flagged' (routing-terminal; entity CONTINUES to steps 8/9)
    //   card_not_in_definitions  → 'failed'  (template corruption; not publishable)
    // Reached ONLY for a genuine round overflow/gap or a corrupt card reference —
    // never as a silent no-op (V6-§1.5 makes dispatch real, so this is not masking
    // an un-run escalation the way B1 did).
    if (d.card_terminus) {
      const terminal = terminalStateForReason(d.card_terminus);
      await setTerminalState(db, runId, d.entity_name, terminal, d.card_terminus);
      writeResults.push({
        entity_name: d.entity_name,
        decision: d.decision,
        terminal,
        instructions_written: 0,
        failure_reason: d.card_terminus,
      });
      continue;
    }

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
      // flag_manual needs human review). flag_manual → 'flagged'; a 'failed'
      // decision's terminal_state is branched on its reason (WF-2): the
      // escalation-overflow reason max_loops_exceeded FLAGS-and-continues, while
      // genuine failures (e.g. dead_site) stay 'failed'.
      const terminal = d.decision === 'flag_manual'
        ? 'flagged'
        : terminalStateForReason(d.failure_reason);
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

    // Build pending targets. v6 inversion: card_round is FIXED = the selected
    // card's scalar `round` (resolveCards already partitioned by round via
    // INV-ROUND). The pre-v6 nextRound walk + card.rounds bound-check, and the
    // exhaustion terminus + markSkipped they fed, are GONE — overflow / corruption
    // is detected upstream by resolveCards' missing_reason (d.card_terminus,
    // handled above) before we reach here.
    const targets = [];
    const activeCards = d.config_overrides?.active_cards || {};
    for (const [stepStr, cardIds] of Object.entries(activeCards)) {
      const step = Number(stepStr);
      for (const cardId of cardIds) {
        const card = cardDefinitions[cardId];
        if (!card) continue;  // defensive — resolveCards only emits present, round-matched cards
        targets.push({
          step,
          card_id: cardId,
          card_round: Number(card.round),
        });
      }
    }

    // Defensive: active_cards was non-empty but nothing resolved (should not
    // happen — resolveCards only emits present, round-matched cards).
    if (targets.length === 0) {
      await setTerminalState(db, runId, d.entity_name, 'failed', 'routing_no_target_step');
      writeResults.push({
        entity_name: d.entity_name,
        decision: d.decision,
        terminal: 'failed',
        instructions_written: 0,
        error: 'no_resolved_targets',
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

export { validateCards, resolveCards, recordQaScores };
