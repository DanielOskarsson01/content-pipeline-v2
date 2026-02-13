# Content Creation Tool — Build Plan

> **Version:** 2.0 — February 10, 2026
> **Reads from:** SKELETON_SPEC_v2.md, SUBMODULE_DEVELOPMENT.md
> **Purpose:** Phased build sequence for Claude Code. Each phase is a self-contained unit of work. Complete one phase fully before starting the next.
> **Strategy:** Clean start. Selectively copy audited files when each phase needs them.

---

## Ground Rules

### For Claude Code — READ THIS FIRST

1. **Read the spec before writing code.** Every phase references specific Parts of SKELETON_SPEC_v2.md. Read those Parts. Do not guess.
2. **Build exactly what the spec says.** Do not add features, "improve" patterns, or anticipate future needs.
3. **Do not touch previous phases.** If Phase 3 requires a change to Phase 1 code, flag it — do not silently modify.
4. **No placeholder "TODO" code.** Each phase must be functional when complete. If something isn't needed yet, don't stub it.
5. **Test each phase before moving on.** The app must compile, render, and function after every phase.

### Strategy: Clean Start + Just-in-Time Audit

The v2 repos are created EMPTY. No bulk copy. No mass delete.

**How it works:**
1. Phase 0 creates empty folder structures + copies ONLY inert config (vite, tailwind, tsconfig, package.json, etc.)
2. Each subsequent phase lists v1 files to AUDIT before building
3. For each v1 file: open it → compare against spec → decide: REUSE (copy as-is), FIX (modify then copy), or WRITE FRESH
4. Only audited, spec-compliant code enters v2

**Why this approach:**
- No leftover cruft — every file in v2 exists because it was explicitly vetted
- No premature copying — files arrive when their phase needs them
- Preserves accumulated knowledge — edge cases, debug fixes, patterns we already solved
- Claude Code never sees irrelevant v1 files that might contaminate new code

**The existing codebase is a READ-ONLY reference.** Located at:
`/Users/danieloskarsson/Library/CloudStorage/Dropbox/content-pipeline/`

**The spec always wins.** When existing code contradicts the spec, write fresh to match the spec.

### V1 Audit Protocol (used by every phase)

When a phase lists "v1 audit" files, follow this process FOR EACH FILE:

1. **Open** the v1 file and read it fully
2. **Compare** against the spec sections referenced by the current phase
3. **Decide:**
   - **REUSE** → File matches spec. Copy to v2 target path as-is.
   - **FIX** → File is mostly right but has spec deviations. Fix in a temp location, then copy to v2.
   - **WRITE FRESH** → File is too far from spec or too tangled with v1 patterns. Write new code from spec.
4. **Log** the decision for each file (print: "filename → REUSE/FIX/FRESH — reason")
5. **Never copy a v1 file without reading it first**

### Two Repos — Physical Separation

```
content-pipeline-v2/              ← Skeleton repo (clean start)
content-pipeline-modules-v2/      ← Modules repo (new)
```

Both repos live under: `/Users/danieloskarsson/Library/CloudStorage/Dropbox/`

The v2 repos live in Dropbox root (same level as the original). The specs remain in their current location and are COPIED into the skeleton repo's specs/ folder.

Source repo (READ-ONLY reference): `/Users/danieloskarsson/Library/CloudStorage/Dropbox/content-pipeline/`
Specs location: `/Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/Content-Pipeline/specs/`

### Tech Stack (from Spec Part 20)

- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS
- **Server state:** TanStack Query
- **UI state:** Zustand
- **Tables:** TanStack Table (when needed, Phase 6+)
- **Backend:** Express.js + Node.js 20 LTS
- **Database:** Supabase PostgreSQL
- **Job queue:** Redis + BullMQ (Phase 7+)
- **Process manager:** PM2 (production only)

---

## V1 Codebase Reference Map

These tables catalog every v1 file and its expected disposition. They are NOT a Phase 0 checklist — files are audited just-in-time when each phase needs them. Each phase's "V1 Audit" section lists which files to open from this map.

Source repo (READ-ONLY): `/Users/danieloskarsson/Library/CloudStorage/Dropbox/content-pipeline/`

### Likely REUSE (expected to pass audit as-is)
| File | Why |
|------|-----|
| `client/src/stores/appStore.ts` | Toast + activeTab, clean Zustand, identical to v2 needs |
| `client/src/stores/panelStore.ts` | Panel visibility + accordion state, matches v2 spec |
| `client/src/components/layout/Toast.tsx` | Works perfectly |
| `client/src/api/client.ts` | apiFetch wrapper, queryClient setup, error handling. API shapes change but plumbing stays |
| `client/src/hooks/useUrlParams.ts` | URL-based project/run routing |
| `services/db.js` | Supabase client, 12 lines |
| `client/vite.config.ts` | Build config |
| `client/tailwind.config.js` | Tailwind config |
| `client/tsconfig.json` + `tsconfig.app.json` + `tsconfig.node.json` | TypeScript config |
| `client/postcss.config.js` | PostCSS config |
| `client/package.json` | Dependencies (React 18, TanStack Query, Zustand, Tailwind, Vite) |
| `package.json` (root) | Server dependencies (Express, BullMQ, Supabase, ioredis) |
| `.env.example` | Environment template |
| `.gitignore` | Standard ignores |

