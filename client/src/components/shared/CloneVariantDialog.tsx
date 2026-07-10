import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePanelStore } from '../../stores/panelStore';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../api/client';
import type { ApiError } from '../../api/client';
import type { TemplateExecutionPlan } from '../../types/step';
import { useTemplatePlan, useTemplateCardMutation } from '../../hooks/useTemplatePlan';
import { addCard } from '../../api/cardPlanEditor';
import { ROUND_TABS, cardsAt } from '../../api/cardPlanView';

/**
 * Clone dialog (S2.3) — reached from a submodule row's "Clone" CTA. Name + description + a SINGLE-SELECT
 * round (a card lives in exactly one round, D10 — two rounds means two clones). "Create & configure →"
 * mints a distinct card and opens the full options editor (VariantPane).
 *
 * If Round 1 is chosen, the "WHERE SHOULD THIS SUBMODULE LIVE?" block appears: v6 binding state (S3.5)
 * overrides the mock — the Global option is RENDERED but DISABLED (inert), default "Only this template"
 * (slot preserved for #37, D11).
 */
export function CloneVariantDialog({ templateId }: { templateId: string | null | undefined }) {
  const { cloneDialogOpen, cloneSubmoduleId, cloneStep, cloneRound, closeCloneDialog, openVariantPane } = usePanelStore();
  const showToast = useAppStore((s) => s.showToast);
  const { data: template } = useTemplatePlan(templateId);
  const { data: allSubmodules } = useQuery({ queryKey: ['submodules-full'], queryFn: api.getSubmodulesFull });
  const cardMutation = useTemplateCardMutation(templateId);

  const plan: TemplateExecutionPlan = template?.execution_plan ?? {};
  const manifest = useMemo(() => (allSubmodules || []).find((s) => s.id === cloneSubmoduleId), [allSubmodules, cloneSubmoduleId]);
  const baseName = manifest?.name || cloneSubmoduleId || 'submodule';

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [round, setRound] = useState(1);

  // A retry round (≥ 2) already holding a card for this (submodule, step) is OCCUPIED — a second card
  // there is a duplicate-round 400 (S4.e). Round 1 is never occupied (clones are valid, D8).
  const occupied = useMemo(() => {
    const set = new Set<number>();
    if (cloneSubmoduleId != null && cloneStep != null) {
      for (const n of [2, 3, 4]) if (cardsAt(plan, cloneSubmoduleId, cloneStep, n).length > 0) set.add(n);
    }
    return set;
  }, [plan, cloneSubmoduleId, cloneStep]);

  // Re-seed the form each time the dialog opens for a (submodule, round). Never seed to an occupied
  // retry round — fall back to Round 1 (always available).
  useEffect(() => {
    if (cloneDialogOpen) {
      setName(`${baseName} copy`);
      setDescription('');
      setRound(occupied.has(cloneRound) ? 1 : (cloneRound || 1));
    }
  }, [cloneDialogOpen, baseName, cloneRound, occupied]);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape' && cloneDialogOpen) closeCloneDialog(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [cloneDialogOpen, closeCloneDialog]);

  if (!cloneDialogOpen || cloneSubmoduleId == null || cloneStep == null) return null;

  const handleCreate = () => {
    const { plan: next, cardId } = addCard(
      plan,
      {
        card_name: name.trim() || `${baseName} copy`,
        submodule_id: cloneSubmoduleId,
        step: cloneStep,
        round,                                  // one card = one round (D10)
        overrides: {},
        ...(description.trim() ? { description: description.trim() } : {}),
      },
      { round1: round === 1 },                  // Round 1 ⇒ placed; Round ≥ 2 ⇒ routing-only (option (e))
    );
    cardMutation.mutate(next, {
      onSuccess: () => {
        closeCloneDialog();
        showToast(round === 1 ? 'Variant created (Round 1)' : `Variant created (Round ${round} — dormant until routed)`, 'success');
        openVariantPane(cardId); // → full options editor (S2.3 "Create & configure")
      },
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={closeCloneDialog} />
      <div className="relative bg-white rounded-lg shadow-2xl w-[440px] max-w-[92vw] p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900">Clone “{baseName}” as a variant</h3>
          <button onClick={closeCloneDialog} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="space-y-3">
          {/* 1. Submodule name */}
          <div>
            <label className="block text-xs text-gray-600 font-medium mb-1">Submodule name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>

          {/* 2. Description */}
          <div>
            <label className="block text-xs text-gray-600 font-medium mb-1">Description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What makes this variant different? (so it isn't confused with the original)"
              className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>

          {/* 3. Active in which round? — single-select (D10) */}
          <div>
            <label className="block text-xs text-gray-600 font-medium mb-1">Active in which round?</label>
            <div className="flex items-center gap-1">
              {ROUND_TABS.map((n) => {
                const isOccupied = occupied.has(n);
                return (
                  <button
                    key={n}
                    onClick={() => !isOccupied && setRound(n)}
                    disabled={isOccupied}
                    title={isOccupied ? `This submodule already has a Round ${n} variant — edit it instead` : undefined}
                    className={`px-3 py-1 text-xs rounded ${round === n ? 'bg-sky-600 text-white' : isOccupied ? 'bg-gray-50 text-gray-300 cursor-not-allowed line-through' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                  >
                    Round {n}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-gray-400 mt-1">
              A card lives in exactly one round. Want it in two rounds? Make two clones. A retry round
              that already has a variant for this submodule is disabled (one card per retry round).
            </p>
          </div>

          {/* Round-1 placement block (S2.3 / S3.5) — Global RENDERED but DISABLED (inert); default
              "Only this template". Slot preserved for #37 (D11). */}
          {round === 1 && (
            <div className="rounded border border-gray-200 bg-gray-50 p-3">
              <p className="text-xs text-gray-600 font-medium mb-2">Where should this submodule live?</p>
              <label className="flex items-center gap-2 text-xs text-gray-700 mb-1">
                <input type="radio" name="placement" checked readOnly className="accent-sky-600" />
                Only this template
              </label>
              <label className="flex items-center gap-2 text-xs text-gray-400 cursor-not-allowed">
                <input type="radio" name="placement" disabled className="accent-sky-600" />
                Global submodule
                <span className="text-[10px] text-gray-400">(coming with #37)</span>
              </label>
            </div>
          )}
        </div>

        {/* §9 save errors inline (on 400) */}
        {(() => {
          const details = (cardMutation.error as ApiError | null)?.details;
          if (!details || details.length === 0) return null;
          return (
            <div className="bg-red-50 border border-red-200 rounded p-2 mt-3">
              <p className="text-[11px] font-medium text-red-700 mb-1">Couldn't save — fix these:</p>
              <ul className="list-disc pl-4 space-y-0.5">{details.map((d, i) => <li key={i} className="text-[10px] text-red-600">{d}</li>)}</ul>
            </div>
          );
        })()}

        <div className="flex items-center justify-end gap-2 mt-5">
          <button onClick={closeCloneDialog} className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700">Cancel</button>
          <button
            onClick={handleCreate}
            disabled={cardMutation.isPending || !name.trim()}
            className="px-4 py-1.5 text-xs font-medium bg-sky-600 text-white rounded hover:bg-sky-700 disabled:bg-gray-300"
          >
            {cardMutation.isPending ? 'Creating…' : 'Create & configure →'}
          </button>
        </div>
      </div>
    </div>
  );
}
