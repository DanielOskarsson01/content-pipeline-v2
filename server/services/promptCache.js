/**
 * Prompt-caching helper for ai.complete (BACKLOG #21).
 *
 * Anthropic prompt caching is a prefix match: the stable prefix must sit in its
 * own content block marked `cache_control: {type:'ephemeral'}`, and the variable
 * suffix in a separate UNmarked block. The model concatenates content blocks
 * with NO separator, so the assembled text the model sees is byte-identical to
 * `cachePrefix + prompt`. Caching changes billing only (cached prefix is re-read
 * at ~10% input cost within the 5-minute window) — it does NOT change what the
 * model sees or produces.
 *
 * Backwards-compatible: with no (or empty) cachePrefix this returns the plain
 * string `prompt`, i.e. the exact `{role:'user', content:<string>}` shape
 * ai.complete sent before #21. Existing callers that don't pass a cachePrefix
 * are unaffected.
 *
 * Threshold caveat: a prefix below the model's minimum cacheable size silently
 * won't cache — no error, `cache_creation_input_tokens:0`. Per Anthropic:
 * Sonnet 4.5 = 1024 tokens, Haiku 4.5 / Opus 4.6 = 4096 tokens. Only pass a
 * cachePrefix that is LARGE and STABLE across calls (e.g. reference docs /
 * closed-vocabulary tables) — never small or per-entity content, which would
 * pay the ~1.25x cache-write premium for nothing.
 *
 * Pipeline-agnostic: operates only on opaque strings; no content-type knowledge.
 */

/**
 * Build the `content` field for the user message, splitting a stable cache
 * prefix from the variable prompt when a prefix is supplied.
 *
 * @param {string} prompt       the variable, per-call prompt text
 * @param {string} [cachePrefix] the large, stable prefix to cache (optional)
 * @returns {string | Array<object>} the plain `prompt` string when no usable
 *   cachePrefix is given; otherwise a two-element content-block array
 *   [{cached prefix}, {variable suffix}].
 */
export function buildCachedUserContent(prompt, cachePrefix) {
  if (typeof cachePrefix !== 'string' || cachePrefix.length === 0) {
    return prompt; // unchanged single-string content — pre-#21 behaviour
  }
  return [
    { type: 'text', text: cachePrefix, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: typeof prompt === 'string' ? prompt : String(prompt ?? '') },
  ];
}
