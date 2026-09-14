/**
 * Corpus Archive — durable, purge-immune banking of scraped page text (Corpus Archive U-C).
 *
 * WHY: the scraped corpus lives only in run-scoped tables (entity_stage_pool /
 * submodule_run_item_data) that retention.js purges after 7 days. Every purged run loses its
 * scrape forever — the exact loss the archive exists to stop. This banks each scraped page's
 * text as a gzip object in the 'corpus' Storage bucket and indexes it in entity_corpus
 * ((company_id|entity_name, url) -> object_key + content_hash + provenance), a table
 * DELIBERATELY absent from retention.js RUN_ID_TABLES (U-B). Its survival is structural.
 *
 * ADDITIVE ONLY: it never mutates what the live pipeline reads. The stageWorker call site
 * wraps archiveEntityScrape so a corpus failure NEVER breaks a scrape — but this module is
 * LOUD internally (every storage/DB call checks { error } and throws; nothing is silently
 * skipped — that swallowed-error class cost this project weeks). It is partial-safe: pages are
 * banked one at a time, so a mid-entity failure leaves what it already banked.
 *
 * IDEMPOTENT: re-banking unchanged content (content_hash match) is a no-op; changed content
 * UPDATES in place (one live copy per (entity, url), matching UNIQUE(dedup_key, url)) — no
 * versioning here; scrape history/freshness is U-E's concern, not U-C's.
 *
 * Scope: U-C WRITE side only. Read/hydration (U-D), freshness gate (U-E) and retention
 * lifecycle (U-F) are separate units. get() exists on the blob store only for tests/U-D.
 *
 * OFF by default: no-op (zero DB work) unless CORPUS_ARCHIVE_BUCKET is set — a clean
 * off-switch for an additive subsystem that writes to prod on every scrape.
 *
 * DI (db / stores injected; no top-level import of the real client) so it is hermetically
 * testable — same convention as seedPersistence.js / postmortemStore.js.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { slugifyEntity } from './storage.js';

export const CORPUS_BUCKET = process.env.CORPUS_ARCHIVE_BUCKET || null; // null = archive OFF

// ── pure helpers ────────────────────────────────────────────────────────────────
/** The identity used for the object key AND for uniqueness. company_id when present (collapses
 *  the Hacksaw/Hacksawgaming split), else slug(entity_name) — NULL-safe, unlike a bare
 *  company_id which would NULL-distinct in a UNIQUE and never dedupe legacy entities. */
export function entityDedupKey(companyId, entityName) {
  const cid = (companyId == null ? '' : String(companyId)).trim();
  return cid || slugifyEntity(entityName);
}

/** Object key within the corpus bucket: <dedup_key>/<sha256(url)>.txt.gz — stable per (entity,url). */
export function corpusObjectKey(dedupKey, url) {
  return `${dedupKey}/${createHash('sha256').update(String(url)).digest('hex')}.txt.gz`;
}

