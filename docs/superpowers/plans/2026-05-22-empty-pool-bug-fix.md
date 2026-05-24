# Empty-Pool Bug Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the empty-pool bug surfaced during Phase 3 validation on 2026-05-22, and harden the pipeline's data_operation contract so the same class of bug cannot recur as the platform moves toward multi-card routing and drag-and-drop composition.

**Architecture:** Keep the 3-op vocabulary (`add` / `transform` / `remove`). Introduce an orthogonal `pool_precondition` manifest field (`empty_ok` or `requires_items`) declaring what state the working pool must be in for the module to execute. Enforce the precondition at runtime (before execute) and at manifest-load time (no default — every module must declare). Decouple the contract from step numbers so it survives drag-and-drop reordering. Add a new `entity_submodule_runs.status = 'skipped_no_input'` value distinct from `'failed'` so composition errors don't poison auto-execute's failure threshold.

**Tech Stack:** Node.js (ESM), Supabase JS client, plain `node`-driven integration tests, production deploy via `deploy.sh` rsync + PM2 restart, BullMQ workers.

---

## Issue Description

### Symptom

On 2026-05-22, a Phase 3 validation auto-execute run on 5 entities (Pronet Gaming, Wazdan, Booming Games, Altenar, NSoft) completed Step 1 with "5 succeeded" per submodule, but `entity_stage_pool.pool_items` remained **empty for all entities at every step**. Steps 2–4 each finished in ~1 second because they had nothing to process. `deep-links` specifically returned 0 URLs for all 5 entities because the working pool was empty when it ran.

### Root Cause

Skeleton commit **`390e768`** ("fix: transform data_operation respects prior remove filtering", 2026-05-21) changed `transform`'s behaviour in [server/routes/submoduleRuns.js](../../../server/routes/submoduleRuns.js) lines 1090–1114. Previously, `transform` was purely additive. After `390e768`, it only pushes items whose key (or `original_url`) is **already in `entityPool`**:

```js
const existingKeys = new Set(entityPool.map(item => String(item[itemKey] ?? '')));
...
if (existingKeys.has(key) || (origKey && existingKeys.has(origKey))) {
  ...
  toAdd.push(item);
}
```

The fix is correct for Steps 2/3/4 (it prevents a `transform` submodule from undoing a prior `remove`). But every Step 1 submodule in the modules repo declares `data_operation_default: "transform"`. When the first runs at Step 1, `entityPool` is empty. `existingKeys` is empty. No approved item matches. Nothing is added. The pool stays empty for the rest of the pipeline.

### Why this slipped through

1. **No regression test.** Nothing asserts "after Step 1 approval, the working pool contains items if any submodule produced any."
2. **Cross-repo contract.** The `data_operation` semantic is declared in module manifests but interpreted in skeleton's approve handler. `390e768` changed the interpreter; it did not (and could not) audit the eight Step 1 manifests that depended on the old semantic.
3. **`data_operation` overloaded two concerns**: what the submodule produces (per-item) and what it requires (lifecycle position). `transform` got asked to mean both.

### Why this approach (vs the rejected alternatives)

| Considered | Rejected because |
|------------|-----------------|
| Single-line bootstrap branch in `transform` (`if entityPool.length === 0`) | Bakes the muddle into code. Next contributor copying `transform` won't see the special case. Future bug recurrence inevitable. |
| New `discover` op | Would be byte-identical to `add`. Two enum values for one behaviour is debt, not architecture. No runtime enforcement of "discover is for Step 1." |
| Validation rules tied to step numbers | Couples to current scaffolding. Multi-card routing and drag-and-drop will eventually run submodules in user-composed sequences where step numbers don't determine position. |
| **`pool_precondition` field, fail-closed at load + fail-loud at runtime** | ✓ Decouples from step position. ✓ Programmatically enforceable. ✓ Auditable mechanically. ✓ Surfaces composition errors loudly. |

---

## File Structure

This plan touches both repos plus the audit script.

**Audit (new):**
- Create: `content-pipeline-modules-v2/scripts/audit-pool-preconditions.mjs` — scans every `execute.js`, proposes a `pool_precondition` per module based on pool-access patterns, outputs CSV for human review

**Modules (`content-pipeline-modules-v2/`):**
- Modify: 8 Step 1 manifests — change `data_operation_default` from `transform` to `add`
- Modify: ~30 manifests total — add `pool_precondition` field (verified value per module)
- Modify: `modules/CLAUDE.md` rule 12 — role-based decision table

**Skeleton (`content-pipeline-v2/`):**
- Modify: `server/routes/submoduleRuns.js` — extract `applyDataOperation` as a pure function; add runtime precondition check before execute; mark precondition failures as `'skipped_no_input'`
- Modify: `server/services/moduleLoader.js` — reject manifests without explicit `pool_precondition`
- Modify: `server/routes/runs.js` — auto-execute threshold logic ignores `'skipped_no_input'`
- Create: `server/lib/applyDataOperation.js` — extracted pure function
- Create: `server/tests/data-operations.test.mjs` — unit tests for `applyDataOperation` and the runtime precondition check
- Modify: `CLAUDE.md` — session log entry

**Docs (this plan + worked example):**
- Modify: this file — add the loop-router retry worked example to Task 10's content
- Create: `scripts/pre-deploy-empty-pool-fix.sh` — tags repos, writes decision_log entries, prints rollback commands

---

## Sequencing Rules

These constraints determine task order:

1. **Audit (Tasks 1–3) MUST complete before manifest loader validation (Task 8) ships.** Otherwise the loader will reject every existing module on first restart.
2. **Tasks 7 (runtime precondition check) and 8 (loader validation) MUST deploy together.** They are two halves of the same enforcement contract. Shipping one without the other leaves a gap.
3. **Tasks 4 (Step 1 transform→add flip) and 5 (`'skipped_no_input'` status) can run in parallel with the audit (Tasks 1–3).** They don't depend on each other.
4. **The pre-deploy script (Task 12) MUST run before the final deploy (Task 13).** It captures the rollback point.

---

## Task 1: Write the audit-helper script

**Files:**
- Create: `content-pipeline-modules-v2/scripts/audit-pool-preconditions.mjs`

- [ ] **Step 1: Write the script**

Create `/Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2/scripts/audit-pool-preconditions.mjs`:

```javascript
#!/usr/bin/env node
/**
 * Pool Precondition Audit.
 *
 * Scans every modules/<step>/<id>/execute.js. For each module, looks for
 * patterns that indicate the module reads from the working pool. Proposes
 * pool_precondition based on what it finds.
 *
 * Usage:
 *   node scripts/audit-pool-preconditions.mjs
 *   node scripts/audit-pool-preconditions.mjs --csv > audit.csv
 *
 * Output: per-module table of (module_id, current_data_op, current_precondition,
 * proposed_precondition, evidence). Human reviews and adjusts.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = join(__dirname, '..', 'modules');

// Patterns that strongly suggest the module reads from the pool.
const POOL_READ_PATTERNS = [
  /entity\.items\b/,                 // canonical per-entity items array
  /entity\.pool_items\b/,            // alternate name
  /\binputData\.items\b/,            // some legacy shapes
  /\bentity\.items\.filter\b/,
  /\bentity\.items\.map\b/,
  /for\s*\(\s*const\s+item\s+of\s+entity\.items\b/,
];

const CSV_MODE = process.argv.includes('--csv');

function findExecuteFiles(root) {
  const results = [];
  for (const stepDir of readdirSync(root)) {
    const stepPath = join(root, stepDir);
    if (!statSync(stepPath).isDirectory()) continue;
    if (!/^step-\d+/.test(stepDir)) continue;
    for (const modDir of readdirSync(stepPath)) {
      const modPath = join(stepPath, modDir);
      if (!statSync(modPath).isDirectory()) continue;
      const exec = join(modPath, 'execute.js');
      const manifest = join(modPath, 'manifest.json');
      try { statSync(exec); statSync(manifest); }
      catch { continue; }
      results.push({ step: stepDir, id: modDir, executePath: exec, manifestPath: manifest });
    }
  }
  return results;
}

function analyze(executePath, manifestPath) {
  const src = readFileSync(executePath, 'utf8');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const matches = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const pat of POOL_READ_PATTERNS) {
      if (pat.test(lines[i])) {
        matches.push({ line: i + 1, text: lines[i].trim().slice(0, 100), pattern: pat.source });
      }
    }
  }

  const proposed = matches.length > 0 ? 'requires_items' : 'empty_ok';
  return {
    id: manifest.id,
    step: manifest.step,
    currentDataOp: manifest.data_operation_default,
    currentPrecondition: manifest.pool_precondition ?? '(none)',
    proposedPrecondition: proposed,
    matchCount: matches.length,
    evidence: matches.slice(0, 3).map(m => `L${m.line}: ${m.text}`).join(' | '),
  };
}

const modules = findExecuteFiles(MODULES_DIR);
const results = modules.map(m => analyze(m.executePath, m.manifestPath));

if (CSV_MODE) {
  console.log('id,step,current_data_op,current_precondition,proposed_precondition,match_count,evidence');
  for (const r of results) {
    const safe = (s) => `"${String(s).replace(/"/g, '""')}"`;
    console.log([r.id, r.step, r.currentDataOp, r.currentPrecondition, r.proposedPrecondition, r.matchCount, safe(r.evidence)].join(','));
  }
} else {
  const rows = results.map(r => ({
    id: r.id,
    step: r.step,
    data_op: r.currentDataOp,
    current: r.currentPrecondition,
    proposed: r.proposedPrecondition,
    matches: r.matchCount,
  }));
  console.table(rows);
  console.log('\nProposed: requires_items if execute.js reads pool, else empty_ok.');
  console.log('Run with --csv to get a copy-pasteable spreadsheet with evidence lines.');
}
```

- [ ] **Step 2: Run the script and verify it produces output**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2
node scripts/audit-pool-preconditions.mjs
```

Expected: a table with ~30 rows, one per module. Step 1 modules should all show `proposed: empty_ok` (they don't read from the pool — they produce from external sources). Step 2/3/4 transform/remove modules should show `proposed: requires_items`. Step 5+ modules vary.

- [ ] **Step 3: Commit (modules repo)**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2
# First write a decision_log entry (the pre-commit hook will require it):
SUPABASE_URL=https://zgfvgghfkkbrbiunsgry.supabase.co
curl -s -X POST "$SUPABASE_URL/rest/v1/decision_log" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"project_name":"content-pipeline-modules-v2","entry_type":"progress","summary":"Add pool-precondition audit script","decision_made":"Mechanical scan of execute.js for pool-read patterns, proposes pool_precondition per module","source":"manual"}'
git add scripts/audit-pool-preconditions.mjs
git commit -m "tooling: add pool-precondition audit script

Mechanical scan of every modules/<step>/<id>/execute.js for pool-read
patterns (entity.items access). Proposes pool_precondition per module:
requires_items if pool is read, empty_ok if not. Output is human-reviewable
table or CSV. Used to seed Task 2's audit pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Run the audit and human-review every proposal

**Files:**
- Create: `content-pipeline-modules-v2/scripts/audit-results.csv` — captured output for traceability

- [ ] **Step 1: Generate CSV output**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2
node scripts/audit-pool-preconditions.mjs --csv > scripts/audit-results.csv
```

- [ ] **Step 2: Human-review each row**

Open `scripts/audit-results.csv` in a spreadsheet. For each row:

1. Read the proposed `pool_precondition` and the `evidence` column
2. Open the module's `execute.js` and verify the proposal — script catches `entity.items` access, but you must also check:
   - Does the module read pool items via a different name (e.g. destructuring)?
   - Does the module produce items unconditionally regardless of pool state (still `empty_ok` even if it touches pool)?
   - Does the module have multiple modes (e.g. api-search has `search` mode and `feed` mode) — does pool-readiness apply uniformly?
3. Decide the final `pool_precondition` for the module. Note your decision in an extra column.

Expected outcomes (sanity check the script's defaults):
- **All 8 Step 1 modules** → `empty_ok` (they produce from external sources: sitemaps, homepage HTML, RSS, APIs, CSV files)
- **Step 2 url-canonicalizer, url-dedup, url-filter, url-relevance** → `requires_items`
- **Step 3 page-scraper, browser-scraper, api-scraper** → `requires_items` (they scrape URLs already in the pool)
- **Step 4 intent-tagger, content-filter, boilerplate-stripper** → `requires_items`
- **Step 5 content-analyzer, seo-planner, content-writer, tone-seo-editor** → `requires_items` (operate on scraped content / prior step output)
- **Step 6 QA modules** → `requires_items`
- **Step 7 loop-router** → `requires_items`
- **Step 8 output modules (markdown-output, html-output, json-output, meta-output, media-output, schema-org-injector, company-media)** → `requires_items`

If the script's proposal differs from these expectations on any module, **the module is the surprising one** — investigate before deciding. Don't override the script's evidence with a hunch.

- [ ] **Step 3: Commit the audit results for traceability**

```bash
SUPABASE_URL=https://zgfvgghfkkbrbiunsgry.supabase.co
curl -s -X POST "$SUPABASE_URL/rest/v1/decision_log" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"project_name":"content-pipeline-modules-v2","entry_type":"progress","summary":"Capture pool-precondition audit results for ~30 modules","decision_made":"Human reviewed every script proposal; final values committed to scripts/audit-results.csv","source":"manual"}'
git add scripts/audit-results.csv
git commit -m "audit: capture pool_precondition proposals for all ~30 modules

Output of audit-pool-preconditions.mjs --csv with a human-reviewed final
column. Single source of truth for Task 3 (writing pool_precondition into
each manifest).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `pool_precondition` to every module manifest

**Files:** all 30 modules' `manifest.json` files in `content-pipeline-modules-v2/modules/step-*/`

- [ ] **Step 1: Write each manifest's `pool_precondition` based on audit-results.csv**

For each module in the audit, open its `manifest.json` and add the field immediately after `data_operation_default`. Example for sitemap-parser:

```json
  "data_operation_default": "add",
  "pool_precondition": "empty_ok",
```

Example for url-dedup:

```json
  "data_operation_default": "transform",
  "pool_precondition": "requires_items",
```

