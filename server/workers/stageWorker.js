/**
 * Pipeline Stage Worker — BullMQ worker that executes submodules.
 *
 * Runs as a standalone PM2 process (not imported by server.js).
 * Entry point: node server/workers/stageWorker.js
 *
 * Job payload: { submodule_run_id, submodule_id, step_index }
 * The worker loads input_data and options from the submodule_runs row,
 * then loads execute.js from MODULES_PATH and calls it.
 */

import 'dotenv/config';
import { Worker } from 'bullmq';
import path from 'path';
import { pathToFileURL } from 'url';
import db from '../services/db.js';
import { createSupabaseStorage } from '../services/storage.js';
import { redis } from '../services/queue.js';
import { loadModules, getSubmoduleById } from '../services/moduleLoader.js';
import { anthropicAcceptsTemperature, anthropicAcceptsThinking, anthropicAcceptsEffort } from '../lib/aiModelParams.js';
import { extractTagSuggestions, writeTaxonomySuggestions } from '../services/taxonomySuggestions.js';
import { COST_CONFIG } from '../config/timeouts.js';
import { resolveModel, PROVIDERS } from '../config/llmRegistry.js';
import { resolveApiKey } from '../services/apiKeys.js';
import { hydrateItems } from '../services/poolBlobs.js';
import { archiveEntityScrape, logCorpusArchiveStatus } from '../services/corpusArchive.js';
import { hydrateRequiresColumns } from '../services/poolHydration.js';
import { convertXlsxInDir } from '../utils/xlsxConverter.js';
import { parseAnthropicSSE } from '../services/aiStream.js';
import { buildCachedUserContent } from '../services/promptCache.js';
import { deriveEntityRunStatus } from '../utils/entityRunStatus.js';
import { applyAiCallMeta } from '../utils/aiCallMeta.js';
import { extractInputTruncation, buildInputTruncationLogRow } from '../utils/inputTruncation.js';
import {
  buildBatchRequestParams, batchLedgerEntry,
  submitAnthropicBatch, getAnthropicBatch, pollAnthropicBatch, fetchAnthropicBatchResults,
} from '../services/anthropicBatch.js';

// Phase 2B: how long the step-6 batch job will wait for an Anthropic Message Batch to end
// before failing loudly (the Anthropic batch itself expires at 24h). The orchestrator's
// per-step wait (autoExecutor MAX_BATCH_TIMEOUT_ASYNC) must exceed this.
const BATCH_POLL_MAX_MS = 24 * 60 * 60 * 1000 + 30 * 60 * 1000; // 24h + 30m margin

// Load submodule manifests (worker is a separate process from server.js)
loadModules();

// Providers whose adapter INLINES cache_prefix into the prompt (string concat)
// instead of sending Anthropic cache_control blocks: gemini and openrouter both
// speak the OpenAI-compatible /chat/completions shape, which has no cache_control.
// Inlining keeps the content whole (never decapitated); there is simply no cache
// hit/write. MUST stay in sync with the openrouter/gemini content construction
// below AND with submoduleHarness.js's copy.
const PROVIDER_INLINES_CACHE_PREFIX = new Set(['gemini', 'openrouter']);

/**
 * Model name → API model id resolution now lives in the shared LLM registry
 * (server/config/llmRegistry.js): resolveModel(provider, model) is PROVIDER-scoped
 * and throws on a bad pair, so a gemini+sonnet mix can no longer silently POST
 * claude-sonnet-5 to the gemini endpoint. Adding a model is one entry there.
 */

/**
 * Build the tools object that gets passed to execute().
 * See spec Part 12.
 * @param {string} runId - entity_submodule_runs row ID to write progress to
 * @param {string} submoduleId - For logging prefix
 */
