import { useState } from 'react';
import type { CategoryGroups, SubmoduleManifest, SubmoduleLatestRunMap, SubmoduleConfig, CardDefinition, TemplateExecutionPlan } from '../../types/step';
import { usePanelStore } from '../../stores/panelStore';
import { useAppStore } from '../../stores/appStore';
import { useTemplatePlan, useTemplateCardMutation } from '../../hooks/useTemplatePlan';
import {
  ROUND_TABS, cardRound, cardsForSubmodule, cardsAt, cardIsRound1, cardRoutingInfo, cardIsDormant,
  submoduleActiveInRound, activeInOtherRounds, placedEntriesForStep,
} from '../../api/cardPlanView';
import { addCard, removeCard, setLegacyPlacement, moveEntryInStep } from '../../api/cardPlanEditor';

const DATA_OP_OPTIONS = ['add', 'remove', 'transform'] as const;
const DATA_OP_ICONS: Record<string, string> = {
  add: '➕',
  remove: '➖',
  transform: '＝',
};

interface CategoryCardGridProps {
  categories: CategoryGroups;
  latestRuns?: SubmoduleLatestRunMap;
  configMap?: Record<string, SubmoduleConfig>;
  onDataOperationChange?: (submoduleId: string, op: 'add' | 'remove' | 'transform') => void;
  /** Template whose cards render as variant rows inset under their submodule. Omit for single_run. */
  templateId?: string | null;
  /** The pipeline step this grid renders — cards live at (submodule, step, round). */
  stepIndex: number;
}

