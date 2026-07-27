/**
 * One-shot submodule harness — CLI wrapper.
 *
 * The implementation lives in server/services/submoduleHarness.js (workbench
 * Unit 2 relocated it server-side so the workbench and this CLI share ONE
 * harness — param gating via aiModelParams.js, _aiCalls/applyAiCallMeta cost
 * capture, optional §7b/§7c hydration). This file keeps the historical CLI
 * entry point and import path alive.
 *
 * Usage (CLI):
 *   node --env-file=.env scripts/run-submodule-once.js spec.json [--out result.json]
 *
 * spec.json:
 *   {
 *     "submodule_id": "content-writer",
 *     "entity": { "name": "Acme", "items": [ { "text_content": "...", "analysis_json": {...} } ] },
 *     "options": { "ai_model": "haiku", "temperature": 0.4 },          // merged over manifest defaults
 *     "overrides": { "ai_model": "sonnet" },                            // merged over resolved options
 *     "prompt_override": { "mode": "merge_sections", "sections": { "tone": "..." } },  // optional
 *     "reference_docs": { "format_spec.md": "<content>" }               // optional; resolves {doc:...}
 *   }
 *
 * CLI specs are expected pre-hydrated (no db is injected here); programmatic
 * callers can pass { hydrate: true, run_id, exclude_run_id } + a db client to
 * runSubmoduleOnce(spec, { db }) for §7b/§7c frozen-input hydration.
 *
 * Programmatic: `import { runSubmoduleOnce } from './scripts/run-submodule-once.js'`.
 */

import { pathToFileURL } from 'url';
import { readFileSync, writeFileSync } from 'fs';
import { runSubmoduleOnce } from '../server/services/submoduleHarness.js';

export { runSubmoduleOnce };

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const specPath = args.find((a) => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  if (!specPath) {
    console.error('usage: node --env-file=.env scripts/run-submodule-once.js <spec.json> [--out result.json]');
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  try {
    const out = await runSubmoduleOnce(spec);
    // result is the UNWRAPPED per-entity { items, meta } (stageWorker parity).
    const items = out.result?.items || [];
    console.error('\n──────── HARNESS RESULT ────────');
    console.error(`submodule: ${out.submodule_id} v${out.version}`);
    if (out.promptInfo) {
      console.error(`prompt_override: mode=${out.promptInfo.mode} applied=[${out.promptInfo.appliedSections}] missing=[${out.promptInfo.missingSections}]`);
      out.promptInfo.warnings.forEach((w) => console.error(`  ⚠ ${w}`));
    }
    console.error(`summary: ${JSON.stringify(out.summary || {})}`);
    if (out.result?.meta?.ai_usage) {
      const u = out.result.meta.ai_usage;
      console.error(`ai_usage: ${u.tokens_in_total} in, ${u.tokens_out_total} out, stops: [${u.calls.map(c => c.stop_reason).join(', ')}]`);
    }
    console.error(`result items: ${Array.isArray(items) ? items.length : 'n/a'}`);
    if (outPath) { writeFileSync(outPath, JSON.stringify(out, null, 2)); console.error(`→ wrote ${outPath}`); }
    else { console.log(JSON.stringify(out, null, 2)); }
  } catch (err) {
    console.error(`\n❌ harness failed: ${err.message}`);
    process.exit(1);
  }
}
