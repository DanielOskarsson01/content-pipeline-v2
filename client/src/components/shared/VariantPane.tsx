import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePanelStore } from '../../stores/panelStore';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../api/client';
import type { ApiError } from '../../api/client';
import type { SubmoduleManifest, TemplateExecutionPlan, CardRoundOverrides } from '../../types/step';
import { useTemplatePlan, useTemplateCardMutation } from '../../hooks/useTemplatePlan';
import { setCardRounds, removeCard, renameCard } from '../../api/cardPlanEditor';
import { cardRound, cardRoutingInfo, cardIsDormant, optionsForEditor } from '../../api/cardPlanView';
import { SubmoduleOptions } from '../primitives/SubmoduleOptions';
import { PanelAccordionItem } from './PanelAccordionItem';

/**
 * VariantPane — the card editor (v6 scalar). Reuses the SubmodulePanel shell (672px, teal #0891B2
 * header, backdrop, Esc-close, PanelAccordionItem). A card IS exactly one round (D10) — there is no
 * `rounds` map and no per-round tabs here; the round is chosen at clone time and shown read-only.
 * "Edit" opens the FULL real SubmoduleOptions (S4.h) over the card's flat `overrides` — every manifest
 * field, never a reduced subset. ALL plan mutations go through cardPlanEditor; every card write is ONE
 * api.updateTemplate PUT (useTemplateCardMutation).
 */
