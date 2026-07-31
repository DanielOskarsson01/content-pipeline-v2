/**
 * tools.storage seam tests — Unit #46 (asset path only).
 * Run: node --test server/tests/storageSeam.test.mjs
 *
 * These are UNIT tests: backend (bytes) and store (metadata) are injected
 * in-memory fakes, so no Supabase / network is required. The live round-trip
 * and anon-LIST-denied checks live in storageSeam.integration.mjs (env-gated).
 *
 * The load-bearing group is F1 (the fail-closed stable-host gate). It MUST be
 * RED against a naive `getPublicUrl()`-style impl (which returns a *.supabase.co
 * host and never throws) and GREEN only once put() constructs the URL from a
 * stable ASSET_PUBLIC_BASE and refuses to serve a native host. See
 * UNIT_D12_REVIEW.md F1 / UNIT_D12_STORAGE_DESIGN.md §0/§4-flag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  assetPublicUrl,
  slugifyEntity,
  buildObjectKey,
  createStorage,
} from '../services/storage.js';

const GOOD_BASE = 'https://cdn.example.com/assets';
const NATIVE_BASE = 'https://abcdproj.supabase.co/storage/v1/object/public/assets';
const NATIVE_CLOUDINARY_BASE = 'https://res.cloudinary.com/dj39tfdpt/image/upload';

// ── in-memory fakes (no network, no db) ───────────────────────────────────
// Fake CLOUDINARY backend: implements the widened bytes-backend interface (name,
// upload→{public_id}, row-addressed download/remove) and keys blobs by the returned
// public_id, exactly as the real adapter does. The real SDK adapter is proven live in
// storageCloudinary.integration.mjs; this fake proves the seam logic with no network.
function fakeCloudinaryBackend() {
  const blobs = new Map(); // cloudinary public_id -> Buffer
  return {
    name: 'cloudinary',
    calls: [],
    async upload(bucket, objectKey, bytes /* , contentType */) {
      const public_id = `pipline/${objectKey}`; // mimic folder=pipline + our object_key stem
      this.calls.push({ op: 'upload', public_id });
      blobs.set(public_id, Buffer.from(bytes));
      return { public_id };
    },
    async download(row) {
      const b = blobs.get(row.cloudinary_public_id);
      if (!b) throw new Error(`fake cloudinary: no object ${row.cloudinary_public_id}`);
      return Buffer.from(b);
    },
    async remove(row) {
      this.calls.push({ op: 'remove', public_id: row.cloudinary_public_id });
      blobs.delete(row.cloudinary_public_id);
    },
  };
}
function fakeStore() {
  const rows = new Map();
  return {
    async insert(row) { rows.set(row.id, { ...row }); },
    async getById(id) { const r = rows.get(id); return r ? { ...r } : null; },
    async deleteById(id) { rows.delete(id); },
    async list(f = {}) {
      return [...rows.values()]
        .filter(r =>
          (f.entity_name == null || r.entity_name === f.entity_name) &&
          (f.run_id == null || r.run_id === f.run_id) &&
          (f.asset_type == null || r.asset_type === f.asset_type) &&
          (f.source == null || r.source === f.source))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    },
  };
}
function withBase(v, fn) {
  const prev = process.env.ASSET_PUBLIC_BASE;
  if (v === undefined) delete process.env.ASSET_PUBLIC_BASE;
  else process.env.ASSET_PUBLIC_BASE = v;
  return (async () => { try { return await fn(); } finally {
    if (prev === undefined) delete process.env.ASSET_PUBLIC_BASE;
    else process.env.ASSET_PUBLIC_BASE = prev;
  } })();
}
function makeStorage(over = {}) {
  let n = 0;
  return createStorage({
    backend: over.backend || fakeCloudinaryBackend(),
    store: over.store || fakeStore(),
    genId: over.genId || (() => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`),
    now: () => '2026-07-12T00:00:00.000Z',
  });
}
const putArgs = (o = {}) => ({
  entity_name: 'Wazdan',
  asset_type: 'image',
  content_type: 'image/png',
  run_id: '6f2a1c9e-0000-4000-8000-000000000001',
  ...o,
});

// ── F1 — THE HARD GATE: fail-closed stable-host guarantee ──────────────────
test('F1: assetPublicUrl throws when ASSET_PUBLIC_BASE is unset', () =>
  withBase(undefined, () => {
    assert.throws(() => assetPublicUrl('asset/w/r/image/u.png'), /ASSET_PUBLIC_BASE/);
  }));

test('F1: assetPublicUrl throws when base is a Supabase-native host', () =>
  withBase(NATIVE_BASE, () => {
    assert.throws(() => assetPublicUrl('asset/w/r/image/u.png'), /supabase\.co|native/i);
  }));

test('F1: assetPublicUrl throws for a trailing-dot Supabase-native host', () =>
  withBase('https://abcdproj.supabase.co.', () => {
    assert.throws(() => assetPublicUrl('asset/x/y/z/u.png'), /supabase\.co|native/i);
  }));

test('F1: assetPublicUrl returns stable base + key when configured', () =>
  withBase(GOOD_BASE, () => {
    assert.equal(assetPublicUrl('asset/wazdan/r/image/u.png'),
      'https://cdn.example.com/assets/asset/wazdan/r/image/u.png');
  }));

// RED-AGAINST-NAIVE: the naive Cloudinary impl returns the SDK's secure_url
// (https://res.cloudinary.com/<cloud>/...). This test FAILS against that impl (url would
// contain cloudinary.com) and passes ONLY when put() builds the url from ASSET_PUBLIC_BASE.
test('F1: put().url is on ASSET_PUBLIC_BASE and never contains supabase.co or cloudinary.com', () =>
  withBase(GOOD_BASE, async () => {
    const s = makeStorage();
    const { url } = await s.put(Buffer.from('img-bytes'), putArgs());
    assert.ok(url.startsWith(GOOD_BASE), `url should start with base: ${url}`);
    assert.ok(!/supabase\.co/i.test(url), `url must not contain supabase.co: ${url}`);
    assert.ok(!/cloudinary\.com/i.test(url), `url must not contain a Cloudinary native host: ${url}`);
  }));

test('F1: assetPublicUrl throws when base is a Cloudinary-native host (res.cloudinary.com)', () =>
  withBase(NATIVE_CLOUDINARY_BASE, () => {
    assert.throws(() => assetPublicUrl('asset/w/r/image/u.png'), /cloudinary\.com|native/i);
  }));

test('F1: put() THROWS fail-closed when ASSET_PUBLIC_BASE is unset — and uploads NOTHING', () =>
  withBase(undefined, async () => {
    const backend = fakeCloudinaryBackend();
    const s = makeStorage({ backend });
    await assert.rejects(s.put(Buffer.from('x'), putArgs()), /ASSET_PUBLIC_BASE/);
    assert.equal(backend.calls.length, 0, 'no bytes may be uploaded when the URL is unserveable');
  }));

test('F1: put() THROWS fail-closed when ASSET_PUBLIC_BASE is a supabase.co host — and uploads NOTHING', () =>
  withBase(NATIVE_BASE, async () => {
    const backend = fakeCloudinaryBackend();
    const s = makeStorage({ backend });
    await assert.rejects(s.put(Buffer.from('x'), putArgs()), /supabase\.co|native/i);
    assert.equal(backend.calls.length, 0, 'no bytes may be uploaded when the host is native');
  }));

// Fail-closed for the Cloudinary native host too — the swap must not open a hole where a
// misconfigured base publishes res.cloudinary.com and uploads bytes anyway.
test('F1: put() THROWS fail-closed when ASSET_PUBLIC_BASE is a cloudinary.com host — and uploads NOTHING', () =>
  withBase(NATIVE_CLOUDINARY_BASE, async () => {
    const backend = fakeCloudinaryBackend();
    const s = makeStorage({ backend });
    await assert.rejects(s.put(Buffer.from('x'), putArgs()), /cloudinary\.com|native/i);
    assert.equal(backend.calls.length, 0, 'no bytes may be uploaded when the host is native');
  }));

// ── functional seam behaviour ──────────────────────────────────────────────
test('put → getBytes round-trips the exact bytes and checksum matches', () =>
  withBase(GOOD_BASE, async () => {
    const s = makeStorage();
    const bytes = Buffer.from('the actual asset payload — binary-ish \x00\x01\x02');
    const { asset_id } = await s.put(bytes, putArgs());
    const got = await s.getBytes(asset_id);
    assert.ok(Buffer.isBuffer(got));
    assert.equal(got.toString('binary'), bytes.toString('binary'));
    const row = await s.get(asset_id);
    assert.equal(row.checksum, createHash('sha256').update(bytes).digest('hex'));
  }));

test('metadata row is correct (backend/bucket/visibility/keys/size/type)', () =>
  withBase(GOOD_BASE, async () => {
    const store = fakeStore();
    const s = makeStorage({ store });
    const bytes = Buffer.from('hello');
    const { asset_id } = await s.put(bytes, putArgs());
    const row = await store.getById(asset_id);
    assert.equal(row.source, 'asset');
    assert.equal(row.backend, 'cloudinary');
    assert.ok(row.cloudinary_public_id && row.cloudinary_public_id.startsWith('pipline/'),
      `cloudinary_public_id must be set under pipline/: ${row.cloudinary_public_id}`);
    assert.equal(row.bucket, 'assets');
    assert.equal(row.visibility, 'public');
    assert.equal(row.entity_name, 'Wazdan');
    assert.equal(row.entity_key, 'wazdan');
    assert.equal(row.run_id, '6f2a1c9e-0000-4000-8000-000000000001');
    assert.equal(row.asset_type, 'image');
    assert.equal(row.content_type, 'image/png');
    assert.equal(row.size_bytes, bytes.length);
    assert.equal(row.checksum, createHash('sha256').update(bytes).digest('hex'));
    assert.ok(row.object_key.endsWith('.png'), row.object_key);
    assert.equal(row.url, `${GOOD_BASE}/${row.object_key}`);
  }));

test('object_key is backend-portable and non-enumerable (random uuid stem)', () =>
  withBase(GOOD_BASE, async () => {
    const s = makeStorage();
    const { asset_id } = await s.put(Buffer.from('x'), putArgs());
    const row = await s.get(asset_id);
    // <source>/<entity_key>/<run|corpus>/<type>/<uuid><ext>, legal on both Supabase & R2/S3
    assert.match(row.object_key,
      /^asset\/wazdan\/6f2a1c9e-0000-4000-8000-000000000001\/image\/[a-z0-9-]+\.png$/);
    assert.ok(!/[^a-z0-9\-_/.]/.test(row.object_key), `illegal key chars: ${row.object_key}`);
    assert.ok(row.object_key.length < 1024);
  }));

test('list filters by entity_name and by run_id', () =>
  withBase(GOOD_BASE, async () => {
    const s = makeStorage();
    await s.put(Buffer.from('a'), putArgs({ entity_name: 'Wazdan', run_id: 'run-A' }));
    await s.put(Buffer.from('b'), putArgs({ entity_name: 'Betsson', run_id: 'run-A' }));
    await s.put(Buffer.from('c'), putArgs({ entity_name: 'Wazdan', run_id: 'run-B' }));
    assert.equal((await s.list({ entity_name: 'Wazdan' })).length, 2);
    assert.equal((await s.list({ entity_name: 'Betsson' })).length, 1);
    assert.equal((await s.list({ run_id: 'run-A' })).length, 2);
    assert.equal((await s.list({ run_id: 'run-B', entity_name: 'Wazdan' })).length, 1);
  }));

test('delete removes both the bytes and the metadata row', () =>
  withBase(GOOD_BASE, async () => {
    const backend = fakeCloudinaryBackend();
    const s = makeStorage({ backend });
    const { asset_id } = await s.put(Buffer.from('x'), putArgs());
    assert.deepEqual(await s.delete(asset_id), { deleted: true });
    assert.equal(await s.get(asset_id), null);
    await assert.rejects(s.getBytes(asset_id), /not found|no such|unknown asset/i);
    assert.ok(backend.calls.some(c => c.op === 'remove'));
  }));

test('put() removes the uploaded bytes if the metadata insert fails (no invisible orphan)', () =>
  withBase(GOOD_BASE, async () => {
    const backend = fakeCloudinaryBackend();
    const store = { insert: async () => { throw new Error('db down'); },
      getById: async () => null, deleteById: async () => {}, list: async () => [] };
    const s = makeStorage({ backend, store });
    await assert.rejects(s.put(Buffer.from('x'), putArgs()), /db down/);
    assert.ok(backend.calls.some(c => c.op === 'upload'), 'should have uploaded');
    assert.ok(backend.calls.some(c => c.op === 'remove'), 'must clean up the orphan on insert failure');
  }));

// ── scope guards (#46 is assets-only; corpus is deferred to D-corpus) ──────
test('put() refuses source=corpus (corpus write path deferred to D-corpus)', () =>
  withBase(GOOD_BASE, async () => {
    const s = makeStorage();
    await assert.rejects(s.put(Buffer.from('x'), putArgs({ source: 'corpus', source_url: 'https://x' })),
      /corpus|D-corpus/i);
  }));

test('put() refuses a private (non-public) asset — assets must be publicly fetchable', () =>
  withBase(GOOD_BASE, async () => {
    const s = makeStorage();
    await assert.rejects(s.put(Buffer.from('x'), putArgs({ visibility: 'private' })), /public/i);
  }));

test('put() validates required args', () =>
  withBase(GOOD_BASE, async () => {
    const s = makeStorage();
    await assert.rejects(s.put(Buffer.from('x'), putArgs({ entity_name: undefined })), /entity_name/);
    await assert.rejects(s.put(Buffer.from('x'), putArgs({ asset_type: undefined })), /asset_type/);
    await assert.rejects(s.put(Buffer.from('x'), putArgs({ content_type: undefined })), /content_type/);
    await assert.rejects(s.put('not-a-buffer', putArgs()), /bytes|buffer/i);
  }));

// ── helpers ────────────────────────────────────────────────────────────────
test('slugifyEntity collapses case/space/punctuation/accents to a key', () => {
  assert.equal(slugifyEntity('Evolution Gaming'), 'evolution-gaming');
  assert.equal(slugifyEntity('  Betsson AB!! '), 'betsson-ab');
  assert.equal(slugifyEntity('Café Casino'), 'cafe-casino');
  assert.equal(slugifyEntity(''), 'entity');
});

test('buildObjectKey composes the portable scheme', () => {
  const key = buildObjectKey({
    source: 'asset', entityKey: 'wazdan', runId: 'run-1', assetType: 'image',
    contentType: 'image/png', id: 'aaaa',
  });
  assert.equal(key, 'asset/wazdan/run-1/image/aaaa.png');
});

// ── SEAM (design test #7): no module reaches a storage SDK or builds a backend URL ──
// Static build-gate over the modules repo. Rule-13 enforcement (design §1.3). Skips
// gracefully if the modules repo isn't checked out in this environment.
function resolveModulesDir() {
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const candidates = [
    process.env.MODULES_PATH ? resolve(repoRoot, process.env.MODULES_PATH) : null,
    resolve(repoRoot, '..', 'content-pipeline-modules-v2'),
  ].filter(Boolean);
  for (const d of candidates) if (existsSync(join(d, 'modules'))) return join(d, 'modules');
  return null;
}
function* walkJs(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) yield* walkJs(full);
    else if (ent.name.endsWith('.js')) yield full;
  }
}
const MODULES_DIR = resolveModulesDir();
// Extended for the Cloudinary swap: `cloudinary` catches the SDK import (import/require) and
// `res\.cloudinary\.com` catches hand-built delivery URLs — otherwise a module could bypass
// the seam via the Cloudinary SDK the same way the Supabase/R2/S3 tokens already prevent (scope §8.8).
const SEAM_FORBIDDEN =
  /@supabase\/supabase-js|storage\.from\(|S3Client|@aws-sdk|ASSET_PUBLIC_BASE|\.supabase\.co\/storage|r2\.cloudflarestorage\.com|cloudinary|res\.cloudinary\.com/;

// Proves the SEAM regex actually bites the new tokens even when the modules repo isn't present
// (the grep test below skips without it, so without this the extension could silently no-op).
test('SEAM regex forbids the Cloudinary SDK import and native delivery host', () => {
  assert.ok(SEAM_FORBIDDEN.test("import { v2 as cloudinary } from 'cloudinary'"), 'must forbid the cloudinary import');
  assert.ok(SEAM_FORBIDDEN.test("const c = require('cloudinary')"), 'must forbid require(cloudinary)');
  assert.ok(SEAM_FORBIDDEN.test('const u = `https://res.cloudinary.com/${cloud}/image/upload/${id}`'), 'must forbid res.cloudinary.com URLs');
  // sanity: an ordinary module line is not falsely flagged
  assert.ok(!SEAM_FORBIDDEN.test("const items = input.entity.urls.map(u => u.trim());"));
});

test('SEAM: modules import only tools.storage, never a backend SDK or URL (design #7)',
  { skip: MODULES_DIR ? false : 'modules repo not present in this environment' },
  () => {
    const violations = [];
    for (const file of walkJs(MODULES_DIR)) {
      readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
        if (SEAM_FORBIDDEN.test(line)) violations.push(`${file.replace(MODULES_DIR, 'modules')}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(violations, [],
      `modules must reach durable storage ONLY through tools.storage:\n${violations.join('\n')}`);
  });
