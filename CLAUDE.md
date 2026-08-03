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

## 🔁 Workflow Patterns

### 1. Subagent-driven vs inline execution

Apply silently for clear cases. Only ask when genuinely ambiguous.

**Use subagent-driven** when ALL of these hold:
- Plan document exists with discrete tasks
- More than 4-5 tasks
- Explicit sequencing or dependencies between tasks
- Estimated work spans >2 hours
- Natural checkpoints exist for human review

**Use inline** when ANY of these hold:
- Investigation/debugging without clear endpoint
- Single coherent change (<1 hour)
- Architectural discussion needing back-and-forth
- Continuous reasoning where context accumulation helps
- User asks a question rather than requesting execution

**Ask the user** when a plan exists but the execution style is ambiguous, or the work could reasonably go either way. Don't ask for clear-cut cases — apply the rule and proceed.

### 2. Review cycles for architectural changes

Architectural changes require `brutal-critic` and CTO review BEFORE implementation:
- Data model changes (schema, manifest fields, contract definitions)
- Cross-module interfaces (how submodules interact, how skeleton interprets module declarations)
- Execution semantics (`data_operation`, pool handling, routing logic)
- Multi-phase plans (Phase 3, Phase 4, etc.)

Skip review for: single-function bug fixes, manifest field *value* changes (not new fields), UI tweaks, documentation updates.

When uncertain whether a change is architectural, default to review.

### 3. Multi-task execution checkpoints

Plans with >5 tasks require explicit human review checkpoints every 3-5 tasks. Don't batch through silently. Surface results at each checkpoint, wait for review, proceed only when confirmed.

Natural checkpoint moments:
- After a test suite completes
- After an audit/inspection task produces output for review
- After deployment, before validation
- Before any irreversible action (commits, deploys, schema changes)

### 4. Strategic vs tactical boundary

Agents handle tactical execution. The user holds strategic alignment.

**Tactical (agent decides):**
- How to implement a specified change
- Which library to use for a defined task
- Code organization within a module
- Test cases for known requirements

**Strategic (surface to user):**
- What to build vs defer
- How architectural pieces connect
- Whether a change affects future work directions
- Trade-offs that have product implications

When uncertain whether a decision is strategic or tactical, surface to the user rather than improvising. The cost of asking is low; the cost of unilateral strategic decisions is high.

---

## 🏛 Architectural Commitments

### Small generic modules, not specialized ones

Content type variation is handled via configuration (cards, prompts, reference docs) of a small number of flexible generic modules. Specialized modules per content type are an anti-pattern.

When a workflow needs different behavior:
1. First: can this be a card of an existing module?
2. Second: can this be template/configuration of an existing module?
3. Last: only if behavior is genuinely different, create a new module

The module catalog should stay small as the content type catalog grows.

### Step boundary discipline

Each step has a specific concern. Modules belong to one step's concern. Modules spanning step boundaries get refactored or replaced.

- **Step 0** — Project setup and user input: project name/description, template selection, entity definition, seed inputs (CSV uploads, manual URL entry, descriptions). Produces structured input that Step 1 submodules consume.
- **Step 1** — Discovery: produce URLs/items into the pool
- **Step 2** — URL processing: filter, dedup, canonicalize
- **Step 3** — Scraping: produce content from URLs
- **Step 4** — Cleanup: transform/filter scraped content
- **Step 5** — Generation: produce format-agnostic content (markdown, JSON, structured fields)
- **Step 6** — QA: verify produced content
- **Step 7** — Routing: decide retry/proceed
- **Step 8** — Bundle: format content for delivery (DOCX, PDF, HTML via templates)
- **Step 9** — Distribution setup: configure send/save (staged but not executed)
- **Step 10** — Human review: publication gate (human decides publish/save/skip)

Step 10 is the publication gate. Steps 0-9 are automated; Step 10 is a human decision.

### Pipeline architecture is ID-based composition

The current 11-step structure is current scaffolding, not fundamental architecture. The real architecture is ID-based submodule composition: the execution engine runs submodules in sequences determined by templates (current), routing decisions (multi-card retries), or user composition (future drag-and-drop).

Validation and contract rules should be position-agnostic — based on what a module does/needs, not where it sits. Step numbers are guidance for current organization, not architectural constraints.

---

## 🛡 Process discipline — failure modes we've hit

These rules exist because each one has already failed in this codebase. They are not theoretical hygiene. Each item is tagged **HARD** (must do, prevents a specific failure) or **GUIDE** (should do, improves quality but skippable under judgment).

**TL;DR — if you do only two things:** read affected code in full before planning (A.2), and trace the actual call path during review (B.1). These two would have caught most of what went wrong.

**Patterns G and H prevent drift in planning sessions.** Without them, A–F catch failures inside individual tasks but miss strategic-level drift — pivots based on stale uploaded files, scope changes made without reviewer engagement, multi-hour sessions that quietly drift from the original direction.

**Pattern I prevents post-merge architectural drift.** Architectural changes ship their own tests for the new behavior, but callsites depending on the changed surface are NOT covered. Without a deliberate post-merge audit, those callsites silently break and stay broken until someone runs the affected path. I is the audit that catches what the change's own tests don't.

### How to read this document

Not all rules below carry equal weight, and not all hold equally well under pressure. Read going in:

- **A.1, A.4, D.1** are checkable in seconds (`ls`, a grep for a phrase). Likely to hold.
- **A.2 (read code end-to-end)** is the most-skipped rule under pressure and also the highest-leverage. No automated enforcement; depends on implementer discipline and reviewer challenge ("did you actually read all of `routingHandler.js`?"). When time is tight, this is the rule that quietly slips first.
- **B.1 (code path trace)** is the highest-leverage reviewer rule. Reviewers should refuse to approve plans without it.
- **B.5 (independent diagnosis verification)** codifies a habit the user already practices (bringing in Gemini fresh for a second opinion). Codifying it makes it the norm rather than the exception.
- **C.1–C.4 (validation)** is the hardest cluster to enforce because validation is the step where time pressure peaks. C.2 (specify evidence in the plan before deploy) is the strongest defense — once committed in writing, skipping it is visible.
- **E.1, E.2** are guidelines, not hard rules, because the actual fix to spec-implementation drift is process external to Claude Code (owners, quarterly review). CLAUDE.md can mitigate, not solve.
- **F** is the only pattern without a direct technical failure mode. It's here because overclaiming progress corrupts the session log, which corrupts future pre-flights.
- **G (reviewer engagement at scope moments)** is checkable but requires discipline. Easy to skip when momentum is high — that's exactly when it matters most. The trigger list is the discipline; without it, "I'll bring in a reviewer when I'm done" becomes "I'll bring in a reviewer never."
- **H (current-state verification)** is checkable in seconds (`ls -la`, `git log -1`) and is likely to hold once the habit is established. The discipline is doing it BEFORE citing the file, not after the recommendation has already gone out.

### Relationship to other rules

This section is process-level (planning, review, validation, communication). It is separate from the module-authoring **Rules 1–12** in the modules repo CLAUDE.md (`content-pipeline-modules-v2/CLAUDE.md`). The two sets are complementary:

- Rules 1–12 govern *what a submodule must look like* (manifest fields, README discipline, partial-items resilience, `data_operation` / `pool_precondition` declarations).
- Patterns A–H govern *how planning, review, and validation are conducted* across both repos.

When a planning task touches a submodule, both apply.

---

### A. Pre-flight for architectural work

Before drafting any plan that changes pool semantics, routing, schema, manifest contracts, multi-step coordination, or cross-module interfaces:

1. **HARD — Search `Content-Pipeline/specs/` for governing specs.** Run `ls Content-Pipeline/specs/` and read filenames. If any file's name plausibly relates to the area you're changing, read it end-to-end before anything else.
   - *Prevents #1 (discoverability gap) and #5 (drift).* The PHASE_3B spec sat unread for 26 days while the buggy code it was designed to replace stayed in production. Filename scan is ~5 seconds; full read of one spec is ~10 minutes. The 4th re-design attempt was about to happen when the user intervened.

