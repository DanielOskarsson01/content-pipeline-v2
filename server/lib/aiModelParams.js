/**
 * AI model parameter capabilities.
 *
 * Extracted from stageWorker.js so the temperature gate is unit-testable
 * (stageWorker starts a BullMQ Worker at import and can't be imported here).
 *
 * Pure — no side effects, no DB, no network.
 */

// Claude-5-generation Anthropic models (Sonnet 5, Opus 4.7/4.8, Fable/Mythos 5)
// reject `temperature` with HTTP 400 ("temperature is deprecated for this
// model"). Haiku 4.5 and the 4.6-and-older line still accept it. Omitting
// temperature is always safe — a model that accepts it just uses its default —
// so this matches the known 5-gen id shapes and fails safe.
// ponytail: family regex, not a per-id list; extend the alternation when a new
// 5-generation family lands (the modules only ever map to these Anthropic ids).
const CLAUDE_TEMPERATURE_UNSUPPORTED = /^claude-(sonnet-5|fable-5|mythos-5|opus-4-[789])/;

/**
 * Whether a resolved Anthropic model id accepts the `temperature` sampling
 * parameter. Only meaningful for provider === 'anthropic'; OpenAI/Perplexity
 * models accept temperature, so callers gate this on the anthropic branch.
 */
export function anthropicAcceptsTemperature(modelId) {
  return !CLAUDE_TEMPERATURE_UNSUPPORTED.test(String(modelId ?? ''));
}
