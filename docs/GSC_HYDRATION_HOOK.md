# GSC hydration hook (PIECE 3)

Fills `keyword_data.gsc_terms` — the site's own Google Search Console queries — during
§7b pool hydration, so the seo-planner receives the site's real earned queries as
attainable head-term candidates. The keyword-data module (step 5, deployed v1.0.1)
emits `keyword_data.gsc_terms: []` as a placeholder because modules can't touch the DB
(Rule 2). Spec: `content-pipeline-specs/template-v3/keyword-data/KEYWORD_DATA.md` §6.

## What changed

- **`sql/gsc_terms_slice_function.sql`** — new read-only Postgres function
  `public.gsc_terms_slice(p_scope, p_slug, p_days, p_limit)`. One GROUP BY over
  `gsc_page_cross_daily`, two scopes (`entity` = `/companies/<slug>`, `category` =
  path segment 2 under `/categories/`), returns the top `p_limit` queries by summed
  impressions. `p_days<=0` = all-time.
- **`server/services/poolHydration.js`** — `hydrateRequiresColumns` now calls
  `fillGscTermsForItems` at the end of its hydrate flow. For any pool item carrying a
  `keyword_data` field (data-shape routed, like Step 8), it runs the entity slice; if
  empty, the category fallback (first `keyword_data.terms` slug with rows); writes the
  top-N into `keyword_data.gsc_terms` as `{term, impressions, clicks, position, scope}`.
- **`server/services/poolHydration.test.js`** — 8 cases (mock db seeded with real prod
  rows): entity fill, category fallback + first-hit ordering, empty→`[]`+warn,
  error→throws, no-keyword_data no-op, idempotent refill guard, JSON-string parse,
  no-db no-op.

## Why a Postgres function instead of a supabase-js query

The category slice matches **115K–198K raw rows** (game-aggregators 115,112;
white-label-solutions 197,834). Pulling those to the skeleton to compute a 25-row
aggregate would be ~115–198 paginated round-trips per thin entity — and the category
slug lives at path segment 2 of the page URL, which PostgREST's query builder can't
filter on (`split_part`). So both slices aggregate server-side and return ≤25 rows.

**Hydration-fix lesson (`.in()` request-URI truncation) is honored:** there is no
client-side multi-row read to range-paginate — the RPC returns a bounded, complete
top-N. The caller still checks `{ error }` and throws on failure, and logs the
per-entity term count so an empty fill is visible, never silent.

## Config (env, all optional)

| Env | Default | Meaning |
|---|---|---|
| `GSC_TERMS_LIMIT` | 25 | top-N terms per slice (spec `LIMIT 25`) |
| `GSC_LOOKBACK_DAYS` | 0 | 0 = all-time; N = `date >= now() - N days` |
| `GSC_CATEGORY_MAX_ATTEMPTS` | 8 | how many `keyword_data.terms` slugs to try as categories |

## Window: RESOLVED to all-time (planning chat 2026-09-11)

§6's SQL literally says `interval '180 days'`, but §6's **own acceptance counts**
(elk-studios 8 queries, vermantia 7) are **all-time**. At 180d they drop to 6/6
(elk's two extra queries are >540d old; GSC data spans 2025-02-03 → 2026-09-10).

**Decision: all-time.** GSC presence is durable topical authority, not a trend — an old
high-impression term still means the site ranks for it. So the spec's 180d/all-time
inconsistency is resolved toward all-time: **`GSC_LOOKBACK_DAYS` defaults to 0 (all-time)**.
A rolling window is available by setting the env to N>0, but the default (and the §6
acceptance fixture counts) are all-time.

## Deploy note (two artifacts, not one)

The code deploys via the CI rsync on push to main, but **the CI rsync does NOT run SQL
migrations**. `sql/gsc_terms_slice_function.sql` must be applied to prod
(`fevxvwqjhndetktujeuu`) as a migration **before** the code runs, or the hook throws
`GSC entity slice failed ... function gsc_terms_slice does not exist` the first time
seo-planner consumes `keyword_data`. Apply the migration first, then push the code.

## Currently inert

Nothing consumes `keyword_data` yet: seo-planner adds it to `requires_columns` in §7
(a separate modules-repo change, not in this unit). Until then no pool item carries
`keyword_data` at hydration and the loop no-ops. Verified today against prod via the
function-body SELECTs (elk 8 entity terms; game-aggregators category; PRG →
strategy-consulting fallback) and 8 unit tests; the live end-to-end fill activates when
§7 lands and the migration is applied.
