/**
 * tools.storage LIVE integration — Unit #46. Run: npm run test:integration
 *
 * Requires a live Supabase project WITH the D12 migration applied (stored_assets
 * table + `assets` bucket). SKIPS when creds/table are absent, so it is a no-op in
 * CI / local-without-creds and the real proof only when pointed at the project.
 *
 * This is the "usage verifies, not just tests" layer (the unit suite proves logic
 * with in-memory fakes; this drives real bytes through Supabase Storage): round-trip
 * of real bytes, public reachability of the object, and — F3 — that anon cannot LIST
 * the public bucket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseStorage, ASSET_BUCKET } from '../services/storage.js';

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const LIVE = !!(SUPA_URL && SUPA_KEY && !/your-project/.test(SUPA_URL));

// Captured BEFORE any placeholder default: a real custom-domain base means the published
// ASSET_PUBLIC_BASE url should actually resolve (reachability test below).
const REAL_ASSET_BASE = process.env.ASSET_PUBLIC_BASE;

// F1 requires a non-native base. Use the configured one, else a placeholder — the
// round-trip verifies via getBytes (download-by-key), which does not need the URL to resolve.
if (LIVE && !process.env.ASSET_PUBLIC_BASE) {
  process.env.ASSET_PUBLIC_BASE = 'https://cdn.integration-placeholder.test/assets';
}

test('LIVE round-trip: put → getBytes exact bytes + checksum + metadata row',
  { skip: LIVE ? false : 'no live Supabase creds (SUPABASE_URL/KEY)' },
  async () => {
    const storage = createSupabaseStorage(createClient(SUPA_URL, SUPA_KEY));
    const bytes = Buffer.from(`d12-integration ${randomUUID()}`);
    const { asset_id, url } = await storage.put(bytes, {
      entity_name: `ZZ_Integration_${randomUUID().slice(0, 8)}`,
      asset_type: 'image', content_type: 'image/png', run_id: null,
    });
    try {
      assert.ok(!/supabase\.co/i.test(url), `url must not be native: ${url}`);
      const got = await storage.getBytes(asset_id);
      assert.equal(got.toString('binary'), bytes.toString('binary'));
      const row = await storage.get(asset_id);
      assert.equal(row.checksum, createHash('sha256').update(bytes).digest('hex'));
      assert.ok(row.object_key.startsWith('asset/'), row.object_key);
    } finally {
      await storage.delete(asset_id);
      assert.equal(await storage.get(asset_id), null);
    }
  });

test('LIVE: the stored object is publicly reachable by key (public bucket serves it)',
  { skip: LIVE ? false : 'no live Supabase creds' },
  async () => {
    const storage = createSupabaseStorage(createClient(SUPA_URL, SUPA_KEY));
    const bytes = Buffer.from(`reach ${randomUUID()}`);
    const { asset_id } = await storage.put(bytes, {
      entity_name: 'ZZ_Reach', asset_type: 'image', content_type: 'image/png', run_id: null,
    });
    try {
      const row = await storage.get(asset_id);
      // test-only: the native public URL (modules NEVER build this) — proves public serving
      const nativeUrl = `${SUPA_URL.replace(/\/$/, '')}/storage/v1/object/public/${ASSET_BUCKET}/${row.object_key}`;
      const res = await fetch(nativeUrl);
      assert.equal(res.status, 200, `public object should be 200, got ${res.status}`);
    } finally {
      await storage.delete(asset_id);
    }
  });

test('LIVE: the published ASSET_PUBLIC_BASE url is reachable (200)',
  { skip: (LIVE && REAL_ASSET_BASE) ? false
      : 'ASSET_PUBLIC_BASE not set to a real custom-domain host — custom domain not provisioned (design §4-flag/§5, review F1)' },
  async () => {
    const storage = createSupabaseStorage(createClient(SUPA_URL, SUPA_KEY));
    const bytes = Buffer.from(`reach-base ${randomUUID()}`);
    const { asset_id, url } = await storage.put(bytes, {
      entity_name: 'ZZ_ReachBase', asset_type: 'image', content_type: 'image/png', run_id: null,
    });
    try {
      assert.ok(url.startsWith(REAL_ASSET_BASE), `url should be on the real base: ${url}`);
      const res = await fetch(url);
      assert.equal(res.status, 200, `ASSET_PUBLIC_BASE url should be 200, got ${res.status}: ${url}`);
    } finally {
      await storage.delete(asset_id);
    }
  });

test('LIVE F3: anon cannot LIST the public assets bucket (enumeration denied)',
  { skip: (LIVE && ANON_KEY) ? false : 'no SUPABASE_ANON_KEY (or no live creds)' },
  async () => {
    const anon = createClient(SUPA_URL, ANON_KEY);
    const { data, error } = await anon.storage.from(ASSET_BUCKET).list();
    // deny = an error OR an empty listing (RLS filters every row out for anon)
    assert.ok(error || (Array.isArray(data) && data.length === 0),
      `anon LIST must be denied/empty — got ${data ? data.length : '?'} objects`);
  });