function buildTools(runId, submoduleId) {
  const progressTable = 'entity_submodule_runs';
  const logs = [];

  const logger = {
    info: (message) => {
      console.log(`[${submoduleId}] ${message}`);
      logs.push({ level: 'info', message, timestamp: new Date().toISOString() });
    },
    warn: (message) => {
      console.warn(`[${submoduleId}] ${message}`);
      logs.push({ level: 'warn', message, timestamp: new Date().toISOString() });
    },
    error: (message) => {
      console.error(`[${submoduleId}] ${message}`);
      logs.push({ level: 'error', message, timestamp: new Date().toISOString() });
    },
  };

  // Helper: race a fetch operation against a timeout. Ensures the ENTIRE operation
  // (connect + headers + body read) completes within the limit. Also aborts the
  // underlying connection on timeout to prevent leaked sockets.
  function withTimeout(fn, ms) {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        const e = new Error(`HTTP request timed out after ${ms}ms`);
        e.isTimeout = true; // duration-driven; NOT retryable (a retry just re-hits the same wall)
        reject(e);
      }, ms);
      fn(controller.signal).then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  const http = {
    get: async (url, options = {}) => {
      const timeout = options.timeout || 30000;
      return withTimeout(async (signal) => {
        const res = await fetch(url, { signal, headers: options.headers || {} });
        const body = await res.text();
        return { status: res.status, headers: Object.fromEntries(res.headers), body, url: res.url };
      }, timeout);
    },
    head: async (url, options = {}) => {
      const timeout = options.timeout || 30000;
      return withTimeout(async (signal) => {
        const res = await fetch(url, { method: 'HEAD', signal, headers: options.headers || {} });
        return { status: res.status, headers: Object.fromEntries(res.headers), url: res.url };
      }, timeout);
    },
    post: async (url, body, options = {}) => {
      const timeout = options.timeout || 30000;
      return withTimeout(async (signal) => {
        const res = await fetch(url, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        });
        const responseBody = await res.text();
        return { status: res.status, headers: Object.fromEntries(res.headers), body: responseBody };
      }, timeout);
    },
  };

  let _lastTotal = 1; // Track last reported total for completion write
  const progress = {
    update: (current, total, message) => {
      // Fire-and-forget — progress writes should never crash the execute function
      const progressData = { current, total, message };
      if (total > 0) _lastTotal = total;
      db.from(progressTable)
        .update({ progress: progressData })
        .eq('id', runId)
        .then(({ error }) => {
          if (error) logger.warn(`Progress update failed: ${error.message}`);
        })
        .catch(() => { /* silent */ });
    },
    get lastTotal() { return _lastTotal; },
  };

  // Retry-eligible HTTP status codes (transient errors)
  const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);

  // Per-request timeout for LLM API calls (10 minutes).
  // The Anthropic path STREAMS (see parseAnthropicSSE), so the socket stays warm
  // and this AbortController — not undici's hidden ~300s body/headers default — is
  // the real ceiling. Generous for large prompts (content-writer: 100KB+).
  const AI_REQUEST_TIMEOUT_MS = 600_000;

  // Retry config for transient failures
  const AI_MAX_RETRIES = 3;
  const AI_BASE_DELAY_MS = 2000; // 2s → 4s → 8s exponential backoff

  // Per-entity AI-call ledger. Every successful ai.complete() pushes its token
  // usage + stop_reason here. Read after the module's execute() returns to
  // (a) fail-closed when any call truncated (stop_reason==='max_tokens') and
  // (b) persist per-entity usage into output meta. Fresh per entity because
  // buildTools runs once per entity.
  const aiCalls = [];

  const ai = {
    complete: async ({ prompt, model = 'haiku', provider = 'anthropic', temperature, max_tokens, cache_prefix, thinking, effort }) => {
      const startTime = Date.now();
      // Provider-scoped resolution — throws loudly on an unknown provider or an
      // unknown model-for-provider (before any HTTP call, outside the retry loop).
      const modelId = resolveModel(provider, model);

      // BACKLOG #53: caller asked for a control the model family doesn't
      // accept → omit it silently (never 400), but leave a trace. (This logger
      // has no debug level; info is the lowest.)
      if (provider === 'anthropic') {
        if (thinking != null && !anthropicAcceptsThinking(modelId)) logger.info(`[ai] thinking control omitted — ${modelId} does not accept an explicit thinking config`);
        if (effort != null && !anthropicAcceptsEffort(modelId)) logger.info(`[ai] effort control omitted — ${modelId} does not accept output_config.effort`);
      } else {
        // BACKLOG #49 landmine: the non-anthropic branches can't honor these
        // controls. Make the drop VISIBLE instead of silent (the anthropic-gated
        // trace above never fired for non-anthropic providers, so cache_prefix /
        // thinking / effort vanished with zero signal).
        if (thinking != null) logger.info(`[ai] thinking control dropped — provider '${provider}' has no thinking config`);
        if (effort != null) logger.info(`[ai] effort control dropped — provider '${provider}' has no output_config.effort`);
        if (cache_prefix != null) {
          logger.info(PROVIDER_INLINES_CACHE_PREFIX.has(provider)
            ? `[ai] prompt-cache not honored on ${provider} — cache_prefix inlined into the prompt (no caching savings)`
            : `[ai] cache_prefix DROPPED — provider '${provider}' sends the prompt WITHOUT the cache prefix (content decapitated)`);
        }
      }

      // Inner function that makes a single API call with timeout
      async function callProvider(attempt) {
        // #49 Unit 7: .env wins, DB-stored key (settings) fills the gap. Read
        // per-call so a pasted key reaches this running worker without a restart.
        const apiKey = await resolveApiKey(provider, db);
        if (!apiKey) throw new Error(`No API key for provider "${provider}" — set ${PROVIDERS[provider]?.envVar ?? 'its API key'} in the environment or add one in settings`);

        if (provider === 'anthropic') {

          // STREAM the response. A non-streamed long generation idles the socket
          // past undici's hidden ~300s body/headers timeout → bare "fetch failed"
          // → (no statusCode) retried 3x → ~908s wall → no content for large
          // entities (Wazdan, 2026-06-13). Streaming keeps bytes flowing, so the
          // request lives until AI_REQUEST_TIMEOUT_MS. The full read is raced
          // against that timeout via withTimeout (its AbortController aborts the
          // fetch + stream on expiry).
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
                // BACKLOG #21: when the caller passes a large stable cache_prefix
                // (e.g. reference docs), split it into a cache_control'd block so
                // the API caches it (~10% input cost on re-read within 5 min).
                // No cache_prefix → plain string content, unchanged from before.
                messages: [{ role: 'user', content: buildCachedUserContent(prompt, cache_prefix) }],
                // Claude-5 models (sonnet-5, opus-4-8, …) 400 on `temperature`;
                // haiku-4-5 and older still accept it. Omit for the 5-gen ids.
                ...(temperature != null && anthropicAcceptsTemperature(modelId) && { temperature }),
                // BACKLOG #53: optional thinking/effort control — sent only
                // when the caller supplies it AND the family accepts it. A
                // call passing neither yields a byte-identical body to before.
                ...(thinking != null && anthropicAcceptsThinking(modelId) && { thinking }),
                ...(effort != null && anthropicAcceptsEffort(modelId) && { output_config: { effort } }),
              }),
            });
            if (res.status !== 200) {
              // Error responses are NOT streamed — body is a JSON error object.
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
            // BACKLOG #21 prompt-cache observability — additive fields, 0 when
            // no cache_prefix was sent or the prefix was below the cache minimum.
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

        } else if (provider === 'openai') {
          const { status, body } = await withTimeout(async (signal) => {
            const res = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              signal,
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model: modelId,
                messages: [{ role: 'user', content: prompt }],
                ...(max_tokens && { max_tokens }),
                ...(temperature != null && { temperature }),
              }),
            });
            return { status: res.status, body: await res.text() };
          }, AI_REQUEST_TIMEOUT_MS);

          if (status !== 200) {
            const err = new Error(`OpenAI API error ${status}: ${body.slice(0, 500)}`);
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
            provider: 'openai',
            // #49: carried for the empty/refused fail-closed reason string
            finish_reason: data.choices?.[0]?.finish_reason ?? null,
            duration_ms,
          };
          logger.info(`[ai] ${provider}/${model} — ${result.tokens_in} in, ${result.tokens_out} out, ${duration_ms}ms`);
          return result;

        } else if (provider === 'perplexity') {
          const { status, body } = await withTimeout(async (signal) => {
            const res = await fetch('https://api.perplexity.ai/chat/completions', {
              method: 'POST',
              signal,
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model: modelId,
                messages: [{ role: 'user', content: prompt }],
                ...(max_tokens && { max_tokens }),
                ...(temperature != null && { temperature }),
              }),
            });
            return { status: res.status, body: await res.text() };
          }, AI_REQUEST_TIMEOUT_MS);

          if (status !== 200) {
            const err = new Error(`Perplexity API error ${status}: ${body.slice(0, 500)}`);
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
            provider: 'perplexity',
            citations: data.citations || [],
            finish_reason: data.choices?.[0]?.finish_reason ?? null,
            duration_ms,
          };
          logger.info(`[ai] ${provider}/${model} — ${result.tokens_in} in, ${result.tokens_out} out, ${duration_ms}ms, ${result.citations.length} citations`);
          return result;

        } else if (provider === 'gemini') {
          // Google Gemini via its OpenAI-compatible endpoint — the openai/perplexity
          // request shape ports verbatim. cache_prefix is INLINED into the content
          // (string concat — byte-identical to the two-block split the model would
          // otherwise see; promptCache.js:7-9), NOT sent as Anthropic cache_control
          // blocks, which Gemini can't parse. So a caller that passes reference docs
          // via cache_prefix is never silently decapitated (content-analyzer does
          // exactly this). No native prompt caching → no cache read/write savings.
          const content = (typeof cache_prefix === 'string' && cache_prefix.length > 0)
            ? cache_prefix + prompt
            : prompt;

          // ponytail: non-streamed, matching openai/perplexity. undici's hidden
          // ~300s idle-socket timeout is HALF of AI_REQUEST_TIMEOUT_MS, so a long
          // generation idles past it → bare "fetch failed" (no statusCode) → 3
          // retries → ~908s wall at 3x input tokens. Fine for short-output checkers;
          // stream (OpenAI-style SSE) or make no-status timeouts fail-fast BEFORE
          // pointing this provider at a long-output step (step 5) at volume.
          const { status, body } = await withTimeout(async (signal) => {
            const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
              method: 'POST',
              signal,
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
              },
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
            const err = new Error(`Gemini API error ${status}: ${body.slice(0, 500)}`);
            err.statusCode = status;
            throw err;
          }

          const data = JSON.parse(body);
          const duration_ms = Date.now() - startTime;
          const result = {
            text: data.choices?.[0]?.message?.content || '',
            tokens_in: data.usage?.prompt_tokens || 0,
            tokens_out: data.usage?.completion_tokens || 0,
            // Gemini 2.5 counts internal "thinking" tokens in total_tokens but NOT
            // in completion_tokens — carry total so cost math isn't undercounted.
            tokens_total: data.usage?.total_tokens || 0,
            model: modelId,
            provider: 'gemini',
            // #49: a safety refusal 200s with an empty message + a content-filter
            // finish_reason — carried so applyAiCallMeta names the reason.
            finish_reason: data.choices?.[0]?.finish_reason ?? null,
            duration_ms,
          };
          logger.info(`[ai] ${provider}/${model} — ${result.tokens_in} in, ${result.tokens_out} out (total ${result.tokens_total}), ${duration_ms}ms`);
          return result;

        } else if (provider === 'openrouter') {
          // OpenRouter (BACKLOG #54) via its OpenAI-compatible endpoint — the same
          // request/response shape as openai/gemini, no new plumbing. cache_prefix is
          // INLINED into the content (string concat, like gemini) because OpenRouter's
          // /chat/completions has no Anthropic cache_control block — so a caller passing
          // reference docs via cache_prefix is never silently decapitated. No prompt-
          // cache savings are claimed (cache_* tokens stay 0).
          const content = (typeof cache_prefix === 'string' && cache_prefix.length > 0)
            ? cache_prefix + prompt
            : prompt;

          // ponytail: non-streamed, matching openai/gemini. Same undici idle-socket
          // caveat as the gemini branch — fine for short-output checkers; stream or
          // fail-fast before pointing this at a long-output step (5) at volume.
          const { status, body } = await withTimeout(async (signal) => {
            const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              signal,
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model: modelId,
                messages: [{ role: 'user', content }],
                ...(max_tokens && { max_tokens }),
                // temperature is an OpenAI-compat param OpenRouter forwards; it silently
                // drops it for a model that doesn't accept it (no 400). thinking/effort
                // are Anthropic-only and are dropped-with-a-log above (OpenRouter's
                // reasoning knob is `reasoning_effort`, deliberately not wired here).
                ...(temperature != null && { temperature }),
                // Ask OpenRouter to return the REAL billed cost (USD) in usage.cost —
                // a true number beats the registry estimate for cross-model comparison.
                usage: { include: true },
              }),
            });
            return { status: res.status, body: await res.text() };
          }, AI_REQUEST_TIMEOUT_MS);

          if (status !== 200) {
            const err = new Error(`OpenRouter API error ${status}: ${body.slice(0, 500)}`);
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
            provider: 'openrouter',
            // Real billed USD from OpenRouter (usage.cost) when present — captured
            // alongside the registry estimate so R5 can compare the two. null if the
            // upstream didn't report it → cost math falls back to the registry price.
            provider_cost: typeof data.usage?.cost === 'number' ? data.usage.cost : null,
            // #49: 200-with-empty-text = an upstream safety refusal / content filter.
            // OpenRouter proxies vendors with their own filters and iGaming copy trips
            // them — carried so applyAiCallMeta fails closed with a named reason.
            finish_reason: data.choices?.[0]?.finish_reason ?? null,
            duration_ms,
          };
          const costNote = result.provider_cost != null ? `, billed $${result.provider_cost}` : '';
          logger.info(`[ai] ${provider}/${model} — ${result.tokens_in} in, ${result.tokens_out} out${costNote}, ${duration_ms}ms`);
          return result;

        } else {
          throw new Error(`Unknown AI provider: "${provider}". Supported: anthropic, openai, perplexity, gemini, openrouter`);
        }
      }

      // Retry loop with exponential backoff for transient errors
      let lastError;
      for (let attempt = 1; attempt <= AI_MAX_RETRIES; attempt++) {
        try {
          const res = await callProvider(attempt);
          aiCalls.push({
            provider: res.provider,
            model: res.model,
            tokens_in: res.tokens_in || 0,
            tokens_out: res.tokens_out || 0,
            tokens_total: res.tokens_total || 0, // #49: gemini's billed-output incl. thinking; 0 elsewhere
            cache_write_tokens: res.cache_write_tokens || 0,
            cache_read_tokens: res.cache_read_tokens || 0,
            provider_cost: res.provider_cost ?? null, // #54: OpenRouter's real billed USD; null elsewhere
            stop_reason: res.stop_reason ?? null,
            // #49: a 200-OK with empty text is a safety refusal (gemini) or a
            // content filter — flag it so applyAiCallMeta fails closed instead of
            // publishing a blank as success. finish_reason feeds the reason string.
            empty_completion: !res.text || res.text.trim() === '',
            finish_reason: res.finish_reason ?? res.stop_reason ?? null,
          });
          return res;
        } catch (err) {
          lastError = err;
          const isTransient = !err.isTimeout && (                       // duration-driven timeout: a retry just re-hits the same wall
            !err.statusCode                                            // Network errors (no HTTP status)
            || RETRYABLE_STATUSES.has(err.statusCode));                // Retryable HTTP statuses

          if (!isTransient || attempt === AI_MAX_RETRIES) {
            throw err; // Permanent error or final attempt — give up
          }

          const delay = AI_BASE_DELAY_MS * Math.pow(2, attempt - 1);  // 2s, 4s, 8s
          logger.warn(`[ai] ${provider}/${model} — attempt ${attempt}/${AI_MAX_RETRIES} failed (${err.message}), retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      throw lastError; // Should not reach here, but safety net
    },
  };

  const browser = {
    fetch: async (url, options = {}) => {
      // Lazy import — Playwright only loaded when actually called
      const { browserFetch } = await import('../services/browserPool.js');
      return browserFetch(url, options);
    },
  };

  const unlocker = {
    fetch: async (url) => {
      // Bright Data Web Unlocker — bypasses Cloudflare/CAPTCHAs server-side
      const { webUnlockerFetch } = await import('../services/browserPool.js');
      return webUnlockerFetch(url);
    },
  };

  // Asset persistence seam (Unit #46). Modules never touch a backend — they call
  // tools.storage.put(bytes, {...}) and get back an opaque { asset_id, url }. The
  // Supabase Storage backend + stored_assets table live entirely behind this.
  const storage = createSupabaseStorage(db);

  return { logger, http, browser, unlocker, progress, ai, storage, _logs: logs, _partialItems: [], _aiCalls: aiCalls };
}

/**
 * Load execute function from a submodule's directory.
 * Supports both ESM (export default) and CommonJS (module.exports).
 */
async function loadExecuteFunction(manifest) {
  const modulePath = manifest._path;
  const executePath = path.join(modulePath, 'execute.js');

  // Use dynamic import (works for both ESM and CJS with file:// URL)
  const moduleUrl = pathToFileURL(executePath).href;
  const mod = await import(moduleUrl);

  // Support both: export default function, module.exports = function
  const fn = mod.default || mod;
  if (typeof fn !== 'function') {
    throw new Error(`execute.js in ${manifest.id} does not export a function`);
  }
  return fn;
}

/**
 * Log an execution metric. Non-blocking — failures are silently ignored.
 */
function logMetric({ run_id, submodule_id, entity_name, status, duration_ms, step_index, cost, error }) {
  db.from('pipeline_metrics')
    .insert({ run_id, submodule_id, entity_name, status, duration_ms, step_index, cost, error })
    .then(() => {})
    .catch(() => {}); // Table may not exist yet — fail silently
}

/**
 * Per-entity job handler.
 * Processes a single entity through a submodule's execute function.
 * Reads from / writes to entity_submodule_runs table.
 */
async function handleEntityJob(job) {
  const { entity_submodule_run_id, entity_name, submodule_id, step_index, batch_id } = job.data;

  console.log(`[worker:entity] Processing ${submodule_id} for "${entity_name}" (step ${step_index})`);

  // 1. Load entity_submodule_runs row
  const { data: entityRun, error: runErr } = await db
    .from('entity_submodule_runs')
    .select('*')
    .eq('id', entity_submodule_run_id)
    .single();

  if (runErr || !entityRun) {
    throw new Error(`entity_submodule_runs row not found: ${entity_submodule_run_id}`);
  }

  // 1b. Idempotency guard — skip if already completed (retry after partial write)
  if (entityRun.status === 'completed' || entityRun.status === 'approved') {
    console.log(`[worker:entity] Skipping ${submodule_id}/${entity_name} — already ${entityRun.status}`);
    return;
  }

  // 1c. Check if run was aborted before we start
  if (entityRun.status === 'failed' && entityRun.error === 'Aborted by user') {
    console.log(`[worker:entity] Skipping ${submodule_id}/${entity_name} — aborted by user`);
    return;
  }

  // 2. Look up manifest
  const manifest = getSubmoduleById(submodule_id);
  if (!manifest) {
    throw new Error(`Submodule not found in registry: ${submodule_id}`);
  }

  // 3. Mark as running + start timer
  const startTime = Date.now();
  await db
    .from('entity_submodule_runs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', entity_submodule_run_id);

  // 4. Load execute function
  const executeFn = await loadExecuteFunction(manifest);

  // 5. Build tools
  const tools = buildTools(entity_submodule_run_id, submodule_id);

  // 6. Timeout + abort polling
  const cost = manifest.cost || 'medium';
  const costConfig = COST_CONFIG[cost] || COST_CONFIG.medium;
  const timeout = costConfig.timeout;
  let timeoutTimer;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new Error(`Execution timed out after ${timeout / 1000}s`)), timeout);
  });

  // Abort polling: check Redis every 2s for entity-level abort signal.
  // When user aborts a single entity, the API sets this key. The reject
  // triggers the catch handler which saves _partialItems.
  let abortInterval;
  const abortPromise = new Promise((_, reject) => {
    abortInterval = setInterval(async () => {
      try {
        const aborted = await redis.get(`abort:entity:${entity_submodule_run_id}`);
        if (aborted) {
          await redis.del(`abort:entity:${entity_submodule_run_id}`);
          reject(new Error('Aborted by user'));
        }
      } catch { /* Redis errors should not crash the worker */ }
    }, 2000);
  });

  // 7. Prepare input — single entity format
  const input = entityRun.input_data;
  const options = { ...(manifest.options_defaults || {}), ...(entityRun.options || {}) };

  // 7a. Pre-process: convert .xlsx/.xls → .csv before csv-discovery runs
  if (submodule_id === 'csv-discovery') {
    for (const dirKey of ['source_dir', 'upload_dir']) {
      if (options[dirKey]) {
        const { converted, errors } = convertXlsxInDir(options[dirKey]);
        if (converted > 0) console.log(`[worker:entity] Converted ${converted} XLSX file(s) in ${options[dirKey]}`);
        if (errors.length > 0) console.warn(`[worker:entity] XLSX conversion errors: ${errors.join('; ')}`);
      }
    }
  }

  // 7b. Enrich: merge downloadable fields from upstream for this entity's items.
  //     Shared logic lives in server/services/poolHydration.js so stageWorker, the
  //     workbench, and offline reconstruction all run the same primary-key→cross-key
  //     cascade instead of re-copying it. excludeRunId keeps the current (running)
  //     row out of the upstream set — behavior-identical to the pre-extract filter.
  //     Mutates entityItems in place; the returned Set drives the 9b strip below.
  const entityItems = input?.entity?.items || [];
  const enrichedFields = await hydrateRequiresColumns({
    runId: entityRun.run_id,
    entityName: entity_name,
    stepIndex: step_index,
    items: entityItems,
    manifest,
    excludeRunId: entity_submodule_run_id,
    db,
  });

  // 7c. Hydrate pool blob refs — restore large fields that were extracted to pool_item_blobs
  if (entityItems.length > 0) {
    const hydratedCount = await hydrateItems(entityItems);
    if (hydratedCount > 0) {
      console.log(`[worker:entity] Hydrated ${hydratedCount} blob refs for "${entity_name}"`);
    }
  }

  // 8. Execute with timeout
  //    Compatibility shim: wrap single entity into legacy array format until
  //    execute.js files are migrated to single-entity input.
  //    Once migrated, the shim detects `input.entity` support and passes directly.
  const entityItemCount = input?.entity?.items?.length ?? 0;
  if (entityItemCount === 0) {
    console.warn(`[worker:entity] WARNING: "${entity_name}" has 0 input items for ${submodule_id} (step ${step_index}). Pool may be empty or items missing url field. Entity keys: ${Object.keys(input?.entity || {}).join(', ')}`);
  } else {
    console.log(`[worker:entity] "${entity_name}" has ${entityItemCount} input items for ${submodule_id}`);
  }

  const legacyInput = {
    ...input,
    entities: [input.entity],
  };

  let result;
  try {
    const rawResult = await Promise.race([executeFn(legacyInput, options, tools), timeoutPromise, abortPromise]);

    // Unwrap: legacy returns { results: [{ entity_name, items, ... }], summary }
    // Per-entity expects { items: [...], ... } for the single entity
    if (rawResult?.results && Array.isArray(rawResult.results)) {
      const entityResult = rawResult.results.find(r => r.entity_name === entity_name) || rawResult.results[0];
      result = entityResult || { items: [] };
    } else {
      result = rawResult;
    }
  } catch (err) {
    const inputItems = input?.entity?.items || [];
    const itemKeyField = manifest.item_key || 'url';
    const isTimeout = err.message?.includes('timed out');

    // If submodule pushed partial results via tools._partialItems, use those.
    // This saves successfully scraped pages even when the overall run times out.
    const partialItems = tools._partialItems || [];

    let outputItems;
    if (partialItems.length > 0) {
      // Use partial results + mark remaining items as timed_out
      const completedKeys = new Set(partialItems.map(i => String(i[itemKeyField] ?? '')));
      const remainingItems = inputItems
        .filter(item => !completedKeys.has(String(item[itemKeyField] ?? '')))
        .map(item => ({
          [itemKeyField]: item[itemKeyField] || 'unknown',
          status: isTimeout ? 'timed_out' : 'error',
          error: err.message,
          entity_name: entity_name,
          word_count: 0,
        }));
      outputItems = [...partialItems, ...remainingItems];
      console.log(`[worker:entity] ${submodule_id}/${entity_name}: saving ${partialItems.length} partial results + ${remainingItems.length} remaining as ${isTimeout ? 'timed_out' : 'error'}`);
    } else {
      // No partial results — build synthetic error items
      outputItems = inputItems.map(item => ({
        [itemKeyField]: item[itemKeyField] || 'unknown',
        status: 'error',
        error: `Execution failed: ${err.message}`,
        entity_name: entity_name,
        word_count: 0,
      }));
    }

    // Use 'completed' status if we have partial results (so they can be approved)
    const runStatus = partialItems.length > 0 ? 'completed' : 'failed';

    await db
      .from('entity_submodule_runs')
      .update({
        status: runStatus,
        error: err.message,
        output_data: outputItems.length > 0
          ? { items: outputItems, meta: { error: err.message, partial: partialItems.length > 0, completed_count: partialItems.length } }
          : null,
        output_render_schema: runStatus === 'completed' ? (manifest.output_schema || null) : undefined,
        logs: tools._logs,
        completed_at: new Date().toISOString(),
      })
      .eq('id', entity_submodule_run_id);

    // Update entity_stage_pool status
    await db
      .from('entity_stage_pool')
      .update({ status: runStatus, error: err.message, updated_at: new Date().toISOString() })
      .eq('run_id', entityRun.run_id)
      .eq('step_index', step_index)
      .eq('entity_name', entity_name);

    const duration_ms = Date.now() - startTime;
    const metricStatus = isTimeout ? 'timeout' : (partialItems.length > 0 ? 'partial' : 'failed');
    logMetric({ run_id: entityRun.run_id, submodule_id, entity_name, status: metricStatus, duration_ms, step_index, cost: manifest.cost || 'medium', error: err.message });

    // 8c (partial). Corpus Archive (U-C) — bank the pages we DID scrape before the timeout/abort.
    //     This is exactly the mid-fleet-death case the scrape-time archive exists for.
    try {
      await archiveEntityScrape({ db, items: partialItems, entityName: entity_name, runId: entityRun.run_id, scraper: submodule_id, requiresColumns: manifest.requires_columns });
    } catch (corpusErr) {
      console.error(`[corpus] banking FAILED (partial) for "${entity_name}" (run ${entityRun.run_id}, ${submodule_id}): ${corpusErr.message}`);
    }

    if (partialItems.length > 0) return; // Don't throw — partial success
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
    clearInterval(abortInterval);
  }

  // 8b. Capture out-of-vocabulary tag PROPOSALS (analysis_json.tags.suggested_new[])
  //     NOW — step 9 below strips analysis_json off result.items (content-analyzer
  //     declares it a downloadable_field), so read it before the strip. The write to
  //     the taxonomy_suggestions review queue happens just before the completed-status
  //     update (§12), gated on entityStatus==='completed'. Data-shape routing: [] for
  //     any output that doesn't carry the path (inert for non-analyzer submodules).
  const tagSuggestions = extractTagSuggestions(result);

  // 8c. Corpus Archive (U-C) — durably bank scraped page text BEFORE §9 strips text_content
  //     (scrapers declare it a downloadable_field, so §9 removes it from result.items).
  //     Additive + best-effort at the call site: LOUD internally, but a corpus failure must
  //     NEVER break the live pipeline. Data-shape routed — a no-op for any output without
  //     text_content, and OFF entirely unless CORPUS_ARCHIVE_BUCKET is set. requiresColumns
  //     gates out text REFINERS (boilerplate-stripper etc.) so cleaned text never overwrites raw.
  try {
    await archiveEntityScrape({ db, items: result?.items, entityName: entity_name, runId: entityRun.run_id, scraper: submodule_id, requiresColumns: manifest.requires_columns });
  } catch (corpusErr) {
    console.error(`[corpus] banking FAILED for "${entity_name}" (run ${entityRun.run_id}, ${submodule_id}): ${corpusErr.message}`);
  }

  // 9. Store downloadable fields (same logic, but for single entity result)
  const downloadFieldDefs = manifest.output_schema?.downloadable_fields || [];
  if (downloadFieldDefs.length > 0 && result?.items) {
    const downloadFieldNames = downloadFieldDefs.map((d) => d.field);
    const itemKeyField = manifest.item_key || 'url';
    const itemDataRows = [];

    for (const item of result.items) {
      const key = String(item[itemKeyField] ?? '');
      if (!key) continue;
      for (const field of downloadFieldNames) {
        const content = item[field];
        if (content != null) {
          const serialized = (typeof content === 'object')
            ? JSON.stringify(content)
            : String(content);
          if (serialized.length > 0) {
            itemDataRows.push({
              submodule_run_id: entity_submodule_run_id,
              item_key: key,
              field_name: field,
              content: serialized,
            });
          }
        }
      }
    }

    if (itemDataRows.length > 0) {
      const BATCH_SIZE = 500;
      let storedCount = 0;
      let insertFailed = false;
      for (let i = 0; i < itemDataRows.length; i += BATCH_SIZE) {
        const batch = itemDataRows.slice(i, i + BATCH_SIZE);
        const { error: itemErr } = await db
          .from('submodule_run_item_data')
          .insert(batch);
        if (itemErr) {
          console.warn(`[worker:entity] Failed to store item data batch for ${submodule_id}/${entity_name}: ${itemErr.message}`);
          insertFailed = true;
        } else {
          storedCount += batch.length;
        }
      }
      console.log(`[worker:entity] Stored ${storedCount}/${itemDataRows.length} downloadable field entries for ${submodule_id}/${entity_name}`);

      // Data is safely stored in submodule_run_item_data (above).
      // Strip downloadable fields from result so pool_items stays lean.
      // We intentionally do NOT use extractToBlob — _blob_ref + hydrateItems
      // restores content for ALL modules, defeating selective field loading
      // via requires_columns. Direct delete + enrichment = selective loading.
      if (!insertFailed) {
        for (const item of result.items) {
          for (const field of downloadFieldNames) {
            delete item[field];
          }
        }
        console.log(`[worker:entity] Stripped ${downloadFieldNames.join(', ')} from ${result.items.length} items for ${submodule_id}/${entity_name} (preserved in item_data)`);
      } else {
        console.warn(`[worker:entity] Keeping downloadable fields inline for ${submodule_id}/${entity_name} because item_data insert failed`);
      }
    }
  }

  // 9b. Strip enriched-but-not-produced fields from output.
  // Transform modules (e.g. intent-tagger) use { ...item, newField } which copies
  // enriched fields (like text_content) back into output, re-inflating pool_items.
  // Strip any enriched field that the module doesn't declare as its own output.
  if (enrichedFields.size > 0 && result?.items) {
    const outputFields = new Set(Object.keys(manifest.output_schema || {}));
    const moduleDownloadable = new Set((manifest.output_schema?.downloadable_fields || []).map(d => d.field));
    for (const item of result.items) {
      for (const field of enrichedFields) {
        // Keep if module declares it as its own output or as downloadable
        if (!outputFields.has(field) && !moduleDownloadable.has(field)) {
          delete item[field];
        }
      }
    }
  }

  // 10. Check if run was aborted while we were executing.
  //     If so, still save results — the work is done, don't throw it away.
  const { data: currentRun } = await db
    .from('entity_submodule_runs')
    .select('status')
    .eq('id', entity_submodule_run_id)
    .single();
  const wasAborted = currentRun?.status === 'failed';
  if (wasAborted) {
    console.log(`[worker:entity] ${submodule_id}/${entity_name} was aborted during execution — saving results anyway`);
  }

  // 11. Fail-closed on truncated LLM output + persist per-entity AI usage.
  //     If any ai.complete() call for this entity hit max_tokens, the output is
  //     amputated — stamp meta.status='error' so deriveEntityRunStatus marks it
  //     'failed' and the supersede gate preserves the prior round's content
  //     instead of letting a truncated retry evict it. Also folds token totals +
  //     stop reasons into meta.ai_usage for cost/truncation observability.
  applyAiCallMeta(result, tools._aiCalls);

  // 12. Write result to entity_submodule_runs
  //     Sanitize: PostgreSQL JSONB rejects \u0000 (null bytes) in text.
  //     Scraped HTML/content may contain them. Strip before writing.
  const sanitizedResult = JSON.parse(JSON.stringify(result).replace(/\\u0000/g, ''));
  // A module that RETURNS an error result (meta.status==='error') for this entity
  // — e.g. content-writer "fetch failed", seo-planner parse-fail — did NOT throw,
  // so without this it was written as 'completed', masking the failure and
  // starving the auto-executor failure-rate threshold. deriveEntityRunStatus
  // flags those as 'failed' while leaving valid QA verdicts (qa_pass:false) as
  // 'completed'. Output is still saved either way so the error item is visible.
  const { status: entityStatus, error: entityError } = deriveEntityRunStatus(result);
  if (entityStatus === 'failed') {
    console.warn(`[worker:entity] ${submodule_id}/${entity_name} returned an ERROR result (not thrown) — marking failed: ${entityError}`);
  }

  // Route out-of-vocabulary tag proposals to the taxonomy_suggestions review queue
  // BEFORE the completed-status write below. Order is deliberate: a DB failure throws
  // → the job retries → the entity is still 'running' (the §12 completed write hasn't
  // happened) → the idempotency skip guard doesn't fire → clean re-run. Writing after
  // completion would let a retry skip and silently drop proposals.
  if (entityStatus === 'completed' && tagSuggestions.length > 0) {
    const written = await writeTaxonomySuggestions({ db, runId: entityRun.run_id, entityName: entity_name, suggestions: tagSuggestions });
    console.log(`[worker:entity] ${submodule_id}/${entity_name}: routed ${written} taxonomy suggestion(s) to review queue`);
  }

  const { error: writeErr } = await db
    .from('entity_submodule_runs')
    .update({
      status: entityStatus,
      ...(entityError ? { error: entityError } : {}),
      output_data: sanitizedResult,
      output_render_schema: manifest.output_schema || null,
      logs: tools._logs,
      progress: { current: tools.progress.lastTotal, total: tools.progress.lastTotal, message: entityStatus === 'failed' ? 'Failed' : 'Done' },
      completed_at: new Date().toISOString(),
    })
    .eq('id', entity_submodule_run_id);

  if (writeErr) {
    console.error(`[worker:entity] Output write failed for ${submodule_id}/${entity_name}: ${writeErr.message}`);
    await db
      .from('entity_submodule_runs')
      .update({ status: 'failed', error: `Output write failed: ${writeErr.message}`, logs: tools._logs, completed_at: new Date().toISOString() })
      .eq('id', entity_submodule_run_id);
    throw writeErr;
  }

  // 11. Mirror the run status into entity_stage_pool. batchWorker derives
  //      pipeline_stages.completed_count/failed_count from the POOL status, so a
  //      returned-error entity must be 'failed' here too — otherwise the headline
  //      "N completed, 0 failed" count keeps masking the failure even though the
  //      run row is 'failed'. (The throw-path already mirrors run status to the
  //      pool; this makes the return-path consistent.)
  await db
    .from('entity_stage_pool')
    .update({ status: entityStatus, updated_at: new Date().toISOString() })
    .eq('run_id', entityRun.run_id)
    .eq('step_index', step_index)
    .eq('entity_name', entity_name);

  // F-D (VALIDATION_E2E_RUN1): input-side truncation must be queryable after the
  // fact. When the module declares on its result meta that its assembled input was
  // cut (content_truncated — the module-agnostic B029 contract), lift it into a
  // first-class decision_log row. Run 9821ed56 delivered 61%/79% of two corpora
  // and the only trace was 3 levels deep in output_data JSONB. Non-fatal by
  // contract: the record is observability — a failed insert must never fail a
  // completed entity ({error} checked + logged, §5).
  const inputTruncation = extractInputTruncation(result);
  if (inputTruncation) {
    console.warn(
      `[worker:entity] ${submodule_id}/${entity_name}: INPUT TRUNCATED — ` +
      `${inputTruncation.content_chars_kept ?? '?'} of ${inputTruncation.content_chars_total ?? '?'} assembled chars delivered`
    );
    const { error: truncErr } = await db.from('decision_log').insert(
      buildInputTruncationLogRow({
        runId: entityRun.run_id, stepIndex: step_index,
        submoduleId: submodule_id, entityName: entity_name,
        truncation: inputTruncation,
      })
    );
    if (truncErr) {
      console.error(`[worker:entity] FAILED to record input truncation for ${submodule_id}/${entity_name}: ${truncErr.message}`);
    }
  }

  const duration_ms = Date.now() - startTime;
  console.log(`[worker:entity] ${entityStatus === 'failed' ? 'FAILED' : 'Completed'}: ${submodule_id} for "${entity_name}" (${(duration_ms / 1000).toFixed(1)}s)`);
  logMetric({ run_id: entityRun.run_id, submodule_id, entity_name, status: entityStatus, duration_ms, step_index, cost: manifest.cost || 'medium' });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2B — step-6 detector batch executor (execution_mode:batch).
//
// One BullMQ job (`entity-batch-llm`) handles the WHOLE step across all entities: it
// collects every entity's LLM calls into two Anthropic Message Batches (round 1
// extractions, round 2 verifications — verification needs the extracted claims), polls
// them to completion (up to ~24h), hands the responses back to the module's pure
// prepare/parse entry points, and persists each entity's result exactly as the sync path
// does. The parent `batch-complete` job (batchWorker) then finalizes counts — any entity
// row this job did NOT write (e.g. it threw) is zombie-swept to `failed` there (loud).
//
// The synchronous handleEntityJob path is UNTOUCHED; batch mode is a separate job name.
// ─────────────────────────────────────────────────────────────────────────────

// A console-backed logger the pure module fns log through during a batch.
function makeBatchLogger(prefix) {
  const mk = (level) => (...args) => console.log(`[worker:batch:${level}] ${prefix} ${args.join(' ')}`);
  return { info: mk('info'), warn: mk('warn'), error: mk('error') };
}

// Submit (or re-attach to) an Anthropic batch for one round, store the id on
// submodule_runs.provider_batch_id, poll to completion, and return the results Map.
// Re-attach (idempotency guard, #6) closes the poll-phase-restart double-submit: if
// provider_batch_id is already set, poll+fetch that batch and — CRITICALLY — only reuse it
// when its custom_ids actually match THIS round's (the two rounds overwrite the same column,
// so a cross-round restart could otherwise point round 1 at round 2's batch). A custom_id
// mismatch (wrong round, or a stale id) → discard and submit fresh. The suffix namespacing
// (__x0 / __v{b}) plus this membership check means a re-attach can never feed one round's
// results to another (which for extraction would silently downgrade to the regex fallback).
async function submitOrReattachBatch(submoduleRunId, requests, apiKey, deadlineMs, logger, roundLabel) {
  const wantIds = new Set(requests.map(r => r.custom_id));
  const { data: srRow } = await db.from('submodule_runs').select('provider_batch_id').eq('id', submoduleRunId).maybeSingle();
  const existing = srRow?.provider_batch_id;
  if (existing) {
    try {
      const probe = await getAnthropicBatch(existing, apiKey);
      const rc = probe?.request_counts || {};
      const totalInBatch = (rc.processing || 0) + (rc.succeeded || 0) + (rc.errored || 0) + (rc.expired || 0) + (rc.canceled || 0);
      if (totalInBatch === requests.length) {
        const ended = await pollAnthropicBatch(existing, apiKey, { deadlineMs });
        const map = await fetchAnthropicBatchResults(ended.results_url, apiKey);
        if ([...map.keys()].some(k => wantIds.has(k))) {
          logger.info(`re-attached to Anthropic batch ${existing} (${roundLabel})`);
          return map;
        }
        logger.warn(`stored provider_batch_id ${existing} is NOT this round's batch (custom_id mismatch) — submitting fresh (${roundLabel})`);
      }
    } catch (err) { logger.warn(`re-attach probe failed (${err.message}) — submitting fresh (${roundLabel})`); }
  }
  const submitted = await submitAnthropicBatch(requests, apiKey);
  const batchId = submitted.id;
  const { error: upErr } = await db.from('submodule_runs').update({ provider_batch_id: batchId }).eq('id', submoduleRunId);
  if (upErr) logger.warn(`could not persist provider_batch_id ${batchId}: ${upErr.message}`);
  logger.info(`submitted Anthropic batch ${batchId} (${roundLabel}, ${requests.length} requests)`);
  const ended = await pollAnthropicBatch(batchId, apiKey, { deadlineMs });
  logger.info(`batch ${batchId} ended (${roundLabel}): ${JSON.stringify(ended.request_counts || {})}`);
  return fetchAnthropicBatchResults(ended.results_url, apiKey);
}

