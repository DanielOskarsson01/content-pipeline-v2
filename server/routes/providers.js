/**
 * GET /api/providers — model-picker availability (BACKLOG #49).
 *
 * The single source the picker renders. Per provider: is it configured (does the
 * box have its key), its models with prices, and — when unavailable — the reason.
 * This kills the current footgun: openai is selectable in the dropdown but has no
 * key on the box, so choosing it 500s mid-run. Here it comes back configured:false
 * with a reason, so the picker can grey it out instead of offering a broken choice.
 *
 * Pure + read-only: imports only the registry (no db.js — safe to mount in a
 * hermetic harness without the SUPABASE env guard tripping).
 */
import { Router } from 'express';
import { PROVIDERS } from '../config/llmRegistry.js';

const router = Router();

// Is this provider usable right now? Unit 3 = env-only (mirrors exactly what the
// two ai.complete copies check today: process.env[KEY]). Unit 7 extends this seam
// to "env OR a DB-stored key" — the ONE place that computation should live.
function providerConfigured(provider) {
  return Boolean(process.env[provider.envVar]);
}

router.get('/', (_req, res) => {
  const providers = Object.values(PROVIDERS).map((p) => {
    const configured = providerConfigured(p);
    return {
      id: p.id,
      displayName: p.displayName,
      configured,
      reason: configured ? null : `No API key configured (${p.envVar} not set)`,
      models: Object.entries(p.models).map(([key, m]) => ({
        key,                 // dropdown value the picker sends back as ai_model
        id: m.id,            // resolved API id
        displayName: m.displayName,
        input: m.input,      // $ per Mtok — shown at the point of choice
        output: m.output,
        alias: Boolean(m.alias), // '-latest' → model + price can shift
      })),
    };
  });
  res.json({ providers });
});

export default router;
