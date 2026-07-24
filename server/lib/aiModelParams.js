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

// BACKLOG #53: explicit thinking control (`thinking: {type: "disabled"}` etc.)
// is a Claude-4.6+/5-gen request surface. Fable/Mythos 5 are EXCLUDED: thinking
// is always on there and an explicit "disabled" is rejected with 400 — omitting
// the param is the only valid shape for them. Unlike the temperature gate this
// is an ALLOW-list: unknown/older ids → omit, which is always safe.
// Probe 2026-07-24 on claude-sonnet-5 (run cb49ef80 tone-editor payload):
// disabled cut output_tokens 24592→8212 with visible text unchanged.
const CLAUDE_THINKING_CONTROL = /^claude-(sonnet-5|sonnet-4-6|opus-4-[6789])/;

/** Whether a resolved Anthropic model id accepts an explicit `thinking` config. */
export function anthropicAcceptsThinking(modelId) {
  return CLAUDE_THINKING_CONTROL.test(String(modelId ?? ''));
}

// `output_config.effort` — supported on Opus 4.5+, Sonnet 4.6+, Fable/Mythos 5.
// Haiku 4.5 rejects it. Allow-list for the same fail-safe reason as above.
// Probe 2026-07-24: output_config {effort:"low"} accepted on claude-sonnet-5.
const CLAUDE_EFFORT = /^claude-(sonnet-5|sonnet-4-6|fable-5|mythos-5|opus-4-[56789])/;

/** Whether a resolved Anthropic model id accepts `output_config: {effort}`. */
export function anthropicAcceptsEffort(modelId) {
  return CLAUDE_EFFORT.test(String(modelId ?? ''));
}
