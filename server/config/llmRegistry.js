/**
 * LLM REGISTRY — the single source of truth for AI providers and models
 * (BACKLOG #49). One place to add a model or a price; read by the two ai.complete
 * copies (stageWorker.js, submoduleHarness.js) for resolution, by aiCost.js for
 * pricing, and by GET /api/providers for the picker. "Develop in only one place."
 *
 * Two things this file makes impossible:
 *   1. A bad provider+model pair silently sending the wrong id. The old
 *      `MODEL_MAP[model] || model` was GLOBAL — provider='gemini' + model='sonnet'
 *      resolved 'claude-sonnet-5' and POSTed it to the Gemini endpoint. Here
 *      resolveModel(provider, model) is provider-SCOPED and THROWS on a mismatch.
 *   2. Price drift between "what the picker shows" and "what cost math bills" —
 *      both read PRICES_BY_ID derived from this one table.
 *
 * ⚠️ `id` is the exact string the adapter branches on: 'gemini', NOT 'google'
 *    (Lineage A's BUILD_PLAN wrote 'google' — the code has always branched on
 *    'gemini'; following 'google' would silently miss).
 *
 * Adding a MODEL to an existing provider = one entry here (free — no adapter
 * change). Adding a VENDOR = a new adapter branch in both ai.complete copies
 * first, then a provider entry here (see brief §5).
 *
 * Prices are $ per MILLION tokens. Anthropic/OpenAI/Gemini verified against the
 * platform consoles 2026-08-03; Perplexity verified 2026-08-04
 * (burnwise.io / pricepertoken.com). NOTE the aiCost caveats carry: claude-sonnet-5
 * standard price is used deliberately (a cap on the higher price refuses earlier);
 * Perplexity additionally bills PER-SEARCH FEES invisible in token counts, so
 * sonar token totals are a floor, not the bill; Gemini has no native prompt
 * caching (cache_* tokens are always 0) so its cache_* rates are inert.
 *
 * `alias: true` marks a '-latest' id whose underlying model AND price can shift
 * without notice — surfaced in the picker so a choice is never blindly durable.
 *
 * This module is PURE: zero imports, no env reads, no db. Env presence
 * ("is this provider configured?") is a runtime concern owned by GET /api/providers
 * — this file only declares each provider's `envVar` NAME.
 */

