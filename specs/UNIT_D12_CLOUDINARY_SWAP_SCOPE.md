# UNIT_D12_CLOUDINARY_SWAP_SCOPE — scoping the Supabase-Storage → Cloudinary backend swap

**Status:** READ-ONLY investigation. No code changed, no build, no Cloudinary calls.
**Repo:** `content-pipeline-v2` (dev worktree) · **branch:** `auto-21-w2-2026-06-25` · **HEAD:** `b2832ad` (`feat(#46): tools.storage asset-persistence seam + stored_assets migration`)
**Authoritative source:** the deployed #46 code (below). Every claim cites `file:line`.
**Decision being scoped:** swap the *asset bytes* backend from Supabase Storage to Cloudinary **without** changing the module-facing seam, the metadata-table design, the F1 stable-host guarantee, or the `assets.onlyigaming.com` plan. Scoping only — the build is a separate, gated unit.

---

## 0. Verification notes (read this first)

- **Environment verified before investigation:** repo ✓, branch `auto-21-w2-2026-06-25` ✓, clean tree ✓, local == `origin/auto-21-w2-2026-06-25` ✓ (`b2832ad…`).
- **Two artifacts the brief cited DO NOT EXIST anywhere on disk or in git history** — flagged per "never fabricate missing artifacts":
  - `specs/UNIT_D12_STORAGE_DESIGN.md` and `UNIT_D12_REVIEW.md` — not in this repo, not on `main`/other branches, not in the Dropbox `Content-Pipeline/specs/` folder. The migration header references them (`20260712000000_d12_stored_assets.sql:3`) but the files were never committed. **No loss:** the #46 code is self-documenting (F1/F2/F3 gates are inline) and is the authoritative contract anyway. This doc is built from the code, not the missing specs.
  - There was **no `specs/` directory** on this branch before this doc (`git ls-files 'specs/*'` → 0). This file creates it. **CLAUDE.md tension:** the repo CLAUDE.md says "Do NOT create a `specs/` folder inside this repo" (that rule was about *copying canonical specs* and causing divergence). The task brief explicitly instructs committing this **new** scoping doc to `specs/` and notes "specs is hook-less." Following the explicit brief; flagging the tension for Daniel to veto.
  - **"Hook-less" correction:** this worktree DOES have an active `commit-msg` hook (`.git/hooks/commit-msg`). It has two sections. Section 2 (code-path-trace attestation) is scoped to routing files (`routingHandler.js` / `autoExecutor.js` / `batchWorker.js` / `stageWorker.js` / routing-RPC SQL) and correctly does **not** fire for a `specs/` doc — so the brief's "hook-less" holds for *that* half. But Section 1 (decision_log enforcement) is **global** — every commit needs a `decision_log` row in the command-center Supabase within 15 min, and it blocked this docs commit until one was written. Noting so future specs commits here expect the decision_log step.

---

## 1. The seam contract as built (what a Cloudinary backend MUST satisfy unchanged)

The module-facing seam is `createStorage(...)` returning **five methods** (`server/services/storage.js:137`, `:221`):

| Method | Signature | Returns |
|---|---|---|
| `put` | `put(bytes: Buffer, opts)` | `{ asset_id, url }` (`storage.js:183`) |
| `get` | `get(asset_id)` | metadata object or `null` (`storage.js:186–194`) |
| `getBytes` | `getBytes(asset_id)` | `Buffer` (`storage.js:196–200`) |
| `delete` | `delete(asset_id)` | `{ deleted: true }` (`storage.js:202–208`) |
| `list` | `list(filter)` | `[{ asset_id, url, asset_type, content_type, size_bytes, created_at }]` (`storage.js:210–219`) |

**`put` opts** (`storage.js:140–151`): required `entity_name`, `asset_type`, `content_type`; optional `run_id`, `filename`, `checksum`, `source_url`; `source` defaults `'asset'` and **only `'asset'` is accepted** (`:146`); `visibility` defaults `'public'` and **only `'public'` is accepted** (`:150`).