### Likely FIX or FRESH (expected to need changes — audit decides)
| File | Changes needed |
|------|---------------|
| `client/src/components/layout/AppHeader.tsx` | Update nav items to: New Project, Projects, Templates |
| `client/src/components/shared/StepApprovalFooter.tsx` | Add [SKIP STEP] button per spec |
| `client/src/components/shared/StepSummary.tsx` | Minor — add working pool count display |
| `client/src/components/shared/CategoryCardGrid.tsx` | Add status-based display (idle/running/has_results/approved), spinner, data operation icon (➕➖＝) |
| `client/src/components/shared/SubmodulePanel.tsx` | Fix to spec's three fixed accordions (Input/Options/Results), spec-exact CTA button logic, data operation toggle |
| `client/src/components/steps/StepContainer.tsx` | Become universal step template — add auto-discovery trigger, working pool display, skip button |
| `client/src/hooks/useSubmodules.ts` | Keep mutation/query patterns, update API shapes to match spec Part 16 |
| `client/src/hooks/useStepContext.ts` | Keep concept, update to v2 step_context table shape |
| `client/src/stores/pipelineStore.ts` | Drop hardcoded category lists, become generic step expansion tracker |
| `client/src/types/step.ts` | Update types to match spec |
| `client/src/router.tsx` | Update routes: /new, /projects, /projects/:id/runs/:runId |
| `client/src/App.tsx` | Simplify to RouterProvider only (routing handles layout) |
| `server.js` | Remove WebSocket code, keep Express setup |
| `routes/submodules.js` | Module loading + execution patterns transferable, update API shapes per spec Part 16 |
| `routes/projects.js` | Keep CRUD, update to v2 schema |
| `workers/stageWorker.js` | Keep BullMQ pattern, update execution model to v2 |

### SKIP (never copy — v1-only, replaced by v2 architecture)
| File | Why |
|------|-----|
| `client/src/components/steps/Step1Discovery.tsx` | Replaced by universal step template |
| `client/src/components/steps/Step2Validation.tsx` | Replaced by universal step template |
| `client/src/components/panels/Step1Panel.tsx` | Replaced by universal pane template |
| `client/src/components/panels/Step2Panel.tsx` | Replaced by universal pane template |
| `client/src/stores/discoveryStore.ts` | Step-specific store, replaced by universal pattern |
| `client/src/stores/validationStore.ts` | Step-specific store, replaced by universal pattern |
| `services/orchestrator.js` | v2 has different orchestration model |
| `services/entityService.js` | v2 doesn't use entities table same way |
| `services/templateService.js` | Rebuild for v2 templates |
| `routes/entities.js` | v2 doesn't have separate entities routes |
| `routes/generated-content.js` | v2 doesn't have this |
| `routes/templates.js` | Rebuild for v2 |
| `modules/` (entire folder) | Submodules move to separate modules repo |
| `config/categories.js` | v2 uses manifest-driven categories |
| `public-legacy-dashboard/` | Legacy, not needed |
| `sql/*.sql` (all existing) | v2 has new schema |
| `tests/` | Start fresh with v2 tests |
| `CLAUDE.md` (root) | Old v1 CLAUDE.md — replaced by new one from specs/ |
| `docker-compose.yml` | Rebuild when needed |
| `Dockerfile` | Rebuild when needed |
| `.github/` | Rebuild when needed |
| `dev.sh` | Rebuild for v2 structure |
| `ecosystem.config.js` | Rebuild for v2 |
| `playwright.config.js` | Rebuild when needed |
| `middleware/errorHandler.js` | v1-only middleware |
| `utils/aiProvider.js` | v1-only, future tools.ai |
| `utils/browser.js` | v1-only |
| `routes/health.js` | Phase 0 creates inline health endpoint |

---

## Phase 0 — Repo Scaffold (Clean Start)

**Goal:** Two empty repos exist with correct folder structures. Inert config files copied. Seed modules in place. Dev server runs.

### Steps

**⚠️ FILE SYSTEM CLARITY: Do these steps IN ORDER. No skipping.**

1. **Create skeleton repo** with empty folder structure:
   ```
   /Users/danieloskarsson/Library/CloudStorage/Dropbox/content-pipeline-v2/
   ├── client/
   │   └── src/
   │       ├── api/
   │       ├── components/
   │       │   ├── layout/
   │       │   ├── shared/
   │       │   ├── steps/
   │       │   ├── primitives/
   │       │   └── pages/
   │       ├── config/
   │       ├── hooks/
   │       ├── stores/
   │       └── types/
   ├── server/
   │   ├── routes/
   │   ├── services/
   │   └── workers/
   ├── sql/
   └── specs/
   ```

2. **Create modules repo** with seed modules:
   ```
   /Users/danieloskarsson/Library/CloudStorage/Dropbox/content-pipeline-modules-v2/
   ├── CLAUDE.md
   └── modules/
       ├── step-1-discovery/
       │   └── sitemap-parser/
       │       ├── manifest.json
       │       └── execute.js
       └── step-2-validation/
           └── url-dedup/
               ├── manifest.json
               └── execute.js
   ```

