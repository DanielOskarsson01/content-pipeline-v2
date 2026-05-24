> ⚠️ **SUPERSEDED** by [2026-05-22-empty-pool-bug-fix.md](./2026-05-22-empty-pool-bug-fix.md).
>
> This plan introduced a new `discover` data_operation. Brutal-critic review and follow-up CTO review surfaced that `discover` would be byte-identical to `add`, providing documentation-only distinction with no runtime enforcement. The replacement plan uses an orthogonal `pool_precondition` manifest field instead, which is enforced at module load and at execution time. Kept for historical context.

---

# `discover` Data Operation — Implementation Plan (SUPERSEDED)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `discover` data_operation to the pipeline so Step 1 (and any future bootstrap-style) submodules can additively populate an empty working pool without colliding with the post-`390e768` strict-`transform` semantics. Eliminate the empty-pool bug surfaced during Phase 3 validation on 2026-05-22 and harden the contract so the same class of bug cannot recur.

**Architecture:** Two-repo change. Skeleton (`content-pipeline-v2`) gets a new branch in the approve handler's data_operation dispatch and an integration test that asserts the working pool is non-empty after Step 1 approval. Modules (`content-pipeline-modules-v2`) gets 8 Step 1 manifest updates changing `data_operation_default` from `transform` to `discover`. Rule 12 in modules `CLAUDE.md` is rewritten as a 4-op decision table so future module authors and the `/submodule-create` skill pick the right op deterministically.

**Tech Stack:** Node.js (ESM), Supabase JS client, plain `node`-driven integration tests (no framework), production deploy via `deploy.sh` rsync + PM2 restart.

---

## Issue Description

### Symptom

On 2026-05-22, a Phase 3 validation auto-execute run on 5 entities (Pronet Gaming, Wazdan, Booming Games, Altenar, NSoft) completed Step 1 with "5 succeeded" per submodule, but `entity_stage_pool.pool_items` remained **empty for all entities at every step**. Steps 2–4 each finished in ~1 second because they had nothing to process. Deep-links specifically returned 0 URLs for all 5 entities because its sibling working pool was empty when it ran.

### Root Cause

Skeleton commit **`390e768`** ("fix: transform data_operation respects prior remove filtering", 2026-05-21) changed `transform`'s behaviour in [server/routes/submoduleRuns.js](../../../server/routes/submoduleRuns.js) lines 1090–1114. Previously, `transform` was purely additive: it pushed all approved items into the entity pool. After `390e768`, it only pushes items whose key (or `original_url`) is **already in `entityPool`**:

```js
const existingKeys = new Set(entityPool.map(item => String(item[itemKey] ?? '')));
...
if (existingKeys.has(key) || (origKey && existingKeys.has(origKey))) {
  ...
  toAdd.push(item);
}
```

The fix is correct for Steps 2/3/4 (it prevents a `transform` submodule from undoing a prior `remove` in the same step). But every Step 1 submodule in the modules repo declares `data_operation_default: "transform"`:

- `sitemap-parser`
- `page-links`
- `browser-crawler`
- `deep-links`
- `rss-feeds`
- `api-search`
- `seed-url-builder`
- `csv-discovery`

When the first of these runs at Step 1, `entityPool` is empty. `existingKeys` is empty. No approved item matches. **Nothing is added.** The pool stays empty for the rest of the pipeline.

### Why this slipped through

1. **No bootstrap regression test.** Nothing asserts "after Step 1 approval, the working pool contains items if any submodule produced any."
2. **Cross-repo contract.** The `data_operation` semantic is declared in module manifests but interpreted in skeleton's approve handler. `390e768` changed the interpreter; it did not (and could not) audit the eight Step 1 manifests that depended on the old semantic.
3. **`data_operation`'s name overloads two concerns:** what the submodule produces (per-item) and where it sits in a step's lifecycle (bootstrap vs. mid-step). `transform` got asked to mean both.

