# Card-write enablement — Step 1 locked contracts

Schema-correction pre-flight for the card-authoring UI (items 16/17). These 8 contracts are
**locked** — Step 2 (the card UI, built in Claude Design as an extension of the existing
template editor) consumes them as fixed, not as decisions to re-make.

**Source of truth = the deployed runtime** (`server/services/routingHandler.js`,
`executionPlanUtils.js`) + the live `30 april` template, verified 2026-06-30. These shapes
intentionally diverge from PHASE_3B's abstract §1 schema; the runtime wins.

Canonical shape (runtime-faithful):
- `card_definitions`: UUID-keyed → `{ card_name, submodule_id, step, rounds, description? }`,
  `rounds` = string-keyed `{ "1": {...}, "2"?: {...}, ... }` sparse override bags (round "1" always present).
- `routing_rules`: `{ "<qa_check>:fail": [ { step, card_id } ] }` (array form — NOT `{target_cards}`).
- overrides (prompt/model/temperature/…) are plain keys inside `rounds[N]`; there is no separate `options_overrides`/`prompt_overrides` object.

---

### 1. card_id generation site — **client-side at clone time**
- **Mechanism:** `mintCardId()` = `crypto.randomUUID()` in `client/src/api/cardPlanEditor.ts`; `addCard()` mints once and returns the id for reuse in routing targets. No server mint endpoint.
- **Why:** spec §1.2 ("Generated on card creation"); the UUID is the card's stable identity, rename changes `card_name` only.
- **Locked in:** `cardPlanEditor.ts` (`mintCardId`, `addCard`) + `cardPlanEditor.test.ts`.

### 2. Atomic `card_definitions` + `submodules_per_step` dual-write — **single-owner immutable reducer**
- **Hazard (Gemini elevated):** a card touches TWO plan keys — `card_definitions[cardId]` (always) and `submodules_per_step[step]` (Round-1 cards only) — in two vocabularies (UUIDs vs submodule-id strings). Two independent editors mutating the one `submodules_per_step` array corrupts the plan.
- **Mechanism:** `cardPlanEditor.ts` is the **sole writer** of both keys. Every function takes the whole plan and returns a NEW whole plan with both keys updated in one immutable transform; the UI then makes **one** `api.updateTemplate(id, { execution_plan })` PUT. The UI must never `setState`+save the two keys on independent paths — always route through the editor. Round-1 card → both keys; retry-only card → `card_definitions` only.
- **Locked in:** `cardPlanEditor.ts` (`addCard`/`removeCard`/`setRoutingTargets`/`setCardRounds`) + tests (atomic dual-write, immutability, remove-cascade).

### 3. `cards` → `card_definitions` migration of existing templates — **hard-reject legacy, no data migration**
- **Decision:** the corrected validator rejects the legacy `cards` key and object-form `routing_rules`; **no data migration is needed.**
- **Why:** migration surface is **empty** — verified 2026-06-30 that **0 of 28** prod templates carry `cards`; the only card template (`30 april`) is already canonical. The dead UI's legacy output was never persisted. The orphan `cards` key can never enter the DB because the save gate now 400s on it.
- **Locked in:** `executionPlanUtils.js` rules 12-13 + `cardPlanRoundTrip.test.js` + the prod-query evidence above.

