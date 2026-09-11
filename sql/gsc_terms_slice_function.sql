-- PIECE 3 — GSC hydration (specs template-v3/keyword-data/KEYWORD_DATA.md §6).
--
-- Read-only helper the skeleton's §7b hydration calls to fill keyword_data.gsc_terms
-- (the placeholder the keyword-data module leaves empty; modules can't touch the DB).
--
-- WHY A FUNCTION (not a supabase-js query): the aggregation must run in Postgres.
-- The category slice matches ~115K–198K raw rows in gsc_page_cross_daily
-- (game-aggregators 115,112; white-label-solutions 197,834). Pulling those to the
-- skeleton to compute a 25-row aggregate would be ~115–198 paginated round-trips per
-- thin entity. And the category slug lives at path segment 2 of the page URL — a
-- split_part() filter PostgREST's query builder cannot express. So both scopes are
-- done here as a single GROUP BY returning at most p_limit rows. No client-side
-- multi-row read = no request-URI truncation risk (the §7b hydration-fix lesson);
-- the caller still checks { error } and logs the returned count.
--
-- Both slices verified against prod fevxvwqjhndetktujeuu 2026-09-11:
--   entity   elk-studios           -> 8 queries / 1039 imp (all-time)
--   entity   vermantia             -> 7 queries / 1313 imp (all-time)
--   entity   pocket-rockets-gaming -> 0 rows  (=> category fallback)
--   category game-aggregators      -> 592 queries (top: casino games aggregator 27,520)
--   category strategy-consulting   -> 3 / casino-platforms -> 20  (PRG's real categories)
--
-- p_days <= 0 means all-time. The §6 SQL literally says `interval '180 days'`, but
-- §6's own acceptance counts (elk 8, vermantia 7) are ALL-TIME — at 180d they drop to
-- 6/6 (elk's two extra queries are >540d old; data spans 2025-02-03..2026-09-10).
-- RESOLVED all-time (planning chat 2026-09-11): GSC presence is durable topical
-- authority, not a trend. The skeleton defaults GSC_LOOKBACK_DAYS=0; window configurable.
--
-- Read-only, STABLE (uses now()), schema-qualified so search_path is irrelevant.

CREATE OR REPLACE FUNCTION public.gsc_terms_slice(
  p_scope TEXT,
  p_slug  TEXT,
  p_days  INTEGER DEFAULT 0,
  p_limit INTEGER DEFAULT 25
)
RETURNS TABLE(term TEXT, impressions BIGINT, clicks BIGINT, "position" NUMERIC)
LANGUAGE sql
STABLE
AS $$
  SELECT g.query::text AS term,
         sum(g.impressions)::bigint AS impressions,
         sum(g.clicks)::bigint AS clicks,
         round(avg(g.position)::numeric, 1) AS "position"
  FROM public.gsc_page_cross_daily g
  WHERE (p_days <= 0 OR g.date >= (now() - make_interval(days => p_days)))
    -- Section pre-filter (companies vs categories), then EXACT segment-2 slug match for
    -- both scopes — a prefix LIKE would collide ('pragmatic' catching 'pragmatic-play').
    AND g.page LIKE '%/' || (CASE p_scope WHEN 'entity' THEN 'companies'
                                          WHEN 'category' THEN 'categories' END) || '/%'
    AND split_part(
          split_part(
            replace(replace(g.page,'https://onlyigaming.com/',''),
                                   'https://www.onlyigaming.com/',''),
            '?', 1),
          '/', 2) = p_slug
  GROUP BY g.query
  ORDER BY sum(g.impressions) DESC
  LIMIT p_limit;
$$;

-- The skeleton connects with the service_role key (server/services/db.js).
GRANT EXECUTE ON FUNCTION public.gsc_terms_slice(TEXT, TEXT, INTEGER, INTEGER) TO service_role;
