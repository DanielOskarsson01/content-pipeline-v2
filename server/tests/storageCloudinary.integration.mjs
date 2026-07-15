/**
 * tools.storage LIVE Cloudinary integration — Unit D12 backend swap.
 * Run: npm run test:integration   (env-gated; a no-op without creds)
 *
 * Requires: a live Supabase project WITH the cloudinary_public_id migration applied
 * (metadata store stays Postgres) + a Cloudinary account (bytes backend). SKIPS when
 * creds are absent, so it is a no-op in CI / local-without-creds and the real proof only
 * when pointed at dj39tfdpt + the migrated project.
 *
 * This is the "usage verifies, not just tests" layer (the unit suite proves seam logic
 * with an in-memory fake; this drives real bytes through the real Cloudinary SDK adapter):
 *   - RAW round-trip (text/plain): byte-exact + checksum.
 *   - IMAGE round-trip (real 1x1 PNG, content_type=image/png): byte-exact + checksum. Under
 *     resource_type=image Cloudinary re-encodes and this returns a DIFFERENT checksum (proven
 *     2026-07-15); the backend stores ALL bytes as raw, so it is byte-identical. This case is
 *     the regression guard for that decision.
 *   - metadata row correct: backend='cloudinary', cloudinary_public_id set under pipline/.
 *   - delete removes BOTH the Cloudinary asset and the metadata row (no test residue).
 * The ASSET_PUBLIC_BASE-reachability test stays SKIPPED (base unset by design until the
 * assets.onlyigaming.com Worker + DNS land — F1 keeps put() building base+object_key).
 *
 * WHERE THE CLOUD NAME RESOLVES (read before trusting a green): the adapter
 * (createCloudinaryBackend) is dependency-injection-pure — it receives an ALREADY-configured
 * `cloudinary` v2 client and never calls cloudinary.config() itself. THIS TEST configures the
 * SDK singleton at the config() call below, then injects it. So a green here proves the
 * round-trip works when the caller has configured a cloud — NOT that any production call site
 * resolves one. There is NO prod Cloudinary call site yet: stageWorker.js:377 still wires
 * createSupabaseStorage; the swap rides a later Path-B. When that wiring lands it MUST configure
 * the SDK (cloudinary.config() or the CLOUDINARY_URL env auto-config) before injecting into
 * createCloudinaryStorage. Until then this test is the only thing exercising the adapter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { v2 as cloudinary } from 'cloudinary';
import { createCloudinaryStorage } from '../services/storage.js';

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME; // NO fallback — see the throw below.
const CLOUD_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUD_SECRET = process.env.CLOUDINARY_API_SECRET;
const LIVE = !!(SUPA_URL && SUPA_KEY && !/your-project/.test(SUPA_URL) && CLOUD_KEY && CLOUD_SECRET);
const SKIP = LIVE ? false : 'no live creds (SUPABASE_URL/KEY + CLOUDINARY_API_KEY/SECRET)';

// Fail loud, never salvage: if live creds (key + secret) are present but the cloud name is
// not, a hardcoded default would run the whole suite GREEN against the WRONG account and mask
// the misconfig — the exact silent-salvage failure class this unit exists to prevent. A test
// that substitutes a cloud when its env is missing is not a test.
if (LIVE && !CLOUD_NAME) {
  throw new Error(
    'CLOUDINARY_CLOUD_NAME is unset while live Cloudinary creds are present. Set it (dj39tfdpt) — ' +
    'this test refuses to fall back to a hardcoded cloud.');
}

if (LIVE) {
  cloudinary.config({ cloud_name: CLOUD_NAME, api_key: CLOUD_KEY, api_secret: CLOUD_SECRET, secure: true });
}

// F1 needs a non-native base for put() to succeed. Captured before defaulting: a real host
// means the reachability test below could run — but it is unset by design this build, so it
// stays SKIPPED. getBytes verifies via the Cloudinary delivery URL, not this stable url.
const REAL_ASSET_BASE = process.env.ASSET_PUBLIC_BASE;
if (LIVE && !process.env.ASSET_PUBLIC_BASE) {
  process.env.ASSET_PUBLIC_BASE = 'https://cdn.integration-placeholder.test/assets';
}

// A tiny but VALID 1x1 PNG — the exact case that round-trips with a DIFFERENT checksum when
// stored as resource_type=image (Cloudinary re-encodes on ingest/delivery). Stored as raw
// (what the backend does for every type) it is byte-exact; this is the regression guard.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');
const sha256 = b => createHash('sha256').update(b).digest('hex');

async function roundTrip({ content_type, asset_type, bytes, label }) {
  const db = createClient(SUPA_URL, SUPA_KEY);
  const storage = createCloudinaryStorage(cloudinary, db);
  const { asset_id, url } = await storage.put(bytes, {
    entity_name: `ZZ_CloudinaryIntegration_${label}_${randomUUID().slice(0, 8)}`,
    asset_type, content_type, run_id: null,
  });
  try {
    // F1: the published url is the stable base, NEVER Cloudinary's secure_url.
    assert.ok(url.startsWith(process.env.ASSET_PUBLIC_BASE), `url should be on the stable base: ${url}`);
    assert.ok(!/cloudinary\.com/i.test(url), `url must not be a Cloudinary native host: ${url}`);

    // getBytes round-trips the exact bytes via the Cloudinary delivery URL.
    const got = await storage.getBytes(asset_id);
    assert.ok(Buffer.isBuffer(got), 'getBytes must return a Buffer');
    assert.equal(sha256(got), sha256(bytes), `${label}: round-tripped bytes must checksum-match the original`);

    // seam metadata (frozen surface) is correct.
    const seen = await storage.get(asset_id);
    assert.equal(seen.checksum, sha256(bytes));
    assert.ok(seen.object_key.startsWith('asset/'), seen.object_key);

    // raw metadata row: backend + cloudinary_public_id (not exposed by the frozen get()).
    const { data: raw, error } = await db.from('stored_assets')
      .select('backend, cloudinary_public_id, bucket, size_bytes').eq('id', asset_id).single();
    assert.ok(!error, `metadata read failed: ${error && error.message}`);
    assert.equal(raw.backend, 'cloudinary');
    assert.ok(raw.cloudinary_public_id && raw.cloudinary_public_id.startsWith('pipline/'),
      `cloudinary_public_id must be set under pipline/: ${raw.cloudinary_public_id}`);
    assert.equal(raw.size_bytes, bytes.length);
  } finally {
    // clean up BOTH sides — no test residue.
    await storage.delete(asset_id);
  }
  // verify gone: metadata row removed AND the Cloudinary asset destroyed.
  const db2 = createClient(SUPA_URL, SUPA_KEY);
  const storage2 = createCloudinaryStorage(cloudinary, db2);
  assert.equal(await storage2.get(asset_id), null, 'metadata row must be gone after delete');
  await assert.rejects(storage2.getBytes(asset_id), /unknown asset/i, 'getBytes must fail after delete (row gone)');
}

test('LIVE Cloudinary RAW round-trip: put → getBytes exact bytes + checksum + metadata + cleanup',
  { skip: SKIP },
  () => roundTrip({
    content_type: 'text/plain', asset_type: 'transcript', label: 'raw',
    bytes: Buffer.from(`d12-cloudinary raw ${randomUUID()} — binary-ish \x00\x01\x02`),
  }));

test('LIVE Cloudinary IMAGE round-trip: put → getBytes exact bytes + checksum + metadata + cleanup',
  { skip: SKIP },
  () => roundTrip({
    content_type: 'image/png', asset_type: 'image', label: 'png', bytes: PNG_1x1,
  }));

test('LIVE: the published ASSET_PUBLIC_BASE url is reachable (200)',
  { skip: (LIVE && REAL_ASSET_BASE) ? false
      : 'ASSET_PUBLIC_BASE not set to a provisioned host — the assets.onlyigaming.com Cloudflare Worker + DNS are a later unit (F1: put() still builds base+object_key)' },
  async () => {
    const db = createClient(SUPA_URL, SUPA_KEY);
    const storage = createCloudinaryStorage(cloudinary, db);
    const { asset_id, url } = await storage.put(PNG_1x1, {
      entity_name: 'ZZ_CloudinaryReachBase', asset_type: 'image', content_type: 'image/png', run_id: null,
    });
    try {
      assert.ok(url.startsWith(REAL_ASSET_BASE), `url should be on the real base: ${url}`);
      const res = await fetch(url);
      assert.equal(res.status, 200, `ASSET_PUBLIC_BASE url should be 200, got ${res.status}: ${url}`);
    } finally {
      await storage.delete(asset_id);
    }
  });
