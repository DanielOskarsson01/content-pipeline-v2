import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePanelStore } from '../../stores/panelStore';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../api/client';
import type { ApiError } from '../../api/client';
import type { ProjectMode, TemplateExecutionPlan, SubmoduleManifest, RoutingTarget } from '../../types/step';
import { useTemplatePlan, useTemplateCardMutation } from '../../hooks/useTemplatePlan';
import { setRoutingTargets, addRoutingTarget, addCard, removeCard } from '../../api/cardPlanEditor';
import { FAILURE_TYPES, cardRound, cardsAt, cardIsRound1, cardRoutingInfo, cardIsDormant, deadRungRounds } from '../../api/cardPlanView';
import { VariantRow } from '../shared/CategoryCardGrid';

// Rounds a routing target can live at (Round 1 is the normal pass, never a routing destination — S2.5).
const TARGET_ROUNDS = [2, 3, 4] as const;
const ORDINAL: Record<number, string> = { 2: '2nd', 3: '3rd', 4: '4th' };

/**
 * Step-7 (Routing) body — the structured editor for routing_rules (V6-§2.5). Each active QA check
 * lists its target variants; a per-check target editor (round tabs from Round 2, sub-copy, whole-
 * catalog add-dropdown) is the routing-trigger affordance that makes different-submodule escalation
 * (the V6-§1.5 flagship) authorable. Amendments: S3.6 dead-rung note. §4 constraints: two checks →
 * one card (reuse an existing (submodule, step, round) card), removing a target keeps the card (→ D9
 * amber), removing the card cascades its rules. All writes → one useTemplateCardMutation PUT.
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
  const [editingCheck, setEditingCheck] = useState<string | null>(null);
  const [editorRound, setEditorRound] = useState(2);

  const plan: TemplateExecutionPlan = template?.execution_plan ?? {};
  const canEdit = !!templateId && projectMode !== 'single_run';
  const details = (cardMutation.error as ApiError | null)?.details;
  const rr = plan.routing_rules ?? {};

  const ruleKeys = useMemo(() => [...new Set<string>([...FAILURE_TYPES, ...Object.keys(rr)])], [rr]);
  const cardName = (cardId: string) => plan.card_definitions?.[cardId]?.card_name ?? cardId.slice(0, 8);
  const targetsOf = (failKey: string): RoutingTarget[] => (Array.isArray(rr[failKey]) ? rr[failKey] : []);

  const savePlan = (next: TemplateExecutionPlan, msg: string, after?: () => void) =>
    cardMutation.mutate(next, { onSuccess: () => { showToast(msg, 'success'); after?.(); } });

  const removeTarget = (failKey: string, cardId: string) =>
    // §4(f): removing a target but keeping the card leaves it dormant (→ D9 amber), not deleted.
    savePlan(setRoutingTargets(plan, failKey, targetsOf(failKey).filter((t) => t.card_id !== cardId)), 'Routing updated');

  const addExistingVariant = (failKey: string, cardId: string) => {
    if (targetsOf(failKey).some((t) => t.card_id === cardId)) return; // already a target → no duplicate row
    const card = plan.card_definitions?.[cardId];
    if (card) savePlan(addRoutingTarget(plan, failKey, targetsOf(failKey), { step: card.step, card_id: cardId }), 'Target added');
  };

  // Add a submodule from the whole catalog as a Round-N target. §4(e): if a card already sits at
  // (submodule, step, round), REUSE it (one card, many rules) — creating a second would be a
  // duplicate-round 400. Otherwise mint a routing-only Round-N card and route to it.
  const addCatalogSubmodule = (failKey: string, sub: SubmoduleManifest, round: number) => {
    const existing = cardsAt(plan, sub.id, sub.step, round)[0];
    if (existing) { addExistingVariant(failKey, existing.cardId); return; }
    const { plan: p1, cardId } = addCard(
      plan,
      { card_name: `${sub.id}-r${round}`, submodule_id: sub.id, step: sub.step, round, overrides: {} },
      { round1: false },
    );
    const p2 = addRoutingTarget(p1, failKey, targetsOf(failKey), { step: sub.step, card_id: cardId });
    savePlan(p2, 'Variant created + routed', () => openVariantPane(cardId));
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
      {/* §9 details inline (on 400) */}
      {details && details.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
          <p className="text-[11px] font-medium text-red-700 mb-1">Couldn't save — fix these:</p>
          <ul className="list-disc pl-4 space-y-0.5">{details.map((d, i) => <li key={i} className="text-[10px] text-red-600">{d}</li>)}</ul>
        </div>
      )}

      {/* Routing rules — one block per QA check (signal chip + target rows + per-check editor) */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Routing</h3>
        <p className="text-[10px] text-gray-400 mb-3">When a QA check fails, escalate to these retry variants (Round 2+).</p>
        <div className="space-y-2">
          {ruleKeys.map((failKey) => (
            <RoutingCheckBlock
              key={failKey}
              failKey={failKey}
              plan={plan}
              targets={targetsOf(failKey)}
              allSubmodules={allSubmodules ?? []}
              cardName={cardName}
              pending={cardMutation.isPending}
              deadRungs={deadRungRounds(plan, failKey)}
              isEditing={editingCheck === failKey}
              editorRound={editorRound}
              onToggleEdit={() => { setEditingCheck(editingCheck === failKey ? null : failKey); setEditorRound(2); }}
              onSetEditorRound={setEditorRound}
              onOpenCard={openVariantPane}
              onRemoveTarget={(cid) => removeTarget(failKey, cid)}
              onAddExisting={(cid) => addExistingVariant(failKey, cid)}
              onAddCatalog={(sub, round) => addCatalogSubmodule(failKey, sub, round)}
            />
          ))}
        </div>
      </div>

      {/* Routed variants list (reuses the shared VariantRow — same card, same pane) */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <h4 className="text-xs font-medium text-gray-700 mb-1">Routed variants</h4>
        <p className="text-[10px] text-gray-400 mb-2">Opening one here or in its step edits the same card.</p>
        {routedCards.length === 0 ? (
          <p className="text-[10px] text-gray-300 italic">No variants routed yet.</p>
        ) : (
          routedCards.map(({ cardId, card }) => (
            <VariantRow
              key={cardId}
              plan={plan}
              cardId={cardId}
              card={card}
              isRound1={cardIsRound1(plan, cardId)}
              routing={cardRoutingInfo(plan, cardId)}
              dormant={cardIsDormant(plan, cardId)}
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

// One QA check: signal chip + its target rows + (when editing) the per-check target editor.
function RoutingCheckBlock({
  failKey, plan, targets, allSubmodules, cardName, pending, deadRungs,
  isEditing, editorRound, onToggleEdit, onSetEditorRound, onOpenCard, onRemoveTarget, onAddExisting, onAddCatalog,
}: {
  failKey: string;
  plan: TemplateExecutionPlan;
  targets: RoutingTarget[];
  allSubmodules: SubmoduleManifest[];
  cardName: (cardId: string) => string;
  pending: boolean;
  deadRungs: number[];
  isEditing: boolean;
  editorRound: number;
  onToggleEdit: () => void;
  onSetEditorRound: (r: number) => void;
  onOpenCard: (cardId: string) => void;
  onRemoveTarget: (cardId: string) => void;
  onAddExisting: (cardId: string) => void;
  onAddCatalog: (sub: SubmoduleManifest, round: number) => void;
}) {
  const roundOf = (cardId: string) => cardRound(plan.card_definitions?.[cardId]);
  const submodOf = (cardId: string) => plan.card_definitions?.[cardId]?.submodule_id ?? '';
  // Targets at the round tab currently selected in the editor.
  const targetsAtRound = targets.filter((t) => roundOf(t.card_id) === editorRound);
  const targetedIds = new Set(targets.map((t) => t.card_id));

  // Existing routing-only variants (round > 1) NOT already targeted by this check — offered directly.
  const existingVariants = Object.entries(plan.card_definitions ?? {})
    .filter(([id, c]) => cardRound(c) > 1 && !targetedIds.has(id))
    .map(([id, c]) => ({ cardId: id, card: c }))
    .sort((a, b) => (a.card.card_name || '').localeCompare(b.card.card_name || ''));
  const catalog = [...allSubmodules].sort((a, b) => a.step - b.step || a.name.localeCompare(b.name));

  const handleSelect = (value: string) => {
    if (value.startsWith('card:')) onAddExisting(value.slice(5));
    else if (value.startsWith('sub:')) {
      const sub = allSubmodules.find((s) => s.id === value.slice(4));
      if (sub) onAddCatalog(sub, editorRound);
    }
  };

  return (
    <div className="bg-gray-50 rounded px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono text-sky-700 bg-sky-50 border border-sky-200 rounded px-1.5 py-0.5">{failKey}</span>
        <button onClick={onToggleEdit} disabled={pending} className="text-[10px] text-gray-500 hover:text-sky-600 disabled:opacity-40">
          {isEditing ? 'Done' : 'Edit'}
        </button>
      </div>

      {/* Target rows: <name> [Round N] [Edit] [Remove] (S2.5). Order = authored INV-DISPATCH-ORDER. */}
      {targets.length === 0 ? (
        <p className="text-[10px] text-gray-400 italic mt-1">No targets yet — click Edit to add.</p>
      ) : (
        <div className="mt-1 space-y-0.5">
          {targets.map((t) => (
            <div key={t.card_id} className="flex items-center justify-between text-[10px] pl-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-gray-700 truncate">{cardName(t.card_id)}</span>
                <span className="text-gray-400">({submodOf(t.card_id)})</span>
                <span className="bg-gray-100 text-gray-500 rounded px-1 flex-shrink-0">Round {roundOf(t.card_id)}</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button onClick={() => onOpenCard(t.card_id)} className="text-gray-400 hover:text-sky-600">Edit</button>
                <button onClick={() => onRemoveTarget(t.card_id)} disabled={pending} className="text-gray-400 hover:text-red-500 disabled:opacity-40">Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Dead-rung nudge (S3.6) */}
      {deadRungs.map((n) => (
        <p key={n} className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1">
          Round {n} targets will not fire unless a Round {n - 1} rung exists for this check.
        </p>
      ))}

      {/* Per-check target editor (S2.5) — round tabs from Round 2, whole-catalog add-dropdown */}
      {isEditing && (
        <div className="mt-2 pt-2 border-t border-gray-200">
          <div className="flex items-center gap-1 mb-1">
            {TARGET_ROUNDS.map((n) => (
              <button
                key={n}
                onClick={() => onSetEditorRound(n)}
                className={`px-2 py-0.5 text-[10px] rounded ${editorRound === n ? 'bg-sky-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-100'}`}
              >
                Round {n}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-gray-400 mb-1">Targets that run on the {ORDINAL[editorRound]} pass when this check fails.</p>
          {targetsAtRound.length === 0 ? (
            <p className="text-[10px] text-gray-300 italic mb-1">No Round {editorRound} targets.</p>
          ) : (
            <div className="flex flex-wrap gap-1 mb-1">
              {targetsAtRound.map((t) => (
                <span key={t.card_id} className="inline-flex items-center gap-0.5 text-[10px] bg-sky-50 border border-sky-200 rounded px-1.5 py-0.5 text-sky-700">
                  {cardName(t.card_id)}
                  <button onClick={() => onRemoveTarget(t.card_id)} disabled={pending} className="text-sky-400 hover:text-red-500 ml-0.5">&times;</button>
                </span>
              ))}
            </div>
          )}
          <select
            value=""
            disabled={pending}
            onChange={(e) => handleSelect(e.target.value)}
            className="text-[10px] border border-gray-200 rounded px-1 py-0.5 text-gray-500 bg-white max-w-[260px]"
          >
            <option value="">+ add target…</option>
            {existingVariants.length > 0 && (
              <optgroup label="existing variants">
                {existingVariants.map((c) => (
                  <option key={c.cardId} value={`card:${c.cardId}`}>{c.card.card_name} — variant (Round {cardRound(c.card)})</option>
                ))}
              </optgroup>
            )}
            <optgroup label="whole catalog (any step)">
              {catalog.map((s) => (
                <option key={s.id} value={`sub:${s.id}`}>{s.name} (step {s.step})</option>
              ))}
            </optgroup>
          </select>
        </div>
      )}
    </div>
  );
}
