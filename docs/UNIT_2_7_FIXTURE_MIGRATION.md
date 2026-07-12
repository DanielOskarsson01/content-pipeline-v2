# Unit 2.7 — 30-april fixture migration: PREPARE + DRY-RUN (report for unit 3.1)

**Status:** PREPARE + DRY-RUN complete. **Nothing was written to prod.** The prod fixture
stays in its old `rounds`-map shape until unit 3.1 flips it atomically with the v6 runtime +
validator. This document is the hand-off 3.1 executes from.

**Spec:** `noble-wandering-graham.md` V6-§1.1 / §1.2 / §1.3 / §2 / §8; `DECISION_CARD_MODEL_V6.md`;
`supabase/README.md` (unit-1.3 dry-run procedure). **Branch:** `auto-21-w2-2026-06-25`.
**Prod:** `fevxvwqjhndetktujeuu`. **Date:** 2026-07-10.

---

## 1. What changes, and why (the scalar-round reshape)

The only card-bearing template — **30-april / `3442873e-921d-4c97-9f0f-39395c676b35`** — holds one
card, `a8f4d2c1-7e57-4001-8001-deadbeef0001` (`writer-v2-placeholder`, `content-writer`, step 5),
in the OLD `rounds`-map shape. The v6 validator (2.4) rejects it and the v6 engine (2.5) cannot
resolve it, so it must migrate to the scalar-round model.

**Two changes to `templates.execution_plan` for that one card:**

