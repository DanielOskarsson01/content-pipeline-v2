/**
 * Server-owned single-submodule harness — workbench Unit 2 (WORKBENCH_DESIGN.md §b U2).
 *
 * Runs ONE submodule's execute() in-process against a supplied (or hydrated)
 * pool, with a tools object faithful to stageWorker.buildTools: the SAME module
 * loader, the SAME #21 prompt-cache helper (buildCachedUserContent) and SSE
 * parser (parseAnthropicSSE), the SAME registry resolution (resolveModel), the SAME retry/timeout
 * semantics, the SAME aiModelParams gating (anthropicAcceptsTemperature /
 * anthropicAcceptsThinking / anthropicAcceptsEffort) and the SAME _aiCalls →
 * applyAiCallMeta cost/token/stop_reason capture incl. the truncation
 * fail-closed guard. Relocated here from scripts/run-submodule-once.js (which
 * now re-exports this) and hardened: the old copy sent `temperature` ungated
 * (400 on claude-sonnet-5), dropped thinking/effort entirely, and captured no
 * ai_usage.
 *
 * The ai.complete orchestration is MIRRORED from stageWorker.js:162-369 rather
 * than imported — stageWorker starts a live BullMQ Worker on import. A future
 * shared ai-client extraction would remove this one duplication (flagged as
 * deferred debt in WORKBENCH_DESIGN.md U2).
 *
 * READ-ONLY BY CONTRACT: this path must NEVER write submodule_runs,
 * entity_submodule_runs, run_submodule_config, entity_stage_pool,
 * submodule_run_item_data, pool_item_blobs, or any other real-run table.
 * It returns a result object; persistence belongs to the workbench experiment
 * store (Units 3/4). The injected `db` is used exclusively for READS (§7b
 * enrichment via poolHydration.js). Caveat: the §7c blob pass (hydrateItems)
 * goes through poolBlobs' own process-global db client, not the injected one —
 * select-only on pool_item_blobs, but reads follow the process env, not deps.db.
 */

import path from 'path';
import { pathToFileURL } from 'url';
import { loadModules, getSubmoduleById } from './moduleLoader.js';
import { buildCachedUserContent } from './promptCache.js';
import { parseAnthropicSSE } from './aiStream.js';
import { applyPromptOverride } from '../utils/promptOverrides.js';
import { anthropicAcceptsTemperature, anthropicAcceptsThinking, anthropicAcceptsEffort } from '../lib/aiModelParams.js';
import { applyAiCallMeta } from '../utils/aiCallMeta.js';
import { resolveModel, PROVIDERS } from '../config/llmRegistry.js';
import { resolveApiKey } from './apiKeys.js';
import { hydrateFrozenInput } from './poolHydration.js';

// Model resolution is shared with stageWorker via the LLM registry
// (server/config/llmRegistry.js) — resolveModel(provider, model) is
// provider-scoped and throws on a bad pair. One source, no more hand-synced map.

const AI_REQUEST_TIMEOUT_MS = 600_000;
const AI_MAX_RETRIES = 3;
const AI_BASE_DELAY_MS = 2000; // 2s → 4s → 8s exponential backoff (stageWorker parity)
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);

// stageWorker parity: e.isTimeout marks duration-driven timeouts NOT retryable
// (a retry just re-hits the same wall).
function withTimeout(fn, ms) {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      const e = new Error(`HTTP request timed out after ${ms}ms`);
      e.isTimeout = true;
      reject(e);
    }, ms);
    fn(controller.signal).then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Build a tools object faithful to stageWorker.buildTools, minus DB progress
 * writes and minus browser/unlocker/storage (no module the workbench targets
 * uses them; storage would WRITE stored_assets, which this path must not do).
 */
