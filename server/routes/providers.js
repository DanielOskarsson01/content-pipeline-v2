/**
 * /api/providers — model-picker availability + settings key management (BACKLOG #49).
 *
 * GET  /api/providers            → per provider: configured?, key source (env/db),
 *                                  last-4, models with prices, and the unavailable
 *                                  reason. The single source the picker renders;
 *                                  kills the openai footgun (selectable-but-keyless).
 * POST /api/providers/:id/key    → store a DB key for a provider (Unit 7). Body
 *                                  { api_key }. Never echoes the value back.
 * DELETE /api/providers/:id/key  → remove the DB key.
 *
 * db-injected factory (like the workbench router) so the key store is testable and
 * this file never imports db.js.
 */
import { Router } from 'express';
import { PROVIDERS } from '../config/llmRegistry.js';
import { providerKeyStatus, invalidateApiKeyCache } from '../services/apiKeys.js';

export function createProvidersRouter({ db } = {}) {
  const router = Router();

  router.get('/', async (_req, res) => {
    // env OR DB key (Unit 7) — the seam Unit 3 left env-only.
    const status = await providerKeyStatus(db);
    const providers = Object.values(PROVIDERS).map((p) => {
      const s = status[p.id] || { configured: false, source: null, last4: null };
      return {
        id: p.id,
        displayName: p.displayName,
        configured: s.configured,
        source: s.source,          // 'env' | 'db' | null — where the active key comes from
        last4: s.last4,            // last-4 of the active key, never the value
        reason: s.configured ? null : `No API key configured (${p.envVar} not set, and no key saved in settings)`,
        models: Object.entries(p.models).map(([key, m]) => ({
          key, id: m.id, displayName: m.displayName, input: m.input, output: m.output, alias: Boolean(m.alias),
        })),
      };
    });
    res.json({ providers });
  });

  // ── Unit 7: store / remove a DB-stored key. Never returns the value. ──
  router.post('/:id/key', async (req, res) => {
    const { id } = req.params;
    if (!PROVIDERS[id]) return res.status(400).json({ error: `Unknown provider "${id}"` });
    const apiKey = req.body?.api_key;
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      return res.status(400).json({ error: 'api_key must be a non-empty string' });
    }
    if (!db) return res.status(503).json({ error: 'key store unavailable' });
    const { error } = await db
      .from('provider_api_keys')
      .upsert({ provider: id, api_key: apiKey.trim(), updated_at: new Date().toISOString() }, { onConflict: 'provider' });
    if (error) return res.status(500).json({ error: error.message });
    invalidateApiKeyCache();
    const status = await providerKeyStatus(db);
    // presence / source / last-4 only — never the value
    return res.json({ provider: id, ...status[id] });
  });

  router.delete('/:id/key', async (req, res) => {
    const { id } = req.params;
    if (!PROVIDERS[id]) return res.status(400).json({ error: `Unknown provider "${id}"` });
    if (!db) return res.status(503).json({ error: 'key store unavailable' });
    const { error } = await db.from('provider_api_keys').delete().eq('provider', id);
    if (error) return res.status(500).json({ error: error.message });
    invalidateApiKeyCache();
    const status = await providerKeyStatus(db);
    return res.json({ provider: id, ...status[id] });
  });

  return router;
}

export default createProvidersRouter;
