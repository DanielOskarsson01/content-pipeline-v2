/**
 * tools.storage — the asset-persistence seam (Unit #46 / design D12).
 *
 * Modules NEVER touch a storage backend. They call tools.storage and get back
 * an opaque { asset_id, url }. Supabase Storage lives behind this file today; an
 * R2 backend swaps in later with zero module changes (design §0/§4). Backends
 * and the metadata store are injected into createStorage() so the seam is
 * unit-testable without a live Supabase.
 *
 * Scope (#46): ASSET path only (source='asset', public bucket). The corpus write
 * path is DEFERRED to D-corpus — it needs a real cross-run entity registry, not
 * the name-slug entity_key (UNIT_D12_REVIEW.md Q2/F4). put() refuses source='corpus'.
 *
 * F1 — the irreversible guarantee, made fail-closed: the public URL is built from
 * a stable, re-pointable ASSET_PUBLIC_BASE host we control — NEVER the Supabase
 * native host. If ASSET_PUBLIC_BASE is unset/empty or resolves to *.supabase.co,
 * put() THROWS rather than publish a URL that an R2 migration would break
 * (design §4-flag/§5, review F1).
 */
import { createHash, randomUUID } from 'node:crypto';

export const ASSET_BUCKET = process.env.ASSET_BUCKET || 'assets';

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/svg+xml': 'svg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/wav': 'wav', 'audio/ogg': 'ogg', 'video/mp4': 'mp4', 'application/pdf': 'pdf',
  'text/html': 'html', 'application/json': 'json', 'text/plain': 'txt',
};

/** Slugify a free-text entity name into a key-safe, backend-portable segment. */
export function slugifyEntity(name) {
  const s = String(name ?? '')
    .normalize('NFKD').replace(/\p{M}/gu, '')   // strip accents (Unicode combining marks)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'entity';
}

function extFor(contentType, filename) {
  const mime = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  const m = String(filename || '').match(/\.([a-z0-9]{1,8})$/i);
  return m ? m[1].toLowerCase() : 'bin';
}

// Cloudinary folder ALL pipeline assets live under. Bojan's spelling — "pipline" (sic),
// accepted as-is so the account namespace matches what he set up.
const CLOUDINARY_FOLDER = 'pipline';

// EVERY asset is stored as resource_type='raw'. tools.storage is a BYTE-IDENTITY store
// (checksum-based dedup/versioning, design F2; getBytes = "the exact bytes"), and Cloudinary's
// image/video pipelines process on ingest and re-encode on delivery — a PNG stored as 'image'
// round-trips with a DIFFERENT checksum (proven live 2026-07-15); stored as 'raw' it is
// byte-exact. No account-setting-independent flag forces the byte-exact original back for an
// image resource, so 'raw' is the only mechanism that preserves the seam's contract.
//
// This deviates from UNIT_D12_CLOUDINARY_SWAP_SCOPE §3's per-type mapping, which assumed
// R2-like fidelity — the seam's byte-identity contract wins. Trade-off (decided): we forgo
// Cloudinary's on-delivery image/video transforms; this seam is durable storage, not a
// transform CDN. The stable-host Worker (later unit) sets Content-Type from stored content_type,
// so delivery is unaffected. On-the-fly transforms, if ever wanted, are a separate contract-
// changing unit that would consciously accept non-identity.
const CLOUDINARY_RESOURCE_TYPE = 'raw';

/**
 * Backend-portable object key: <source>/<entity_key>/<run|corpus>/<type>/<uuid><ext>.
 * lowercase, charset [a-z0-9-_/.], random uuid stem => not enumerable, byte-identical on R2.
 */
export function buildObjectKey({ source = 'asset', entityKey, runId, assetType, contentType, filename, id }) {
  const runSeg = source === 'corpus' ? 'corpus' : (runId || 'norun');
  const typeSeg = slugifyEntity(assetType);
  return `${source}/${entityKey}/${runSeg}/${typeSeg}/${id}.${extFor(contentType, filename)}`;
}