export const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    models: {
      haiku:  { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', input: 1,   output: 5,  cache_read: 0.1, cache_write: 1.25 },
      sonnet: { id: 'claude-sonnet-5',           displayName: 'Claude Sonnet 5',  input: 3,   output: 15, cache_read: 0.3, cache_write: 3.75 },
      opus:   { id: 'claude-opus-4-8',           displayName: 'Claude Opus 4.8',  input: 5,   output: 25, cache_read: 0.5, cache_write: 6.25 },
    },
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    models: {
      'gpt-4o-mini': { id: 'gpt-4o-mini', displayName: 'GPT-4o mini', input: 0.15, output: 0.6, cache_read: 0.075, cache_write: 0.15 },
      'gpt-4o':      { id: 'gpt-4o',      displayName: 'GPT-4o',      input: 2.5,  output: 10,  cache_read: 1.25,  cache_write: 2.5 },
    },
  },
  perplexity: {
    id: 'perplexity',
    displayName: 'Perplexity',
    envVar: 'PERPLEXITY_API_KEY',
    // token rates are a FLOOR — perplexity also bills per-search fees (see header).
    models: {
      sonar:                 { id: 'sonar',                 displayName: 'Sonar',                 input: 1, output: 1,  cache_read: 1, cache_write: 1 },
      'sonar-pro':           { id: 'sonar-pro',             displayName: 'Sonar Pro',             input: 3, output: 15, cache_read: 3, cache_write: 3 },
      'sonar-reasoning':     { id: 'sonar-reasoning',       displayName: 'Sonar Reasoning',       input: 1, output: 5,  cache_read: 1, cache_write: 1 },
      'sonar-reasoning-pro': { id: 'sonar-reasoning-pro',   displayName: 'Sonar Reasoning Pro',   input: 2, output: 8,  cache_read: 2, cache_write: 2 },
    },
  },
  gemini: {
    id: 'gemini',
    displayName: 'Google Gemini',
    envVar: 'GOOGLE_AI_API_KEY',
    // '-latest' aliases only — dated ids (gemini-2.5-flash, …) 404 "no longer
    // available to new users" on this project's key (verified live 2026-08-03).
    // No native prompt caching → cache_* rates inert.
    models: {
      'gemini-flash': { id: 'gemini-flash-latest', displayName: 'Gemini Flash (latest)', input: 0.30, output: 2.50, cache_read: 0.30, cache_write: 0.30, alias: true },
      'gemini-pro':   { id: 'gemini-pro-latest',   displayName: 'Gemini Pro (latest)',   input: 1.25, output: 10,   cache_read: 1.25, cache_write: 10,   alias: true },
    },
  },
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    envVar: 'OPENROUTER_API_KEY',
    // OpenRouter is an OpenAI-compatible PROXY over many vendors (Moonshot, MiniMax,
    // DeepSeek, Qwen, Z.ai, Mistral, Meta, OpenAI, Google …). The adapter reuses the
    // OpenAI-compatible branch — no new request/response plumbing (BACKLOG #54).
    //
    // Prices are $/MILLION tokens as OpenRouter LISTED THEM 2026-08-05 (resolved live
    // from GET /api/v1/models), NOT the screening roster's — 10 of 18 drifted from the
    // roster's 2026-08-04 figures because OpenRouter routes each call to the cheapest
    // available host and per-host prices move. Treat every price here as a SNAPSHOT:
    // re-resolve against /api/v1/models before trusting a cost delta. The real billed
    // number is captured per-call from usage.cost (usage:{include:true}) and beats
    // this table; these rates are the fallback estimate + the picker's at-a-glance cost.
    //
    // cache_* rates are INERT: the adapter sends no Anthropic cache_control blocks
    // (cache_prefix is INLINED into the prompt like gemini), so cache_read/cache_write
    // tokens are always 0. Set equal to `input` so a stray cached token could only be
    // priced sanely, never at $0 or a wild rate.
    //
    // `alias: true` marks a '-preview' or undated slug whose underlying build AND price
    // can shift without notice (gemini-3-flash-preview; deepseek-v4-flash tracks a
    // dated snapshot) — surfaced in the picker so a choice is never blindly durable.
    models: {
      'kimi-k2.6':              { id: 'moonshotai/kimi-k2.6', displayName: 'Kimi K2.6', input: 0.589, output: 2.48, cache_read: 0.589, cache_write: 0.589 },
      'kimi-k2.5':              { id: 'moonshotai/kimi-k2.5', displayName: 'Kimi K2.5', input: 0.57, output: 2.85, cache_read: 0.57, cache_write: 0.57 },
      'minimax-m2.7':           { id: 'minimax/minimax-m2.7', displayName: 'MiniMax M2.7', input: 0.27, output: 1.08, cache_read: 0.27, cache_write: 0.27 },
      'minimax-m2.5':           { id: 'minimax/minimax-m2.5', displayName: 'MiniMax M2.5', input: 0.15, output: 0.9, cache_read: 0.15, cache_write: 0.15 },
      'deepseek-v4-pro':        { id: 'deepseek/deepseek-v4-pro', displayName: 'DeepSeek V4-Pro', input: 0.435, output: 0.87, cache_read: 0.435, cache_write: 0.435 },
      'deepseek-v4-flash':      { id: 'deepseek/deepseek-v4-flash', displayName: 'DeepSeek V4-Flash', input: 0.14, output: 0.28, cache_read: 0.14, cache_write: 0.14, alias: true },
      'qwen3.7-plus':           { id: 'qwen/qwen3.7-plus', displayName: 'Qwen3.7 Plus', input: 0.32, output: 1.28, cache_read: 0.32, cache_write: 0.32 },
      'qwen3.5-flash':          { id: 'qwen/qwen3.5-flash-02-23', displayName: 'Qwen3.5-Flash', input: 0.065, output: 0.26, cache_read: 0.065, cache_write: 0.065 },
      'glm-5.2':                { id: 'z-ai/glm-5.2', displayName: 'GLM 5.2', input: 0.76, output: 2.42, cache_read: 0.76, cache_write: 0.76 },
      'glm-4.7-flash':          { id: 'z-ai/glm-4.7-flash', displayName: 'GLM 4.7 Flash', input: 0.06, output: 0.4, cache_read: 0.06, cache_write: 0.06 },
      'mistral-medium-3':       { id: 'mistralai/mistral-medium-3', displayName: 'Mistral Medium 3', input: 0.4, output: 2.0, cache_read: 0.4, cache_write: 0.4 },
      'mistral-small-3.2':      { id: 'mistralai/mistral-small-3.2-24b-instruct', displayName: 'Mistral Small 3.2 24B', input: 0.0938, output: 0.25, cache_read: 0.0938, cache_write: 0.0938 },
      'llama-4-maverick':       { id: 'meta-llama/llama-4-maverick', displayName: 'Llama 4 Maverick', input: 0.2, output: 0.8, cache_read: 0.2, cache_write: 0.2 },
      'gpt-oss-120b':           { id: 'openai/gpt-oss-120b', displayName: 'gpt-oss-120b', input: 0.037, output: 0.17, cache_read: 0.037, cache_write: 0.037 },
      'gpt-5.4-nano':           { id: 'openai/gpt-5.4-nano', displayName: 'GPT-5.4 Nano', input: 0.2, output: 1.25, cache_read: 0.2, cache_write: 0.2 },
      'gpt-5-mini':             { id: 'openai/gpt-5-mini', displayName: 'GPT-5 Mini', input: 0.25, output: 2.0, cache_read: 0.25, cache_write: 0.25 },
      'gemini-3-flash':         { id: 'google/gemini-3-flash-preview', displayName: 'Gemini 3 Flash', input: 0.5, output: 3.0, cache_read: 0.5, cache_write: 0.5, alias: true },
      'gemini-3.5-flash-lite':  { id: 'google/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', input: 0.3, output: 2.5, cache_read: 0.3, cache_write: 0.3 },
    },
  },
};

