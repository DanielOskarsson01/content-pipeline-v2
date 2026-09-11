# §7b Hydration Truncation — root cause + fix

**Date:** 2026-09-11
**File:** `server/services/poolHydration.js` (`hydrateRequiresColumns`)
**Severity:** highest-priority — silently halved the scraped corpus reaching the analyzer, causing grounded claims to be flagged as hallucinations.

---

## Symptom

For run `94baa6f6` entity **ELK Studios**, the analyzer received text from ~123–202 of
402 scraped pages. ~200 pages/entity never reached content-analyzer. The
hallucination-detector's corpus grep then found grounded claims (ELK's NetBet→Denmark,
888→Italy, SkillOnNet→Mexico partnerships) *absent* from the truncated corpus and flagged
them as fabrications. (Root cause traced in `CITATION_GROUNDING.md`, commit `e48069d`.)

## Root cause — exact mechanism

`hydrateRequiresColumns` merged `requires_columns` (e.g. `text_content`) onto pool items
by querying `submodule_run_item_data` with `.in('item_key', keyBatch)`, batched at
`ENRICH_BATCH = 200` page URLs. ELK's page URLs average 49 / **max 758** chars, so a
200-key batch produces a GET query-string of ~10–15 KB. That **overran the PostgREST
request-URI limit.**

Reproduced live against prod (read-only), same query at varying batch sizes, **with and
without the heavy `content` column**:

| batch | with `content` | without `content` |
|------:|----------------|-------------------|
| ≤150  | 402/402 keys, 0 err | 402/402 keys, 0 err |
| 200   | **202/402, `TypeError: fetch failed`** | **202/402, `fetch failed`** (identical) |
| 402   | 0/402, `400 Bad Request` | 0/402, `400 Bad Request` |

Dropping `content` changes nothing → it is the **request URI**, not the response payload.
It is **not** a 1000-row PostgREST cap (text_content is 606 rows / 402 keys, < 1000; and
the failure is identical without `content`).

The kill shot: the code destructured only `{ data }` and **ignored `error`**
(`poolHydration.js`, old lines 110-117). A failed batch → `data` null → `if (itemData)`
false → **zero rows contributed, silently.** No throw, no log. Quality degraded invisibly.

content-analyzer's `item_key` is `entity_name`, so the damage lands in the **url cross-key
fallback** pass (which batches the ~402 page URLs).

## The fix

The `item_key` IN-list was **redundant**: `upstreamRunIds` already scope to the entity
(`entity_submodule_runs` are per-entity; the table PK is
`(submodule_run_id, item_key, field_name)`). Removing it eliminates the URL-length failure
class entirely.

- Fetch by `submodule_run_id` + `field_name`, **range-paginated by the PK** in pages of
  1000 — which also defeats the 1000-row response cap for >1000-page entities (Play'n GO
  scraped 1500+).
- Filter to `wantedKeys` (a `Set` of pool keys) **client-side** to bound memory.
- **THROW on any query `error`** (was swallowed) so a future truncation fails loudly. The
  throw fails just that entity's BullMQ job (consistent with the existing throw at
  `stageWorker.js:444`, both before the execute `try`); other entities proceed.
- Added a per-field **coverage log** (`hydration coverage "<entity>" <field>: X/Y items`).

Applied uniformly to all three lookup passes via one `fetchFieldRows` + `buildLookup`
helper. Independent `/code-review`: **PASS / PROCEED** (4 INFO, all advisory).

## Before / after — proved live on prod (read-only), run 94baa6f6 ELK

| | pages with text_content | corpus chars |
|---|---|---|
| **BEFORE** (old prod logic) | 202 / 402 | 199,521 |
| **AFTER** (fixed) | **402 / 402** | **678,838** (3.4×) |

The previously-flagged supporting text is now grounded in the corpus:
`"NetBet Denmark"` in 3 pages (incl. `sigma.world/...netbet-denmark-expands...`, **2346
chars** — matches the CITATION_GROUNDING evidence), and it was dropped pre-fix (2 pages) →
recovered post-fix (3). SkillOnNet 7 pages, 888 6, Mexico 8, partnership 19.

## Tests

`server/tests/poolHydration.test.mjs` (+3): >200 url keys all hydrate; >1000 rows assemble
across range pages; a query error **throws** (guards the swallow-error regression).
Full skeleton suite: **354/354 pass, 0 fail** (on the `origin/main` deploy base).

## Deploy

Prod `/opt/content-pipeline-v2` deploys **CI-on-push to `main`** (`.github/workflows/deploy.yml`
rsyncs the tree, `npm install`, `pm2 startOrReload`). `deploy.sh` is the manual alternate.

**Clean isolation from H18:** the sibling branch `fix/qa-pool-latest-draft` also carried the
unrelated, prod-unvalidated H18 `completed_at` tie-break (`6dce4a3`). To keep this load-bearing
deploy to the hydration fix ALONE, this change is shipped on branch
`fix/hydration-truncation-clean` cut from `origin/main`, with the sort kept **step_index-only**
(main's existing tie behavior). Verified H18-free: `grep completed_at poolHydration.js` → none;
`poolHydration.latestDraft.test.js` (an H18 artifact) is not included.

**Risk:** low. The fix removes a failure mode; the only behavior change in normal operation
is the new throw, which fires only on a genuine DB error (the oversized IN-list that used to
trigger it is gone). No schema/API/config change. Pure read-path.

**Validation run (post-deploy, when authorized):** ELK + Pocket Rockets Gaming + Vermantia,
archived-at-creation, re-scored against the Unit-7 drafts. Projection: ELK auto-approve
0.856 → ~0.958 PASS, the 5 partnership/award false positives cleared.
