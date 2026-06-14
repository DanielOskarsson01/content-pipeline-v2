/**
 * Tests for parseAnthropicSSE — the streaming-response accumulator for ai.complete.
 *
 * Run: node server/tests/aiStream.test.mjs   (from content-pipeline-v2/)
 *
 * Why this exists: the non-streamed Anthropic fetch hit undici's hidden ~300s
 * socket timeout on long generations → "fetch failed" → retried → ~908s wall →
 * Step 5 produced no content (2026-06-13, Wazdan). Streaming keeps the socket
 * warm. parseAnthropicSSE turns the SSE byte stream into the same result shape
 * the non-streamed path returned: { text, tokens_in, tokens_out, stop_reason }.
 */

import { parseAnthropicSSE } from '../services/aiStream.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  PASS: ${msg}`); pass++; }
  else { console.log(`  FAIL: ${msg}`); fail++; }
}

// Build an async iterable from an array of string chunks (simulates res.body).
async function* chunks(arr) { for (const c of arr) yield c; }
// Same, but as Uint8Array (simulates Node fetch res.body byte chunks).
async function* byteChunks(arr) { const enc = new TextEncoder(); for (const c of arr) yield enc.encode(c); }

const SSE_OK = [
  'event: message_start\n',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":1200,"output_tokens":0}}}\n\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"# Wazdan"}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" profile"}}\n\n',
  'event: message_delta\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4096}}\n\n',
  'event: message_stop\n',
  'data: {"type":"message_stop"}\n\n',
];

(async () => {
  console.log('\n=== basic accumulation ===');
  {
    const r = await parseAnthropicSSE(chunks(SSE_OK));
    assert(r.text === '# Wazdan profile', `accumulates text deltas (got ${JSON.stringify(r.text)})`);
    assert(r.tokens_in === 1200, 'captures input_tokens from message_start');
    assert(r.tokens_out === 4096, 'captures output_tokens from message_delta');
    assert(r.stop_reason === 'end_turn', 'captures stop_reason');
  }

  console.log('\n=== works on raw byte chunks (Uint8Array) ===');
  {
    const r = await parseAnthropicSSE(byteChunks(SSE_OK));
    assert(r.text === '# Wazdan profile', 'decodes Uint8Array chunks');
    assert(r.tokens_out === 4096, 'byte path captures tokens');
  }

  console.log('\n=== SSE lines split across chunk boundaries ===');
  {
    // Split a data line mid-JSON across two chunks — buffering must reassemble.
    const split = [
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","te',
      'xt":"hello"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
    ];
    const r = await parseAnthropicSSE(chunks(split));
    assert(r.text === 'hello', `reassembles a data line split across chunks (got ${JSON.stringify(r.text)})`);
    assert(r.tokens_out === 7, 'split path still captures tokens');
  }

  console.log('\n=== ignores ping / [DONE] / blank / non-data lines ===');
  {
    const noisy = [
      ': ping\n\n',
      'event: ping\n',
      'data: {"type":"ping"}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n',
      'data: [DONE]\n\n',
    ];
    const r = await parseAnthropicSSE(chunks(noisy));
    assert(r.text === 'x', 'ignores noise, keeps real deltas');
  }

  console.log('\n=== max_tokens truncation stop_reason surfaced ===');
  {
    const trunc = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":16384}}\n\n',
    ];
    const r = await parseAnthropicSSE(chunks(trunc));
    assert(r.stop_reason === 'max_tokens', 'surfaces max_tokens stop_reason so caller can warn');
  }

  console.log('\n=== stream error event throws ===');
  {
    const errStream = [
      'event: error\n',
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ];
    let threw = false;
    try { await parseAnthropicSSE(chunks(errStream)); }
    catch (e) { threw = true; assert(/overloaded|error/i.test(e.message), 'error event message surfaced'); }
    assert(threw, 'throws on Anthropic stream error event (so retry/forensics engage)');
  }

  console.log('\n=== null/empty body throws a clear error (not a raw TypeError) ===');
  {
    let threw = false;
    try { await parseAnthropicSSE(null); }
    catch (e) { threw = true; assert(/no readable body/i.test(e.message), 'null body → clear "no readable body" error'); }
    assert(threw, 'null res.body throws (so it fails clearly, not as a misleading TypeError)');
  }

  console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
