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
 *   - PROVE BEFORE WRITE: resolve the candidate preset_map for a fresh run and
 *     REFUSE (no write) if any option would not resolve to the new value —
 *     closes the write-then-corrupt window (review T3 F2);
 *   - REFUSE (409) if a GLOBAL row would shadow, naming the row id; a
 *     project-scoped row only WARNS (fresh runs = new project, unaffected), and
 *     project rows on OTHER projects are surfaced as warnings too (F4);
 *   - mirror the resolver exactly: it consults EVERY preset_name in the template
 *     and indexes by submodule::option, so a shadow can come from a row under
 *     ANY of the template's preset_names (review T3 F3);
 *   - md5 over a CANONICAL (key-sorted) form so a Postgres jsonb round-trip
 *     (which does not preserve object key order) can't false-fail an
 *     object-valued override (review T3 F1);
 *   - optimistic-concurrency lock on updated_at so a concurrent template edit
 *     can't be clobbered last-write-wins (review T3 F5 / CTO);
 *   - back up the prior preset_map (returned + logged), read back + verify, and
 *     restore the backup if the read-back mismatches.
 *
 * `db` is injected. Writes exactly one table: `templates` (by PK, guarded).
 */
import { createHash } from 'node:crypto';
import { resolvePresetMapWith } from './presetResolution.js';

// Canonical form: recursively sort object keys so the hash is stable across a
// Postgres jsonb round-trip (jsonb does NOT preserve insertion order). Arrays
// keep order (semantically significant).
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
    return o;
  }
  return v;
}
const md5 = (v) => createHash('md5').update(JSON.stringify(canonical(v ?? null))).digest('hex');

// A synthetic project id with no option_presets rows — models "a fresh run"
// (new project) for the shadow analysis and the resolution proof.
export const FRESH_RUN_PROBE_PROJECT = '00000000-0000-0000-0000-000000000000';

// CTO 4b: the fresh-run proof resolves against the sentinel project, which MUST
// have zero option_presets rows — a stray row would let the proof falsely pass
// (the silent-shadow class this unit prevents). Assert it, loudly.
async function assertFreshProbeClean(db) {
  const { data } = await db.from('option_presets').select('id').eq('project_id', FRESH_RUN_PROBE_PROJECT);
  if (data && data.length) {
    throw new Error(`fresh-run proof aborted: FRESH_RUN_PROBE_PROJECT (${FRESH_RUN_PROBE_PROJECT}) has real option_presets rows — cannot trust the proof`);
  }
}

/**
 * Rows in option_presets that resolvePresetMap would consult for
 * (submodule, option). Mirrors the resolver: it fetches by the template's WHOLE
 * preset_name set and indexes by submodule::option, so a row under ANY of those
 * preset_names can shadow. Split by layer:
 *   { global, sourceProject, otherProjects: [] } — each entry { row_id, value, ... }.
 */
export async function findShadows({ submoduleId, optionName, presetNames, projectId, db }) {
  const names = (presetNames || []).filter(Boolean);
  if (!names.length) return { global: null, sourceProject: null, otherProjects: [] };
  const { data, error } = await db
    .from('option_presets')
    .select('id, preset_value, project_id, preset_name')
    .eq('submodule_id', submoduleId)
    .eq('option_name', optionName)
    .in('preset_name', names);
  if (error) throw new Error(`option_presets read failed: ${error.message}`);
  let global = null; let sourceProject = null; const otherProjects = [];
  for (const row of data || []) {
    if (row.project_id == null) global = { row_id: row.id, value: row.preset_value, preset_name: row.preset_name };
    else if (row.project_id === projectId) sourceProject = { row_id: row.id, value: row.preset_value };
    else otherProjects.push({ row_id: row.id, value: row.preset_value, project_id: row.project_id });
  }
  return { global, sourceProject, otherProjects };
}

/**
 * @param {object}  args.experiment    accepted experiment row (submodule_id + overrides)
 * @param {object}  args.template      target template row (id, name, preset_map)
 * @param {string?} args.projectId     the run's project id (same-project shadow warning)
 * @param {string?} args.priorUpdatedAt template.updated_at read by the caller (optimistic lock)
 * @param {boolean} args.dryRun        analyse + plan + prove, write NOTHING
 * @param {object}  args.db            injected supabase client
 */