**The opaque return `{ asset_id, url }`** is the whole contract modules see (`storage.js:183`). `asset_id` is the `stored_assets.id` UUID; `url` is the stable public URL. Modules never receive a bucket, object_key, public_id, or backend host.

**Who depends on it:** exactly **one** non-test consumer — `buildTools()` in `server/workers/stageWorker.js:356` (`const storage = createSupabaseStorage(db)`), which puts `storage` into the `tools` object handed to every submodule's `execute()` (`stageWorker.js:358`). Plus the two test files. **Blast radius on consumers = one line in stageWorker + two tests.**

**Rule-13 seam enforcement** (design "no module reaches a storage SDK") is a static build-gate test: `storageSeam.test.mjs:280–294` greps the modules repo for forbidden tokens (`@supabase/supabase-js`, `storage.from(`, `S3Client`, `@aws-sdk`, `ASSET_PUBLIC_BASE`, `.supabase.co/storage`, `r2.cloudflarestorage.com`). **This regex does NOT yet forbid Cloudinary** — see §8 (must add `cloudinary` / `res.cloudinary.com` or the swap quietly opens a seam bypass).

> **A Cloudinary backend must keep all of the above byte-identical.** Nothing in this table changes. What changes lives *below* the seam.

---

## 2. What the Supabase backend does, operation by operation (the spec a Cloudinary adapter re-implements)

Critical architecture fact: **the bytes backend and the metadata store are two separate injected objects** (`createStorage({ backend, store })`, `storage.js:137`). Only three of the five seam methods touch the **bytes backend**; the other two are pure **metadata-store** (Postgres) reads and are backend-agnostic already.

The bytes-backend interface is **exactly three methods** (`createSupabaseBackend`, `storage.js:83–99`):

```
upload(bucket, key, bytes, contentType)   → storage.js:85–88   db.storage.from(bucket).upload(key, bytes, {contentType, upsert:false})
download(bucket, key)                      → storage.js:89–93   db.storage.from(bucket).download(key) → Buffer
remove(bucket, key)                        → storage.js:94–97   db.storage.from(bucket).remove([key])
```

Operation-by-operation:

- **`put`** (`storage.js:138–184`): validate args → `id = genId()` → `entity_key = slugifyEntity(entity_name)` → `object_key = buildObjectKey(...)` (`storage.js:156`) → **`url = assetPublicUrl(object_key)` BEFORE upload** (F1 fail-closed, `storage.js:159`) → `checksum = sha256(bytes)` computed here, **backend-independent** (`storage.js:162`) → `backend.upload(bucket, object_key, bytes, content_type)` (`:164`) → `store.insert(row)` with `backend:'supabase'`, `size_bytes: bytes.length` (`:166–174`) → on insert failure, **best-effort `backend.remove` to avoid an invisible orphan** (`:176–181`) → return `{ asset_id: id, url }`.
- **`get`** (`storage.js:186–194`): **`store.getById` only — NO bytes backend.** Backend-agnostic.
- **`getBytes`** (`storage.js:196–200`): `store.getById` → `backend.download(row.bucket, row.object_key)`.
- **`delete`** (`storage.js:202–208`): `store.getById` → `backend.remove(row.bucket, row.object_key)` → `store.deleteById`.
- **`list`** (`storage.js:210–219`): **`store.list` only — NO bytes backend.** Backend-agnostic.

**`object_key` construction** (`buildObjectKey`, `storage.js:50–54`): `<source>/<entity_key>/<run|corpus>/<type>/<uuid>.<ext>`, lowercase, charset `[a-z0-9-_/.]`, random-uuid stem (non-enumerable), designed byte-identical on any S3-like backend. Example: `asset/wazdan/<run_id>/image/<uuid>.png`.

