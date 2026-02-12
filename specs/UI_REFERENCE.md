# UI Reference — v2 Component Specifications

> **Date finalized:** February 11, 2026
> **Rule:** Keep the existing visual design. Only make the functional changes listed below.
> **Existing app:** http://188.245.110.34:3000/
> **Companion artifacts:** .jsx visual references in Claude.ai conversation (Feb 11, 2026)
> Files: projects-list-v2.jsx, step0-project-setup.jsx, step1-category-cards.jsx, submodule-panel.jsx

---

## Component 1: Header

**Current:** "Content Pipeline v3.0", tabs [Projects, Pipeline Monitor, Content Library, Templates], Demo/Live toggle
**v2:**
- Title → "OnlyiGaming Content Tool" + v2.0 badge
- Tabs → [New Project, Projects, Templates]
- Remove Demo/Live toggle entirely
- Visual layout: NO CHANGES

✅ APPROVED — See `header-current.jsx`

---

## Component 2: Projects List

**Current:** Stat cards (Total/Completed/Running/Failed), project rows with type tags, filter input, + New Project button
**v2:**
- Remove stat cards row entirely
- Remove type tags from project rows
- Remove filter input (can add later)
- Keep: + New Project button, project rows (name + date + status badge only)
- Visual layout of rows: NO CHANGES

✅ APPROVED — See `projects-list-v2.jsx`

---

## Component 3: Step 0 — Project Setup

**Dedicated form — NOT the universal step template.**

**Fields (from Part 4 of SKELETON_SPEC):**
- Project Name (required, active)
- Intent (optional, active)
- Template (optional, disabled — "Not available yet")
- Parent Project (optional, disabled — "Not available yet")
- Timing (optional, disabled — "Not available yet")

**NO Description field. NO data upload.**

**Two states:**
1. ACTIVE: Creation form + "Create & Start Run" button
2. COMPLETED: Green summary box showing project name + intent

**Header always visible** above the step accordion (← Back + project name).

✅ APPROVED — See `step0-project-setup.jsx`

---

## Component 4: Step Accordion (collapsed cards)

**NO CHANGES to visual appearance.**

Each collapsed step card shows:
- Numbered circle (green ✓ = completed, blue = active, gray = pending)
- Step name + description
- Status badge
- Expand/collapse arrow

Step names and descriptions come from STEP_CONFIG constant (not hardcoded per component).

Steps 1–10 all use the **universal step template** when expanded.

---

## Component 5: Universal Step Template (expanded step, Steps 1–10)

**Layout inside every expanded step:**
1. Pink banner: category description (e.g., "Source Types (click to configure)")
2. CategoryCardGrid: grid of category cards from manifest
3. StepSummary: per-submodule summary rows (NOT an aggregate summary)
4. StepApprovalFooter: [Skip Step] + [Approve Step]

### Category Cards (collapsed)
- Icon + label + "X/Y submodules" count — X = approved submodules, Y = total submodules in category
- Click → expands inline

### Category Cards (expanded) — submodule rows
Each row shows, LEFT to RIGHT:
1. **Data operation toggle** (➕➖＝) — clickable, cycles through add/subtract/replace
2. **Checkbox** — checked if approved
3. **Status dot** — idle (gray), running (blue pulse), has_results (blue), approved (green), failed (red)
4. **Submodule name** + result count if completed (e.g., "623 URLs")
5. **Description** (small text below name)
6. **Arrow →** — click opens SubmodulePanel

### StepSummary (above CTAs)
**Per-submodule rows, NOT a single aggregate line.**
- Skeleton provides the container area and data flow
- Each submodule provides its own summary content
- Only submodules that have been run appear (idle ones hidden)
- Each row: status icon + submodule name + summary text from module + status badge

### StepApprovalFooter
- [Skip Step] — secondary/gray
- [Approve Step] — primary/pink

✅ APPROVED — See `step1-category-cards.jsx`

---

## Component 6: SubmodulePanel (slides from left)

**Fixed width: 480px. Always same size. Never resizes.**
**Only ONE accordion open at a time.**

### Panel structure (top to bottom):

#### 6a. Panel Header (dark)
- Line 1: "Step {N} — {submodule_name}" + Close (✕) button
- Line 2: Project name

#### 6b. Description Bar
- One line from manifest.description
- Read-only

#### 6c. Data Operation Indicator
- Toggleable: ➕➖＝ (cycles on click)
- Shows label + working pool count
- ➕ "Adding to working pool · Currently: N items"
- ➖ "Filtering working pool · Currently: N items"
- ＝ "Transforming working pool · Currently: N items"
- Syncs with the data op toggle on the submodule row

#### 6d. Previous Run Summary (conditional)
- Only visible if submodule has been run before
- Blue bar: "Last run: 623 URLs · Approved ✓ · 2h ago" + [View results]

#### 6e. Input Accordion (blue/cyan header)
**Skeleton owns entirely.**
Contents:
- Paste URLs/data textarea
- "or" divider
- File drop zone (CSV, XLSX)
- Download template link
- Content preview (auto-resolved from previous step, shared context, or saved input)
  - Rendered via ContentRenderer using render_schema from producing module
  - Source label: "From Step {N-1}" / "Saved input" / "From {submodule} upload"
- [Save Input] button — active only if user changed something

#### 6f. Options Accordion (teal header)
**Slot for module-provided component.**
- If module provides `options_component` → render that component
- If no component but `options[]` in manifest → auto-render form
- If neither → "No configurable options"
- [Save Options] button — active only if dirty

#### 6g. Results Accordion (pink header) — ALWAYS RENDERED
**Skeleton renders via ContentRenderer + output_schema from module.**

Before run: "No results yet. Configure input and click RUN TASK."
During run: Progress bar + entity counter (polls every 2s)
After run:
- Summary line (from module output)
- [Select all] / [Deselect all]
- Item list with checkboxes (item-level approval)
- Per-row data operation icon (read-only, matches pane setting)
- Pagination + counts (total/approved/rejected)
- **Action CTAs at bottom of results:**
  - [Change Input] → opens Input accordion
  - [Change Options] → opens Options accordion
  - [Download] — generic export (NOT CSV-specific)
  - [Try again] — clears results, resets for new run

#### 6h. Fixed CTA Footer (always visible at bottom)
| Button | When enabled | Action |
|--------|-------------|--------|
| RUN TASK | hasInput && !isRunning | Creates BullMQ job, opens Results |
| SEE RESULTS | isCompleted | Opens Results accordion |
| APPROVE | isCompleted | Approves run, updates pool, closes panel |

✅ APPROVED — See `submodule-panel.jsx`

---

## Ownership Model

| Area | Skeleton owns | Module provides |
|------|--------------|----------------|
| Step accordion, expand/collapse | ✅ | — |
| Category card grid | ✅ | Categories from manifest |
| Submodule rows (checkbox, status, data op) | ✅ | Status from submodule_runs |
| StepSummary container | ✅ | Summary text per submodule |
| Panel header, description, data op indicator | ✅ | Manifest fields |
| Input accordion (upload, preview, auto-resolve) | ✅ | — |
| Options accordion container | ✅ | React component OR options[] |
| Results accordion (list, checkboxes, pagination) | ✅ via ContentRenderer | Data + output_schema |
| Results action CTAs | ✅ | — |
| CTA footer | ✅ | — |

---

## What Does NOT Change (visual)

- Color scheme, fonts, spacing
- Card border styles, rounded corners
- Accordion expand/collapse animations
- Panel slide-in behavior, backdrop, escape-to-close
- Button styles (pink primary, gray secondary)
- Status badge colors (green/blue/gray/red)
- Project row layout
