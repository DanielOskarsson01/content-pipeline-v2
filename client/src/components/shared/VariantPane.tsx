import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePanelStore } from '../../stores/panelStore';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../api/client';
import type { ApiError } from '../../api/client';
import type { SubmoduleManifest, TemplateExecutionPlan, CardRoundOverrides } from '../../types/step';
import { useTemplatePlan, useTemplateCardMutation } from '../../hooks/useTemplatePlan';
import { setCardRounds, setCardPlacement, removeCard, renameCard } from '../../api/cardPlanEditor';
import { cardIsRound1, cardRoutingInfo, roundKeys, nextRoundKey } from '../../api/cardPlanView';
import { SubmoduleOptions } from '../primitives/SubmoduleOptions';
import { PanelAccordionItem } from './PanelAccordionItem';

type Rounds = Record<string, CardRoundOverrides>;

const fmt = (v: unknown): string => {
  if (v === undefined) return '—';
  if (typeof v === 'string') return v.length > 40 ? v.slice(0, 40) + '…' : v;
  if (Array.isArray(v)) return `${v.length} item${v.length !== 1 ? 's' : ''}`;
  if (v && typeof v === 'object') return '{…}';
  return String(v);
};

/**
 * VariantPane — the card editor. Reuses the production SubmodulePanel shell (672px, teal #0891B2
 * header, backdrop, Esc-close, PanelAccordionItem). ALL plan mutations go through cardPlanEditor;
 * every card write is ONE api.updateTemplate PUT (useTemplateCardMutation) — never the run-scoped
 * saveSubmoduleConfig endpoint. Batched dirty-save for the body (name + rounds); structural actions
 * (Round-1 toggle, remove) save immediately.
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
  const [localRounds, setLocalRounds] = useState<Rounds>({ '1': {} });
  const [activeRound, setActiveRound] = useState('1');

  const roundsKey = JSON.stringify(card?.rounds);
  useEffect(() => {
    if (card) {
      setLocalName(card.card_name);
      setLocalRounds(structuredClone(card.rounds) as unknown as Rounds);
      setActiveRound((prev) => (card.rounds[prev as '1'] ? prev : '1'));
    }
  }, [variantCardId, card?.card_name, roundsKey]);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape' && variantPaneOpen) closeVariantPane(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [variantPaneOpen, closeVariantPane]);

  if (!variantPaneOpen || !variantCardId) return null;

  const manifestOptions = manifest?.options ?? [];
  const manifestDefaults = (manifest?.options_defaults ?? {}) as Record<string, unknown>;
  const isRound1 = cardIsRound1(plan, variantCardId);
  const routing = cardRoutingInfo(plan, variantCardId);
  const dirty = !!card && (localName !== card.card_name || JSON.stringify(localRounds) !== roundsKey);
  const details = (cardMutation.error as ApiError | null)?.details;

  // ── mutations (all via cardPlanEditor → one PUT) ──
  const savePlan = (next: TemplateExecutionPlan, msg: string, after?: () => void) =>
    cardMutation.mutate(next, { onSuccess: () => { showToast(msg, 'success'); after?.(); } });

  const handleSaveChanges = () => {
    if (!card) return;
    let p: TemplateExecutionPlan = plan;
    if (localName.trim() && localName !== card.card_name) p = renameCard(p, variantCardId, localName.trim());
    if (JSON.stringify(localRounds) !== roundsKey) p = setCardRounds(p, variantCardId, localRounds as never);
    savePlan(p, 'Variant saved');
  };
  const handleToggleRound1 = () =>
    savePlan(setCardPlacement(plan, variantCardId, { round1: !isRound1 }), isRound1 ? 'Now retry-only' : 'Now runs in Round 1');
  const handleRemove = () =>
    savePlan(removeCard(plan, variantCardId), 'Variant removed', closeVariantPane);

  // ── round editing (local, batched) ──
  const present = roundKeys({ rounds: localRounds });
  const nextRound = nextRoundKey({ rounds: localRounds });
  const setOverride = (rk: string, field: string, value: unknown) =>
    setLocalRounds((r) => ({ ...r, [rk]: { ...r[rk], [field]: value } }));
  const removeOverride = (rk: string, field: string) =>
    setLocalRounds((r) => { const nr = { ...r[rk] }; delete nr[field]; return { ...r, [rk]: nr }; });
  const addRetryRound = () => { if (nextRound) { setLocalRounds((r) => ({ ...r, [nextRound]: {} })); setActiveRound(nextRound); } };
  const dropRound = (rk: string) => {
    setLocalRounds((r) => { const nr = { ...r }; delete nr[rk]; return nr; });
    setActiveRound('1');
  };

  const overrides = localRounds[activeRound] ?? {};
  const referenceLabel = activeRound === '1' ? 'Default' : 'Round 1';
  const referenceValue = (field: string): unknown =>
    activeRound === '1' ? manifestDefaults[field] : (localRounds['1']?.[field] ?? manifestDefaults[field]);
  const overriddenFields = Object.keys(overrides);
  const availableToOverride = manifestOptions.filter((o) => !(o.name in overrides));

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
                <p className="text-[10px] text-gray-400 font-mono">{card.submodule_id} · step {card.step}</p>
                {/* Routing note */}
                {routing.routed ? (
                  <p className="text-[11px] text-sky-600">← {routing.failKeys.join(', ')}</p>
                ) : (
                  <p className="text-[11px] text-amber-600">Dormant — not routed. Wire a QA failure to it in Step 7 routing.</p>
                )}
                {/* Runs in Round 1 toggle (immediate) */}
                <label className="flex items-center gap-2 cursor-pointer pt-1">
                  <input type="checkbox" checked={isRound1} onChange={handleToggleRound1} disabled={cardMutation.isPending} className="accent-sky-600" />
                  <span className="text-xs text-gray-700">Runs in Round 1</span>
                  <span className="text-[10px] text-gray-400">{isRound1 ? '(placed in the normal pass)' : '(retry-only — fires when routed)'}</span>
                </label>
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

              {/* Rounds accordion (reused PanelAccordionItem) */}
              <PanelAccordionItem title="Rounds" badge={`${present.length}/4`} isOpen variant="teal" onToggle={() => {}}>
                {/* Round tabs */}
                <div className="flex items-center gap-1 mb-3 flex-wrap">
                  {present.map((rk) => (
                    <button
                      key={rk}
                      onClick={() => setActiveRound(rk)}
                      className={`px-2.5 py-1 text-xs rounded ${activeRound === rk ? 'bg-sky-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                    >
                      Run {rk}
                    </button>
                  ))}
                  {nextRound && (
                    <button onClick={addRetryRound} className="px-2.5 py-1 text-xs rounded border border-dashed border-gray-300 text-gray-500 hover:border-sky-400 hover:text-sky-600">
                      + retry round
                    </button>
                  )}
                </div>

                {/* Inherit framing */}
                {activeRound === '1' ? (
                  <p className="text-[10px] text-gray-400 mb-2">Round 1 is the base config. Only overridden fields are stored.</p>
                ) : (
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-gray-400">Inherits Round 1 — only fields below are overridden.</p>
                    <button onClick={() => dropRound(activeRound)} className="text-[10px] text-gray-400 hover:text-red-500">remove round</button>
                  </div>
                )}

                {/* Per-field sparse overrides */}
                {overriddenFields.length === 0 && (
                  <p className="text-[10px] text-gray-300 italic mb-2">No overrides yet.</p>
                )}
                <div className="space-y-3">
                  {overriddenFields.map((field) => {
                    const opt = manifestOptions.find((o) => o.name === field);
                    return (
                      <div key={field} className="border border-gray-200 rounded p-2">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] text-gray-400">{referenceLabel}: <span className="font-mono">{fmt(referenceValue(field))}</span></span>
                          <button onClick={() => removeOverride(activeRound, field)} className="text-[10px] text-gray-400 hover:text-red-500">remove override</button>
                        </div>
                        {opt ? (
                          <SubmoduleOptions
                            options={[opt]}
                            values={{ [field]: overrides[field] }}
                            onChange={(n, v) => setOverride(activeRound, n, v)}
                            projectId={projectId}
                            submoduleId={card.submodule_id}
                          />
                        ) : (
                          <p className="text-[10px] text-amber-600 font-mono">{field} (not in manifest)</p>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* + override a field */}
                {availableToOverride.length > 0 && (
                  <div className="mt-3">
                    <select
                      value=""
                      onChange={(e) => { const f = e.target.value; if (f) setOverride(activeRound, f, referenceValue(f) ?? ''); }}
                      className="text-[10px] border border-gray-200 rounded px-2 py-1 text-gray-500 bg-white"
                    >
                      <option value="">+ override a field…</option>
                      {availableToOverride.map((o) => <option key={o.name} value={o.name}>{o.label || o.name}</option>)}
                    </select>
                  </div>
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
