/**
 * Resolve a card's `prompt_overrides` (V5 data-model commitment #5) against a base
 * prompt. First implementation of prompt_overrides resolution — Verification
 * amendment 1e reserved the field in sub-plan 1 but never merged it.
 *
 * Shape (from the architecture plan):
 *   { mode: 'replace'|'append'|'merge_sections', value?: string, sections?: {name: text} }
 *
 * Modes:
 *   - replace: `value` wholly replaces the base prompt.
 *   - append:  `value` is appended after the base prompt.
 *   - merge_sections: each `sections[name]` replaces the body of the matching
 *     `<!-- section: name -->...<!-- /section: name -->` block, preserving the
 *     markers so the section can be merged again.
 *
 * MARKER CHECK (Verification amendment 1e): base prompts do not carry section
 * markers yet. When merge_sections targets a section whose markers are absent,
 * that section is reported in `missingSections` with a warning (NOT silently
 * dropped). The harness surfaces this so v2-card authors know to add markers to
 * the base prompt first, or fall back to `replace`/`append`.
 *
 * Pure function (no I/O). Shared by the one-shot harness and — when wired — the
 * production prompt merge, so a prompt validated in the harness produces the same
 * final prompt in production.
 *
 * @param {string} basePrompt
 * @param {{mode?: string, value?: string, sections?: Record<string,string>}} [override]
 * @returns {{prompt: string, mode: string, appliedSections: string[], missingSections: string[], warnings: string[]}}
 */
export function applyPromptOverride(basePrompt, override) {
  const base = typeof basePrompt === 'string' ? basePrompt : '';
  const warnings = [];
  const none = { prompt: base, mode: 'none', appliedSections: [], missingSections: [], warnings };

  if (!override || typeof override !== 'object' || !override.mode) return none;

  switch (override.mode) {
    case 'replace': {
      if (typeof override.value !== 'string') {
        warnings.push("prompt_overrides mode 'replace' requires a string `value` — kept base prompt unchanged.");
        return { ...none, mode: 'replace' };
      }
      return { prompt: override.value, mode: 'replace', appliedSections: [], missingSections: [], warnings };
    }

    case 'append': {
      if (typeof override.value !== 'string') {
        warnings.push("prompt_overrides mode 'append' requires a string `value` — kept base prompt unchanged.");
        return { ...none, mode: 'append' };
      }
      const prompt = base.length ? `${base}\n\n${override.value}` : override.value;
      return { prompt, mode: 'append', appliedSections: [], missingSections: [], warnings };
    }

    case 'merge_sections': {
      const sections = (override.sections && typeof override.sections === 'object') ? override.sections : {};
      const appliedSections = [];
      const missingSections = [];
      let prompt = base;

      for (const [name, replacement] of Object.entries(sections)) {
        const re = sectionRegex(name);
        if (re.test(prompt)) {
          // reset lastIndex (test() advanced it on a global regex) before replace
          re.lastIndex = 0;
          prompt = prompt.replace(re, `<!-- section: ${name} -->\n${replacement}\n<!-- /section: ${name} -->`);
          appliedSections.push(name);
        } else {
          missingSections.push(name);
        }
      }

      if (missingSections.length > 0) {
        warnings.push(
          `merge_sections: no marker found for section(s) [${missingSections.join(', ')}] ` +
          `(expected '<!-- section: NAME -->...<!-- /section: NAME -->'). ` +
          `Add markers to the base prompt or use mode 'replace'/'append'.`,
        );
      }
      return { prompt, mode: 'merge_sections', appliedSections, missingSections, warnings };
    }

    default:
      warnings.push(`Unknown prompt_overrides mode '${override.mode}' — kept base prompt unchanged.`);
      return { ...none, mode: 'none' };
  }
}

/** Whitespace-tolerant matcher for a named section block (markers preserved on replace). */
function sectionRegex(name) {
  const n = escapeRegex(name);
  return new RegExp(`<!--\\s*section:\\s*${n}\\s*-->[\\s\\S]*?<!--\\s*\\/section:\\s*${n}\\s*-->`, 'g');
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
