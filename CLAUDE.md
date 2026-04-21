# CLAUDE.md — Content Creation Tool v2 (Skeleton Repo)

## ⛔ STOP — READ THIS ENTIRE FILE BEFORE WRITING ANY CODE

You are building the skeleton infrastructure for an 11-step content creation wizard. This repo is the BUILDING — walls, wiring, plumbing, doors. Submodules (the furniture) live in a separate repo.

---

## 📂 File System — CRITICAL

### Active repos (ALL work happens here):
- **Skeleton:** `/Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-v2/`
- **Modules:** `/Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/content-pipeline-modules-v2/`

### Archived (READ-ONLY, never write to):
- **v1 original:** `/Users/danieloskarsson/Library/CloudStorage/Dropbox/content-pipeline/`

### Specs (READ-ONLY reference — lives OUTSIDE this repo):
- `/Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/Content-Pipeline/specs/`

⛔ **Do NOT create a `specs/` folder inside this repo.** Specs live ONLY in the project folder above. Read them by path. Never copy, symlink, or duplicate them here. A previous copy caused spec divergence — the project folder fell behind while edits accumulated in the repo copy. Single source of truth = project folder.

**Phase 0 creates the v2 repos from scratch. The original repo stays at its current path as a READ-ONLY reference. V1 files are audited just-in-time in each phase — never bulk-copied. If you find yourself writing to `content-pipeline/` (without -v2), STOP — you are in the wrong directory.**

---

## 🧭 How You Work

### MANDATORY: Plan Before You Code

For EVERY phase:
1. **Read** the spec sections referenced in that phase
2. **Audit** any v1 files listed in the phase's "V1 Audit" section (open → compare against spec → decide REUSE/FIX/FRESH)
3. **Present a plan** listing: which files you'll create, which v1 files you'll reuse/fix, and what each change does
4. **Wait for approval** before writing any code
5. **Execute** the approved plan
6. **Verify** against the deliverables checklist

**NEVER skip the plan step.** If you start coding without presenting a plan first, you are doing it wrong.

### Phase Gating

You may ONLY work on the current phase. Check the `CURRENT PHASE` marker at the bottom of this file.

- Do NOT start the next phase until told to
- Do NOT "prepare" things for future phases
- Do NOT stub or scaffold future work
- If you discover the current phase needs something from a future phase, STOP and flag it

### When Existing Code Contradicts the Spec

The spec ALWAYS wins. Rewrite the code to match the spec. Do not adapt the spec to match existing code.

---

## 📚 Required Reading (in order)

| Document | Location | What it tells you |
|----------|----------|-------------------|
| SKELETON_SPEC_v2.md | Content-Pipeline/specs/ | Architecture, components, data flow, database schema — THE source of truth |
| BUILD_PLAN.md | Content-Pipeline/specs/ | Phased build sequence, what to copy vs build vs delete |
| UI_REFERENCE.md | Content-Pipeline/specs/ | Visual specs for every component, what changes vs stays, ownership model |
| STRATEGIC_ARCHITECTURE.md | Content-Pipeline/specs/ | Governing strategy (read once for context) |

**Before each phase:** Re-read the specific Parts of SKELETON_SPEC referenced in BUILD_PLAN for that phase.

---

## 🚫 Rules — Never Break These

### Architecture Rules
1. **No submodule-specific logic in this repo.** Ever. If you're writing code that only applies to one submodule, it belongs in the modules repo.
2. **No hardcoded step content.** Step names, descriptions, categories — all come from STEP_CONFIG or manifests. Never from component code.
3. **Universal step template for Steps 1–10.** One component renders all of them. There is no Step1Discovery.tsx, no Step2Validation.tsx.
4. **Skeleton renders slots. Modules fill them.** The only module-provided React component is the Options accordion slot. Everything else is skeleton-rendered using data/schema from modules.

