/**
 * Routing Handler — Phase 3
 *
 * Reads loop-router decisions from entity_submodule_runs, resolves routing_rules
 * into card-based per-entity instructions, enforces max_loops backstop,
 * cascade-deletes stale intermediate data, and calls the apply_entity_routing
 * RPC in a single atomic transaction.
 *
 * Phase 3 additions:
 * - resolveCards(): maps QA failures → routing_rules → card definitions
 * - flag_manual upgrade: when routing_rules resolve cards for a flag_manual
 *   entity (2+ QA failures), the decision is upgraded to loop_*
 * - validateCards(): template save-time validation for card/rule consistency
 * - DECISION_TARGET_MAP retained as fallback for templates without routing_rules
 *
 * Called by the approval handler in runs.js when routing is detected.
 */

const MAX_LOOPS = 3;
const LAST_STEP = 10; // Pipeline ceiling (from stepConfig)

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

  return warnings;
}

/**
 * Apply routing for a run. Reads loop-router output, builds decisions for
 * ALL entities, enforces max_loops, cascade-deletes stale data, calls RPC.
 *
 * @param {object} db - Supabase client
 * @param {string} runId - The run UUID
 * @param {number} routingStep - The step index where routing runs (default 10)
 * @param {object} [executionPlan={}] - Template execution_plan (cards + routing_rules)
 * @returns {object} Routing summary from the RPC
 * @throws {Error} If no router output found (always a bug) or RPC fails
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

  // ── e) Cascade-delete stale intermediate data for routed entities ───
  const routedEntities = decisions.filter(d => d.target_step !== undefined);
  for (const d of routedEntities) {
    const { error: delErr } = await db
      .from('entity_submodule_runs')
      .delete()
      .eq('run_id', runId)
      .eq('entity_name', d.entity_name)
      .gte('step_index', d.target_step)
      .lte('step_index', LAST_STEP);

    if (delErr) {
      console.error(
        `[routingHandler] Failed to delete stale runs for ${d.entity_name}: ${delErr.message}`
      );
    }
  }

  // Also delete parent submodule_runs records for reactivated steps.
  // Without this, checkExistingSubmoduleRun in autoExecutor finds old 'approved'
  // records and skips every submodule on loop re-entry — silently breaking routing.
  if (routedEntities.length > 0) {
    const earliestTarget = Math.min(...routedEntities.map(d => d.target_step));

    const { data: staleStages } = await db
      .from('pipeline_stages')
      .select('id')
      .eq('run_id', runId)
      .gte('step_index', earliestTarget)
      .lte('step_index', LAST_STEP);

    if (staleStages && staleStages.length > 0) {
      const { error: smDelErr } = await db
        .from('submodule_runs')
        .delete()
        .in('stage_id', staleStages.map(s => s.id));

      if (smDelErr) {
        console.error(`[routingHandler] Failed to delete stale submodule_runs: ${smDelErr.message}`);
      } else {
        console.log(`[routingHandler] Deleted submodule_runs for steps ${earliestTarget}-${LAST_STEP} (${staleStages.length} stages)`);
      }
    }
  }

  // ── f) Call RPC ─────────────────────────────────────────────────────
  const { data: rpcResult, error: rpcErr } = await db.rpc('apply_entity_routing', {
    p_run_id: runId,
    p_routing_decisions: decisions,
    p_routing_step: routingStep,
  }).single();

  if (rpcErr) {
    throw new Error(`apply_entity_routing RPC failed: ${rpcErr.message}`);
  }

  // ── g) Return summary ──────────────────────────────────────────────
  return {
    ...rpcResult,
    decisions_sent: decisions.length,
    routed_entities: routedEntities.map(d => ({
      entity_name: d.entity_name,
      decision: d.decision,
      target_step: d.target_step,
    })),
  };
}

export { validateCards };
