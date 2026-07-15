-- D12 Cloudinary swap rollback — for 20260714000000_d12_cloudinary_public_id.sql.
--
-- Drops the additive, nullable cloudinary_public_id column. Reversible cleanly ONLY while
-- this build is NOT deployed: STORE_COLUMNS in storage.js selects this column on every
-- metadata read, so once this build ships, dropping the column breaks get/getBytes/delete/
-- list — revert the build first. (The call-site swap riding a later Path-B is irrelevant
-- here; the column read is in THIS build.) Cloudinary bytes are never reclaimed by SQL;
-- this only removes the metadata handle. The `backend` column and all other schema stay.

ALTER TABLE stored_assets DROP COLUMN IF EXISTS cloudinary_public_id;