### State Management Rules
5. **Zustand = UI state ONLY.** Which panel is open, which accordion is expanded, toast messages. NEVER domain data (projects, runs, entities).
6. **TanStack Query = ALL server data.** Projects, runs, steps, submodule results — all fetched and cached via TanStack Query.
7. **No fetch() in components.** All API calls go through hooks in `client/src/hooks/`. Components call hooks, never fetch directly.

### UI Rules (from UI_REFERENCE.md)
8. **Keep the existing visual design.** Colors, fonts, spacing, border styles, rounded corners — no changes unless UI_REFERENCE.md explicitly says to change it.
9. **SubmodulePanel: fixed 480px width.** Never resizes. `w-[480px] min-w-[480px] max-w-[480px]`.
10. **SubmodulePanel: one accordion open at a time.** Opening one closes the others.
11. **StepSummary: per-submodule rows, NOT an aggregate summary.** Each submodule provides its own summary content. Skeleton provides the container.
12. **Submodule rows show (left to right):** Data op toggle (➕➖＝) → checkbox → status dot → name + result count → description → arrow →.
13. **Results accordion action CTAs:** Change Input, Change Options, Download, Try again. These are at the bottom of the results list inside the accordion.
14. **CTA Footer (panel bottom):** RUN TASK, SEE RESULTS, APPROVE. Always visible, activation based on state.

### Code Quality Rules
15. **Each phase must compile and run.** No broken builds between phases. `npm run dev` must work after every phase.
16. **No TODO/FIXME stubs for future phases.** If it's not needed now, don't write it.
17. **No silent modifications to previous phases.** If Phase 5 needs a Phase 2 change, flag it and wait for approval.
18. **Run `/code-review` before every commit.** Spawn a review agent to check the diff for regressions, unintended side effects, scope creep, and breaking changes. Do NOT commit until the review passes. If the review finds issues, fix them first.

---

## 🏗 Tech Stack

- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS
- **Server state:** TanStack Query
- **UI state:** Zustand
- **Tables:** TanStack Table (Phase 7+ for results)
- **Backend:** Express.js + Node.js 20 LTS
- **Database:** Supabase PostgreSQL
- **Job queue:** Redis + BullMQ (Phase 7+)

---

## 📁 File Structure

```
content-pipeline-v2/
├── client/
│   ├── src/
│   │   ├── components/    ← UI components (NO fetch, NO domain state)
│   │   │   ├── layout/    ← AppHeader, Toast
│   │   │   ├── shared/    ← CategoryCardGrid, SubmodulePanel,
│   │   │   │                 StepSummary, StepApprovalFooter
│   │   │   ├── steps/     ← StepContainer
│   │   │   ├── primitives/← CsvUploadInput, SubmoduleOptions, ResultsList,
│   │   │   │                 ContentRenderer, UrlTextarea
│   │   │   └── pages/     ← ProjectsList, NewProject, RunView, Templates
│   │   ├── stores/        ← Zustand (UI state ONLY)
│   │   ├── hooks/         ← TanStack Query (ALL data fetching)
│   │   ├── api/           ← API client wrapper
│   │   ├── types/         ← TypeScript types
│   │   └── config/        ← STEP_CONFIG and other constants
│   └── ...config files
├── server/
│   ├── server.js
│   ├── routes/
│   ├── services/
│   └── workers/
├── sql/
│   └── schema.sql
└── CLAUDE.md              ← This file (no specs/ folder — specs live in Content-Pipeline/specs/)
```

---

## ✅ Architecture Self-Check

Run these before committing. All should return nothing:

```bash
# Stores must NOT contain domain data
grep -rn "entities\|projects:\s*\[\|selectedProjectId\|submodules:\s*\[" client/src/stores/ || echo "PASS: No domain data in stores"

# Components must NOT fetch directly  
grep -rn "fetch(\|axios\|supabase\." client/src/components/ || echo "PASS: No direct fetching in components"

# No step-specific components (should all be deleted)
ls client/src/components/steps/Step[0-9]*.tsx 2>/dev/null && echo "FAIL: Step-specific components exist" || echo "PASS: No step-specific components"

# No step-specific stores
ls client/src/stores/*discovery*  client/src/stores/*validation* 2>/dev/null && echo "FAIL: Step-specific stores exist" || echo "PASS: No step-specific stores"
```