export function buildHarnessTools(submoduleId, logs = [], db = undefined) {
  const log = (level, message) => {
    console.error(`[${submoduleId}] ${message}`);
    logs.push({ level, message, timestamp: new Date().toISOString() });
  };
  const logger = { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) };

  const http = {
    get: async (url, o = {}) => withTimeout(async (signal) => {
      const res = await fetch(url, { signal, headers: o.headers || {} });
      return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text(), url: res.url };
    }, o.timeout || 30000),
    head: async (url, o = {}) => withTimeout(async (signal) => {
      const res = await fetch(url, { method: 'HEAD', signal, headers: o.headers || {} });
      return { status: res.status, headers: Object.fromEntries(res.headers), url: res.url };
    }, o.timeout || 30000),
    post: async (url, body, o = {}) => withTimeout(async (signal) => {
      const res = await fetch(url, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', ...(o.headers || {}) },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
    }, o.timeout || 30000),
  };

  const progress = { update: () => {}, get lastTotal() { return 1; } };

  // Per-call AI ledger — read after execute() returns to fold token usage +
  // stop reasons into meta.ai_usage and fail closed on truncation
  // (applyAiCallMeta), exactly as stageWorker does at its step 11.
  const aiCalls = [];

  const ai = {
    // Mirror of stageWorker ai.complete (stageWorker.js:162-369).
    complete: async ({ prompt, model = 'haiku', provider = 'anthropic', temperature, max_tokens, cache_prefix, thinking, effort }) => {
      const startTime = Date.now();
      // Provider-scoped resolution — throws on an unknown provider/model pair
      // before any HTTP call (stageWorker parity).
      const modelId = resolveModel(provider, model);

      // BACKLOG #53: caller asked for a control the model family doesn't
      // accept → omit it silently (never 400), but leave a trace.
      if (provider === 'anthropic') {
        if (thinking != null && !anthropicAcceptsThinking(modelId)) logger.info(`[ai] thinking control omitted — ${modelId} does not accept an explicit thinking config`);
        if (effort != null && !anthropicAcceptsEffort(modelId)) logger.info(`[ai] effort control omitted — ${modelId} does not accept output_config.effort`);
      } else {
        // BACKLOG #49 landmine: non-anthropic branches can't honor these controls;
        // make the drop visible instead of silent (stageWorker parity).
        if (thinking != null) logger.info(`[ai] thinking control dropped — provider '${provider}' has no thinking config`);
        if (effort != null) logger.info(`[ai] effort control dropped — provider '${provider}' has no output_config.effort`);
        if (cache_prefix != null) {
          logger.info(provider === 'gemini'
            ? `[ai] prompt-cache not honored on gemini — cache_prefix inlined into the prompt (no caching savings)`
            : `[ai] cache_prefix DROPPED — provider '${provider}' sends the prompt WITHOUT the cache prefix (content decapitated)`);
        }
      }

      async function callProvider() {
        // #49 Unit 7: .env wins, DB-stored key fills the gap (stageWorker parity).
        // db is optional here (CLI harness → env-only); prod passes the injected db.
        const apiKey = await resolveApiKey(provider, db);
        if (!apiKey) throw new Error(`No API key for provider "${provider}" — set ${PROVIDERS[provider]?.envVar ?? 'its API key'} in the environment or add one in settings`);

        if (provider === 'anthropic') {

          const streamed = await withTimeout(async (signal) => {
            const res = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              signal,
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: modelId,
                max_tokens: max_tokens ?? 16384,
                stream: true,
                messages: [{ role: 'user', content: buildCachedUserContent(prompt, cache_prefix) }],
                // Claude-5 models (sonnet-5, opus-4-8, …) 400 on `temperature`;
                // haiku-4-5 and older still accept it. Omit for the 5-gen ids.
                ...(temperature != null && anthropicAcceptsTemperature(modelId) && { temperature }),
                // BACKLOG #53: optional thinking/effort control — sent only
                // when the caller supplies it AND the family accepts it.
                ...(thinking != null && anthropicAcceptsThinking(modelId) && { thinking }),
                ...(effort != null && anthropicAcceptsEffort(modelId) && { output_config: { effort } }),
              }),
            });
            if (res.status !== 200) {
              const errBody = await res.text();
              const err = new Error(`Anthropic API error ${res.status}: ${errBody.slice(0, 500)}`);
              err.statusCode = res.status;
              throw err;
            }
            return await parseAnthropicSSE(res.body);
          }, AI_REQUEST_TIMEOUT_MS);

          const duration_ms = Date.now() - startTime;
          const stopReason = streamed.stop_reason || 'unknown';
          const result = {
            text: streamed.text || '',
            tokens_in: streamed.tokens_in || 0,
            tokens_out: streamed.tokens_out || 0,
            cache_write_tokens: streamed.cache_creation_input_tokens || 0,
            cache_read_tokens: streamed.cache_read_input_tokens || 0,
            model: modelId,
            provider: 'anthropic',
            stop_reason: stopReason,
            duration_ms,
          };
          if (stopReason === 'max_tokens') {
            logger.warn(`[ai] ${provider}/${model} — response TRUNCATED (hit max_tokens). Output may be incomplete.`);
          }
          const cacheNote = (result.cache_read_tokens || result.cache_write_tokens)
            ? `, cache: ${result.cache_read_tokens} read / ${result.cache_write_tokens} write`
            : '';
          logger.info(`[ai] ${provider}/${model} — ${result.tokens_in} in, ${result.tokens_out} out${cacheNote}, ${duration_ms}ms, stop: ${stopReason} (streamed)`);
          return result;
        }

        // openai / perplexity / gemini (non-streamed), mirroring stageWorker's branches.
        const endpoints = {
          openai: 'https://api.openai.com/v1/chat/completions',
          perplexity: 'https://api.perplexity.ai/chat/completions',
          gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        };
        if (!endpoints[provider]) throw new Error(`Unknown AI provider: "${provider}". Supported: anthropic, openai, perplexity, gemini`);

        // Gemini has no Anthropic-style cache_control blocks; inline the stable
        // prefix into the prompt (string concat — byte-identical to the split the
        // model would otherwise see) so a cache_prefix caller is never decapitated.
        // openai / perplexity keep content = prompt (byte-identical to pre-#49).
        const content = (provider === 'gemini' && typeof cache_prefix === 'string' && cache_prefix.length > 0)
          ? cache_prefix + prompt
          : prompt;

        const { status, body } = await withTimeout(async (signal) => {
          const res = await fetch(endpoints[provider], {
            method: 'POST', signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: modelId,
              messages: [{ role: 'user', content }],
              ...(max_tokens && { max_tokens }),
              ...(temperature != null && { temperature }),
            }),
          });
          return { status: res.status, body: await res.text() };
        }, AI_REQUEST_TIMEOUT_MS);

        if (status !== 200) {
          const err = new Error(`${provider} API error ${status}: ${body.slice(0, 500)}`);
          err.statusCode = status;
          throw err;
        }
        const data = JSON.parse(body);
        const duration_ms = Date.now() - startTime;
        const result = {
          text: data.choices?.[0]?.message?.content || '',
          tokens_in: data.usage?.prompt_tokens || 0,
          tokens_out: data.usage?.completion_tokens || 0,
          model: modelId,
          provider,
          ...(provider === 'perplexity' && { citations: data.citations || [] }),
          // Gemini 2.5 counts internal thinking tokens in total_tokens (not in
          // completion_tokens) — carry total so cost math isn't undercounted.
          ...(provider === 'gemini' && { tokens_total: data.usage?.total_tokens || 0 }),
          // #49: carried for the empty/refused fail-closed reason string.
          finish_reason: data.choices?.[0]?.finish_reason ?? null,
          duration_ms,
        };
        logger.info(`[ai] ${provider}/${model} — ${result.tokens_in} in, ${result.tokens_out} out, ${duration_ms}ms`);
        return result;
      }

      // Retry loop with exponential backoff — stageWorker parity (isTimeout is
      // NOT retryable; only no-status network errors + RETRYABLE_STATUSES are).
      let lastError;
      for (let attempt = 1; attempt <= AI_MAX_RETRIES; attempt++) {
        try {
          const res = await callProvider();
          aiCalls.push({
            provider: res.provider,
            model: res.model,
            tokens_in: res.tokens_in || 0,
            tokens_out: res.tokens_out || 0,
            tokens_total: res.tokens_total || 0, // #49: gemini's billed-output incl. thinking; 0 elsewhere
            cache_write_tokens: res.cache_write_tokens || 0,
            cache_read_tokens: res.cache_read_tokens || 0,
            stop_reason: res.stop_reason ?? null,
            // #49: 200-OK with empty text = safety refusal / content filter →
            // flag so applyAiCallMeta fails closed (stageWorker parity).
            empty_completion: !res.text || res.text.trim() === '',
            finish_reason: res.finish_reason ?? res.stop_reason ?? null,
          });
          return res;
        } catch (err) {
          lastError = err;
          const isTransient = !err.isTimeout && (!err.statusCode || RETRYABLE_STATUSES.has(err.statusCode));
          if (!isTransient || attempt === AI_MAX_RETRIES) throw err;
          const delay = AI_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          logger.warn(`[ai] ${provider}/${model} — attempt ${attempt}/${AI_MAX_RETRIES} failed (${err.message}), retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      throw lastError;
    },
  };

  return { logger, http, progress, ai, _partialItems: [], _aiCalls: aiCalls, _logs: logs };
}

async function loadExecuteFunction(manifest) {
  const mod = await import(pathToFileURL(path.join(manifest._path, 'execute.js')).href);
  const fn = mod.default || mod;
  if (typeof fn !== 'function') throw new Error(`execute.js in ${manifest.id} does not export a function`);
  return fn;
}

/**
 * Run one submodule once. Returns the UNWRAPPED per-entity result (stageWorker
 * parity: legacy `{results:[...]}` shapes are unwrapped to the entity's own
 * `{items, meta}`), with meta.ai_usage + the truncation fail-closed guard
 * applied via applyAiCallMeta.
 *
 * @param {object} spec
 * @param {string}  spec.submodule_id
 * @param {{name:string, items?:any[]}} spec.entity
 * @param {object}  [spec.options]         merged over manifest options_defaults
 *   (plays the run_submodule_config role)
 * @param {object}  [spec.overrides]       per-call option overrides (e.g.
 *   ai_model, max_tokens, thinking, effort, prompt) merged over the resolved
 *   options — the workbench's edit surface
 * @param {object}  [spec.prompt_override] applyPromptOverride payload
 * @param {Record<string,string>} [spec.reference_docs] resolves {doc:...}
 * @param {string}  [spec.run_id]          real pipeline_runs.id (required for hydrate)
 * @param {number}  [spec.step_index]      defaults to manifest.step
 * @param {boolean} [spec.hydrate]         run §7b+§7c frozen-input hydration on
 *   spec.entity.items before execute (requires deps.db + spec.run_id)
 * @param {string}  [spec.exclude_run_id]  entity_submodule_runs id to exclude
 *   from §7b upstream (pass the replayed run's own id for prod parity)
 * @param {object} [deps]
 * @param {object} [deps.db]  injected Supabase client — READS ONLY (hydration)
 */
export async function runSubmoduleOnce(spec, deps = {}) {
  if (!spec?.submodule_id) throw new Error('spec.submodule_id is required');
  if (!spec?.entity?.name) throw new Error('spec.entity.name is required (entity = { name, items })');

  loadModules();
  const manifest = getSubmoduleById(spec.submodule_id);
  if (!manifest) throw new Error(`Submodule '${spec.submodule_id}' not found (is MODULES_PATH set / does it exist?)`);

  const executeFn = await loadExecuteFunction(manifest);

  // options = manifest defaults <- spec.options <- spec.overrides,
  // plus reference docs map for {doc:...}
  const options = { ...(manifest.options_defaults || {}), ...(spec.options || {}), ...(spec.overrides || {}) };
  if (spec.reference_docs) options.reference_docs = { ...(options.reference_docs || {}), ...spec.reference_docs };

  // Resolve prompt_override against the base prompt (resolved options.prompt or manifest default).
  let promptInfo = null;
  if (spec.prompt_override) {
    const basePrompt = options.prompt ?? '';
    promptInfo = applyPromptOverride(basePrompt, spec.prompt_override);
    options.prompt = promptInfo.prompt;
  }

  const stepIndex = spec.step_index ?? manifest.step ?? 0;
  const items = spec.entity.items || [];

  // §7b + §7c frozen-input hydration (U1's shared poolHydration) — opt-in so
  // pre-hydrated CLI specs keep working. Reads real-run tables; never writes.
  let hydration = null;
  if (spec.hydrate) {
    if (!deps.db) throw new Error('spec.hydrate requires deps.db (injected Supabase client)');
    if (!spec.run_id) throw new Error('spec.hydrate requires spec.run_id');
    const { enrichedFields, hydratedBlobs } = await hydrateFrozenInput({
      runId: spec.run_id,
      entityName: spec.entity.name,
      stepIndex,
      items,
      manifest,
      excludeRunId: spec.exclude_run_id,
      db: deps.db,
    });
    hydration = { enrichedFields: [...enrichedFields], hydratedBlobs };
  }

  const logs = [];
  const tools = buildHarnessTools(spec.submodule_id, logs, deps.db);

  // stageWorker parity: legacyInput carries BOTH `entity` and `entities`, and
  // the entity keeps its extra keys (website, linkedin, loop_count, …) — prod
  // builds { ...orig, name, items } and modules/prompts read those fields.
  const entity = { ...spec.entity, name: spec.entity.name, items };
  const input = {
    entity,
    entities: [entity],
    run_id: spec.run_id || 'harness-once',
    step_index: stepIndex,
    submodule_id: spec.submodule_id,
  };

  const rawResult = await executeFn(input, options, tools);

  // Unwrap to the per-entity result (stageWorker parity).
  let result;
  if (rawResult?.results && Array.isArray(rawResult.results)) {
    result = rawResult.results.find(r => r.entity_name === spec.entity.name) || rawResult.results[0] || { items: [] };
  } else {
    result = rawResult;
  }

  // Fold token totals + stop reasons into meta.ai_usage and fail closed on
  // truncation — identical to stageWorker step 11. (stageWorker's 9b
  // enriched-field strip is a pool-persistence concern; nothing is persisted
  // here, so the full result is returned.)
  applyAiCallMeta(result, tools._aiCalls);

  return {
    submodule_id: spec.submodule_id,
    version: manifest.version,
    // The FULL options object execute() ran with — U4 stores it as the
    // experiment's resolved_config (provenance: spec §2 "full resolved config").
    resolvedOptions: options,
    resolvedPrompt: options.prompt,
    promptInfo,
    result,
    summary: rawResult?.summary ?? null,
    hydration,
    logs,
  };
}
