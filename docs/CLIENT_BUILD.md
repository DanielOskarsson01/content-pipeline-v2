# Client Build & Serve Procedure

**Repo:** `content-pipeline-v2` (skeleton)
**Applies to:** `client/` (Vite + React 19 SPA)
**Last verified:** 2026-07-07 (BACKLOG #4 closeout — build confirmed working from a clean install)

This document is the canonical "how to build and serve the React client" procedure, plus
the recovery recipe for the Rollup optional-dependency bug (BACKLOG #4) that historically
broke `deploy.sh` at step 1.

---

## What the client is / how it is served

- `client/` is a Vite 7 + React 19 single-page app. Router routes live in
  `client/src/router.tsx` (e.g. the run view is `/projects/:projectId/runs/:runId`).
- `vite build` emits a static bundle to `client/dist/` (`index.html` + hashed
  `assets/*.js` + `assets/*.css`).
- **Production serve:** the Express server serves the built bundle directly —
  `express.static(client/dist)` plus an SPA fallback that returns
  `client/dist/index.html` for any non-`/api` route
  (`server/server.js:42-43` and `:224-232`). There is no separate static host; the
  API process (port 3001) is the web server for the SPA too.
- **Deploy path:** `deploy.sh` step `[1/6]` runs the client build **locally**, then
  step `[3/6]` rsyncs the whole tree (including `client/dist/`) to Hetzner. The build
  therefore always runs on the local machine's Node/arch — never on the server.

---

## Requirements

| Requirement | Why |
|-------------|-----|
| Node from `/opt/homebrew/bin/node` (native **arm64** on Apple Silicon) | The historical #4 failure was a Rosetta **x64** node at `/usr/local/bin/node` — Rollup then needed `@rollup/rollup-darwin-x64` (absent) instead of `-darwin-arm64`. Run `node -p "process.platform+'-'+process.arch"` and confirm it matches your machine. |
| npm **11+** (`npm --version`) | npm 11 fixes the optional-dependency install bug ([npm/cli#4828](https://github.com/npm/cli/issues/4828)) behind #4. |
| `client/package-lock.json` committed (lockfileVersion 3) | Records **all** platform Rollup binaries with `os`/`cpu` constraints, so a clean install deterministically picks the right one per platform. Do not delete it. |

---

## Build

From the repo root:

```bash
npm run build          # → cd client && vite build
```

or directly:

```bash
cd client && npm run build
```

Expected output ends with `✓ built in …s` and writes:

```
client/dist/index.html
client/dist/assets/index-<hash>.js
client/dist/assets/index-<hash>.css
```

Non-fatal warnings you can ignore: the `DEP0205 module.register()` deprecation, the
`Browserslist … 6 months old` notice, and the `chunk larger than 500 kB` advisory. None
of them fail the build (exit code stays 0).

### Reproducible / CI-style build (recommended before a deploy)

To build from a clean, lockfile-exact install (this is the real test that #4 will not
recur — it is what a fresh clone or CI does):

```bash
cd client
rm -rf node_modules
npm ci                 # deterministic install from committed package-lock.json
npm run build
```

`npm ci` installs the platform-appropriate `@rollup/rollup-*` binary for the running
Node's arch. Verify it landed:

```bash
ls -d client/node_modules/@rollup/rollup-$(node -p "process.platform+'-'+process.arch")
# darwin-arm64 on Apple Silicon homebrew node; linux-x64-gnu on the server, etc.
```

---

## Serve / verify locally

**Option A — preview the built bundle only (fast, no backend):**

```bash
cd client && npm run preview -- --port 4317 --strictPort
# → http://localhost:4317/
```

`vite preview` serves `client/dist/` exactly as production would (including SPA history
fallback). Sanity checks:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://localhost:4317/
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://localhost:4317/projects/demo/runs/demo
# both should be 200 text/html (the second proves SPA fallback for the run view route)
```

To confirm React actually mounts (not just that HTML serves), render headlessly and check
that `#root` gets populated:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --user-data-dir="$(mktemp -d)" --virtual-time-budget=6000 \
  --dump-dom "http://localhost:4317/projects/demo/runs/demo"
# The dumped DOM should contain the app shell (header "OnlyiGaming Content Tool", the
# New Project / Projects / Templates nav) and the RunView rendering "Loading run..."
# (it stays on "Loading run..." because no API is running — that is expected; the point
# is that the component MOUNTED).
```

**Option B — full app (client + API + workers, needs env/DB):**

```bash
npm run dev            # concurrently runs api, worker, batch, and the vite dev server
```

Use this when you need live data. For a pure "did the build produce a working bundle?"
check, Option A is sufficient and has no backend dependencies.

---

## Recovery: if the build fails with a missing `@rollup/rollup-*` module (BACKLOG #4)

Symptom (`vite build` crashes):

```
Error: Cannot find module @rollup/rollup-darwin-arm64. npm has a bug related to
optional dependencies. Please try `npm i` again after removing both
package-lock.json and node_modules directory.
```

The exact platform in the message depends on the running Node's arch — it may be
`-darwin-x64` (Rosetta/x64 node), `-darwin-arm64` (Apple Silicon), or
`-linux-x64-gnu` (server).

**Fix, in order of least to most invasive:**

1. **Confirm your Node arch is what you expect.** A Rosetta x64 node needs the `-x64`
   binary; a homebrew arm64 node needs `-arm64`. This mismatch was the actual 2026-06-15
   cause. Prefer the native `/opt/homebrew/bin/node`.
   ```bash
   which node && node -p "process.platform+'-'+process.arch"
   ```
2. **Clean install from the committed lockfile** (does not change the lockfile):
   ```bash
   cd client && rm -rf node_modules && npm ci && npm run build
   ```
3. **Last resort — regenerate the lockfile** (only if `npm ci` still can't resolve the
   optional dep; this rewrites `package-lock.json`, so commit the result):
   ```bash
   cd client && rm -rf node_modules package-lock.json && npm install && npm run build
   ```

**Server-only deploys do not need the client build at all.** If you only changed
`server/`, you can bypass a broken client build entirely (the "Path B" workaround):
rsync `server/` (no `--delete`, leaving `client/dist` intact) and `pm2 restart all`.
See BACKLOG #6 (deploy.sh hardcodes the client build) for the standing request to split
`deploy.sh` so server hotfixes never depend on a working client build.

---

## Cross-references

- `deploy.sh` — step `[1/6]` builds the client locally before the rsync.
- BACKLOG #4 (modules repo) — the Rollup optional-dep bug this doc closes out.
- BACKLOG #6 (modules repo) — split `deploy.sh` so server-only deploys skip the client build.
- `docs/HETZNER_SERVICES.md` — how the built app is run (PM2 / Express) on the server.
