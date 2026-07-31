-- D12 / #46 rollback — for the 20260712000000_d12_stored_assets migration.
--
-- Drops the stored_assets table (its indexes drop with it). The `assets` bucket is
-- LEFT AS-IS: it pre-existed this migration (created 2026-03-12, holds 3 UI avatar
-- SVGs), so the migration only adopted it (ON CONFLICT DO NOTHING) and rollback must
-- not remove it. Bytes in a bucket are never reclaimed by SQL regardless.
--
-- Reversible cleanly while stored_assets is empty (asset-path not yet used in prod).

DROP TABLE IF EXISTS stored_assets;