---

## 🔄 Ownership Model (what renders what)

| Component | Skeleton owns | Module provides |
|-----------|--------------|----------------|
| Step accordion expand/collapse | ✅ | — |
| Category card grid | ✅ | Categories from manifest |
| Submodule rows (checkbox, status, data op) | ✅ | Status from submodule_runs |
| StepSummary container | ✅ area + data flow | Summary text per submodule |
| Panel header, description, data op indicator | ✅ | manifest fields |
| Input accordion (upload, preview, auto-resolve) | ✅ | — |
| Options accordion container | ✅ | React component OR options[] from manifest |
| Results accordion (list, checkboxes, pagination, CTAs) | ✅ via ContentRenderer | Data + output_schema |
| CTA footer | ✅ | — |

---

## 📋 Phase Checklist Reference

Detailed phase steps and deliverables are in **BUILD_PLAN.md**. Read that document for each phase.

Summary:
- **Phase 0:** Create empty v2 repos, copy inert config (vite/tailwind/tsconfig), seed modules, minimal main.tsx + server.js, git init
- **Phase 1:** Header bar, routing (3 pages), placeholder content
- **Phase 2:** Step 0 form, Supabase tables (projects, pipeline_runs, pipeline_stages), projects list
- **Phase 3:** Run View, vertical step accordion, Step 0 approval, universal step template (empty)
- **Phase 4:** Module auto-discovery, manifest reading, real category cards
- **Phase 5:** SubmodulePanel shell (3 accordions placeholder, CTA footer, data op toggle)
- **Phase 6:** Input accordion internals, Options accordion internals, file upload, ContentRenderer
- **Phase 7:** BullMQ execution, Results accordion, approval flow, working pool
- **Phase 8:** Step-to-step data flow, step approval aggregation, skip step
- **Phase 9:** First real submodules (in modules repo)
- **Phase 10:** Polish, error states, edge cases

---

## 🔗 Entity Name Contract

Every entity flowing into submodules MUST have a `name` field. All submodules use `entity.name` for logging, grouping, and output. The skeleton enforces this at the data boundary — submodules must never defensively handle missing names.

Enforcement is in `server/routes/stepContext.js` (three layers):
1. Column aliases resolved first (see below) so canonical `name` column is present
2. URL textarea: name auto-derived from hostname in `client/src/components/primitives/UrlTextarea.tsx` (`parseTextareaToEntities`)
3. Final safety net in stepContext.js: first non-empty string value on the entity, or "Entity N"

**Rule:** Contract enforcement belongs in the skeleton, not in individual submodules.

---

## ⏱ BatchWorker Timing Contract

The `batchWorker` (separate PM2 process in `server/workers/batchWorker.js`) finalizes the parent `submodule_runs` record AFTER all entity child jobs complete. There is a timing gap: `entity_submodule_runs` rows may all show `completed` before `batchWorker` updates the parent `submodule_runs.status` to `completed`.

**Rule:** Any code that checks batch completion by counting `entity_submodule_runs` MUST then wait for `submodule_runs.status` to reach `completed` before proceeding (e.g., approving). The `waitForSubmoduleRunStatus` helper in `autoExecutor.js` does this with a 30s polling loop.

**Why:** Without this wait, approval logic queries `submodule_runs` for `status='completed'`, finds nothing (still `pending`/`running`), and silently skips approval — data never enters the pool for the next step.

---

## 📎 Column Alias System

`COLUMN_ALIASES` in `server/routes/stepContext.js` maps common CSV/Excel header variants to canonical column names before `requires_columns` validation runs:

| Aliases | Canonical name |
|---------|---------------|
| "company name", "brand", "operator" | `name` |
| "url", "domain", "company url", "website url" | `website` |
| "youtube channel", "youtube url" | `youtube` |
| "linkedin url", "linkedin profile" | `linkedin` |

Drop zone hint in `client/src/components/primitives/CsvUploadInput.tsx` mentions aliases are accepted.