3. **Copy seed modules** from specs into modules repo:
   ```bash
   cp -r /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/Content-Pipeline/specs/seed-modules/* \
         /Users/danieloskarsson/Library/CloudStorage/Dropbox/content-pipeline-modules-v2/modules/
   ```

4. **Copy modules CLAUDE.md:**
   ```bash
   cp /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/Content-Pipeline/specs/CLAUDE_MODULES.md \
      /Users/danieloskarsson/Library/CloudStorage/Dropbox/content-pipeline-modules-v2/CLAUDE.md
   ```

5. **Copy specs** into v2 skeleton repo:
   ```bash
   cp /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/Content-Pipeline/specs/SKELETON_SPEC_v2.md \
      /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/Content-Pipeline/specs/BUILD_PLAN.md \
      /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/Content-Pipeline/specs/UI_REFERENCE.md \
      /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/Content-Pipeline/specs/SUBMODULE_DEVELOPMENT.md \
      /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/Content-Pipeline/specs/STRATEGIC_ARCHITECTURE.md \
      /Users/danieloskarsson/Library/CloudStorage/Dropbox/content-pipeline-v2/specs/
   ```

6. **Copy skeleton CLAUDE.md** to repo root:
   ```bash
   cp /Users/danieloskarsson/Library/CloudStorage/Dropbox/Projects/OnlyiGaming/Content-Pipeline/specs/CLAUDE.md \
      /Users/danieloskarsson/Library/CloudStorage/Dropbox/content-pipeline-v2/CLAUDE.md
   ```

7. **Copy inert config files** from v1 repo (these are boilerplate with zero logic):
   ```
   FROM: /Users/danieloskarsson/Library/CloudStorage/Dropbox/content-pipeline/
   TO:   /Users/danieloskarsson/Library/CloudStorage/Dropbox/content-pipeline-v2/

   client/vite.config.ts        → client/vite.config.ts
   client/tailwind.config.js    → client/tailwind.config.js
   client/tsconfig.json         → client/tsconfig.json
   client/tsconfig.app.json     → client/tsconfig.app.json
   client/tsconfig.node.json    → client/tsconfig.node.json
   client/postcss.config.js     → client/postcss.config.js
   client/index.html            → client/index.html
   client/src/index.css         → client/src/index.css
   .env.example                 → .env.example
   .gitignore                   → .gitignore
   ```
   ⚠️ Do NOT copy package.json files yet. They need auditing (may have unwanted dependencies).

8. **Audit and copy package.json files** — Open each, remove dependencies not in the spec's tech stack:
   - `client/package.json` — Keep: react, react-dom, @tanstack/react-query, zustand, tailwindcss, vite, typescript. Remove anything step-specific.
   - Root `package.json` — Keep: express, @supabase/supabase-js, bullmq, ioredis, dotenv, cors. Remove anything step-specific. Ensure `"type": "module"` is set (v2 uses ESM throughout — `import`/`export`, not `require()`). Add `"scripts": { "dev:server": "node server/server.js" }`.
   - Copy cleaned versions to v2.

9. **Create empty `sql/schema.sql`** — Will be populated in Phase 2.

10. **npm install** in v2 repo — both client/ and root. Verify no errors.

11. **Create minimal client/src/main.tsx** — Just enough to mount React:
    ```tsx
    import React from 'react'
    import ReactDOM from 'react-dom/client'
    import './index.css'

    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <div className="p-8 text-lg">Content Pipeline v2 — Shell ready</div>
      </React.StrictMode>
    )
    ```

12. **Create minimal server/server.js** — Just enough to serve:
    ```javascript
    import express from 'express';
    const app = express();
    app.use(express.json());
    app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => console.log(`Server running on :${PORT}`));
    ```

13. **npm run dev** — Vite dev server starts, page loads with "Content Pipeline v2 — Shell ready".

14. **git init** + initial commit in both v2 repos.

### Do NOT do in Phase 0
- Copy any v1 React components, hooks, stores, or routes
- Copy any v1 server routes or services (except db.js if needed)
- Create any application logic
- These all happen in Phases 1-9 via the just-in-time audit process

### Deliverables
- [ ] content-pipeline-v2/ created with clean folder structure
- [ ] content-pipeline-modules-v2/ created with seed modules
- [ ] Seed modules present: sitemap-parser (Step 1) and url-dedup (Step 2) with manifest.json + execute.js
- [ ] Specs copied to v2/specs/
- [ ] CLAUDE.md at root of both repos
- [ ] Inert config files copied (vite, tailwind, tsconfig, postcss, index.html, index.css, .env.example, .gitignore)
- [ ] package.json files audited and cleaned
- [ ] `npm install` works (client + root)
- [ ] `npm run dev` starts Vite dev server — page loads
- [ ] Minimal Express server runs on :3001
- [ ] git init + initial commit in both repos

---

## Phase 1 — Shell UI

**Goal:** Header bar with navigation, routing between three pages, all showing placeholder content. Adapted from existing AppHeader + router.

**Spec reference:** Part 3 (UI Shell — Top-Level Structure)