(Hand-edit one by one, OR write a small sed loop that reads from `scripts/audit-results.csv` if your audit decisions match the script's proposals 1:1 — but only do this if no row was overridden during review.)

- [ ] **Step 2: Verify all manifests have the field**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2
TOTAL=$(find modules -name manifest.json -not -path "*/node_modules/*" | wc -l | tr -d ' ')
WITH_FIELD=$(grep -l '"pool_precondition"' $(find modules -name manifest.json -not -path "*/node_modules/*") | wc -l | tr -d ' ')
echo "Total manifests: $TOTAL, with pool_precondition: $WITH_FIELD"
```

Expected: equal counts.

- [ ] **Step 3: Run the audit script again to confirm**

```bash
node scripts/audit-pool-preconditions.mjs
```

Expected: every row's `current` column now matches what you set. No `(none)` values.

- [ ] **Step 4: Commit (modules repo)**

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/decision_log" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"project_name":"content-pipeline-modules-v2","entry_type":"progress","summary":"Add pool_precondition to all module manifests","decision_made":"Every module manifest declares pool_precondition (empty_ok or requires_items)","source":"manual"}'
git add modules/*/*/manifest.json
git commit -m "feat: add pool_precondition to every module manifest

Each module now declares whether it can execute against an empty working
pool (empty_ok — discovery/seed modules) or requires items already in the
pool (requires_items — transform/remove/per-entity-generation modules).

Values derived from the audit-results.csv produced by Task 1's script and
human-reviewed in Task 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Change 8 Step 1 manifests from `transform` to `add`

**Files:** 8 manifests in `modules/step-1-discovery/`

- [ ] **Step 1: Flip data_operation_default**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2/modules/step-1-discovery
for mod in sitemap-parser page-links browser-crawler deep-links rss-feeds api-search seed-url-builder csv-discovery; do
  sed -i.bak 's/"data_operation_default": "transform"/"data_operation_default": "add"/' "$mod/manifest.json"
  rm "$mod/manifest.json.bak"
done
```

- [ ] **Step 2: Verify exactly 8 manifests changed**

```bash
grep -l '"data_operation_default": "add"' /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2/modules/step-1-discovery/*/manifest.json | wc -l
```

Expected: `8`.

```bash
grep -l '"data_operation_default": "transform"' /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2/modules/step-1-discovery/*/manifest.json | wc -l
```

Expected: `0`.

- [ ] **Step 3: Commit (modules repo)**

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/decision_log" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"project_name":"content-pipeline-modules-v2","entry_type":"progress","summary":"Step 1 modules use add data_operation","decision_made":"Flip 8 manifests from transform to add — they produce net-new items, not refine existing ones","source":"manual"}'
git add modules/step-1-discovery/*/manifest.json
git commit -m "feat: Step 1 modules use add data_operation

All 8 Step 1 discovery modules (sitemap-parser, page-links, browser-crawler,
deep-links, rss-feeds, api-search, seed-url-builder, csv-discovery) flip
data_operation_default from transform to add. They produce net-new items
into the working pool — add is the correct vocabulary.

Pairs with pool_precondition: empty_ok set in Task 3. Together these
manifests now declare both 'what we produce' (add) and 'what we need'
(empty_ok pool is fine).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Add `'skipped_no_input'` status semantics

**Files:**
- `server/routes/runs.js` (auto-execute threshold logic)
- No schema change needed — `status` is `TEXT` with no CHECK constraint (verified in `sql/schema.sql:36,89,167,189`)

- [ ] **Step 1: Identify auto-execute threshold computation**

Open `server/routes/runs.js`. Find the auto-executor's per-step failure-rate calculation (search for `failure_threshold` and `completed_count` / `failed_count`). The logic computes:

```js
const failureRate = failedCount / Math.max(totalCount, 1);
if (failureRate > threshold) { /* halt run */ }
```

This needs to exclude rows with `status = 'skipped_no_input'` from both `failedCount` and `totalCount` denominators.

- [ ] **Step 2: Update the threshold calculation**

In every place that computes `failed_count` or `completed_count` from `entity_submodule_runs`:

- Add `'skipped_no_input'` to the exclusion list when counting failures
- Subtract skipped-no-input rows from the denominator before dividing

Concrete change (illustrative — adapt to the actual idiom used in `runs.js`):

```js
// BEFORE
const { count: failedCount } = await db
  .from('entity_submodule_runs')
  .select('id', { count: 'exact', head: true })
  .eq('submodule_run_id', subRunId)
  .eq('status', 'failed');

// AFTER
const { count: failedCount } = await db
  .from('entity_submodule_runs')
  .select('id', { count: 'exact', head: true })
  .eq('submodule_run_id', subRunId)
  .eq('status', 'failed');

const { count: skippedCount } = await db
  .from('entity_submodule_runs')
  .select('id', { count: 'exact', head: true })
  .eq('submodule_run_id', subRunId)
  .eq('status', 'skipped_no_input');

const effectiveTotal = totalCount - skippedCount;
const failureRate = effectiveTotal > 0 ? failedCount / effectiveTotal : 0;
```

Apply this pattern at every threshold-evaluation site in runs.js (likely 2–3 locations).

- [ ] **Step 3: Update batchWorker too**

`server/workers/batchWorker.js` writes summary counts back to `submodule_runs`. The verbiage in `progress.message` should distinguish skipped from failed. Open the file and update:

```js
// BEFORE
message: `${completed} succeeded, ${failed + zombies.length} failed`,

// AFTER (find the appropriate location for skipped count if available)
message: `${completed} succeeded, ${failed + zombies.length} failed, ${skipped} skipped (no input)`,
```

If `skipped` isn't already tracked in batchWorker, add it by counting `entity_submodule_runs` with `status='skipped_no_input'` for the batch.

- [ ] **Step 4: Commit (skeleton repo)**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2
curl -s -X POST "$SUPABASE_URL/rest/v1/decision_log" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"project_name":"content-pipeline-v2","entry_type":"progress","summary":"skipped_no_input status semantics","decision_made":"Distinguish composition errors (precondition not met) from genuine execution failures; auto-execute threshold excludes skipped rows from numerator AND denominator","source":"manual"}'
git add server/routes/runs.js server/workers/batchWorker.js
git commit -m "feat: skipped_no_input status excluded from failure threshold

Add a new entity_submodule_runs.status value 'skipped_no_input' for cases
where a submodule's pool_precondition is not met (e.g. requires_items but
pool is empty for this entity). Auto-execute threshold logic treats these
as composition errors, not failures — they're excluded from both the
numerator (failed count) and denominator (total) when computing failure
rate. UI message updated to surface skipped count distinctly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Extract `applyDataOperation` into a pure function

**Files:**
- Create: `server/lib/applyDataOperation.js`
- Modify: `server/routes/submoduleRuns.js` (replace inline logic with import)

- [ ] **Step 1: Create the extracted module**

Create `/Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2/server/lib/applyDataOperation.js`:

```javascript
/**
 * applyDataOperation — pure function that takes a working pool and approved
 * items, applies the data_operation semantic, and returns the new pool.
 *
 * Extracted from server/routes/submoduleRuns.js so the contract can be
 * exhaustively unit-tested without spinning up the API.
 *
 * Inputs:
 *   entityPool      — array of pool items currently associated with the entity
 *   approvedItems   — array of items approved from the submodule's output
 *   dataOperation   — 'add' | 'transform' | 'remove'
 *   itemKey         — string, the field used to identify items uniquely (e.g. 'url')
 *   approvedKeySet  — Set of String(item[itemKey]) values, prebuilt by caller
 *                     (used by 'remove' which also needs key-only matching)
 *
 * Returns:
 *   { pool: <new entityPool array>, ops: <stats for logging> }
 */
