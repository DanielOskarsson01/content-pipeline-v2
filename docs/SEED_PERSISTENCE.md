# Seed persistence — the durable per-entity seed store (2026-09-12)

## The bug (verified in prod before the fix)

The intended architecture is that entity data is written to the DB and later
submodules hydrate it back — nothing rides between steps in memory. But the seed's
`company_id`/`cms_id`/`website` were parsed at ingest, used to launch discovery, and
**never written to a durable per-entity table**. By Step 5 the entity was `{name}`
only:

- `submoduleRuns.js:484-497` loads `step_context` WHERE `step_index=5` → miss → falls
  back to pool-derived `inputData.entities` (which carry only `{entity_name}`).
- `taxonomySuggestions.js` therefore left `company_id`/`cms_id` NULL (verified 2026-09-12
  on run `94baa6f6`: the entity object at the Step-5 hook was `{name, entity_name}`).

`run_entities` was clearly meant to be this store (schema exists: `run_id`,
`entity_snapshot jsonb NOT NULL`, dead `entity_id`) but nothing wrote it — dead since
2026-02. A wiring gap, not a design limit.

## The fix

Persist the FULL seed row per entity at ingest into a durable table keyed by
`(run_id, entity_name)`, and hydrate it back through the normal §7b path where needed
— exactly how scraped pages and `gsc_terms` are hydrated today.

### Store — `run_entities` revived (not a new table)

Chosen over a new table because `run_entities` already carries `run_id` +
`entity_snapshot jsonb NOT NULL` (2 of the 3 columns needed), is already in the
retention purge list (`retention.js`), and was the intended store. Migration
(`supabase/migrations/20260912180000_seed_persistence_run_entities.sql`) is additive +
idempotent:

```sql
alter table public.run_entities add column if not exists entity_name text;
create unique index if not exists run_entities_run_id_entity_name_key
  on public.run_entities (run_id, entity_name);
```

The whole parsed seed row lives in `entity_snapshot`; `company_id`/`cms_id`/`website`
stay individually queryable via `entity_snapshot->>'…'`. The legacy `(run_id, entity_id)`
unique index is untouched (`entity_id` stays NULL; NULLs are distinct). ~1193 dead legacy
rows all have `entity_name` NULL, so the new unique index builds without violation.

### Write at ingest — `seedPersistence.persistSeedEntities`

`templates.js` launch handler (step "9a", right after the `step_context` write) calls
`persistSeedEntities({ runId, entities, db })`:

- `buildSeedRows(runId, entities)` → one `{run_id, entity_name, entity_snapshot}` row per
  entity (skips nameless rows; `entity_snapshot` = the whole parsed seed row).
- Idempotent upsert on `(run_id, entity_name)`.
- **LOUD on write error** (throws — the swallowed-error class), logs `seed_rows_written`.
- No-op in seedless mode (`entities = []`).

### Hydrate back — `poolHydration.js` "Pass 4: seed fallback"

`hydrateRequiresColumns` gains a 4th fallback after the primary/url/entity_name cascade:
any `requires_columns` field still missing after the upstream cascade is filled from the
persisted seed row via `seedPersistence.fillSeedFieldsForItems`. Mirrors the
`fillGscTermsForItems` pattern: data-shape routed (only requested fields present in the
seed are filled, only where the item lacks them), no-op when db/runId/entityName/fields
absent or no seed row exists, THROWS on query error. So a module that declares a seed
field (`company_id`/`cms_id`/`website`) in its manifest `requires_columns` receives it —
`cms_id` and `website` can now reach later steps.

## Tests

`server/services/seedPersistence.test.js` (11 hermetic assertions): row written at ingest,
idempotent upsert, loud-on-error, no-op on empty, hydrated back, does-not-overwrite-set
values, no-op/warn when no seed row, loud on query error, no-op with no db/fields/items.
Full skeleton suite green (215/215). `poolHydration.test.js` (the live GSC-hook tests)
unaffected — Pass 4 sits inside the `requires_columns.length > 0` block those tests skip.

## Loop-closure boundary (deliberate)

Phase 1 ships the **store + write + hydration mechanism** — proven by the unit tests and
the production seed-write. It does **not** wire a live consumer: no module currently
declares `company_id`/`cms_id` in `requires_columns`, and `taxonomySuggestions` still
writes them NULL. Wiring a consumer (e.g. the taxonomy hook hydrating `company_id`, or
`markdown-output` `frontmatter_entity_fields`) is the follow-up that closes the loop.

## Production proof

- Migration applied to prod `fevxvwqjhndetktujeuu` (column + unique index verified).
- Code deployed via CI (commit `72621dc` seed-persistence; `f80bb49` includes it); prod
  shasums byte-identical to local HEAD; `resolveModel`/pm2 healthy.
- **Seed-write + survives-to-Step-5 proven** on validation run
  `36c75581-fb28-4e1d-a0a4-59154f801b58` (which completed Steps 1–8): at launch ingest
  `run_entities` carried all 3 entities with `company_id`+`cms_id`+`website` in
  `entity_snapshot`, and those rows stayed queryable through Steps 5–8 (nothing rides in
  memory). (`persistSeedEntities` also fired correctly on the earlier run `43a34774`.)