### V1 Audit (open → compare against spec → REUSE / FIX / FRESH)
- `AppHeader.tsx` → compare against Part 3. Nav items need changing to [New Project, Projects, Templates].
- `router.tsx` → compare against Part 3. Routes need updating to /new, /projects, /templates.
- `App.tsx` → compare against Part 3. Existing has both router-based and tab-based rendering — should be router only.
- `Toast.tsx` → likely REUSE (standalone utility, no step-specific logic).
- `appStore.ts` → likely REUSE (toast state used by many components).
- `main.tsx` → compare against Phase 0 minimal version. May already be replaced.

### Build
1. **Header bar** — Update existing. Fixed top. Logo "OnlyiGaming Content Tool" on left. Three nav items.
2. **Routing** — Update existing router.tsx. Three routes with placeholder content. Also add `/projects/:projectId/runs/:runId` → placeholder "Run View" page (Phase 2 will redirect here after project creation, Phase 3 builds the real content).
3. **Styling** — Keep existing Tailwind setup. Dark header, light content area.

### Do NOT build
- Run View (Phase 3)
- Any data fetching
- Any Supabase connection
- Step navigation

### Deliverables
- [ ] Header renders on all pages with updated nav
- [ ] Nav items highlight active route
- [ ] All three routes work
- [ ] Templates page shows empty state
- [ ] No console errors
- [ ] Old tab-based navigation removed (appStore.activeTab can stay but isn't used for routing)

---

## Phase 2 — Step 0: Project Creation

**Goal:** User can create a project. Data persists in Supabase. After creation, user lands on the Run View (placeholder).

**Spec reference:** Part 4 (Step 0), Part 10 (Database Schema — projects, pipeline_runs, pipeline_stages tables)

### V1 Audit (open → compare against spec → REUSE / FIX / FRESH)
- `Step0ProjectSetup.tsx` → compare against Part 4. Has project creation form + TanStack Query mutations. Schema fields differ in v2.
- `routes/projects.js` → compare against Part 10 + Part 16. Has CRUD routes. Schema differs.
- `api/client.ts` → compare against Part 16. Has `api.getProjects`, `api.createProject`. Types need updating.
- `services/db.js` → likely REUSE (just Supabase client init).
- `server.js` → compare against Phase 0 minimal version. Remove WebSocket/Redis pub-sub. Keep Express + CORS + JSON + static.
- `types/step.ts` → compare against Part 10 + STEP_CONFIG. Update types to match v2 schema.

### Build

1. **Database schema** — Create NEW tables in Supabase (from spec Part 10). Drop/ignore old tables.
   - `projects` (id, name, description, timing, template_id, status, created_at)
   - `pipeline_runs` (id, project_id, status, current_step, started_at, completed_at)
   - `pipeline_stages` (id, run_id, step_index, step_name, status, input_data, input_render_schema, output_data, output_render_schema, working_pool, working_pool_render_schema, started_at, completed_at)

2. **Step 0 form** — At `/new`:
   - Project Name (required)
   - Template (disabled, "Coming in v2")
   - Parent Project (optional, disabled in v1)
   - Intent (optional freeform text)
   - Timing (optional, disabled — "Not available yet". Placeholder for: one-off / scheduled / continuous)
   - [Create & Start Run] button
   - **NO Description field.** This was removed per UI_REFERENCE.md.
   - **NO Content Type field.** Old remnant — removed.

3. **Server route** — `POST /api/projects`:
   - Creates projects row
   - Creates pipeline_runs row (status: "running", current_step: 0)
   - Creates 11 pipeline_stages rows (step 0 = "active", steps 1-10 = "pending")
   - Returns project + run IDs

4. **After creation** — Redirect to `/projects/:projectId/runs/:runId`

5. **Projects list** — At `/projects`:
   - `GET /api/projects` → List all projects
   - Show name, description, status, created date
   - Click → navigate to latest run

6. **Express server** — server.js:
   - Remove WebSocket code
   - Remove Redis pub/sub subscriber
   - Keep: Express, CORS, JSON parsing, static file serving, SPA fallback
   - Port: 3001 (or keep 3000 — update Vite proxy)

### STEP_CONFIG

Define a constant for all 11 steps. This is used everywhere steps are referenced:

```typescript
const STEP_CONFIG = [
  { index: 0, name: "Project Start", description: "Define project scope and metadata" },
  { index: 1, name: "Discovery", description: "Find candidate sources and seed data" },
  { index: 2, name: "Validation", description: "Filter before committing to expensive operations" },
  { index: 3, name: "Scraping", description: "Fetch actual content from validated sources" },
  { index: 4, name: "Filtering & Assembly", description: "Clean and organize into source packages" },
  { index: 5, name: "Analysis & Generation", description: "Produce output content from sources" },
  { index: 6, name: "Quality Assurance", description: "Verify output meets standards" },
  { index: 7, name: "Routing", description: "Decide what happens to items that fail QA" },
  { index: 8, name: "Bundling", description: "Package into delivery formats" },
  { index: 9, name: "Distribution", description: "Push to external systems" },
  { index: 10, name: "Review", description: "Final human gate before publication" }
];
```

This STEP_CONFIG is copied verbatim from SKELETON_SPEC_v2.md Part 5. It is the single source of truth. Do NOT modify it.

### Do NOT build
- Step approval for Step 0 (Phase 3)
- Run View internals (Phase 3)
- Any submodule UI

### Deliverables
- [ ] Supabase tables created (projects, pipeline_runs, pipeline_stages)
- [ ] Project creation form works
- [ ] Data persists in Supabase
- [ ] Projects list shows created projects
- [ ] Click project → navigates to run view (placeholder)
- [ ] Express server running on :3001
- [ ] WebSocket code removed from server.js

---

## Phase 3 — Universal Step Template + Run View

**Goal:** When viewing a run, user sees the vertical step accordion and the active step's workspace. Expanding a step renders the universal step template with category cards (hardcoded dummy data for now).

**Spec reference:** Part 3 (Run View), Part 5 (Universal Step Template), Part 8 (Data Flow — Level 1)

### V1 Audit (open → compare against spec → REUSE / FIX / FRESH)
- `StepContainer.tsx` → compare against Part 3 + Part 5. Has collapsible step pattern with status badges. Internals must become universal (category cards from manifests, not step-specific content).
- `pipelineStore.ts` → compare against Part 3. Has step expansion state. Must be generic (no hardcoded step references).
- `StepApprovalFooter.tsx` → compare against Part 5. Need [SKIP STEP] button added.
- `StepSummary.tsx` → compare against Part 5. Minor updates likely.
- `useUrlParams.ts` → likely REUSE. URL-based project/run routing needed for Run View.

### Build

1. **Vertical step accordion** — Keep existing layout exactly. Each step is a collapsible card showing:
   - Numbered circle with status color (green=completed, blue=active, gray=pending)
   - Step name + description
   - Status badge (completed/active/pending/skipped)
   - Expand/collapse arrow
   - Active step auto-expanded, completed steps clickable to expand read-only output
   - Pending steps collapsed + grayed out

2. **Run View** — At `/projects/:projectId/runs/:runId`:
   - Reads pipeline_stages from Supabase for this run
   - Renders step navigation from real status data
   - Below navigation: renders the active step's workspace

3. **Step 0 in Run View** — Step 0 shows project summary (name, description, intent). [APPROVE STEP] button. Clicking approve:
   - Sets step 0 status → "completed"
   - Sets step 1 status → "active"
   - Updates pipeline_runs.current_step → 1
   - Step navigation updates

4. **Universal Step Template** — For steps 1-10 (all identical structure):
   - Step header: step name, description, status badge
   - CategoryCardGrid area (empty for now — "No submodules available" message)
   - StepSummary bar (zero counts)
   - StepApprovalFooter: [APPROVE STEP] disabled (no approved submodules), [SKIP STEP] enabled

5. **API routes:**
   - `GET /api/runs/:id` — Run status, current step
   - `GET /api/runs/:runId/steps/:stepIndex` — Step data
   - `POST /api/runs/:runId/steps/:stepIndex/approve` — Step approval (basic version — just status update and advance, no pool aggregation yet)
   - `POST /api/runs/:runId/steps/:stepIndex/skip` — Skip step (pass-through)

6. **State management:**
   - TanStack Query for run/step data
   - `pipelineStore` (Zustand) for active step selection only

### Do NOT build
- CategoryCardGrid with real submodule data (Phase 4)
- SubmodulePanel (Phase 5)
- Working pool mechanics (Phase 7)
- File upload (Phase 6)

### Deliverables
- [ ] Run View renders with real step status data
- [ ] Step navigation shows correct status per step
- [ ] Step 0 approval advances to Step 1
- [ ] Skip step works
- [ ] Active step shows universal template
- [ ] Completed steps show read-only output (placeholder)
- [ ] Locked steps non-clickable

---

## Phase 4 — Module Auto-Discovery + Category Cards

**Goal:** Skeleton reads manifests from the modules repo and renders real category cards. No pane yet — cards are visual only.

**Spec reference:** Part 13 (Module Auto-Discovery), Part 5 (Category Cards)

### V1 Audit (open → compare against spec → REUSE / FIX / FRESH)
- `CategoryCardGrid.tsx` → compare against Part 5. Has card grid with category expand/collapse and submodule rows. Needs v2 additions: data operation icon (➕➖＝), cost badge from manifest, status-based display.
- `useSubmodules.ts` → compare against Part 16. Has `useSubmoduleMetadata()` fetching from `/api/submodules`. API shape differs in v2.
- `routes/submodules.js` → compare against Part 13 + Part 16. Has module loading from filesystem + endpoint. Must change from loading .js files to reading manifest.json.

### Build

1. **Module loader service** — Server-side module loader:
   - Read `MODULES_PATH` env var (points to modules repo)
   - Scan `step-{N}-{name}/*/manifest.json`
   - Validate required fields
   - Store in-memory registry
   - (Existing code loads `.js` files — change to load `manifest.json`)

2. **Create 2-3 test manifests** in modules repo:
   - `step-1-discovery/sitemap-parser/manifest.json` (cost: cheap, category: crawling, data_operation: add)
   - `step-1-discovery/rss-feeds/manifest.json` (cost: cheap, category: news, data_operation: add)
   - `step-2-validation/url-filter/manifest.json` (cost: cheap, category: filtering, data_operation: remove)
   - NO execute.js yet — just manifests

3. **API route** — `GET /api/submodules`:
   - `GET /api/submodules?step=1` — Returns submodules for a step, grouped by category
   - Include manifest fields needed for cards

4. **CategoryCardGrid** —
   - Categories grouped from manifest `category` field
   - Each category card shows category name, submodule count
   - Click category → expands inline, shows submodule rows
   - Each submodule row: name, description, cost badge, data operation icon (➕➖＝)
   - Clicking submodule row → nothing yet (Phase 5 wires this to pane)

5. **Submodule status on cards** — All show "idle" for now (submodule_runs table created in Phase 7). Build the status display logic (idle, running, has_results, approved, failed) but hardcode to "idle" until Phase 7 wires real data.

### Do NOT build
- SubmodulePanel (Phase 5)
- execute.js files (Phase 9)
- File upload or input mechanics
- Working pool

### Deliverables
- [ ] Module loader reads manifest.json files at startup
- [ ] Invalid manifests logged and skipped
- [ ] GET /api/submodules returns manifest data grouped by category
- [ ] CategoryCardGrid renders from real manifest data
- [ ] Category expand/collapse works
- [ ] Submodule rows show name, description, cost, operation icon
- [ ] Status indicators work (all show "idle" since nothing has run)

---

## Phase 5 — Universal Pane Template

**Goal:** Clicking a submodule row opens the SubmodulePanel. Panel has three accordions (all empty/placeholder inside). CTA footer with three buttons. Panel closes properly.

**Spec reference:** Part 6 (Universal Pane Template — structure only, not internals)

### V1 Audit (open → compare against spec → REUSE / FIX / FRESH)
- `SubmodulePanel.tsx` → compare against Part 6. Has panel with accordions, CTA footer, escape key handling, backdrop. Needs exact three accordions (Input blue, Options teal, Results pink) and CTA button logic per spec.
- `panelStore.ts` → compare against Part 6. Has panel open/close + accordion state. Likely REUSE with minor tweaks.

### Build

1. **SubmodulePanel** — Slides from LEFT side of screen:
   - Header: step name + submodule name
   - Data operation indicator (➕➖＝) with toggle
   - Three accordions: Input (blue), Options (teal), Results (pink)
   - CTA footer pinned at bottom

2. **Accordion behavior:**
   - Each accordion: colored header, expand/collapse on click
   - Only content is placeholder text for now
   - Input: "Input content will appear here"
   - Options: "Options will appear here"
   - Results: "Results will appear here"

3. **CTA Footer** — Three buttons per spec:
   - RUN TASK (pink, primary) — disabled (no input yet)
   - SEE RESULTS (gray) — disabled (no results yet)
   - APPROVE (green) — disabled (no results yet)

4. **Data operation toggle** — ➕➖＝ icons. Reads default from manifest. Click cycles through options. Saves to `run_submodule_config.data_operation`.

5. **Panel state:**
   - `panelStore` — which panel is open, which submodule
   - Click submodule row → opens panel
   - Click outside / close button → closes panel
   - Only one panel open at a time

6. **API route:**
   - `PUT /api/runs/:runId/steps/:stepIndex/submodules/:submoduleId/config` — Upsert config (data_operation for now)
   - `GET /api/runs/:runId/steps/:stepIndex/submodules/:submoduleId/config` — Get saved config

7. **Database table:**
   - `run_submodule_config` (from spec Part 10)

### Do NOT build
- Input accordion internals (Phase 6)
- Options accordion internals (Phase 6)
- Results accordion internals (Phase 7)
- RUN TASK execution (Phase 7)
- APPROVE flow (Phase 7)

### Deliverables
- [ ] Click submodule row → panel slides open
- [ ] Panel shows correct submodule name and step
- [ ] Three accordions expand/collapse
- [ ] CTA buttons render with correct disabled states
- [ ] Data operation toggle works and persists
- [ ] Close panel works (click outside, escape key, close button)
- [ ] run_submodule_config table created

---

## Phase 6 — Pane Internals: Input + Options

**Goal:** Input accordion handles file upload and content preview. Options accordion renders submodule options (auto-rendered from manifest). SAVE INPUT and SAVE OPTIONS work.

**Spec reference:** Part 6 (Input accordion, Options accordion), Part 9 (Shared Step Context, File Upload Flow)

### V1 Audit (open → compare against spec → REUSE / FIX / FRESH)
- `CsvUploadInput.tsx` → compare against Part 6 + Part 9. Has drag-and-drop CSV upload. Flow may differ in v2.
- `SubmoduleOptions.tsx` → compare against Part 6. Has auto-rendering of options from metadata. Must render from manifest options[] in v2.
- `ResultsList.tsx` → compare against Part 6. May be useful starting point for ContentRenderer.
- `useStepContext.ts` → compare against Part 9. Has step context fetching pattern. Schema differs in v2.

### Build

1. **Input accordion internals:**
   - Upload zone: drag-and-drop area for CSV/XLSX
   - Content preview below upload zone
   - Auto-resolution logic (spec Part 6): saved input config → previous step output → step_context → empty state
   - Source label: "From Step N", "From uploaded data", "Saved input"
   - [SAVE INPUT] button — active when input source differs from saved

2. **File upload flow** (spec Part 9):
   - `POST /api/runs/:runId/steps/:stepIndex/context` — multipart upload
   - Server parses CSV/XLSX
   - Validates columns against step's union of requires_columns
   - Stores in step_context table
   - Returns entity_count, columns_found, columns_missing

3. **step_context table** (from spec Part 10)

4. **Content preview** — ContentRenderer component:
   - Reads display_type from render_schema
   - For user uploads (no render_schema): table view showing all CSV columns, requires_columns highlighted
   - For inherited data: uses source's render_schema
   - v1 display types: table, url_list, content_cards, file_list

5. **Shared context banner** — When step_context exists and submodule has no saved input:
   - Inline banner in upload zone: "Found X entities from uploaded data. [Use these] [Upload different]"
   - [Use these] → writes { source: "step_context" } to input_config
   - [Upload different] → shows upload dropzone

6. **Options accordion internals:**
   - If manifest has options_component → load custom React component (from modules repo)
   - If manifest has options[] but no options_component → auto-render form from SubmoduleOptions primitive
   - If neither → show "No options" message
   - [SAVE OPTIONS] button — active when options differ from saved
   - Dirty-state tracking (deep comparison of current vs saved)

7. **RUN TASK activation:**
   - Enable when hasInput is true (any data resolved from auto-resolution)
   - Disable when isRunning

8. **API routes:**
   - `POST /api/runs/:runId/steps/:stepIndex/context` — File upload
   - `GET /api/runs/:runId/steps/:stepIndex/context` — Get step context

### Do NOT build
- Results accordion internals (Phase 7)
- BullMQ job execution (Phase 7)
- APPROVE flow (Phase 7)
- Actual submodule execute.js logic (Phase 9)

### Deliverables
- [ ] step_context table created in Supabase
- [ ] CSV upload works end-to-end (upload → parse → store → preview)
- [ ] Content preview renders uploaded data
- [ ] Auto-resolution picks correct source
- [ ] Shared context banner works between submodules
- [ ] Options auto-render from manifest works
- [ ] SAVE INPUT and SAVE OPTIONS persist to run_submodule_config
- [ ] RUN TASK enables when input exists
- [ ] ContentRenderer handles table display_type

---

## Phase 7 — Execution + Results + Approval

**Goal:** RUN TASK creates a BullMQ job, worker executes submodule, results appear, user approves, working pool updates.

**Spec reference:** Part 15 (Job Queue), Part 14 (Execute Function), Part 6 (Results accordion), Part 17 (Approval Mechanics), Part 8 (Working Pool)

### V1 Audit (open → compare against spec → REUSE / FIX / FRESH)
- `workers/stageWorker.js` → compare against Part 14 + Part 15. Has BullMQ worker pattern, Redis connection, job processing. Execution model differs in v2.
- `routes/submodules.js` → compare against Part 16. Has execution routes, approval routes, result fetching. API shapes differ. (Already audited in Phase 4 — re-check execution-specific parts.)
- `useSubmodules.ts` → compare against Part 16. Has `useExecuteSubmodule`, `useBatchApprove`, `useApproveSubmoduleRun`. (Already audited in Phase 4 — re-check execution hooks.)

### Build

1. **BullMQ setup:**
   - Redis connection
   - One queue: `pipeline-stages`
   - stageWorker process
   - Cost-based timeout/retry/priority (spec Part 15 table)

2. **Execute route** (spec Part 16):
   - `POST /api/runs/:runId/steps/:stepIndex/submodules/:submoduleId/run`
   - Check no active run (409 if pending/running exists)
   - Resolve input from auto-resolution
   - Load options from saved config or manifest defaults
   - Create submodule_runs row (status: pending)
   - Create BullMQ job
   - Return { submodule_run_id, status: "pending" }

3. **submodule_runs table** (from spec Part 10)

4. **Worker logic** (spec Part 15):
   - Load execute.js from MODULES_PATH
   - Build tools object (logger, http, progress)
   - Call execute(input, options, tools)
   - Write results → submodule_runs.output_data
   - Copy manifest output_schema → output_render_schema
   - Update status

5. **Results accordion:**
   - Polling: GET /api/submodule-runs/:id every 2s while running
   - Progress display during execution
   - On completion: render results using ContentRenderer (pass-through from output_data + output_render_schema)
   - The skeleton does NOT add checkboxes or selection UI — ContentRenderer reads `selectable` from render_schema
   - If `selectable: true` in render_schema → ContentRenderer renders checkboxes + Select all/Deselect all
   - If `selectable: false` or absent → results are read-only, APPROVE means approve all
   - Summary line: total count (+ approved/rejected counts when selectable)
   - Per-row data operation icon only when selectable (read-only indicator)

6. **Approval flow** (spec Part 16 + Part 17):
   - APPROVE button → POST /api/submodule-runs/:id/approve
   - Request: { approved_item_keys: [...] }
   - Server: store approved_items, update status, update working pool, log decision
   - Working pool update logic (spec Part 8): read data_operation, apply ➕➖＝ per entity
   - Concurrency protection: SELECT FOR UPDATE on pipeline_stages row
   - Panel closes, card updates

7. **Re-approval flow:**
   - Reopen approved submodule → see previous results via ContentRenderer
   - If `selectable: true`: checkboxes reflect previous approval states, user can modify and re-approve
   - If `selectable: false`: results shown read-only, user can [Try again] to re-run

8. **decision_log table** (from spec Part 10)

9. **GET submodule-runs response** (spec Part 16):
   - Full response shape with status, progress, output_data, approved_items, render_schema

10. **Panel close during execution:**
    - Job continues in background
    - CategoryCardGrid row shows spinner
    - Toast on completion/failure
    - Reopen → resume polling if still running

### Do NOT build
- Real submodule execute.js logic (Phase 9)
- Step-to-step data flow (Phase 8)

### Test with
- Create a simple test execute.js in modules repo that returns dummy data after a 3-second delay. Validates the full flow without real scraping logic.

### Deliverables
- [ ] submodule_runs table created in Supabase
- [ ] decision_log table created in Supabase
- [ ] RUN TASK → BullMQ job → worker executes → results appear
- [ ] Progress updates during execution
- [ ] Results render via ContentRenderer (pass-through from output_render_schema)
- [ ] Selectable mode works when render_schema declares selectable: true
- [ ] Non-selectable mode: APPROVE sends all item keys
- [ ] APPROVE updates working pool
- [ ] Re-approval works
- [ ] Decision log entries created
- [ ] Polling handles panel close/reopen
- [ ] Toast notifications on completion
- [ ] CategoryCardGrid reflects submodule status

---

## Phase 8 — Step-to-Step Plumbing

**Goal:** Full pipeline flow works. Approve step → aggregates pool → writes output → activates next step → next step reads input. Data flows from Step 1 through Step 2 with real rendering.

**Spec reference:** Part 8 (Data Flow — all three levels), Part 16 (Step Approval server logic)

### Build

1. **Step approval — full version** (spec Part 16):
   - Validate at least one approved submodule_run
   - Only latest approved run per submodule contributes
   - Copy working_pool → output_data
   - Copy output_render_schema → next step's input_render_schema
   - Initialize next step's working_pool from input_data
   - Mark step completed, next step active
   - Update pipeline_runs.current_step
   - Log decision

2. **Next step input rendering:**
   - Step 2 opens → Input accordion shows "From Step 1 · X entities"
   - ContentRenderer uses input_render_schema from previous step
   - Submodules in Step 2 auto-resolve input from step output

3. **Skip step** — Pass input_data → output_data unchanged

4. **Completed step view** — Click completed step in navigation → read-only view of output_data

5. **Run completion** — After Step 10 approval, mark run as "completed"

### Deliverables
- [ ] Approve Step 1 → Step 2 activates with Step 1's output
- [ ] Step 2 submodules see Step 1 data as input
- [ ] Skip step passes data through
- [ ] Completed steps show output read-only
- [ ] Run completes after Step 10
- [ ] Full flow: create project → step 0 → step 1 (run submodule, approve) → step 2 receives data

---

## Phase 9 — First Real Submodules

**Goal:** Build 2-3 real submodules in the modules repo to validate the full architecture.

**Spec reference:** SUBMODULE_DEVELOPMENT.md

This is when work shifts to the modules repo. The skeleton should not change (if it does, that's a spec gap — document it).

### Build (in modules repo)

1. **Step 1 — Sitemap Parser** (add, cheap) — Already has working execute.js from seed modules. Verify it works end-to-end with real skeleton. Fix if needed, don't rewrite.

2. **Step 1 — RSS Feeds** (add, cheap) — NEW execute.js:
   - Takes entities with website field
   - Tries common feed paths
   - Returns table display_type

3. **Step 2 — URL Dedup** (remove, cheap) — Already has working execute.js from seed modules. Verify it works end-to-end. Fix if needed.

4. **Step 2 — URL Filter** (remove, cheap) — NEW execute.js:
   - Takes URLs from Step 1
   - Filters by pattern/status code
   - Returns filtered subset

### Validates
- manifest auto-discovery works with real manifests
- execute.js receives correct input/options/tools
- Results render correctly per display_type
- ➕ submodules accumulate in pool
- ➖ submodule filters pool
- Entity scoping works
- Step 1 → Step 2 data handoff works

### Deliverables
- [ ] All submodules appear in UI automatically
- [ ] Full flow: upload companies → discover URLs → filter URLs → approve both steps
- [ ] Entity scoping preserved throughout

---

## Phase 10 — Polish and Edge Cases

**Goal:** Handle all the edge cases from the spec that weren't covered in core phases.

### Build
- Template system placeholder (table exists, UI shows empty state)
- Error states: failed jobs, network errors, validation failures
- Loading states: skeletons, spinners, disabled buttons
- Responsive layout adjustments
- Bulk filter-and-approve in results (TanStack Table column filtering)
- CSV template download per step
- Decision log viewing (read-only list of all decisions for a run)

---

## Appendix: What NOT To Build

These are explicitly out of scope for the skeleton build:

- Content Library tables (Step 10 module concern)
- AI provider integration (tools.ai — future)
- Cache system (tools.cache — future)
- SSE/WebSocket (v2 — polling is fine for v1)
- Template creation UI (v2)
- Monitoring/alerting
- CI/CD pipeline
- User authentication (single-user tool in v1)