---

## ⚠️ Common Mistakes to Avoid

1. **Building the results table inside the skeleton as a fixed component.** The skeleton uses ContentRenderer which reads render_schema from the module's output_schema. Different modules produce different displays (url_list, table, content_cards, file_list).

2. **Putting the summary as one aggregate line.** StepSummary shows one row PER submodule, each with its own content from the module. Not "728 items total."

3. **Making the Options accordion a skeleton form.** Options is a SLOT. The module provides either a custom React component (options_component) or an options[] array that the skeleton auto-renders. If neither exists, show "No options."

4. **Hardcoding categories.** Categories come from the `category` field in submodule manifests. The skeleton groups by this field dynamically.

5. **Forgetting the action CTAs in Results.** Below the item list: Change Input, Change Options, Download, Try again. These are NOT in the footer — they're inside the Results accordion.

6. **Making the panel resizable or responsive.** Panel is exactly 480px. Always.

7. **Allowing multiple accordions open in the panel.** One at a time. Opening one closes the other.

8. **Working in the wrong directory.** The original `content-pipeline/` is a READ-ONLY reference. ALL work happens in `content-pipeline-v2/`. If your path doesn't end in `-v2/`, you're in the wrong place.

---

## 🏷 CURRENT PHASE: 12c — Auto-Execute Orchestration (UI + backend complete; E2E test pending)

Phases 0–10 are complete. Phase 11 Step 8 bundling submodules are code complete.

**Complete (Phases 0-10):**
- Full skeleton infrastructure: schema, BullMQ, React UI, step-to-step data flow
- Steps 1-5 end-to-end verified with real data (sitemap-parser through content-writer)
- All Phase 9/10 bug fixes applied (P9-001 through P9-011, K001/K004, R001-R009)
- Reference docs system, source_submodule stamping, data operation semantics

**Phase 11 — Code complete in modules repo (3 local commits, SSH push blocked):**
- markdown-output, html-output, json-output, meta-output, media-output built
- Data-shape routing pattern established (see modules repo CLAUDE.md)
- tools.http.head() added to stageWorker.js (P9-001 fix)

**Phase 11 — Skeleton bug fixes (NOT YET COMMITTED as of 2026-03-13):**
- Entity name contract: `stepContext.js` auto-derives name from URL/CSV, final safety net fallback
- Column alias system: `COLUMN_ALIASES` in `stepContext.js`
- `UrlTextarea.tsx`: `parseTextareaToEntities` derives name from hostname
- `CsvUploadInput.tsx`: drop zone hint updated to mention column aliases

**Next action:** Full flow test — Step 5 approve → skip 6 → skip 7 → Step 8 bundling with live data.

All findings tracked in `specs/BACKLOG.md`.

---

## 🧩 Parallel Submodule Development (decided 2026-03-20)

**Decision:** Submodules can be specced and built in parallel with skeleton bug fixes. They are pure functions with a defined contract (`input.entity` in, `{ entity_name, items, meta }` out), live in the modules repo, and don't touch the skeleton. A second Claude Code session, a freelancer, or work in claude.ai can produce them independently.

**28 research briefs** are ready at `Content-Pipeline/specs/submodule-briefs/`. Each brief follows the research brief template: what goes in, what comes out, approach, external dependencies, edge cases, cost estimate, and a concrete example output in per-entity format. Each can be handed to any developer to build the manifest + execute.js independently.

**Key corrections to the original submodule plan:**
- PSE Directories — one submodule with a configurable directory list (not one per directory)
- Curated List Import — separate from PSE; imports pre-built Google Sheets lists
- AI Discovery Scout runs first — generates search strategies and leads for downstream submodules
- Image & Logo Search — added to Step 1 (was missing)
- SEO Keyword Researcher — added to Step 5 using real tools (Ahrefs, SERPApi, GSC), not LLM-guessed
- Media Transcript Fetcher — moved from Step 5 to Step 3 (scraping is where it belongs)
- Step 5 media enrichment — split into three: Image Generator, Video Generator, Audio/TTS Generator