/**
 * F1 — fail-closed public-URL construction. The URL is served from a stable,
 * re-pointable host we control (ASSET_PUBLIC_BASE), NEVER the backend-native host.
 * Throws if ASSET_PUBLIC_BASE is unset/empty or resolves to *.supabase.co, because
 * publishing a native host silently forfeits the zero-re-author guarantee the moment
 * an R2 migration changes the host (design §4-flag/§5, review F1). This is the one
 * irreversible failure mode, so it fails loud and early rather than "working in dev".
 */
export function assetPublicUrl(objectKey) {
  const base = String(process.env.ASSET_PUBLIC_BASE || '').trim().replace(/[/.]+$/, ''); // strip trailing / and . (a trailing-dot FQDN still resolves to the native host)
  if (!base) {
    throw new Error(
      'ASSET_PUBLIC_BASE is unset — refusing to publish an asset URL. A stable, ' +
      're-pointable host (custom domain / CDN) is required from the first published ' +
      'asset (design §4-flag / §5, review F1). There is no dev fallback: a native ' +
      'host baked into published content is unrecoverable on R2 migration.');
  }
  if (/(^|\/\/|\.)(supabase\.co|cloudinary\.com)([:/]|$)/i.test(base)) {
    throw new Error(
      `ASSET_PUBLIC_BASE ("${base}") resolves to a backend-native host (Supabase / Cloudinary). ` +
      'Publishing the native host forfeits the zero-re-author guarantee on a backend migration ' +
      '(review F1). Point ASSET_PUBLIC_BASE at a custom domain / CDN you control.');
  }
  return `${base}/${objectKey}`;
}

// ── bytes-backend interface (below the seam, injected into createStorage) ──
// name                                → written to stored_assets.backend
// upload(bucket, key, bytes, ct)      → { public_id }  (null for key-addressed backends)
// download(row) / remove(row)         → take the full metadata row (Cloudinary needs
//                                        cloudinary_public_id, which (bucket,key) can't carry).
// get()/list() never touch the backend — they are Postgres-only (scope §2).

// ── real Supabase adapter (dormant fallback once the call site swaps to Cloudinary). ──
export function createSupabaseBackend(db) {
  return {
    name: 'supabase',
    async upload(bucket, key, bytes, contentType) {
      const { error } = await db.storage.from(bucket).upload(key, bytes, { contentType, upsert: false });
      if (error) throw new Error(`tools.storage: upload to ${bucket}/${key} failed: ${error.message}`);
      return { public_id: null }; // Supabase is key-addressed; object_key is the physical handle.
    },
    async download(row) {
      const { data, error } = await db.storage.from(row.bucket).download(row.object_key);
      if (error) throw new Error(`tools.storage: download of ${row.bucket}/${row.object_key} failed: ${error.message}`);
      return Buffer.from(await data.arrayBuffer());
    },
    async remove(row) {
      const { error } = await db.storage.from(row.bucket).remove([row.object_key]);
      if (error) throw new Error(`tools.storage: remove of ${row.bucket}/${row.object_key} failed: ${error.message}`);
    },
  };
}