### Why we fix this with a new op rather than patching `transform`

The proposed patch (special-case `entityPool.length === 0` inside `transform`) restores correctness but bakes the semantic muddle into the code. Future contributors see `transform` declared in manifests, read it as "I produce items," and won't know about the empty-pool branch unless they read the approve handler. The next collision of this kind is inevitable.

A new `discover` op with explicit semantics ("bootstrap discovery, additive, intended for the first wave at a step") names the concern and gives `/submodule-create` something concrete to ask about.

---

## File Structure

This plan touches both repos and a third meta location (the `/submodule-create` skill).

**Skeleton (`content-pipeline-v2/`):**
- Modify [server/routes/submoduleRuns.js](../../../server/routes/submoduleRuns.js) around line 1057–1117 — add `discover` branch before/alongside the existing `add` / `remove` / `transform` branches.
- Create `server/tests/data-operations.test.mjs` — integration test verifying `discover` adds all items into an empty pool and `transform` retains its post-`390e768` strict semantics.
- Modify [CLAUDE.md](../../../CLAUDE.md) — add session log entry documenting the change.

**Modules (`content-pipeline-modules-v2/`):**
- Modify the 8 manifests listed above: change `"data_operation_default": "transform"` → `"data_operation_default": "discover"`. Each file gets exactly one one-line change.
- Modify [modules/CLAUDE.md](../../../../content-pipeline-modules-v2/CLAUDE.md) rule 12 — rewrite as a 4-op decision table.

**Skill (`~/.claude/skills/submodule-create/`):**
- Modify the skill prompt to ask explicitly which op the module needs (discover / add / transform / remove) with the decision table inline.

---

## Task 1: Add a failing test that exercises `discover` and the empty-pool bug

**Files:**
- Create: `server/tests/data-operations.test.mjs`

- [ ] **Step 1: Write the integration test**

```javascript
/**
 * Integration test — data_operation semantics, in particular the `discover`
 * op for Step 1 bootstrap and the post-390e768 strict `transform` for Steps 2/3/4.
 *
 * Run against local:      node server/tests/data-operations.test.mjs
 * Run against production:  BASE_URL=https://www.jugadorvip.com AUTH=onlyigaming:test2026 node server/tests/data-operations.test.mjs
 *
 * Creates a real project + run, exercises Step 1 against an empty pool, then
 * cleans up. Total wall time should be < 30s.
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const AUTH = process.env.AUTH;
const TAG = `__test_dataop_${Date.now()}`;

let passed = 0, failed = 0;
const cleanup = { projects: [], runs: [] };

function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else            { failed++; console.log(`  ❌ ${label}`); }
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (AUTH) opts.headers['Authorization'] = 'Basic ' + Buffer.from(AUTH).toString('base64');
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function main() {
  console.log('\n=== data_operation semantics ===\n');

  // 1. Create a minimal project with one entity (an iGaming B2B test target).
  const proj = await api('POST', '/api/projects', {
    name: `${TAG}_project`,
    template_id: null,
    entities: [{ name: 'Pronet Gaming', website: 'https://www.pronetgaming.com' }],
  });
  assert(proj.status === 200 || proj.status === 201, 'project created');
  const projectId = proj.body.id;
  cleanup.projects.push(projectId);

  // 2. Start a run with explicit data_operation overrides for a discover-style
  //    Step 1 submodule (sitemap-parser) and a transform-style mid-pipeline submodule.
  const run = await api('POST', `/api/projects/${projectId}/runs`, {
    submodules_per_step: { '1': ['sitemap-parser'] },
  });
  assert(run.status === 200 || run.status === 201, 'run created');
  const runId = run.body.id;
  cleanup.runs.push(runId);

  // 3. Execute Step 1 / sitemap-parser and wait for completion.
  const exec = await api('POST', `/api/submodule-runs/run`, {
    run_id: runId,
    step_index: 1,
    submodule_id: 'sitemap-parser',
    options: {},
  });
  assert(exec.status === 200 || exec.status === 201, 'sitemap-parser execute kicked off');

  // 4. Poll until the per-entity submodule_run completes.
  const subRunId = exec.body.id ?? exec.body.submodule_run_id;
  let subRun, attempts = 0;
  do {
    await new Promise(r => setTimeout(r, 1000));
    const r = await api('GET', `/api/submodule-runs/${subRunId}`);
    subRun = r.body;
  } while (subRun?.status === 'pending' || subRun?.status === 'running' && attempts++ < 30);
  assert(subRun?.status === 'completed', `submodule reached completed (was ${subRun?.status})`);

  // 5. Approve the submodule_run — this is the path that writes pool_items.
  const approve = await api('POST', `/api/submodule-runs/${subRunId}/approve`, {});
  assert(approve.status === 200, 'approve succeeded');

  // 6. THE CRITICAL ASSERTION:
  //    The entity_stage_pool at step_index=1 for Pronet Gaming should have items > 0.
  //    Before the fix, this is 0 (the bug). After the fix, it is the count produced.
  const poolRes = await api('GET', `/api/runs/${runId}/pool?step_index=1&entity_name=Pronet+Gaming`);
  const itemCount = Array.isArray(poolRes.body?.pool_items) ? poolRes.body.pool_items.length : 0;
  assert(itemCount > 0, `Pronet Gaming pool has items after Step 1 (got ${itemCount})`);

  // 7. Cleanup
  for (const id of cleanup.runs)     await api('DELETE', `/api/runs/${id}`);
  for (const id of cleanup.projects) await api('DELETE', `/api/projects/${id}`);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
```

