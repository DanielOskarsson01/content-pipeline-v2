-- BACKLOG #49 — DB-stored provider API keys (Unit 7).
--
-- Lets a key pasted in the settings UI reach an already-running worker without a
-- redeploy: the adapters read keys per-call via resolveApiKey (server/services/
-- apiKeys.js), which consults this table (60s cache). .env keys take precedence,
-- so this table only fills the gap for providers that have NO .env key.
--
-- ⚠️ SECURITY: api_key is stored PLAINTEXT — the SAME trust level as the .env file
--    that already holds these keys on the box, but with additional exposure via DB
--    backups/replication. Access is service_role-only (RLS enabled, NO policies →
--    anon/authenticated are denied; the app connects as service_role which bypasses
--    RLS). The API never returns a key value (presence / last-4 only). HARDENING
--    FOLLOW-UP: move to Supabase Vault (pgsodium) for column encryption at rest.
--
-- Apply via Supabase MCP apply_migration (prod-schema change = Daniel's call).
-- Safe to apply before or after the code merges: resolveApiKey catches a missing
-- table and falls back to .env, so nothing 500s while the table is absent.

CREATE TABLE IF NOT EXISTS provider_api_keys (
  provider   text PRIMARY KEY,              -- registry provider id: 'anthropic' | 'openai' | 'perplexity' | 'gemini' | future
  api_key    text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Deny-all: no anon/authenticated access to a secrets table. service_role bypasses RLS.
ALTER TABLE provider_api_keys ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE provider_api_keys IS
  'BACKLOG #49: DB-stored LLM provider API keys (gap-fill for providers without an .env key). PLAINTEXT, service_role-only. API never returns the value. Consider Vault for encryption at rest.';
