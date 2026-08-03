/**
 * A3 metrics — hermetic. Text-producing arms populate the text block;
 * checkers stay null-heavy (null = not applicable, never zero); AI usage
 * maps to token/cost fields.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeExperimentMetrics } from '../lib/experimentMetrics.js';

const ARTICLE = [
  '# Hacksaw Gaming',
  '',
  'Intro paragraph with some words and a citation [#1] and another [2].',
  '',
  '## Products [Suggested tag]',
  Array(60).fill('word').join(' ') + ' [#3]',
  '',
  '## FAQ FAQ',
  'Too thin.',
  '',
  '## History',
  Array(55).fill('word').join(' ') + ' broken ref [#7]',
].join('\n');

test('text-producing arm: full text block populated', () => {
  const m = computeExperimentMetrics({
    output_data: {
      items: [{
        entity_name: 'X',
        content_markdown: ARTICLE,
        source_citations: ['a', 'b', 'c'], // 3 sources → [#7] is broken
      }],
    },
    ai_usage: {
      calls: [
        { model: 'claude-sonnet-5', tokens_in: 1000, tokens_out: 500, cache_read_tokens: 100, cache_write_tokens: 50, stop_reason: 'end_turn' },
      ],
      tokens_in_total: 1000, tokens_out_total: 500, cache_read_tokens_total: 100, cache_write_tokens_total: 50,
    },
    duration_ms: 1234,
  });
  assert.equal(m.has_h1, true);
  assert.equal(m.h2_sections, 3);
  assert.equal(m.thin_sections, 1, 'FAQ section is thin');
  assert.equal(m.marker_leak_headings, 1, '[Suggested tag] leak counted');
  assert.equal(m.dup_token_headings, 1, 'FAQ FAQ counted');
  assert.equal(m.distinct_citations, 4, '[#1] [2] [#3] [#7]');
  assert.equal(m.max_citation_n, 7);
  assert.equal(m.broken_refs, 1, 'only [#7] exceeds 3 sources');
  assert.ok(m.words > 120);
  assert.equal(m.tokens_in, 1000);
  assert.equal(m.tokens_out, 500);
  assert.equal(m.cache_read_tokens, 100);
  assert.equal(m.cache_write_tokens, 50);
  assert.equal(m.stop_reason, 'end_turn');
  assert.equal(m.duration_ms, 1234);
  assert.ok(m.cost_usd > 0);
});

test('checker arm: text metrics null (not zero), tokens null without ai_usage', () => {
  const m = computeExperimentMetrics({
    output_data: { items: [{ entity_name: 'X', qa_pass: true, structural_score: 0.83 }] },
    ai_usage: null,
    duration_ms: 5,
  });
  for (const k of ['words', 'h2_sections', 'thin_sections', 'has_h1', 'marker_leak_headings',
    'dup_token_headings', 'distinct_citations', 'max_citation_n', 'broken_refs',
    'tokens_in', 'tokens_out', 'cache_read_tokens', 'cache_write_tokens', 'stop_reason', 'cost_usd']) {
    assert.equal(m[k], null, `${k} must be null, got ${m[k]}`);
  }
  assert.equal(m.duration_ms, 5);
});

test('step-8 bundle: final_markdown counts as the text source; no source_citations → broken_refs null', () => {
  const m = computeExperimentMetrics({
    output_data: { items: [{ entity_name: 'X', final_markdown: '## One\n' + Array(60).fill('w').join(' ') + ' [#2]' }] },
    ai_usage: null,
    duration_ms: 10,
  });
  assert.equal(m.h2_sections, 1);
  assert.equal(m.distinct_citations, 1);
  assert.equal(m.broken_refs, null, 'no source_citations list on the item');
  assert.equal(m.has_h1, false);
});

test('truncated arm: max_tokens stop_reason surfaces', () => {
  const m = computeExperimentMetrics({
    output_data: { items: [] },
    ai_usage: { calls: [{ model: 'claude-sonnet-5', tokens_in: 10, tokens_out: 10, stop_reason: 'max_tokens' }], tokens_in_total: 10, tokens_out_total: 10 },
    duration_ms: 1,
  });
  assert.equal(m.stop_reason, 'max_tokens');
});
