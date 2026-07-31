-- =====================================================================
-- D12 / #46 — tools.storage: stored_assets table + public `assets` bucket
-- Design: Content-Pipeline/specs/UNIT_D12_STORAGE_DESIGN.md @ a32e63f (§2.1, corrected)
-- Review gates (UNIT_D12_REVIEW.md): F2 (versioning-correct corpus dedup index),
--   F3 (explicit `visibility` column; public bucket denies anon LIST).
--
-- WHAT THIS DOES (pure DDL + one bucket upsert — safe to dry-run on a schema-only branch):
--   (1) stored_assets — the backend-agnostic, queryable index over persisted binary
--       assets. `backend` + a byte-identical `object_key` make a future R2 migration a
--       data UPDATE, not a rewrite. `source` ('asset'|'corpus') + partial indexes make
--       the schema corpus-ready with NO later ALTER. THIS UNIT writes/reads ONLY
--       source='asset' rows — the corpus write path is deferred to D-corpus.
--   (2) the public `assets` Storage bucket. RLS on storage.objects stays default-deny
--       (RLS enabled, no anon SELECT policy) so the bucket is READABLE BY KEY via the
--       public /object/public/ path but NOT enumerable by anon (review F3 / Attack-3).
--       The random-uuid key stem (design §3.3) defeats guessing; LIST-deny defeats
--       enumeration. Writes/reads/list go through the service-role key in tools.storage.
--   A private `corpus` bucket is intentionally NOT created — corpus is deferred to
--   D-corpus; #46 provisions only what the asset path uses.
--
-- PROD NOTE (verified 2026-07-12 read-only): prod already has a public `assets` bucket
--   (created 2026-03-12, 3 unrelated UI avatar SVGs at root — a DIFFERENT key namespace
--   than asset/<entity_key>/...). The bucket upsert below is ON CONFLICT DO NOTHING, so
--   on prod it is a no-op (adopts the existing bucket, touches neither its config nor the
--   avatars); on a fresh dry-run branch it creates the bucket so the full path is tested.
--   storage.objects RLS is already enabled with ZERO policies on prod → anon LIST already
--   denied; this migration adds no permissive policy.
--
-- SCOPE: additive only. One new table + its indexes + one idempotent bucket upsert.
--   Touches NO existing table. IF NOT EXISTS / idempotent throughout.
--
-- SAFETY: re-runnable — every object guarded (table + indexes IF NOT EXISTS; bucket
--   upsert ON CONFLICT DO NOTHING). A second run touches nothing.
--
-- ROLLBACK: supabase/artifacts/d12/rollback.sql — DROP TABLE stored_assets (+ its
--   indexes cascade); the bucket is left as-is (it pre-existed this migration). Bytes in
--   a bucket are never reclaimed by SQL. Reversible while stored_assets is empty.
-- =====================================================================

-- stored_assets — the durable, portable record over all persisted binary assets.
CREATE TABLE IF NOT EXISTS stored_assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- the opaque asset_id the seam returns
  source        TEXT NOT NULL DEFAULT 'asset',               -- 'asset' (write-once output) | 'corpus' (reusable input; D-corpus)
  entity_name   TEXT NOT NULL,                               -- module-visible handle (Entity Name Contract)
  entity_key    TEXT,                                        -- slug of entity_name; cross-run corpus linkage (D-corpus)
  run_id        UUID REFERENCES pipeline_runs(id),           -- asset: producing run. corpus: NULL (cross-run by design)
  asset_type    TEXT NOT NULL,                               -- 'image'|'audio'|'pdf'|'video'|'scrape'|'transcript'|...
  backend       TEXT NOT NULL DEFAULT 'supabase',            -- 'supabase' | 'r2'  ← THE swap column
  bucket        TEXT NOT NULL,                               -- bucket name within that backend
  visibility    TEXT NOT NULL DEFAULT 'public',              -- 'public'|'private'. EXPLICIT, not inferred from source (F3)
  object_key    TEXT NOT NULL,                               -- backend-PORTABLE key (byte-identical string on R2)
  url           TEXT NOT NULL,                               -- resolved stable URL (= ASSET_PUBLIC_BASE + object_key)
  content_type  TEXT NOT NULL,
  size_bytes    BIGINT,
  checksum      TEXT,                                        -- sha256 hex of bytes; byte-identity dedup / versioning
  source_url    TEXT,                                        -- corpus: origin URL. asset: NULL
  dedup_key     TEXT,                                        -- corpus has()-precheck lookup key. asset: NULL
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE stored_assets IS
  'D12/#46 tools.storage index. backend + byte-identical object_key make an R2 migration a data UPDATE. #46 uses source=asset only; corpus is D-corpus.';

-- (a) "what assets exist for entity X" — the per-run output query, used NOW.
CREATE INDEX IF NOT EXISTS idx_stored_assets_entity
  ON stored_assets(entity_name, source, asset_type);

-- (b) "what source material do we already have on company X" — corpus query, LATER, no DDL change.
CREATE INDEX IF NOT EXISTS idx_stored_assets_corpus
  ON stored_assets(entity_key, source) WHERE source = 'corpus';

-- Corpus dedup + versioning (review F2): keyed on (entity_key, source_url, checksum) so
-- an identical re-scrape dedups and changed bytes create a NEW version row. The earlier
-- UNIQUE(dedup_key) permitted one row per (entity,url) and made versioning impossible.
-- Partial → never constrains write-once assets.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stored_assets_dedup
  ON stored_assets(entity_key, source_url, checksum) WHERE source = 'corpus';

-- Per-run asset listing + cascade-friendly lookups.
CREATE INDEX IF NOT EXISTS idx_stored_assets_run
  ON stored_assets(run_id) WHERE run_id IS NOT NULL;

-- Migration sweeps operate by backend.
CREATE INDEX IF NOT EXISTS idx_stored_assets_backend
  ON stored_assets(backend);

-- ── the public `assets` bucket (idempotent adopt) ───────────────────────────
-- public=true → objects fetchable by key via /object/public/assets/<key> with no auth
-- (published article images). NO anon SELECT policy on storage.objects is created here,
-- so anon LIST/enumerate is denied by default RLS (review F3). tools.storage uses the
-- service-role key for put/get/list/delete.
INSERT INTO storage.buckets (id, name, public)
VALUES ('assets', 'assets', true)
ON CONFLICT (id) DO NOTHING;