// Persist one entity's batch result. Mirrors the synchronous persist spine
// (stageWorker.js handleEntityJob §11-§12: applyAiCallMeta → deriveEntityRunStatus →
// sanitize → write entity_submodule_runs → mirror entity_stage_pool). Deliberately does
// NOT run the taxonomy-suggestion routing or downloadable-field strip — the detector
// emits neither (no downloadable_fields, no suggested_new). ponytail: kept as a small dup
// (reusing the shared applyAiCallMeta + deriveEntityRunStatus utils) so the universal sync
// handleEntityJob stays 100% untouched; if the sync spine changes, mirror it here.
async function persistBatchEntityResult({ row, result, aiCalls, manifest, stepIndex }) {
  applyAiCallMeta(result, aiCalls);
  const sanitizedResult = JSON.parse(JSON.stringify(result).replace(/\\u0000/g, ''));
  const { status: entityStatus, error: entityError } = deriveEntityRunStatus(result);
  if (entityStatus === 'failed') {
    console.warn(`[worker:batch] ${manifest.id}/${row.entity_name} returned an ERROR result — marking failed: ${entityError}`);
  }

  const { error: writeErr } = await db
    .from('entity_submodule_runs')
    .update({
      status: entityStatus,
      ...(entityError ? { error: entityError } : {}),
      output_data: sanitizedResult,
      output_render_schema: manifest.output_schema || null,
      logs: [],
      progress: { current: 1, total: 1, message: entityStatus === 'failed' ? 'Failed' : 'Done' },
      completed_at: new Date().toISOString(),
    })
    .eq('id', row.id);

  if (writeErr) {
    console.error(`[worker:batch] Output write failed for ${manifest.id}/${row.entity_name}: ${writeErr.message}`);
    await db.from('entity_submodule_runs')
      .update({ status: 'failed', error: `Output write failed: ${writeErr.message}`, completed_at: new Date().toISOString() })
      .eq('id', row.id);
    throw writeErr;
  }

  await db.from('entity_stage_pool')
    .update({ status: entityStatus, updated_at: new Date().toISOString() })
    .eq('run_id', row.run_id)
    .eq('step_index', stepIndex)
    .eq('entity_name', row.entity_name);

  // F-D mirror of the sync spine (see handleEntityJob §12): lift a module-declared
  // input truncation into decision_log. The detector emits no truncation meta today,
  // so this is a no-op for batch mode — kept in lockstep per this function's
  // mirror-the-spine contract.
  const inputTruncation = extractInputTruncation(result);
  if (inputTruncation) {
    console.warn(
      `[worker:batch] ${manifest.id}/${row.entity_name}: INPUT TRUNCATED — ` +
      `${inputTruncation.content_chars_kept ?? '?'} of ${inputTruncation.content_chars_total ?? '?'} assembled chars delivered`
    );
    const { error: truncErr } = await db.from('decision_log').insert(
      buildInputTruncationLogRow({
        runId: row.run_id, stepIndex,
        submoduleId: manifest.id, entityName: row.entity_name,
        truncation: inputTruncation,
      })
    );
    if (truncErr) {
      console.error(`[worker:batch] FAILED to record input truncation for ${manifest.id}/${row.entity_name}: ${truncErr.message}`);
    }
  }
}