export function contentHash(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function numericOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── core: bank an entity's scraped pages (loud, idempotent, partial-safe) ─────────
/**
 * @param {object[]} items scraped items (only those with a url + non-empty text_content are banked)
 * @param {{company_id?, entity_name, website?, cms_id?}} identity durable entity identity
 * @param {string} source_run_id originating run (provenance, not a FK)
 * @param {string} scraper submodule id that produced the pages
 * @param {{put(objectKey, bytes)}} blobStore loud bytes store
 * @param {{getExisting(dedupKey,url), upsertRow(row)}} indexStore loud index store
 * @param {() => string} now iso timestamp
 * @returns {{corpus_rows_written, bytes_stored, skipped, banked_urls}}
 */
export async function archiveScrapedItems({ items, identity, source_run_id, scraper, blobStore, indexStore, now = () => new Date().toISOString() }) {
  const entityName = identity?.entity_name;
  if (!entityName) throw new Error('[corpus] archiveScrapedItems: identity.entity_name is required');
  const dedupKey = entityDedupKey(identity.company_id, entityName);

  // Data-shape route: only pages with a url + text. Dedupe by url within this batch so the
  // same page scraped twice in one output is banked once (design: one copy per unique URL).
  const seen = new Set();
  const pages = [];
  for (const it of (items || [])) {
    const url = it?.url;
    const text = it?.text_content;
    if (!url || typeof text !== 'string' || text.length === 0) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    pages.push(it);
  }

  let corpus_rows_written = 0, bytes_stored = 0, skipped = 0;
  const banked_urls = [];

  // ponytail: per-page getExisting round-trip (~N SELECTs for an N-page entity). Kept per-page
  // so each page commits independently (partial-safe). Batch the existence check into one
  // `.in('url', urls)` read if post-scrape latency on big entities (max ~565 pages) ever matters.
  for (const it of pages) {
    const url = it.url;
    const text = it.text_content;
    const hash = contentHash(text);

    const existing = await indexStore.getExisting(dedupKey, url); // LOUD
    if (existing && existing.content_hash === hash) { skipped++; continue; } // unchanged → no-op

    const objectKey = corpusObjectKey(dedupKey, url);
    const gz = gzipSync(Buffer.from(text, 'utf8'));
    await blobStore.put(objectKey, gz);                          // LOUD; overwrites on change

    await indexStore.upsertRow({                                 // LOUD; UPDATEs on (dedup_key,url) conflict
      company_id: identity.company_id ?? null,
      entity_name: entityName,
      website: identity.website ?? null,
      cms_id: identity.cms_id ?? null,
      url,
      dedup_key: dedupKey,
      object_key: objectKey,
      content_hash: hash,
      char_len: text.length,
      http_status: numericOrNull(it.http_status ?? it.status_code),
      scrape_status: typeof it.status === 'string' ? it.status : null,
      word_count: numericOrNull(it.word_count),
      scraper: scraper ?? null,
      source_run_id: source_run_id ?? null,
      scraped_at: now(),
    });

    corpus_rows_written++;
    bytes_stored += gz.length;
    banked_urls.push(url);
  }

  return { corpus_rows_written, bytes_stored, skipped, banked_urls };
}

// ── identity lookup (the persisted seed snapshot) ────────────────────────────────
/** Durable entity identity from run_entities.entity_snapshot (written by seedPersistence).
 *  LOUD on query error; nulls (never a throw) when no seed row exists — legacy entities are
 *  banked under slug(entity_name). */
export async function lookupIdentity({ db, runId, entityName }) {
  const { data, error } = await db.from('run_entities')
    .select('entity_snapshot')
    .eq('run_id', runId)
    .eq('entity_name', entityName)
    .maybeSingle();
  if (error) throw new Error(`[corpus] identity lookup failed (run ${runId}, entity "${entityName}"): ${error.message}`);
  const s = (data && data.entity_snapshot && typeof data.entity_snapshot === 'object' && !Array.isArray(data.entity_snapshot))
    ? data.entity_snapshot : {};
  return {
    company_id: s.company_id ?? null,
    website: s.website ?? null,
    cms_id: s.cms_id ?? null,
    entity_name: entityName,
  };
}

// ── real Supabase-backed stores (loud on { error }) ──────────────────────────────
export function createSupabaseBlobStore(db, bucket = CORPUS_BUCKET) {
  return {
    async put(objectKey, bytes) {
      const { error } = await db.storage.from(bucket).upload(objectKey, bytes, { contentType: 'application/gzip', upsert: true });
      if (error) throw new Error(`[corpus] object upload to ${bucket}/${objectKey} failed: ${error.message}`);
    },
    async get(objectKey) { // for tests / U-D read side
      const { data, error } = await db.storage.from(bucket).download(objectKey);
      if (error || !data) throw new Error(`[corpus] object download of ${bucket}/${objectKey} failed: ${error?.message || 'not found'}`);
      return Buffer.from(await data.arrayBuffer());
    },
  };
}

export function createSupabaseIndexStore(db) {
  return {
    async getExisting(dedupKey, url) {
      const { data, error } = await db.from('entity_corpus')
        .select('content_hash, object_key')
        .eq('dedup_key', dedupKey)
        .eq('url', url)
        .maybeSingle();
      if (error) throw new Error(`[corpus] index read failed (${dedupKey} / ${url}): ${error.message}`);
      return data || null;
    },
    async upsertRow(row) {
      const { error } = await db.from('entity_corpus').upsert(row, { onConflict: 'dedup_key,url' });
      if (error) throw new Error(`[corpus] index upsert failed (${row.dedup_key} / ${row.url}): ${error.message}`);
    },
  };
}

// ── the stageWorker hook ─────────────────────────────────────────────────────────
/**
 * Bank a completed (or partial) scraper output for one entity. No-op (returns null, ZERO
 * queries) when the archive is OFF, the module is a text REFINER (see below), or the batch
 * carries no text_content page — so it is inert for every non-producing submodule run without
 * a step/id check (data-shape + manifest-dependency routed).
 * LOUD internally; the CALL SITE catches so a corpus failure never breaks the live pipeline.
 *
 * @param {string[]} requiresColumns the submodule's manifest.requires_columns. A module that
 *   REQUIRES text_content as INPUT is refining it (boilerplate-stripper, intent-tagger,
 *   content-filter), not producing a raw scrape — banking its output would overwrite the raw
 *   corpus with transformed text under the wrong provenance. We bank only PRODUCERS of
 *   text_content (scrapers require url/name/nothing, never text_content). Manifest-declared
 *   data dependency ⇒ pipeline-agnostic (no step number / submodule id / content-type check).
 */
export async function archiveEntityScrape({ db, items, entityName, runId, scraper, requiresColumns, bucket = CORPUS_BUCKET, now }) {
  if (!bucket || !db || !entityName) return null;                // archive OFF / missing context
  if ((requiresColumns || []).includes('text_content')) return null; // refiner, not a raw producer — never overwrite the raw scrape
  const hasText = (items || []).some(it => it && it.url && typeof it.text_content === 'string' && it.text_content.length > 0);
  if (!hasText) return null;                                     // non-scraper output — skip identity lookup entirely

  const identity = await lookupIdentity({ db, runId, entityName });
  const stats = await archiveScrapedItems({
    items, identity, source_run_id: runId, scraper,
    blobStore: createSupabaseBlobStore(db, bucket),
    indexStore: createSupabaseIndexStore(db),
    now,
  });
  console.log(`[corpus] banked entity="${entityName}" run=${runId} scraper=${scraper}: corpus_rows_written=${stats.corpus_rows_written} bytes_stored=${stats.bytes_stored} skipped=${stats.skipped}`);
  return stats;
}

/** Loud boot signal so an OFF archive is visible (mirrors postmortemStore's boot line). */
export function logCorpusArchiveStatus(bucket = CORPUS_BUCKET, log = console) {
  if (bucket) log.log(`[corpus] archive ON -> bucket "${bucket}"`);
  else log.warn('[corpus] ⚠️  archive OFF — scraped corpus will NOT be banked. Set CORPUS_ARCHIVE_BUCKET in .env and restart the stage worker.');
}