## Decision Log

This project uses automated decision logging via a PostToolUse hook.
A shell script fires after every Claude tool call and writes session checkpoints to Supabase every 60 minutes — zero tokens, fully automatic.

For important decisions, write a detailed entry:

```sql
INSERT INTO decision_log (project_name, entry_type, summary, decision_made, alternatives_rejected, reasoning, source)
VALUES ('content-pipeline-v2', 'decision', 'What was decided', 'The choice made', 'What was rejected', 'Why this choice', 'manual');
```

Entry types: decision | progress | blocker | idea

## Session Log

### Session: 2026-03-19 00:30 - Per-entity URL forwarding fixes
**Accomplished:**
- Fixed URL forwarding between steps in per-entity mode — root cause was GET endpoint putting entity summary objects into `working_pool`, which UI treated as data rows showing "5 in working pool" with empty cells
- Fixed transform approval doubling items (281→562) — key-based replacement instead of source_submodule filter
- Fixed deep-links not working — load entity properties from step_context instead of pool-derived data
- Implemented hard reset on step reopen — cascade delete of all data from reopened step onwards (submodule_runs, entity_submodule_runs, entity_stage_pool, step_context, run_submodule_config, item_data)
- Fixed ReferenceError: `logger` not defined in runs.js — crashed post-RPC code during step approval, leaving UI stuck
- Added lazy-populate for input_data from entity_stage_pool in GET endpoint
- CTO self-review: removed over-engineered bandaids (manual pool verification, dead code fallback), kept only root cause fix

**Decisions:**
- Entity summaries go to `entity_pool_summary` (separate response field), never `working_pool` — UI treats working_pool items as data rows
- `input_data` on pipeline_stages is a denormalized copy for UI display only; entity_stage_pool is the execution source of truth
- Lazy-populate pattern: GET endpoint writes input_data from entity pools when missing, persists to DB for subsequent requests

**Blockers/Questions:**
- UI may still show stale "5 in working pool" due to browser cache — user needs hard refresh (Cmd+Shift+R)
- Browser-crawler has connection failures for Cloudflare-protected sites (punterslounge.com, playngo.com, tipstly.com)

**Updated by:** session-closer agent

### Session: 2026-03-19 01:00 - Null byte sanitization fix
**Accomplished:**
- Investigated url-filter HEAD request behavior — Cloudflare returns 403 to HEAD requests, removing all URLs from protected sites; option only useful for stale URL lists
- Diagnosed Play'n GO Step 3 failure: "unsupported Unicode escape sequence" — null bytes in scraped HTML rejected by PostgreSQL JSONB column
- Root cause: per-entity mode processes entities individually, keeping text_content under the 1MB stripping threshold, so null bytes reach output_data JSONB (legacy mode combined all entities, exceeding threshold, stripping fields)
- Fixed stageWorker.js: added null byte sanitization before DB write in both per-entity and legacy paths — global fix for all submodules
- Committed and pushed (4f50390), auto-deploys via GitHub Actions

**Decisions:**
- url-filter check_status_codes is counterproductive for Cloudflare-protected iGaming sites — leave disabled
- Null byte sanitization in stageWorker.js (central worker) rather than per-submodule — single fix covers all
- 1MB stripping threshold inconsistency between legacy/per-entity is benign (content always saved to item_data table first)

**Blockers/Questions:**
- SSH access to Hetzner (188.245.110.34) broken — cannot check PM2 logs directly
- Systematic per-entity audit still pending (CTO recommendation from previous session)

**Updated by:** session-closer agent

### Session: 2026-03-21 21:00 - API scraper + pool dedup fix
**Accomplished:**
- Created api-scraper submodule (Step 3.3) — ScrapFly API fallback for Cloudflare-protected sites, only processes pages that failed page-scraper and browser-scraper
- Iteratively fixed Cloudflare block page detection through 5 commits: raw HTML detection, extracted text detection, duplicate text detection across pages, partition logic for upstream block pages
- Fixed critical per-entity pool dedup bug — `add` data_operation was deduplicating by `item_key` alone, causing sibling submodule items (seo-planner) to be silently dropped when they shared the same `item_key` (entity_name) as content-analyzer
- Deployed SCRAPFLY_KEY to both local .env and Hetzner production
- All changes auto-deployed via GitHub Actions CI/CD

