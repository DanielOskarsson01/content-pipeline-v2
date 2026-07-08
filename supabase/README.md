# Supabase migrations — baseline + dry-run notes (Unit 1.3, #17)

This directory brings the pipeline DB (`fevxvwqjhndetktujeuu`, "Claude code content
creation tool") under Supabase migration history so **schema changes can be dry-run
on a throwaway branch before they touch prod** — the prerequisite for the Phase 2/3
card-model migration (a JSONB rewrite of `templates.execution_plan`).

## Why a baseline was needed

Prod's migration ledger (`supabase_migrations.schema_migrations`) was **partially
tracked**: it began at `20260421202908 entity_routing_phase1` and its 21 successors
*assume* the core tables already exist (e.g. `entity_run_meta REFERENCES pipeline_runs`).
The core schema was applied out-of-band (Path-B), so it was in **no** migration.
Consequence: a fresh Supabase branch (built by replaying the ledger) failed on
migration #1 — `pipeline_runs` didn't exist yet. Branch dry-runs were impossible.

**Fix (Option A — prepend a base baseline, not a squash):**
`migrations/20260421000000_baseline_core_schema.sql` creates the 37 core tables that
no tracked migration owns, plus the 4 base-only functions and 2 triggers. It sorts
*before* the first tracked migration, so a fresh branch replays
`baseline → 21 migrations → reproduces prod`. The 17 migration-owned tables
(`entity_run_meta`, `entity_routing_log`, `js_knowledge_bank`, 7×`gsc_*`, 7×`ga4_*`)
are deliberately **excluded** — their own migrations create them on replay.

The baseline was reconstructed from the **live** schema via `pg_catalog`
(`format_type` / `pg_get_constraintdef` / `pg_get_indexdef` / `pg_get_functiondef` /
`pg_get_triggerdef`), not from the stale `sql/schema.sql` (which was missing ~20 tables).

## How the baseline is recorded on prod (metadata-only)

The baseline is recorded in prod's ledger as **already-applied** — its DDL is **never
executed against prod** (prod already has the schema; the `ADD CONSTRAINT` lines would
error if run). It was inserted as metadata only:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('20260421000000', 'baseline_core_schema', ARRAY[ <full file contents> ]);
```

The ledger `statements` are kept **byte-identical** to this file
(`md5 = 6984e5705a9095885a9d182b6c07ecf7`, 35053 bytes). If you edit the baseline file,
re-sync the ledger row or the two will drift.

## Validation (2026-07-08)

A throwaway branch was built from the ledger and its schema compared to prod via a
structural fingerprint (tables, columns, constraints, indexes, functions, triggers).
Result: **fully identical** — 54 tables · 516 columns · 110 constraints · 140 indexes ·
8 functions · 2 triggers, all md5-matching. Branch(baseline+21) ≡ prod, byte-for-byte.

A trivial schema-change migration was then dry-run on the branch and it was torn down:
`ALTER TABLE templates ADD COLUMN _dryrun_probe text;` (applied + recorded) →
`ALTER TABLE templates DROP COLUMN _dryrun_probe;` (applied + recorded) → branch deleted.

## Dry-run procedure (for the Phase 2/3 card migration, and any future schema change)

Tooling: the **Supabase CLI is not installed** in this environment; all ops go through
the Supabase MCP (`list_migrations`, `create_branch`, `apply_migration`, `execute_sql`,
`delete_branch`) or the dashboard.

1. **Create a branch.** Cost is `$0.01344/hr` (billed hourly) — confirm cost first.
   The branch replays the ledger (`baseline → 21 migrations`) onto a fresh DB.
   Branches are **schema-only** (`with_data: false`) — no prod rows carry over.
2. **Apply the candidate migration** to the branch via `apply_migration`. Confirm it
   applies cleanly and inspect the result with `execute_sql`.
3. **Tear the branch down** (`delete_branch`) and verify via `list_branches` that only
   the default `main` branch remains (no lingering billed preview).

> ⚠️ **Phase 2/3 caveat — the card migration is a DATA rewrite, not DDL.** A schema-only
> branch has no `templates` rows to rewrite. Before dry-running the `execution_plan`
> JSONB migration, **seed representative template rows into the branch first**
> (e.g. copy the relevant rows from prod), otherwise the migration runs against an empty
> table and proves nothing. This step is specific to data migrations; pure-DDL changes
> don't need it.

## Rollback / down-paths

- **Baseline ledger row** (metadata-only, fully reversible — touches no schema object):
  ```sql
  DELETE FROM supabase_migrations.schema_migrations WHERE version = '20260421000000';
  ```
- **A dry-run / candidate migration on a branch:** the down-path is the reverse DDL
  (`ADD COLUMN` ↔ `DROP COLUMN`, `CREATE TABLE` ↔ `DROP TABLE`, etc.). On a throwaway
  branch, the simplest rollback is to **delete the branch** — nothing on prod is touched.
- **The branch itself:** `delete_branch(branch_id)` → confirm with `list_branches`.

## Known follow-ups (out of scope for Unit 1.3)

- The 21 tracked migrations live in the **ledger** (with their `statements`) but are not
  yet present as **files** under `migrations/`. If/when the Supabase CLI workflow is
  adopted, backfill them as files so `supabase db pull`/`push` see a complete history.
  (Branch dry-runs already work today via the ledger — files are only needed for CLI.)
- RLS is disabled on 37 `public` tables (Supabase advisor, critical). The pipeline
  connects with the service-role key so it's not an active break, but it belongs to its
  own security unit — **not** touched here.
