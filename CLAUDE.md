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

## 🏷 CURRENT PHASE: 11 — Step 8 Bundling (code complete, flow test pending)

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
