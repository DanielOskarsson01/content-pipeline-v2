/**
 * Streaming-response helpers for ai.complete.
 *
 * Background: the non-streamed Anthropic fetch (await res.text() on the whole
 * body) hit undici's hidden ~300s socket headers/body timeout on long
 * generations, throwing the bare "fetch failed" TypeError. That has no HTTP
 * status, so the ai.complete retry loop classified it as transient and retried
 * 3x — landing at the deterministic ~908s wall and producing no content for
 * large entities (e.g. Wazdan, 2026-06-13). Streaming keeps the socket active
 * (bytes flow continuously), so the request lives until the AbortController
 * limit instead of undici's silent default.
 *
 * parseAnthropicSSE turns the Anthropic Messages streaming (SSE) response into
 * the SAME result shape the non-streamed path returned, so callers are
 * unchanged: { text, tokens_in, tokens_out, stop_reason }. It additionally
 * surfaces prompt-cache usage (cache_creation_input_tokens,
 * cache_read_input_tokens) from the message_start usage block for BACKLOG #21
 * observability — additive fields; existing callers ignore them.
 *
 * Pure + dependency-free (no undici import) — uses only Web streams / TextDecoder
 * available in Node 18+. Accepts an async iterable yielding string OR Uint8Array
 * chunks, so it works against a real `res.body` and against test fixtures.
 */

/**
 * @param {AsyncIterable<string|Uint8Array>} stream  the response body
 * @returns {Promise<{text:string,tokens_in:number,tokens_out:number,stop_reason:string,cache_creation_input_tokens:number,cache_read_input_tokens:number}>}
 * @throws {Error} if the stream emits an Anthropic `error` event
 */
export async function parseAnthropicSSE(stream) {
  // A 200 streaming response always carries a body; guard the unreachable case
  // with a clear error rather than a misleading TypeError on the for-await.
  if (stream == null || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new Error('Anthropic streaming response had no readable body');
  }

  let text = '';
  let tokens_in = 0;
  let tokens_out = 0;
  let stop_reason = 'unknown';
  // Prompt-cache usage (BACKLOG #21) — present in message_start usage when a
  // cache_control breakpoint is sent; 0 otherwise. tokens_in is the UNcached
  // input remainder, so total prompt = tokens_in + cache_creation + cache_read.
  let cache_creation_input_tokens = 0;
  let cache_read_input_tokens = 0;

  const decoder = new TextDecoder();
  let buffer = '';

  const handleEvent = (evt) => {
    switch (evt.type) {
      case 'message_start':
        if (evt.message?.usage?.input_tokens != null) tokens_in = evt.message.usage.input_tokens;
        if (evt.message?.usage?.output_tokens != null) tokens_out = evt.message.usage.output_tokens;
        if (evt.message?.usage?.cache_creation_input_tokens != null) cache_creation_input_tokens = evt.message.usage.cache_creation_input_tokens;
        if (evt.message?.usage?.cache_read_input_tokens != null) cache_read_input_tokens = evt.message.usage.cache_read_input_tokens;
        break;
      case 'content_block_delta':
        if (typeof evt.delta?.text === 'string') text += evt.delta.text;
        break;
      case 'message_delta':
        if (evt.usage?.output_tokens != null) tokens_out = evt.usage.output_tokens;
        if (evt.delta?.stop_reason) stop_reason = evt.delta.stop_reason;
        break;
      case 'error': {
        const msg = evt.error?.message || JSON.stringify(evt.error || evt);
        const err = new Error(`Anthropic stream error: ${msg}`);
        if (evt.error?.type) err.anthropicErrorType = evt.error.type;
        throw err;
      }
      default:
        break; // ping, message_stop, content_block_start/stop, etc.
    }
  };

  const consumeLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return; // SSE `event:` / comment `:` lines carry no payload we need
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let evt;
    try { evt = JSON.parse(payload); } catch { return; } // skip unparseable keep-alive fragments
    handleEvent(evt);
  };

  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      consumeLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  // Flush any trailing decoder state + final line without a newline.
  buffer += decoder.decode();
  if (buffer.length > 0) consumeLine(buffer);

  return { text, tokens_in, tokens_out, stop_reason, cache_creation_input_tokens, cache_read_input_tokens };
}
