/**
 * Postmortem storage (TUNING-SESSIONS v1, T5).
 *
 * A tuning postmortem is a small JSON file that must be DURABLE — survive a
 * closed tab, an abandoned session, a deploy, and retention. The rsync deploy
 * (--delete) wipes everything under /opt/content-pipeline-v2 except a few
 * excludes, so a postmortem written INSIDE the tree is not durable. Two backends
 * a server process can actually reach durably:
 *
 *   - POSTMORTEM_DIR   : a filesystem dir OUTSIDE the deployed tree (survives
 *                        deploys). Atomic temp-write + rename, so an abandoned
 *                        mid-write leaves the PRIOR complete file intact.
 *   - POSTMORTEM_BUCKET: a Supabase Storage bucket (reachable from Hetzner AND
 *                        the local Mac harness — same project; survives deploys
 *                        and retention). upsert replaces the whole object
 *                        atomically, so a killed write leaves the prior object.
 *
 * If NEITHER is configured, createPostmortemStore returns null and the caller
 * logs + skips (best-effort — an accept must not fail because the durable store
 * is unconfigured). "No postmortem written" is logged, never silent.
 */
import fs from 'node:fs';
import path from 'node:path';

function createFsStore(dir) {
  return {
    kind: 'fs',
    location: dir,
    async put(key, json) {
      const full = path.join(dir, key);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const tmp = `${full}.tmp`;
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, full); // atomic on POSIX
      return { location: full, bytes: Buffer.byteLength(json) };
    },
    async get(key) {
      try { return fs.readFileSync(path.join(dir, key), 'utf8'); } catch { return null; }
    },
  };
}

function createSupabaseStorageStore(db, bucket) {
  return {
    kind: 'supabase',
    location: bucket,
    async put(key, json) {
      const { error } = await db.storage.from(bucket)
        .upload(key, Buffer.from(json), { contentType: 'application/json', upsert: true });
      if (error) throw new Error(`postmortem upload to ${bucket}/${key} failed: ${error.message}`);
      return { location: `${bucket}/${key}`, bytes: Buffer.byteLength(json) };
    },
    async get(key) {
      const { data, error } = await db.storage.from(bucket).download(key);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer()).toString('utf8');
    },
  };
}

/** In-memory backend for hermetic tests. */
export function createMemoryStore() {
  const map = new Map();
  return {
    kind: 'memory', location: 'memory', map,
    async put(key, json) { map.set(key, json); return { location: `memory/${key}`, bytes: Buffer.byteLength(json) }; },
    async get(key) { return map.has(key) ? map.get(key) : null; },
  };
}

/**
 * Pick a durable backend from env, or null if none configured.
 * POSTMORTEM_DIR wins (used by the local harness); else POSTMORTEM_BUCKET.
 */
export function createPostmortemStore({ db, env = process.env } = {}) {
  if (env.POSTMORTEM_DIR) return createFsStore(env.POSTMORTEM_DIR);
  if (env.POSTMORTEM_BUCKET && db?.storage) return createSupabaseStorageStore(db, env.POSTMORTEM_BUCKET);
  return null;
}

/**
 * Which durable backend the env selects, for a LOUD startup signal. Mirrors
 * createPostmortemStore's DIR-wins-over-BUCKET precedence (env presence only —
 * it does NOT re-check db.storage, so it reports intent, not reachability) so an
 * unconfigured store (writer = guaranteed no-op) is announced at boot rather
 * than only discovered when a postmortem silently fails to appear.
 * Returns { configured, kind, target }.
 */
export function describePostmortemStore(env = process.env) {
  if (env.POSTMORTEM_DIR) return { configured: true, kind: 'fs', target: env.POSTMORTEM_DIR };
  if (env.POSTMORTEM_BUCKET) return { configured: true, kind: 'supabase', target: env.POSTMORTEM_BUCKET };
  return { configured: false, kind: null, target: null };
}

/** Emit the loud boot-time line. Extracted so a test can assert both branches. */
export function logPostmortemStoreStatus(env = process.env, log = console) {
  const s = describePostmortemStore(env);
  if (s.configured) {
    log.log(`[tuning] postmortem store configured: ${s.kind} -> ${s.target}`);
  } else {
    log.warn('[tuning] ⚠️  postmortem store UNCONFIGURED — tuning postmortems will NOT be written. Set POSTMORTEM_BUCKET (Supabase Storage bucket) or POSTMORTEM_DIR in .env and restart pipeline-api.');
  }
  return s;
}