2. **HARD — Read the currently-affected code files end-to-end before proposing changes.** Not greps, not excerpt reads — full files. At minimum: every file the plan will modify, plus the immediate callers and the immediate callees.
   - *Prevents #2 (code path assumption gap) and #3 (wrong diagnosis).* The cascade-delete bug review missed that the plan's central assumption was untraced — three reviewers approved an architecturally correct fix without confirming it sat on the path where the bug fired.

3. **HARD — Before plan drafting, write a "current state vs intended state" gap summary.** One paragraph. What exists now in code, what the spec (or your design) says should exist, what the delta is. Surface it explicitly.
   - *Prevents #1, #2, #5.* Forces the implementer to articulate the gap rather than discover it mid-plan. If you can't write the gap summary, you don't understand the area well enough to plan changes to it.

4. **HARD — If no governing spec exists, state that explicitly before designing fresh.** Exact phrasing: *"No governing spec found in `Content-Pipeline/specs/` for [area]. Designing from scratch."*
   - *Prevents #1.* The user must have the chance to say "wait, check X" before you commit to designing. The PHASE_3B incident: user intervention came late because the implementer never surfaced "no spec found" — they just started designing.

### B. Plan review criteria (beyond architectural soundness)

Reviewers (brutal-critic, CTO, human, AI second-opinion) MUST check these before approving. Architectural correctness is necessary but not sufficient.

1. **HARD — Code path trace.** The plan must explicitly identify the call chain from the trigger event (HTTP request, BullMQ enqueue, etc.) to the line being changed. Reviewer must confirm: *"Yes, this path actually executes when the bug occurs."* Without this, the fix may be correct in isolation but unreachable in production.
   - *Prevents #2.* Three reviewers approved the empty-pool fix without anyone tracing the `autoExecutor` → `executeRouter` → `batchWorker` chain. The fix happened to land correctly. Next time it won't.

2. **GUIDE — Compatibility check.** What happens to the normal pipeline run that doesn't exercise the new feature? Specifically: does the change have any effect on entities/runs that never trigger the condition the change handles?
   - *Cross-cutting quality.* Catches "this only affects the new code path" assumptions that turn out wrong because the change touched shared validation, shared state initialization, etc.

3. **GUIDE — Openness check.** Does this over-fit to the current immediate use case, or stay general? If a config option, prompt, or check is hardcoded to today's content type / template / step, flag it.
   - *Reinforces the "small generic modules" architectural commitment.* Plans that bake in "for company profiles" or "for casino-platforms pillars" should justify why they can't stay generic.

4. **HARD — Fit with Architectural Commitments.** Plan must not violate the rules in the "Architectural Commitments" section above (small generic modules, step boundary discipline, ID-based composition, position-agnostic validation). If it does, the plan must explicitly call out the exception and justify it.

5. **HARD — Diagnosis verification when remediation depends on it.** If the plan is a bug fix, the diagnosis must be verified by a source **independent of the one that produced the original diagnosis** before remediation design starts. Reading the same code that produced the wrong diagnosis does NOT count — the second read inherits the first read's blind spot. Acceptable independent sources:
   - A different model (Gemini, GPT) reviewing the trace fresh, given the symptom but NOT the proposed diagnosis
   - A database query that proves or disproves the proposed mechanism (e.g., `SELECT status FROM entity_submodule_runs WHERE ...`)
   - A log inspection that proves the new code fired (or did not)
   - A human reading the path independently, without seeing the diagnosis first
   - *Prevents #3.* The "auto-executor uses a different code path" diagnosis was wrong. Claude Code could not catch its own wrong diagnosis by re-reading the same code that produced it — independent Gemini did. Independence is what makes the second source valuable; without independence, the verification is theatre.

### C. Validation criteria that actually validate

A change is not validated until ALL of these are true for the specific case the change addresses.

1. **HARD — "Outputs produced" is NEVER sufficient proof.** Outputs can be produced by pre-existing code paths, by partial execution, by happy-path fallbacks. Output presence proves nothing about whether the new mechanism fired.
   - *Prevents #4.* The empty-pool smoke test "passed" for Pronet Gaming (outputs produced) but the new precondition-check code path never fired because Pronet's pool was never empty. The test validated nothing about the change.

2. **HARD — Evidence the new code actually ran.** One of: a database row written by the new code (e.g., `skipped_no_input` status), a log line emitted by the new code, a metric incremented by the new code. The plan must specify which evidence will be inspected, and validation must include reading that evidence.

3. **HARD — Correct behavior under the designed conditions.** Construct a test case that triggers the condition the change handles. Empty-pool fix → run with an entity whose pool will be empty. Routing fix → run with QA failures that trigger routing. Without this, the change is unvalidated even if it deployed cleanly.

4. **HARD — Failure-visibility check.** If the change failed silently, would you know? Specifically: are there error logs, status fields, or DB rows that would surface a malfunction? If the answer is "no" or "I don't know," the change is not safely deployed.
   - *Prevents #4.* The cascade-delete bug destroyed the very tracking rows that would have revealed the failure. Outputs were produced for the entity that worked; the entity that failed left no auditable evidence trail.

### D. Spec discoverability

1. **HARD — Before implementing in an area, check `Content-Pipeline/specs/` for governing specs.** Restated from A.1 as a process rule (not just a pre-flight step) so it applies to small changes too, not only architectural ones.

2. **GUIDE — Reference governing spec by filename in plans, commits, and PRs.** Format: *"Implements §X.Y of `PHASE_3B_PER_ENTITY_INSTRUCTIONS_SPEC.md`."* Without this reference, future sessions can't trace the implementation back to the spec, and the discoverability problem repeats.

### E. Pending-spec tracking

1. **GUIDE — Specs marked "pending sign-off" / "REVIEWED v4 — pending final sign-off" / similar require an explicit owner and decision date.** Indefinite pending state is a flag, not a neutral state. A spec that has been pending for >30 days should be reviewed for adoption, rejection, or extension with a new date.

2. **GUIDE — When you encounter a pending spec during pre-flight, surface its status to the user.** Phrasing: *"Spec `X.md` is in pending-signoff state, last reviewed [date]. Adopt now, defer, or design around?"* Don't silently implement against a pending spec without confirmation.

### F. Time and progress honesty

1. **GUIDE — When summarizing accomplishments, distinguish current-session work from prior-session work.** Sentences like *"we accomplished X"* implicitly claim X was done in the current session. If most of "we accomplished" was actually finding work other sessions did, say so.
   - The 2026-05-26 PHASE_3B session is the canonical case: the real outcome was *recovering an existing spec*, not new design. Framing it as "we did major architectural work today" would have been an overclaim.

2. **GUIDE — Distinguish problem-progress from context-recovery.** Both are useful, but they are not the same thing.
   - *Problem-progress:* code changed, bug fixed, test passed, capability added, decision made and acted on.
   - *Context-recovery:* spec found, history reconstructed, prior state understood, gap surfaced.
   - Context-recovery is necessary, often the right thing to do, and frequently undervalued. But it's not problem-progress. Conflating them inflates session summaries and creates a misleading picture of where the project stands. Future sessions then pre-flight against a project state that isn't real.

### G. Reviewer engagement timing (HARD)

Reviewers (CTO, brutal-critic, Gemini, AI second-opinion) engage at SCOPE moments, not just plan-complete moments:

- **Strategic pivots** — Before any "let's change direction" call. CTO verifies the pivot aligns with current plan state.
- **Scope definition** — Before "this work covers X, defers Y." CTO verifies the deferral aligns with planned sequencing.
- **Trade-off decisions** — Before "Option A vs Option B." Brutal critic torches the weaker option. Gemini verifies the stronger one's assumptions.
- **Multi-day planning structure** — Before deciding "single plan vs multiple plans." CTO weighs architectural implications.
- **Long session drift** — When a session exceeds 20 exchanges or 2 hours, CTO checkpoint verifies current direction still aligns with the plan.
- **User pushback on direction** — When the user challenges a direction ("are you sure about X"), that's a reviewer trigger, not just "let me check again." The pushback itself signals reviewer engagement is needed.

