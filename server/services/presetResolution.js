/**
 * Preset resolution — the single source of truth for how a run resolves an
 * option value, extracted so it can run with an INJECTED db (no top-level db.js
 * import, hence hermetically testable and reusable by promote-settings).
 *
 * Resolution order (highest wins):
 *   1. Project-scoped preset  (option_presets WHERE project_id = X)
 *   2. Global preset          (option_presets WHERE project_id IS NULL)
 *   3. Template fallback_values (preset_map)
 *   4. Manifest default        (when an option isn't named above — applied later)
 *
 * templates.js re-exports this as resolvePresetMap (default db) so existing
 * callers are unchanged.
 */
export async function resolvePresetMapWith(presetMap, projectId, db) {
  const submoduleIds = Object.keys(presetMap);
  const presetNames = [...new Set(submoduleIds.map(id => presetMap[id].preset_name).filter(Boolean))];

  let presetRows = [];
  if (presetNames.length > 0 && submoduleIds.length > 0) {
    const { data } = await db
      .from('option_presets')
      .select('submodule_id, option_name, preset_name, preset_value, project_id')
      .in('submodule_id', submoduleIds)
      .in('preset_name', presetNames);
    presetRows = data || [];
  }

  // Index: "submoduleId::optionName" → { project, global }
  const presetIndex = {};
  for (const row of presetRows) {
    const key = `${row.submodule_id}::${row.option_name}`;
    if (!presetIndex[key]) presetIndex[key] = {};
    if (row.project_id === projectId) presetIndex[key].project = row.preset_value;
    else if (!row.project_id) presetIndex[key].global = row.preset_value;
  }

  const resolved = {};
  for (const [subId, config] of Object.entries(presetMap)) {
    resolved[subId] = {};
    for (const [optName, fallbackVal] of Object.entries(config.fallback_values || {})) {
      const key = `${subId}::${optName}`;
      const idx = presetIndex[key] || {};
      resolved[subId][optName] = idx.project ?? idx.global ?? fallbackVal;
    }
  }
  return resolved;
}