export function applyDataOperation(entityPool, approvedItems, dataOperation, itemKey, approvedKeySet) {
  const ops = { added: 0, kept: 0, removed: 0, replaced: 0 };

  if (dataOperation === 'add') {
    // Upsert by composite (itemKey, source_submodule). Replace this submodule's
    // prior output if re-approved; preserve other submodules' items.
    const compositeKey = (item) => `${String(item[itemKey] ?? '')}::${item.source_submodule || ''}`;
    const approvedKeys = new Set(approvedItems.map(compositeKey));
    const before = entityPool.length;
    entityPool = entityPool.filter(item => !approvedKeys.has(compositeKey(item)));
    ops.replaced = before - entityPool.length;
    entityPool.push(...approvedItems);
    ops.added = approvedItems.length;
    return { pool: entityPool, ops };
  }

  if (dataOperation === 'remove') {
    // Filter to keep only approved items, AND merge any enriched fields from
    // the submodule output into the surviving items.
    const approvedItemMap = new Map(
      approvedItems.map(item => [String(item[itemKey] ?? ''), item])
    );
    entityPool = entityPool.filter(item => {
      const keyVal = String(item[itemKey] ?? '');
      if (!approvedKeySet.has(keyVal)) { ops.removed++; return false; }
      const enriched = approvedItemMap.get(keyVal);
      if (enriched) {
        for (const [k, v] of Object.entries(enriched)) {
          if (k !== itemKey && k !== 'source_submodule' && !(k in item)) {
            item[k] = v;
          }
        }
      }
      ops.kept++;
      return true;
    });
    return { pool: entityPool, ops };
  }

  if (dataOperation === 'transform') {
    // Per 390e768: only push items whose key is already in the pool.
    // Items removed by an earlier 'remove' in the same step stay removed.
    // For empty pool: nothing happens — but pool_precondition: requires_items
    // should have prevented the module from running in the first place.
    const existingKeys = new Set(entityPool.map(item => String(item[itemKey] ?? '')));
    const removalSet = new Set();
    const toAdd = [];
    for (const item of approvedItems) {
      const key = String(item[itemKey] ?? '');
      const origKey = item.original_url != null && String(item.original_url) !== key
        ? String(item.original_url) : null;
      if (existingKeys.has(key) || (origKey && existingKeys.has(origKey))) {
        removalSet.add(key);
        if (origKey) { removalSet.add(origKey); }
        toAdd.push(item);
      }
    }
    const before = entityPool.length;
    entityPool = entityPool.filter(item => !removalSet.has(String(item[itemKey] ?? '')));
    ops.replaced = before - entityPool.length;
    entityPool.push(...toAdd);
    ops.added = toAdd.length;
    return { pool: entityPool, ops };
  }

  throw new Error(`Unknown data_operation: ${dataOperation}`);
}
```

- [ ] **Step 2: Replace the inline logic in submoduleRuns.js**

In `server/routes/submoduleRuns.js`, find the block beginning around line 1062:

```js
if (dataOperation === 'add') {
  ...
} else if (dataOperation === 'remove') {
  ...
} else if (dataOperation === 'transform') {
  ...
}
```

Replace the entire if/else chain with:

```js
const { pool: newPool, ops } = applyDataOperation(entityPool, approvedItems, dataOperation, itemKey, approvedKeySet);
entityPool = newPool;
console.log(`[${dataOperation}] ${entityName}: added=${ops.added} kept=${ops.kept} removed=${ops.removed} replaced=${ops.replaced}`);
```

Add the import at the top of submoduleRuns.js:

```js
import { applyDataOperation } from '../lib/applyDataOperation.js';
```

- [ ] **Step 3: Write the unit tests**

Create `/Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2/server/tests/data-operations.test.mjs`:

```javascript
/**
 * Unit tests for applyDataOperation.
 *
 * No API, no DB, no fixtures. Pure function in, pure value out.
 *
 * Run: node server/tests/data-operations.test.mjs
 */
import { applyDataOperation } from '../lib/applyDataOperation.js';

let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else            { failed++; console.log(`  ❌ ${label}`); }
}

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// --- empty pool semantics ---

(function emptyPool_add_addsAllItems() {
  const result = applyDataOperation(
    [], // empty pool
    [{ url: 'a', source_submodule: 'sitemap-parser' }, { url: 'b', source_submodule: 'sitemap-parser' }],
    'add',
    'url',
    new Set(['a', 'b']),
  );
  assert(result.pool.length === 2, 'empty + add → adds all items');
  assert(result.ops.added === 2, 'empty + add → ops.added === 2');
})();

(function emptyPool_transform_addsNothing() {
  const result = applyDataOperation(
    [],
    [{ url: 'a' }, { url: 'b' }],
    'transform',
    'url',
    new Set(['a', 'b']),
  );
  assert(result.pool.length === 0, 'empty + transform → adds nothing (THE BUG)');
})();

(function emptyPool_remove_returnsEmpty() {
  const result = applyDataOperation(
    [],
    [{ url: 'a' }],
    'remove',
    'url',
    new Set(['a']),
  );
  assert(result.pool.length === 0, 'empty + remove → empty');
})();

// --- non-empty pool semantics ---

(function nonEmptyPool_add_replacesSameSubmodule() {
  const pool = [
    { url: 'a', source_submodule: 'sitemap-parser', meta: 'old' },
    { url: 'c', source_submodule: 'rss-feeds' },
  ];
  const approved = [{ url: 'a', source_submodule: 'sitemap-parser', meta: 'new' }];
  const result = applyDataOperation(pool, approved, 'add', 'url', new Set(['a']));
  assert(result.pool.length === 2, 'add re-approval → keeps other submodule items');
  const found = result.pool.find(i => i.url === 'a' && i.source_submodule === 'sitemap-parser');
  assert(found?.meta === 'new', 'add re-approval → replaces own prior output');
});

(function nonEmptyPool_transform_strictPer390e768() {
  const pool = [{ url: 'a', extra: 'x' }, { url: 'b', extra: 'y' }];
  const approved = [
    { url: 'a', extra: 'transformed' },
    { url: 'c', extra: 'NEW_KEY_should_be_dropped' },
  ];
  const result = applyDataOperation(pool, approved, 'transform', 'url', new Set(['a', 'c']));
  assert(result.pool.length === 2, 'transform → no net-new keys (390e768 contract)');
  assert(result.pool.find(i => i.url === 'a')?.extra === 'transformed', 'transform → existing key updated');
  assert(!result.pool.find(i => i.url === 'c'), 'transform → new key NOT injected (390e768 contract)');
  assert(result.pool.find(i => i.url === 'b'), 'transform → unmodified existing key preserved');
})();

(function nonEmptyPool_transform_canonicalization() {
  const pool = [{ url: 'https://example.com/a/', extra: 'x' }];
  const approved = [{ url: 'https://example.com/a', original_url: 'https://example.com/a/' }];
  const result = applyDataOperation(pool, approved, 'transform', 'url', new Set(['https://example.com/a']));
  assert(result.pool.length === 1, 'transform canonicalization → one item');
  assert(result.pool[0].url === 'https://example.com/a', 'transform canonicalization → url updated');
})();

(function nonEmptyPool_remove_filtersAndMerges() {
  const pool = [{ url: 'a' }, { url: 'b' }, { url: 'c' }];
  const approved = [
    { url: 'a', relevance: 0.9 },
    { url: 'c', relevance: 0.7 },
  ];
  const result = applyDataOperation(pool, approved, 'remove', 'url', new Set(['a', 'c']));
  assert(result.pool.length === 2, 'remove → filters to approved keys');
  assert(result.pool.find(i => i.url === 'a')?.relevance === 0.9, 'remove → merges enriched fields');
  assert(!result.pool.find(i => i.url === 'b'), 'remove → drops unapproved items');
})();

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 4: Run the unit tests**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2
node server/tests/data-operations.test.mjs
```

Expected: all assertions pass.

- [ ] **Step 5: Run existing test suites against local skeleton (does not hit prod)**

Start a local server pointed at a local or staging DB if available. If only prod DB is accessible, set `BASE_URL=http://localhost:3001` and accept that this is read-mostly. Then:

```bash
node server/tests/modes.test.mjs
node server/tests/phase3-routing.test.mjs
```

Expected: both pass. If `phase3-routing.test.mjs` exercises a path that touched the refactored function, it confirms the extraction is behaviour-preserving.

- [ ] **Step 6: Commit (skeleton repo)**

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/decision_log" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"project_name":"content-pipeline-v2","entry_type":"progress","summary":"Extract applyDataOperation + unit tests","decision_made":"Pure function in server/lib/applyDataOperation.js; 7 unit test cases covering empty-pool semantics and 390e768 strict-transform","source":"manual"}'
git add server/lib/applyDataOperation.js server/routes/submoduleRuns.js server/tests/data-operations.test.mjs
git commit -m "refactor: extract applyDataOperation + add unit tests

The data_operation switch in the approve handler is now a pure function
in server/lib/applyDataOperation.js. Behaviour preserved exactly — same
inputs produce same outputs as the inline version.