*Prevents:* drift in planning sessions before plans are drafted. Catches stale-info pivots. Catches scope creep before it locks in. Session 2026-05-28 demonstrated multiple pivots that CTO would have caught at scope-definition moments.

### H. Current-state verification (HARD)

Before strategic recommendations referencing planning documents:

- **Verify the document is current** before citing it:
  - `ls -la specs/[plan_file]` (modification date)
  - `git log -1 specs/[plan_file]` (last commit)
- **Files older than 14 days** or with recent commits the current context might not reflect: re-read before recommending based on them.
- **Cite specific line numbers** when referencing plan content. "V5 puts X in Phase Y" without line reference is a flag to verify before acting.
- **Uploaded files in session context are snapshots**, not authoritative. Treat them as historical until verified current.
- **When user provides plan content via upload**, ask if it represents current state or is a snapshot from a specific date.

*Prevents:* recommendations based on stale plan state. Session 2026-05-28 demonstrated April 28 V5 snapshot being treated as authoritative when May 6 ROADMAP had restructured Phase 3.

**Extension (2026-05-29) — Capability verification, not just config/file existence.**

When a pre-flight finding claims "X exists" or "X is built," verify all three before accepting the claim:

1. **Code exists** — not just config / JSONB / comments. A template entry referencing a card name is not the card.
2. **Code does what its name implies** — not just exists with that name. A function named `validateInput` that returns `true` unconditionally is not validation.
3. **Production runs have exercised it end-to-end** — not just shipped untested. Code that exists but has never executed is not "shipped."

Without all three, the correct framing is **"X is partially present"** — not "X is built."

Specifically dangerous:
- **Template JSONB entries** — naming a card in template config is not the card existing in code.
- **BACKLOG items marked "designed" / "specified" / similar** — these are NOT "built."
- **Code that exists but has never executed** — NOT "shipped."

*Prevents:* overclaim of "built" or "shipped" capabilities. Inflates project state, drives future sessions to pre-flight against capabilities that don't actually exist (compounds A.2 failure — the implementer reads partial code thinking it's complete). Closely related to F.2 (problem-progress vs context-recovery): naming something is not building it.

### I. Post-merge callsite audit for architectural changes (HARD)

When an architectural change (DDL migration, contract change, identity-shape change, RPC signature change) merges, the change ships with its OWN tests for the new behavior. But callsites referencing the changed surface — code that the change didn't directly touch but that depends on it — are NOT covered by those tests. Without a deliberate post-merge sweep, those callsites silently break and stay broken until someone runs the affected path with eyes open.

After merging any architectural change, before subsequent work begins on top of it, run a callsite audit:

1. **Identify the changed surface.** Concretely: which functions, types, table constraints, manifest fields, RPC signatures, JSONB shapes did the change modify? List them.
2. **Grep for direct references.** `grep -rn` each name across both repos. List every file that references the changed surface.
3. **For each referenced file, verify compatibility.** Does the caller's assumed behavior match the new behavior? Does the caller make assumptions the change invalidated? Be specific: line-by-line, not "looks fine."
4. **Test the actual transition.** If state migrated, exercise the migrated state on a branch/staging DB with the new code. Not just unit tests on the new code in isolation — the actual prod-state-equivalent.
5. **Document the audit output.** Either: zero additional changes needed (record the audit was done), OR N follow-up fixes filed with traceable references.

Three concrete examples from this codebase:

- **2026-06-03 Multi-Card Pattern migration** added `card_id` to three unique indexes (`run_submodule_config`, `submodule_runs`, `entity_submodule_runs`). Three callsite onConflict strings in `submoduleConfig.js`, `submoduleRuns.js`, `templates.js` were NOT updated. Bug surfaced 2026-06-06 as UI save errors (B052). Callsite audit at merge time would have caught it.
- **2026-05-24 V5 empty-pool-fix work** introduced composite `(itemKey, source_submodule)` identity in `add` operation. The `remove` and `transform` operations were NOT audited for compatibility. Multi-source duplicates survived all Step 2+ filters for ~13 days in prod (B054). Callsite audit at merge time would have caught it.
- **2026-04-22 Step 7 routing migration** changed `apply_entity_routing` RPC to accept `p_routing_step` parameter. The deployed `routingHandler.js` call site was NOT updated to pass it (commit `d881612` fixed it post-deploy when prod errored).

*Prevents:* the recurring failure mode where an architectural change ships its own tests in isolation but the lateral impact on call sites isn't audited. The change's own tests pass; the callsites silently break. Without Pattern I, three bugs in 24h of careful testing (B052/B053/B054) is the visible surface of an iceberg whose scale is unknown until a deliberate audit runs.

*When to skip:* never for architectural changes (DDL, contract, signature, shape). Acceptable to skip for pure-implementation changes that don't alter contracts (e.g., refactoring internal helpers, performance tuning a single function). When in doubt, run the audit — its cost is hours, the cost of skipping is days of follow-up bugs.

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

## ⚠️ MERGE = DEPLOY (verified live 2026-08-02)

`.github/workflows/deploy.yml` triggers on **every push to `main`** and performs a
FULL deploy: client build in CI, `rsync -azP --delete` of the entire tree to
`/opt/content-pipeline-v2` (excluding node_modules/.env/.git/.github/logs),
`npm install`, and `pm2 startOrReload`. There is **no attended gate**: merging a
PR into `main` IS a production deploy. The D12 Cloudinary swap reached prod on
2026-08-02 precisely because "merge ≠ deploy" was assumed.

Consequences:
- **Branch + PR only.** Never push to `main` unless deploying right now is the intent.
  A push with `[skip ci]` in the commit subject is the only non-deploying main push.
- **The box IS a full checkout of `main`** after any CI deploy (the full-tree
  `rsync --delete` mirrors the repo). This **supersedes** the earlier
  "box is not a complete checkout" finding *for the skeleton* — diff-scoped
  Path-B deploys created that state, and the first CI deploy erased it. (The
  modules repo may still be deployed diff-scoped; verify separately.)
- `deploy.sh` / attended "Path-B" deploys still exist as tools, but any document
  claiming they are the ONLY deploy mechanism is wrong — CI-on-main-push is live.

## ⛔ Production Server — No Git Commands

**NEVER run git commands on the production server (188.245.110.34).** The server has no `.git` directory. It is deployed exclusively by CI/CD (rsync `--delete` from GitHub Actions). Running `git pull`, `git checkout`, or `git reset` on the server will either fail or corrupt the deployment.

- **To deploy a fix:** commit and push to `main` -- CI/CD handles the rest
- **For emergency server-side fix:** edit files via SSH + `pm2 restart all`, then commit the same fix locally and push (to prevent CI/CD from overwriting it on next deploy)
- **To verify deployed version:** `curl -s https://www.jugadorvip.com/api/version` or check `build-info.json` on the server

**Background (2026-04-28 outage):** A stale `.git` directory on the server (left from the initial clone, never updated by rsync) allowed git commands to silently overwrite CI/CD-deployed files with old code. The `.git` directory has since been removed by CI/CD.

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

## Multi-window discipline (#42)

Multiple Claude windows over the shared `Dropbox/Projects` tree have repeatedly clobbered each other's work. Five confirmed #42 incidents: a wrong-branch cross-repo push (2026-05-31), a wrong-thread session report, repeated `RESUME.md` overwrites by a parallel window, a lost session of client work, and the lost card-write landing kit. The six rules below are binding for every session in this repo. **Thread ownership** — which thread owns which repo/branch/worktree — is recorded in `content-pipeline-specs/THREAD_OWNERSHIP.md`; read it before you commit, and only commit within the repos/branches it assigns you.

