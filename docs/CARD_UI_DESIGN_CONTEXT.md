# Card UI — Design-Context Package (for the Claude Design pass)

**Purpose.** Claude Design can't read this repo. This package is the portable reference so the
card-authoring UI (V5 items 16/17) is designed as an **extension of the existing template
editor**, not an invention. The design has **two fixed constraints and invents neither**:

1. **Visual + interaction patterns** — this document (extracted from `client/src/components/pages/TemplateEditor.tsx` + `client/src/components/primitives/SubmoduleOptions.tsx`, 2026-06-30).
2. **Data shapes** — the Step 1 contract (canonical `card_definitions` §1.2, array-form `routing_rules` §2.1, the §9 validation rules incl. the new 12-13). See the bottom section.

A static visual reference mock is at `docs/card-ui-reference-mock.html` (open in a browser / render in Claude Design — it reproduces the existing editor's look with the exact classes).

> **⚠️ §0 below supersedes the flat-sections reading.** The 2026-06-30 → 07-01 design conversation reconciled the model into a **nested, step-based** editor (not separate Cards/Routing/Escalation lists). §1–§9 remain valid for **tokens, idioms, gold patterns, and the data contract**; §0 says how to compose them and what changed.

---

## 0. Reconciled interaction model (2026-07-01) — READ FIRST

The design is **one nested surface organized by pipeline step**, not a stack of flat sections. The same surface serves **building a new template** and **editing an existing one**. This supersedes any "separate CardsSection / RoutingRulesSection" reading below.

**A. One surface, nested by step; greyed-until-activated.**
- Show the pipeline steps (0–10). Each step expands to reveal the submodules that run in it.
- **Every submodule is greyed until activated** (= added to `submodules_per_step`). Activating + configuring **is** template-building; editing later is the same surface. No separate "creation wizard."
- **Steps 6 (QA) and 7 (Routing) are configured here too** — set thresholds, pick which submodules/variants to route to. Not a separate mode.

**B. Submodule-row CTAs (these replace the flat removable chip).** Each active submodule row carries, on the right (where "idle →" sits today):
- **data-op glyph `➕ / ➖ / ＝`** — the EXISTING `CategoryCardGrid` control (add / remove / transform). **DO NOT remove it** — it's the Rule-12 pool-operation contract, a different axis from the CTAs. Keep it.
- **Edit** (renamed from "Change") — opens the config / round-overrides editor (settings, reference docs, LLM/model, prompt) = **reuse `SubmoduleOptions`** (§4).
- **Clone** — clones the submodule into a card/variant (see E).
- **Reorder** up/down arrows — running order **is** the `submodules_per_step` array order (saved in the template).

**C. Variants (v2/v3/v4) are inset + badged; the step view is a CATALOG, not the orchestrator.**
- A cloned variant renders **inset (~100px indent)** under its parent submodule, with a version badge (`v2`/`v3`/`v4`) and a `Retry-only` tag where applicable.
- The generation/step view only shows **which variants exist**. It does **not** decide when they run — routing does (F). Do not make variants look like they run on their own.

**D. Run 1 / 2 / 3 / 4 tabs (at the top of a step).**
- Tabs select which "run" (round) you're viewing. **Run 1** = the normal-order submodules (`submodules_per_step`). **Run 2+** = the routed retry variants.
- Selecting Run 2 **highlights** the variants active on the 2nd pass and **greys** the rest. So "greyed" has ONE meaning: *not active in the run you're currently viewing* (this resolves the earlier "unused vs variant" ambiguity — the run tab is the single axis).
- The tabs are a **view** consistent with `routing_rules` (the source of truth for which variant runs when), not a second place to author routing.

**E. Clone → save-scope chooser.** Clicking Clone prompts where to save the variant:
- **Template-specific** — ✅ supported now (`card_definitions`, template-scoped by default).
- **Global (reusable across templates)** — ⏳ **STUB, unlinked.** Show the option, mark it "coming"; **no backend** (BACKLOG **Item 37**). Caveat baked into 37: escalation/writer variants are the *config-carrying, routing-target* case (need fresh namespaced `card_name` + provenance when built); config-free discovery clones (e.g. a PSE curated source list) are the clean global-safe case.
- **As a v2/v3/v4 version** of an existing submodule.

**F. Variant → routing connection (answers "how do they get wired").**
- A variant is **dormant until routing wires it** — existing-but-unrouted is fine, not an error.
- In Step-7 routing: map a QA failure `"<check>:fail"` **→ a target card** via a dropdown listing **all existing variant cards + any unused submodule**. The **threshold** lives in the QA submodule's **Step-6** config; the failure signal it emits is the routing key.
- **Build order works top-down:** create variants first (Step 5) → set QA thresholds (Step 6) → wire failure→variant (Step 7). Rules 10/11: routing can only target a pre-existing card with a round > 1.

**G. Escalation rules — OUT OF SCOPE (correction 2026-07-03). Leave the textarea; do NOT touch.**
- ⚠️ **The earlier "round-keyed escalation editor" guidance (this §0.G, pre-2026-07-03) was a design error** — round-keyed escalation gates were invented in the design pass and do not exist in the runtime. Ground-truthed against live code: `escalation_rules` is **STEP-index-keyed** (`autoExecutor.js:379` reads `config.escalationRules?.[String(stepIndex)]`; the live "30 april" template keys are `"2"`/`"4"`), with per-step fields — **Step 2:** `volume_threshold`/`fail_threshold` (on URL count); **Step 4:** `quality_threshold_words`/`quality_fail_threshold` (on word count). There is **no round dimension** in the shape, the type, or the consumer.
- A **"Round 2/3/4 tab strip" CANNOT emit a byte-identical `escalation_rules`** — it's a category error (round-keyed keys would feed `evaluateEscalationGate` wrong step indices, breaking the live gate). "Rounds" belong to `card_definitions.rounds` + `routing_rules` (the retry feature) — which is exactly what the **§0.D Run 1–4 tabs** view. Escalation gates fire at **steps 2/4, not Step 7** — so an escalation editor does not belong in the Step-7 routing body either.
- **DO:** leave `EscalationRulesSection` (the raw-JSON textarea) **UNTOUCHED** — it is live and *literal*-byte-safe (it preserves the live `_comment` string + field order that a typed re-serializer would drop). A structured **step-keyed** editor (Step 2 / Step 4) is a **separate future item with its own review — NOT part of card-write.**

**H. Out of scope — two documented future epics. Design forward-compatible; DO NOT build.**
- **Global variant library — BACKLOG Item 37.** Stub only (E). No store, no resolver.
- **Non-linear / fluent-graph flow — BACKLOG Item 36** (analysis-driven re-discovery: an analysis LLM finds new companies/people/concepts → a *new* discovery round → scrape/transcribe → writer; arbitrary step jumps with different inputs per re-entry). Architecturally in-bounds (same routing / ID-composition machinery) **but** needs new discovery modules, LLM question-expansion, a **NEW routing trigger beyond `"<check>:fail"`**, and executor work. **Keep the routing model generic (trigger → target card at step)** so Item 36 extends it later; a stubbed note "future: non-`:fail` triggers (Item 36)" is fine, but **build only the stepwise + QA-failure routing-loop model.**

**I. Collapse the "three overlapping lists" confusion.** In the flat model a submodule appears in Preset Map *and* Execution Plan *and* Cards — three places. The nested model shows each submodule **once**, under its step, with its preset/config in its Edit body and its variants inset. Don't re-list the same submodule across sibling sections.

**J. Two surfaces, same writes.** The nested editor is used both as an all-steps **overview/editor** and, step-by-step, **during a live run** (the run is genuinely per-step / per-submodule). Edit + Clone are legitimate in both; a clone during a run persists to the **template** (per E's save-scope), not just that run instance.

---

## 1. Tech & design system
- **Tailwind CSS v4** (`tailwindcss ^4.1.18`, utility classes). **No component library** — every control is hand-rolled with Tailwind utilities. The card UI must match by composing the same utility classes, not by importing a kit.
- **State:** `@tanstack/react-query` v5 for server state + mutations (the `updateMutation` → `api.updateTemplate(id, { execution_plan })` PUT); **Zustand** (`useAppStore`) for UI toasts (`showToast(msg, 'success'|'error')`). React Router v7.
- **Font:** `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`. Page bg `#f9fafb` (gray-50), text `#111827` (gray-900).

## 2. Design tokens (exact)
| Token | Value | Use |
|---|---|---|
| **Primary accent** | `sky-600 #0284c7` → hover `sky-700` | every editor button + focus ring (`focus:ring-2 focus:ring-sky-500`) |
| Option-editor accent | teal `#0891B2` | `SubmoduleOptions` input focus/checkbox (`focus:border-[#0891B2]`) — inherited as-is when you reuse it |
| Pause/info accent | `blue-600` / `blue-50` / `blue-200` / `blue-700` | pause chips, pause checkboxes |
| Error | `red-500 #ef4444` | required asterisk, inline errors, remove-hover |
| Warning | `amber-600` | non-blocking warnings |
| Neutral surfaces | white card on `gray-50` page; borders `gray-200`; sub-dividers `gray-100` | |
| Text scale | `gray-900` titles · `gray-700` sub-headers · `gray-600` labels · `gray-400`/`gray-500` meta/helper | |
| (theme extras, mostly unused in editor) | `teal-500 #0891B2`, `pink-500 #E11D73` (approve), `brand-600 #0284c7` | |
| Radii | cards/inputs `rounded-lg`; chips/small controls `rounded` | |

## 3. Layout & structure patterns (exact classes)
- **Page shell:** `max-w-2xl mx-auto`. Page title row: `flex items-center justify-between mb-6` → `<h2 class="text-lg font-semibold text-gray-900">`.
- **Section card** (every section is one): `bg-white border border-gray-200 rounded-lg p-4 mb-4`.
- **Section header:** `text-sm font-semibold text-gray-900 mb-3` + an inline count chip `<span class="text-gray-400 font-normal ml-1 text-xs">(N cards)</span>`.
- **Helper line:** `text-[10px] text-gray-400 mb-2`.
- **Sub-section divider** (within a card): `pt-3 border-t border-gray-100 mt-4` then `<h4 class="text-xs font-medium text-gray-700 mb-2">`.
- **Vertical rhythm:** lists `space-y-3` (entries) / `space-y-1` (rows); empty state `text-xs text-gray-400`.

## 4. Interaction idiom library (extend these — don't invent)
- **Removable chip:** `inline-flex items-center gap-0.5 text-[10px] bg-white border border-gray-200 rounded px-1.5 py-0.5 text-gray-600` + `&times;` button `text-gray-400 hover:text-red-500 ml-0.5`. (Pause variant: `bg-blue-50 border-blue-200 text-blue-700`.)
- **Add-via-dropdown** (the canonical "add" affordance): a `<select>` whose first option is `+ add...`, classes `text-[10px] border border-gray-200 rounded px-1 py-0.5 text-gray-500 bg-white`; once a value is chosen, an **Add** button appears: `text-[10px] px-1.5 py-0.5 bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-50`.
- **Expandable item row** (THE pattern for a card — see §6 gold): outer `border border-gray-200 rounded-lg`; clickable header `flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-gray-50`; left = name `text-xs font-medium text-gray-800` + meta `text-[10px] text-gray-400 ml-2`; right = `Remove` button `text-[10px] text-gray-400 hover:text-red-500` + caret `▼`/`▶` `text-gray-400 text-xs`. Expanded body: `border-t border-gray-200 px-3 py-2 space-y-2`.
- **Per-option editor — reuse `SubmoduleOptions`** (`client/src/components/primitives/SubmoduleOptions.tsx`): give it `options={manifest.options}`, `values`, `onChange(name,val)`, `submoduleId`, `projectId=""`. It renders every option type (select / boolean / number / textarea / text / json (form↔raw toggle) / doc_selector / file_upload) with consistent styling (input: `w-full bg-white border border-gray-300 rounded px-3 py-2 text-gray-900 text-sm focus:border-[#0891B2]`; label `text-xs text-gray-600 mb-1`; desc `text-[10px] text-gray-400 mt-1`; json error `text-[10px] text-red-500`). **The round-override editor IS this primitive** — a round's overrides are exactly a `Record<string,unknown>` of submodule options.
- **Number commit-on-blur** (`ThresholdInput`): local state, save on blur or Enter (not per keystroke) — reuse for any numeric card field to avoid a PUT per keystroke.
- **Checkbox:** `<label class="flex items-center gap-1.5 cursor-pointer">` + `<input type="checkbox" class="accent-sky-600">` + `text-[10px] text-gray-600`.
- **Primary button (small):** `px-3 py-1.5 text-xs bg-sky-600 text-white rounded hover:bg-sky-700 disabled:bg-gray-300`. (Large: `px-4 py-2 rounded-lg text-sm font-medium`.)
- **Save-when-dirty:** the "Save X" button renders **only** when `dirty` (computed `JSON.stringify(local) !== JSON.stringify(saved)`). On click → parent `onSave(execution_plan)` → `updateMutation.mutate({ execution_plan })` → on success: invalidate `['template', id]`/`['templates']` + success toast. Lean-persist convention (PresetMapEntry): store only values that differ from defaults.
- **Validation-error display:** inline `text-[10px] text-red-500 mt-1` (errors) and `text-[10px] text-amber-600 mt-0.5` (warnings). **Server-side** 400s surface as a **red toast** via `apiFetch` → React Query `onError`. ⚠️ The toast currently shows only the top-level `error` string ("Invalid execution_plan"), **NOT** the §9 `details[]` array. Surfacing the §9 `details[]` inline is a worthwhile design improvement (the new rules produce specific, user-fixable messages) — flagged, not mandated.

## 5. Save-flow & dirty-tracking summary
- Two save cadences exist; pick per control: **immediate-save** (ExecutionPlanSection saves on every chip add/remove via `onSave`) vs **batched dirty-save** (PresetMapEntry/CardsSection/RoutingRulesSection hold local state, show a "Save" button only when dirty). The card editor should use **batched dirty-save** for the round-overrides body (avoid a PUT per keystroke) and may use immediate-save for structural add/remove/route-toggle.
- Every save routes through **one** `updateMutation.mutate({ execution_plan })`. This is where the **atomic dual-write** contract lives: the UI hands a fully-formed `execution_plan` built by `cardPlanEditor.ts` (one immutable transform of both `card_definitions` and `submodules_per_step`), never two separate saves.

## 6. The repoint targets — current state (what Step 2 rewrites)
All three are rendered in the editor at `TemplateEditor.tsx:151-165`, each as a `bg-white border ... rounded-lg p-4 mb-4` section. **CardsSection and RoutingRulesSection are today RAW JSON `<textarea>` editors** writing the legacy/dead shape — that's the whole reason for the rewrite.

| Section | Lines | Current control | Step-2 action |
|---|---|---|---|
| **CardsSection** | 743-808 | `<textarea>` (`font-mono text-[11px]`) editing `plan.cards` (human-name-keyed legacy); client warn on missing `submodule_id`/`step`; "Save Cards" when dirty | **Replace** with a structured per-card editor (extend the §6-gold PresetMapEntry pattern). Emit `card_definitions` (UUID-keyed) via `cardPlanEditor.addCard`. Delete the @deprecated `LegacyCardDefinition` type. |
| **RoutingRulesSection** | 812-887 | `<textarea>` editing `plan.routing_rules` (object `{target_cards}` legacy); shows `FAILURE_TYPES` chips (`hallucination:fail`, `citation:fail`, `keyword:fail`, `meta:fail`, `structural:fail`); warn on unknown card name; "Save Routing Rules" when dirty | **Replace** with a structured `"<check>:fail" → card(s)` mapper; emit array-form `routing_rules` (`RoutingTarget[]`) via `cardPlanEditor.setRoutingTargets`. The `FAILURE_TYPES` list is the canonical set of rule keys. |
| **EscalationRulesSection** | 891-947 | `<textarea>` editing `plan.escalation_rules` | **KEEP UNTOUCHED (correction 2026-07-03, see §0.G).** `escalation_rules` is **step-keyed** (steps 2/4), not round-keyed; the 2026-07-01 "now in scope / per-round inputs" note was a design error. Gates fire at steps 2/4 with a live consumer; the textarea is literal-byte-safe (preserves `_comment` + field order). **Item 9 does NOT touch this section.** A structured *step-keyed* editor is a separate future item with its own review. |

## 7. Gold patterns to extend (explicit mapping)
- **A card row** = `PresetMapEntry` (TemplateEditor.tsx:313-425): an expandable bordered row with a name + meta header, a Remove button, and an expanded body that hosts `SubmoduleOptions` + a dirty "Save". For the card editor the header carries **card_name** (editable) + submodule + step + a Round-1/retry indicator; the body hosts **round tabs/sections** (1-4), each a `SubmoduleOptions` over that round's sparse overrides.
- **Adding a card / placing a Round-1 card / picking routing targets** = the **dropdown-`+ add...`-then-Add** idiom (ExecutionPlanSection:560-581) + removable **chips** (548-559). "Clone a submodule into a card" = pick submodule from the add-dropdown → `addCard`.
- **Failure-type → card mapping** = `FAILURE_TYPES` chips (851) as the rule rows; each row gets the dropdown-add to attach `card_definitions` entries as `RoutingTarget`s.

## 8. Genuinely-new interaction (no existing idiom — design must introduce, flag as invention)
- **Reorder.** Item 16 says "add/remove/**reorder**", and **the editor has NO reorder idiom anywhere** (no drag-handle, no up/down). **DECIDED (2026-07-01): up/down arrow buttons** matching the chip/▼ button styling — NOT drag (the editor has zero drag interactions; a drag handle would be the only one). Running order = the `submodules_per_step` array order. Do not defer.
- **Round tabs (1-4)** within a **single card's Edit body** — for editing THAT card's per-round sparse overrides. Closest precedent is expand/collapse; tabs are mild invention. Keep them in the existing type scale (`text-[10px]`/`text-xs`). **Distinct from the step-level Run 1–4 tabs (§0.D)**, which show *which cards are active per run* across the whole step — different granularity: step-level = which cards run; card-level = that card's round overrides.
- **Round-1 vs retry-only toggle** — maps to a *data* fact (is the card_id in `submodules_per_step`?), so it's a single control whose flip drives the atomic dual-write. No existing single-control-drives-two-keys precedent; design it explicitly and route through `cardPlanEditor` (never two saves).
- **Sparse-diff affordance for rounds 2-4** — must read visually as "only what differs from round 1," not a full config (contract 5). No existing precedent for a diff-style option editor; design a clear "inherits round 1 except…" framing.

---

## 9. FIXED DATA CONTRACT (the design must emit exactly this — from Step 1)

The UI builds an `execution_plan` and PUTs it via `api.updateTemplate(id, { execution_plan })`.
**Always construct it with `client/src/api/cardPlanEditor.ts`** (the atomic dual-write owner) —
never hand-assemble JSON. Types are in `client/src/types/step.ts`.

### card_definitions (§1.2) — UUID-keyed
```jsonc
"card_definitions": {
  "<uuid>": {
    "card_name": "content-writer-v2",     // display only; identity is the UUID key
    "submodule_id": "content-writer",       // registered submodule
    "step": 5,                              // == its submodules_per_step placement step
    "rounds": {                            // STRING keys "1".."4"; "1" always present; ≤4
      "1": {},                             // sparse override bag (any submodule option is just a key:
      "2": { "temperature": 0.3, "prompt": "stricter citation rules" }  //  prompt/ai_model/… live HERE)
    },
    "description": "optional note"
  }
}
```
- A **Round-1 card** also appears (by its `card_id`) in `submodules_per_step[step]`. A **retry-only card** appears in `card_definitions` only. `cardPlanEditor.addCard(plan, input, { round1 })` does both writes atomically.
- There is **no** `options_overrides`/`prompt_overrides` object — overrides are bare keys inside `rounds[N]`.

### routing_rules (§2.1) — array form
```jsonc
"routing_rules": {
  "citation:fail": [ { "step": 5, "card_id": "<uuid>" } ],
  "hallucination:fail": [ { "step": 5, "card_id": "<uuid>" } ]
}
```
- Key = `"{qa_check}:fail"`; value is **directly the array** of `{ step, card_id }` (NOT `{target_cards:[…]}`). Build with `cardPlanEditor.setRoutingTargets(plan, "citation:fail", targets)`.

### §9 save-validation (server `validateExecutionPlan`; a violation → HTTP 400 `{error, details[]}`)
1 card_id is a valid UUID · 2 submodule_id present + registered · 3 step is an integer · 4 rounds is an object · 5 round "1" present · 6 round keys ∈ {1,2,3,4} · 7 ≤ 4 rounds · 8 every UUID in submodules_per_step ∈ card_definitions · 9 card.step == placement step · 10 every routing card_id ∈ card_definitions · 11 every routed card has a round > 1 · **12 legacy `cards` key rejected** · **13 routing_rules values must be arrays of `{step, card_id}`** (legacy `{target_cards}` rejected).
- The UI should prevent these client-side where it can (UUID minting, round-1 always present, can't route to a round-1-only card, can't place a card at the wrong step) and surface the server `details[]` for anything that slips through.

### The editor API the UI calls (`cardPlanEditor.ts`)
`mintCardId()` · `addCard(plan, {card_name,submodule_id,step,rounds,description?}, {round1})→{plan,cardId}` · `removeCard(plan,cardId)` (cascades to submodules_per_step + routing_rules) · `setRoutingTargets(plan,failKey,targets[])` · `setCardRounds(plan,cardId,rounds)`. All pure/immutable; the UI makes **one** PUT with the returned plan.

---

## Summary for the design pass
Extend the existing template editor's **look** (white section cards, sky-600 controls, chips + dropdown-add, the expandable `PresetMapEntry` row hosting `SubmoduleOptions`, batched dirty-save → one PUT) into the **nested step-based model of §0**: one surface, submodules grouped under their step (greyed until activated), each row carrying data-op glyph + **Edit** + **Clone** + reorder arrows, variants inset+badged under their parent, **Run 1–4 tabs** at step level, routing wired as `"<check>:fail" → target card` (§0.F). Replace the **two dead** raw-JSON textareas — Cards and Routing — with structured controls that emit the §9-valid canonical shapes via `cardPlanEditor`. **Escalation stays a textarea, UNTOUCHED** (step-keyed, live consumer, literal-byte-safe — §0.G correction 2026-07-03). Item 9 = delete `CardsSection` + `RoutingRulesSection` + `LegacyCardDefinition` + ship validator rules 12-13 in the same deploy (NO escalation change). Invent only: reorder (up/down arrows, decided), round tabs, the round-1/retry toggle, and the sparse-diff framing. **Stub** the global-save option (Item 37). **Do not build** the non-linear graph flow (Item 36) — keep the routing seam generic so it extends later.