export function CategoryCardGrid({ categories, latestRuns = {}, configMap = {}, onDataOperationChange, templateId, stepIndex }: CategoryCardGridProps) {
  const { openSubmodulePanel, openVariantPane, openCloneDialog } = usePanelStore();
  const showToast = useAppStore((s) => s.showToast);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [activeRound, setActiveRound] = useState(1);
  const { data: template } = useTemplatePlan(templateId);
  const plan: TemplateExecutionPlan = template?.execution_plan ?? {};
  const cardMutation = useTemplateCardMutation(templateId);
  const cardsEnabled = !!templateId; // card editing needs a template (single_run has none)

  const savePlan = (next: TemplateExecutionPlan, msg: string, after?: () => void) =>
    cardMutation.mutate(next, { onSuccess: () => { showToast(msg, 'success'); after?.(); } });

  const removeVariant = (cardId: string) => savePlan(removeCard(plan, cardId), 'Variant removed');
  const moveEntry = (entry: string, dir: -1 | 1) => savePlan(moveEntryInStep(plan, stepIndex, entry, dir), 'Reordered');

  // Base-row toggle. The checkbox is DISABLED whenever a named card already occupies this
  // (submodule, step, round) — that activation is owned by the variant row's Remove — so each branch
  // below is reachable and unambiguous. Round 1 = a bare legacy placement (first pass, default
  // config); Round ≥ 2 = a default routing-only card (dormant until routed — V6-§2.5 item 4/8).
  const toggleBase = (sub: SubmoduleManifest, on: boolean) => {
    if (activeRound === 1) {
      savePlan(setLegacyPlacement(plan, stepIndex, sub.id, on), on ? 'Runs in Round 1' : 'Removed from Round 1');
      return;
    }
    // Round ≥ 2: only ON is reachable (OFF is disabled once a card exists — removed via its row).
    if (on) {
      const { plan: next, cardId } = addCard(
        plan,
        { card_name: `${sub.id}-r${activeRound}`, submodule_id: sub.id, step: stepIndex, round: activeRound, overrides: {} },
        { round1: false },
      );
      savePlan(next, `Active in Round ${activeRound} (dormant until routed)`, () => openVariantPane(cardId));
    }
  };

  // Sort categories in logical pipeline order (not alphabetical/load order)
  const CATEGORY_ORDER: Record<string, number> = {
    website: 1, crawling: 2, search: 3, news: 4, filtering: 5, scraping: 6, analysis: 7,
    planning: 8, generation: 9, seo: 10, review: 11, qa: 12,
    formatting: 13, bundling: 14, media: 15, data: 16, testing: 17,
  };
  const categoryEntries = Object.entries(categories).sort(
    ([a], [b]) => (CATEGORY_ORDER[a] ?? 99) - (CATEGORY_ORDER[b] ?? 99)
  );

  if (categoryEntries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center">
        <p className="text-gray-400 text-sm">No submodules available for this step</p>
      </div>
    );
  }

  // Empty-round info line (S3.3): the active round tab has NO active submodule in this step.
  const allSubs = Object.values(categories).flat();
  const roundIsEmpty = cardsEnabled && activeRound > 1 &&
    !allSubs.some((s) => submoduleActiveInRound(plan, s.id, stepIndex, activeRound));

  return (
    <div className="mb-4">
      {/* Round tabs (S2.1 — fixed 1..4; label is "Round", never "Run" per S3.1) */}
      {cardsEnabled && (
        <div className="flex items-center gap-1 mb-3">
          {ROUND_TABS.map((n) => (
            <button
              key={n}
              onClick={() => setActiveRound(n)}
              className={`px-3 py-1 text-xs rounded ${activeRound === n ? 'bg-sky-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              Round {n}
            </button>
          ))}
          <span className="text-[10px] text-gray-400 ml-2">
            {activeRound === 1 ? 'first pass (placed)' : 'retry / escalation (routing-only)'}
          </span>
        </div>
      )}

      {/* Empty-round info line (S3.3 — verbatim; flag-and-continue, V6-§3) */}
      {roundIsEmpty && (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-3 mb-3">
          <p className="text-xs text-gray-500">
            No variants run on this pass — entities escalating here are flagged for review and continue.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {categoryEntries.map(([catKey, submodules]) => {
          const isExpanded = expandedCategory === catKey;

          return (
            <div
              key={catKey}
              className={`rounded-lg border transition-all ${
                isExpanded
                  ? 'border-dashed border-2 border-sky-400 bg-white'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              {/* Category Header */}
              <div
                className="p-3 cursor-pointer"
                onClick={() => setExpandedCategory(isExpanded ? null : catKey)}
              >
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-gray-800 capitalize">{catKey}</p>
                </div>
                <p className="text-[10px] text-gray-500 mt-1">
                  {submodules.length} submodule{submodules.length !== 1 ? 's' : ''}
                </p>
              </div>

              {/* Inline Submodules (shown when expanded) */}
              {isExpanded && (
                <div className="border-t border-gray-200">
                  <p className="text-[10px] text-gray-500 font-medium uppercase px-3 pt-2">
                    Submodules
                  </p>
                  <div className="p-2 space-y-1">
                    {submodules.map((sub) => {
                      const savedOp = configMap[sub.id]?.data_operation;
                      const currentOp = savedOp || sub.data_operation_default;
                      // Variant rows (named cards) for this submodule at THIS step. Round-1 cards render
                      // in submodules_per_step array order (INV-ORDER); the rest by round then name.
                      const variants = cardsEnabled ? orderedVariants(plan, sub.id, stepIndex) : [];
                      const activeHere = cardsEnabled && submoduleActiveInRound(plan, sub.id, stepIndex, activeRound);
                      const hasCardHere = cardsEnabled && cardsAt(plan, sub.id, stepIndex, activeRound).length > 0;
                      const otherRounds = cardsEnabled && !activeHere
                        ? activeInOtherRounds(plan, sub.id, stepIndex, activeRound)
                        : [];

                      return (
                        <div key={sub.id}>
                        <SubmoduleRow
                          submodule={sub}
                          categoryKey={catKey}
                          onOpen={openSubmodulePanel}
                          latestRun={latestRuns[sub.id]}
                          currentDataOp={currentOp}
                          docCount={
                            configMap[sub.id]?.options
                              ? Object.values(configMap[sub.id].options!).reduce<number>(
                                  (sum, v) => sum + (Array.isArray(v) ? v.length : 0), 0)
                              : 0
                          }
                          onCycleDataOp={
                            onDataOperationChange
                              ? () => {
                                  const idx = DATA_OP_OPTIONS.indexOf(currentOp as typeof DATA_OP_OPTIONS[number]);
                                  const next = DATA_OP_OPTIONS[(idx + 1) % DATA_OP_OPTIONS.length];
                                  onDataOperationChange(sub.id, next);
                                }
                              : undefined
                          }
                          cardsEnabled={cardsEnabled}
                          activeRound={activeRound}
                          activeInRound={activeHere}
                          toggleDisabled={hasCardHere}
                          activeInOtherRounds={otherRounds}
                          onToggle={(on) => toggleBase(sub, on)}
                          onClone={() => openCloneDialog(sub.id, stepIndex, activeRound)}
                          pending={cardMutation.isPending}
                        />
                        {variants.map((v) => (
                          <VariantRow
                            key={v.cardId}
                            plan={plan}
                            cardId={v.cardId}
                            card={v.card}
                            activeRound={activeRound}
                            isRound1={cardIsRound1(plan, v.cardId)}
                            routing={cardRoutingInfo(plan, v.cardId)}
                            dormant={cardIsDormant(plan, v.cardId)}
                            onOpen={() => openVariantPane(v.cardId)}
                            onRemove={() => removeVariant(v.cardId)}
                            onMove={(dir) => moveEntry(v.cardId, dir)}
                            removing={cardMutation.isPending}
                          />
                        ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Variant cards for a submodule at a step, ordered for display: Round-1 placed cards in
 *  submodules_per_step array order (INV-ORDER, V6-§4 — the two-clones case), then the rest by round
 *  then card_name. */
function orderedVariants(
  plan: TemplateExecutionPlan,
  submoduleId: string,
  step: number,
): Array<{ cardId: string; card: CardDefinition }> {
  const cards = cardsForSubmodule(plan, submoduleId).filter(({ card }) => card.step === step);
  const order = placedEntriesForStep(plan, step);
  return [...cards].sort((a, b) => {
    const ra = cardRound(a.card), rb = cardRound(b.card);
    const pa = order.indexOf(a.cardId), pb = order.indexOf(b.cardId);
    if (pa >= 0 && pb >= 0) return pa - pb;       // both placed → authored array order (INV-ORDER)
    if (pa >= 0) return -1;                        // placed before unplaced
    if (pb >= 0) return 1;
    if (ra !== rb) return ra - rb;                // then by round
    return (a.card.card_name || '').localeCompare(b.card.card_name || '');
  });
}

function SubmoduleRow({
  submodule,
  categoryKey,
  onOpen,
  latestRun,
  currentDataOp,
  docCount = 0,
  onCycleDataOp,
  cardsEnabled,
  activeRound,
  activeInRound,
  toggleDisabled,
  activeInOtherRounds,
  onToggle,
  onClone,
  pending,
}: {
  submodule: SubmoduleManifest;
  categoryKey: string;
  onOpen: (submoduleId: string, categoryKey: string) => void;
  latestRun?: { status: string; result_count: number; approved_count: number; progress: { current: number; total: number; message: string } | null; error?: string | null; mode?: 'per_entity'; entity_count?: number; completed_count?: number };
  currentDataOp: string;
  docCount?: number;
  onCycleDataOp?: () => void;
  cardsEnabled: boolean;
  activeRound: number;
  activeInRound: boolean;
  toggleDisabled: boolean;
  activeInOtherRounds: number[];
  onToggle: (on: boolean) => void;
  onClone: () => void;
  pending: boolean;
}) {
  const opIcon = DATA_OP_ICONS[currentDataOp] || '＝';
  const isActive = submodule.active !== false;
  const greyed = cardsEnabled && !activeInRound;

  return (
    <div
      className={`flex items-center justify-between p-2 rounded ${
        isActive
          ? `hover:bg-gray-50 cursor-pointer group ${greyed ? 'opacity-60' : ''}`
          : 'opacity-40 cursor-default'
      }`}
      onClick={isActive ? () => onOpen(submodule.id, categoryKey) : undefined}
    >
      <div className="flex items-center gap-2 min-w-0">
        {cardsEnabled && isActive && (
          <input
            type="checkbox"
            checked={activeInRound}
            disabled={pending || toggleDisabled}
            title={toggleDisabled ? 'Active via the variant below — remove it there' : activeInRound ? `Active in Round ${activeRound}` : `Activate in Round ${activeRound}`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onToggle(e.target.checked)}
            className="accent-sky-600 flex-shrink-0"
          />
        )}
        <button
          type="button"
          className="text-sm w-5 text-center hover:scale-125 transition-transform flex-shrink-0"
          title={`Data operation: ${currentDataOp} (click to change)`}
          onClick={(e) => {
            e.stopPropagation();
            if (isActive) onCycleDataOp?.();
          }}
          disabled={!isActive}
        >
          {opIcon}
        </button>
        <div className="min-w-0">
          <p className="text-sm text-gray-700 truncate">{submodule.name}</p>
          <p className="text-[10px] text-gray-400 truncate">{submodule.description}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Cross-round pill (S3.2b): greyed here, but active in another round of this step. */}
        {activeInOtherRounds.map((n) => (
          <span key={n} className="text-[10px] bg-sky-50 text-sky-600 px-1.5 py-0.5 rounded" title="This submodule has a card in another round of this step">
            Active in Round {n}
          </span>
        ))}
        {cardsEnabled && isActive && (
          <button
            onClick={(e) => { e.stopPropagation(); onClone(); }}
            disabled={pending}
            className="text-[10px] text-gray-400 hover:text-sky-600 disabled:opacity-40"
            title="Clone as a named variant"
          >
            Clone
          </button>
        )}
        {isActive ? (
          <>
            {docCount > 0 && (
              <span className="text-[10px] bg-teal-100 text-teal-700 px-1.5 py-0.5 rounded">
                {docCount} doc{docCount !== 1 ? 's' : ''}
              </span>
            )}
            <SubmoduleStatusBadge latestRun={latestRun} />
            <svg
              className="w-4 h-4 text-gray-400 opacity-50 group-hover:opacity-100"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </>
        ) : (
          <span className="text-[10px] text-gray-300 italic">inactive</span>
        )}
      </div>
    </div>
  );
}

// Variant (card) row — inset under its parent submodule. Exported so the Step-7 routed-variants
// list reuses the SAME row (same card, opens the same pane). Carries the REQUIRED [Round N] chip
// (S2.2/S3.2a — visible from every tab), the <- signal:fail back-reference, reorder arrows for the
// two-Round-1-clones case (S2.1), and the D9 [unreachable] amber (S3.4).
export function VariantRow({ plan, cardId, card, activeRound, isRound1, routing, dormant, onOpen, onRemove, onMove, removing }: {
  plan: TemplateExecutionPlan;
  cardId: string;
  card: CardDefinition;
  /** The round tab currently selected — this variant renders active only when it matches. Optional
   *  (the Step-7 routed-variants list passes none → always shown at full strength). */
  activeRound?: number;
  isRound1: boolean;
  routing: { routed: boolean; failKeys: string[] };
  dormant: boolean;
  onOpen: () => void;
  onRemove: () => void;
  /** Reorder within submodules_per_step (INV-ORDER). Omit where reordering doesn't apply. */
  onMove?: (dir: -1 | 1) => void;
  removing: boolean;
}) {
  const round = cardRound(card);
  const greyed = activeRound !== undefined && round !== activeRound;
  const canReorder = !!onMove && isRound1; // only placed (Round-1) entries have an array position

  return (
    <div
      className={`flex items-center justify-between pl-11 pr-2 py-1.5 rounded bg-[#fcfcfd] hover:bg-gray-50 cursor-pointer group ${greyed ? 'opacity-50' : ''}`}
      onClick={onOpen}
    >
      <div className="flex items-center gap-2 min-w-0">
        {canReorder && (
          <span className="flex flex-col leading-none" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => onMove!(-1)} disabled={removing} className="text-[8px] text-gray-300 hover:text-sky-600 disabled:opacity-30" title="Move earlier">▲</button>
            <button onClick={() => onMove!(1)} disabled={removing} className="text-[8px] text-gray-300 hover:text-sky-600 disabled:opacity-30" title="Move later">▼</button>
          </span>
        )}
        <span className="text-xs text-gray-700 truncate">{card.card_name}</span>
        {/* REQUIRED [Round N] chip — visible from every tab (S3.2a) */}
        <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${isRound1 ? 'bg-sky-50 text-sky-600' : 'bg-gray-100 text-gray-500'}`}>
          Round {round}
        </span>
        {/* Retry-only is optional/redundant (round ≥ 2 implies it) — kept for the mock's parity (S2.2). */}
        {round > 1 && (
          <span className="text-[10px] text-gray-400 flex-shrink-0">Retry-only</span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* <- signal:fail back-reference to the Step-7 routing rule (S2.2) */}
        {routing.routed && (
          <span className="text-[10px] text-sky-600" title={`routed by ${routing.failKeys.join(', ')}`}>← {routing.failKeys.join(', ')}</span>
        )}
        {/* D9 [unreachable] amber — scoped to a round ≥ 2 authored escalation card no rule targets (S3.4) */}
        {dormant && (
          <span className="text-[10px] bg-amber-100 text-amber-700 border border-amber-300 px-1.5 py-0.5 rounded" title="No routing rule reaches this escalation card — wire a QA failure in Step 7">
            unreachable
          </span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          disabled={removing}
          className="text-[10px] text-gray-400 hover:text-red-500 disabled:opacity-40"
        >
          Remove
        </button>
        <svg className="w-4 h-4 text-gray-400 opacity-50 group-hover:opacity-100" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </div>
    </div>
  );
}

function SubmoduleStatusBadge({ latestRun }: { latestRun?: { status: string; result_count: number; approved_count: number; progress: { current: number; total: number; message: string } | null; error?: string | null; mode?: 'per_entity'; entity_count?: number; completed_count?: number } }) {
  if (!latestRun) {
    return <span className="text-[10px] text-gray-300">idle</span>;
  }

  const isPerEntity = latestRun.mode === 'per_entity';

  switch (latestRun.status) {
    case 'pending':
      return <span className="text-[10px] text-amber-400">queued</span>;
    case 'running':
      return (
        <span className="flex items-center gap-1 text-[10px] text-sky-500">
          <span className="inline-block w-3 h-3 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
          {isPerEntity
            ? `${latestRun.completed_count || 0}/${latestRun.entity_count || 0} entities`
            : latestRun.progress
              ? `${latestRun.progress.current}/${latestRun.progress.total}`
              : 'running'}
        </span>
      );
    case 'completed':
      return (
        <span className="text-[10px] font-medium text-amber-500">
          {isPerEntity
            ? `${latestRun.entity_count || 0} entities`
            : `${latestRun.result_count} result${latestRun.result_count !== 1 ? 's' : ''}`}
        </span>
      );
    case 'approved':
      return (
        <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-500">
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
          {isPerEntity ? `${latestRun.entity_count || 0} entities` : latestRun.approved_count}
        </span>
      );
    case 'failed': {
      const errMsg = latestRun.error ? (latestRun.error.length > 30 ? latestRun.error.slice(0, 30) + '…' : latestRun.error) : 'failed';
      return (
        <span className="flex items-center gap-1 text-[10px] font-medium text-red-500" title={latestRun.error || 'Execution failed'}>
          <svg className="w-3 h-3 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          {errMsg}
        </span>
      );
    }
    default:
      return <span className="text-[10px] text-gray-300">idle</span>;
  }
}