7 unit test cases document the contract:
- empty pool + add → adds all
- empty pool + transform → adds nothing (the bug we are about to surface
  with a runtime precondition check rather than 'fix' inside transform)
- empty pool + remove → empty
- non-empty + add → composite-key replacement preserves siblings
- non-empty + transform → strict per-390e768 (no net-new keys)
- non-empty + transform + original_url → canonicalization works
- non-empty + remove → filters and merges enriched fields

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Runtime precondition check before execute

**Files:**
- Modify: `server/routes/submoduleRuns.js` (execute endpoint)

- [ ] **Step 1: Locate the execute endpoint**

The skeleton mounts `executeRouter` separately from `submoduleRunRouter`. Find the execute endpoint in submoduleRuns.js. It's the route that creates a new `submodule_runs` row and enqueues BullMQ jobs for entity processing. Look for the function that fans out per-entity work.

- [ ] **Step 2: Add precondition check immediately before per-entity job creation**

After the pool is loaded for each entity (around the existing `entity_stage_pool` query in the execute path), and before BullMQ jobs are enqueued, evaluate the precondition:

```js
const moduleManifest = getSubmoduleById(submoduleId);
const precondition = moduleManifest?.pool_precondition;
if (!precondition) {
  // Defensive — moduleLoader validation (Task 8) should already reject
  // manifests without this field, but never trust it past one layer.
  return res.status(500).json({
    error: `Module ${submoduleId} has no pool_precondition declared. Reject at execute time.`,
  });
}

// For each entity, decide whether to execute or mark skipped.
const skippedEntities = [];
const executableEntities = [];
for (const entity of entities) {
  const poolForEntity = poolMap.get(entity.entity_name) || [];
  if (precondition === 'requires_items' && poolForEntity.length === 0) {
    skippedEntities.push(entity);
  } else {
    executableEntities.push(entity);
  }
}

// Insert skipped_no_input rows for skipped entities so they show in
// per-entity result panes with a clear status.
if (skippedEntities.length > 0) {
  console.warn(`[execute] ${submoduleId}: ${skippedEntities.length} entities skipped — pool empty, module requires items`);
  await db.from('entity_submodule_runs').insert(
    skippedEntities.map(e => ({
      run_id: runId,
      stage_id: stageId,
      submodule_id: submoduleId,
      entity_name: e.entity_name,
      step_index: stepIdx,
      batch_id: batchId,
      status: 'skipped_no_input',
      error: `Submodule ${submoduleId} requires items in pool; pool is empty for this entity. Check pipeline composition — a prior step may have removed all items, or no discovery module ran upstream.`,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    }))
  );
}

// Only enqueue jobs for entities that can actually execute.
if (executableEntities.length === 0) {
  // The whole submodule_run is effectively a no-op — mark accordingly.
  await db.from('submodule_runs').update({
    status: 'completed',
    completed_at: new Date().toISOString(),
    progress: { current: 0, total: 0, message: `Skipped — 0 of ${entities.length} entities had pool items` },
  }).eq('id', submoduleRunId);
  return res.json({ id: submoduleRunId, status: 'completed', skipped: entities.length });
}

// Continue with existing BullMQ enqueue for executableEntities.
```

The exact integration depends on how the execute endpoint currently structures the fan-out. Find the existing code that maps `entities → BullMQ jobs` and insert the filtering above it.

- [ ] **Step 3: Add a test case for the runtime check**

Append to `server/tests/data-operations.test.mjs`:

```javascript
// --- runtime precondition check (mock) ---

(function precondition_requires_items_emptyPool_skips() {
  // Pure-function representation of the check logic that Task 7 implements
  // in the execute endpoint. If the check logic is also extracted to
  // server/lib/preconditionCheck.js, test it directly.
  function shouldSkip(precondition, poolLength) {
    return precondition === 'requires_items' && poolLength === 0;
  }
  assert(shouldSkip('requires_items', 0) === true,   'requires_items + empty → skip');
  assert(shouldSkip('requires_items', 5) === false,  'requires_items + non-empty → execute');
  assert(shouldSkip('empty_ok', 0) === false,        'empty_ok + empty → execute');
  assert(shouldSkip('empty_ok', 5) === false,        'empty_ok + non-empty → execute');
})();
```

Run again:

```bash
node server/tests/data-operations.test.mjs
```

Expected: 11+ tests pass.

- [ ] **Step 4: Commit (skeleton repo)**

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/decision_log" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"project_name":"content-pipeline-v2","entry_type":"progress","summary":"Runtime pool_precondition check before execute","decision_made":"Fail loudly with skipped_no_input status when requires_items module hits empty pool for an entity; other entities continue","source":"manual"}'
git add server/routes/submoduleRuns.js server/tests/data-operations.test.mjs
git commit -m "feat: runtime pool_precondition check before submodule execute

Before enqueuing per-entity BullMQ jobs, check each entity's pool against
the module's pool_precondition. If 'requires_items' and pool is empty,
insert an entity_submodule_runs row with status='skipped_no_input' (and
a diagnostic error message) instead of enqueueing the job. The status is
distinct from 'failed' and is excluded from auto-execute's failure
threshold (per Task 5).

This is the loud-failure mode replacing the silent drop that caused the
Phase 3 validation empty-pool bug. The pool is no longer secretly empty
— either the module ran with items, or there is a row clearly saying
'I could not run because the pool was empty.'

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Manifest loader validation (fail-closed)

**Files:**
- Modify: `server/services/moduleLoader.js`

- [ ] **Step 1: Add validation in the loader**

Open `server/services/moduleLoader.js`. The function `loadModules` (line ~53) iterates manifests and registers them. Add validation after the JSON parse:

```js
function validateManifest(manifest, manifestPath) {
  if (!manifest.pool_precondition) {
    throw new Error(`Manifest ${manifestPath} missing required field 'pool_precondition'. Set to "empty_ok" or "requires_items". See modules/CLAUDE.md rule 12.`);
  }
  if (!['empty_ok', 'requires_items'].includes(manifest.pool_precondition)) {
    throw new Error(`Manifest ${manifestPath} has invalid pool_precondition "${manifest.pool_precondition}". Allowed: empty_ok, requires_items.`);
  }
  if (!['add', 'transform', 'remove'].includes(manifest.data_operation_default)) {
    throw new Error(`Manifest ${manifestPath} has invalid data_operation_default "${manifest.data_operation_default}". Allowed: add, transform, remove.`);
  }
}
```

Call `validateManifest(manifest, manifestPath)` after the JSON.parse, before the manifest is registered. If validation throws, the loader should **fail to start the process** — fail-closed semantics. This means a botched audit causes immediate, visible startup failure rather than silent runtime weirdness.

