-- Unit 4c §TASK 3a — taxonomy_suggestions: Option B (the honest migration).
--
-- content-analyzer emits out-of-vocabulary tag PROPOSALS in
-- analysis_json.tags.suggested_new[].{label, why, evidence[]}. Nothing wrote them
-- (they were lost) and they leaked into published drafts as [Tag: <label>] markers.
-- A skeleton post-module hook (server/services/taxonomySuggestions.js) now routes
-- them to this review table.
--
-- WHY Option B: company_id uuid NOT NULL is a fossil of the retired CMS-coupled
-- design. The pipeline identifies entities by NAME only — run_entities is dead, and
-- the seed's company_id does NOT survive to the Step-5 hook (verified 2026-09-12 on
-- run 94baa6f6: the entity object at the hook is {name, entity_name} — even website
-- is gone, because step_context is stored per-step and only exists at step 1). So we
-- store the truth the pipeline knows (entity_name), leave company_id as a harmless
-- nullable fossil, and add cms_id text for the future Strapi publishing leg (the CMS
-- key is a documentId STRING, not a uuid — so it never belonged in company_id uuid).
--
-- Additive + idempotent (safe to re-run). Table has 0 rows, so the new UNIQUE index
-- cannot collide on existing data. Apply via Supabase MCP apply_migration
-- (prod-schema change = Daniel's call); CI does not run migrations.
-- Safe to apply BEFORE the code merges: the hook is the only writer, and it upserts
-- on the new unique index — which must exist first (deploy migration-first).

ALTER TABLE taxonomy_suggestions ADD COLUMN IF NOT EXISTS entity_name text;
ALTER TABLE taxonomy_suggestions ADD COLUMN IF NOT EXISTS cms_id      text;
ALTER TABLE taxonomy_suggestions ALTER COLUMN company_id DROP NOT NULL;

-- Idempotency key for the hook: one row per (run, entity, type, label). Makes a
-- loop-router / manual re-run an atomic upsert(onConflict) instead of
-- delete-then-insert, so a re-run replaces its OWN rows and never touches another
-- run's reviewed rows.
CREATE UNIQUE INDEX IF NOT EXISTS taxonomy_suggestions_run_entity_type_label_uidx
  ON taxonomy_suggestions (run_id, entity_name, suggestion_type, label);

COMMENT ON COLUMN taxonomy_suggestions.entity_name IS
  'Unit 4c: the pipeline''s only reliable entity identity at the Step-5 hook (name-based; run_entities is dead).';
COMMENT ON COLUMN taxonomy_suggestions.cms_id IS
  'Unit 4c: future Strapi publishing key (documentId STRING). NULL until the seed id survives to the hook (CMS-seed-enrichment backlog).';
COMMENT ON COLUMN taxonomy_suggestions.company_id IS
  'Fossil of the retired CMS-coupled design. Nullable since Unit 4c; the hook does not write it. Use entity_name/cms_id.';