1. **Verify repo + branch before any commit.** Use `git -C <absolute-path>` and absolute paths; never trust the shell's cwd — a persisted `cd` caused the 2026-05-31 wrong-branch cross-repo push. Confirm you are in the repo AND on the branch you think you are before staging.
2. **Push immediately after any commit that represents real work.** Unpushed local state has caused lost work more than once (the card-write kit, a client session). Do not batch pushes for later.
3. **RESUME.md etiquette.** A per-thread `RESUME.md` lives in that thread's own repo. Read it skeptically (it may be stale or written by another window). Update only your own thread's section. Never overwrite another thread's RESUME.
4. **One workstream per session.** One window = one thread = one worktree. Never run two concurrent windows over the same working directory. If a second track needs the same repo, it gets its own worktree (see THREAD_OWNERSHIP.md).
5. **Cross-boundary change flagging.** Any change that would touch another thread's repo, branch, or worktree STOPS and reports — it does not reach across. (Unit 0.1 did this correctly: the buildout-thread cross-refs living on another branch were handed off, not edited.)
6. **Never fabricate missing artifacts.** If a handoff kit, file, or prior state cannot be located, STOP AND REPORT. Do not reconstruct it from memory — a confidently-wrong reconstruction is worse than an honest "not found."

---

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

### Session: 2026-04-22 — Phase 4a/4b Escalation & Cascade Planning
**Accomplished:**
- Designed Phase 4a (Within-Run Escalation): ~99 lines in 2 files (autoExecutor.js + runs.js). After each step's primary submodules complete, check per-entity item counts — if below threshold, launch escalation submodules; if still below fail_threshold after escalation, mark entity as terminally failed
- Received thorough architecture review identifying 6 real issues: entity_run_meta consistency, failure ownership overlap with loop-router, loop pass cascade-delete interaction, scope of escalation (pool-wide waste), config placement, thin verification
- Revised plan (Rev 2) addressing all 6 concerns — escalation failures now write to entity_run_meta (terminal_state='failed', failure_reason='escalation_floor'), 9 verification cases documented
- Designed Phase 4b (Cascade Runs): ~450 lines, 3 new files, 1 migration. Cross-run retry system where failed entities become seed for new run with different template, routed by failure classification (scrape-blocked, thin-content, etc.)
- Explored codebase thoroughly: template schema, auto-executor main loop, entity_run_meta terminal state system, approve_step_v2 RPC forwarding logic, cascade-delete in routingHandler, terminal entity filter in submoduleRuns.js

**Decisions:**
- Phase 4a before 4b: within-run escalation ships first (~99 lines), cascade runs after validation (~450 lines)
- Failure ownership split: escalation owns "insufficient data" at Steps 1/3 (failure_reason='escalation_floor'), loop-router owns quality failures at Step 10 — no overlap
- Escalation runs for ALL entities (documented waste): per-entity filtering deferred as future improvement, acceptable at current 10-entity scale
- entity_run_meta must be written for escalation failures: upsert pattern matches apply_entity_routing RPC, terminal entity filter will exclude on loop passes
- No DB migration for Phase 4a: entity_stage_pool.status and entity_run_meta.terminal_state are free TEXT columns, execution_plan is JSONB
- Config as separate `escalation_rules` key in execution_plan (not nested into step objects): less refactoring, step numbers correlate across both keys
- Step 7 routing is a separate project (user clarification) — not part of Phase 4a/4b scope

**Blockers/Questions:**
- Phase 4a not yet implemented — plan approved in principle, code not written
- Step 1 escalation submodule (google-search-discovery) is a brief, not yet built — needed for real testing of Step 1 escalation
- Phase 4b depends on 4a being shipped and validated first

**Updated by:** session-closer agent

### Session: 2026-04-27 — Phase 2 scraping hardening + browser anti-detection
**Accomplished:**
- Phase 2 batch: B032 transform fix + B1 Load More click loop in browserPool
- Bumped Step 2 timeout factor 10s→60s per entity, base timeout 300s→600s for browser fallback workloads
- Step timeout now evaluates failure threshold instead of hard-halting the run
- Fixed PresetField: always show all presets in dropdown, allow saving new ones
- Hardened browser pool anti-detection for bot-protected sites
- Added Bright Data Web Unlocker as Cloudflare fallback
- Exposed `res.url` in http.get/head for redirect detection

**Commits:** 7 commits (Apr 25-28)

**Updated by:** CTO audit catchup (2026-05-21)

### Session: 2026-04-28 — CI/CD safeguards + browserPool locator migration
**Accomplished:**
- Migrated browserPool click loop to locator API with array selector support
- Added CI/CD safeguards to prevent server desync from manual git commands (removes .git after rsync — learned from outage)
- Fixed options merge bug and URL sanitization for entity input
- Fixed pool status blocking multi-submodule steps on loop passes
- Reset completed pools to pending before submodule run on loop passes
- Fixed batch finalization blocked by failed entity jobs

**Commits:** 6 commits (Apr 28-29)

**Updated by:** CTO audit catchup (2026-05-21)

### Session: 2026-04-29 to 2026-05-03 — Operational hardening + entity production + JSON form editors
**Accomplished:**
- Increased entity execution timeouts across all cost tiers
- Added iGaming preset seed script for url-filter exclude patterns
- Preserved partial scraping results on step timeout
- Increased per-LLM-call timeout from 300s to 600s
- Added entity_production support in approval logic + placement at next step
- Support dynamic detail sections and update category ordering
- Added form-based editors for JSON options (providers, keywords, params) — improves TemplateEditor UX
- Added XLSX support and CSV upload for csv-discovery
- Increased Step 2 timeout from 10min to 30min for high-volume URL validation
- Fixed entity_production: place produced entities at next step

**Commits:** 10 commits (Apr 29 – May 3)

**Updated by:** CTO audit catchup (2026-05-21)

### Session: 2026-05-05 to 2026-05-06 — Auto-executor enhancements + data flow optimization
**Accomplished:**
- Removed step-level timeouts — rely on job-level timeouts only
- Auto-resume orphaned runs on server restart (with crash-loop guard: if same run auto-resumed twice, halt permanently)
- Added automated 7-day data retention for pipeline runs
- Added pause_before_steps to auto-executor for triage checkpoints
- Activated selective field loading to reduce pool_items IO by ~95% (envelope system)
- Fixed cross-key enrichment: check per-field + add reverse direction
- Fixed enrichment: parse JSON strings + sort by step_index
- Fixed B046: preserve user-defined submodule execution order during progressive save
- Added pause_after_submodules to auto-executor for mid-step triage
- Fixed paused status UI: add blue dot in ProjectsList, distinguish submodule vs step pauses in RunView

**Commits:** 10 commits (May 5-6)

**Updated by:** CTO audit catchup (2026-05-21)

### Session: 2026-05-07 — Auto-resume fallback fix
**Accomplished:**
- Fixed auto-resume for template-less projects: fall back to run_submodule_config when no template execution_plan exists

**Commits:** 1 commit (May 7)

**Updated by:** CTO audit catchup (2026-05-21)

### Session: 2026-05-20 — Phase 3: Multi-card routing, escalation gates, template UI
**Accomplished:**
- Phase 3 commit: multi-card routing, escalation gates, and template UI enhancements (cards, routing rules, escalation rules sections in TemplateEditor)
- QA threshold tuning log with Phase 2 failure data analysis (docs/phase3-threshold-tuning-log.md)

**Commits:** 2 commits (May 20)

**Updated by:** CTO audit catchup (2026-05-21)

