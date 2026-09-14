-- Durable Corpus Archive — U-B: the purge-immune entity->object index.
-- Bytes live in the 'corpus' Storage bucket; this table maps (entity, url) -> object_key + provenance.
-- PURGE-IMMUNE BY DESIGN: never listed in retention.js RUN_ID_TABLES; source_run_id is a plain
-- column, NOT a foreign key, so a purged run never cascades here.
-- Applied to prod fevxvwqjhndetktujeuu 2026-09-14 (this file is the committed record).
CREATE TABLE IF NOT EXISTS entity_corpus (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    text,                 -- durable cross-run key (uuid OR Strapi id); NULL for legacy entities
  entity_name   text NOT NULL,        -- fallback / human key
  website       text,                 -- domain anchor
  cms_id        text,                 -- Strapi documentId (CMS link)
  url           text NOT NULL,        -- the page (dedup anchor)
  dedup_key     text NOT NULL,        -- COALESCE(company_id, slug(entity_name)); NULL-safe identity for object key + uniqueness
  object_key    text NOT NULL,        -- path within the corpus Storage bucket
  content_hash  text NOT NULL,        -- sha256 of scraped text; change detection / no-op re-bank
  char_len      int,                  -- uncompressed text length
  http_status   int,                  -- numeric HTTP code if the scraper carries one (usually NULL today)
  scrape_status text,                 -- scraper string status: success/low_content/... (walled/thin signal)
  word_count    int,                  -- thin-page signal
  scraper       text,                 -- provenance: submodule that produced it
  source_run_id uuid,                 -- provenance: originating run (audit only — NOT a FK, must not cascade)
  scraped_at    timestamptz NOT NULL,
  archived_at   timestamptz DEFAULT now(),
  UNIQUE (dedup_key, url)
);
CREATE INDEX IF NOT EXISTS idx_entity_corpus_entity_name ON entity_corpus (entity_name);
CREATE INDEX IF NOT EXISTS idx_entity_corpus_website     ON entity_corpus (website);
CREATE INDEX IF NOT EXISTS idx_entity_corpus_scraped_at  ON entity_corpus (scraped_at);
CREATE INDEX IF NOT EXISTS idx_entity_corpus_company_id  ON entity_corpus (company_id);

COMMENT ON TABLE entity_corpus IS 'Durable, purge-immune index of the scraped page corpus (Corpus Archive U-B). Bytes live in the corpus Storage bucket (object_key). DELIBERATELY absent from retention.js RUN_ID_TABLES; source_run_id is a plain column, NOT a foreign key. That structural absence IS the 7-day-purge survival.';
COMMENT ON COLUMN entity_corpus.source_run_id IS 'Originating run, audit only. NOT a foreign key by design — must never cascade-delete when a run is purged.';