/**
 * Resolve a (provider, model) pair to the exact API model id, PROVIDER-SCOPED.
 * Accepts the dropdown key ('sonnet') OR the already-resolved API id
 * ('claude-sonnet-5') — but only when that id belongs to THIS provider, so a
 * cross-provider id (gemini + 'claude-sonnet-5') still throws.
 *
 * Throws loudly on an unknown provider or an unknown model-for-provider. This is
 * the correctness core of the brief: an invalid pair errors at resolution time,
 * BEFORE any HTTP call — never falls through to send the wrong id.
 *
 * @param {string} provider  e.g. 'anthropic'
 * @param {string} model     dropdown key or API id, e.g. 'sonnet' / 'claude-sonnet-5'
 * @returns {string} the API model id to send
 */
export function resolveModel(provider, model) {
  const p = PROVIDERS[provider];
  if (!p) {
    throw new Error(`Unknown AI provider: "${provider}". Known providers: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  if (p.models[model]) return p.models[model].id;
  // someone passed the already-resolved API id — accept it only within this provider
  const byId = Object.values(p.models).find((m) => m.id === model);
  if (byId) return byId.id;
  throw new Error(
    `Model "${model}" is not valid for provider "${provider}". Valid models: ${Object.keys(p.models).join(', ')}`,
  );
}

/**
 * Price table keyed by API model id, derived from PROVIDERS — the ONE source
 * aiCost.js prices usage from and the picker displays from. Adding a model above
 * prices it here automatically.
 * @type {Record<string, {input:number, output:number, cache_read:number, cache_write:number}>}
 */
export const PRICES_BY_ID = Object.fromEntries(
  Object.values(PROVIDERS).flatMap((p) =>
    Object.values(p.models).map((m) => [
      m.id,
      { input: m.input, output: m.output, cache_read: m.cache_read, cache_write: m.cache_write },
    ]),
  ),
);
