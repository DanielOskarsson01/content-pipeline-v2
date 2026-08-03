/**
 * USD cost of AI usage, from the meta.ai_usage shape applyAiCallMeta persists.
 *
 * Prices are $ per MILLION tokens, verified against platform.claude.com
 * 2026-08-03 (Anthropic) — cache reads bill ~0.1x base input, cache writes
 * 1.25x (5-minute TTL; the pipeline never requests the 1h tier). claude-sonnet-5
 * has an intro price ($2/$10) through 2026-08-31; the standard price is used
 * here deliberately — a cost CAP computed on the higher price refuses earlier,
 * never later. Non-Anthropic rows are the providers' published token rates;
 * Perplexity sonar additionally bills PER-SEARCH FEES that are invisible in
 * token counts (measured 2026-07-28: fees, not tokens, are its cost floor),
 * so sonar totals here are a floor, not the bill.
 */
export const MODEL_PRICES_PER_MTOK = {
  'claude-sonnet-5': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  'claude-opus-4-8': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'gpt-4o': { input: 2.5, output: 10, cache_read: 1.25, cache_write: 2.5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cache_read: 0.075, cache_write: 0.15 },
  sonar: { input: 1, output: 1, cache_read: 1, cache_write: 1 },
  'sonar-pro': { input: 3, output: 15, cache_read: 3, cache_write: 3 },
};

// Unknown model → priced as the most expensive row so a cap can only
// over-refuse, never silently under-count.
const FALLBACK = MODEL_PRICES_PER_MTOK['claude-opus-4-8'];

/**
 * @param {{calls?: Array<{model?:string, tokens_in?:number, tokens_out?:number, cache_read_tokens?:number, cache_write_tokens?:number}>}|null} aiUsage
 * @returns {number} USD (0 for null/non-AI usage)
 */
export function costOfUsage(aiUsage) {
  let usd = 0;
  for (const c of aiUsage?.calls || []) {
    const p = MODEL_PRICES_PER_MTOK[c.model] || FALLBACK;
    usd += (c.tokens_in || 0) * p.input / 1e6
      + (c.tokens_out || 0) * p.output / 1e6
      + (c.cache_read_tokens || 0) * p.cache_read / 1e6
      + (c.cache_write_tokens || 0) * p.cache_write / 1e6;
  }
  return usd;
}
