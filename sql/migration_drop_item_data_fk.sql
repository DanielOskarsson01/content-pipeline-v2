-- Migration: Drop FK constraint on submodule_run_item_data.submodule_run_id
--
-- Problem: The FK references submodule_runs(id), but in per-entity mode we store
-- entity_submodule_runs IDs in the same column. This causes all inserts to fail
-- silently, resulting in empty text_content in the UI and incomplete downloads.
--
-- The column is polymorphic (references either submodule_runs or entity_submodule_runs),
-- so no single FK can enforce both. Schema.sql already reflects this (no FK), but
-- this migration drops the constraint from existing production databases.
--
-- Run this in the Supabase SQL Editor.

-- Find and drop all FK constraints on submodule_run_item_data.submodule_run_id
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE table_name = 'submodule_run_item_data'
      AND constraint_type = 'FOREIGN KEY'
  ) LOOP
    EXECUTE 'ALTER TABLE submodule_run_item_data DROP CONSTRAINT ' || quote_ident(r.constraint_name);
    RAISE NOTICE 'Dropped FK constraint: %', r.constraint_name;
  END LOOP;
END $$;

-- Verify: should return 0 rows
SELECT constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_name = 'submodule_run_item_data'
  AND constraint_type = 'FOREIGN KEY';
