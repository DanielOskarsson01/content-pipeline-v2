/**
 * USD cost of AI usage, from the meta.ai_usage shape applyAiCallMeta persists.
 *
 * Prices per MILLION tokens now live in ONE place — the LLM registry
 * (server/config/llmRegistry.js), keyed by API model id. This re-export keeps the
 * historical name/shape for aiCost's own consumers while killing the duplicated
 * price table (BACKLOG #49: single source of truth for models AND prices). The
 * caveats still hold and are documented at the registry: claude-sonnet-5 standard
 * price used deliberately (a cap on the higher price refuses earlier); Perplexity
 * sonar bills per-search fees invisible in token counts (floor, not bill); Gemini
 * has no native prompt caching (cache_* tokens always 0, rates inert).
 */
import { PRICES_BY_ID } from '../config/llmRegistry.js';

// Keep the historical export name/shape for aiCost's own consumers.
export const MODEL_PRICES_PER_MTOK = PRICES_BY_ID;

// Unknown model → priced as the most expensive row so a cap can only
// over-refuse, never silently under-count.
const FALLBACK = MODEL_PRICES_PER_MTOK['claude-opus-4-8'];

/**
 * @param {{calls?: Array<{model?:string, tokens_in?:number, tokens_out?:number, tokens_total?:number, cache_read_tokens?:number, cache_write_tokens?:number}>}|null} aiUsage
 * @returns {number} USD (0 for null/non-AI usage)
 */
export function costOfUsage(aiUsage) {
  let usd = 0;
  for (const c of aiUsage?.calls || []) {
    const p = MODEL_PRICES_PER_MTOK[c.model] || FALLBACK;
    // Billed output. Gemini 2.5 counts internal "thinking" tokens in total_tokens
    // but NOT in completion (tokens_out), and bills them at the output rate — so
    // for gemini the true output is tokens_total - tokens_in. Providers without a
    // tokens_total (anthropic/openai/perplexity) fall back to tokens_out, and when
    // there is no thinking tokens_total - tokens_in == tokens_out, so this is
    // backward-compatible for every existing provider.
    const billedOut = c.tokens_total ? (c.tokens_total - (c.tokens_in || 0)) : (c.tokens_out || 0);
    usd += (c.tokens_in || 0) * p.input / 1e6
      + billedOut * p.output / 1e6
      + (c.cache_read_tokens || 0) * p.cache_read / 1e6
      + (c.cache_write_tokens || 0) * p.cache_write / 1e6;
  }
  return usd;
}