- [ ] **Step 2: Run the test to confirm it fails against current code**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2
BASE_URL=https://www.jugadorvip.com AUTH=onlyigaming:test2026 node server/tests/data-operations.test.mjs
```

Expected: `❌ Pronet Gaming pool has items after Step 1 (got 0)` — this is the bug. Other assertions should pass. Exit code 1.

- [ ] **Step 3: Commit the failing test**

```bash
git add server/tests/data-operations.test.mjs
git commit -m "test: failing test for empty-pool data_operation bug

Reproduces the Phase 3 validation issue where Step 1 transform submodules
silently drop all produced items when the working pool starts empty.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `discover` branch in the approve handler

**Files:**
- Modify: `server/routes/submoduleRuns.js` around lines 1057–1117

- [ ] **Step 1: Insert the new branch above the existing `add` branch**

Open [server/routes/submoduleRuns.js](../../../server/routes/submoduleRuns.js) and locate the block that begins at line 1057:

```js
} else {
  // ── NORMAL MODE ──
  // Update entity pool based on data_operation
  let entityPool = poolMap.get(entityName) || [];

  if (dataOperation === 'add') {
```

Replace it with:

```js
} else {
  // ── NORMAL MODE ──
  // Update entity pool based on data_operation
  let entityPool = poolMap.get(entityName) || [];

  if (dataOperation === 'discover') {
    // Bootstrap discovery — submodule produces net-new keys to seed the pool.
    // Designed for Step 1 (and any "first wave" submodule at a later step) where
    // there is no prior content to respect. Idempotent on re-run via composite
    // (itemKey, source_submodule) replacement — same shape as `add`, but the
    // intent is explicit: this submodule is a source of truth for new items.
    const compositeKey = (item) => `${String(item[itemKey] ?? '')}::${item.source_submodule || ''}`;
    const approvedKeys = new Set(approvedItems.map(compositeKey));
    entityPool = entityPool.filter(item => !approvedKeys.has(compositeKey(item)));
    entityPool.push(...approvedItems);
  } else if (dataOperation === 'add') {
```

(Everything from `} else if (dataOperation === 'add') {` onward stays exactly as it currently is — we are inserting a sibling branch, not replacing any existing one.)

