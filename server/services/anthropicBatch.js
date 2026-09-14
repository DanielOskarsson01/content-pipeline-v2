/**
 * Anthropic Message Batches helpers (Phase 2B).
 *
 * Pure-ish transport layer for the step-6 hallucination-detector batch path: build a
 * batch request body from the module's ai.complete-shaped args, submit a batch, poll it
 * to completion (24h-tolerant), and parse the JSONL results by custom_id. Deliberately
 * imports NOTHING from the BullMQ worker (so it is unit-testable in isolation).
 *
 * A batch is billed at 50% of standard, returns asynchronously (typically <1h, ceiling
 * 24h), and does NOT support `stream` — which is exactly right for an async batch (there
 * is no HTTP socket to keep alive). Results are keyed by custom_id and each request's
 * success/error/expired is independent.
 */

import { resolveModel } from '../config/llmRegistry.js';
import { buildCachedUserContent } from './promptCache.js';

const BATCH_URL = 'https://api.anthropic.com/v1/messages/batches';
const ANTHROPIC_HEADERS = (apiKey) => ({
  'Content-Type': 'application/json',
  'x-api-key': apiKey,
  'anthropic-version': '2023-06-01',
});
// Mirror stageWorker.js's transient-retry set for the batch's OWN HTTP calls
// (submit/poll/fetch). A single 529 must not nuke the whole batch.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);

/**
 * Build the `params` object for ONE batch request from the module's ai.complete args
 * ({prompt, cache_prefix, model, provider, max_tokens}). Mirrors the synchronous
 * anthropic body in stageWorker.js (resolveModel + `max_tokens ?? 16384` + the
 * cache_control split), MINUS `stream` (unsupported in batch). `model` is REQUIRED (no
 * default): the caller always supplies the resolved option, and a silent default here
 * would be free to diverge from ai.complete's own default — so an absent model throws
 * loudly via resolveModel rather than picking a different tier than the sync path would.
 */
export function buildBatchRequestParams({ prompt, cache_prefix, model, provider = 'anthropic', max_tokens }) {
  return {
    model: resolveModel(provider, model),
    max_tokens: max_tokens ?? 16384,
    messages: [{ role: 'user', content: buildCachedUserContent(prompt, cache_prefix) }],
  };
}

async function fetchWithRetry(url, opts, { retries = 3, label = 'anthropic-batch', sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.status >= 200 && res.status < 300) return res;
      const body = await res.text();
      const err = new Error(`${label} HTTP ${res.status}: ${body.slice(0, 500)}`);
      err.statusCode = res.status;
      if (!RETRYABLE_STATUSES.has(res.status) || attempt === retries) throw err;
      lastErr = err;
    } catch (err) {
      lastErr = err;
      // A permanent HTTP error (already thrown above with a non-retryable status) rethrows;
      // a network error (no statusCode) is transient and retried.
      if (err.statusCode && !RETRYABLE_STATUSES.has(err.statusCode)) throw err;
      if (attempt === retries) throw err;
    }
    await sleep(2000 * attempt);
  }
  throw lastErr;
}

/** POST a batch of {custom_id, params} requests. Returns the created batch object ({id, processing_status, ...}). */
export async function submitAnthropicBatch(requests, apiKey, deps = {}) {
  const res = await fetchWithRetry(BATCH_URL, {
    method: 'POST',
    headers: ANTHROPIC_HEADERS(apiKey),
    body: JSON.stringify({ requests }),
  }, { label: 'batch-submit', ...deps });
  return res.json();
}

/** GET a batch's current state ({processing_status, results_url, request_counts, ...}). */
export async function getAnthropicBatch(batchId, apiKey, deps = {}) {
  const res = await fetchWithRetry(`${BATCH_URL}/${encodeURIComponent(batchId)}`, {
    method: 'GET',
    headers: ANTHROPIC_HEADERS(apiKey),
  }, { label: 'batch-get', ...deps });
  return res.json();
}

