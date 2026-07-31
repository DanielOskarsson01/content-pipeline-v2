-- =====================================================================
-- D12 / Cloudinary backend swap — stored_assets.cloudinary_public_id
-- Scope: UNIT_D12_CLOUDINARY_SWAP_SCOPE.md §4 (content-pipeline-specs).
-- Follows 20260712000000_d12_stored_assets.sql (the #46 table).
--
-- WHAT THIS DOES (one additive, nullable column — safe to dry-run on a schema branch):
--   ADD stored_assets.cloudinary_public_id TEXT (nullable). Cloudinary's public_id is the
--   authoritative handle for destroy()/delivery and is NOT re-derivable from object_key
--   (Cloudinary strips the extension per resource_type), so the adapter stores what upload
--   returns rather than re-derive it at every delete. NULL on all existing / Supabase rows.
--
--   NO other DDL. The `backend` column already exists (TEXT DEFAULT 'supabase', "THE swap
--   column") — Cloudinary rows just write backend='cloudinary', no schema change. resource_type
--   is the constant 'raw' for every asset (byte-identity; not persisted). `bucket` stays NOT NULL and carries
--   the cosmetic ASSET_BUCKET sentinel for Cloudinary rows (Cloudinary has no buckets).
--
-- SCOPE: additive only. ONE existing table, ONE nullable ADD COLUMN. No data backfill —
--   existing rows keep NULL (correct; they are Supabase-backed).
--
-- SAFETY: re-runnable — ADD COLUMN IF NOT EXISTS. A second run touches nothing. Additive +
--   nullable → back-compatible: code that never selects/writes this column is unaffected
--   (the call-site swap to Cloudinary is a later Path-B deploy; prod runs unchanged meanwhile).
--
-- ROLLBACK: supabase/artifacts/d12/rollback_cloudinary_public_id.sql — DROP COLUMN IF EXISTS.
--   Reversible cleanly while no deployed code reads the column.
-- =====================================================================

ALTER TABLE stored_assets
  ADD COLUMN IF NOT EXISTS cloudinary_public_id TEXT;  -- Cloudinary physical handle; NULL for Supabase/R2 rows

COMMENT ON COLUMN stored_assets.cloudinary_public_id IS
  'Cloudinary public_id returned on upload — authoritative for destroy()/delivery; NULL for non-Cloudinary rows (backend <> ''cloudinary''). UNIT_D12_CLOUDINARY_SWAP_SCOPE §4.';