### 4. Routing-lifecycle observability (Gemini's 8th) — **spec locked now; implements with the routing deploy**
- **Why first-class:** routing already failed *ambiguously* in prod (runs `78c9644d`/`7ea66af7` halted on a content-analyzer worker timeout, indistinguishable from a routing failure).
- **Required (the contract):** every routing decision emits, per loop:
  - a structured log line: `[routing] run=… entity=… <check>:fail → card=<id>(<name>) step=N round=R decision=<routed|flagged|approved|failed> reason=…`
  - the per-entity `entity_run_meta.card_instructions` record (`status` pending|consumed|skipped, `skipped_reason`, `trigger`) — queryable per run.
  - the run-level rollup already in `AutoExecuteState.routing_events` `{loop, earliest_step, routed, approved, failed, flagged, timestamp}` — KEEP, but it is insufficient alone (can't tell "routed+retried" from "worker died").
- **Status:** partial infra exists (`routing_events` type, `card_instructions` column). The per-decision line + reason taxonomy land in the routing code that ships in the card-write bundle. Tracked here so it is not an afterthought.

### 5. Sparse rounds 2-4 editing semantics — **round N is a diff over round 1**
- **Decision:** `rounds[N]` is a SPARSE diff, merged shallowly at execution (`{ ...baseOptions, ...rounds[N] }`, `submoduleRuns.js`); to undo a round-1 override, round N must explicitly set the value back.
- **Mechanism / locked in:** `CardRounds` + `CardRoundOverrides` in `step.ts` ('1' required, '2'–'4' optional, each an open record). The UI (Step 2) must render rounds 2-4 as explicit diffs, never as full configs.

### 6. `card_name` uniqueness — **not unique; UI disambiguates**
- **Decision:** `card_name` is cosmetic; identity is always `card_id`. Names are NOT required unique and the validator does not check them. The routing-target picker (Step 2) renders `card_name (short-uuid)` when names collide (or soft-warns on duplicates).
- **Locked in:** `step.ts` (`card_name` typed required-for-UI-hygiene, documented runtime-optional). Presentation is Step 2's design.

### 7. In-flight run snapshot on template edit — **edits never affect running pipelines**
- **Decision:** editing a template's cards does not affect in-flight runs. Each run froze `pipeline_runs.execution_plan_snapshot` at launch; `routingHandler` reads the snapshot's `card_definitions`, not the live template.
- **Mechanism:** existing snapshot infra (snapshot written at run start). The Step-1 requirement — the snapshot must carry `card_definitions` — is satisfied because the corrected UI writes `card_definitions` (the prior latent risk, a snapshot carrying legacy `cards` the runtime ignored, is closed).
- **Locked in:** existing snapshot infra + the corrected types guaranteeing the right shape is what gets snapshotted.

### 8. Client TS type rewrite — **canonical replaces legacy; legacy kept @deprecated until Step 2**
- **Decision:** `step.ts` now encodes the canonical shapes; legacy types are `@deprecated` and deleted in Step 2 with the dead-section repoint.
- **Mechanism:** added `CardDefinition` (new), `CardRounds`, `CardRoundOverrides`, `RoutingTarget`; `routing_rules` → `RoutingTarget[]`; `cards` → `@deprecated LegacyCardDefinition`; `RoutingRule` → `@deprecated LegacyRoutingRule`.
- **Blast radius (measured):** only `TemplateEditor.tsx` reads these typed — `plan.cards` (deprecated type keeps it compiling) and `rule.target_cards` (reads from a local `JSON.parse`, not the typed field — unaffected by the `routing_rules` change). `tsc -b`: **0 new errors** (13 pre-existing, unrelated).
- **Locked in:** `step.ts` + the tsc baseline comparison.

---

## Artifacts produced (Step 1)
1. `client/src/types/step.ts` — corrected canonical types (artifact #1).
2. `client/src/api/cardPlanEditor.ts` (+ `.test.ts`) — atomic API-client builders (artifact #2; locks contracts 1, 2).
3. `server/services/cardPlanRoundTrip.test.js` — round-trip + 400 test (artifact #3); `executionPlanUtils.js` rules 12-13 close the validator-passes-legacy gap.

## DEPLOY GATE (from the Step-1 independent review — must hold before this ships)
The validator gap-close (rules 12-13) is **committed-not-deployed**. It must NOT reach production
on its own, because the still-rendered legacy `CardsSection`/`RoutingRulesSection`
(TemplateEditor.tsx) will then **HTTP 400 on save** — and a template that already carries a `cards`
key would 400 even on an unrelated Routing-Rules save (its `onSave({ ...plan, ... })` spread
re-sends `plan.cards`, re-tripping rule 12). This is a UX regression, not a corruption risk
(0/28 prod templates carry `cards`; nothing is deployed yet). **Gate:** Step 1 (validator + types)
and Step 2 (delete/repoint those two sections) ship in the SAME release — OR Step 2 disables/hides
the two sections. Do not deploy the validator change before one of those is true.

Two review INFO notes (no action; documented so they aren't re-discovered as bugs): a top-level
`cards`/`routing_rules` that is itself an *array* passes the validator (runtime-inert, editor never
produces it); and a Round-1 card defined but absent from `submodules_per_step` passes (the editor
guarantees the dual-write; the validator only backstops the dangerous direction — a reverse rule
would wrongly reject legitimately-unplaced retry-only cards).

## Verification
- `npm test` → 115/115 (incl. 7 new round-trip tests). `validateExecutionPlan.test.js` 21/21 (no regression).
- `node --test client/src/api/cardPlanEditor.test.ts` → 7/7 (incl. editor-output-accepted-by-real-validator cross-check).
- `tsc -b` → 0 new errors vs HEAD baseline.
- Real Postgres JSONB round-trip (Supabase MCP, scratch row, self-deleted): `jsonb_intact: true`, array-form routing read back exactly.
