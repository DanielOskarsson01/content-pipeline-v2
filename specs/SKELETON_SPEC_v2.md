# Content Creation Tool — Skeleton Specification

> **Version:** 2.0 — February 9, 2026
> **Replaces:** SKELETON_SPEC.md (v1.2), SKELETON_DEFINITION_v2.md, SKELETON_SPEC_DELTA.md
> **Companion:** STRATEGIC_ARCHITECTURE.md (governing strategy document — unchanged)
> **Purpose:** Defines the hollow skeleton — what it provides, what it doesn't, and how it works. Every example uses generic placeholders. No submodule-specific content belongs in this document.

---

## Part 1: The Skeleton Principle

The skeleton is the building. Submodules are the apartments.

**The skeleton provides:**
- Containers — step workspace, category cards, submodule panes, accordion sections. All are empty slots with defined positions.
- Mechanics — data transfer between steps, shared context within steps, format validation, execution via job queue, status state machine, approval flow, decision logging.
- CTAs and transitions — hardcoded buttons with activation logic. Their placement is fixed. Their availability follows rules.

**The skeleton does NOT provide:**
- What content appears inside any slot
- What columns a results list shows
- What input fields an upload form needs
- What options exist
- What a summary looks like
- How results are visualized
- Any step-specific or content-type-specific logic

Each submodule declares all of that through its manifest and component definitions. The skeleton renders the slot. The submodule fills it.

---

## Part 2: Two-Repo Architecture

**Repo 1 (Skeleton):** The building — walls, wiring, plumbing, doors. Built once, tested, frozen. Contains: server, routes, services, workers, shared React components, hooks, stores, SQL schema.

**Repo 2 (Modules):** The apartments — what goes in each room. Active development. Contains: individual submodule folders, each with a manifest, an execute function, and optional React components (e.g., custom Options panels).

### Why Two Repos

The split exists for **AI assistant containment**. When an AI coding assistant is debugging a submodule, it follows imports, reads related files, and "helpfully" fixes things along the way. In a monorepo — even with ESLint rules or package boundaries — the AI can still see and modify infrastructure files. Physical repo separation means the modules repo literally does not contain infrastructure code. There is nothing for the AI to accidentally break.

**Why not a monorepo with package boundaries?** ESLint import rules are checked at lint time, not at edit time. An AI assistant following an import chain during debugging will read, modify, and save files across package boundaries without running the linter. The protection only triggers after the damage is done.

**The trade-off:** Cross-boundary changes (~1–2 per month) require coordinating across two repositories — roughly 30 minutes of extra friction per change. This is overwhelmingly worth it compared to the rebuild cycles that occurred in the majority of development sessions before the split.

### What lives where

| Skeleton (Repo 1) | Modules (Repo 2) |
|---|---|
| Express API server | Individual submodule folders |
| Database connection + schema | manifest.json per submodule |
| BullMQ queue + workers | execute.js per submodule |
| React shell components | React components per submodule (options panels, custom renderers) |
| Module loader + auto-discovery | |
| Tools object factory | |
| Approval routes + decision logging | |
| Step-to-step data flow | |


---

## Part 3: UI Shell — Top-Level Structure

### Header Bar (always visible)

Logo (OnlyiGaming Content Tool) on the left. Three navigation items:

1. **New Project** — Project creation form (Step 0).
2. **Projects** — List view: all projects with name, description, number of runs. Clicking a project opens a detail view showing runs, active steps, dates. *(v1: list + open current run. Detail view built later.)*
3. **Templates** — Placeholder in v1. Nav item exists, page shows empty state.

When inside a run, the header stays. Below it, the RunView renders the step workspace.

### Run View — Vertical Accordion Layout

**CRITICAL: The layout is a vertical accordion of collapsible step cards.** This matches the existing StepContainer.tsx implementation exactly. DO NOT change this to a horizontal nav bar, wizard bar, tabs, or sidebar.

All 11 steps render as collapsible cards stacked vertically. One step is expanded at a time (the active step auto-expands). Each collapsed step card shows: step number circle (color = status), step name, description, status badge. Completed steps can be clicked to expand and review output. Pending/locked steps are grayed out and collapsed.

The expanded step card contains the **Step Workspace** — which renders the universal step template (CategoryCardGrid, StepSummary, StepApprovalFooter).

---

## Part 4: Step 0 — Project Start

Not a step template — this is a dedicated project creation form built into the skeleton.

**Fields:**
- Project Name (required)
- Template (optional — placeholder in v1)
- Parent Project (optional — link to parent if sub-project)
- Intent (optional — freeform goal text)
- Timing (optional — placeholder in v1: one-off / scheduled / continuous)

**No data upload. No entities. No CSV.** Data entry happens inside submodules in Step 1.

**Flow:**
1. User fills in project metadata
2. Clicks [Create & Start Run]
3. Skeleton creates: projects row, pipeline_runs row, 11 pipeline_stages rows
4. Step 0 → "active"
5. User sees project summary, clicks [APPROVE STEP]
6. Step 0 → completed, Step 1 → active, opens automatically

---

## Part 5: Universal Step Template

One template for all steps (Step 1 through Step 10). The skeleton does not know which step it is rendering. It renders the same structure every time.

### Step Workspace Layout

Steps are **accordions** — each step expands/collapses. Inside each step, **category cards** are shown in a grid. When a category card is clicked, it expands **inline** to reveal the submodules within that category.

```
┌─────────────────────────────────────────────────────────────────┐
│ ▼ Step 0: Project Start                              ✓ Complete │
│   (collapsed — shows summary only)                              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ ▼ Step 1: Discovery                                    ● Active │
│                                                                 │
│   Source Types (click to configure)                             │
│                                                                 │
│   ┌────────────────┐  ┌────────────────┐  ┌────────────────┐   │
│   │ 🌐 Website     │  │ 📰 News        │  │ 🔗 External    │   │
│   │ 2/3 submodules │  │ 0/2 submodules │  │ 0/1 submodules │   │
│   └────────────────┘  └────────────────┘  └────────────────┘   │
│                                                                 │
│   When "Website" clicked, it expands INLINE:                    │
│   ┌─ 🌐 Website ─────────────────────────────────────────────┐ │
│   │ 2/3 submodules                                            │ │
│   │ ──────────────────────────────────────────────────────── │ │
│   │ Submodules                                                │ │
│   │ ➕ ☑ Sitemap Parser        (623 URLs)            →       │ │
│   │ ➕ ☑ Navigation Links      (105 URLs)            →       │ │
│   │ ➕ ☐ Seed Expansion                              →       │ │
│   └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│   ─────────────────────────────────────────────────────────    │
│   Summary (per-submodule rows, NOT aggregate):                  │
│     ➕ Sitemap Parser: 623 URLs approved                        │
│     ➕ Navigation Links: 105 URLs approved                      │
│   [APPROVE STEP]  [SKIP STEP]                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ ▶ Step 2: Validation                                   ○ Locked │
└─────────────────────────────────────────────────────────────────┘
```

**Category card (collapsed):** Icon + label + "X/Y submodules" — X = approved submodules, Y = total submodules in category
**Category card (expanded):** Shows submodules inline with:
- Data operation icon (➕➖＝) — toggleable, from manifest `data_operation_default`
- Checkbox (checked if approved)
- Submodule name
- Result count if completed (e.g., "623 URLs")
- Arrow icon (→) — click opens SubmodulePanel

**Clicking a submodule row:** Opens the SubmodulePanel from the left

### What the Skeleton Renders

- **StepContainer** — Accordion wrapper for each step (expand/collapse, status badge, summary)
- **CategoryCardGrid** — Grid of category cards that expand inline to show submodules
- **StepSummary** — Per-submodule rows showing each non-idle submodule's status and result count
- **StepApprovalFooter** — [APPROVE STEP], [SKIP STEP] buttons
- **SubmodulePanel** — Slides from left, contains accordion sections for Input/Options/Results

### What the Skeleton Does NOT Render

