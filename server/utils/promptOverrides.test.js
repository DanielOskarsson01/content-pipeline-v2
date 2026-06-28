import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPromptOverride } from './promptOverrides.js';

// applyPromptOverride resolves a card's prompt_overrides (data-model commitment #5)
// against a base prompt. First implementation of prompt_overrides resolution
// (Verification amendment 1e: the field was reserved in sub-plan 1 but never merged).
// Used by the one-shot harness now; the production merge (content-writer-v2 slice)
// reuses this same helper so a prompt validated in the harness produces the same
// final prompt in production.

const BASE = [
  'You are a writer.',
  '<!-- section: tone -->',
  'Neutral, factual tone.',
  '<!-- /section: tone -->',
  'Cite sources.',
  '<!-- section: meta_requirements -->',
  'meta_title up to 70 chars.',
  '<!-- /section: meta_requirements -->',
  'End.',
].join('\n');

// --- no override → passthrough ---

test('no override → base prompt unchanged, mode none', () => {
  for (const ov of [undefined, null, {}]) {
    const r = applyPromptOverride(BASE, ov);
    assert.equal(r.prompt, BASE);
    assert.equal(r.mode, 'none');
    assert.deepEqual(r.appliedSections, []);
    assert.deepEqual(r.missingSections, []);
  }
});

// --- replace ---

test('replace → value wholly replaces base', () => {
  const r = applyPromptOverride(BASE, { mode: 'replace', value: 'BRAND NEW PROMPT' });
  assert.equal(r.prompt, 'BRAND NEW PROMPT');
  assert.equal(r.mode, 'replace');
});

test('replace with missing value → passthrough + warning (never silently empties the prompt)', () => {
  const r = applyPromptOverride(BASE, { mode: 'replace' });
  assert.equal(r.prompt, BASE);
  assert.ok(r.warnings.length > 0);
});

// --- append ---

test('append → value appended after base', () => {
  const r = applyPromptOverride(BASE, { mode: 'append', value: 'EXTRA: every claim needs [source: <url>].' });
  assert.ok(r.prompt.startsWith(BASE));
  assert.ok(r.prompt.includes('EXTRA: every claim needs [source: <url>].'));
  assert.equal(r.mode, 'append');
});

// --- merge_sections: the surgical mode v2 cards are expected to use ---

test('merge_sections replaces a named section, preserves markers, reports applied', () => {
  const r = applyPromptOverride(BASE, { mode: 'merge_sections', sections: { tone: 'STRICT: citation-required, no hype.' } });
  assert.equal(r.mode, 'merge_sections');
  assert.deepEqual(r.appliedSections, ['tone']);
  assert.deepEqual(r.missingSections, []);
  assert.ok(r.prompt.includes('STRICT: citation-required, no hype.'));
  assert.ok(!r.prompt.includes('Neutral, factual tone.'));
  // markers preserved so the section can be merged again
  assert.ok(r.prompt.includes('<!-- section: tone -->'));
  assert.ok(r.prompt.includes('<!-- /section: tone -->'));
  // other section untouched
  assert.ok(r.prompt.includes('meta_title up to 70 chars.'));
});

test('merge_sections handles multiple sections', () => {
  const r = applyPromptOverride(BASE, { mode: 'merge_sections', sections: { tone: 'T2', meta_requirements: 'M2' } });
  assert.deepEqual(r.appliedSections.sort(), ['meta_requirements', 'tone']);
  assert.ok(r.prompt.includes('T2') && r.prompt.includes('M2'));
});

test('MARKER CHECK: merge_sections on a base with NO markers reports every section as missing, prompt unchanged', () => {
  const noMarkers = 'You are a writer. Cite sources. End.';
  const r = applyPromptOverride(noMarkers, { mode: 'merge_sections', sections: { tone: 'X', meta_requirements: 'Y' } });
  assert.deepEqual(r.appliedSections, []);
  assert.deepEqual(r.missingSections.sort(), ['meta_requirements', 'tone']);
  assert.equal(r.prompt, noMarkers); // nothing applied → unchanged
  assert.ok(r.warnings.some((w) => /marker/i.test(w)));
});

test('merge_sections partial: present applied, missing reported', () => {
  const r = applyPromptOverride(BASE, { mode: 'merge_sections', sections: { tone: 'T2', nonexistent: 'Z' } });
  assert.deepEqual(r.appliedSections, ['tone']);
  assert.deepEqual(r.missingSections, ['nonexistent']);
});

test('merge_sections tolerates whitespace variation in markers', () => {
  const base = 'a\n<!--section:tone-->\nold\n<!--/section:tone-->\nb';
  const r = applyPromptOverride(base, { mode: 'merge_sections', sections: { tone: 'NEW' } });
  assert.deepEqual(r.appliedSections, ['tone']);
  assert.ok(r.prompt.includes('NEW') && !r.prompt.includes('old'));
});

// --- defensive ---

test('unknown mode → passthrough + warning', () => {
  const r = applyPromptOverride(BASE, { mode: 'frobnicate', value: 'x' });
  assert.equal(r.prompt, BASE);
  assert.ok(r.warnings.length > 0);
});

test('non-string base → empty-string-safe', () => {
  const r = applyPromptOverride(undefined, { mode: 'append', value: 'x' });
  assert.equal(typeof r.prompt, 'string');
});
