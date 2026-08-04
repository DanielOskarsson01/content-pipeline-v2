import { useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useTuningSession, useTuningSummary, useAcceptExperiment, usePromoteSettings } from '../../hooks/useWorkbench';
import { nextStepReads, downstreamToErase, promotableExperimentId } from '../../api/tuningSession';
import type { WorkbenchExperimentResponse, PromoteSettingsResult } from '../../types/step';

/**
 * U3 — the tuning-session surface in the run view (inside the Try-It panel).
 * Session state stays server-side; this renders it and drives the four actions:
 *   1. the current session's accepted chain, per step
 *   2. Accept this result (with erase-downstream confirmation when a re-accept
 *      would destroy accepted steps below it — shows exactly what is lost)
 *   3. what the NEXT run will read, stated before running (chained vs pool,
 *      pool fallback unmistakable)
 *   4. Promote settings to the template, confirmed (template · submodule ·
 *      old → new · "changes all future runs"), surfacing the blocking row when
 *      T3's shadow-refusal fires.
 */
export function TuningSessionControls({
  runId,
  stepIndex,
  entityName,
  templateId,
  tryItResult,
  disabled,
  manualOverride,
}: {
  runId: string;
  stepIndex: number;
  entityName: string | null;
  templateId?: string | null;
  tryItResult: WorkbenchExperimentResponse | null;
  disabled?: boolean;
  /** Manual U8 chain override (chainFromLast) — wins over session auto-chain. */
  manualOverride?: { id: string; submodule_id: string } | null;
}) {
  const showToast = useAppStore((s) => s.showToast);
  // `isSuccess` gates Accept: `steps` falls back to [] while the session GET is
  // unresolved/errored, which would let a destructive accept skip the
  // erase-downstream confirm (the warning must fail CLOSED, not open).
  const { data: session, isSuccess: sessionLoaded } = useTuningSession(runId, entityName);
  const { data: summary } = useTuningSummary(runId, entityName);
  const acceptMutation = useAcceptExperiment();
  const promoteMutation = usePromoteSettings();

  const [eraseConfirm, setEraseConfirm] = useState(false);
  const [promotePreview, setPromotePreview] = useState<PromoteSettingsResult | null>(null);

  if (!entityName) return null;
  const steps = session?.steps ?? [];

  const exp = tryItResult?.experiment ?? null;
  const resultMatchesHere = !!exp
    && exp.status === 'completed'
    && exp.source_run_id === runId
    && exp.entity_name === entityName
    && exp.step_index === stepIndex;

  const acceptedHere = steps.find((s) => s.step_index === stepIndex) ?? null;
  const thisIsAccepted = resultMatchesHere && acceptedHere?.experiment_id === exp!.id;
  // Promote acts on the accepted experiment for this step, read from the
  // persisted session — so it stays reachable after the Try-It result is gone
  // (modal close / panel reopen clears tryItResult).
  const promoteExpId = promotableExperimentId(steps, stepIndex);

  // What the next run reads, stated BEFORE running (unless the manual override wins).
  const reads = nextStepReads(steps, stepIndex);
  const willErase = resultMatchesHere ? downstreamToErase(steps, stepIndex) : [];

  // Cost of what an erase would destroy — matched from the summary's accepted attempts.
  const lostCost = (() => {
    if (!willErase.length || !summary?.steps) return null;
    let total = 0; let any = false;
    for (const s of willErase) {
      const st = summary.steps.find((x) => x.step_index === s.step_index);
      const acc = st?.attempts.find((a) => a.accepted && a.experiment_id === s.experiment_id);
      if (acc?.metrics?.cost_usd != null) { total += acc.metrics.cost_usd; any = true; }
    }
    return any ? total : null;
  })();

  const doAccept = () => {
    if (!resultMatchesHere) return;
    setEraseConfirm(false);
    acceptMutation.mutate(
      { source_run_id: runId, entity_name: entityName, step_index: stepIndex, experiment_id: exp!.id },
      {
        onSuccess: (res) => {
          const erased = res.erased.length
            ? ` — erased ${res.erased.length} downstream step${res.erased.length === 1 ? '' : 's'} (${res.erased.map((e) => `s${e.step_index}`).join(', ')})`
            : '';
          const pm = res.postmortem ? '' : ' · postmortem NOT written (store unconfigured)';
          showToast(`Accepted step ${stepIndex}${erased}${pm}`, 'success');
        },
        onError: (e) => showToast(e instanceof Error ? e.message : 'Accept failed', 'error'),
      },
    );
  };

  const onAcceptClick = () => {
    if (willErase.length > 0) setEraseConfirm(true);
    else doAccept();
  };

  const openPromote = () => {
    if (!promoteExpId) return;
    setPromotePreview(null);
    promoteMutation.mutate(
      { experiment_id: promoteExpId, template_id: templateId!, dry_run: true },
      {
        onSuccess: (res) => setPromotePreview(res),
        onError: (e) => showToast(e instanceof Error ? e.message : 'Promote preview failed', 'error'),
      },
    );
  };

  const doPromote = () => {
    if (!promoteExpId) return;
    promoteMutation.mutate(
      { experiment_id: promoteExpId, template_id: templateId! },
      {
        onSuccess: (res) => {
          if (res.refused) { setPromotePreview(res); showToast('Promote refused — see details', 'error'); return; }
          setPromotePreview(null);
          showToast(`Promoted ${res.promoted} setting${res.promoted === 1 ? '' : 's'} to template — all future runs use them`, 'success');
        },
        onError: (e) => showToast(e instanceof Error ? e.message : 'Promote failed', 'error'),
      },
    );
  };

  return (
    <div className="space-y-3 border-t border-gray-200 pt-3">
      {/* 1. Accepted chain, per step */}
      <div>
        <p className="text-xs font-medium text-gray-700 mb-1">Accepted chain for {entityName}</p>
        {steps.length === 0 ? (
          <p className="text-[11px] text-gray-400 italic">Nothing accepted yet — this run reads the raw pool.</p>
        ) : (
          <ul className="space-y-0.5">
            {steps.map((s) => (
              <li
                key={s.step_index}
                className={`text-[11px] flex items-center gap-2 ${s.step_index === stepIndex ? 'text-green-800 font-medium' : 'text-gray-600'}`}
              >
                <span className="w-10">step {s.step_index}</span>
                <span>{s.submodule_id}</span>
                <span className="font-mono text-gray-400">{s.experiment_id.slice(0, 8)}</span>
                {s.step_index === stepIndex && <span className="text-green-600">← this step</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 3. What the next run will read — stated before running */}
      <p className="text-[11px] text-gray-500">
        Next run at step {stepIndex} will read:{' '}
        {manualOverride ? (
          <span className="font-medium text-sky-800">
            experiment {manualOverride.id.slice(0, 8)} ({manualOverride.submodule_id}) — manual override
          </span>
        ) : reads.source === 'chained' && reads.from ? (
          <span className="font-medium text-sky-800">
            the accepted step-{reads.from.step_index} experiment ({reads.from.submodule_id}) overlaid on the pool
          </span>
        ) : (
          <span className="font-medium text-amber-700">the raw pool — nothing accepted upstream (not chained)</span>
        )}
      </p>

      {/* 2. Accept this result */}
      {resultMatchesHere && !thisIsAccepted && (
        <div>
          <button
            onClick={onAcceptClick}
            disabled={disabled || acceptMutation.isPending || !sessionLoaded}
            className={`w-full py-2 rounded text-sm font-medium transition-colors ${
              disabled || acceptMutation.isPending || !sessionLoaded
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-green-600 text-white hover:bg-green-700'
            }`}
          >
            {acceptMutation.isPending ? 'Accepting…' : !sessionLoaded ? 'Loading session…' : `Accept this result for step ${stepIndex}`}
          </button>

          {/* Erase-downstream confirmation — shows exactly what is destroyed */}
          {eraseConfirm && (
            <div className="mt-2 bg-red-50 border border-red-300 rounded p-3 space-y-2">
              <p className="text-xs font-semibold text-red-800">
                Re-accepting at step {stepIndex} will erase {willErase.length} accepted downstream step{willErase.length === 1 ? '' : 's'}
                {lostCost != null ? ` (~$${lostCost.toFixed(4)} of work)` : ''}:
              </p>
              <ul className="text-[11px] text-red-700 space-y-0.5">
                {willErase.map((s) => (
                  <li key={s.step_index}>step {s.step_index} — {s.submodule_id} ({s.experiment_id.slice(0, 8)})</li>
                ))}
              </ul>
              <p className="text-[11px] text-red-600">The experiments stay in the log, but the accepted chain below this step is cleared. This cannot be undone.</p>
              <div className="flex gap-2">
                <button onClick={doAccept} disabled={acceptMutation.isPending} className="px-3 py-1.5 rounded text-xs font-medium bg-red-600 text-white hover:bg-red-700">
                  Erase &amp; accept
                </button>
                <button onClick={() => setEraseConfirm(false)} className="px-3 py-1.5 rounded text-xs font-medium border border-gray-300 text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {resultMatchesHere && thisIsAccepted && (
        <p className="text-[11px] text-green-700 font-medium">✓ This result is accepted for step {stepIndex}.</p>
      )}

      {/* 4. Promote settings to template (the accepted experiment for this step —
          reachable whether or not the live Try-It result is still on screen). */}
      {promoteExpId && templateId && (
        <div>
          <button
            onClick={openPromote}
            disabled={disabled || promoteMutation.isPending}
            className={`w-full py-2 rounded text-sm font-medium transition-colors border-2 ${
              disabled || promoteMutation.isPending
                ? 'border-gray-200 text-gray-400 cursor-not-allowed'
                : 'border-[#E11D73] text-[#E11D73] hover:bg-[#E11D73]/10'
            }`}
          >
            {promoteMutation.isPending ? 'Working…' : 'Promote these settings to the template'}
          </button>
          {promotePreview && <PromotePreview preview={promotePreview} onConfirm={doPromote} onCancel={() => setPromotePreview(null)} busy={promoteMutation.isPending} />}
        </div>
      )}
    </div>
  );
}

function PromotePreview({
  preview, onConfirm, onCancel, busy,
}: {
  preview: PromoteSettingsResult; onConfirm: () => void; onCancel: () => void; busy: boolean;
}) {
  // The "no overrides to promote" return omits conflicts/warnings entirely —
  // default to [] so a no-override accepted experiment doesn't crash the render.
  const conflicts = preview.conflicts ?? [];
  const warnings = preview.warnings ?? [];
  const changing = preview.plan.filter((p) => p.changes);
  if (preview.refused) {
    return (
      <div className="mt-2 bg-red-50 border border-red-300 rounded p-3 space-y-2">
        <p className="text-xs font-semibold text-red-800">Refused — {preview.reason}</p>
        {conflicts.length > 0 && (
          <ul className="text-[11px] text-red-700 space-y-1">
            {conflicts.map((c) => (
              <li key={c.option}>
                <span className="font-mono">{c.option}</span>: a <span className="font-medium">{c.layer}</span> preset
                {' '}<span className="font-medium">{c.preset_name}</span> (row <span className="font-mono">{c.row_id}</span>)
                {' '}would resolve to <span className="font-mono">{JSON.stringify(c.would_resolve_to)}</span> instead of your{' '}
                <span className="font-mono">{JSON.stringify(c.blocked_new)}</span>.
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-red-600">Delete/adjust the named row, or promote to the global layer explicitly.</p>
        <button onClick={onCancel} className="px-3 py-1.5 rounded text-xs font-medium border border-gray-300 text-gray-600 hover:bg-gray-50">Close</button>
      </div>
    );
  }
  return (
    <div className="mt-2 bg-amber-50 border border-amber-300 rounded p-3 space-y-2">
      <p className="text-xs font-semibold text-amber-900">
        This changes template <span className="font-medium">{preview.template_name ?? preview.template_id}</span> · submodule{' '}
        <span className="font-mono">{preview.submodule_id}</span> — <span className="underline">for all future runs</span>.
      </p>
      {changing.length === 0 ? (
        <p className="text-[11px] text-amber-800">{preview.message ?? 'No values differ from the template — nothing to change.'}</p>
      ) : (
        <ul className="text-[11px] text-amber-900 space-y-0.5">
          {changing.map((p) => (
            <li key={p.option}>
              <span className="font-mono">{p.option}</span>: <span className="font-mono">{JSON.stringify(p.old)}</span> →{' '}
              <span className="font-mono font-medium">{JSON.stringify(p.new)}</span>
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="text-[11px] text-amber-700 space-y-0.5">
          {warnings.map((w, i) => <li key={i}>⚠ {w.option}: {w.note}</li>)}
        </ul>
      )}
      <div className="flex gap-2">
        <button onClick={onConfirm} disabled={busy || changing.length === 0} className={`px-3 py-1.5 rounded text-xs font-medium ${busy || changing.length === 0 ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-[#E11D73] text-white hover:bg-[#E11D73]/90'}`}>
          {busy ? 'Promoting…' : 'Confirm — change the template'}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 rounded text-xs font-medium border border-gray-300 text-gray-600 hover:bg-gray-50">Cancel</button>
      </div>
    </div>
  );
}