**Decisions:**
- Per-entity `add` approval uses composite key (item_key + source_submodule) — aligns with non-per-entity path which already did this correctly
- ScrapFly geo-location defaults to empty (auto-select) — no hardcoded country
- Duplicate text detection threshold: 3+ pages with identical text_content = block page (demote to error)
- api-scraper is a separate submodule (not integrated into browser-scraper) because it costs money per request

**Blockers/Questions:**
- api-scraper live test pending — need to re-run Step 5 submodules (content-analyzer → seo-planner → content-writer) after pool dedup fix
- ScrapFly returned Cloudflare block pages for Punters Lounge — may need different ASP settings or proxy country

**Updated by:** session-closer agent

### Session: 2026-03-23 01:00 - Failure display, Download All CTA, code review skill
**Accomplished:**
- Fixed ROOT CAUSE of empty extracted text: FK constraint on `submodule_run_item_data` silently rejected all per-entity inserts (table had 0 rows ever). Dropped FK, updated schema.sql. Added `?full=true` to per-entity detail endpoint.
- Created `/code-review` skill — mandatory pre-commit code review by independent agent. Added as rule 18 (skeleton) and rule 9 (modules).
- Fixed all-or-nothing entity failure display: stageWorker catch block now writes synthetic error items to output_data. Added diagnostic logging for entities with 0 input items. UI now has three mutually exclusive states (items / empty / error).
- Added Download All CTA for per-entity batch mode: new `GET /api/submodule-runs/:id/all-items` endpoint aggregates items across all entity runs. Both CSV and ZIP downloads work. `ResultsActionCTAs` now supports `batchRunId` prop.
- Fixed hardcoded `url` in enrichment logic → now uses `manifest.item_key`

