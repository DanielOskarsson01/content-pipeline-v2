/**
 * Tuning sessions (TUNING-SESSIONS v1, T1+).
 *
 * `db` is injected (repo convention — workbenchExperiments.js, cardInstructions.js)
 * so hermetic tests never touch db.js or its env guard.
 *
 * These tables are OUTSIDE retention's RUN_ID_TABLES and carry NO FK to
 * pipeline_runs — a session survives deletion of its source run. The one
 * destructive operation here, erase-downstream, deletes tuning_session_steps
 * rows ONLY; workbench_experiments (the durable log) is never touched.
 */

/**
 * The one live tuning session per (run, entity) — decision 1, "one live chain
 * per session". Created on first accept, re-used thereafter.
 */
export async function getOrCreateSession(sourceRunId, entityName, db) {
  const { data: existing, error: selErr } = await db
    .from('tuning_sessions')
    .select('*')
    .eq('source_run_id', sourceRunId)
    .eq('entity_name', entityName)
    .maybeSingle();
  if (selErr) throw new Error(`tuning_sessions read failed: ${selErr.message}`);
  if (existing) return existing;

  const { data, error } = await db
    .from('tuning_sessions')
    .insert({ source_run_id: sourceRunId, entity_name: entityName })
    .select()
    .single();
  if (error) {
    // 23505 = a concurrent create won the UNIQUE(source_run_id, entity_name)
    // race; re-read rather than fail (two browser tabs, same run+entity).
    if (error.code === '23505') {
      const { data: raced } = await db
        .from('tuning_sessions').select('*')
        .eq('source_run_id', sourceRunId).eq('entity_name', entityName).maybeSingle();
      if (raced) return raced;
    }
    throw new Error(`tuning_sessions create failed: ${error.message}`);
  }
  return data;
}

/** Read-only: the session for (run, entity), or null. Does NOT create one. */
export async function findSession(sourceRunId, entityName, db) {
  const { data, error } = await db
    .from('tuning_sessions')
    .select('*')
    .eq('source_run_id', sourceRunId)
    .eq('entity_name', entityName)
    .maybeSingle();
  if (error) throw new Error(`tuning_sessions read failed: ${error.message}`);
  return data || null;
}

/** Accepted steps for a session, ascending by step. */
export async function getSessionSteps(sessionId, db) {
  const { data, error } = await db
    .from('tuning_session_steps')
    .select('*')
    .eq('session_id', sessionId)
    .order('step_index', { ascending: true });
  if (error) throw new Error(`tuning_session_steps read failed: ${error.message}`);
  return data || [];
}

/** The accepted step at or nearest-below `stepIndex` (the parent T2 chains from). */
export async function getAcceptedUpstream(sessionId, stepIndex, db) {
  const steps = await getSessionSteps(sessionId, db);
  const upstream = steps.filter(s => s.step_index < stepIndex);
  return upstream.length ? upstream[upstream.length - 1] : null;
}

/**
 * Mark `experimentId` accepted for `stepIndex` in the session, then ERASE every
 * accepted step DOWNSTREAM (step_index > stepIndex) — settled decision 1:
 * changing an earlier step invalidates everything after it, so no stale state
 * survives. This deletes tuning_session_steps rows ONLY; workbench_experiments
 * is never touched (decision 2 — they stay queryable for the step-10 summary).
 *
 * The erase is read-before-delete and logged loudly so a surprised user can
 * reconstruct exactly what was cleared.
 *
 * @returns {{ accepted, erased }} erased = the cleared downstream step rows.
 */
export async function acceptExperiment({ sessionId, stepIndex, experimentId, submoduleId }, db, log = console) {
  // 1. Upsert the accepted marker for this step (re-accept replaces it).
  const { error: upErr } = await db
    .from('tuning_session_steps')
    .upsert(
      {
        session_id: sessionId,
        step_index: stepIndex,
        experiment_id: experimentId,
        submodule_id: submoduleId,
        accepted_at: new Date().toISOString(),
      },
      { onConflict: 'session_id,step_index' },
    );
  if (upErr) throw new Error(`tuning_session_steps accept failed: ${upErr.message}`);

  // 2. Read what will be erased BEFORE deleting, so the log + response name it.
  const { data: downstream, error: dErr } = await db
    .from('tuning_session_steps')
    .select('step_index, experiment_id, submodule_id')
    .eq('session_id', sessionId)
    .gt('step_index', stepIndex);
  if (dErr) throw new Error(`tuning_session_steps downstream read failed: ${dErr.message}`);
  const erased = downstream || [];

  // 3. Erase downstream (session-only). workbench_experiments is NOT touched.
  if (erased.length) {
    const { error: delErr } = await db
      .from('tuning_session_steps')
      .delete()
      .eq('session_id', sessionId)
      .gt('step_index', stepIndex);
    if (delErr) throw new Error(`tuning_session_steps erase-downstream failed: ${delErr.message}`);
    const cleared = erased.map(d => `s${d.step_index}:${d.experiment_id}`).join(', ');
    (log.warn || log.log)?.call(log,
      `[tuning] session ${sessionId}: accepted step ${stepIndex} (exp ${experimentId}) — ` +
      `ERASED ${erased.length} downstream step(s): ${cleared}`);
  }

  // 4. Touch the session so "most recently active" is queryable.
  await db.from('tuning_sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId);

  return {
    accepted: { session_id: sessionId, step_index: stepIndex, experiment_id: experimentId, submodule_id: submoduleId },
    erased,
  };
}

/**
 * T2: resolve the effective chain parent for a session-mode experiment, without
 * the caller hand-picking a parent. Explicit `parent_experiment_id` always wins.
 * Otherwise chain from the accepted experiment at the nearest accepted upstream
 * step. The returned `sessionBlock` rides the experiment response and makes a
 * pool fallback (no accepted upstream) UNMISTAKABLE — the "silently scored the
 * pool" failure class this feature must not reintroduce.
 *
 * @returns {{ effectiveParent: string|null, sessionBlock: object|null }}
 */
export async function resolveSessionParent({ source_run_id, entity_name, step_index, parent_experiment_id, useSession }, db) {
  if (!useSession) return { effectiveParent: parent_experiment_id || null, sessionBlock: null };
  if (parent_experiment_id) {
    return {
      effectiveParent: parent_experiment_id,
      sessionBlock: {
        session_id: null, chained_from: parent_experiment_id, chained_from_step: null,
        note: 'used the explicitly supplied parent_experiment_id (session auto-chain skipped)',
      },
    };
  }
  if (!source_run_id || !entity_name || step_index == null) {
    // runExperimentCore will 400 on the missing fields — don't invent a session.
    return { effectiveParent: null, sessionBlock: null };
  }
  const sess = await findSession(source_run_id, entity_name, db);
  if (!sess) {
    return {
      effectiveParent: null,
      sessionBlock: {
        session_id: null, chained_from: null, chained_from_step: null,
        note: 'no tuning session yet for this run+entity — ran against the raw pool',
      },
    };
  }
  const upstream = await getAcceptedUpstream(sess.id, step_index, db);
  if (!upstream) {
    return {
      effectiveParent: null,
      sessionBlock: {
        session_id: sess.id, chained_from: null, chained_from_step: null,
        note: 'no accepted upstream step — ran against the raw pool',
      },
    };
  }
  return {
    effectiveParent: upstream.experiment_id,
    sessionBlock: {
      session_id: sess.id, chained_from: upstream.experiment_id, chained_from_step: upstream.step_index,
      note: `chained from the accepted step-${upstream.step_index} experiment`,
    },
  };
}
