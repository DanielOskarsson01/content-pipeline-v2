/**
 * Provider API-key resolution (BACKLOG #49, Unit 7).
 *
 * Lets a key pasted in the settings UI reach an ALREADY-RUNNING worker without a
 * redeploy. Running processes load .env once at boot; the adapters instead call
 * resolveApiKey() PER ai.complete call, which consults this resolver.
 *
 * RESOLUTION ORDER — .env WINS, DB fills the gap:
 *   - a provider that has an .env key resolves from process.env every time — no DB
 *     read on the hot path, and .env keys can NEVER regress (regression is
 *     impossible by construction);
 *   - a provider with NO .env key (e.g. openai) resolves from the DB-stored key.
 *
 * PROPAGATION: DB keys are cached for TTL_MS. A pasted/deleted key takes effect
 * within one TTL (≤60s) across the running worker + api processes — no restart.
 * Cache writes are also invalidated eagerly by the POST/DELETE key endpoints in
 * the same process (the other processes catch up within the TTL).
 *
 * FAIL-SAFE: a DB error (incl. the table not existing yet — the migration is
 * Daniel's gated apply) is swallowed; the resolver returns whatever .env / last
 * cache holds. An absent table therefore never 500s an LLM call.
 *
 * This module is db-injected (never imports db.js — keeps it hermetically
 * testable and avoids the load-time SUPABASE env guard).
 */
import { PROVIDERS } from '../config/llmRegistry.js';

const TTL_MS = 60_000;
let cache = { at: -Infinity, keys: {} };

/** Test seam: reset the module cache between cases. */
export function _resetApiKeyCache() { cache = { at: -Infinity, keys: {} }; }

/** Load DB-stored keys, cached for TTL_MS. Select-only. Never throws. */
async function loadDbKeys(db, now) {
  if (now - cache.at < TTL_MS) return cache.keys;
  try {
    const { data, error } = await db.from('provider_api_keys').select('provider, api_key');
    if (error) throw error;
    cache = { at: now, keys: Object.fromEntries((data || []).map((r) => [r.provider, r.api_key])) };
  } catch {
    // Table missing / transient DB error → keep serving the last cache (or {}),
    // and don't re-hammer the DB for this whole TTL. .env keys are unaffected.
    cache = { at: now, keys: cache.keys };
  }
  return cache.keys;
}

/** Force the next resolve to re-read the DB (called after a key write/delete). */
export function invalidateApiKeyCache() { cache = { at: -Infinity, keys: cache.keys }; }

/**
 * Resolve the API key for a provider. .env precedence; DB fallback for keyless
 * providers. Returns undefined if neither has a key.
 * @param {string} provider  registry provider id
 * @param {object} [db]      injected Supabase client (READ). Omit → env-only.
 */
export async function resolveApiKey(provider, db, now = Date.now()) {
  const p = PROVIDERS[provider];
  if (!p) return undefined;
  const envKey = process.env[p.envVar];
  if (envKey) return envKey;            // .env wins — hot path, no DB read
  if (!db) return undefined;            // no db (e.g. CLI harness) → env-only
  const dbKeys = await loadDbKeys(db, now);
  return dbKeys[provider];
}

/**
 * Per-provider key status for the availability endpoint + settings UI.
 * Returns { [providerId]: { configured, source: 'env'|'db'|null, last4 } }.
 * NEVER returns the key value — presence, source, and last-4 only.
 */
export async function providerKeyStatus(db, now = Date.now()) {
  const dbKeys = db ? await loadDbKeys(db, now) : {};
  const out = {};
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const envKey = process.env[p.envVar];
    const dbKey = dbKeys[id];
    const key = envKey || dbKey;
    out[id] = {
      configured: Boolean(key),
      source: envKey ? 'env' : (dbKey ? 'db' : null),
      last4: key ? String(key).slice(-4) : null,
    };
  }
  return out;
}
