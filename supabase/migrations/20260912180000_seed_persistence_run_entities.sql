-- Seed persistence — revive run_entities as the durable per-entity seed store.
--
-- The pipeline knows entities by NAME only. The seed's company_id/cms_id/website were
-- parsed at ingest but never persisted, so by Step 5 the entity is {name}
-- (submoduleRuns.js:484-497 → step_context miss → pool-derived {entity_name}), and
-- taxonomy_suggestions.company_id/cms_id were left null. run_entities was the intended
-- store (schema exists) but dead since 2026-02 (entity_id null, nothing writes it).
--
-- Additive & idempotent: add entity_name (the stable identity) and a
-- (run_id, entity_name) unique index so ingest can upsert one seed row per entity. The
-- full seed row lives in the existing entity_snapshot jsonb; company_id/cms_id/website
-- stay individually queryable via entity_snapshot->>'...'. The existing
-- (run_id, entity_id) unique index is untouched (entity_id stays null; NULLs distinct).
--
-- Prod-safety: the table is dead (nothing writes it) but NOT empty — it holds ~1193
-- legacy rows, all with entity_name NULL. NULLs are distinct in a unique index, so the
-- new index builds without violation, and a plain (non-CONCURRENTLY) build is sub-second
-- on a table this size — no meaningful lock on live traffic.

alter table public.run_entities add column if not exists entity_name text;

create unique index if not exists run_entities_run_id_entity_name_key
  on public.run_entities (run_id, entity_name);