**URL construction / F1 gate** (`assetPublicUrl`, `storage.js:64–80`): `url = ASSET_PUBLIC_BASE + '/' + object_key`. Throws if `ASSET_PUBLIC_BASE` is unset (`:66–72`) or matches `/(^|\/\/|\.)supabase\.co([:/]|$)/i` (`:73–78`). This is the whole F1 mechanism — see §5.

---

## 3. What a Cloudinary backend adapter would need (conceptual mapping — NOT written here)

Only the **3-method bytes backend** (`upload/download/remove`) is re-implemented as `createCloudinaryBackend(...)`. `get`/`list` are untouched (metadata-only). Concept map:

| Seam-internal op | Supabase today | Cloudinary equivalent (concept) | Difference the code must handle |
|---|---|---|---|
| `upload` | `storage.from(bucket).upload(key, bytes)` (`storage.js:86`) | `cloudinary.uploader.upload_stream({ resource_type, public_id, folder, overwrite:false }, cb)` fed the Buffer (or a base64 data-URI to `.upload`) | Returns **`public_id` + `secure_url`** (Cloudinary's identity, authoritative). No bucket concept. `resource_type` must be chosen (see below). |
| `download` (getBytes) | `storage.from(bucket).download(key)` (`storage.js:90`) | **No SDK "download-by-key"** — HTTP `GET` the delivery URL (our assets are public, so no signing). We already store `url`, so this is a plain fetch. | Different *mechanism* (HTTP GET, not SDK). Needs the delivery URL or `public_id`+`resource_type`+`format`, not `(bucket, key)`. |
| `remove` (delete) | `storage.from(bucket).remove([key])` (`storage.js:95`) | `cloudinary.uploader.destroy(public_id, { resource_type, invalidate:true })` | **Needs `public_id` + `resource_type`, NOT `object_key`.** This is the load-bearing difference (see §4). |
| `list` | — (never hits backend; `store.list`, `storage.js:210`) | **N/A — our `list()` queries Postgres, not the backend.** Cloudinary's Admin API `api.resources` is irrelevant. | **Zero change.** |

**Cloudinary concepts that enter the picture:**
- **`public_id`** — Cloudinary's identity for an asset, returned on upload. It is *not* guaranteed byte-identical to our `object_key`: for `image`/`video` resource types Cloudinary **strips the file extension** from `public_id` (format is tracked separately); for `raw` it keeps the full string. So `public_id ≠ object_key` in general. → drives the metadata delta in §4.
- **`secure_url`** — the `https://res.cloudinary.com/<cloud>/<resource_type>/upload/<version>/<public_id>.<fmt>` delivery URL. → drives the F1 / subdomain interaction in §5–§6.
- **`resource_type`** ∈ `image | video | raw` — Cloudinary files by type, and **`destroy` and Admin-API `list` silently miss the asset if the wrong `resource_type` is passed.** Our assets span images, audio, video, pdf, json, html, txt (`MIME_EXT`, `storage.js:24–29`). Mapping: `image/*→image`, `video/*` and **`audio/*→video`** (Cloudinary files audio under `video`), everything else (`pdf`, `json`, `html`, `txt`)→`raw`. Deterministic from `content_type`; the adapter must pass it explicitly on upload and derive the same way on delete.
- **`folder` / `tags`** — organization. Our `object_key` prefix (`asset/<entity_key>/…`) already gives a folder-like namespace; we can pass it as `public_id` (so Cloudinary keeps our scheme) or as `folder` + short `public_id`.
- **No buckets.** The `bucket` param in the 3-method interface is meaningless to Cloudinary (it'll write a sentinel, e.g. cloud name or folder, into the NOT-NULL `bucket` column — §4).

**Interface-shape note (internal, invisible to modules):** the current bytes-backend signatures are Supabase-shaped — `download(bucket, key)` / `remove(bucket, key)` (`storage.js:89,94`). Cloudinary needs `public_id` + `resource_type`, which aren't in `(bucket, key)`. Both call sites already load the full `row` first (`getBytes` `storage.js:197–199`, `delete` `:203–205`), so the fix is a **small local widening**: pass the `row` (or `{public_id, content_type}`) to `download`/`remove` instead of `(bucket, key)`. Contained entirely within `storage.js`; the module-facing seam does not move.

**Unaffected by the swap:** `checksum` (sha256 computed in `put`, `storage.js:162`, not from the backend), `size_bytes` (`bytes.length`, `:170`), `entity_key`/`object_key` scheme, and all of `get`/`list`.

---

## 4. Metadata table — does `stored_assets` need changes?

Current shape (`20260712000000_d12_stored_assets.sql:41–59`): `id, source, entity_name, entity_key, run_id, asset_type, backend, bucket, visibility, object_key, url, content_type, size_bytes, checksum, source_url, dedup_key, created_at`.

**Minimal delta: exactly ONE nullable column.**

- **ADD `cloudinary_public_id TEXT` (nullable).** Cloudinary's `public_id` is the authoritative key for `destroy` and for any future transform, is returned on upload, and is **not** re-derivable from `object_key` without replicating Cloudinary's per-`resource_type` extension/normalization rules (§3). Store what the upload returns rather than re-derive it at every delete. Nullable → back-compatible with existing/Supabase rows. (Additive, nullable — same low-risk profile as the original migration, which is "additive only," `…d12_stored_assets.sql:29`.)
- **`backend` column — no DDL.** It's free `TEXT DEFAULT 'supabase'` and is *explicitly documented as "THE swap column"* (`…d12_stored_assets.sql:48`, values `'supabase' | 'r2'`). Writing `'cloudinary'` needs no schema change.
- **`resource_type` — no column.** Deterministically derivable from `content_type` (§3). The adapter controls it at upload and re-derives identically at delete, so persisting it is optional. (If you'd rather eliminate the derivation-drift risk entirely, a second nullable `cloudinary_resource_type TEXT` is cheap — but not required. Recommend derive.)
- **`bucket TEXT NOT NULL` (`…:49`) — no DDL, but note:** Cloudinary has no buckets. The adapter must write a sentinel (cloud name or folder) to satisfy NOT-NULL. Cosmetic.
- **`object_key` — keep as-is.** Still our canonical portable path / intended folder; still useful. `url` still stores the resolved stable URL (`…:52`).

**Is `object_key` still the right key, or does `public_id` become the key?** `object_key` stays the *logical* key (folder scheme, listing, human trace). `public_id` becomes the *backend-physical* key for delete/transform. They coexist — hence the one added column. This mirrors the schema's existing intent: `object_key` is "backend-PORTABLE," `backend` names the store; we're adding Cloudinary's physical handle alongside.

> **Verdict: one nullable column (`cloudinary_public_id`). A prod DDL change, but additive + nullable + idempotent-friendly — the same class as the #46 migration itself.**

---

## 5. F1 under Cloudinary (the critical guarantee)

**The guarantee is identical; only the native-host string differs.** F1 = "the published `url` is on the stable, re-pointable host we control (`ASSET_PUBLIC_BASE`), NEVER the backend-native host" (`storage.js:56–63`).

Today the native-host rejection is Supabase-specific: `/(^|\/\/|\.)supabase\.co([:/]|$)/i` (`storage.js:73`). For Cloudinary the native delivery host is **`res.cloudinary.com`** (and `*.cloudinary.com`). So F1 must **also reject `cloudinary.com`**. The structure of `assetPublicUrl` is already host-agnostic (validate base present → reject known-native hosts → prepend base); the change is **extending the rejected-host set**, not rewriting the gate.

Minimal change: broaden the regex to a set, e.g. reject `supabase\.co` **or** `cloudinary\.com`. One line. Fail-closed ordering (`put` validates the URL before uploading, `storage.js:158–159`) is preserved for **Path A** below.

**F1 tests today** assert the Supabase case (`storageSeam.test.mjs:94–137`). The swap adds symmetric `res.cloudinary.com` rejection cases (unset → throw + upload nothing; native host → throw + upload nothing). Same shape as the existing seven F1 tests.

**One nuance, tied to the subdomain choice (§6):** under **Path A** (proxy/Worker), `url = base + object_key` stays exactly as-is and F1 is a pure one-line host-set extension. Under **Path B** (Cloudinary custom domain), the delivered path is Cloudinary's `<resource_type>/upload/<public_id>.<fmt>`, which is *not* our `object_key`. There, `assetPublicUrl` changes from "`base + object_key`" to "take the upload's `secure_url`, swap `res.cloudinary.com` → `ASSET_PUBLIC_BASE`." That means the final URL is composed **after** upload (you need Cloudinary's returned `public_id`), so the fail-closed check splits: validate `ASSET_PUBLIC_BASE` presence/host **before** upload (no orphan on misconfig), compose the final URL after, and lean on the existing best-effort `remove` (`storage.js:176–181`) for the narrow window. **F1's guarantee (never publish a native host) holds in both paths** — no red flag.

> **F1 is cleanly preservable under Cloudinary. No STOP condition. The guarantee is unchanged; the rejected host string (and, under Path B, the URL-composition source) is what moves.**

---

## 6. The subdomain question — two paths (DEPENDENT on Daniel's Cloudinary plan tier)

`assets.onlyigaming.com` can front Cloudinary two ways. **Both preserve F1.** Do not assume the tier.

- **Path A — proxy / Cloudflare Worker in front of Cloudinary** (like the planned Supabase setup).
  - Published URL stays `assets.onlyigaming.com/<object_key>`; `assetPublicUrl` stays `base + object_key`; F1 = one-line host-set extension (§5).
  - Cost: the Worker must map our `object_key` → Cloudinary delivery URL, which needs a `public_id` lookup (more logic than Supabase's static path rewrite). Independent of Cloudinary tier.
- **Path B — Cloudinary custom delivery hostname / CNAME** (Cloudinary "private CDN + CNAME" — a **paid-tier feature**).
  - `assets.onlyigaming.com` is Cloudinary's own domain; no Worker. Published URL = Cloudinary's native path with our host.
  - Cost: `assetPublicUrl` composes from `secure_url` (host-swap), not `object_key` (§5). F1 preserved.
  - **DEPENDENT on whether Daniel's tier supports custom domain/CNAME.**

**Neither changes the seam or the metadata contract** — both live inside `assetPublicUrl` + the adapter. Flag for Daniel: choice is gated on his plan tier, which he confirms once he has the login.

---

## 7. What CANNOT be determined without Daniel's Cloudinary account (his to-provide list)

1. **Cloud name** (`<cloud_name>`) — required for every delivery URL and SDK config.
2. **API key + API secret**, and the **env var names** to standardize on. Proposal: `CLOUDINARY_URL` (the SDK's native `cloudinary://key:secret@cloud` form) **or** the trio `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET`. (Metadata still uses `SUPABASE_URL`/`SUPABASE_KEY` — see §8.)
3. **Plan tier: does it support a custom delivery domain / CNAME?** → decides Path A vs Path B (§6).
4. **Existing folder / naming conventions in the OnlyiGaming Cloudinary account** — so pipeline assets don't collide with existing paid OnlyiGaming media. Our keys start with `asset/…`; confirm no existing `asset/` namespace, or adopt a dedicated prefix (e.g. `content-pipeline/asset/…`).
5. **Reserved `public_id`s / tags already in use** we must avoid overwriting (`overwrite:false` mitigates, but confirm).
6. **Signed vs unsigned upload preference** — we intend server-side **signed** uploads with the API secret; confirm the account permits it (default yes).

These are the build unit's hard preconditions; the swap build is gated on them.

---

## 8. Scope verdict — BOUNDED backend-adapter swap. No wider ripple. No STOP condition.

The swap is a **bounded unit**, not a seam/metadata/module rewrite. What the BUILD unit would touch:

1. **New `createCloudinaryBackend(cloudinaryClient)`** — the 3 methods `upload/download/remove` (new function in `storage.js` or a sibling). Only real net-new logic.
2. **Small internal widening** of `createStorage`↔backend calls so `download`/`remove` receive `public_id`+`resource_type` (or the `row`) rather than `(bucket, key)` — local to `storage.js`; seam unchanged (§3).
3. **`put` writes `backend:'cloudinary'` + the returned `public_id`** into the new column; chooses `resource_type` (§3).
4. **F1: extend native-host rejection** to also reject `cloudinary.com` (`storage.js:73`, one line). Under Path B, `assetPublicUrl` composes from `secure_url` (§5).
5. **One nullable column `cloudinary_public_id`** — prod DDL, additive (§4).
6. **New wiring `createCloudinaryStorage(cloudinaryClient, db)`** — note it needs **both** the Cloudinary client (bytes) **and** the Supabase `db` (metadata store stays Postgres, `db.js:20–25`). Swap the one call site `stageWorker.js:356` (or gate by env to keep Supabase as fallback).
7. **New dependency: the `cloudinary` npm package** (not currently installed — `package.json` has only `@supabase/supabase-js`).
8. **Re-test:** unit tests add a Cloudinary fake backend; F1 tests add `cloudinary.com` cases; integration test points at real Cloudinary (creds-gated, mirrors `storageSeam.integration.mjs`); **and `SEAM_FORBIDDEN` (`storageSeam.test.mjs:280–281`) gains `cloudinary` / `res.cloudinary.com`** so a module can't bypass the seam via the Cloudinary SDK (currently it can — the regex only covers Supabase/R2/S3). One-line, strengthens Rule-13.

**Does NOT ripple into:**
- **The module-facing seam** — `{put,get,getBytes,delete,list}` + `{asset_id,url}` unchanged (§1).
- **Modules** — no module touches storage directly; the SEAM gate still passes (after adding the Cloudinary token).
- **`get` / `list`** — metadata-only, **zero change** (§2).
- **The F1 guarantee** — identical; host string (and Path-B URL source) differ (§5).
- **`stored_assets` core design** — one additive nullable column (§4).
- **`checksum` / `size_bytes` / `object_key` scheme** — backend-independent (§3).

**Red-flag check (F1 cannot be preserved?) → NOT triggered.** F1 is cleanly preservable under both subdomain paths. The one item that is more than a pure host-swap — Path-B URL composition — stays inside `assetPublicUrl`/adapter and keeps the guarantee. No STOP-and-report condition surfaced.

**Estimated build size:** one new adapter (~the size of `createSupabaseBackend`, `storage.js:83–99`) + a local interface widening + one nullable column + one F1 line + wiring + test parity. Comparable to, and largely mechanical against, the existing #46 unit. **Gated on §7 (Daniel's account details) and the §6 tier decision.**

---

### Appendix — files read (authoritative)
- `server/services/storage.js` (seam + Supabase backend + F1)
- `server/services/db.js:1–25` (shared Supabase client)
- `supabase/migrations/20260712000000_d12_stored_assets.sql` (table shape)
- `server/tests/storageSeam.test.mjs` (unit contract + F1 + SEAM gate)
- `server/tests/storageSeam.integration.mjs` (live round-trip, public reach, anon-LIST-deny)
- `server/workers/stageWorker.js:17,53,353–358` (buildTools wiring)
- `supabase/artifacts/d12/rollback.sql`
- `.env.example:8–14` (`ASSET_PUBLIC_BASE`, `ASSET_BUCKET`)
