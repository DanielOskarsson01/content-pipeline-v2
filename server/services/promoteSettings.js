/**
 * Promote-settings (TUNING-SESSIONS v1, T3) — write an accepted experiment's
 * tuned options back to a template's preset_map.fallback_values so FUTURE runs
 * resolve to them.
 *
 * The load-bearing hazard (2026-07-22, two days lost): a value written to
 * fallback_values was SILENTLY shadowed by a higher option_presets layer.
 * Resolution order (resolvePresetMap): project preset -> global preset ->
 * fallback_values -> manifest default. A *fresh* run of a template creates a
 * NEW project with no project-scoped presets, so only a GLOBAL option_presets
 * row can shadow it. Therefore:
 *   - target = template.preset_map[submodule].fallback_values, written by the
 *     template PK (never a name-matched option_presets write);
 *   - REFUSE the whole write if a GLOBAL row would shadow any option, naming the
 *     row id (fail-closed — never industrialise the silent-shadow bug);
 *   - a project-scoped row for THIS run's project can't affect a fresh run, so
 *     it is a WARNING (it would shadow a same-project re-run), not a refusal;
 *   - back up the prior preset_map, read back + md5-verify, then PROVE a fresh
 *     run resolves to the new value by re-running the REAL resolvePresetMap.
 *
 * `db` is injected (repo convention). Writes exactly one table: `templates`
 * (by PK). Reads option_presets / pipeline_runs. No real-run pool writes.
 */
import { createHash } from 'node:crypto';
import { resolvePresetMapWith } from './presetResolution.js';

const md5 = (v) => createHash('md5').update(JSON.stringify(v ?? null)).digest('hex');

// A synthetic project id with no option_presets rows — models "a fresh run"
// (new project) for the shadow analysis and the post-write resolution proof.
export const FRESH_RUN_PROBE_PROJECT = '00000000-0000-0000-0000-000000000000';

/**
 * Rows in option_presets that resolvePresetMap would consult for
 * (submodule, option) under `presetName`, split by layer. Each is null or
 * { row_id, value }. When presetName is falsy, resolvePresetMap ignores
 * option_presets entirely, so nothing can shadow.
 */
export async function findShadows({ submoduleId, optionName, presetName, projectId, db }) {
  if (!presetName) return { global: null, project: null };
  const { data, error } = await db
    .from('option_presets')
    .select('id, preset_value, project_id')
    .eq('submodule_id', submoduleId)
    .eq('option_name', optionName)
    .eq('preset_name', presetName);
  if (error) throw new Error(`option_presets read failed: ${error.message}`);
  let global = null; let project = null;
  for (const row of data || []) {
    if (row.project_id == null) global = { row_id: row.id, value: row.preset_value };
    else if (row.project_id === projectId) project = { row_id: row.id, value: row.preset_value };
  }
  return { global, project };
}

/**
 * @param {object}  args.experiment   the accepted experiment row (supplies submodule_id + overrides)
 * @param {object}  args.template     the target template row (id + preset_map)
 * @param {string?} args.projectId    the run's project id (for the same-project shadow warning)
 * @param {boolean} args.dryRun       true = analyse + plan, write NOTHING (drives the UI confirmation)
 * @param {object}  args.db           injected supabase client
 */
export async function promoteExperimentSettings({ experiment, template, projectId, dryRun = false, db }) {
  const submoduleId = experiment.submodule_id;
  const overrides = experiment.overrides || {};
  const optionNames = Object.keys(overrides);
  const presetMap = template.preset_map || {};
  const entry = presetMap[submoduleId] || {};
  const presetName = entry.preset_name || null;

  const targetLayer = 'template.preset_map.fallback_values';
  if (!optionNames.length) {
    return { promoted: 0, target_layer: targetLayer, template_id: template.id, submodule_id: submoduleId, plan: [], message: 'experiment has no overrides to promote' };
  }

  // ---- pre-write shadow analysis (refuse on GLOBAL, warn on same-project) ----
  const conflicts = []; const warnings = []; const plan = [];
  for (const option of optionNames) {
    const newValue = overrides[option];
    const oldValue = (entry.fallback_values || {})[option] ?? null;
    plan.push({ submodule_id: submoduleId, option, old: oldValue, new: newValue, changes: md5(oldValue) !== md5(newValue) });
    const { global, project } = await findShadows({ submoduleId, optionName: option, presetName, projectId, db });
    if (global && md5(global.value) !== md5(newValue)) {
      conflicts.push({ option, layer: 'global', preset_name: presetName, row_id: global.row_id, would_resolve_to: global.value, blocked_new: newValue });
    }
    if (project && md5(project.value) !== md5(newValue)) {
      warnings.push({ option, layer: 'project', preset_name: presetName, row_id: project.row_id, note: "a project-scoped preset shadows a SAME-project re-run; fresh runs are unaffected" });
    }
  }

  const preview = {
    target_layer: targetLayer, template_id: template.id, template_name: template.name ?? null,
    submodule_id: submoduleId, preset_name: presetName, plan, conflicts, warnings,
  };

  if (conflicts.length) {
    return { ...preview, promoted: 0, refused: true, reason: 'a higher (global) option_presets layer would shadow this write — resolve or delete the named row(s), or promote to the global layer explicitly' };
  }
  if (dryRun) {
    return { ...preview, promoted: 0, dry_run: true };
  }

  // ---- backup, then write template.fallback_values by PK ----
  const backup = { template_id: template.id, preset_map_before: JSON.parse(JSON.stringify(presetMap)) };
  const nextEntry = { ...entry, fallback_values: { ...(entry.fallback_values || {}) } };
  for (const p of plan) nextEntry.fallback_values[p.option] = p.new;
  const nextPresetMap = { ...presetMap, [submoduleId]: nextEntry };

  const { error: upErr } = await db
    .from('templates')
    .update({ preset_map: nextPresetMap, updated_at: new Date().toISOString() })
    .eq('id', template.id); // PK target
  if (upErr) throw new Error(`template promote write failed: ${upErr.message}`);

  // ---- read back + md5-verify the written values ----
  const { data: readBack, error: rbErr } = await db
    .from('templates').select('id, preset_map').eq('id', template.id).maybeSingle();
  if (rbErr) throw new Error(`template read-back failed: ${rbErr.message}`);
  const verification = plan.map(p => {
    const got = readBack?.preset_map?.[submoduleId]?.fallback_values?.[p.option];
    return { option: p.option, ok: md5(got) === md5(p.new), md5_expected: md5(p.new), md5_got: md5(got) };
  });
  const badVerify = verification.filter(v => !v.ok);
  if (badVerify.length) throw new Error(`promote read-back mismatch: ${JSON.stringify(badVerify)}`);

  // ---- PROVE a fresh run resolves to the new values (REAL resolver) ----
  const resolved = await resolvePresetMapWith(readBack.preset_map, FRESH_RUN_PROBE_PROJECT, db);
  const resolvedProof = plan.map(p => {
    const got = resolved?.[submoduleId]?.[p.option];
    return { option: p.option, fresh_run_resolves_to: got, matches_new: md5(got) === md5(p.new) };
  });
  const proofFailures = resolvedProof.filter(r => !r.matches_new);
  if (proofFailures.length) {
    // Should be impossible after the pre-write refusal, but never claim success
    // on an unproven resolution — that is the exact silent-shadow failure class.
    throw new Error(`promote proof failed — a fresh run would NOT resolve to the promoted value: ${JSON.stringify(proofFailures)}`);
  }

  return {
    ...preview, promoted: plan.length, refused: false,
    backup, verification, resolved_proof: resolvedProof,
  };
}
