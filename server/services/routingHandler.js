/**
 * Routing Handler — Phase 2
 *
 * Reads loop-router decisions from entity_submodule_runs, enforces max_loops
 * backstop, cascade-deletes stale intermediate data, and calls the
 * apply_entity_routing RPC in a single atomic transaction.
 *
 * Called by the Step 10 approval handler in runs.js when routing_pending=true.
 */

const MAX_LOOPS = 3;

// Decision → target_step mapping (hardcoded — escalation config deferred)
const DECISION_TARGET_MAP = {
  loop_discovery: 1,
  loop_tone: 5,
  loop_generation: 5,
};

/**
 * Apply routing for a run. Reads loop-router output, builds decisions for
 * ALL entities, enforces max_loops, cascade-deletes stale data, calls RPC.
 *
 * @param {object} db - Supabase client
 * @param {string} runId - The run UUID
 * @returns {object} Routing summary from the RPC
 * @throws {Error} If no router output found (always a bug) or RPC fails
 */
export async function applyRouting(db, runId) {
  // ── a) Read loop-router output ──────────────────────────────────────
  const { data: routerRuns, error: routerErr } = await db
    .from('entity_submodule_runs')
    .select('entity_name, output_data')
    .eq('run_id', runId)
    .eq('step_index', 10)
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
    .select('entity_name, loop_count')
    .eq('run_id', runId);

  if (metaErr) {
    throw new Error(`Failed to read entity_run_meta: ${metaErr.message}`);
  }

  const loopCounts = new Map(
    (allEntities || []).map(m => [m.entity_name, m.loop_count || 0])
  );

  const decisions = [];
  for (const meta of (allEntities || [])) {
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
  for (const d of decisions) {
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
      .lte('step_index', 10);

    if (delErr) {
      console.error(
        `[routingHandler] Failed to delete stale runs for ${d.entity_name}: ${delErr.message}`
      );
      // Non-fatal — the RPC will still work, but checkExistingSubmoduleRun may
      // find stale rows. Log and continue.
    }
  }

  // ── f) Call RPC ─────────────────────────────────────────────────────
  const { data: rpcResult, error: rpcErr } = await db.rpc('apply_entity_routing', {
    p_run_id: runId,
    p_routing_decisions: decisions,
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