**Decisions:**
- Synthetic error items in stageWorker catch block — defensive fix even if root cause may be empty pool_items (CTO review finding)
- Three mutually exclusive UI display states instead of overlapping "No items returned" + error messages
- Server-side batch item aggregation (single endpoint) rather than N+1 client-side fetches for downloads
- FK constraint permanently removed — polymorphic column references two parent tables (PG can't enforce)

**Blockers/Questions:**
- Root cause of "Play'n GO 0 items" unknown — diagnostic logging added, needs next run to confirm if pool_items are empty
- Existing runs before FK fix have no text_content stored — need re-run to populate detail view
- No SSH access to Hetzner for direct PM2 log inspection

**Updated by:** session-closer agent

### Session: 2026-03-23 16:00 - Scraper fixes, boilerplate detection, deploy verification
**Accomplished:**
- Fixed ROOT CAUSE of text_content data loss: FK constraint on `submodule_run_item_data` silently rejected per-entity inserts. Added `insertFailed` guard to prevent stripping when inserts fail. Created migration SQL to drop FK.
- Added Abort button for running/pending submodule runs (server endpoint + worker abort-awareness + UI)
- Implemented partial results on timeout via `tools._partialItems` — completed items survive entity timeouts
- Increased expensive entity timeout from 10 to 30 minutes
- Fixed zip filename collisions: URLs with same last path segment overwrote each other (525 items → 295 files). Now uses full URL path + dedup counter.
- Added `/api/version` endpoint — CI writes `build-info.json`, server reads it. Shows deployed commit for both repos.
- Investigated Play'n GO download gap: queried production API, found 525/525 success but 198 pages had identical footer text. Boilerplate detection was the correct trigger for browser re-scrape.

**Decisions:**
- FK constraint permanently removed — polymorphic column references two parent tables
- Zip filenames use full URL path joined with underscores + counter for duplicates
- Version endpoint reads build-info.json from disk (rsync excludes .git)

**Blockers/Questions:**
- SSH to Hetzner broken — password auth denied, can only verify via API
- og:description truncation detection added to page-scraper (needs flow test)

**Updated by:** session-closer agent

### Session: 2026-03-24 — og:description truncation detection across Step 3 scrapers
**Accomplished:**
- Investigated why Play'n GO PokerStars article couldn't be scraped (Wix JS-rendered page with only 2 paragraphs SSR'd, rest loads via JavaScript)
- Key finding: SSR'd body text (~60 words) passes the 50-word threshold, so page-scraper marks it "success" with truncated content
- Added `extractOgDescription()` and `isLikelyTruncated()` helpers to all 3 Step 3 scrapers (page-scraper, browser-scraper, api-scraper)
- page-scraper: if body text <= og:description length (100+ chars), marks as `low_content` to cascade to browser-scraper
- browser-scraper: adds `waitForSelector` for content containers, truncation check cascades to api-scraper if still truncated
- api-scraper: handles `low_content` in partition logic, flags `possibly_truncated: true` on final output
- Made `waitForSelector` non-fatal in `browserPool.js` (skeleton) — try/catch wrapper logs warning instead of throwing
- Code review caught missing `decodeEntities()` in api-scraper's `extractOgDescription` — fixed before commit

**Decisions:**
- og:description meta tag used as truncation signal — conservative check: body text must be shorter than the summary itself, which should never happen for a complete article
- Truncation is a cascade trigger (not hard failure) — pages flow to next scraper in the chain
- `waitForSelector` made non-fatal because selector absence shouldn't crash the entire scrape attempt

**Blockers/Questions:**
- None — both repos committed (d64fc37, 9832f4e) and pushed, CI/CD will deploy

**Updated by:** session-closer agent

### Session: 2026-04-03 — Phase 12c Auto-Execute UI + Bug Fixes + Fallback Logic
**Accomplished:**
- Completed Batch 5 (UI MVP) of Phase 12c: 7 files modified — ProjectsList.tsx (status dots), RunView.tsx (AutoExecuteBanner, HaltedBanner, AutoExecuteButton, friendly labels), RunReport.tsx (friendly labels), useRun.ts (10s polling for auto_executing), SubmodulePanel.tsx (disabled buttons during auto-exec), UniversalStepTemplate.tsx (prop passthrough), types/step.ts (auto_executing/halted union + AutoExecuteState interface)
- Fixed 5 review issues (parallel code review + CTO review): catch block state clobbering, startup recovery state preservation, resume state preservation via previousState param, negative sleep guard (Math.max(0,...)), abandon guard (400 when auto_executing)
- Committed and pushed Phase 12c as bf43a14 (13 files, 1090 insertions)
- Fixed PGRST116 handling: auto-execute and resume endpoints returned 500 for non-existent runs — fixed, pushed as 7813b5c
- Added Auto-Execute button to RunView header (indigo, visible when status=running) — pushed as 7eaa339
- Wrote 13-section 60+ test case protocol saved to Content-Pipeline/specs/PHASE_12C_TEST_PROTOCOL.md
- Ran API guard tests: 4/4 pass (non-existent run 404, resume non-halted 400, abort nothing 400, no submodules 400)
- Added submodules_per_step fallback in server/routes/runs.js: derives from module registry when template has no explicit config — written but NOT yet committed (needs code review first)

**Decisions:**
- Fallback submodules_per_step from registry: when template has no explicit config, auto-populate from registered modules at each step — avoids requiring a manual pipeline run before auto-execute works
- No docs in code repos: documentation/planning files go in Content-Pipeline/specs/, not in skeleton or modules repos — test protocol moved accordingly
- Port 3002 for local testing: command center occupies 3001, pipeline server started on 3002 for testing

**Blockers/Questions:**
- submodules_per_step fallback (runs.js) not yet committed — needs /code-review then commit/push before it's live
- Full E2E auto-execute test not done — need happy path + halt/resume + abort flows with real entities in browser
- Production server needs restart after CI/CD deploy of Phase 12c code

**Updated by:** session-closer agent

