/**
 * Workbench (U6): compute the overrides payload for POST /api/workbench/experiments.
 * The endpoint itself merges defaults + historical config + overrides, so the
 * client sends ONLY the keys the user actually changed from the resolved
 * baseline — the experiment row then records true edit provenance.
 */
export function computeOverrides(
  baseline: Record<string, unknown>,
  edited: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(edited)) {
    if (JSON.stringify(value) !== JSON.stringify(baseline[key])) out[key] = value;
  }
  return out;
}