- Content inside the Options accordion (that's a submodule-provided component — see Part 6)
- What a category card's expanded content looks like beyond the submodule list
- Step-specific logic (every step uses StepContainer + CategoryCardGrid)

### Step Config Source

Step names, descriptions, and ordering come from a config object — not hardcoded per component:

```typescript
const STEP_CONFIG = [
  { index: 0, name: 'Project Start', description: 'Define project scope and metadata' },
  { index: 1, name: 'Discovery', description: 'Find candidate sources and seed data' },
  { index: 2, name: 'Validation', description: 'Filter before committing to expensive operations' },
  { index: 3, name: 'Scraping', description: 'Fetch actual content from validated sources' },
  { index: 4, name: 'Filtering & Assembly', description: 'Clean and organize into source packages' },
  { index: 5, name: 'Analysis & Generation', description: 'Produce output content from sources' },
  { index: 6, name: 'Quality Assurance', description: 'Verify output meets standards' },
  { index: 7, name: 'Routing', description: 'Decide what happens to items that fail QA' },
  { index: 8, name: 'Bundling', description: 'Package into delivery formats' },
  { index: 9, name: 'Distribution', description: 'Push to external systems' },
  { index: 10, name: 'Review', description: 'Final human gate before publication' },
];
```


---

## Part 6: Universal Pane Template

One template for all submodule panes. The skeleton does not know which submodule it is rendering. Same structure every time. This section is the complete reference for everything that happens inside the pane.

### Pane Layout

The panel slides in from the **LEFT** side when a submodule row is clicked. **Fixed width: 480px** (`w-[480px] min-w-[480px] max-w-[480px]`). Never resizes. Full height. Backdrop behind it darkens the step workspace.

**Accordion behavior:** Only ONE accordion may be expanded at a time. Opening one automatically collapses the other two.

```
┌──────────────────────────────────────────────────────┐
│ HEADER (teal)                                        │
│ Step 1 - Sitemap Parser                     [Close]  │
│ iGaming Payments Q1                                  │
├──────────────────────────────────────────────────────┤
│ DESCRIPTION                                          │
│ Parse XML sitemaps to discover URLs                  │
├──────────────────────────────────────────────────────┤
│ DATA OPERATION INDICATOR                             │
│ ➕ Adding to working pool · Currently: 0 items       │
├──────────────────────────────────────────────────────┤
│                                                      │
│ ┌── Previous Run Summary (if exists) ─────────────┐  │
│ │ Last run: 623 URLs · Approved ✓ · 2h ago        │  │
│ └─────────────────────────────────────────────────┘  │
│                                                      │
│ ▼ Input (blue)                                       │
│ ┌─────────────────────────────────────────────────┐  │
│ │ See "Input Accordion" section below             │  │
│ └─────────────────────────────────────────────────┘  │
│                                                      │
│ ▶ Options (teal)                                     │
│ ┌─────────────────────────────────────────────────┐  │
│ │ See "Options Accordion" section below           │  │
│ └─────────────────────────────────────────────────┘  │
│                                                      │
│ ▼ Results (pink) — ALWAYS VISIBLE                    │
│ ┌─────────────────────────────────────────────────┐  │
│ │ See "Results Accordion" section below           │  │
│ └─────────────────────────────────────────────────┘  │
│                                                      │
├──────────────────────────────────────────────────────┤
│ FOOTER                                               │
│ [RUN TASK]     [SEE RESULTS]     [APPROVE]           │
└──────────────────────────────────────────────────────┘
```

### Pane Header

**Line 1:** "Step {N} - {submodule_name}" + [Close] button (X icon)
**Line 2:** Project name (from pipelineStore.selectedProjectId)

Both read from the manifest and project context. No submodule-specific logic.

### Description Bar

One line below the header. Shows `manifest.description`. Plain text, read-only. Gives the user context about what this submodule does before they interact with anything.

### Data Operation Indicator

Same data operation icon shown in two places — same source (`manifest.data_operation_default`), two render points:

1. **On the submodule row** (in expanded category card): compact icon only (➕/➖/＝), toggleable
2. **In the pane** (below description): icon + context label + working pool count

Pane display:

| State | Display |
|-------|---------|
| ➕ add | `➕ Adding to working pool · Currently: {N} items` |
| ➖ remove | `➖ Filtering working pool · Currently: {N} items` |
| ＝ transform | `＝ Transforming working pool · Currently: {N} items` |

The "Currently: N items" shows the step's working pool size from `pipeline_stages.working_pool`. This tells the user what will happen to their data when they approve: will it grow, shrink, or change shape?

The user can toggle the operation (➕ → ➖ → ＝ → ➕ cycle) in either location. Toggling in one updates the other immediately. The toggle saves to `run_submodule_config.data_operation` (see Part 10: Configuration Storage). It doesn't modify the manifest — just overrides the default for this run.

### Previous Run Summary

Visible only when this submodule has been run before in this step/run. Shown as a compact bar above the accordions:

```
┌─────────────────────────────────────────────────────┐
│ Last run: 623 URLs · Approved ✓ · 2 hours ago       │
│ [View results]                                       │
└─────────────────────────────────────────────────────┘
```

If the previous run was rejected: `Last run: 623 URLs · Rejected ✗ · 2 hours ago`
If the previous run failed: `Last run: Failed · "timeout after 5 min" · 2 hours ago`

[View results] opens the Results accordion with the previous run's data loaded.

Data source: latest `submodule_runs` record for this submodule + run.

---

### Input Accordion (blue)

**Purpose:** Provide the submodule with data to process.

**Layout:** The accordion has two zones stacked vertically:
1. **Upload zone** (top) — Always visible. File upload + manual entry controls.
2. **Content preview** (bottom) — Always visible. Shows the actual data that will be fed to the submodule, regardless of source.

#### Upload Zone (always visible)

- Drag-and-drop file area (accepts CSV, XLSX in v1)
- "or" divider
- URL/text textarea for manual entry (freeform)
- Link to download CSV template (generated from manifest `requires_columns`)

Uploading new data always overrides any auto-resolved input.

#### Auto-Resolution (skeleton handles automatically)

When the pane opens, the skeleton checks for existing data in priority order (first match wins):

1. **Saved input config exists?** → Load into content preview. Show source label: "Saved input". (User previously clicked SAVE INPUT — this always wins because it represents an explicit user choice.)
2. **Previous step output exists?** → Load into content preview. Show source label: "From Step {N-1}".
3. **Shared step context exists?** → Load into content preview. Show source label: "From {submodule_name} upload ({filename})".
4. **None of the above?** → Content preview shows empty state: "No input data. Upload a file or enter data above."

**Override behavior:** Saving input config (via SAVE INPUT) always overrides inherited data. To revert to inherited data, the user uploads nothing and the skeleton clears the saved config — auto-resolution then falls through to step output or shared context.

#### Content Preview (always visible)

The skeleton renders the resolved input data below the upload zone. **The skeleton does not decide how to visualize this data.** It presents the content exactly as it was rendered in the Results accordion of whatever produced it:

- Data from a previous step's output → rendered using the producing step's output format
- Data from a sibling submodule's results → rendered using that submodule's `output_schema`
- Data from a user upload → rendered as table showing all CSV columns, with `requires_columns` highlighted

The rendering format travels with the data. When a step or submodule saves output, it saves both the data and a `render_schema` (derived from the producing submodule's `output_schema`). The Input content preview reads this schema and renders accordingly — URL lists stay as URL lists, tables stay as tables, HTML packages stay as HTML previews.

**How render_schema drives the UI:** The skeleton includes a `ContentRenderer` component that reads `render_schema` and selects the appropriate display mode. The `render_schema` contains the `output_schema` fields plus a `display_type` field. The skeleton ships with renderers for each display type. If `display_type` is missing or unknown, the skeleton falls back to `"table"`.

**Exhaustive display_type list (v1):**
- `"table"` — Columnar rows. Default. Each field in the schema becomes a column header. Items with missing fields show empty cells.
- `"url_list"` — Compact list showing primary URL plus entity name. Other fields available on row expand.
- `"content_cards"` — Card layout for content pieces (articles, HTML documents). Shows title, excerpt, status. Used by content-producing steps (Step 6+).
- `"file_list"` — Filename + size + timestamp. For steps that produce file outputs.

Additional display_types can be added by adding a new renderer to `ContentRenderer`. No manifest or database changes needed.

**User-uploaded data rendering:** When data comes from a CSV upload (no producing submodule, no render_schema), `ContentRenderer` shows all CSV columns in a table. Columns matching any submodule's `requires_columns` are visually highlighted to show coverage.

```
Example: Data from Step 1 output (entity list passed to Step 2)
┌─────────────────────────────────────────────────────┐
│ Source: From Step 1 · 5 entities                     │
│ ─────────────────────────────────────────────────── │
│ Name              Website                  LinkedIn  │
│ Stripe            stripe.com               ✓         │
│ Adyen             adyen.com                ✓         │
│ ...                                                  │
└─────────────────────────────────────────────────────┘

Example: Data from Sitemap Parser submodule (URL list)
┌─────────────────────────────────────────────────────┐
│ Source: From Sitemap Parser · 623 URLs               │
│ ─────────────────────────────────────────────────── │
│ https://stripe.com/payments                          │
│ https://stripe.com/billing                           │
│ https://stripe.com/connect                           │
│ ...                                                  │
└─────────────────────────────────────────────────────┘

Example: Data from Web Scraper submodule (HTML packages)
┌─────────────────────────────────────────────────────┐
│ Source: From Web Scraper · 42 pages                  │
│ ─────────────────────────────────────────────────── │
│ 📄 stripe.com/payments    12KB   scraped 2h ago     │
│ 📄 stripe.com/billing      8KB   scraped 2h ago     │
│ 📄 stripe.com/connect     15KB   scraped 2h ago     │
│ ...                                                  │
└─────────────────────────────────────────────────────┘
```

The skeleton is a pass-through renderer here. It reads `render_schema` + data and renders. It does not reformat, restructure, or impose its own visualization.

If required columns (from current submodule's manifest) are missing in the incoming data: warning banner with list of missing columns.
If data was just uploaded by the user: preview updates immediately after server-side parsing returns.

#### [SAVE INPUT] button

- Positioned at the bottom of the Input accordion (below content preview)
- **Active only if** the user has changed something (uploaded a file, typed entities, or switched from auto-resolved to manual). Dirty-state tracked by the skeleton.
- **Saves to:** `run_submodule_config.input_config` (see Part 10: Configuration Storage)
- Also triggers server-side file parsing if a file was uploaded (see Part 9: File Upload Flow)
- After save: content preview updates with the new data
- If nothing has been changed since last save, button is disabled (gray)

#### RUN TASK activation rule

RUN TASK in the footer is enabled when content is available from **any** source:
- Content inherited from previous step → `hasInput = true` (no save needed)
- Content from shared step context (sibling submodule upload) → `hasInput = true` (no save needed)
- User uploaded/entered and saved → `hasInput = true`
- Nothing from any source and user hasn't saved → `hasInput = false`, RUN TASK disabled

The rule: if the content preview shows data, RUN TASK is active.

#### What the skeleton reads from the manifest
- `requires_columns` — What columns the upload must contain. Used for validation, template generation, and content preview column headers.
- `item_key` — Primary key field for deduplication (e.g., "url", "entity_id").

**Server-side parsing:** All file parsing happens on the server (see Part 9: File Upload Flow). The frontend sends the raw file; the API parses, validates against `requires_columns`, and stores in `step_context`.

---

### Options Accordion (teal)

**Purpose:** Let the user configure the submodule before running.

**How it works:** The Options accordion is a **slot** — the submodule provides its own frontend component that renders inside the accordion body. If the submodule provides an `options_component`, the skeleton does not render the options form; the submodule owns its own UI. If the submodule does NOT provide an `options_component`, the skeleton falls back to auto-rendering a basic form from the manifest's `options[]` array.

**Submodule provides:** A React component registered in the manifest under `options_component`. This component receives the current saved options as props and calls `onChange(newOptions)` when the user modifies anything.

**Skeleton provides:**
- The accordion container (expand/collapse, teal header)
- Dirty-state tracking (compares current state to last saved state)
- [SAVE OPTIONS] button at the bottom of the accordion
- Persistence to `run_submodule_config.options` (see Part 10: Configuration Storage)

**[SAVE OPTIONS] button:**
- Active only if the submodule component has called `onChange()` with values different from the last saved state
- Saves to: `run_submodule_config.options` in Supabase
- After save: button returns to disabled (no unsaved changes)

**Default values:** On first open, the skeleton loads defaults from the manifest's `options_defaults` object and passes them to the submodule component. If a saved config exists in `run_submodule_config`, those saved values are used instead of defaults.

**Templates:** Because options are stored in `run_submodule_config`, templates can copy these values to pre-configure submodules. Creating a run from a template copies `template_submodule_config` rows → `run_submodule_config` rows (see Part 10).

**Default state:** Collapsed. Default values loaded.

**No options component?** Two cases:
- `options_component` missing but `options[]` array exists in manifest → skeleton auto-renders a basic form from the `options[]` definitions (using `SubmoduleOptions` primitive component). Save button rendered.
- Both `options_component` and `options[]` missing → accordion header shows "No options" and the body shows "This submodule has no configurable options." No save button rendered.

---

### Results Accordion (pink)

**Purpose:** Show execution output, enable item-level review, and support approval.

**Always visible.** The Results accordion is always rendered — it is never hidden. Its content changes based on state.

#### Results: Before any run

```
┌─────────────────────────────────────────────────────┐
│ No results yet. Configure input and click RUN TASK. │
└─────────────────────────────────────────────────────┘
```

Empty state message. Collapsed by default but openable.

#### Results: During execution

```
┌─────────────────────────────────────────────────────┐
│ ⟳ Processing entity 3/5... Adyen                    │
│ ████████████░░░░░░░░ 60%                            │
└─────────────────────────────────────────────────────┘
```

Opens automatically when RUN TASK is clicked. Shows progress from `submodule_runs.progress` (updated by worker via `tools.progress.update()`). Frontend polls every 2s (see Part 15: Real-Time Status Updates).

#### Results: After completion

**The Results accordion is a pass-through container.** The skeleton does not own the content inside it. All result rendering is driven by `output_render_schema` (from the submodule's manifest `output_schema`) via ContentRenderer — the same component used in the Input content preview. The skeleton renders whatever the submodule returns, exactly as described by its schema.

**What the skeleton owns inside Results:**
- The pink accordion header (expand/collapse) + item count badge
- The summary line (total count, plus approved/rejected counts when selectable)
- The action buttons below results: [Change Input], [Change Options], [Download], [Try again]

**What the skeleton does NOT own inside Results:**
- How items are displayed (table, url_list, content_cards, file_list — all driven by `display_type` in render_schema)
- Whether checkboxes appear (driven by `selectable` in render_schema)
- Column headers, row layout, filtering — all driven by render_schema fields

**The `selectable` field in output_schema:**

The submodule's manifest declares `selectable: true` in its `output_schema` when item-level approval is needed. When `selectable` is true, ContentRenderer wraps each row with a checkbox and renders [Select all] / [Deselect all] controls. When `selectable` is false or absent, results render as read-only and APPROVE means "approve all items."

Default convention (submodule authors follow this, skeleton does not enforce it):
- ➕ add submodules → `selectable: false` (approve all discovered items)
- ➖ remove submodules → `selectable: true` (user picks what to filter out)
- ＝ transform submodules → `selectable: false` (approve all transformed items)

These are conventions, not rules. A ➕ submodule CAN declare `selectable: true` if it makes sense for its use case. The skeleton reads the schema and renders accordingly.

```
Example: selectable: false (Step 1 Discovery — ➕ add)
┌─────────────────────────────────────────────────────┐
│ 623 URLs found across sitemap.xml                    │
│ ─────────────────────────────────────────────────── │
│ https://stripe.com/payments            Stripe        │
│ https://stripe.com/billing             Stripe        │
│ https://stripe.com/connect             Stripe        │
│ https://paypal.com/business            PayPal        │
│ ... (scrollable, paginated)                          │
│ ─────────────────────────────────────────────────── │
│ Showing 1-50 of 623                                  │
│ [Change Input] [Change Options] [Download] [Try again]│
└─────────────────────────────────────────────────────┘

Example: selectable: true (Step 2 Validation — ➖ remove)
┌─────────────────────────────────────────────────────┐
│ 623 URLs checked · 3 flagged for removal             │
│ ─────────────────────────────────────────────────── │
│ [Select all]  [Deselect all]                         │
│                                                      │
│ ☑ https://stripe.com/payments     Stripe       ➕   │
│ ☑ https://stripe.com/billing      Stripe       ➕   │
│ ☐ https://stripe.com/404          Stripe       ➖   │
│ ☑ https://paypal.com/business     PayPal       ➕   │
│ ... (scrollable, paginated)                          │
│ ─────────────────────────────────────────────────── │
│ Showing 1-50 of 623 · 620 approved · 3 rejected     │
│ [Change Input] [Change Options] [Download] [Try again]│
└─────────────────────────────────────────────────────┘
```

**Per-row data operation icon (when selectable: true):** Each row shows ➕ or ➖ or ＝ matching the pane's data operation setting. This is a read-only visual indicator — not a per-item toggle. It reminds the user what will happen to these items when approved.

**Summary line:** Bottom of results. When `selectable: true`: shows total, approved, rejected counts (updates live as user checks/unchecks). When `selectable: false`: shows total count only.

**Actions below results:**
- [Change Input] — Opens/scrolls to Input accordion. User can upload new data or modify entities.
- [Change Options] — Opens/scrolls to Options accordion. User can adjust configuration.
- [Download] — Export current results (format depends on data type, not CSV-specific)
- [Try again] — Clears results, resets to INPUT READY state. Does NOT delete the previous submodule_run (preserved for history). Equivalent to: Change Input + re-run.

[Change Input] and [Change Options] keep the current results visible — the user can scroll between accordions. [Try again] is more destructive: it clears the results display and expects a new run.

#### Results: Reopening a completed submodule

When the user clicks a submodule row that was already run and approved:
- Results accordion shows the previous run's data via ContentRenderer (same render_schema)
- If `selectable: true`: checkboxes reflect previous approval states
- If `selectable: false`: results shown as read-only (same as first view)
- Previous Run Summary bar shows at top
- User can click [Try again] to re-run

---

### CTA Footer

Three buttons, always visible at the bottom. Sequential activation.

| CTA | Appearance | When enabled | What it does |
|-----|-----------|--------------|--------------|
| **RUN TASK** | Pink (primary) | `hasInput && !isRunning` | Creates BullMQ job. Opens Results accordion. Starts polling. `isRunning` is per-submodule (not per-pane) — tracked via the latest `submodule_runs` status for this submodule in this step. Other submodules in the same step can run concurrently. |
| **SEE RESULTS** | Gray (secondary) | `isCompleted` | Opens/scrolls to Results accordion |
| **APPROVE** | Green | `isCompleted` | Approves the submodule run. Updates working pool (using ➕➖＝ operation). Logs decision. Shows toast. Closes panel. |

**Disabled state:** Gray background, gray text, cursor not-allowed.

**After APPROVE:**
1. If `selectable: true` → `POST /api/submodule-runs/:id/approve` with checked item keys
2. If `selectable: false` (or absent) → `POST /api/submodule-runs/:id/approve` with ALL item keys (approve everything)
3. Server updates `submodule_runs.status` → "approved", stores `approved_items`
4. Server updates `pipeline_stages.working_pool` based on data operation (➕➖＝)
5. Decision logged automatically
6. Panel closes
7. Submodule row in CategoryCardGrid updates: checkbox checked, result count shown
8. StepSummary updates with new totals

**REJECT (implicit):** There is no explicit REJECT button. The user either:
- Clicks [Try again] in Results to re-run (creates new submodule_run, previous preserved)
- Closes the panel without approving (submodule stays in "completed" state, not "approved")
- When `selectable: true`: unchecks items individually and then approves (partial approval)

**CategoryCardGrid display by status:**
- `pending` — No indicator. Row is clickable.
- `running` — Spinner icon. Row shows progress message.
- `completed` (not approved) — Result count shown (e.g., "623 URLs") but checkbox unchecked. User must open and explicitly approve.
- `approved` — Checkbox checked. Result count shows approved count (e.g., "620 URLs").
- `failed` — Error icon. Row shows error message snippet.

**Panel close during execution:** If user closes the panel while a job is running, the job continues in the background. The CategoryCardGrid row shows spinner + progress. When the job completes, a toast notification appears: "Sitemap Parser completed — 623 results". Reopening the pane shows the Results accordion with data. The active `submodule_run_id` is tracked in the Zustand `panelStore` — on reopen, the pane resumes polling if status is still "running".

**Working pool race condition:** The UI disables all other APPROVE buttons in the same step while an approval is in flight. Only one working pool update can run at a time per step. This is enforced client-side (optimistic) and server-side (row-level lock on `pipeline_stages` during pool update).

---

### Pane State Machine

```
FRESH                    No previous run, no saved config, no inherited data
├── Input:    OPEN       Upload zone + empty content preview
├── Options:  collapsed  Defaults from manifest (or template)
├── Results:  empty      "No results yet" message
├── SAVE INPUT: disabled (nothing to save)
├── RUN TASK: disabled   No hasInput
├── SEE RESULTS: disabled
└── APPROVE:  disabled
        │
        ├──▶ auto-resolution finds inherited data → skip to INPUT READY
        │
        ▼ user uploads file / types entities
INPUT DIRTY
├── Content preview: shows parsed data from upload
├── SAVE INPUT: ENABLED  (unsaved changes detected)
├── RUN TASK: disabled   (must save first)
        │
        ▼ user clicks SAVE INPUT → persists to run_submodule_config
INPUT READY              (also entered directly if inherited data exists)
├── Input:    content preview shows data with source label
├── SAVE INPUT: disabled (nothing changed since save)
├── RUN TASK: ENABLED    (hasInput = true)
├── SEE RESULTS: disabled
└── APPROVE:  disabled
        │
        ▼ user clicks RUN TASK
RUNNING
├── Input:    locked (can't change during run)
├── Options:  locked
├── Results:  progress spinner, entity counter
├── RUN TASK: disabled (isRunning)
├── SEE RESULTS: disabled
└── APPROVE:  disabled
        │
        ▼ execution completes
COMPLETED
├── Results:  populated with items, checkboxes, summary
├── Results bottom: [Change Input] [Change Options] [Download] [Try again]
├── RUN TASK: enabled (can re-run)
├── SEE RESULTS: ENABLED
└── APPROVE:  ENABLED
        │
        ├──▶ user clicks APPROVE → panel closes, working pool updated
        ├──▶ user clicks [Change Input] → opens Input accordion
        ├──▶ user clicks [Change Options] → opens Options accordion
        └──▶ user clicks [Try again] → clears results, back to INPUT READY
```

---

### Skeleton-Owned vs Submodule-Owned

**Skeleton owns (all of the above):**
- Panel frame: header, description, data operation indicator, close button, slide-in from left
- Previous Run Summary bar
- Input accordion: resolution logic, upload area, file parsing via API, [SAVE INPUT] button
- Options accordion: container, dirty-state tracking, [SAVE OPTIONS] button, persistence
- Results accordion: result table, checkboxes, bulk actions, summary, pagination, download, [Change Input], [Change Options]
- CTA footer: RUN TASK, SEE RESULTS, APPROVE with activation logic
- Configuration persistence: all saves go to `run_submodule_config` in Supabase
- Backdrop, escape key, panel close behavior
- Working pool update on approve
- Decision logging on approve

**Submodule owns (via manifest + optional component):**
- `description` — text shown in description bar
- `data_operation_default` — ➕➖＝ initial setting
- `requires_columns` — what the upload must contain
- `item_key` — primary key for deduplication in results
- `options_defaults` — default configuration values
- `options_component` — React component rendered inside Options accordion (optional)
- `output_schema` — column definitions for the results table
- `execute()` function — the actual processing logic

The submodule provides data declarations and optionally an options UI component. The skeleton renders and persists everything else.

---

## Part 7: Data Operation Icons (➕ ➖ ＝)

Each submodule card shows a data operation indicator. This is visible on the card before the pane opens, and it's what makes one universal step template possible — the skeleton doesn't need to know what kind of step it's rendering.

| Icon | Manifest value | Meaning |
|------|---------------|---------|
| ➕ | `"add"` | Output gets added to the step's working data pool |
| ➖ | `"remove"` | Output replaces the pool with a smaller set |
| ＝ | `"transform"` | Output replaces the pool with transformed content (same quantity, different shape) |

**Default value:** Declared in the submodule's manifest via `data_operation_default`. A discovery submodule defaults to `"add"`. A filter submodule defaults to `"remove"`.

**User override:** The user can change the toggle on the card at any time before approving the step.

**Effect on step data:** When a submodule is approved, the step's working dataset updates immediately based on the card's current toggle setting. See Part 6 (Data Operation Indicator) for how this appears inside the pane, and Part 8 (Level 2) for the working pool update mechanics.

---

## Part 8: Three-Level Data Flow Mechanics

### Level 1: Between Steps — Database-Mediated

Step N finalizes → data saved to Supabase → Step N+1 loads that data.

Steps communicate exclusively through the database. No direct connections, no event passing, no callbacks. Step 3 doesn't know Step 1 exists — it reads whatever data is in Supabase for this run at this step.

This means:
- Steps can be reordered without code changes
- Steps can be skipped (previous output passes through unchanged)
- A step failure doesn't cascade
- Adding a new step requires zero changes to existing steps

**Flow:**
1. User clicks [APPROVE STEP] → skeleton aggregates approved items from all submodule runs
2. Writes aggregated results to `pipeline_stages.output_data` for step N
3. Sets step N status to "completed"
4. Sets step N+1 status to "active"
5. Step N+1 reads step N's output_data as its input_data

### Level 2: Within a Step — Sequential Chaining via Working Pool

Within a step, submodules chain sequentially. The user triggers them one at a time. There is no concurrent execution of sibling submodules.

Each step maintains a **running working pool** — an intermediate dataset that updates as submodules are approved. All operations are entity-scoped — Stripe's items never mix with PayPal's items.

**For ➕ submodules:** Every approved item is added to the pool, tagged with its entity. Multiple add-submodules stack their results. Deduplication by `item_key` within each entity — later approval wins.

**For ➖ submodules:** Approved items define what remains. Items not in the approved set are removed from the pool. Removals never cross entity boundaries. The next submodule receives the reduced set, not the original.

**For ＝ submodules:** Output replaces the pool with transformed content. Same items, different shape. Count may differ from original if user rejected items during approval.

**Initial state:** Previous step's output_data (or empty for Step 1).

**Entity scoping:** The working pool is organized by entity. When a run processes 5 companies, each company's items are tracked separately. Pool operations (➕➖＝) apply per-entity — adding URLs for Stripe never affects PayPal's URLs. Step output preserves entity grouping. The `entity_name` field on each item associates it with its entity.

**Step finalization:** When [APPROVE STEP] is clicked, the current working pool becomes the step's output_data and passes to the next step. Entity grouping is preserved.

**Persistence:** The working pool is stored in the `pipeline_stages` table in the `working_pool` JSONB column as **full item objects** (not references). Updated after each submodule approval. Server-as-truth — the frontend reads it, never computes it. Deduplication uses the submodule's `item_key` field — if two submodules produce items with the same key, the later approval wins.

**Working pool update logic (server-side, in approve route):**
1. Load current `working_pool` from `pipeline_stages` for this run + step
2. Load approved items: filter `submodule_runs.output_data` to only items whose `item_key` value is in `submodule_runs.approved_items`
3. Read the data operation from `run_submodule_config.data_operation` for this submodule. If null, fall back to the manifest's `data_operation_default`.
4. Apply operation to working pool:
   - ➕ (add): merge approved items into pool (union, deduplicated by `item_key` — later approval wins)
   - ➖ (filter): replace pool with approved items (the submodule's output IS the filtered result)
   - ＝ (transform): replace pool with approved items (same items, different shape — count may differ from original if user rejected items)
5. Write updated pool back to `pipeline_stages.working_pool`
6. Return updated pool summary to frontend (count, delta from previous)

**Concurrency protection:** The approve route wraps steps 1–5 in a database transaction with `SELECT ... FOR UPDATE` on the `pipeline_stages` row. This serializes concurrent approvals for the same step. The frontend also disables other APPROVE buttons while an approval is in flight (optimistic — the server lock is the real protection).

### Level 3: Within a Submodule — The Pane

See Part 6 for the complete pane specification. The pane has three accordions (Input, Options, Results), a data operation indicator, and a CTA footer. The skeleton owns the pane frame and persistence; submodules provide React components (options panels) and data through their manifest and execute function.


---

## Part 9: Shared Step Context

When a user uploads data in any submodule within a step, that data becomes available to all other submodules in the same step, same run.

**Two storage locations — different purposes:**
- `step_context` — Holds the actual entity data (parsed CSV rows). Shared across all submodules in the step. One per step per run. When any submodule uploads, it overwrites the step's shared context. All submodules see the same entities.
- `run_submodule_config.input_config` — Holds metadata about a submodule's input source selection: `{ source: "step_context" | "previous_step" | "manual", entity_count: N }`. Written by SAVE INPUT. Does NOT contain entity data — it records which source the submodule should read from.

**How it works:**
1. User uploads CSV in Submodule A → skeleton parses and writes entities to `step_context`, writes `{ source: "step_context" }` to Submodule A's `run_submodule_config.input_config`
2. User opens Submodule B → skeleton checks step_context → finds data → offers it as a banner inside the Input accordion's upload zone: "Found X entities from uploaded data. [Use these] [Upload different]". This replaces the empty upload dropzone. Not a modal — inline in the accordion body.
3. If user clicks [Use these] → writes `{ source: "step_context" }` to Submodule B's `input_config`
4. If user uploads different data → overwrites `step_context` with new data (all submodules now see the new data)

**Priority (mirrored from Part 6 auto-resolution):**
1. Saved input config exists → read source field, load from that source
2. Previous step output exists → use that
3. Shared step context exists → offer it
4. None → show upload prompt

**Scope:** Same step, same run. Not shared across steps or runs.

**Dynamic CSV template:** The skeleton generates a CSV template for each step by reading all manifests for submodules in that step and collecting every `requires_columns` into a union. Adding a new submodule with new column requirements automatically updates the template. Column order: columns are sorted alphabetically, with `name` always first (if present). Columns are literal — `website` and `url` are treated as different columns (no semantic matching).

### File Upload Flow (Server-Side)

All file parsing happens server-side. The browser uploads the raw file; the API parses, validates, and stores it. The frontend never interprets file contents.

**Why server-side:**
- Validation against manifest `requires_columns` needs manifest data (server owns manifests)
- Size limits enforced before parsing
- Consistent parsing across browsers
- Error messages are standardized

**Flow:**
1. User drops/selects file in Input accordion upload area
2. Frontend sends: `POST /api/runs/:runId/steps/:stepIndex/context` with `multipart/form-data`
3. API receives file, detects type (CSV, XLSX, JSON by extension/mime)
4. API parses file → extracts rows → validates columns against step's union of `requires_columns`
5. API writes to `step_context` table: `{ run_id, step_index, source_submodule: "submodule-id", entities: [{ name: "Company A", website: "companya.com" }, ...] }`
6. API returns: `{ entity_count: 5, columns_found: ["name", "website", "linkedin"], columns_missing: [] }`
7. Frontend enables RUN TASK button (`hasInput = true`)

**Supported file types in v1:** CSV, XLSX. Others return `415 Unsupported Media Type`.

**Size limit:** 10MB per file, 10,000 rows. Configurable via environment variables.

---

## Part 10: Database Schema

### Core Pipeline Tables

**projects**

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID (PK) | |
| name | TEXT | |
| description | TEXT | Optional project description, shown in project list |
| timing | TEXT | Reserved for scheduling (v2). Placeholder values: "one-off", "scheduled", "continuous". Nullable, disabled in v1. |
| template_id | UUID (FK, nullable) | Reserved for template system (v2). No templates table in v1 — column exists for forward compatibility. |
| status | TEXT | "active", "archived" |
| created_at | TIMESTAMPTZ | |

**pipeline_runs** — One execution of a project through the 11-step sequence.

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID (PK) | |
| project_id | UUID (FK → projects) | |
| status | TEXT | "running", "completed", "failed", "paused" |
| current_step | INTEGER | Which step the run is currently on (0–10) |
| started_at | TIMESTAMPTZ | |
| completed_at | TIMESTAMPTZ | Null until run completes |

**pipeline_stages** — One step's data within a run.

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID (PK) | |
| run_id | UUID (FK → pipeline_runs) | |
| step_index | INTEGER | 0–10 |
| step_name | TEXT | From STEP_CONFIG |
| status | TEXT | "pending", "active", "completed", "skipped" |
| input_data | JSONB | Data received from previous step |
| input_render_schema | JSONB | How to render input_data — copied from previous step's output_render_schema |
| output_data | JSONB | Approved results from this step (becomes next step's input) |
| output_render_schema | JSONB | How to render output_data — copied from producing submodule's output_schema |
| working_pool | JSONB | Current intermediate dataset, updated after each submodule approval |
| working_pool_render_schema | JSONB | How to render working_pool — recomputed on each pool update. For tabular data: union of all contributing submodules' output_schema fields. For non-tabular steps: `display_type` from the most recent contributing submodule. |
| started_at | TIMESTAMPTZ | |
| completed_at | TIMESTAMPTZ | |

**submodule_runs** — One execution of one submodule within a step.

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID (PK) | |
| stage_id | UUID (FK → pipeline_stages) | |
| run_id | UUID (FK → pipeline_runs) | |
| submodule_id | TEXT | Matches manifest id |
| status | TEXT | "pending", "running", "completed", "failed", "approved", "rejected" |
| options | JSONB | Option values configured for this run |
| input_data | JSONB | What was fed to the submodule |
| output_data | JSONB | Raw results from execute() |
| output_render_schema | JSONB | How to render output_data — from this submodule's manifest output_schema |
| approved_items | JSONB | Array of `item_key` values the user approved (e.g., `["https://a.com", "https://b.com"]`). Server uses these to filter `output_data` when building the working pool. |
| progress | JSONB | `{ current, total, message }` — updated during execution by worker |
| error | TEXT | Error message if execution failed |
| logs | JSONB | Array of {level, message, timestamp} from tools.logger |
| started_at | TIMESTAMPTZ | |
| completed_at | TIMESTAMPTZ | |

**step_context** — Shared data within a step (CSV sharing mechanism).

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID (PK) | |
| run_id | UUID (FK → pipeline_runs) | |
| step_index | INTEGER | |
| entities | JSONB | Parsed entity data — array of objects with columns as keys |
| filename | TEXT | Original uploaded filename (shown in auto-resolution label: "From {submodule_name} upload ({filename})") |
| source_submodule | TEXT | Which submodule uploaded the data |
| created_at | TIMESTAMPTZ | |

Unique constraint on (run_id, step_index) — intentionally one context per step per run. All submodules in the step share the same uploaded data. A new upload by any submodule overwrites the shared context (see Part 9).

**decision_log** — Every human judgment recorded.

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID (PK) | |
| run_id | UUID (FK → pipeline_runs) | |
| step_index | INTEGER | |
| submodule_id | TEXT | |
| entity_id | TEXT (nullable) | Which entity this decision was about. Null for step-level decisions (step_approved, step_skipped). |
| decision | TEXT | "approved", "rejected", "re-run", "skipped", "rerouted" |
| reason | TEXT | Optional — why the user made this decision |
| context | JSONB | Snapshot of relevant data at decision time |
| decided_at | TIMESTAMPTZ | |

### Configuration Storage

**run_submodule_config** — Persisted input/options/operation choices per submodule per step per run. This is what SAVE INPUT, SAVE OPTIONS, and the ➕➖＝ toggle write to. Also what templates copy from.

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID (PK) | |
| run_id | UUID (FK → pipeline_runs) | |
| step_index | INTEGER | |
| submodule_id | TEXT | Matches manifest id |
| input_config | JSONB | What input source, entity count, manual entries — written by SAVE INPUT |
| options | JSONB | `{key: value}` — written by SAVE OPTIONS. Null = use manifest defaults |
| data_operation | TEXT | "add", "remove", "transform" — null = use manifest default |
| updated_at | TIMESTAMPTZ | |

Unique constraint on `(run_id, step_index, submodule_id)` — one config row per submodule per step per run. Uses upsert on save.

**template_submodule_config** — Same shape, for templates. When creating a run from a template, rows are copied: `template_submodule_config` → `run_submodule_config`.

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID (PK) | |
| template_id | UUID (FK → templates) | |
| step_index | INTEGER | |
| submodule_id | TEXT | |
| input_config | JSONB | Pre-configured input source |
| options | JSONB | Pre-configured options |
| data_operation | TEXT | Pre-configured operation override |

Unique constraint on `(template_id, step_index, submodule_id)`.

**Note:** Both `template_submodule_config` and its FK target `templates` are deferred — created when the template system is implemented (v2). Not part of the initial build.

### Content Library Tables (Deferred — Module-Level)

Content storage tables (`content_items`, `platform_tags`, `content_tags`) are not part of the skeleton schema. They belong to Step 10 (Distribution) submodules and will be defined when those submodules are built. The skeleton does not read from or write to content library tables.

### Schema Principles

- **Content reuse:** Content stored once by source_url. Multiple projects reference the same content.
- **Freshness flags, not gates:** Stale content is flagged but never blocked.
- **Conflict resolution:** On re-process, newer version wins with version increment.
- **Tiered retention:** Filtered content keeps metadata but JSONB body is nulled after 7 days.


---

## Part 11: The Manifest Contract

Every submodule has a `manifest.json` that tells the skeleton everything it needs to know. The skeleton never reads `execute.js` to understand a submodule — the manifest is the complete interface declaration.

### Manifest Shape

```json
{
  "id": "example-submodule",
  "name": "Example Submodule",
  "description": "One-line explanation of what this submodule does.",
  "version": "1.0.0",
  "step": 1,
  "category": "example-category",
  "cost": "cheap",
  "data_operation_default": "add",

  "requires_columns": ["website"],

  "options": [
    {
      "name": "max_results",
      "type": "number",
      "label": "Maximum Results",
      "description": "Limit total results returned per entity.",
      "default": 1000,
      "min": 1,
      "max": 50000
    },
    {
      "name": "include_nested",
      "type": "boolean",
      "label": "Include nested sources",
      "description": "Follow references to discover additional sources.",
      "default": true
    },
    {
      "name": "filter_mode",
      "type": "select",
      "label": "Filter mode",
      "description": "Which patterns to include.",
      "default": "all",
      "values": ["all", "pages_only", "custom_regex"]
    }
  ],

  "options_defaults": {
    "max_results": 1000,
    "include_nested": true,
    "filter_mode": "all"
  },

  "options_component": "./OptionsPanel.jsx",

  "item_key": "url",

  "output_schema": {
    "display_type": "table",
    "url": "string (required)",
    "source_category": "string",
    "depth": "number",
    "last_modified": "string (ISO date, if available)"
  }
}
```

### Field Reference

**id** — Unique identifier. Used in database records, file paths, API calls. URL-safe (lowercase, hyphens). Once set, never changes.

**name** — Human-readable display name. Shown on submodule cards.

**description** — One-line explanation. Shown in UI on hover or expand.

**version** — Semantic version. Allows skeleton to detect manifest changes.

**step** — Which step this submodule belongs to (0–10). A submodule appears in exactly one step.

**category** — Visual grouping within a step. Categories are visual only — they help users find submodules. No functional meaning.

**cost** — Cost tier: "cheap", "medium", "expensive". Used for BullMQ job priority and timeout thresholds. Not displayed on UI cards in v1.

**data_operation_default** — "add", "remove", or "transform". Default ➕➖＝ toggle value shown on card. User can override.

**requires_columns** (required) — Which columns must exist in entity data for this submodule to run. Skeleton uses this to check shared step context and determine executability. If required columns are missing, skeleton shows a message explaining what's needed. For Step 1 modules, columns are checked on entity-level fields (e.g., `["website"]` checks `entity.website`). For Step 2+ modules, columns are checked on item-level fields within `entity.items` (e.g., `["url"]` checks `entity.items[0].url`).

**options** — Array describing the submodule's configurable fields. Used for two purposes:
1. **Documentation/schema** — The skeleton can use this to validate saved config values, generate help text, and understand defaults.
2. **Fallback rendering** — If a submodule does not provide an `options_component`, the skeleton MAY use this array to render a basic auto-generated form as a fallback.

Each option has:
- `name` — Key used in options object passed to execute()
- `type` — "boolean" (toggle), "number" (number input), "text" (text input), "select" (dropdown), "textarea" (multiline)
- `label` — Display label
- `description` — Help text
- `default` — Pre-filled value
- Type-specific constraints: `min`/`max` for numbers, `values` for selects, `maxLength` for text

**options_component** — (optional) Path to a React component that renders the Options accordion body. If provided, this component takes full control of the options UI. Receives `{ options, onChange }` as props. If not provided, the skeleton can fall back to auto-rendering from the `options` array.

**options_defaults** — Object of `{key: value}` pairs. These are the starting values when no saved config exists. Typically derived from the `options[].default` values, but declared separately so the skeleton can read them without parsing the full options array.

**item_key** — Which field(s) in output items uniquely identify a result. Used for: (1) tracking across re-runs — matching new results to previously approved/rejected items, (2) deduplication when merging into the working pool. Uniqueness is scoped to the step's working pool — two submodules in the same step producing the same `item_key` value means the later approval overwrites the earlier one. Can be a single field name (string) or an array for composite keys.

**output_schema** — Describes the shape of each result item plus rendering instructions for ContentRenderer. Key fields:
- `display_type` — How to visualize: `"table"` (columnar), `"url_list"` (one URL per row), `"content_cards"` (article/document cards), `"file_list"` (filename + size + timestamp). Falls back to `"table"` if omitted. See Part 6 for the exhaustive display_type list.
- `selectable` — Boolean. When `true`, ContentRenderer adds item-level checkboxes + Select all/Deselect all controls. When `false` or absent, results render as read-only and APPROVE means "approve all items." Convention: ➖ remove submodules set `selectable: true`, ➕ add and ＝ transform submodules leave it `false`.
- Field definitions — Used for results display column headers and for `render_schema` passed downstream. Not enforced at runtime in v1.

### What the manifest does NOT include

- No database configuration (submodules don't access the database)
- No dependency declarations (submodules use only tools object + standard Node.js)

---

## Part 12: The Tools Object

When the skeleton executes a submodule, it passes three arguments: `input`, `options`, and `tools`. The tools object is the submodule's only bridge to the outside world.

### Tools Interface

```
tools.logger
  .info(message)     — Log informational message
  .warn(message)     — Log warning
  .error(message)    — Log error
  Logged to: submodule_runs.logs (JSONB array) + server console.
  UI displays logs in real-time by polling the submodule_runs record.

tools.http
  .get(url, options)  — GET request
  .post(url, body, options) — POST request
  Options: { timeout: ms (default 30000), headers: {} }
  Returns: { status, headers, body }
  Skeleton wraps to add: rate limiting, retry logic, timeout handling, logging.
  Submodules never use raw fetch() or axios.

tools.progress
  .update(current, total, message) — Report execution progress
  Example: tools.progress.update(45, 100, "Processing entity 45 of 100")
  Worker writes to submodule_runs.progress JSONB column.
  Frontend polling picks up the update every 2s and renders in Results accordion.
  Optional — long-running submodules should call it so users see activity.
```

### What tools does NOT provide

- No database access (no tools.db)
- No queue access (no tools.queue)
- No file system write access
- No access to other submodules' data
- No access to configuration outside of `options`

### Future tools (not in v1)

- `tools.ai.generate(prompt, options)` — Wrapped AI client with model selection, cost tracking, retry logic. Submodules never import an LLM SDK directly.
- `tools.cache.get(key)` / `tools.cache.set(key, value)` — Cross-run caching for submodules that benefit from it.

Added when needed, not prebuilt.

---

## Part 13: Module Auto-Discovery

No registration step. No configuration file listing submodules.

### How it works

At startup, the skeleton's moduleLoader service:

1. Reads MODULES_PATH environment variable
2. Scans for directories matching `step-{N}-{name}/{submodule-name}/`
3. Reads `manifest.json` in each submodule directory
4. Validates (required fields present, id unique, step number valid)
5. Registers in an in-memory registry

When UI requests submodules for a step, skeleton returns all registered submodules where `manifest.step === requestedStep`.

### Adding a new submodule

1. Create folder: `modules/step-{N}-{name}/new-submodule/`
2. Add `manifest.json`
3. Add `execute.js`
4. Add React components if needed (e.g., `OptionsPanel.jsx` referenced by `options_component`)
5. Restart skeleton (or hot-reload in future version)

No other changes. Skeleton discovers, UI shows it, user can run it.

### Validation

At startup, moduleLoader rejects invalid manifests and logs warnings. Invalid means: missing required fields, duplicate id, invalid step number, malformed options array. Invalid submodules don't crash the skeleton — they're skipped.


---

## Part 14: The Execute Function Contract

Every submodule's `execute.js` exports a single async function.

### Signature

```javascript
async function execute(input, options, tools) → results
```

### Input

```javascript
{
  entities: [
    { name: "Company A", website: "companya.com", additional_field: "..." },
    { name: "Company B", website: "companyb.com" }
  ],
  run_id: "uuid",
  step_index: 1,
  submodule_id: "example-submodule"
}
```

`entities` is an array of objects. Each has at minimum a `name` field. Other fields depend on uploads and shared context. The submodule should check for required fields and handle missing ones gracefully (skip entity, log warning).

**Step 2+ input enrichment:** For steps beyond Step 1, the skeleton attaches items from the previous step's output (the working pool) to each entity. The `items` array contains the accumulated, approved items grouped by `entity_name`:

```javascript
// Step 2+ entity shape — entities carry items from previous step
{
  entities: [
    {
      name: "Company A",
      website: "companya.com",
      items: [
        { url: "https://companya.com/about", last_modified: "2024-01-01" },
        { url: "https://companya.com/products", last_modified: "2024-02-15" }
      ]
    },
    {
      name: "Company B",
      website: "companyb.com",
      items: [
        { url: "https://companyb.com/page1", last_modified: "2024-03-01" }
      ]
    }
  ],
  run_id: "uuid",
  step_index: 2,
  submodule_id: "url-dedup"
}
```

The skeleton builds this by reading `pipeline_stages.working_pool` (or `output_data` for step transitions), grouping items by `entity_name`, and attaching them to the matching entity object. Original entity fields (name, website, etc.) are preserved. If an entity has no items from the previous step, `items` is an empty array.

Step 1 submodules never have `items` — they receive the raw upload entities. Step 2+ submodules should always read `entity.items` for their processing data.

### Options

Loaded from `run_submodule_config.options` (saved via SAVE OPTIONS in the pane). Falls back to `manifest.options_defaults` if no saved config exists. Keys match manifest `options[].name`:

```javascript
{ max_results: 1000, include_nested: true, filter_mode: "all" }
```

### Return Value

```javascript
{
  results: [
    {
      entity_name: "Company A",
      items: [
        { url: "https://companya.com/about", depth: 1 },
        { url: "https://companya.com/products", depth: 1 }
      ],
      meta: { total_found: 142, filtered: 12, errors: 0 }
    },
    {
      entity_name: "Company B",
      items: [...],
      meta: {...}
    }
  ],
  summary: {
    total_entities: 2,
    total_items: 284,
    errors: []
  }
}
```

**Per-entity grouping required.** Skeleton displays results grouped by entity for approve/reject per entity or per item.

**Summary required.** Skeleton uses it for status line and card badge.

### Error Handling

Partial success: return results for successful entities, include errors:

```javascript
{
  results: [
    { entity_name: "Company A", items: [...], meta: { total_found: 142 } },
    { entity_name: "Bad Domain", items: [], error: "DNS resolution failed", meta: { errors: 1 } }
  ],
  summary: { total_entities: 2, total_items: 142, errors: ["Bad Domain: DNS resolution failed"] }
}
```

Total failure: throw. Skeleton catches, marks submodule_run as "failed", displays error.

---

## Part 15: Job Queue (BullMQ)

User clicks [Run Task] → API creates job → Worker picks up → Worker executes submodule → Worker writes results to Supabase.

### Queue Design

One queue: `pipeline-stages`. Job payload is minimal — just IDs. The worker loads all data fresh from the database:

```javascript
{
  submodule_run_id: "uuid",
  submodule_id: "example-submodule",
  step_index: 1
}
```

The worker reads `input_data` and `options` from the `submodule_runs` row (populated by the execute route at creation time). This ensures the worker always uses exactly what was resolved at job creation.

### Worker Logic

The stageWorker processes jobs:

1. Read job data
2. Look up submodule by id in module registry
3. Load execute.js from submodule's directory
4. Load saved config from `run_submodule_config` → merge with manifest defaults for `options`
5. Build tools object
6. Call `execute(input, options, tools)` — options = saved config merged over defaults
7. Snapshot: copy resolved `options` to `submodule_runs.options` (audit trail)
8. On success: write results to `submodule_runs.output_data`, copy manifest `output_schema` → `submodule_runs.output_render_schema`, status → "completed"
9. On failure: write error to `submodule_runs.error`, status → "failed"

### Configuration

| Setting | Cheap | Medium | Expensive |
|---------|-------|--------|-----------|
| Timeout | 5 min | 15 min | 30 min |
| Retries | 3 | 2 | 1 |
| BullMQ priority | 1 (highest) | 5 | 10 (lowest) |

**Concurrency:** 2 jobs simultaneously. A slow expensive job doesn't block a fast cheap job.

### Why Not Direct Execution

BullMQ adds: persistence (job recovery on crash), isolation (misbehaving submodule can't crash API), visibility (job status tracking), future scaling (workers on separate machines).

### Real-Time Status Updates

The frontend needs to know when a BullMQ job completes. Two approaches:

**v1: Polling**
- After clicking RUN TASK, frontend polls `GET /api/submodule-runs/:id` every 2 seconds
- Response includes `status` field: `pending`, `running`, `completed`, `failed`
- On `completed`: stop polling, load results, enable APPROVE
- On `failed`: stop polling, show error in Results accordion
- Timeout: stop polling after 10 minutes, show "job may still be running" message

**Why polling for v1:**
- Simple — no WebSocket server, no connection management
- Stateless — survives page refresh (just resume polling)
- Supabase handles the reads efficiently (indexed by id)

**v2 option: Server-Sent Events (SSE)**
- `GET /api/runs/:runId/events` — long-lived connection
- Server pushes: `{ type: "submodule_complete", submodule_run_id, result_count }`
- Lower latency, no wasted requests
- Add when polling becomes a bottleneck

**Progress updates during execution:**
- Worker updates `submodule_runs.progress` field: `{ current: 3, total: 5, message: "Processing entity 3/5" }`
- Frontend polling picks up progress and renders it in the Results accordion spinner area
- Submodules report progress via `tools.progress.update(current, total, message)`

---

## Part 16: API Routes

Express routes the React frontend calls. Every route is a skeleton operation — no business logic.

### Projects
- `POST /api/projects` — Create project
- `GET /api/projects` — List projects
- `GET /api/projects/:id` — Get project details

### Runs
- `POST /api/projects/:id/runs` — Create new run
- `GET /api/runs/:id` — Get run status, current step
- `PATCH /api/runs/:id` — Update run (pause, resume)

### Steps
- `GET /api/runs/:runId/steps/:stepIndex` — Get step data (input, output, working pool, submodule runs)
- `POST /api/runs/:runId/steps/:stepIndex/approve` — Approve step (aggregate and advance)
- `POST /api/runs/:runId/steps/:stepIndex/skip` — Skip step (pass through and advance)

#### Step Approval — Server Logic

`POST /api/runs/:runId/steps/:stepIndex/approve` does all of this in a single transaction:

1. **Validate:** At least one submodule_run has status "approved" for this stage. If not → 400 error.
2. **Finalize pool:** Copy `pipeline_stages.working_pool` → `pipeline_stages.output_data` for this step.
3. **Mark complete:** Set `pipeline_stages.status` → "completed", set `completed_at`.
4. **Prepare next step:** Set next `pipeline_stages.status` → "active", copy this step's `output_data` → next step's `input_data`, copy `output_render_schema` → next step's `input_render_schema` (so the next step's Input accordion knows how to render the incoming data), initialize next step's `working_pool` from `input_data`.
5. **Update run:** Set `pipeline_runs.current_step` → next step index.
6. **Log decision:** Insert decision_log entry with type "step_approved", counts of approved/rejected items per submodule.
7. **Return:** `{ step_completed: stepIndex, next_step: stepIndex + 1, items_forwarded: count }`

If this is the last step (step 10), mark the run as "completed" instead of advancing.

#### Step Skip — Server Logic

`POST /api/runs/:runId/steps/:stepIndex/skip`:

1. Copy `input_data` → `output_data` unchanged (pass-through).
2. Set status → "skipped".
3. Prepare next step same as approval.
4. Log decision with type "step_skipped".

### Submodules
- `GET /api/submodules` — List all registered submodules
- `GET /api/submodules?step=1` — List submodules for a step
- `POST /api/runs/:runId/steps/:stepIndex/submodules/:submoduleId/run` — Execute submodule
- `GET /api/submodule-runs/:id` — Get run status and results
- `POST /api/submodule-runs/:id/approve` — Approve results
- `POST /api/submodule-runs/:id/reject` — Reject results

#### Execute Submodule — Server Logic

`POST /api/runs/:runId/steps/:stepIndex/submodules/:submoduleId/run`

**Request body:** `{}` (empty — server resolves input from auto-resolution priority)

**Server logic:**
1. **Check no active run:** Query `submodule_runs` for this submodule with status "pending" or "running". If found → 409 Conflict.
2. **Resolve input:** Follow auto-resolution priority (saved input_config source → previous step output → step_context). Load entity data.
3. **Load options:** Read from `run_submodule_config.options`. If null, use manifest `options_defaults`.
4. **Create submodule_runs row:** Insert with status "pending", input_data = resolved entities, options = resolved options, output_render_schema = manifest's output_schema.
5. **Create BullMQ job:** `{ submodule_run_id, submodule_id, step_index }`. The worker loads input_data and options fresh from the submodule_runs row (not from the job payload).
6. **Return:** `{ submodule_run_id: "uuid", status: "pending" }`

#### Get Submodule Run — Response Shape

`GET /api/submodule-runs/:id`

**Response:**
```json
{
  "id": "uuid",
  "submodule_id": "sitemap-parser",
  "status": "completed",
  "progress": { "current": 200, "total": 200, "message": "Done" },
  "output_data": { "results": [...], "summary": {...} },
  "output_render_schema": { "display_type": "table", "url": "string", ... },
  "approved_items": ["url1", "url2"],
  "error": null,
  "started_at": "...",
  "completed_at": "..."
}
```

Note: `output_data` can be large. Frontend should cache and only re-fetch on status change.

#### Approve Submodule Run — Server Logic

`POST /api/submodule-runs/:id/approve`

**Request body:** `{ "approved_item_keys": ["url1", "url2", ...] }`

**Server logic:**
1. **Validate:** submodule_run status must be "completed". If not → 400.
2. **Store:** Update `submodule_runs.approved_items` = request body's `approved_item_keys`.
3. **Update status:** Set status → "approved".
4. **Update working pool:** Execute working pool update logic (see Part 8). Read data_operation from saved config or manifest default. Filter output_data to approved items. Apply operation to pool.
5. **Log decision:** Insert decision_log entries for each approved/rejected item.
6. **Return:** `{ status: "approved", pool_count: N, pool_delta: +M }`

#### Get Submodules List — Response Shape

`GET /api/submodules?step=1`

**Response:**
```json
[
  {
    "id": "sitemap-parser",
    "name": "Sitemap Parser",
    "description": "...",
    "category": "crawling",
    "cost": "cheap",
    "data_operation_default": "add",
    "latest_run": {
      "id": "uuid",
      "status": "approved",
      "result_count": 623,
      "approved_count": 620
    }
  }
]
```

The `latest_run` field is populated per run context. `CategoryCardGrid` uses `latest_run.status` to show checkboxes and counts. `category` is used for grouping into cards.

### Context
- `POST /api/runs/:runId/steps/:stepIndex/context` — Upload entity data
- `GET /api/runs/:runId/steps/:stepIndex/context` — Get step context

### Submodule Configuration
- `PUT /api/runs/:runId/steps/:stepIndex/submodules/:submoduleId/config` — Upsert config (SAVE INPUT, SAVE OPTIONS, ➕➖＝ toggle). Body: `{ input_config?, options?, data_operation? }` — partial updates, only provided fields are written.
- `GET /api/runs/:runId/steps/:stepIndex/submodules/:submoduleId/config` — Get saved config (or null if no overrides)

### Decision Log
- `POST /api/decisions` — Log a decision (called automatically by approve/reject routes)
- `GET /api/runs/:runId/decisions` — Get decision history

### API Principles

- All routes return JSON
- All mutations return the updated record
- Error responses include `message` field
- Routes use `db.js` service (no direct Supabase imports)
- Routes use `queue.js` service (no direct BullMQ imports)


---

## Part 17: Approval Mechanics

### Three Levels

**Item-level** — Within results, user approves/rejects individual items. Fine-grained control.

**Submodule-level** — After reviewing items, user finalizes the submodule run. "Approved" means the user is satisfied (even if some items were rejected).

**Step-level** — After desired submodules are approved, user approves the step. Triggers aggregation and advances to next step.

### State Machines

**Submodule run:**
```
pending → running → completed → approved
                              → rejected
                  → failed
```

**Step:**
```
pending → active → completed (approved)
                 → skipped
```

**Run:**
```
running → completed (all steps done)
        → paused
        → failed
```

### Rules

- Step cannot be approved until at least one submodule is approved
- Step can be skipped at any time
- Submodule can be re-run after completion (new submodule_run, previous preserved)
- **Only the most recent approved run per submodule contributes to step aggregation.** Previous approved runs stay in history but don't affect the working pool.
- Item approvals are per submodule_run — re-run creates fresh items
- Step approval aggregates only from the latest approved submodule_run per submodule
- Run advances linearly (0 → 1 → 2 → ... → 10). No jumping ahead.
- **Re-approval:** User can reopen an approved submodule, modify item selections, and click APPROVE again. This updates `approved_items`, re-triggers the working pool update, and logs a new decision. State remains "approved" — no new submodule_run is created.

### Bulk Filter-and-Approve

The ResultsTable supports column filtering. Approve/reject actions apply to currently visible (filtered) rows, not the full dataset. This lets users handle high-volume results efficiently — filter to a pattern, approve those, filter to another pattern, reject those.

---

## Part 18: Decision Logging

Every human judgment is recorded automatically. This is infrastructure for the calibration pattern described in Strategic Architecture.

### What Gets Logged

| Action | Decision value | Context captured |
|--------|---------------|-----------------|
| Approve an item | "approved" | Entity, item data, source submodule |
| Reject an item | "rejected" | Entity, item data, optional reason |
| Re-run a submodule | "re-run" | Submodule, changed options |
| Skip a step | "skipped" | Step index |
| Approve a step | "step_approved" | Approved/rejected counts per submodule |

### Logging is Automatic

Built into the skeleton's approval routes, not submodules. When the frontend calls `POST /api/submodule-runs/:id/approve`, the route handler updates the record AND writes a decision_log entry. Submodules don't know about decision logging.

### v1 Scope

Decisions are logged but not analyzed. No rule engine, no automation. The log grows. Historical data will be there when calibration rules are built later.

---

## Part 19: UI Components

The skeleton provides these React components. All are step-agnostic and submodule-agnostic.

### Existing Components (current codebase)

| Component | Location | What it does |
|-----------|----------|-------------|
| `StepContainer` | `components/steps/` | Accordion wrapper for each step. Shows step number, title, description, status badge, result summary. Expand/collapse. |
| `CategoryCardGrid` | `components/shared/` | Grid of category cards. Click to expand inline, shows submodules list. Submodule row opens panel. |
| `SubmodulePanel` | `components/shared/` | Slides from LEFT. Header with step/submodule name. Generic accordion sections (Input/Options/Results). Fixed CTA row at bottom. |
| `StepSummary` | `components/shared/` | Per-submodule summary rows. Each row shows one non-idle submodule with its data op icon, name, and result text. NOT an aggregate line. |
| `StepApprovalFooter` | `components/shared/` | [APPROVE STEP] / [SKIP STEP] buttons with loading state. |

### Primitive Components

| Component | Location | What it does |
|-----------|----------|-------------|
| `CsvUploadInput` | `components/primitives/` | File upload for CSV files |
| `UrlTextarea` | `components/primitives/` | Textarea for pasting URLs |
| `SubmoduleOptions` | `components/primitives/` | Fallback options renderer from manifest `options[]` array (used when submodule has no `options_component`) |
| `ResultsList` | `components/primitives/` | Displays results with approve/reject |
| `ContentRenderer` | `components/primitives/` | Pass-through renderer that reads `render_schema.display_type` and selects the appropriate display mode (table, url_list, content_cards, file_list). Used in both Input content preview and Results accordion. See Part 6 for display_type definitions. |

### State Management

| Store | Purpose |
|-------|---------|
| `appStore` | Toast notifications, UI flags |
| `panelStore` | Which panel is open, which accordion expanded |
| `pipelineStore` | Step expansion state |
| `discoveryStore` | Step 1 specific UI state (to be generalized) |

**TanStack Query:** Project list, run data, step data, submodule run results (via `useStepCategories`, `useFinalizeStep`, etc.)

**Zustand:** UI-only state (panel open, accordion expanded, toast)

---

## Part 20: Infrastructure

| Component | Technology |
|-----------|-----------|
| Server | Hetzner CX22 VPS (2 vCPU, 4GB RAM, Ubuntu 24.04) |
| Database | Supabase PostgreSQL |
| Job queue | Redis + BullMQ on Hetzner |
| Runtime | Node.js 20 LTS |
| API | Express.js |
| Process manager | PM2 |
| Frontend | React 18 + TypeScript + Vite + Tailwind |
| Server state | TanStack Query |
| UI state | Zustand (if needed) or React hooks |
| Tables | TanStack Table |

### Local Development vs Production

| Concern | Local | Production (Hetzner) |
|---------|-------|---------------------|
| API server | `node server/server.js` on localhost:3001 | PM2 managed |
| Frontend | Vite dev server on localhost:5173 | Built static files served by Express |
| Redis | Local Redis (`brew install redis`) or Docker | Installed on Hetzner |
| BullMQ worker | Same process or separate terminal | PM2 as separate process |
| Database | Same Supabase instance (dev project) | Same Supabase instance (prod project) |
| Submodules path | `MODULES_PATH=../modules-repo` (local checkout) | `MODULES_PATH=/opt/modules` (deployed) |
| File uploads | Stored in `/tmp/uploads` | Stored in `/var/uploads` on Hetzner |

**Startup (local):**
```bash
# Terminal 1: Redis
redis-server

# Terminal 2: API + Worker
MODULES_PATH=../content-pipeline-modules-v2 node server/server.js

# Terminal 3: Frontend
cd client && npm run dev
```

**dev.sh script** handles port conflicts and starts all services. See `dev.sh` in repo root.

---

## Part 21: Code Architecture — Two-Repo Migration

When splitting into the two-repo structure:

**Skeleton repo gets:**
- All shared components (StepContainer, CategoryCardGrid, SubmodulePanel, StepSummary, StepApprovalFooter)
- All primitive components (CsvUploadInput, UrlTextarea, SubmoduleOptions, ResultsList)
- All stores (appStore, panelStore, pipelineStore)
- All hooks (useStepCategories, useFinalizeStep, useUrlParams)
- Server (server.js, routes/, services/, workers/)
- SQL schema

**Modules repo gets:**
- Submodule folders with manifest.json + execute.js + React components (options panels, custom renderers)
- No database access (uses tools object)
- No skeleton infrastructure code (no routes, services, workers, shared components)

**What to generalize:**
- `discoveryStore` → generic step UI state (not step-1 specific)
- `Step1Discovery.tsx`, `Step1Panel.tsx` → patterns extracted into universal components
- Hardcoded `'discovery'` type strings → use manifest step index

**Dedicated module mount point:** The skeleton reads `MODULES_PATH` environment variable to find submodule folders. During development, this points to a local modules repo checkout.

---

## Part 22: What This Document Doesn't Cover

These topics live in companion documents or are deferred:

- **Individual submodule specifications** — What each submodule does, its options, its output format (Module Decisions document)
- **Content type configurations** — How different content types differ in the pipeline
- **Template system** — How templates save and restore configurations
- **External system integration details** — API authentication, field mappings, content type schemas
- **Tag management** — How tags are loaded and maintained
- **AI provider integration** — Model selection, prompt management, cost tracking
- **Monitoring, deployment, testing** — Operational concerns
- **Strategic reasoning** — Why decisions were made (see STRATEGIC_ARCHITECTURE.md)

---

## Appendix: Documents This Spec Replaces

The following documents are superseded by this spec and should be moved to archive:

| Document | What it contained | Where it went |
|----------|------------------|--------------|
| SKELETON_SPEC.md (v1.2, Feb 7) | Original skeleton spec with submodule-specific examples baked in | Superseded. All valid content captured here without submodule leakage. |
| SKELETON_DEFINITION_v2.md (Feb 8) | Building/apartment principle, universal pane template, two-level CTA system, data operation toggles | Merged into Parts 1, 5, 6, 7. |
| SKELETON_SPEC_DELTA.md (Feb 8) | Four agreed changes: ➕➖＝ icons, intra-step chaining, internal accordion CTAs, universal step template | Merged into Parts 5, 6, 7, 8. No longer "delta" — now part of the main spec. |

The governing strategy document **STRATEGIC_ARCHITECTURE.md** is unchanged and remains the authoritative source for principles, reasoning, and intent.
