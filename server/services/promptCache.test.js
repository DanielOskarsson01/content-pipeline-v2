import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCachedUserContent } from './promptCache.js';
import { parseAnthropicSSE } from './aiStream.js';

// ── buildCachedUserContent: backwards-compatible no-prefix path ──

test('no cachePrefix → returns the plain prompt string unchanged (pre-#21 shape)', () => {
  const out = buildCachedUserContent('hello prompt', undefined);
  assert.equal(out, 'hello prompt');
  assert.equal(typeof out, 'string');
});

test('empty-string cachePrefix → plain string (no useless cache block)', () => {
  assert.equal(buildCachedUserContent('p', ''), 'p');
});

test('non-string cachePrefix (null) → plain string', () => {
  assert.equal(buildCachedUserContent('p', null), 'p');
});

// ── buildCachedUserContent: the caching split ──

test('with cachePrefix → two-block array, cache_control on the prefix only', () => {
  const out = buildCachedUserContent('VARIABLE', 'STABLE-DOCS');
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { type: 'text', text: 'STABLE-DOCS', cache_control: { type: 'ephemeral' } });
  assert.deepEqual(out[1], { type: 'text', text: 'VARIABLE' });
  // the variable block must NOT carry cache_control (or every call writes a new entry)
  assert.equal(out[1].cache_control, undefined);
});

test('assembled text is BYTE-IDENTICAL to cachePrefix + prompt (model sees the same input)', () => {
  const prefix = 'REFERENCE DOCS\n\n=== vocab ===\nslug-a\nslug-b\n\n';
  const prompt = 'Analyze entity: Acme Corp.';
  const out = buildCachedUserContent(prompt, prefix);
  const assembled = out.map((b) => b.text).join(''); // API concatenates blocks with NO separator
  assert.equal(assembled, prefix + prompt);
});

test('non-string prompt is coerced safely in the split path', () => {
  const out = buildCachedUserContent(undefined, 'PFX');
  assert.equal(out[1].text, '');
});

// ── parseAnthropicSSE: prompt-cache usage capture (#21 observability) ──

async function* chunks(arr) { for (const c of arr) yield c; }

test('captures cache_creation_input_tokens / cache_read_input_tokens from message_start', async () => {
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":40,"output_tokens":0,"cache_creation_input_tokens":20000,"cache_read_input_tokens":0}}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
  ];
  const r = await parseAnthropicSSE(chunks(sse));
  assert.equal(r.text, 'ok');
  assert.equal(r.tokens_in, 40);          // uncached remainder
  assert.equal(r.cache_creation_input_tokens, 20000); // cache write (first call)
  assert.equal(r.cache_read_input_tokens, 0);
});

test('cache read on a warm call is captured', async () => {
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":40,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":20000}}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
  ];
  const r = await parseAnthropicSSE(chunks(sse));
  assert.equal(r.cache_read_input_tokens, 20000);
  assert.equal(r.cache_creation_input_tokens, 0);
});

test('absent cache fields default to 0 (backwards-compatible with non-cached responses)', async () => {
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":1200,"output_tokens":0}}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n',
  ];
  const r = await parseAnthropicSSE(chunks(sse));
  assert.equal(r.cache_creation_input_tokens, 0);
  assert.equal(r.cache_read_input_tokens, 0);
  assert.equal(r.tokens_in, 1200);
  assert.equal(r.tokens_out, 10);
});

// ── structural guard: stageWorker actually wires the helper into the request ──

test('stageWorker imports buildCachedUserContent and uses it for the user content', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../workers/stageWorker.js'), 'utf8');
  assert.match(src, /import\s*\{\s*buildCachedUserContent\s*\}\s*from\s*['"]\.\.\/services\/promptCache\.js['"]/,
    'stageWorker must import buildCachedUserContent');
  assert.match(src, /content:\s*buildCachedUserContent\(prompt,\s*cache_prefix\)/,
    'stageWorker must build the user content via buildCachedUserContent(prompt, cache_prefix)');
});