1. **Card reshape** — drop the `rounds` map; promote round 2 to a scalar `round` + flat `overrides`:
   ```
   {"rounds": {"1": {}, "2": {"_placeholder_marker": "sub-plan-1-ship-gate"}}}
     ->  {"round": 2, "overrides": {"_placeholder_marker": "sub-plan-1-ship-gate"}}
   ```
   The old `rounds["1"]` was an **empty dummy** that only existed to satisfy old rule 5 and never
   ran (V6-§2's routing-only hack). It is dropped — nothing of value lost.

2. **De-placement** — remove the card UUID from `submodules_per_step["5"]`. Under the new validator
   a `round > 1` card is **routing-only** (option (e)); a PLACED group must include round 1 and be
   contiguous, so leaving a round-2 card placed **400s**. `content-writer` still runs at round 1 as
   its plain-string entry; the card is reached only by escalation via `routing_rules` (unchanged).

> **IMPORTANT — live prod differs from the captured `sql/rebuild_30_april_template.sql`.** The
> committed rebuild SQL did NOT place the card UUID; **live prod DOES** (it is in
> `submodules_per_step["5"]`). The migration is authored against **live prod**, hence the
> de-placement step. Do not author 3.1 from the rebuild SQL.

`routing_rules`, `escalation_rules`, and every other step are left **byte-identical** (surgical
transform, not a full rebuild).

---

## 2. The migration script (3.1 applies this — NOT run against prod here)

**File:** [`supabase/migrations/20260710000000_v6_scalar_round_card_model.sql`](../supabase/migrations/20260710000000_v6_scalar_round_card_model.sql)

- Single atomic `UPDATE`, **id-scoped** to `3442873e…`, **guarded** on the old shape
  (`… rounds IS NOT NULL`) so it is **idempotent** (a second run touches 0 rows) and **fail-closed**
  (if the fixture drifted, 0 rows rather than corruption).
- 3.1 applies it **before** the v6 code (migration-before-code), inside the atomic deploy, protected
  by the rollback snapshot below.

---

## 3. Captured per-row JSONB (CTO2-1 — the ONLY working rollback)

A code revert-anchor cannot undo a JSONB data rewrite. The per-row snapshot is the rollback.

| Artifact | File | canonical `md5(execution_plan::text)` |
|---|---|---|
| **BEFORE** (restore target) | [`supabase/artifacts/unit-2.7/30april.execution_plan.before.json`](../supabase/artifacts/unit-2.7/30april.execution_plan.before.json) | `637910f29ea241ac53047b44de08c984` |
| **AFTER** (what 3.1 writes) | [`supabase/artifacts/unit-2.7/30april.execution_plan.after.json`](../supabase/artifacts/unit-2.7/30april.execution_plan.after.json) | `e554852aa7dba2a088a0e19d707425a9` |
| **ROLLBACK** (per-row restore) | [`supabase/artifacts/unit-2.7/rollback.sql`](../supabase/artifacts/unit-2.7/rollback.sql) | restores → `637910f29ea241ac53047b44de08c984` |

3.1 must capture the **live** BEFORE snapshot again at deploy time and confirm its md5 still equals
`637910f29ea241ac53047b44de08c984` before flipping — if prod drifted since 2026-07-10, STOP.

---

## 4. Dry-run: PROVEN on a seeded throwaway branch (torn down, teardown confirmed)

Per `supabase/README.md`. Branch `unit-2-7-dryrun` (ref `srnkettnzdfbeifpmyrd`), schema-only
(`with_data: false`), replayed ledger (baseline + 21 = 22 migrations, 54 public tables).

| # | Proof | Result |
|---|---|---|
| 1 | **Seed byte-faithful to prod** — seeded the 30-april old-shape row; md5 == prod | `637910f29ea241ac53047b44de08c984` ✓ |
| 2 | **Migration → scalar shape == intended** (`execution_plan = after.json::jsonb`) | `equals_intended_after = true` ✓ |
| 3 | Card: `round=2`, `overrides={_placeholder_marker}`, `rounds` gone | `card_still_has_rounds = false` ✓ |
| 4 | `submodules_per_step[5]` UUID removed, order preserved | `step5_still_has_uuid = false` ✓ |
| 5 | **Control row untouched** (card-less `Job Search` seeded by the ledger) | `control_unchanged = true` ✓ |
| 6 | **Idempotent** — second run of the migration | `rows_touched = 0`, plan unchanged ✓ |
| 7 | **Rollback restores byte-identical to prod** | md5 back to `637910f29ea241ac53047b44de08c984` ✓ |
| 8 | Branch deleted; `list_branches` → only `main` remains | no lingering billed branch ✓ |

**Semantic half (free, local, real 2.4 validator + 2.5 engine):**
[`server/tests/unit_2_7_fixture_migration.test.mjs`](../server/tests/unit_2_7_fixture_migration.test.mjs) — 6/6 pass:
BEFORE rejected by `validateExecutionPlan` (rule 4 + rule 11) → migration necessary; AFTER validates
clean; card de-placed; `resolveCards({citation:fail, hallucination:fail}, after, loopCount=0)` selects
the round-2 card at step 5 (INV-ROUND: `loop_count 0 → round 2`); flat `overrides` collapse resolves;
`loopCount=1` (round 3, unauthored) → `no_card_for_round` flag-and-continue terminus, never a crash.

---

## 5. THE SEEDING REQUIREMENT (do NOT repeat the empty-table trap)

`supabase/README.md` §Phase-2/3-caveat: a schema-only branch has **no `templates` rows**. Dry-running
a **data** migration against an empty table proves NOTHING. **3.1 (and any future data-migration
dry-run) MUST seed representative rows first** — including the 30-april fixture's exact current
old-shape row — before applying the migration.

Concretely for this migration: seed at minimum (a) the 30-april old-shape row (the mutation target)
and (b) at least one card-less row (a non-mutation control). On this branch, a ledger migration
already seeded a card-less `Job Search` template, which served as the control — but **do not rely on
that**; seed the control explicitly.

---

## 6. Templates the migration would mutate — ENUMERATION (step D)

Verified against prod 2026-07-10 (read-only). Of **28** templates:

- **1 mutated:** `3442873e` (30 april) — 1 card, old `rounds`-map shape. **Daniel-approved (this is the
  fixture).**
- **0** carry the legacy string-keyed `cards` key.
- **27** have no `card_definitions` (card-less legacy pipeline plans) — validator-clean, **untouched**
  (the migration is id-scoped AND guarded on `card_definitions.<uuid>.rounds`).

**No template other than the approved 30-april fixture is mutated. No STOP condition.** This confirms
the `executionPlanUtils.js:152-154` comment ("0 production templates carry `cards`; the only card
template is 30-april") against live prod.

Enumeration query (re-runnable at 3.1 deploy time to re-confirm no drift):
```sql
SELECT t.id, t.name,
  (t.execution_plan ? 'cards') AS has_legacy_cards,
  COALESCE((SELECT count(*) FROM jsonb_each(t.execution_plan->'card_definitions') c WHERE c.value ? 'rounds'),0) AS old_rounds_map_cards
FROM templates t
ORDER BY old_rounds_map_cards DESC;
-- expect: exactly one row with old_rounds_map_cards > 0 (3442873e); has_legacy_cards all false.
```

---

## 7. Gates 3.1 must carry (do not lose these)

### 7.1 — card_id first-pass merge is end-to-end UNTESTED (2.5 /code-review WARNING) — 3.x gate
2.5's review flagged: forwarding `entry.card_id` (placement-aware `expandCardGroups`, W3) makes a
**placed round-1 card's `overrides` merge on the first pass** — correct v6, inert for legacy,
**untested end-to-end**. **The 30-april fixture does NOT cover this**, in either shape:
- After migration it has **zero placed card UUIDs** (the card is de-placed / routing-only), so the
  placed-round-1 merge path is never exercised by it.
- Its escalation is a **same-submodule** routing-only round-2 card (`content-writer` is placed as a
  plain string), so it dispatches via the **existing** placed loop + card-instruction merge — it does
  **NOT** exercise the V6-§1.5 **different-submodule (unplaced) dispatch** path either.

  **Action for 3.x:** author a separate fixture/test with (a) a **placed round-1 card UUID** carrying
  overrides (to exercise the first-pass merge) and (b) a **different, unplaced** round-2 submodule (to
  exercise V6-§1.5 dispatch — the flagship capability). Neither is covered by 30-april. Do not let the
  green 30-april round-trip read as coverage of these two paths.

### 7.2 — Resume-time snapshot/live split-brain (V6-§8, W6) — HARD 3.1 drain gate
Restoring the template is **necessary, not sufficient**. Halted old-shape runs re-read the **LIVE**
template on resume while per-batch execution reads the **FROZEN** `execution_plan_snapshot` — the two
disagree on the card model mid-run. **3.1 must gate on run-state** (drain all active/resumable
old-shape runs) before the flip, not just template-state. The rollback in §3 fixes the template only.

### 7.3 — Atomicity
The fixture flip is a step **inside** the single 3.1 deploy — runtime + validator + fixture flip
together. Never flip the fixture while prod runs the old validator/engine (V6-§8): a scalar card
would 400 under old rule 5, or a raw write would leave a shape the old engine misreads.

---

## 8. Scope confirmation

Server + migration + specs only. No `client/src/**` file was needed or touched. No prod write, no
merge, no deploy. Branch `auto-21-w2-2026-06-25`, HEAD verified `0dd7c74` before commit.