### Session: 2026-04-22 — Pronetgaming scraping fixes + proxy 407 fallback
**Accomplished:**
- Investigated pronetgaming.com scraping issues: broken sitemap (missing `/blog/` path segment → 404s), `word_count = NaN` in pass-through paths, no built-in URL exclusion patterns, browser-crawler missing `waitForSelector` for RSC/SPA pages
- Fixed `word_count` NaN propagation in stageWorker.js — added `word_count: 0` to both synthetic error item maps (lines ~495 and ~505)
- Created `scripts/seed-url-filter-preset.js` — idempotent script inserting global "Recommended" preset (16 social/junk URL patterns) into `option_presets` table. Verified on server (create + skip)
- Fixed proxy 407 fallback in `browserPool.js` — added HTTP status check before returning result, retries with direct browser on 407 (previously only caught thrown `ERR_TUNNEL_CONNECTION_FAILED` errors)
- Commits: `0a88e8c` (word_count guard + seed script), `10d4311` (proxy 407 fallback)
- Acceptance test PASSED: browser-crawler discovered 7 blog URLs from pronetgaming.com (threshold was 5)

**Decisions:**
- Deferred Fix #3 (pass full URL to url-relevance LLM) to separate PR — changes classification behavior globally
- Empty defaults + preset system for url-filter exclude_patterns — not hardcoded patterns in manifest
- `?? 0` for pass-through maps (preserves legitimate zero), `|| 0` for sum reduces (falsy fine in summation)
- Proxy 407 treated same as ERR_TUNNEL_CONNECTION_FAILED — retry with direct (no-proxy) browser

**Blockers/Questions:**
- None — all fixes deployed and verified

**Updated by:** session-closer agent

### Session: 2026-05-21 11:46 — Perplexity keyword research + template editor UI
**Accomplished:**
- Added Perplexity as AI provider in stageWorker.js (MODEL_MAP: sonar/sonar-pro, callProvider branch with citations support, retry/timeout)
- Added PERPLEXITY_API_KEY placeholder to .env
- Template editor overhaul: SubmoduleOptions reused in preset map (replaces raw text inputs), execution plan gets add/remove submodules per step, skip steps, pause before steps, failure thresholds UI
- RunView: added "Edit Template" link when project has template_id
- PresetField: auto-global save when no projectId, guard doc_selector/file_upload when no projectId
- step.ts: added `step` field to SubmoduleManifest interface

**Decisions:**
- Perplexity provider follows same pattern as anthropic/openai in stageWorker.js — gets retry logic, timeout, logging for free
- `citations` field added to AI response object (only populated for perplexity provider)
- Template preset map now uses full SubmoduleOptions component instead of raw key/value text inputs

**Blockers/Questions:**
- PERPLEXITY_API_KEY empty — needs API key from perplexity.ai before keyword research can be tested
- Skeleton + modules repos both ahead of origin (1 and 2 commits respectively) — need push

**Updated by:** session-closer agent

### Session: 2026-05-22 — Phase 3 planning + RPC bug fix
**Accomplished:**
- Ran full Phase 3 planning via Plan agent — discovered most multi-card infrastructure already built in previous sessions
- Confirmed Bug 2 (escalationRules passthrough) was a false alarm — already correctly wired in runs.js lines 1154 + 1228
- Fixed critical Bug 1: apply_entity_routing RPC only accepted 2 params but routingHandler.js calls with 3 (p_routing_step) — every auto-execute routing call was silently failing
- Created sql/migration_routing_phase3_rpc_fix.sql with DEFAULT 10, pipeline-ceiling comments, and source_step fix in entity_routing_log INSERT
- Applied migration to production Supabase (fevxvwqjhndetktujeuu), verified signature: `p_run_id uuid, p_routing_decisions jsonb, p_routing_step integer DEFAULT 10`
- Pre-commit code review found DEFAULT 7 should be DEFAULT 10 — fixed before committing
- Committed (d881612) and pushed to origin/main

**Decisions:**
- DEFAULT 10 (not 7) for p_routing_step — matches legacy hardcoded value and JS-side default in routingHandler.js; all callers supply explicitly so default is safety-net only
- Two remaining hardcoded 10s in RPC body (step_index = 10, step_index <= 10) are intentional pipeline-ceiling constants, not routing step references — documented with inline comments

**Blockers/Questions:**
- Phase 3 remaining: Batch 1 (model_select on 4 QA manifests), Batch 2 (belowThreshold escalation warning), Batch 3 (loop_generation decision map fix), Batch 4 (phase3-cards-routing-rules.sql production run), Batch 5 (server-side card validation route), Batch 6 (visual card builder UI, optional), then 50-entity E2E test

**Updated by:** session-closer agent

### Session: 2026-05-21 12:30 — Pipeline run 2931e702 post-mortem + data extraction
**Accomplished:**
- Investigated autorun 2931e702 (project "test2", 10 entities, 2026-05-20 14:41–16:16 UTC)
- Diagnosed result pane bug: auto-execute completes steps but doesn't populate batch-level submodule_runs.output_data — UI reads from that table, finds NULL
- Diagnosed Traffillions step 2 timeout: 3,634 discovered URLs, url-relevance timed out at 300s, 527 URLs validated before kill — pipeline continued with partial set
- Diagnosed WeltBet (website unreachable: 30s timeout + Wayback HTTP 451) and Tipico (22 URLs found, 0 after filtering) having zero source material
- Found 4 entities missing entity_submodule_runs for steps 1-7 entirely (ThriveFantasy, Tipsport, Traffillions, VL Partners); 2 more missing steps 5-7 (Thrill Partners, Wanejo Bets)
- Extracted step 8 bundle JSONs for all 10 entities → ~/Downloads/run-2931e702-bundles/ (1.5 MB total)
- Extracted step 5 content markdown for 8 entities → ~/Downloads/run-2931e702-step5-markdown/ (Tipico + WeltBet had no content)
- Traffillions produced only 2.6 KB of markdown despite 527 validated URLs — content-writer underutilized source material

**Decisions:**
- Result pane emptiness is a skeleton bug in auto-execute path, not a data loss — per-entity data exists in entity_submodule_runs
- Steps 9 (Distribution) and 10 (Review) being skipped is expected auto-execute behavior (listed in steps_skipped)

**Blockers/Questions:**
- BUG: Auto-execute doesn't write batch-level output_data to submodule_runs table — result pane empty for all submodules in auto-executed runs
- BUG: entity_submodule_runs not created for all entities at all steps during auto-execute (only 4-6 of 10 entities have records for steps 1-7)
- Traffillions content underutilization: 527 scraped pages produced only 2.6 KB markdown — content-writer may not be consuming all pool items

**Updated by:** session-closer agent