- [ ] **Step 2: Run the test against local to confirm it passes**

Start the local skeleton against the prod DB (using the existing env) and re-run the test:

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2
# In one terminal:
npm start
# In another:
node server/tests/data-operations.test.mjs
```

Expected: all assertions pass with `0 failed`. Note: the test exercises sitemap-parser, which still has `data_operation_default: "transform"` in its manifest — so the test will only pass once Task 3 lands. For Task 2 in isolation, verify the new branch compiles and the existing `add` / `remove` / `transform` paths still work by running the full existing test suite:

```bash
node server/tests/modes.test.mjs
node server/tests/phase3-routing.test.mjs
```

Expected: both pass with their previous green status.

- [ ] **Step 3: Commit**

```bash
git add server/routes/submoduleRuns.js
git commit -m "feat: add discover data_operation for bootstrap-style submodules

Splits the discovery use case out of transform. discover is purely additive
(upsert by (itemKey, source_submodule)) and is intended for Step 1 and any
other 'first wave' submodule that seeds an empty working pool.

transform retains its post-390e768 strict semantics: only update items whose
key is already in the pool, never inject net-new keys. This preserves the
fix that prevents transform from undoing a prior remove in the same step.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Flip the 8 Step 1 manifests from `transform` to `discover`

**Files:** (all in the modules repo)
- Modify: `modules/step-1-discovery/sitemap-parser/manifest.json`
- Modify: `modules/step-1-discovery/page-links/manifest.json`
- Modify: `modules/step-1-discovery/browser-crawler/manifest.json`
- Modify: `modules/step-1-discovery/deep-links/manifest.json`
- Modify: `modules/step-1-discovery/rss-feeds/manifest.json`
- Modify: `modules/step-1-discovery/api-search/manifest.json`
- Modify: `modules/step-1-discovery/seed-url-builder/manifest.json`
- Modify: `modules/step-1-discovery/csv-discovery/manifest.json`

- [ ] **Step 1: Apply the same one-line change to each manifest**

For each of the 8 files above, change:

```json
  "data_operation_default": "transform",
```

to:

```json
  "data_operation_default": "discover",
```

One-shot sed:

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2/modules/step-1-discovery
for mod in sitemap-parser page-links browser-crawler deep-links rss-feeds api-search seed-url-builder csv-discovery; do
  sed -i.bak 's/"data_operation_default": "transform"/"data_operation_default": "discover"/' "$mod/manifest.json"
  rm "$mod/manifest.json.bak"
done
```

- [ ] **Step 2: Verify all 8 files changed exactly once**

```bash
grep -l '"data_operation_default": "discover"' /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2/modules/step-1-discovery/*/manifest.json | wc -l
```

Expected: `8`.

```bash
grep -l '"data_operation_default": "transform"' /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2/modules/step-1-discovery/*/manifest.json | wc -l
```

Expected: `0` (no Step 1 transform defaults remain).

- [ ] **Step 3: Spot-check one file**

```bash
grep -A1 -B1 "data_operation_default" /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2/modules/step-1-discovery/sitemap-parser/manifest.json
```

Expected:
```
  "data_operation_default": "discover",
```

- [ ] **Step 4: Commit (in the modules repo)**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2
git add modules/step-1-discovery/*/manifest.json
git commit -m "feat: Step 1 modules use discover data_operation

Pairs with skeleton-repo introduction of discover. All 8 Step 1 modules
(sitemap-parser, page-links, browser-crawler, deep-links, rss-feeds,
api-search, seed-url-builder, csv-discovery) are discovery-style: they
produce net-new keys to seed the working pool. The discover op makes
that intent explicit and decouples them from transform's post-390e768
strict 'no net-new keys' semantics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Run the integration test end-to-end and confirm green

**Files:** none — purely verification.

- [ ] **Step 1: Deploy the skeleton + modules changes to Hetzner**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2
./deploy.sh
```