export async function promoteExperimentSettings({ experiment, template, projectId, priorUpdatedAt = null, dryRun = false, db }) {
  const submoduleId = experiment.submodule_id;
  const overrides = experiment.overrides || {};
  const optionNames = Object.keys(overrides);
  const presetMap = template.preset_map || {};
  const entry = presetMap[submoduleId] || {};
  const targetLayer = 'template.preset_map.fallback_values';
  const templatePresetNames = [...new Set(Object.values(presetMap).map(e => e?.preset_name).filter(Boolean))];

  if (!optionNames.length) {
    return { promoted: 0, target_layer: targetLayer, template_id: template.id, submodule_id: submoduleId, plan: [], message: 'experiment has no overrides to promote' };
  }

  // ---- shadow analysis (refuse on GLOBAL, warn on any project-scoped) ----
  const conflicts = []; const warnings = []; const plan = [];
  for (const option of optionNames) {
    const newValue = overrides[option];
    const oldValue = (entry.fallback_values || {})[option] ?? null;
    plan.push({ submodule_id: submoduleId, option, old: oldValue, new: newValue, changes: md5(oldValue) !== md5(newValue) });
    const { global, sourceProject, otherProjects } = await findShadows({ submoduleId, optionName: option, presetNames: templatePresetNames, projectId, db });
    if (global && md5(global.value) !== md5(newValue)) {
      conflicts.push({ option, layer: 'global', preset_name: global.preset_name, row_id: global.row_id, would_resolve_to: global.value, blocked_new: newValue });
    }
    if (sourceProject && md5(sourceProject.value) !== md5(newValue)) {
      warnings.push({ option, layer: 'project', scope: 'source_run_project', row_id: sourceProject.row_id, note: "shadows a re-run into this run's project; fresh runs unaffected" });
    }
    for (const op of otherProjects) {
      if (md5(op.value) !== md5(newValue)) {
        warnings.push({ option, layer: 'project', scope: 'other_project', project_id: op.project_id, row_id: op.row_id, note: 'shadows a re-run into that project; fresh runs unaffected' });
      }
    }
  }

  const nextEntry = { ...entry, fallback_values: { ...(entry.fallback_values || {}) } };
  for (const p of plan) nextEntry.fallback_values[p.option] = p.new;
  const nextPresetMap = { ...presetMap, [submoduleId]: nextEntry };

  const preview = {
    target_layer: targetLayer, template_id: template.id, template_name: template.name ?? null,
    submodule_id: submoduleId, preset_names: templatePresetNames, plan, conflicts, warnings,
  };

  if (conflicts.length) {
    return { ...preview, promoted: 0, refused: true, reason: 'a higher (global) option_presets layer would shadow this write — resolve/delete the named row(s), or promote to the global layer explicitly' };
  }

  // ---- PROVE BEFORE WRITE (no mutation): resolve the candidate for a fresh run ----
  await assertFreshProbeClean(db);
  const resolvedPre = await resolvePresetMapWith(nextPresetMap, FRESH_RUN_PROBE_PROJECT, db);
  const resolvedProof = plan.map(p => {
    const got = resolvedPre?.[submoduleId]?.[p.option];
    return { option: p.option, fresh_run_resolves_to: got, matches_new: md5(got) === md5(p.new) };
  });
  const proofFail = resolvedProof.filter(r => !r.matches_new);
  if (proofFail.length) {
    // A shadow the conflict scan didn't name (belt-and-suspenders). Refuse — NO write.
    return { ...preview, promoted: 0, refused: true, reason: 'a higher preset layer would shadow this write (caught by fresh-run resolution) — promote blocked', resolved_proof: resolvedProof };
  }
  if (dryRun) {
    return { ...preview, promoted: 0, dry_run: true, resolved_proof: resolvedProof };
  }

  // ---- backup, then write (optimistic-concurrency guarded, PK target) ----
  const backup = { template_id: template.id, preset_map_before: JSON.parse(JSON.stringify(presetMap)) };
  console.warn(`[promote] template ${template.id}: backing up preset_map before write (submodule ${submoduleId}, options ${plan.map(p => p.option).join(',')})`);
  let upd = db.from('templates').update({ preset_map: nextPresetMap, updated_at: new Date().toISOString() }).eq('id', template.id);
  if (priorUpdatedAt) upd = upd.eq('updated_at', priorUpdatedAt); // optimistic lock
  const { data: updatedRows, error: upErr } = await upd.select('id');
  if (upErr) throw new Error(`template promote write failed: ${upErr.message}`);
  if (priorUpdatedAt && (!updatedRows || updatedRows.length === 0)) {
    return { ...preview, promoted: 0, refused: true, concurrency_conflict: true, reason: 'template changed since it was read (concurrent edit) — reload and retry' };
  }

  // ---- read back + md5-verify; RESTORE backup on mismatch ----
  const { data: readBack, error: rbErr } = await db
    .from('templates').select('id, preset_map').eq('id', template.id).maybeSingle();
  if (rbErr) throw new Error(`template read-back failed: ${rbErr.message}`);
  const verification = plan.map(p => {
    const got = readBack?.preset_map?.[submoduleId]?.fallback_values?.[p.option];
    return { option: p.option, ok: md5(got) === md5(p.new), md5_expected: md5(p.new), md5_got: md5(got) };
  });
  const badVerify = verification.filter(v => !v.ok);
  if (badVerify.length) {
    await db.from('templates').update({ preset_map: backup.preset_map_before, updated_at: new Date().toISOString() }).eq('id', template.id);
    throw new Error(`promote read-back mismatch (restored backup): ${JSON.stringify(badVerify)}`);
  }

  return { ...preview, promoted: plan.length, refused: false, backup, verification, resolved_proof: resolvedProof };
}