- [ ] **Step 2: Verify the loader starts cleanly with the audited manifests**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2
node -e "import('./server/services/moduleLoader.js').then(m => { m.loadModules(); console.log('OK — all manifests valid'); })"
```

Expected: `OK — all manifests valid`. If any manifest fails validation, the audit (Task 2/3) was incomplete — go back, fix the manifest, then re-run.

- [ ] **Step 3: Commit (skeleton repo)**

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/decision_log" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"project_name":"content-pipeline-v2","entry_type":"progress","summary":"Manifest loader fail-closed validation","decision_made":"No default for pool_precondition; loader rejects manifests without it; process fails to start if audit incomplete","source":"manual"}'
git add server/services/moduleLoader.js
git commit -m "feat: manifest loader fail-closed validation

Module loader now throws on:
- missing pool_precondition (no default)
- invalid pool_precondition value
- invalid data_operation_default value

Throw at startup means a botched audit causes immediate visible failure
rather than silent runtime drops. The audit (Task 1-3) is now load-bearing
on every server start, not a one-shot check that can rot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Worked example — loop-router retry trace

**Files:**
- Modify: this plan document (Task 9 content below is the deliverable)

The architectural reframe — that the contract is independent of step position — requires verification against the most position-dependent feature: Phase 3 loop-router retries with v2 cards. Walk through one concrete scenario and verify the precondition check sees the right state.

### Scenario

- **Routing rule:** `hallucination:fail → writer-v2` (defined in the `30 april` template's execution_plan.routing_rules)
- **v2 card target:** `writer-v2` is a Step 5 card with `options_overrides` (stricter content-writer prompt, citation-required mode)
- **Entity:** "Pronet Gaming"

### Step-by-step pool state

1. **Initial pool state (Step 0)**: entity_stage_pool has no rows for Pronet Gaming yet. Run starts.
2. **Step 1 completes**: sitemap-parser, page-links, browser-crawler etc. run. Their `pool_precondition: "empty_ok"` allows execution. After approval, `entity_stage_pool[step_index=1, entity_name='Pronet Gaming'].pool_items` contains ~289 discovered URLs.
3. **Step 2 completes**: url-dedup, url-canonicalizer, url-filter, url-relevance run. All have `pool_precondition: "requires_items"`. Pool has 289 items → precondition passes. After filtering, pool has ~40 relevance-approved URLs.
4. **Step 3 completes**: page-scraper / browser-scraper / api-scraper. `requires_items` → pass. Pool has ~30 scraped items with `content_markdown`.
5. **Step 4 completes**: boilerplate-stripper, intent-tagger, content-filter. `requires_items` → pass. Pool has cleaned content.
6. **Step 5 first pass**: content-analyzer → seo-planner → content-writer → tone-seo-editor. All `requires_items`. After completion, pool has analysis_json + seo_plan_json + content_markdown + tone-edited content.
7. **Step 6 QA**: hallucination-detector runs and fails (e.g., flags 3 unsupported claims for Pronet Gaming).
8. **Step 7 loop-router** evaluates routing rules. Finds `hallucination:fail → writer-v2`. Writes a per-entity instruction: "for Pronet Gaming, re-run Step 5 with card writer-v2 (Round 2)."
9. **Retry execution kicks off**: writer-v2 is the content-writer module loaded with `options_overrides` from the card definition.
10. **Precondition check for writer-v2 on Pronet Gaming**:
    - `pool_precondition` for content-writer module: `requires_items`
    - Pool state for Pronet Gaming at step_index=5: still contains analysis_json + seo_plan_json + cleaned content (from steps 1-4) + the prior content-writer output (from step 5 first pass)
    - **pool_items length > 0 → precondition PASSES**
    - writer-v2 executes with stricter prompt and citation-required option
11. **writer-v2 produces a new content draft.** Step 5 chain continues through tone-seo-editor (also `requires_items` → passes), then Step 6 re-runs QA on the new draft.

### Verification

The precondition check at step (10) is the load-bearing assertion. It works because:

- The pool is **per-entity, per-step**, and survives across the original Step 5 → Step 6 → Step 7 → Step 5-retry sequence. The loop-router routes the entity *back* to Step 5 for retry, not to a fresh step. The pool that was populated by Steps 1-4 is still there.
- The precondition is intrinsic to the **module**, not to the **step position**. content-writer needs items regardless of whether it's running first time or as writer-v2. The check sees `pool_items.length > 0` and proceeds.

### Edge cases the worked example surfaces

- **What if the loop-router routes back to Step 1?** (e.g., a hypothetical `urls_insufficient:fail → pse-v2` rule routing to a Step 1 v2 card.) Step 1's writer-v2-equivalent would have `pool_precondition: "empty_ok"` (it's a discovery card), so the precondition passes regardless of pool state. ✓ Works.
- **What if a retry hits a deeply-empty entity?** (e.g., scraping found zero content for one of the 5 entities.) Then Step 5's first pass would have hit `requires_items` with an empty pool and inserted `'skipped_no_input'`. The loop-router has nothing to retry — there's no `hallucination:fail` entry to match because hallucination-detector never ran. ✓ Works without retry chaos.
- **What if a v2 card's options_overrides change which submodule reads the pool?** The module is the same module; its declared `pool_precondition` doesn't change with options. The override only affects how the module **uses** the pool, not whether it **can run**. ✓ Decoupling holds.

The reframe is durable. No special-cases for retry paths needed.

### Post-implementation verification (added 2026-05-24 after Tasks 6-8 shipped)

The worked example was drafted before Tasks 6-8 implementation. Each load-bearing claim has now been verified against the shipped code:

| Worked-example claim | Verified in implementation |
|---------------------|---------------------------|
| Precondition is read from the module's manifest, not from step position | [server/routes/submoduleRuns.js:457-487](../../../server/routes/submoduleRuns.js#L457-L487) — `manifest?.pool_precondition` resolved via `getSubmoduleById(submoduleId)` |
| Empty pool + `requires_items` → entity skipped (not failed) | Same lines + early-return at [lines 489-537](../../../server/routes/submoduleRuns.js#L489-L537) — inserts `entity_submodule_runs.status='skipped_no_input'` row |
| Per-entity check is per-entity-pool (not per-batch) | Iteration over `entities` filters into `executableEntities` / `skippedEntities` — each entity's `pool_items` evaluated independently |
| Composition errors do NOT count toward auto-execute halt threshold | [server/services/autoExecutor.js:730-743](../../../server/services/autoExecutor.js#L730-L743) — `effectiveTotal = totalCount - skippedCount`; failure rate denominator excludes skipped entities |
| Pure function exhaustively unit-testable | [server/lib/applyDataOperation.js](../../../server/lib/applyDataOperation.js) + [server/tests/data-operations.test.mjs](../../../server/tests/data-operations.test.mjs) — 23 unit test assertions, including the canonical empty-pool-transform bug |
| Loader rejects manifests without `pool_precondition` | [server/services/moduleLoader.js](../../../server/services/moduleLoader.js) `validateManifest()` throws on missing field, invalid value, or invalid `data_operation_default`; all 37 active manifests verified to load cleanly |

The architectural reframe (contract is independent of step position) holds at the code level. Multi-card routing and future drag-and-drop will run modules in user-composed sequences; the precondition check uses the manifest's declared `pool_precondition` regardless of where the module sits.

- [x] **Step 1: Worked example verified against shipped implementation. No edge cases surfaced beyond those documented above.**

---

## Task 10: Update modules/CLAUDE.md rule 12

**Files:**
- Modify: `content-pipeline-modules-v2/CLAUDE.md` rule 12

- [ ] **Step 1: Replace rule 12 entirely**

Locate the rule that begins:

```
12. **`data_operation_default` for Steps 5-10 MUST be `"add"`, never `"transform"`.**
```

Replace the entire rule and its trailing paragraph with:

```markdown
12. **Every manifest MUST declare BOTH `data_operation_default` AND `pool_precondition`. They are orthogonal — one describes what the module produces; the other describes what it requires.**

    `data_operation_default` — what this module does to the pool:

    | Op | What it does | When to use |
    |----|-------------|-------------|
    | `add` | Adds net-new items to the pool. Upsert by composite `(itemKey, source_submodule)` — replaces this module's own prior output, preserves other modules' items. | Any module that produces new items into the pool from a source the pool doesn't already contain. |
    | `transform` | Modifies items already in the pool — only updates items whose key (or `original_url`) is already present. Cannot inject net-new keys. | Modules that refine items in place (canonicalize, dedup, tag, strip boilerplate). |
    | `remove` | Filters items out of the pool — keeps only items whose key matches an approved item. Merges enriched fields from approved items into the kept items. | Filters (url-filter, content-filter) and relevance/quality checkers (url-relevance). |

    `pool_precondition` — what the module requires to be true about the pool before it can execute:

    | Precondition | Meaning |
    |--------------|---------|
    | `empty_ok` | Module works against an empty or populated pool. Default for discovery/seed modules that produce from external sources. |
    | `requires_items` | Module needs items in the pool for this entity to produce useful output. If pool is empty for an entity, the module is **skipped** with status `'skipped_no_input'` (not failed). |

    **No defaults.** Every manifest must declare both fields explicitly. The module loader (skeleton/server/services/moduleLoader.js) rejects manifests missing either field — server fails to start.

    **The two fields are orthogonal:**
    - A module declared `add` + `empty_ok` produces new items and can bootstrap an empty pool (e.g., sitemap-parser).
    - A module declared `add` + `requires_items` produces new items but only on top of upstream content (e.g., content-analyzer takes scraped pages and produces analysis_json items — but won't produce anything useful if there are no scraped pages to analyze).
    - A module declared `transform` + `empty_ok` is suspicious — transform by definition needs items to modify. The loader does not block this combination, but the runtime check will skip the module on empty pools anyway.
    - A module declared `transform` + `requires_items` is the normal case for canonicalizers / deduplicators / taggers.

    **Step-position guidance (current pipeline organization — may change with drag-and-drop):**

    - Step 1 (Discovery): typically `add` + `empty_ok` (sitemap-parser, page-links, browser-crawler, deep-links, rss-feeds, api-search, seed-url-builder, csv-discovery)
    - Step 2 (URL filtering): `transform` + `requires_items` for canonicalize/dedup; `remove` + `requires_items` for filter/relevance
    - Step 3 (Scraping): `add` + `requires_items` (each scraper enriches a different URL subset of the pool)
    - Step 4 (Cleanup): `transform` + `requires_items` for intent-tagger/boilerplate-stripper; `remove` + `requires_items` for content-filter
    - Step 5 (Generation): `add` + `requires_items` (content-analyzer/seo-planner/content-writer/tone-seo-editor — all need scraped content; the data_operation must be `add` because `item_key` is `entity_name` at these steps and `transform` would destroy sibling submodules' output, see rule 12-legacy below)
    - Step 6 (QA): `add` + `requires_items` (verdict items added to existing content items)
    - Step 7 (Routing): module-specific
    - Step 8 (Output): `add` + `requires_items` for output formatters

    The **data_operation contract is independent of step position.** Step numbers are *current scaffolding* — multi-card routing (Phase 3) and future drag-and-drop composition will run submodules in user-composed sequences where step numbers don't determine position. The runtime check uses `pool_precondition`, never `step`.

    **Legacy rule preserved:** for steps that use `item_key: "entity_name"` (Steps 5-10), `data_operation_default` MUST be `"add"`, never `"transform"`. With `entity_name` as the key, `transform` would replace ALL items for an entity, destroying upstream data from other submodules.

    **When unsure:** `add` + `empty_ok` is the safest "first wave" combination. `add` + `requires_items` is the safest "enrichment" combination. Use `transform` or `remove` only when you specifically need their semantics.
```

- [ ] **Step 2: Commit (modules repo)**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2
curl -s -X POST "$SUPABASE_URL/rest/v1/decision_log" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"project_name":"content-pipeline-modules-v2","entry_type":"progress","summary":"Rewrite rule 12 with orthogonal pool_precondition","decision_made":"Two orthogonal fields, no defaults, role-based not step-based","source":"manual"}'
git add CLAUDE.md
git commit -m "docs: rule 12 — orthogonal data_operation + pool_precondition

Rule 12 now requires every manifest to declare both data_operation_default
AND pool_precondition. The two are orthogonal: data_operation describes
what the module produces; pool_precondition describes what the module
requires. Decision tables for both, with step-position guidance kept as
*advisory* — the contract is role-based, not step-based.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Pre-deploy script with rollback

**Files:**
- Create: `scripts/pre-deploy-empty-pool-fix.sh`

- [ ] **Step 1: Write the script**

Create `/Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2/scripts/pre-deploy-empty-pool-fix.sh`:

```bash
#!/bin/bash
# Pre-deploy: tag both repos, write decision_log entries, print rollback recipe.
set -e

DATE=$(date +%Y-%m-%d)
TAG="pre-empty-pool-fix-${DATE}"

SUPABASE_URL=https://zgfvgghfkkbrbiunsgry.supabase.co

# ---- Tag skeleton ----
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2
SKELETON_TAG_REF=$(git rev-parse HEAD)
git tag -a "$TAG" -m "Pre-deploy snapshot before empty-pool-fix rollout" "$SKELETON_TAG_REF"
git push origin "$TAG"

# ---- Tag modules ----
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2
MODULES_TAG_REF=$(git rev-parse HEAD)
git tag -a "$TAG" -m "Pre-deploy snapshot before empty-pool-fix rollout" "$MODULES_TAG_REF"
git push origin "$TAG"

# ---- Write decision_log entries ----
for proj in content-pipeline-v2 content-pipeline-modules-v2; do
  curl -s -X POST "$SUPABASE_URL/rest/v1/decision_log" \
    -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"project_name\":\"$proj\",\"entry_type\":\"decision\",\"summary\":\"Pre-deploy snapshot for empty-pool-fix rollout\",\"decision_made\":\"Tagged $TAG on both repos before rsync deploy. Rollback recipe printed.\",\"source\":\"manual\"}" \
    > /dev/null
done

echo ""
echo "=== Pre-deploy snapshot complete ==="
echo "Skeleton tagged: $SKELETON_TAG_REF as $TAG"
echo "Modules tagged:  $MODULES_TAG_REF as $TAG"
echo ""
echo "ROLLBACK COMMANDS (if deploy fails):"
echo ""
echo "  cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2"
echo "  git reset --hard $TAG"
echo "  cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2"
echo "  git reset --hard $TAG"
echo "  cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2"
echo "  ./deploy.sh   # re-rsyncs the rolled-back state"
echo ""
echo "  ssh hetzner 'pm2 logs pipeline-api --lines 50 --err --nostream'   # check post-rollback state"
```

```bash
chmod +x /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2/scripts/pre-deploy-empty-pool-fix.sh
```

- [ ] **Step 2: Commit (skeleton repo)**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2
curl -s -X POST "$SUPABASE_URL/rest/v1/decision_log" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"project_name":"content-pipeline-v2","entry_type":"progress","summary":"Pre-deploy script for empty-pool-fix","decision_made":"Tags both repos, writes decision_log entries, prints paste-ready rollback recipe","source":"manual"}'
git add scripts/pre-deploy-empty-pool-fix.sh
git commit -m "tooling: pre-deploy script with rollback recipe

Before the empty-pool-fix deploy, run this script to tag both repos
(skeleton + modules) at the current HEAD, write decision_log entries
documenting the pre-deploy state, and print the exact rollback commands
to paste if anything goes wrong.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Run pre-deploy script + deploy

**Files:** none — operational task

- [ ] **Step 1: Run pre-deploy**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2
./scripts/pre-deploy-empty-pool-fix.sh
```

Expected: script completes without error, prints rollback recipe. Copy the rollback recipe into your clipboard / a notes file.

- [ ] **Step 2: Push remaining unpushed commits to both repos**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2
git push origin main
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2
git push origin main
```

- [ ] **Step 3: Deploy**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2
./deploy.sh
```

Expected: rsync succeeds, `npm install --omit=dev` succeeds, PM2 restarts pipeline-api/stage-worker/batch-worker. Final `pm2 status` shows all `online`.

- [ ] **Step 4: Verify the loader is happy with all manifests**

```bash
ssh hetzner 'pm2 logs pipeline-api --lines 30 --nostream 2>&1 | grep -iE "error|fail|valid"'
```

Expected: no errors. If the loader is unhappy, **immediate rollback** using the recipe from step 1.

---

## Task 13: Smoke test + Phase 3 validation

**Files:** none — validation task

- [ ] **Step 1: Run the unit tests against the deployed code**

```bash
cd /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2
node server/tests/data-operations.test.mjs
```

Expected: all assertions pass.

- [ ] **Step 2: Smoke test on 2 entities**

In the UI (https://www.jugadorvip.com), create a new project named `empty-pool-smoke-2026-05-22` with template `30 april` and just two entities:

- Pronet Gaming
- Wazdan

Start auto-execute. Watch the run progress.

Expected: Step 1 produces non-zero pool items per entity (verify in Supabase SQL Editor via:

```sql
SELECT entity_name, jsonb_array_length(pool_items) AS items
FROM entity_stage_pool
WHERE run_id = '<run-id>' AND step_index = 1
ORDER BY entity_name;
```

Both rows should have items > 0.

- [ ] **Step 3: Phase 3 validation on 5 entities**

If Step 2 looks clean, create the real validation project: `phase3-validation-2026-05-22-postfix` with template `30 april` and 5 entities:

- Pronet Gaming
- Wazdan
- Booming Games
- Altenar
- NSoft

Start auto-execute. Let it run through Step 7.

Verify post-run:

```sql
-- All 5 entities have pool items at every step that ran
SELECT step_index, entity_name, jsonb_array_length(pool_items) AS items
FROM entity_stage_pool
WHERE run_id = '<run-id>'
ORDER BY step_index, entity_name;

-- No entities are skipped_no_input (or if they are, the diagnostic makes sense)
SELECT submodule_id, entity_name, status, error
FROM entity_submodule_runs
WHERE run_id = '<run-id>' AND status = 'skipped_no_input';

-- No 500s from batchWorker (failed_count + completed_count check on submodule_runs)
SELECT submodule_id, status, completed_count, progress
FROM submodule_runs
WHERE run_id = '<run-id>'
ORDER BY started_at;
```

- [ ] **Step 4: Decision point**

If Step 3 passes (all 5 entities flowed cleanly through Step 7 with non-zero items at each step and no unexpected `skipped_no_input` rows), **the empty-pool bug is fixed.** Proceed to Phase 3's remaining batches (model_select on QA manifests, 50-entity E2E).

If Step 3 partially fails (e.g., 1 entity gets `skipped_no_input` mid-pipeline), the diagnostic in the error message tells you where the composition broke. Investigate that specific entity's pool history, **do not roll back unless the failure is widespread.**

If Step 3 widely fails, roll back using the recipe from Task 12 Step 1.

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Audit-helper script misses a pool-read pattern not in its regex list | Medium | Human review in Task 2 explicitly checks each module's execute.js. Script is a starting point, not the final say. |
| One of ~30 manifests is overlooked in Task 3 | Medium | Task 3 Step 2 grep-counts manifests with field present; Task 8 loader will fail at startup if any are missing — fail-closed catches this before traffic hits. |
| Auto-execute threshold logic in runs.js is more complex than the illustrative pattern in Task 5 | Medium | Task 5 Step 1 explicitly says "find every threshold-evaluation site" — multiple touchpoints. Reviewer follows the code. |
| Decision_log pre-commit hooks block the ~12 commits in this plan | High (proven blocker) | Every task's commit step includes a curl-write of the decision_log entry before `git commit`. Pre-deploy script Task 11 also writes one per repo. |
| Production deploy breaks mid-step for an in-flight run | Low (no active runs as of plan-write time) | Pre-deploy step Task 12 includes a manual check "any runs in `running` status?" before deploy. If yes, halt them via abort endpoint first. |
| PR pre-commit hook blocks commits with reference to issue-tracker IDs | Low — not used here | N/A |
| `phase3-routing.test.mjs` was written for current strict-transform behavior and breaks | Medium | Task 6 Step 5 explicitly runs it. If broken, the failure surfaces during refactor (Task 6), not during deploy. |
| `BullMQ` queue has pending jobs at deploy time | Low (no current runs) | PM2 restart drains then restarts; jobs persist in Redis and resume on restart. |

## Success Criteria

The plan is complete when **all of**:

1. `node server/tests/data-operations.test.mjs` passes (all 11+ assertions green) against the deployed skeleton.
2. `node server/tests/modes.test.mjs` and `node server/tests/phase3-routing.test.mjs` still pass.
3. Every module manifest has `pool_precondition` declared (audit-results.csv has zero `(none)` values; `moduleLoader` starts cleanly).
4. The smoke test on 2 entities (Pronet Gaming, Wazdan) shows non-zero `entity_stage_pool.pool_items` at Step 1 for both entities.
5. The Phase 3 validation on 5 entities completes through Step 7 with non-zero pool items per entity and no unexpected `skipped_no_input` rows.
6. Both repos' session logs reflect the change.
7. `modules/CLAUDE.md` rule 12 is the new orthogonal `data_operation × pool_precondition` decision table.
8. All commits pushed to origin/main on both repos.
9. Pre-deploy tag `pre-empty-pool-fix-2026-05-22` exists on both repos and can be rolled back to.

## Out of Scope

The following are deliberately deferred to follow-up work:

- **Drag-and-drop UI for pipeline composition** — separate work when prioritized. The pool_precondition contract is the prerequisite for this; it's now in place but no UI work is part of this plan.
- **A new `discover` data_operation** — rejected. Would be physically identical to `add` with documentation-only distinction. Programmatic enforcement via `pool_precondition` is the better solution.
- **Production integration tests creating real projects** — replaced with unit tests on the extracted `applyDataOperation`. Smoke + validation runs are the only real-data interactions.
- **Renaming `transform` to something less ambiguous (e.g., `refine`)** — acceptable debt. The new rule 12 disambiguates by pairing data_operation with pool_precondition.
- **UI surfacing of `pool_precondition`** — runtime check errors go to logs. Surfacing in the template editor (e.g., warn when composition obviously violates preconditions) is a future enhancement.
- **Step structure changes** — current step organization (Steps 0-10) stays. The contract is now independent of step position regardless.

---

## Self-Review (writing-plans skill)

**1. Spec coverage:**
- Empty-pool bug root cause → Issue Description ✓
- `pool_precondition` field added → Task 3 ✓
- 8 Step 1 manifests flipped to `add` → Task 4 ✓
- `'skipped_no_input'` status → Task 5 ✓
- Runtime precondition check → Task 7 ✓
- Manifest loader validation → Task 8 ✓
- `applyDataOperation` extracted + unit tests → Task 6 ✓
- Audit script + run → Tasks 1, 2 ✓
- Loop-router worked example → Task 9 ✓
- Rule 12 rewritten → Task 10 ✓
- Pre-deploy + rollback → Tasks 11, 12 ✓
- Smoke + validation → Task 13 ✓

**2. Placeholder scan:** No "TODO", "TBD", "fill in later", "similar to Task N". Every code block contains exact code. Decision_log curl invocations are repeated verbatim per commit step (intentional — engineer may execute tasks out of order).

**3. Type consistency:**
- `pool_precondition` values: `'empty_ok'` and `'requires_items'` used consistently across Tasks 3, 7, 8, 10.
- `'skipped_no_input'` status used consistently in Tasks 5, 7, 13.
- `applyDataOperation` signature: `(entityPool, approvedItems, dataOperation, itemKey, approvedKeySet)` matches in lib file, import, tests.
- `data_operation_default` enum values: `add`, `transform`, `remove` everywhere. No legacy `discover`.

**4. Sequencing rules enforced:**
- Tasks 1, 2, 3 (audit) before Task 8 (loader) ✓ — Task 8 Step 2 explicitly tests the loader against the audited manifests.
- Tasks 7 and 8 ship together ✓ — both committed to skeleton, both deployed in Task 12.
- Task 11 (pre-deploy) before Task 12 (deploy) ✓.