Expected: deploy.sh rsyncs both repos, runs `npm install --omit=dev`, restarts PM2. Final lines should show `pm2 status` with `online` for `pipeline-api`, `stage-worker`, `batch-worker`.

- [ ] **Step 2: Run the data-operations test against production**

```bash
BASE_URL=https://www.jugadorvip.com AUTH=onlyigaming:test2026 \
  node server/tests/data-operations.test.mjs
```

Expected: all assertions pass with `0 failed`. In particular, the "Pronet Gaming pool has items after Step 1 (got N)" assertion shows N > 0 (likely 100+ items from sitemap.xml).

- [ ] **Step 3: Re-run the existing test suites against production to confirm no regression**

```bash
BASE_URL=https://www.jugadorvip.com AUTH=onlyigaming:test2026 node server/tests/modes.test.mjs
BASE_URL=https://www.jugadorvip.com AUTH=onlyigaming:test2026 node server/tests/phase3-routing.test.mjs
```

Expected: both green. The phase3-routing test in particular exercises the strict-`transform` path; it must remain green to confirm we didn't regress `390e768`.

---

## Task 5: Update the data_operation contract docs

**Files:**
- Modify: `modules/CLAUDE.md` rule 12 (in the modules repo)

- [ ] **Step 1: Locate and replace rule 12**

Open `/Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2/CLAUDE.md` and find the rule that begins with:

```
12. **`data_operation_default` for Steps 5-10 MUST be `"add"`, never `"transform"`.**
```

Replace that entire rule (and its trailing explanation block) with:

```markdown
12. **Pick `data_operation_default` deliberately — wrong choice silently drops your output.** Use this decision table:

    | Op | When to use | Skeleton behaviour |
    |----|-------------|--------------------|
    | `discover` | Submodule produces **net-new items** into a (possibly empty) working pool. Default for Step 1 and any other "first wave" submodule. | Upsert by `(itemKey, source_submodule)`. Adds new items; replaces this submodule's prior output if re-approved. |
    | `add` | Submodule **enriches** the pool — adds items but does not act as bootstrap source. Default for Steps 5-10 (per-entity generation/QA/output) where each submodule contributes a different data shape. | Same physical behaviour as `discover` (upsert by composite key) but **must not** be used at Step 1 — the intent is enrichment, not bootstrap. |
    | `transform` | Submodule **rewrites/refines existing items in place** — e.g. url-dedup, url-canonicalizer, boilerplate-stripper, intent-tagger. Default for Step 2/3/4 modules that operate on items already in the pool. | Only push items whose `itemKey` (or `original_url`) is already in the pool. Cannot inject net-new keys — that role belongs to `discover`. |
    | `remove` | Submodule **filters items out** — e.g. url-filter, url-relevance, content-filter. | Filter pool to only the keys present in `approved_items`. Enriched fields from the submodule's output are merged into the surviving items. |

    Step → op mapping (defaults):

    - **Step 1 (Discovery):** `discover`
    - **Step 2 (URL filtering):** `transform` for canonicalize / dedup; `remove` for filter / relevance
    - **Step 3 (Scraping):** `add` (each scraper enriches a different URL subset)
    - **Step 4 (Cleanup):** `transform` for intent-tagger / boilerplate-stripper; `remove` for content-filter
    - **Step 5-10:** `add`. Never `transform` — `item_key` is `entity_name` at these steps and `transform` would destroy upstream data from sibling submodules.

    If you cannot decide, the safest answer is `add` (Steps 5+) or `discover` (Step 1). Both are upserts; both are idempotent. Reach for `transform` or `remove` only when you specifically need their semantics.
```

- [ ] **Step 2: Verify the file still parses cleanly (no broken markdown)**

```bash
grep -c "^## \|^### \|^- \|^| " /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2/CLAUDE.md
```