// ── real Cloudinary adapter (the swapped-in bytes backend). `cloudinary` = a configured
// v2 client, injected (createCloudinaryStorage / tests), so this file never hard-imports
// the SDK — the seam stays dependency-injection-pure, exactly like the Supabase side. ──
export function createCloudinaryBackend(cloudinary) {
  return {
    name: 'cloudinary',
    async upload(bucket, objectKey, bytes /* , contentType */) {
      // bucket is ignored (Cloudinary has no buckets); the row keeps ASSET_BUCKET as a cosmetic
      // NOT-NULL sentinel (scope §4). All assets go under folder CLOUDINARY_FOLDER as raw.
      // raw keeps the full name, so public_id = object_key WITH its extension. We STORE whatever
      // upload returns (result.public_id) and NEVER re-derive it later (scope §3/§4).
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { resource_type: CLOUDINARY_RESOURCE_TYPE, folder: CLOUDINARY_FOLDER, public_id: objectKey,
            overwrite: false, use_filename: false, unique_filename: false },
          (err, res) => (err
            ? reject(new Error(`tools.storage: cloudinary upload of ${objectKey} failed: ${err.message}`))
            : resolve(res)),
        ).end(bytes);
      });
      return { public_id: result.public_id };
    },
    async download(row) {
      // ponytail: Admin API resource() returns Cloudinary's own secure_url — robust vs
      // hand-rebuilding the raw delivery URL. Rate-limited (Admin API); a cloudinary.url()
      // fast-path is the upgrade if getBytes ever gets hot. Public assets → no signing.
      const info = await cloudinary.api.resource(row.cloudinary_public_id, { resource_type: CLOUDINARY_RESOURCE_TYPE });
      const res = await fetch(info.secure_url);
      if (!res.ok) throw new Error(`tools.storage: cloudinary download of ${row.cloudinary_public_id} failed: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async remove(row) {
      const res = await cloudinary.uploader.destroy(row.cloudinary_public_id, { resource_type: CLOUDINARY_RESOURCE_TYPE, invalidate: true });
      // 'ok' = deleted; 'not found' = already gone (idempotent). Anything else is a real failure.
      if (res.result !== 'ok' && res.result !== 'not found') {
        throw new Error(`tools.storage: cloudinary destroy of ${row.cloudinary_public_id} failed: ${res.result}`);
      }
    },
  };
}

const STORE_COLUMNS =
  'id, source, entity_name, entity_key, run_id, asset_type, backend, bucket, object_key, url, ' +
  'visibility, content_type, size_bytes, checksum, source_url, dedup_key, cloudinary_public_id, created_at';

export function createSupabaseStore(db) {
  return {
    async insert(row) {
      const { error } = await db.from('stored_assets').insert(row);
      if (error) throw new Error(`tools.storage: metadata insert failed: ${error.message}`);
    },
    async getById(id) {
      const { data, error } = await db.from('stored_assets').select(STORE_COLUMNS).eq('id', id).maybeSingle();
      if (error) throw new Error(`tools.storage: metadata read failed: ${error.message}`);
      return data || null;
    },
    async deleteById(id) {
      const { error } = await db.from('stored_assets').delete().eq('id', id);
      if (error) throw new Error(`tools.storage: metadata delete failed: ${error.message}`);
    },
    async list(f = {}) {
      let q = db.from('stored_assets').select(STORE_COLUMNS);
      if (f.source != null) q = q.eq('source', f.source);
      if (f.entity_name != null) q = q.eq('entity_name', f.entity_name);
      if (f.run_id != null) q = q.eq('run_id', f.run_id);
      if (f.asset_type != null) q = q.eq('asset_type', f.asset_type);
      const { data, error } = await q.order('created_at', { ascending: false });
      if (error) throw new Error(`tools.storage: list failed: ${error.message}`);
      return data || [];
    },
  };
}

/**
 * The module-facing seam. Returns { put, get, getBytes, delete, list }.
 * backend / store are injected (real = Supabase adapters above; tests inject fakes).
 */
export function createStorage({ backend, store, genId = randomUUID, now = () => new Date().toISOString() }) {
  async function put(bytes, opts = {}) {
    if (!Buffer.isBuffer(bytes)) throw new Error('tools.storage.put: bytes must be a Buffer');
    const { entity_name, asset_type, content_type, run_id = null, filename } = opts;
    if (!entity_name) throw new Error('tools.storage.put: entity_name is required');
    if (!asset_type) throw new Error('tools.storage.put: asset_type is required');
    if (!content_type) throw new Error('tools.storage.put: content_type is required');

    const source = opts.source || 'asset';
    if (source !== 'asset') {
      throw new Error(`tools.storage.put: source='${source}' is unsupported in #46 — the corpus write path is deferred to D-corpus (needs a real entity registry).`);
    }
    const visibility = opts.visibility || 'public';
    if (visibility !== 'public') {
      throw new Error(`tools.storage.put: an asset must be public (got visibility='${visibility}') — a published article must fetch it without auth.`);
    }

    const id = genId();
    const entity_key = slugifyEntity(entity_name);
    const object_key = buildObjectKey({ source, entityKey: entity_key, runId: run_id, assetType: asset_type, contentType: content_type, filename, id });

    // F1: construct + validate the public URL BEFORE uploading — fail-closed, no orphaned bytes.
    const url = assetPublicUrl(object_key);

    const bucket = ASSET_BUCKET;
    const checksum = opts.checksum || createHash('sha256').update(bytes).digest('hex');

    // The backend returns its physical handle: Cloudinary's public_id (authoritative for
    // destroy/download, not re-derivable from object_key), null for key-addressed backends.
    const { public_id = null } = (await backend.upload(bucket, object_key, bytes, content_type)) || {};

    const row = {
      id, source, entity_name, entity_key, run_id, asset_type,
      backend: backend.name || 'supabase', bucket, object_key, url, visibility,
      content_type, size_bytes: bytes.length, checksum,
      source_url: opts.source_url || null, dedup_key: null,
      cloudinary_public_id: public_id,
      created_at: now(),
    };
    try {
      await store.insert(row);
    } catch (err) {
      // ponytail: best-effort orphan cleanup. An insert failure AFTER a successful
      // upload leaves bytes with no metadata row — invisible to any row-driven
      // retention sweeper (M1), so this is the only place they can be reclaimed.
      // Best-effort, not transactional: swallow the secondary error, rethrow the real one.
      try { await backend.remove(row); } catch { /* ignore */ }
      throw err;
    }
    return { asset_id: id, url };
  }

  async function get(asset_id) {
    const row = await store.getById(asset_id);
    if (!row) return null;
    return {
      asset_id: row.id, url: row.url, asset_type: row.asset_type, content_type: row.content_type,
      size_bytes: row.size_bytes, entity_name: row.entity_name, run_id: row.run_id, source: row.source,
      visibility: row.visibility, checksum: row.checksum, object_key: row.object_key, created_at: row.created_at,
    };
  }

  async function getBytes(asset_id) {
    const row = await store.getById(asset_id);
    if (!row) throw new Error(`tools.storage.getBytes: unknown asset ${asset_id}`);
    return backend.download(row);
  }

  async function del(asset_id) {
    const row = await store.getById(asset_id);
    if (!row) throw new Error(`tools.storage.delete: unknown asset ${asset_id}`);
    await backend.remove(row);
    await store.deleteById(asset_id);
    return { deleted: true };
  }

  async function list(filter = {}) {
    const rows = await store.list({
      source: filter.source || 'asset',
      entity_name: filter.entity_name, run_id: filter.run_id, asset_type: filter.asset_type,
    });
    return rows.map(r => ({
      asset_id: r.id, url: r.url, asset_type: r.asset_type,
      content_type: r.content_type, size_bytes: r.size_bytes, created_at: r.created_at,
    }));
  }

  return { put, get, getBytes, delete: del, list };
}

/** Convenience wiring: the Supabase-backed seam (dormant fallback; still buildTools' wiring
 *  until the call site swaps to Cloudinary in the later Path-B deploy). */
export function createSupabaseStorage(db) {
  return createStorage({ backend: createSupabaseBackend(db), store: createSupabaseStore(db) });
}

/** Convenience wiring: the live Cloudinary-backed seam. Bytes live in Cloudinary; the
 *  metadata store stays Postgres (`db`), so both are injected (scope §8.6). */
export function createCloudinaryStorage(cloudinary, db) {
  return createStorage({ backend: createCloudinaryBackend(cloudinary), store: createSupabaseStore(db) });
}