/**
 * Poll a batch until processing_status === 'ended' or the deadline passes. Returns the
 * ended batch object (carries results_url). Throws (batchTimeout) past the deadline.
 * `sleep`/`now`/`getBatch` are injectable for deterministic tests.
 */
export async function pollAnthropicBatch(batchId, apiKey, {
  deadlineMs,
  intervalMs = 10000,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  now = () => Date.now(),
  getBatch = getAnthropicBatch,
} = {}) {
  for (;;) {
    const b = await getBatch(batchId, apiKey);
    if (b && b.processing_status === 'ended') return b;
    if (typeof deadlineMs === 'number' && now() >= deadlineMs) {
      const e = new Error(`Anthropic batch ${batchId} did not end before the deadline (status: ${b?.processing_status})`);
      e.batchTimeout = true;
      throw e;
    }
    await sleep(intervalMs);
  }
}

/** GET + parse the JSONL results at results_url into a Map custom_id -> normalized result. */
export async function fetchAnthropicBatchResults(resultsUrl, apiKey, deps = {}) {
  const res = await fetchWithRetry(resultsUrl, {
    method: 'GET',
    headers: ANTHROPIC_HEADERS(apiKey),
  }, { label: 'batch-results', ...deps });
  return parseBatchResultsJsonl(await res.text());
}

/** Pure: parse the batch results JSONL into Map custom_id -> normalizeBatchResult(result). */
export function parseBatchResultsJsonl(jsonl) {
  const map = new Map();
  for (const line of String(jsonl || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let row;
    try { row = JSON.parse(t); } catch { continue; }
    if (!row || !row.custom_id || !row.result) continue;
    map.set(row.custom_id, normalizeBatchResult(row.result));
  }
  return map;
}

/**
 * Pure: normalize one batch result. `succeeded` -> {ok:true, text, model, stop_reason,
 * service_tier, usage}; `errored`/`expired`/`canceled` -> {ok:false, error}. The caller
 * turns {ok:false} into a LOUD entity failure (never a silent pass).
 */
export function normalizeBatchResult(result) {
  if (result && result.type === 'succeeded' && result.message) {
    const msg = result.message;
    const text = Array.isArray(msg.content)
      ? msg.content.filter(b => b && b.type === 'text').map(b => b.text).join('')
      : '';
    const u = msg.usage || {};
    return {
      ok: true,
      text,
      model: msg.model ?? null,
      stop_reason: msg.stop_reason ?? null,
      service_tier: u.service_tier ?? null,
      usage: {
        tokens_in: u.input_tokens ?? 0,
        tokens_out: u.output_tokens ?? 0,
        cache_write_tokens: u.cache_creation_input_tokens ?? 0,
        cache_read_tokens: u.cache_read_input_tokens ?? 0,
      },
    };
  }
  const errType = (result && result.type) || 'errored';
  const errMsg =
    result?.error?.error?.message ||
    result?.error?.message ||
    result?.error?.type ||
    errType;
  return { ok: false, error: `${errType}: ${errMsg}` };
}

/**
 * Build an aiCalls-ledger entry (the shape stageWorker pushes into tools._aiCalls) from a
 * normalized SUCCEEDED batch result, so applyAiCallMeta's truncation (stop_reason) and
 * refused/empty (empty_completion) fail-closed guards fire in batch exactly as in sync.
 * service_tier rides along for logging (applyAiCallMeta ignores it — the ai_usage schema
 * has no service_tier field, so batch cost telemetry records the full registry rate; the
 * 50% saving is computed manually in the validation report).
 */
export function batchLedgerEntry(norm) {
  return {
    provider: 'anthropic',
    model: norm.model,
    tokens_in: norm.usage.tokens_in,
    tokens_out: norm.usage.tokens_out,
    tokens_total: 0,
    cache_write_tokens: norm.usage.cache_write_tokens,
    cache_read_tokens: norm.usage.cache_read_tokens,
    provider_cost: null,
    stop_reason: norm.stop_reason,
    empty_completion: !norm.text || norm.text.trim() === '',
    finish_reason: norm.stop_reason,
    service_tier: norm.service_tier,
  };
}