### Session: 2026-05-22 — Supabase performance diagnostic + compute upgrade + zombie cleanup
**Accomplished:**
- Full CTO audit of git state, deploy state, and prod DB. Confirmed Hetzner is on `f9c1e55` (latest skeleton commit) and modules repo synced (seo-planner v2 keyword research present). PM2 stable (`unstable_restarts=0` on all workers).
- Diagnosed recent `canceling statement due to statement timeout` errors (May 5, May 21) in api-error.log. Root cause was NOT statement_timeout config — `authenticator` already at 120s on prod (not the 8s default another chat assumed). Real cause: NANO compute (`t4g.nano`, 0.5 GB RAM, burstable 10% baseline CPU) exhausting burst credits under 50-entity workloads.
- Verified entity_stage_pool plumbing is healthy: index `idx_entity_stage_pool_run_step` on `(run_id, step_index)` exists, JSONB `pool_items` payloads are tiny (avg 712 bytes max 722 at step 5). No structural perf bug — just compute starvation.
- Found 9 zombie `pipeline_runs` stuck in `status='running'` since May 5-13 — orphans from before the May startup-recovery fixes (`f13fc64`, `c90ae64`). Cleaned them up via transactional DELETE across all FK children (decision_log, entity_routing_log, entity_run_meta, entity_stage_pool, entity_submodule_runs, pipeline_metrics, pipeline_stages, run_submodule_config, step_context, submodule_runs, submodule_run_item_data) + their polymorphic submodule_run_item_data rows. 15 runs → 6 runs (5 completed + 1 paused).
- Ran `VACUUM (ANALYZE)` on all 6 bloated tables. Table sizes unchanged on disk as expected (VACUUM ANALYZE marks freed pages reusable; doesn't shrink files). Future inserts reuse the space.
- **Upgraded Supabase compute from NANO → Small** (`t4g.small`, 2 GB RAM, 2x CPU baseline). Memory chart confirms cache + buffers jumped from ~300 MB to ~1.4 GB after restart. This is the actual fix for the timeout symptoms.
- Discovered stale claim in `Content-Pipeline/PROJECT_STATUS.md`: says "Git repo initialized on Hetzner (`/opt/content-pipeline-v2/`), deploys via `git pull` + PM2 restart" — false. Neither skeleton nor modules dirs on Hetzner have `.git`. Actual deploy is rsync via `deploy.sh`. Needs correction (not done this session).
- Discovered earlier-session bug: modules-repo session log `528e685` claims `failed_count` was added to batchWorker, but skeleton commit `2117765` reverted that line 34 minutes later (column doesn't exist on `submodule_runs`). Session log entry still uncorrected.
- Wrote memory file at `~/.claude/projects/.../memory/supabase-plan.md` so future sessions don't reach for "free tier" framing — DB is on paid Pro with NANO compute add-on (now Small).
- Saved diagnostic SQL bundle at `sql/diagnostic_statement_timeout.sql` for future reference.

**Decisions:**
- Reject the "ALTER ROLE authenticator SET statement_timeout = '300s'" suggestion from another chat — 120s was already in place, and the symptom was compute starvation not query slowness. 300s would mask, not fix.
- Compute upgrade Small ($15/mo add-on) over Micro ($10/mo): $4 more for 2x RAM and 2x CPU baseline credits accrual. Right tier for 50-entity Phase 3 E2E test.
- `VACUUM (ANALYZE)` not `VACUUM FULL` — reusable space inside files is enough; FULL would lock tables exclusively during the rewrite (risky on prod).
- Targeted zombie cleanup by `status='running'` rather than time-based retention — 30-day cutoff returned 0 rows because the DB only has 15 total runs. Issue was stuck state, not accumulation.
- Don't `VACUUM FULL` the 175 MB on `entity_submodule_runs` — most of it is legitimate output_data from completed May 20 test2 runs, not bloat. Live within the data volume; reclaim only if real bloat shows up.

**Blockers/Questions:**
- Phase 3 validation run cleared to proceed: fresh 5-entity project, auto-execute Step 1-7 on the Small instance. Watch for entity_submodule_runs population (entity-merge fix `52540ae`), result pane content per entity, and absence of timeouts/500s.
- `PROJECT_STATUS.md` still claims git-pull deploy on Hetzner — should be corrected to reflect rsync deploy.
- `Content-Pipeline/PROJECT_STATUS.md` is also marked "Last Updated: 2026-04-28" — currently outdated by ~4 weeks of work.
- 4 RLS Disabled critical advisor warnings on `pipeline_metrics`, `option_presets`, `template_preset_mappings`, `submodule_run_item_data`. Low actual risk (server uses service_role, no anon access exposed), but should be enabled or explicitly opted out.
- modules-repo session log `528e685` `failed_count` claim still wrong — should be amended with reference to `2117765` revert.

**Updated by:** CTO agent (manual session entry)

### Session: 2026-05-24 — Empty-pool fix validated + routing cascade-delete bug surfaced

**Accomplished:**
- Empty-pool fix validated end-to-end on Pronet Gaming smoke test. Pool flowed correctly through all 11 steps; output produced in every format (markdown, HTML, JSON, schema.org). Precondition check, `skipped_no_input` entity status, and failure threshold logic all functioning on the intended code path.
- Routing cascade-delete bug surfaced during Wazdan investigation — pre-existing Phase 3 bug, NOT introduced by the empty-pool fix. Three stacked issues identified: (1) incorrect target_step calculation, (2) cross-entity scoping inconsistency, (3) no atomic transaction wrapping the cascade-delete + re-enqueue.
- Routing bug filed as a separate backlog item and deferred to next session.

**Decisions:**
- Routing bug filed and deferred, not patched in this session — three stacked issues need their own investigation pass, not a hot-fix during validation.
- Empty-pool fix unblocks single-pass success paths. Phase 3 multi-card validation remains blocked on the routing fix (retry paths don't work).
- Batch 8a (threshold tuning) and 8b (50-entity validation) both deferred until routing works for multi-failure entities.

**Blockers/Questions:**
- Routing cascade-delete bug — must be fixed before Phase 3 multi-card validation can proceed. Next session picks up here.
- Batch 8a and 8b remain blocked on the routing fix.

**Architectural findings:**
- **Verification value.** Three review rounds missed the routing bug's existence. Gemini verification corrected the initial diagnosis. The "verify before declare success" pattern caught real situations at every checkpoint and is what surfaced the bug at all.
- **Process gap.** Plans verify architectural correctness but not code path assumptions. Future plans should include code path tracing as an explicit verification step.
- **Parallel session coordination.** Multiple Claude Code sessions ran simultaneously today (this validation session + a CLAUDE.md update session that landed Workflow Patterns + Architectural Commitments + the rule 12 `pool_precondition` / `data_operation_default` rewrite). Worked OK because docs and code didn't conflict, but future parallel sessions should have explicit scope boundaries.

**Updated by:** manual entry (session conclusion notes from user)

### Session: 2026-06-03 → 2026-06-04 — Section C plan v3 (routingHandler rewrite contract)

**Accomplished:**
- Pre-flight commits landed: `b879c1d` (require `card_round` on pending targets in `validateCardInstructions`; 5 new tests including 3 loud-fail variants + multi-target happy path + historical-state preservation; 80/80 cardInstructions tests green) + `1eee648` (two LOW cleanups in submoduleRuns.js: dead `loop_config` removed from entity_run_meta select, per-entity card-merge console.log downgraded to per-batch aggregate). Both pushed to origin `sub-plan-1-multi-card`.
- Drafted plan v1 (445 lines) → CTO plan review surfaced 7 findings (1 PASS, 6 NEEDS-REVISION).
- Conducted `is_loop_pass` consumer audit: confirmed `apply_entity_routing` is sole setter; enumerated all 9 hits in `submoduleRuns.js`; recommended option (b)-via-cardId. Audit landed on the simpler architectural answer (cardId is already the routed-retry signal, present on every retry via the writer chain — `is_loop_pass` was a redundant pre-Multi-Card-Pattern side channel).
- Revised to plan v2 (830 lines) folding all 7 v1 findings.
- Dispatched parallel same-model agents (brutal-critic + Gemini-leg) — caught findings 1, 2/3, 5 correctly. **Mis-labeled the second agent as "Gemini" — actually a same-model general-purpose subagent, not real Pattern B.5.** Surfaced honestly to user.
- User ran real Gemini independent verification on plan v2 + the 6 live files (sql/migration_multi_card_pattern.sql, server/services/{routingHandler,cardInstructions,cardGroups}.js, server/routes/{submoduleRuns,runs}.js). Real Gemini confirmed findings 1, 2/3, 4, 5 + caught **Finding 6 (CRITICAL)** the same-model "Gemini" leg missed entirely: plan v2 pseudocode passed `findPendingInstructionsForRun(stepIndex=null, ...)` for the QA-passed cleanup, but the helper at `cardInstructions.js:203` strictly filters `target.step === stepIndex`, so `target.step === null` evaluates false for every target → helper returns zero pending → cleanup silently does nothing. Exact silent-no-op class the whole sub-plan exists to kill. Same-model agents reasoned about it as a deferred design uncertainty (Open Question 1), not a code-execution bug.
- Revised to plan v3 (932 lines, commit `71764d2`) folding all 4 real-Gemini load-bearing findings + Test Group 8 rewrite to reachable case + one-line `validateCards` cardId-step-uniqueness warning. User read-through cleared all 3 v3 spot-checks (finding 6 helper extension, Group 8 rewrite, no fictional SELECT FOR UPDATE in the SQL).
- Branch pushed to origin: 3 commits ahead (`b879c1d` + `1eee648` + `71764d2`), durable on GitHub.

**Decisions:**
- **`is_loop_pass` retired via cardId-based derivation** (option (b), not the band-aid side-channel option (a)). cardId is already the routed-retry signal via the writer chain (`runs.js:1155` → autoExecutor → `cardGroups.js:99-106` → batchWorker → `submodule_runs.card_id`). The flag predated the Multi-Card Pattern contract; now structurally redundant. Single source of truth.
- **`loop_count` atomic via RPC parameter, NOT separate UPDATE.** Add `p_increment_loop_count BOOLEAN DEFAULT FALSE` to `append_card_instruction` via one added SET clause (`loop_count = CASE WHEN p_increment_loop_count THEN COALESCE(loop_count, 0) + 1 ELSE loop_count END`) in the existing single UPDATE WHERE NOT EXISTS. Atomicity by Postgres single-statement UPDATE semantics — if dedup blocks (0 rows touched), loop_count naturally doesn't bump. No SELECT FOR UPDATE required (v2 pseudocode invented one; v3 fixed it against the live RPC body at `migration_multi_card_pattern.sql:133-163`).
- **`findPendingInstructionsForRun` and `findPendingInstructions` extended to accept `stepIndex: number | null`** ("all steps" semantics when null). Gemini-verified all 4 callers pass specific integers → extension is purely additive, zero backward-compat risk.
- **Test Group 8 rewritten to the reachable dangerous case** (`cardId=null`, non-card-routed step-rerun, `inputData.entities.length > pool.size`). v2 spec verified a vacuously-passing card-routed scenario that can never reach line 411 (Gemini-confirmed if/else exclusivity). Group 8 documents an intended **behavior change**: pre-v2 the defensive merge was blocked on `isLoopPass=true`, silently dropping the widened entities (the bug the merge exists to prevent). Post-v2 the merge fires, entities preserved. Confirmed by user as the desired correctness improvement.
- **`is_loop_pass` column kept inert in schema for one production cycle**, dropped in follow-up migration. Schema comment updated to DEPRECATED with date + reason — never becomes mystery-cruft.
- **AC 2 grep exclusion list** adds `migration_routing.sql` and `migration_multi_card_pattern.sql` (real-Gemini direct grep confirmed the v2 list was incomplete; without these, AC 2 would falsely block the commit).
- **One-line belt-and-suspenders `validateCards` warning** added for cardId-reused-across-steps. `getConsumedRoundsForRun` keys by (entity, card_id), not (entity, card_id, step) — latent cross-step contamination if a future template reuses a cardId at multiple steps. Today's data model doesn't; the warning surfaces the latent shape.
- **Three review rounds, not four.** Brutal-critic explicitly recommended the 2-round cap stand after v2 → real-Gemini on v3 if findings folded cleanly. v3 user read-through cleared all spot-checks. No more reviewer rounds; implementation runs against v3 in a fresh session.
- **Plan v3 committed + pushed** (against initial "no push" close-out plan) — three rounds of review investment + load-bearing pre-flight contract should not be local-only on a single machine. Plan is the implementation contract; belongs in git history.

**Cross-model verification process finding (NEW):**
The v2 review round dispatched two parallel same-model general-purpose subagents, one labeled "Gemini" via brief. Both agents made real tool calls against real files (so their findings weren't fabricated), but they share the underlying model and its blind spots. **Finding 6 alone would have shipped if the simulated round had been trusted as Pattern B.5.** Going forward in this project, treat simulated cross-checks as same-model; weight only real cross-model checks (paste files to actual Gemini, or fetch via WebFetch) as Pattern B.5. Documented in plan v3 itself for posterity.

**Blockers/Questions:**
- Section C implementation pending — runs against v3 plan in a fresh session. Multi-hour single-file rewrite + 2 SQL files + helper extensions + 9 test groups + ship-gate. Needs fresh runway (no half-rewrite at session boundary).
- Tripwire stub continues guarding production until Section C lands AND deploys. Do not push Step 7 traffic.
- Deploy gate pre-condition 0 (HARD STOP) for the eventual deploy session: `ecosystem.config.cjs` must handle fork_mode cleanly (per 2026-06-02 PM2 cluster_mode incident). Separate 1-task micro-plan owns the fix; if not landed, `deploy.sh` MUST NOT run.
- Out-of-scope candidate filed: runtime loud-fail check that `cardId` is present on step-execute calls to steps with pending instructions. cardId is currently structural-plumbing (Gemini-surfaced nuance), not runtime-enforced. Section C retires `is_loop_pass` on the structural-plumbing guarantee; a future check would convert it to a runtime guarantee.

**Updated by:** session-closer (manual entry — Section C planning closeout)

### Session: 2026-06-04 13:30 — Section C implementation landed (routingHandler rewrite, BACKLOG #7 closed)

**Accomplished:**
- Implemented plan v3 end-to-end in a single fresh session — 9-file atomic commit `16886fb` on `sub-plan-1-multi-card`, pushed to origin. 1450 insertions, 105 deletions.
- Rewrote `applyRouting()` in `server/services/routingHandler.js`: (a)-(d) preserved verbatim (router-output read, decisions build, routing_rules resolution, max_loops backstop, DECISION_TARGET_MAP fallback); (e)-(g) replaced with per-entity instruction-write loop using `writeInstructions` + `markSkipped` from cardInstructions.js. Bound check on `card.rounds[nextRound]` before emitting target. Per-entity try/catch isolates failures — terminal_state='failed' + failure_reason='instruction_write_failed' on writeInstructions throw, loop continues for others.
- Extended `cardInstructions.js`: `writeInstructions` accepts `incrementLoopCount` → propagated as `p_increment_loop_count` to the RPC (default FALSE for back-compat with sub-plan 2 gate writer). `findPendingInstructionsForRun` + sibling `findPendingInstructions` extended to accept `stepIndex === null` meaning "all steps" (closes the real-Gemini v3 finding 6 silent-no-op). Added `step` field to the `pending[]` shape (was only on orphaned; the QA-passed cleanup needs `step` to call markSkipped correctly — caught by my own test on first run).
- Retired `is_loop_pass` in `server/routes/submoduleRuns.js`: read block deleted, 7 consumer sites swapped from `isLoopPass` → `cardId` (load cardDefinitions, reset 'completed' pools, filter to 'pending', filter terminal entities, load metaMap, line 411 defensive merge guard DROP, inject loop_count). Line 411 `!isLoopPass` guard dropped per Gemini-verified if/else exclusivity. `schema.sql:47` comment marked DEPRECATED with date + reason (column drop deferred to follow-up migration after one production cycle).
- Two new SQL files committed atomically with the JS: `sql/add_increment_loop_count_to_append_card_instruction.sql` (re-CREATE `append_card_instruction` with new `p_increment_loop_count BOOLEAN DEFAULT FALSE` param + one added SET clause for atomic `loop_count` bump — body byte-identical to `migration_multi_card_pattern.sql:133-163` except the parameter, SET clause, and updated COMMENT) and `sql/drop_apply_entity_routing_tripwire.sql` (single `DROP FUNCTION IF EXISTS apply_entity_routing(uuid, jsonb, integer)`, idempotent).
- Wrote `server/tests/routingHandler.test.mjs` (691 lines, 9 test groups, 49/49 green) covering: happy path + cascade-delete-gone + no-apply_entity_routing-call assertions (Group 1), bound check → markSkipped not write (Group 2), per-entity isolation under RPC error + sync throw (Groups 3a/3b), max_loops backstop (Group 4), partial vs full rounds exhaustion (Groups 5/6), QA-passed cleanup with stepIndex=null walking multiple steps (Group 7 + 7b throw sub-case), line 411 static-analysis check (Group 8 — plan-authorized fallback because route handler isn't a clean named export), validateCards new warning negative case (Group 9).
- Extended `server/tests/cardInstructions.test.mjs` with 5 new tests (88/88 green): 3 `incrementLoopCount` tests (default false, explicit true, explicit false) + 2 `stepIndex=null` tests (returns all steps + stepIndex=N unchanged — closes the real-Gemini v3 finding 6 directly).
- Wrote `server/tests/section_c_ac4a_merge_chain.test.mjs` (318 lines, 17/17 green) — AC 4a in-memory cross-seam proof: `_placeholder_marker` from `card.rounds["2"]` survives `routingHandler` → entity_run_meta payload → `expandCardGroups` → submoduleRuns merge → final executed options. Round-2 model (sonnet) replaced Round-1 base (haiku); non-overridden base preserved (max_tokens=4000). Cross-seam invariant asserted.
- Code review (general-purpose subagent against the full diff) returned PASS with one INFO-level finding — stale JSDoc on `applyRouting` ("cascade-deletes stale data, calls RPC") fixed in the same commit.
- Ship-gate run pre-commit: **AC 1 PASS** (zero cascade-delete grep matches in routingHandler.js), **AC 2 PASS** (zero live refs to `apply_entity_routing` / `is_loop_pass` repo-wide; remaining matches are Section-C documentation/test grep assertions only), **AC 3 PASS** (per-entity isolation under RPC error + sync throw via Groups 3a/3b), **AC 4a PASS** (17/17 cross-seam merge chain).
- Pre-commit hook enforced decision_log entry — discovered the hook points at the project-command-center Supabase project (`zgfvgghfkkbrbiunsgry`), not the pipeline's own Supabase project. Wrote a manual decision_log entry there (id `4901444c-389f-4e43-a176-774501966159`) via REST POST with the anon key. Both gates (decision_log + code-path trace) passed at commit time.
- Wrote handoff note for the deploy session at `/Users/danieloskarsson/.claude/plans/sub-plan-1-section-c-deploy-handoff.md` (208 lines): branch state, both hard deploy-gate pre-conditions, the BACKLOG #17 minimal-bootstrap dance for the Supabase branch test (so the deploy session doesn't rediscover the empty-branch FK-fail), tripwire status, the two SQL files to apply, 8-step deploy session checklist.

**Decisions:**
- **AC 4 split into AC 4a (JS, free) + AC 4-RPC (SQL, deferred to deploy gate).** AC 4 has two distinct things to prove against two layers: (1) the merge chain across JS seams — provable in-memory via AC 4a, (2) the RPC body atomicity (loop_count CASE expression bumps only on dedup pass-through, NOT on WHERE NOT EXISTS block) — SQL behavior, cannot prove in-memory. Sequenced AC 4a NOW (free, fast, proves the JS mechanism); AC 4-RPC pinned as HARD deploy-gate pre-condition 1 alongside the existing pre-condition 0 (ecosystem.config.cjs fork_mode fix). Rejected: AC 4 against prod first (tripwire still guards), AC 4 against local Supabase CLI (not installed; setup overhead unjustified for this gate), branch dry-run before commit (sequenced free proof first; branch cost only justifies when actually deploying).
- **Partial-AC-4 disclosure as prominent as the passes in commit body + decision_log + handoff.** "154/154 green" + "AC 4a PASS" reads triumphant; the deferred AC 4-RPC could get visually lost. Wrote it as a top-level "DEFERRED — NOT YET RUNTIME-PROVEN, HARD DEPLOY BLOCKER" section in the commit body and as next_steps in the decision_log entry — not a footnote.
- **Pre-commit hook target Supabase project discovered**: `zgfvgghfkkbrbiunsgry.supabase.co` (project-command-center DB), NOT the pipeline's own `fevxvwqjhndetktujeuu`. The hook reads `SUPABASE_ANON_KEY` from env and POSTs to that project's `decision_log` table. Schema: `project_name`, `entry_type`, `summary`, `decision_made`, `alternatives_rejected`, `reasoning`, `status`, `next_steps`, `tags`, `files_changed`, `source`. Captured in this session log for future reference.
- **`step` field added to `pending[]` shape in cardInstructions.js**, not just to `orphaned[]`. Originally only `orphaned` carried `step` (the read site was only the step-specific helper, which the caller already knew). My QA-passed cleanup needs step to call markSkipped — without the field, the very test designed to prove finding 6's fix failed because `p.step` was undefined and the skip RPC arg was wrong. Caught on first test run, fixed once. Zero consumer impact (`cardGroups.js:81` only filters by submodule_id).
- **Stale JSDoc on `applyRouting` fixed in the same commit as a code-review INFO-level finding.** Plan v3 said "Single atomic commit" — strict reading allowed the doc fix because it touches the same file already in the commit; not a separate scope.
- **Group 8 implementation followed the plan-authorized fallback** (static-analysis check via fs.readFileSync + regex match on submoduleRuns.js:411 area, asserting `!isLoopPass` is gone and the `else if` branch is preserved). Plan v3 explicitly permits this when the route handler isn't a clean named export.
- **Branch pushed AFTER ship-gate passed**, not before. Push triggers no deploy (deploy.sh is the gate, branch is non-mergeable per its history, tripwire still guards prod) — pure backup of the most load-bearing commit in the effort.

**Blockers/Questions:**
- **AC 4-RPC body atomicity runtime-unverified.** SQL behavior; cannot prove in-memory. **HARD deploy-gate pre-condition 1** — must pass on a Supabase branch dry-run before `deploy.sh` runs. The two paths to prove: dedup-PASS (new target, RETURNS TRUE, 1 row updated, loop_count incremented by 1) AND dedup-BLOCK (same target, RETURNS FALSE, 0 rows updated, loop_count UNCHANGED). Plus idempotent DROP of the tripwire stub.
- **Pre-condition 0 (ecosystem.config.cjs fork_mode fix) still pending.** Separate ~1-task micro-plan; if not landed AND deployed verifiably, `deploy.sh` MUST NOT run. The 2026-06-02 cluster_mode incident will recur on any fresh deploy that wipes PM2 state.
- **BACKLOG #17 trap will hit the deploy session's branch test**: `schema.sql` was applied to prod directly, not through Supabase's migration history. Fresh Supabase branch starts empty; first tracked migration FK-fails. Handoff note documents the 6-table minimal-bootstrap dance (`pipeline_runs`, `pipeline_stages`, `entity_run_meta`, `entity_submodule_runs`, `submodule_runs`, `entity_stage_pool`) so the deploy session doesn't rediscover from scratch.
- **Tripwire stub (`sql/restore_apply_entity_routing_stub.sql`) continues guarding prod** until BOTH deploy-gate pre-conditions pass AND `deploy.sh` runs. Until then: no Step 7 traffic, don't resume paused runs toward Step 7, don't start runs reaching Step 7.
- **`is_loop_pass` column drop deferred** to follow-up migration after one production cycle (~1 week minimum). Column sits inert (no writes, no reads in runtime code) until that migration lands.
- **Cross-model verification disposition (process)**: this session had no reviewer rounds — implementation only. Plan v3 had real Gemini cross-check; b879c1d pre-flight enforces card_round contract at write time; code review by independent subagent caught the JSDoc nit. Trust chain rests on those, plus AC 4a's runtime proof of the JS mechanism. The RPC body is the one remaining hole.

**Alignment:** Confirmed. Section C is the load-bearing close-out of the routing model rewrite — closes BACKLOG #7 (cascade-delete partial-state damage class surfaced 2026-05-25 via Wazdan smoke test), retires the pre-Multi-Card-Pattern `is_loop_pass` side-channel, and lands the producer side that Sections A + B + B.5 plumbed against. Architectural commitments preserved: small generic modules (no specialized routing handlers per content type), step-boundary discipline (Step 7 routing concern, Step 5 generation), ID-based composition (cardId is the structural retry signal). No specialized modules added; no scope-creep; the rewrite is single-responsibility (routing) and atomic.

**Updated by:** session-closer skill

