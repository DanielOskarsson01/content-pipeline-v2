/**
 * Fold per-entity AI-call telemetry into a module result's meta, and fail-closed
 * on truncation.
 *
 * Every successful tools.ai.complete() pushes { provider, model, tokens_in,
 * tokens_out, stop_reason } into tools._aiCalls (see buildTools in stageWorker.js).
 * After a module's execute() returns, the worker calls this to:
 *
 *   1. FAIL-CLOSED ON TRUNCATION. If any call stopped on 'max_tokens', the model's
 *      response was amputated (streamed text cut off mid-output). Set
 *      meta.status='error' — unless the module already flagged an error — so
 *      deriveEntityRunStatus marks the entity 'failed' AND the per-entity supersede
 *      gate (isFailedRun, server/lib/applyDataOperation.js) takes the
 *      preserve-on-failure branch. That keeps the prior round's COMPLETE content in
 *      the pool instead of letting a truncated retry evict it. A truncated round-2
 *      must never supersede a complete round-1.
 *
 *   2. OBSERVABILITY. Persist token totals + per-call stop reasons into
 *      meta.ai_usage so cost-per-entity and truncation are queryable per run — it
 *      rides in the existing output_data JSONB, no schema migration.
 *
 * Mutates and returns `result`. No-op when result isn't a plain object or no AI
 * calls were made (non-LLM modules keep their meta untouched).
 *
 * SCOPE NOTES (deliberate):
 *   - Fails closed on max_tokens for ANY module, overriding a module's own
 *     salvage of a truncated response (e.g. content-analyzer's JSON repair). An
 *     amputated output is incomplete regardless of who parses it. In practice
 *     only content-writer truncates; others emit <2k output tokens.
 *   - Truncation detection is Anthropic-only: the OpenAI/Perplexity branches in
 *     stageWorker don't surface a stop_reason, so their finish_reason:'length'
 *     is unmapped and won't trip this guard. Extend those branches if/when a
 *     non-Anthropic generation path needs the same protection.
 *
 * @param {{items?:any[], meta?:object}} result  per-entity module result
 * @param {Array<{provider?:string, model?:string, tokens_in?:number, tokens_out?:number, cache_write_tokens?:number, cache_read_tokens?:number, stop_reason?:string}>} aiCalls
 * @returns {object} the same `result`, mutated
 */
export function applyAiCallMeta(result, aiCalls) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const calls = Array.isArray(aiCalls) ? aiCalls : [];
  if (calls.length === 0) return result;

  result.meta = result.meta || {};

  result.meta.ai_usage = {
    calls: calls.map(c => ({
      provider: c.provider ?? null,
      model: c.model ?? null,
      tokens_in: c.tokens_in || 0,
      tokens_out: c.tokens_out || 0,
      // For a CACHED call tokens_in is only the UNCACHED remainder — true input
      // volume = tokens_in + cache_write + cache_read. Carry both so cost math
      // doesn't silently undercount cached modules (content-analyzer today,
      // content-writer once it adopts prompt caching).
      cache_write_tokens: c.cache_write_tokens || 0,
      cache_read_tokens: c.cache_read_tokens || 0,
      stop_reason: c.stop_reason ?? null,
    })),
    tokens_in_total: calls.reduce((s, c) => s + (c.tokens_in || 0), 0),
    tokens_out_total: calls.reduce((s, c) => s + (c.tokens_out || 0), 0),
    cache_write_tokens_total: calls.reduce((s, c) => s + (c.cache_write_tokens || 0), 0),
    cache_read_tokens_total: calls.reduce((s, c) => s + (c.cache_read_tokens || 0), 0),
  };

  const truncated = calls.find(c => c.stop_reason === 'max_tokens');
  if (truncated) {
    result.meta.truncated = true;
    result.meta.truncated_by = `${truncated.provider ?? 'anthropic'}/${truncated.model ?? 'unknown'}`;
    if (result.meta.status !== 'error') {
      result.meta.status = 'error';
      result.meta.error = result.meta.error
        || `LLM output truncated (hit max_tokens) on ${result.meta.truncated_by} — failing closed to preserve prior round's content`;
    }
  }

  return result;
}
