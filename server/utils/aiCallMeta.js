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
 *   3. FAIL-CLOSED ON AN EMPTY / REFUSED COMPLETION (BACKLOG #49). Gemini via its
 *      OpenAI-compat endpoint 200s with EMPTY text on a safety refusal; the
 *      adapter flags it empty_completion:true. Set meta.status='error' so a
 *      refused blank never publishes as success — same supersede-preserving
 *      fail-closed as (1). See the guard below for the full rationale.
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
      // Gemini 2.5 (BACKLOG #49): total_tokens includes internal thinking tokens
      // that tokens_out (completion) excludes but that ARE billed at the output
      // rate. Carry it so costOfUsage prices the true output; 0 for providers that
      // don't report a total.
      tokens_total: c.tokens_total || 0,
      // BACKLOG #54: OpenRouter reports the REAL billed USD for the call in
      // usage.cost — carried here (null for providers that don't) so a true billed
      // number is queryable alongside the registry-priced estimate costOfUsage
      // computes. A real number beats an estimate for cross-model cost comparison.
      provider_cost: c.provider_cost ?? null,
      stop_reason: c.stop_reason ?? null,
    })),
    tokens_in_total: calls.reduce((s, c) => s + (c.tokens_in || 0), 0),
    tokens_out_total: calls.reduce((s, c) => s + (c.tokens_out || 0), 0),
    tokens_total_total: calls.reduce((s, c) => s + (c.tokens_total || 0), 0),
    cache_write_tokens_total: calls.reduce((s, c) => s + (c.cache_write_tokens || 0), 0),
    cache_read_tokens_total: calls.reduce((s, c) => s + (c.cache_read_tokens || 0), 0),
    // Sum of real billed cost — only a TRUE total when EVERY call reported a cost
    // (all-openrouter run). On a mixed run (e.g. one openrouter + one anthropic call)
    // some costs are null, so a sum would be a misleading PARTIAL — return null there
    // so a consumer falls back to the full registry estimate (costOfUsage) rather than
    // comparing an incomplete billed figure. null also distinguishes "none reported".
    provider_cost_total: calls.length > 0 && calls.every(c => c.provider_cost != null)
      ? calls.reduce((s, c) => s + (c.provider_cost || 0), 0)
      : null,
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

  // 3. FAIL-CLOSED ON AN EMPTY / REFUSED COMPLETION (BACKLOG #49). Gemini via its
  //    OpenAI-compat /chat/completions endpoint returns HTTP 200 with EMPTY text
  //    on a safety refusal — gambling copy trips it, and today it publishes as a
  //    successful empty article. (openai/perplexity can also 200-empty on a
  //    content filter.) The adapter flags such a call with empty_completion:true
  //    (computed from the returned text; provider-specific in the adapter, generic
  //    here). An empty completion is never a legitimate success for these modules,
  //    so fail closed with a named reason — same override-the-module philosophy as
  //    the truncation guard. Distinct from truncation: a truncated response HAS
  //    text (cut off); a refused one has none, so the two guards never collide.
  //
  //    SCOPE (deliberate, like the truncation guard):
  //    - RUN GRANULARITY: fires if ANY call in the run is empty, overriding a
  //      module's own salvage — a multi-call module that tolerates an empty
  //      auxiliary call still fails. In practice the only tolerant path is
  //      seo-planner's perplexity keyword-research (Promise.allSettled), and (a)
  //      perplexity effectively never 200s with 0-char text, (b) a hollow plan is
  //      already failed by seo-planner's own content gate — so the over-fire is a
  //      rare, defensible fail-closed, not a silent break.
  //    - TWO SIGNALS (BACKLOG #54): an EMPTY completion (empty_completion) OR an
  //      explicit finish_reason==='content_filter'. The empty-text signal is the
  //      gemini-safety-block case; the content_filter signal catches an OpenRouter-
  //      proxied vendor (Llama/Mistral/DeepSeek/Qwen/GLM) that refuses iGaming copy
  //      with a NON-empty apology but flags the block via finish_reason. A verbose
  //      refusal that sets NEITHER (plain prose, finish_reason 'stop') still slips —
  //      a refusal-phrase classifier would be the next layer; out of scope here.
  const refused = calls.find(c => c.empty_completion || c.finish_reason === 'content_filter');
  if (refused) {
    result.meta.refused = true;
    result.meta.refused_by = `${refused.provider ?? 'unknown'}/${refused.model ?? 'unknown'}`;
    if (result.meta.status !== 'error') {
      result.meta.status = 'error';
      const fr = refused.finish_reason ? ` (finish_reason: ${refused.finish_reason})` : '';
      result.meta.error = result.meta.error
        || `LLM returned an empty/refused completion on ${result.meta.refused_by}${fr} — failing closed; a safety refusal must not publish as an empty success`;
    }
  }

  return result;
}
