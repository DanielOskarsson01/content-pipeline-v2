import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePanelStore } from '../../stores/panelStore';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../api/client';
import type { ApiError } from '../../api/client';
import type { ProjectMode, TemplateExecutionPlan, SubmoduleManifest, RoutingTarget, CardDefinition } from '../../types/step';
import { useTemplatePlan, useTemplateCardMutation } from '../../hooks/useTemplatePlan';
import { setRoutingTargets, addRoutingTarget, createAndRoute, removeCard } from '../../api/cardPlanEditor';
import { FAILURE_TYPES, cardsForSubmodule, cardIsRound1, cardRoutingInfo, roundKeys, runEntries, availableRuns } from '../../api/cardPlanView';
import { VariantRow } from '../shared/CategoryCardGrid';

/**
 * Step-7 (Routing) body — replaces the generic CategoryCardGrid for step 7. Structured editor for
 * routing_rules (the dead RoutingRulesSection's replacement, living where operators work): one row
 * per QA failure type → target variant chips + "+ add target / create variant". Below: the routed-
 * variants list (reusing the item-4 VariantRow — same card, same pane). Top: view-only Run 1-4 tabs.
 * All writes go through cardPlanEditor → one useTemplateCardMutation PUT; never the run-scoped config.
 */
export function Step7RoutingBody({ templateId, projectMode }: {
  templateId?: string | null;
  projectMode?: ProjectMode;
}) {
  const { data: template } = useTemplatePlan(templateId);
  const { data: allSubmodules } = useQuery({ queryKey: ['submodules-full'], queryFn: api.getSubmodulesFull });
  const cardMutation = useTemplateCardMutation(templateId);
  const { openVariantPane } = usePanelStore();
  const showToast = useAppStore((s) => s.showToast);
  const [activeRun, setActiveRun] = useState(1);

  const plan: TemplateExecutionPlan = template?.execution_plan ?? {};
  const canEdit = !!templateId && projectMode !== 'single_run';
  const details = (cardMutation.error as ApiError | null)?.details;
  const rr = plan.routing_rules ?? {};

  const runs = availableRuns(plan);
  const displayRun = runs.includes(activeRun) ? activeRun : 1; // fall back when activeRun leaves availableRuns
  const activeEntries = runEntries(plan, displayRun);

  const ruleKeys = useMemo(() => [...new Set<string>([...FAILURE_TYPES, ...Object.keys(rr)])], [rr]);
  const cardName = (cardId: string) => plan.card_definitions?.[cardId]?.card_name ?? cardId.slice(0, 8);
  const versionOf = (cardId: string, submoduleId: string) => cardsForSubmodule(plan, submoduleId).findIndex((c) => c.cardId === cardId) + 2;

  const savePlan = (next: TemplateExecutionPlan, msg: string, after?: () => void) =>
    cardMutation.mutate(next, { onSuccess: () => { showToast(msg, 'success'); after?.(); } });

  const removeTarget = (failKey: string, targets: RoutingTarget[], cardId: string) =>
    savePlan(setRoutingTargets(plan, failKey, targets.filter((t) => t.card_id !== cardId)), 'Routing updated');
  const addExisting = (failKey: string, targets: RoutingTarget[], cardId: string) => {
    const card = plan.card_definitions?.[cardId];
    if (card) savePlan(addRoutingTarget(plan, failKey, targets, { step: card.step, card_id: cardId }), 'Target added');
  };
  const createVariant = (failKey: string, targets: RoutingTarget[], sub: SubmoduleManifest) => {
    const version = cardsForSubmodule(plan, sub.id).length + 2;
    const { plan: next, cardId } = createAndRoute(plan, { card_name: `${sub.id}-v${version}`, submodule_id: sub.id, step: sub.step }, failKey, targets);
    savePlan(next, 'Variant created + routed', () => openVariantPane(cardId));
  };

  const routedCards = useMemo(
    () => Object.entries(plan.card_definitions ?? {})
      .filter(([cardId]) => cardRoutingInfo(plan, cardId).routed)
      .map(([cardId, card]) => ({ cardId, card }))
      .sort((a, b) => (a.card.card_name || '').localeCompare(b.card.card_name || '')),
    [plan],
  );

  // ── single_run / no template → read-only ──
  if (!canEdit) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Routing</h3>
        <p className="text-[10px] text-gray-400 mb-3">Map QA failures to retry variants. <span className="text-amber-600">Save as Template first</span> to edit routing.</p>
        {Object.keys(rr).length === 0 ? (
          <p className="text-[10px] text-gray-300 italic">No routing rules.</p>
        ) : (
          <div className="space-y-1">
            {Object.entries(rr).map(([failKey, targets]) => (
              <div key={failKey} className="flex items-start gap-2 text-[10px]">
                <span className="font-mono text-gray-500 w-28 shrink-0">{failKey}</span>
                <span className="text-gray-600">{(Array.isArray(targets) ? targets : []).map((t) => cardName(t.card_id)).join(', ') || '—'}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {/* Run tabs (view-only) */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Runs</h3>
        <div className="flex items-center gap-1 mb-2">
          {runs.map((n) => (
            <button key={n} onClick={() => setActiveRun(n)} className={`px-2.5 py-1 text-xs rounded ${activeRun === n ? 'bg-sky-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>Run {n}</button>
          ))}
        </div>
        <p className="text-[10px] text-gray-400 mb-1">{displayRun === 1 ? 'Runs on the first pass:' : `Retry variants active on run ${displayRun}:`}</p>
        <div className="flex flex-wrap gap-1">
          {activeEntries.length === 0 && <span className="text-[10px] text-gray-300 italic">nothing</span>}
          {activeEntries.map((e) => (
            <span key={e.kind === 'card' ? e.cardId : e.submoduleId} className={`text-[10px] px-1.5 py-0.5 rounded ${e.kind === 'card' ? 'bg-sky-50 text-sky-700' : 'bg-gray-100 text-gray-500'}`}>
              {e.kind === 'card' ? e.card.card_name : e.submoduleId}
            </span>
          ))}
        </div>
      </div>

      {/* §9 details inline (on 400) */}
      {details && details.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
          <p className="text-[11px] font-medium text-red-700 mb-1">Couldn't save — fix these:</p>
          <ul className="list-disc pl-4 space-y-0.5">{details.map((d, i) => <li key={i} className="text-[10px] text-red-600">{d}</li>)}</ul>
        </div>
      )}

      {/* Routing rules editor */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Routing rules</h3>
        <p className="text-[10px] text-gray-400 mb-3">When a QA check fails, run these retry variants (Round 2+).</p>
        <div className="space-y-1.5">
          {ruleKeys.map((failKey) => (
            <RoutingRuleRow
              key={failKey}
              failKey={failKey}
              targets={Array.isArray(rr[failKey]) ? rr[failKey] : []}
              plan={plan}
              allSubmodules={allSubmodules ?? []}
              cardName={cardName}
              pending={cardMutation.isPending}
              onRemove={(cid) => removeTarget(failKey, Array.isArray(rr[failKey]) ? rr[failKey] : [], cid)}
              onAddExisting={(cid) => addExisting(failKey, Array.isArray(rr[failKey]) ? rr[failKey] : [], cid)}
              onCreateVariant={(sub) => createVariant(failKey, Array.isArray(rr[failKey]) ? rr[failKey] : [], sub)}
            />
          ))}
        </div>
      </div>

      {/* Routed variants list (reuses the item-4 VariantRow) */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <h4 className="text-xs font-medium text-gray-700 mb-1">Routed variants</h4>
        <p className="text-[10px] text-gray-400 mb-2">Opening one here or in its step edits the same card.</p>
        {routedCards.length === 0 ? (
          <p className="text-[10px] text-gray-300 italic">No variants routed yet.</p>
        ) : (
          routedCards.map(({ cardId, card }) => (
            <VariantRow
              key={cardId}
              card={card}
              version={versionOf(cardId, card.submodule_id)}
              isRound1={cardIsRound1(plan, cardId)}
              routing={cardRoutingInfo(plan, cardId)}
              onOpen={() => openVariantPane(cardId)}
              onRemove={() => savePlan(removeCard(plan, cardId), 'Variant removed')}
              removing={cardMutation.isPending}
            />
          ))
        )}
      </div>
    </>
  );
}

// One failure-type row: mono key + target chips + "+ add target / create variant" dropdown (gated to
// rules 10-11 valid targets — only offers cards with a round > 1, so an invalid PUT is impossible).
function RoutingRuleRow({ failKey, targets, plan, allSubmodules, cardName, pending, onRemove, onAddExisting, onCreateVariant }: {
  failKey: string;
  targets: RoutingTarget[];
  plan: TemplateExecutionPlan;
  allSubmodules: SubmoduleManifest[];
  cardName: (cardId: string) => string;
  pending: boolean;
  onRemove: (cardId: string) => void;
  onAddExisting: (cardId: string) => void;
  onCreateVariant: (sub: SubmoduleManifest) => void;
}) {
  const targetedIds = new Set(targets.map((t) => t.card_id));
  const routable: Array<{ cardId: string; card: CardDefinition }> = Object.entries(plan.card_definitions ?? {})
    .filter(([id, c]) => !targetedIds.has(id) && roundKeys(c).some((k) => Number(k) > 1))
    .map(([id, c]) => ({ cardId: id, card: c }))
    .sort((a, b) => (a.card.card_name || '').localeCompare(b.card.card_name || ''));
  const submods = [...allSubmodules].sort((a, b) => a.name.localeCompare(b.name));

  const handleSelect = (value: string) => {
    if (value.startsWith('card:')) onAddExisting(value.slice(5));
    else if (value.startsWith('create:')) {
      const sub = allSubmodules.find((s) => s.id === value.slice(7));
      if (sub) onCreateVariant(sub);
    }
  };

  return (
    <div className="flex items-start gap-2 bg-gray-50 rounded px-3 py-2">
      <span className="text-[10px] font-mono text-gray-500 w-32 shrink-0 pt-1">{failKey}</span>
      <div className="flex flex-wrap items-center gap-1 flex-1 min-w-0">
        {targets.map((t) => (
          <span key={t.card_id} className="inline-flex items-center gap-0.5 text-[10px] bg-sky-50 border border-sky-200 rounded px-1.5 py-0.5 text-sky-700">
            {cardName(t.card_id)}
            <button onClick={() => onRemove(t.card_id)} disabled={pending} className="text-sky-400 hover:text-red-500 ml-0.5">&times;</button>
          </span>
        ))}
        {targets.length === 0 && <span className="text-[10px] text-gray-300 italic mr-1">no targets</span>}
        <select
          value=""
          disabled={pending}
          onChange={(e) => handleSelect(e.target.value)}
          className="text-[10px] border border-gray-200 rounded px-1 py-0.5 text-gray-500 bg-white max-w-[220px]"
        >
          <option value="">+ add target…</option>
          {routable.length > 0 && (
            <optgroup label="existing variants">
              {routable.map((c) => <option key={c.cardId} value={`card:${c.cardId}`}>{c.card.card_name} ({c.card.submodule_id})</option>)}
            </optgroup>
          )}
          <optgroup label="create variant">
            {submods.map((s) => <option key={s.id} value={`create:${s.id}`}>+ {s.name} variant</option>)}
          </optgroup>
        </select>
      </div>
    </div>
  );
}