async function handleDetectorBatchJob(job) {
  const { batch_id, submodule_run_id, submodule_id, step_index } = job.data;
  const startTime = Date.now();
  const logger = makeBatchLogger(`${submodule_id}/${batch_id}`);
  console.log(`[worker:batch] START detector batch ${batch_id} (${submodule_id}, step ${step_index})`);

  const manifest = getSubmoduleById(submodule_id);
  if (!manifest) throw new Error(`Submodule not found in registry: ${submodule_id}`);
  const executeFn = await loadExecuteFunction(manifest);

  // The module MUST expose the batch entry points. Nothing else does, so a mis-set
  // execution_mode:batch fails the whole batch loudly rather than silently degrading.
  if (typeof executeFn.prepareExtractionRequests !== 'function'
    || typeof executeFn.prepareVerificationRequests !== 'function'
    || typeof executeFn.parseResults !== 'function') {
    const msg = `${submodule_id} does not expose the batch entry points — execution_mode:batch unsupported for this submodule`;
    console.error(`[worker:batch] ${msg}`);
    await db.from('entity_submodule_runs')
      .update({ status: 'failed', error: msg, completed_at: new Date().toISOString() })
      .eq('batch_id', batch_id).in('status', ['pending', 'running']);
    return;
  }

  // Load entity rows; process only the not-yet-final ones (idempotency on a re-run).
  const { data: allRows, error: rowsErr } = await db
    .from('entity_submodule_runs').select('*').eq('batch_id', batch_id);
  if (rowsErr) throw rowsErr;
  const rows = (allRows || []).filter(r => r.status === 'pending' || r.status === 'running');
  if (rows.length === 0) {
    console.log(`[worker:batch] batch ${batch_id}: no pending entity rows — nothing to do`);
    return;
  }

  await db.from('entity_submodule_runs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .in('id', rows.map(r => r.id)).eq('status', 'pending');

  // Build hydrated entities in row order (same enrich+blob hydration as handleEntityJob).
  const entities = [];
  for (const row of rows) {
    const input = row.input_data || {};
    const entity = input.entity || { name: row.entity_name, items: [] };
    const items = entity.items || [];
    await hydrateRequiresColumns({ runId: row.run_id, entityName: row.entity_name, stepIndex: step_index, items, manifest, excludeRunId: row.id, db });
    if (items.length > 0) await hydrateItems(items);
    entities.push(entity);
  }
  // Options are submodule-level (a template preset for the detector), so every entity in
  // the step shares them; take the first row's, merged over manifest defaults.
  const options = { ...(manifest.options_defaults || {}), ...(rows[0].options || {}) };
  const apiKey = await resolveApiKey('anthropic', db);
  if (!apiKey) throw new Error(`No Anthropic API key for batch execution — set ${PROVIDERS.anthropic?.envVar ?? 'ANTHROPIC_API_KEY'}`);

  const tools = { logger };
  const deadlineMs = Date.now() + BATCH_POLL_MAX_MS;
  const aiCallsByEntity = rows.map(() => []);
  const cid = (entityIdx, suffix) => `${rows[entityIdx].id}__${suffix}`;

  // ── ROUND 1: extractions (empty in regex mode) ──
  const { state, extractionRequests } = executeFn.prepareExtractionRequests(entities, options, tools);
  const extractionByEntityIdx = [];
  if (extractionRequests.length > 0) {
    const reqs = extractionRequests.map(r => ({ custom_id: cid(r.entityIdx, 'x0'), params: buildBatchRequestParams(r.args) }));
    const resultsMap = await submitOrReattachBatch(submodule_run_id, reqs, apiKey, deadlineMs, logger, 'extract');
    for (const r of extractionRequests) {
      const norm = resultsMap.get(cid(r.entityIdx, 'x0')) || { ok: false, error: 'missing_batch_result' };
      extractionByEntityIdx[r.entityIdx] = norm.ok ? { ok: true, text: norm.text } : { ok: false, error: norm.error };
      if (norm.ok) aiCallsByEntity[r.entityIdx].push(batchLedgerEntry(norm));
    }
  }

  // ── ROUND 2: verifications ──
  const { verificationRequests } = executeFn.prepareVerificationRequests(entities, options, state, extractionByEntityIdx, tools);
  const verificationByEntityIdx = [];
  if (verificationRequests.length > 0) {
    const reqs = verificationRequests.map(r => ({ custom_id: cid(r.entityIdx, `v${r.batchIdx}`), params: buildBatchRequestParams(r.args) }));
    const resultsMap = await submitOrReattachBatch(submodule_run_id, reqs, apiKey, deadlineMs, logger, 'verify');
    for (const r of verificationRequests) {
      const norm = resultsMap.get(cid(r.entityIdx, `v${r.batchIdx}`)) || { ok: false, error: 'missing_batch_result' };
      (verificationByEntityIdx[r.entityIdx] ||= [])[r.batchIdx] = norm.ok ? { ok: true, text: norm.text } : { ok: false, error: norm.error };
      if (norm.ok) aiCallsByEntity[r.entityIdx].push(batchLedgerEntry(norm));
    }
  }

  // ── PARSE (reuses the same stages as sync → byte-identical verdicts) ──
  const { results } = executeFn.parseResults(entities, options, state, verificationByEntityIdx, tools);

  // ── PERSIST each entity (batchWorker finalizes submodule_runs + pipeline_stages) ──
  for (let i = 0; i < rows.length; i++) {
    await persistBatchEntityResult({ row: rows[i], result: results[i] || { items: [], meta: { status: 'error', error: 'no_result' } }, aiCalls: aiCallsByEntity[i], manifest, stepIndex: step_index });
  }

  const failed = results.filter(r => r?.meta?.status === 'error').length;
  console.log(`[worker:batch] DONE detector batch ${batch_id}: ${rows.length} entities (${failed} failed) in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

// Create the worker — per-entity + the Phase 2B step-6 batch job (dispatched by name)
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '2', 10);

const worker = new Worker(
  'pipeline-stages-v2',
  async (job) => {
    if (job.name === 'entity-batch-llm') return handleDetectorBatchJob(job);
    return handleEntityJob(job);
  },
  {
    connection: redis,
    concurrency: WORKER_CONCURRENCY,
    stalledInterval: 60000,
    maxStalledCount: 2,        // Mark job as failed after 2 stall detections
    lockDuration: 120000,      // 2 min lock — prevents premature stall detection for slow jobs
  }
);

worker.on('failed', (job, err) => {
  console.error(`[worker] Job ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts?.attempts}): ${err.message}`);
});

worker.on('stalled', (jobId) => {
  console.warn(`[worker] Job ${jobId} stalled — worker may have crashed or lost connection`);
});

worker.on('error', (err) => {
  console.error(`[worker] Worker error: ${err.message}`);
});

worker.on('ready', () => {
  console.log(`[worker] Pipeline stage worker ready (concurrency: ${WORKER_CONCURRENCY})`);
  logCorpusArchiveStatus(); // loud boot signal: corpus archive on/off
});

// Graceful shutdown — close worker and browser on SIGTERM/SIGINT
async function shutdown() {
  console.log('[worker] Shutting down...');
  try {
    const { closeBrowser } = await import('../services/browserPool.js');
    await closeBrowser();
  } catch (_) { /* browser may not have been loaded */ }
  await worker.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default worker;
