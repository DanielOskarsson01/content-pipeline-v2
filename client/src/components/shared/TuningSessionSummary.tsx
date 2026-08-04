import { useMemo, useState } from 'react';
import { useWorkbenchSourceRun, useTuningSummary } from '../../hooks/useWorkbench';
import { ExperimentMetrics } from './ExperimentMetrics';
import type { TuningPostmortemStep } from '../../types/step';

/**
 * U2 — the step-10 tuning summary. Per session (run, entity): every setting
 * tried per step, its metrics, which attempt was accepted and which were
 * discarded, and the cumulative cost of the accepted chain. Metrics-only
 * (the server's postmortem carries no article body); rendered through the ONE
 * ExperimentMetrics path.
 *
 * A session containing an erase-and-redo shows BOTH the discarded attempts and
 * the accepted one, clearly distinguished (accepted = green ring + badge;
 * discarded = muted, "not accepted").
 */
export function TuningSessionSummary({ runId }: { runId: string }) {
  const { data: tree } = useWorkbenchSourceRun(runId);
  const entities = useMemo(() => {
    const set = new Set<string>();
    for (const s of tree?.steps ?? []) for (const e of s.entities) set.add(e);
    return [...set].sort();
  }, [tree]);
  const [entity, setEntity] = useState<string | null>(null);
  const activeEntity = entity ?? entities[0] ?? null;

  const { data: summary, isLoading } = useTuningSummary(runId, activeEntity);

  const acceptedCost = useMemo(() => {
    if (!summary?.steps) return null;
    let total = 0; let any = false;
    for (const step of summary.steps) {
      const acc = step.attempts.find((a) => a.accepted);
      if (acc?.metrics?.cost_usd != null) { total += acc.metrics.cost_usd; any = true; }
    }
    return any ? total : null;
  }, [summary]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Tuning session summary</h3>
          <p className="text-xs text-gray-500">
            Every setting tried per step for this entity, what was accepted, what was discarded.
          </p>
        </div>
        {entities.length > 0 && (
          <select
            value={activeEntity ?? ''}
            onChange={(e) => setEntity(e.target.value || null)}
            className="bg-white border border-gray-300 rounded px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:border-[#0891B2]"
          >
            {entities.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        )}
      </div>

      {!activeEntity ? (
        <p className="text-xs text-gray-400 italic">No entities in this run.</p>
      ) : isLoading ? (
        <p className="text-xs text-gray-400">Loading summary…</p>
      ) : !summary || summary.session_id == null || summary.steps.length === 0 ? (
        <p className="text-xs text-gray-400 italic">
          No tuning session for <span className="font-medium">{activeEntity}</span> yet — accept an experiment at a step to start one.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-4 text-xs text-gray-600 flex-wrap">
            {summary.template_name && <span>Template: <span className="font-medium text-gray-900">{summary.template_name}</span></span>}
            <span>Steps: <span className="font-medium text-gray-900">{summary.steps.length}</span></span>
            <span>Cumulative accepted cost: <span className="font-medium text-gray-900">{acceptedCost != null ? `$${acceptedCost.toFixed(4)}` : '—'}</span></span>
          </div>
          {summary.steps.map((step) => <SummaryStep key={step.step_index} step={step} />)}
        </div>
      )}
    </div>
  );
}

function SummaryStep({ step }: { step: TuningPostmortemStep }) {
  return (
    <div className="border border-gray-200 rounded-lg p-3">
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="text-xs font-semibold text-gray-900">Step {step.step_index}</span>
        <span className="text-xs text-gray-500">{step.submodule_id ?? '—'}</span>
        <span className="text-[11px] text-gray-400">
          {step.attempt_count} attempt{step.attempt_count === 1 ? '' : 's'}
        </span>
        {step.accepted_experiment_id == null && (
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">nothing accepted</span>
        )}
      </div>
      <div className="space-y-2">
        {step.attempts.map((a) => {
          const changed = a.changed_from_previous.length > 0 ? a.changed_from_previous.join(', ') : 'no change';
          return (
            <div
              key={a.experiment_id}
              className={`rounded border p-2 ${
                a.accepted
                  ? 'border-green-300 ring-1 ring-green-200 bg-green-50/40'
                  : 'border-gray-200 bg-gray-50 opacity-90'
              }`}
            >
              <div className="flex items-center gap-2 flex-wrap mb-1">
                {a.accepted ? (
                  <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-green-100 text-green-700">ACCEPTED</span>
                ) : (
                  <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-gray-200 text-gray-600">not accepted</span>
                )}
                <span className={`text-[11px] px-2 py-0.5 rounded-full ${a.status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{a.status}</span>
                <span className="text-[11px] font-mono text-gray-400">{a.experiment_id.slice(0, 8)}</span>
                {a.parent_experiment_id && (
                  <span className="text-[11px] text-sky-700" title={a.parent_experiment_id}>
                    chained ← {a.parent_experiment_id.slice(0, 8)}
                  </span>
                )}
                <span className="text-[11px] text-gray-400">changed: {changed}</span>
              </div>
              <ExperimentMetrics metrics={a.metrics} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
