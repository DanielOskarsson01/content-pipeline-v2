# Card UI — Design-Context Package (for the Claude Design pass)

**Purpose.** Claude Design can't read this repo. This package is the portable reference so the
card-authoring UI (V5 items 16/17) is designed as an **extension of the existing template
editor**, not an invention. The design has **two fixed constraints and invents neither**:

1. **Visual + interaction patterns** — this document (extracted from `client/src/components/pages/TemplateEditor.tsx` + `client/src/components/primitives/SubmoduleOptions.tsx`, 2026-06-30).
2. **Data shapes** — the Step 1 contract (canonical `card_definitions` §1.2, array-form `routing_rules` §2.1, the §9 validation rules incl. the new 12-13). See the bottom section.

A static visual reference mock is at `docs/card-ui-reference-mock.html` (open in a browser / render in Claude Design — it reproduces the existing editor's look with the exact classes).

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
| **EscalationRulesSection** | 891-947 | `<textarea>` editing `plan.escalation_rules` | **DO NOT CHANGE.** This section is LIVE/correct (its consumer `autoExecutor.evaluateEscalationGate` matches). Out of scope. Shown only so the design doesn't accidentally restyle/remove it. |

## 7. Gold patterns to extend (explicit mapping)
- **A card row** = `PresetMapEntry` (TemplateEditor.tsx:313-425): an expandable bordered row with a name + meta header, a Remove button, and an expanded body that hosts `SubmoduleOptions` + a dirty "Save". For the card editor the header carries **card_name** (editable) + submodule + step + a Round-1/retry indicator; the body hosts **round tabs/sections** (1-4), each a `SubmoduleOptions` over that round's sparse overrides.
- **Adding a card / placing a Round-1 card / picking routing targets** = the **dropdown-`+ add...`-then-Add** idiom (ExecutionPlanSection:560-581) + removable **chips** (548-559). "Clone a submodule into a card" = pick submodule from the add-dropdown → `addCard`.
- **Failure-type → card mapping** = `FAILURE_TYPES` chips (851) as the rule rows; each row gets the dropdown-add to attach `card_definitions` entries as `RoutingTarget`s.

## 8. Genuinely-new interaction (no existing idiom — design must introduce, flag as invention)
- **Reorder.** Item 16 says "add/remove/**reorder**", but **the editor has NO reorder idiom anywhere** (no drag-handle, no up/down). This is invention, not extension — design a minimal one (e.g. up/down arrows matching the chip/▼ button styling) or defer reorder to a later pass. Don't assume a pattern exists.
- **Round tabs (1-4)** within a card body — closest precedent is the expand/collapse; tabs are mild invention. Keep them in the existing type scale (`text-[10px]`/`text-xs`).
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
Extend the existing template editor: white section cards, sky-600 controls, chips + dropdown-add, the expandable `PresetMapEntry` row hosting `SubmoduleOptions`, batched dirty-save → one PUT. Replace the two raw-JSON textareas (Cards, Routing) with structured controls that emit the §9-valid canonical shapes via `cardPlanEditor`. Invent only reorder, round tabs, the round-1/retry toggle, and the sparse-diff framing — and flag those as the new parts. Leave EscalationRulesSection alone.