Expected: a number much larger than 0 (sanity check that the file isn't truncated or corrupted). Eyeball the rule visually in an editor or via:

```bash
sed -n '/^12\./,/^---$/p' /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2/CLAUDE.md | head -50
```

Expected: the new table renders correctly.

- [ ] **Step 3: Commit (modules repo)**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2
git add CLAUDE.md
git commit -m "docs: rewrite rule 12 as 4-op data_operation decision table

Replaces the prior 'Steps 5-10 must use add' rule with a full decision
table covering discover / add / transform / remove. Includes step-by-step
default recommendations and an explicit 'safest answer when unsure' clause.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Update the `/submodule-create` skill to ask for the op explicitly

**Files:**
- Modify: `~/.claude/skills/submodule-create/SKILL.md` (or whichever file defines the skill — locate via `ls ~/.claude/skills/submodule-create/`)

- [ ] **Step 1: Locate the skill definition**

```bash
ls ~/.claude/skills/submodule-create/ 2>/dev/null || ls ~/.claude/plugins/cache/*/skills/submodule-create/ 2>/dev/null
```

Identify the main markdown file (typically `SKILL.md` or `skill.md`).

- [ ] **Step 2: Add an explicit data_operation question to the skill prompt**

Open the skill file and locate the section that handles "manifest scaffolding" or "default data_operation" (search for `data_operation`). Above the existing `data_operation_default` selection logic, insert:

```markdown
### Pick data_operation deliberately

Before writing the manifest, ask the user (or infer from context) which operation the submodule performs. Use the decision table from modules/CLAUDE.md rule 12:

- **`discover`** — Submodule produces net-new items into the working pool (Step 1 default, or any "first wave" submodule).
- **`add`** — Submodule enriches the pool with new items but is not bootstrap (Steps 5–10 default).
- **`transform`** — Submodule refines/rewrites existing items in place (Step 2/3/4 canonicalizers, deduplicators, taggers).
- **`remove`** — Submodule filters items out (filters, relevance checkers).

If you cannot tell from the brief, ASK. The wrong choice silently drops the submodule's output and is hard to diagnose later.
```

- [ ] **Step 3: Commit the skill update**

```bash
# The .claude/skills directory may or may not be under version control. If it is:
cd ~/.claude/skills/submodule-create/
git add SKILL.md
git commit -m "docs(submodule-create): require explicit data_operation choice with decision table"
# If not under git control, this is just a local-state change — no commit needed.
```

---

## Task 7: Add session log entries + commit skeleton docs

**Files:**
- Modify: `content-pipeline-v2/CLAUDE.md` (append a session entry)
- Modify: `content-pipeline-modules-v2/CLAUDE.md` (append a session entry)

- [ ] **Step 1: Append session log entry in skeleton CLAUDE.md**

At the end of `content-pipeline-v2/CLAUDE.md`, immediately after the existing 2026-05-22 entry, append:

```markdown

### Session: 2026-05-22 — `discover` data_operation introduced
**Accomplished:**
- Diagnosed Phase 3 validation failure: Step 1 submodules produced 100s of URLs in entity_submodule_runs.output_data but entity_stage_pool stayed empty for all 5 entities. Root caused to commit `390e768` ("transform respects prior remove filtering") over-restricting `transform` so empty-pool bootstrap silently dropped all approved items.
- Added new `discover` data_operation in `server/routes/submoduleRuns.js`: purely additive upsert by composite (itemKey, source_submodule). Replaces the bootstrap use case `transform` used to cover.
- Updated 8 Step 1 module manifests in modules repo (sitemap-parser, page-links, browser-crawler, deep-links, rss-feeds, api-search, seed-url-builder, csv-discovery) to use `discover` instead of `transform`.
- Rewrote modules CLAUDE.md rule 12 as a 4-op decision table (discover / add / transform / remove) with step-by-step default mapping.
- Added `server/tests/data-operations.test.mjs` — integration test asserting Step 1 approval populates the working pool. Regression guard for this class of bug.
- Updated `/submodule-create` skill prompt to ask explicitly which op the new submodule needs.

**Decisions:**
- **New op, not a patch:** rejected the 5-line "empty-pool bootstrap branch inside transform" fix because it bakes the semantic muddle into code. Introduced `discover` as a distinct op so future contributors can pick deliberately.
- **`discover` is intentionally additive-by-composite-key** (same physical behaviour as `add`) — the intent ("this submodule is a bootstrap source") is the value, not a new algorithm. Future divergence stays possible.
- **transform stays strict** (per 390e768) — no bootstrap branch, no special case. The 4-op decision table is now the single source of truth for what each op means.
- Deploy via existing `deploy.sh` rsync, no migration needed (manifests are JSON, picked up on next module reload).

**Blockers/Questions:**
- Phase 3 validation run can now be re-kicked on the same 5 entities (Pronet Gaming, Wazdan, Booming Games, Altenar, NSoft). Validation pre-conditions: data-operations.test.mjs green against prod, modes.test.mjs green, phase3-routing.test.mjs green.

**Updated by:** CTO agent (manual session entry)
```

- [ ] **Step 2: Append matching session log entry in modules CLAUDE.md**

At the end of `content-pipeline-modules-v2/CLAUDE.md`, append:

```markdown

### Session: 2026-05-22 — Step 1 manifests use `discover`
**Accomplished:**
- All 8 Step 1 manifests updated: `data_operation_default` changed from `transform` to `discover` (sitemap-parser, page-links, browser-crawler, deep-links, rss-feeds, api-search, seed-url-builder, csv-discovery).
- Rule 12 in this CLAUDE.md rewritten as a 4-op decision table covering discover / add / transform / remove with step-by-step default recommendations.
- Coordinated change with skeleton repo (see content-pipeline-v2 session log of same date) — skeleton ships the `discover` branch in the approve handler; modules repo flips the defaults to use it.

**Decisions:**
- `discover` chosen as the name (not `bootstrap` or `seed`) — matches Step 1's existing folder name (`step-1-discovery`) and the operational vocabulary users already use ("discovery modules").
- All 8 Step 1 modules flipped simultaneously — no half-state where some use `discover` and some use `transform`. Avoids the per-module override surface area until a real use case demands it.

**Blockers/Questions:**
- None — committed alongside skeleton-repo change. Both deploys via `deploy.sh` rsync.

**Updated by:** CTO agent (manual session entry)
```

- [ ] **Step 3: Commit both repos**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2
git add CLAUDE.md
git commit -m "docs: session log — discover data_operation introduced

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin main

cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2
git add CLAUDE.md
git commit -m "docs: session log — Step 1 manifests use discover

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `discover` branch behaves differently than expected for re-runs (e.g., duplicates appear) | Low — same composite key as `add` | Step 2 of Task 2 explicitly re-runs `modes.test.mjs` which exercises re-run paths. Plus the new test in Task 1 covers the empty-pool path. |
| One of the 8 Step 1 manifests already had a special-case override (e.g., the user configured `add` in run_submodule_config) and the manifest change is silently overridden | Low — `savedConfig?.data_operation` takes precedence over `manifest?.data_operation_default` per line 934 | This is actually desirable: existing per-run overrides keep working. New runs default to `discover`. No regression. |
| `phase3-routing.test.mjs` exercises an old `transform` path on Step 1 and breaks | Medium — that test was written for the post-`390e768` world | Step 3 of Task 4 explicitly re-runs it. If it fails, we have a concrete signal and can investigate before committing further. |
| Hetzner deploy partially succeeds (rsync OK, PM2 restart fails) | Low | `deploy.sh` exits on first error. Manual `ssh hetzner 'pm2 status'` confirms post-deploy. |
| The `/submodule-create` skill file structure has changed and Task 6 step 1 finds nothing | Medium | Task 6 step 1 includes both probable paths; if neither exists, downgrade to a TODO comment and ship the rest. The skill update is not on the critical path for unblocking validation. |
| Modules repo or skeleton repo pre-commit hook (decision_log requirement) blocks one of the 4 planned commits | High — confirmed in prior CTO session | Write a decision_log entry to `https://zgfvgghfkkbrbiunsgry.supabase.co` (command-center Supabase) before each commit, scoped to the right `project_name`. Use the curl pattern from skeleton session log of 2026-05-22. |

## Success Criteria

The plan is complete when **all of**:

1. `node server/tests/data-operations.test.mjs` exits 0 against production (`BASE_URL=https://www.jugadorvip.com`).
2. `node server/tests/modes.test.mjs` and `node server/tests/phase3-routing.test.mjs` both still exit 0 against production.
3. A fresh 5-entity Phase 3 validation run on the same B2B targets (Pronet Gaming, Wazdan, Booming Games, Altenar, NSoft) shows non-zero `entity_stage_pool.pool_items` at Step 1 for all 5 entities. Verify via:

```sql
SELECT entity_name,
       jsonb_array_length(pool_items) AS items
FROM entity_stage_pool
WHERE run_id = '<new-run-id>' AND step_index = 1
ORDER BY entity_name;
```

Expected: 5 rows, all with `items > 0` (likely 50+ for Wazdan/Booming Games, 100+ for the others).

4. Both repos' CHANGELOG / session logs reflect the change.
5. Modules CLAUDE.md rule 12 is the new 4-op decision table.
6. All commits pushed to origin/main on both repos.

## Out of Scope

The following are deliberately deferred to follow-up plans, **not** addressed by this plan:

- Auditing Steps 2/3/4 module manifests for incorrect `transform` usage. Some may also be miscategorized (e.g., a Step 3 module that should be `discover` because it produces from external API rather than refining pool items). Risk: small — the symptom would be the same empty-pool bug, which the new regression test would catch the next time validation runs. Follow-up audit recommended within the next two sessions.
- Renaming the existing `transform` to something less ambiguous (e.g., `refine`). Considered but rejected for this plan — would force a wider modules-repo migration with no immediate benefit beyond clarity.
- Backfilling tests for `add` and `remove`. The new test exercises `discover` and indirectly the path that re-uses for `add`. `remove` is exercised heavily by `phase3-routing.test.mjs`. Coverage is acceptable for now.

---

## Self-Review (writing-plans skill)

**1. Spec coverage:**
- Empty-pool bug diagnosis → Issue Description ✓
- `discover` op added in skeleton → Task 2 ✓
- 8 Step 1 manifests updated → Task 3 ✓
- Rule 12 rewritten → Task 5 ✓
- `/submodule-create` skill updated → Task 6 ✓
- Regression test added → Task 1 ✓
- Session logs in both repos → Task 7 ✓
- Deploy + validation → Task 4 ✓

**2. Placeholder scan:** No "TODO", "TBD", "fill in later", "similar to Task N", or "appropriate error handling". Every code block contains the exact text to use.

**3. Type consistency:** `discover` named consistently across all tasks. `data_operation_default` and `dataOperation` (the local variable) used correctly in their respective contexts. Composite-key helper `compositeKey` reused from the existing `add` branch — same shape.

**4. Known gaps deliberately accepted:**
- Task 6 may not find the skill file at the documented path (depends on Claude Code's plugin cache layout). The risk table addresses this; the worst case is "update skill later," not a blocker for unblocking validation.
- The regression test in Task 1 depends on a `GET /api/runs/:runId/pool` endpoint that may not exist by that exact path. If the route is named differently (e.g. `entity_stage_pool` via a different route), Task 1 step 1 needs a one-line route adjustment. Acceptable because that's a 30-second fix on the spot.
