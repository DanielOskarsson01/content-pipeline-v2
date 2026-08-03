/**
 * A3 — derived metrics persisted on every workbench_experiments insert, so a
 * two-arm comparison is readable from the rows alone instead of re-deriving
 * word counts and citation coverage from raw output_data by eye.
 *
 * STRICTLY derivable from THIS experiment's own output — never re-runs
 * checkers. Fields that don't apply to a submodule are null, not zero (a
 * checker has no word count; a non-AI module has no tokens). Text metrics
 * read the first output item carrying content_markdown (writer/editor arms)
 * or final_markdown (step-8 bundles).
 *
 * Thresholds/regexes are display heuristics, deliberately simple — they are
 * NOT the QA modules' rules and must never be treated as verdicts:
 *   - thin section: < 50 words under a ## heading
 *   - marker leak: a bracketed tag left in a heading (house [Type Marker]
 *     H2s must be stripped before delivery)
 *   - dup tokens: a consecutively repeated word in a heading ("FAQ FAQ")
 *   - citations: inline [n] / [#n] markers; broken_refs = distinct markers
 *     beyond the item's own source_citations list (null when the item
 *     carries no such list)
 */
import { costOfUsage } from './aiCost.js';

const CITATION_RE = /\[#?(\d{1,3})\]/g;

export function computeExperimentMetrics(row) {
  const items = row?.output_data?.items || [];
  const textItem = items.find(i =>
    (typeof i?.content_markdown === 'string' && i.content_markdown.length > 0)
    || (typeof i?.final_markdown === 'string' && i.final_markdown.length > 0));
  const text = textItem ? (textItem.content_markdown || textItem.final_markdown) : null;

  let words = null, h2Sections = null, thinSections = null, hasH1 = null;
  let markerLeakHeadings = null, dupTokenHeadings = null;
  let distinctCitations = null, maxCitationN = null, brokenRefs = null;

  if (text != null) {
    words = text.split(/\s+/).filter(Boolean).length;
    hasH1 = /^#\s/m.test(text);

    const headings = [...text.matchAll(/^(#{2,6})\s+(.+)$/gm)].map(m => m[2]);
    h2Sections = [...text.matchAll(/^##\s/gm)].length;
    markerLeakHeadings = headings.filter(h => /\[[^\]\n]+\]/.test(h)).length;
    dupTokenHeadings = headings.filter(h => /\b(\w+)\s+\1\b/i.test(h)).length;

    const sections = text.split(/^##\s/m).slice(1);
    thinSections = sections.filter(s => s.split(/\s+/).filter(Boolean).length < 50).length;

    const ns = [...text.matchAll(CITATION_RE)].map(m => Number(m[1]));
    const distinct = new Set(ns);
    distinctCitations = distinct.size;
    maxCitationN = ns.length > 0 ? Math.max(...ns) : null;
    const sources = Array.isArray(textItem.source_citations) ? textItem.source_citations.length : null;
    brokenRefs = sources != null ? [...distinct].filter(n => n > sources).length : null;
  }

  const usage = row?.ai_usage;
  const calls = usage?.calls || [];
  const lastStop = [...calls].reverse().find(c => c.stop_reason != null)?.stop_reason ?? null;

  return {
    words,
    h2_sections: h2Sections,
    thin_sections: thinSections,
    has_h1: hasH1,
    marker_leak_headings: markerLeakHeadings,
    dup_token_headings: dupTokenHeadings,
    distinct_citations: distinctCitations,
    max_citation_n: maxCitationN,
    broken_refs: brokenRefs,
    tokens_in: usage ? (usage.tokens_in_total ?? null) : null,
    tokens_out: usage ? (usage.tokens_out_total ?? null) : null,
    cache_read_tokens: usage ? (usage.cache_read_tokens_total ?? null) : null,
    cache_write_tokens: usage ? (usage.cache_write_tokens_total ?? null) : null,
    stop_reason: lastStop,
    duration_ms: row?.duration_ms ?? null,
    cost_usd: usage ? Math.round(costOfUsage(usage) * 1e4) / 1e4 : null,
  };
}