export function VariantPane({ templateId, projectId }: { templateId: string | null | undefined; projectId: string }) {
  const { variantPaneOpen, variantCardId, closeVariantPane } = usePanelStore();
  const showToast = useAppStore((s) => s.showToast);
  const { data: template } = useTemplatePlan(templateId);
  const { data: allSubmodules } = useQuery({ queryKey: ['submodules-full'], queryFn: api.getSubmodulesFull });
  const cardMutation = useTemplateCardMutation(templateId);

  const plan: TemplateExecutionPlan = template?.execution_plan ?? {};
  const card = variantCardId ? plan.card_definitions?.[variantCardId] : undefined;
  const manifest = useMemo<SubmoduleManifest | undefined>(
    () => (allSubmodules || []).find((s) => s.id === card?.submodule_id),
    [allSubmodules, card?.submodule_id],
  );

  const [localName, setLocalName] = useState('');
  // The card's FLAT overrides (v6 scalar). Sparse: only fields that differ from the manifest default.
  const [localOverrides, setLocalOverrides] = useState<CardRoundOverrides>({});

  const overridesKey = JSON.stringify(card?.overrides ?? {});
  useEffect(() => {
    if (card) {
      setLocalName(card.card_name);
      setLocalOverrides(structuredClone(card.overrides ?? {}));
    }
  }, [variantCardId, card?.card_name, overridesKey]);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape' && variantPaneOpen) closeVariantPane(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [variantPaneOpen, closeVariantPane]);

  if (!variantPaneOpen || !variantCardId) return null;

  const round = cardRound(card);
  const routing = cardRoutingInfo(plan, variantCardId);
  const dormant = cardIsDormant(plan, variantCardId);
  const options = optionsForEditor(manifest);
  const dirty = !!card && (localName !== card.card_name || JSON.stringify(localOverrides) !== overridesKey);
  const details = (cardMutation.error as ApiError | null)?.details;

  // ── mutations (all via cardPlanEditor → one PUT) ──
  const savePlan = (next: TemplateExecutionPlan, msg: string, after?: () => void) =>
    cardMutation.mutate(next, { onSuccess: () => { showToast(msg, 'success'); after?.(); } });

  const handleSaveChanges = () => {
    if (!card) return;
    let p: TemplateExecutionPlan = plan;
    if (localName.trim() && localName !== card.card_name) p = renameCard(p, variantCardId, localName.trim());
    if (JSON.stringify(localOverrides) !== overridesKey) p = setCardRounds(p, variantCardId, localOverrides);
    savePlan(p, 'Variant saved');
  };
  const handleRemove = () =>
    savePlan(removeCard(plan, variantCardId), 'Variant removed', closeVariantPane);

  const setOverride = (name: string, value: unknown) =>
    setLocalOverrides((o) => ({ ...o, [name]: value }));
  const clearOverride = (name: string) =>
    setLocalOverrides((o) => { const n = { ...o }; delete n[name]; return n; });

  const cardName = card?.card_name ?? localName ?? 'Variant';

  return (
    <div className="fixed inset-0 z-50">
      <div className="fixed inset-0 bg-black/30 transition-opacity duration-300 opacity-100" onClick={closeVariantPane} />
      <div className="fixed inset-y-0 left-0 w-[672px] min-w-[672px] max-w-[672px] bg-gray-100 shadow-2xl flex flex-col transition-transform duration-300 translate-x-0">
        {/* Header (teal, reused chrome) */}
        <div className="bg-[#0891B2] text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
          <h3 className="text-base font-semibold flex items-center gap-2">
            {cardName}
            <span className="text-[10px] font-mono bg-white/20 px-1.5 py-0.5 rounded">variant</span>
            <span className="text-[10px] font-mono bg-white/20 px-1.5 py-0.5 rounded">Round {round}</span>
          </h3>
          <button onClick={closeVariantPane} className="p-1 text-white/80 hover:text-white rounded hover:bg-white/10">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {!card ? (
          <div className="p-6 text-sm text-gray-500">This variant no longer exists.</div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {/* Name + meta */}
              <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-2">
                <label className="block text-xs text-gray-600 font-medium">Variant name</label>
                <input
                  value={localName}
                  onChange={(e) => setLocalName(e.target.value)}
                  className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
                <p className="text-[10px] text-gray-400 font-mono">
                  {card.submodule_id} · step {card.step} · Round {round} · {round === 1 ? 'placed (first pass)' : 'routing-only'}
                </p>
                {/* Routing status */}
                {round === 1 ? (
                  <p className="text-[11px] text-gray-500">Runs in Round 1 (the normal pass).</p>
                ) : routing.routed ? (
                  <p className="text-[11px] text-sky-600">← {routing.failKeys.join(', ')}</p>
                ) : (
                  <p className="text-[11px] text-amber-600">
                    <span className="font-medium">Unreachable</span> — no QA failure routes here. Wire a
                    <span className="font-mono"> {'<check>:fail'}</span> to it in Step 7 routing.
                  </p>
                )}
                {dormant && (
                  <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300">unreachable</span>
                )}
              </div>

              {/* §9 details inline (on 400) */}
              {details && details.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-[11px] font-medium text-red-700 mb-1">Couldn't save — fix these:</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {details.map((d, i) => <li key={i} className="text-[10px] text-red-600">{d}</li>)}
                  </ul>
                </div>
              )}

              {/* Options — the FULL real SubmoduleOptions (S4.h): every manifest field, over the card's
                  flat overrides. NOT a reduced subset. */}
              <PanelAccordionItem title="Options" badge={`${options.length} field${options.length !== 1 ? 's' : ''}`} isOpen variant="teal" onToggle={() => {}}>
                <p className="text-[10px] text-gray-400 mb-2">
                  The full submodule options. Fields you change here override the base config for this variant;
                  everything else inherits the manifest default.
                </p>
                {options.length === 0 ? (
                  <p className="text-[10px] text-gray-300 italic">This submodule declares no options.</p>
                ) : (
                  <>
                    <SubmoduleOptions
                      options={options}
                      values={localOverrides}
                      onChange={setOverride}
                      projectId={projectId}
                      submoduleId={card.submodule_id}
                    />
                    {Object.keys(localOverrides).length > 0 && (
                      <div className="mt-3 pt-2 border-t border-gray-100">
                        <p className="text-[10px] text-gray-400 mb-1">Overridden fields ({Object.keys(localOverrides).length}):</p>
                        <div className="flex flex-wrap gap-1">
                          {Object.keys(localOverrides).map((f) => (
                            <span key={f} className="inline-flex items-center gap-0.5 text-[10px] bg-sky-50 border border-sky-200 rounded px-1.5 py-0.5 text-sky-700">
                              {f}
                              <button onClick={() => clearOverride(f)} className="text-sky-400 hover:text-red-500 ml-0.5" title="revert to default">&times;</button>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </PanelAccordionItem>

              {/* Remove variant */}
              <button onClick={handleRemove} disabled={cardMutation.isPending} className="text-[11px] text-gray-400 hover:text-red-500">
                Remove variant
              </button>
            </div>

            {/* Save Changes (batched — only when dirty) */}
            {dirty && (
              <div className="border-t border-gray-200 px-4 py-3 bg-white flex-shrink-0">
                <button
                  onClick={handleSaveChanges}
                  disabled={cardMutation.isPending}
                  className="px-4 py-2 rounded text-sm font-medium bg-sky-600 text-white hover:bg-sky-700 disabled:bg-gray-300"
                >
                  {cardMutation.isPending ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
