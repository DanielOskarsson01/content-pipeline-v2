import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { computeOverrides } from '../../api/workbenchOverrides';
import { useWorkbenchSourceRuns, useWorkbenchSourceRun, useCreateWorkbenchExperiment } from '../../hooks/useWorkbench';
import { SubmoduleOptions } from '../primitives/SubmoduleOptions';
import type { WorkbenchExperimentResponse } from '../../types/step';

/**
 * SubmoduleWorkbench (WORKBENCH_DESIGN.md Unit 6): pick a terminal run →
 * step → submodule → entity, edit the resolved options, replay via
 * POST /api/workbench/experiments and inspect the result. No writes to
 * real-run tables — see the workbench endpoint's no-write contract.
 */
export function SubmoduleWorkbench() {
  const [runId, setRunId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  const [submoduleId, setSubmoduleId] = useState<string | null>(null);
  const [entityName, setEntityName] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<WorkbenchExperimentResponse | null>(null);

  const { data: runs, isLoading: runsLoading } = useWorkbenchSourceRuns();
  const { data: tree } = useWorkbenchSourceRun(runId);
  const { data: allSubmodules } = useQuery({ queryKey: ['submodules-full'], queryFn: api.getSubmodulesFull });
  const experiment = useCreateWorkbenchExperiment();

  const step = tree?.steps.find((s) => s.step_index === stepIndex) || null;
  const stepSubmodule = step?.submodules.find((m) => m.submodule_id === submoduleId) || null;
  const manifest = allSubmodules?.find((m) => m.id === submoduleId) || null;

  // Resolved baseline exactly as the endpoint resolves it (defaults ← run config);
  // the user's edits layer on top and only the diff is sent as overrides.
  const baseline = useMemo<Record<string, unknown>>(
    () => ({ ...(manifest?.options_defaults || {}), ...(stepSubmodule?.options || {}) }),
    [manifest, stepSubmodule],
  );
  const values = useMemo(() => ({ ...baseline, ...edits }), [baseline, edits]);
  const overrides = useMemo(() => computeOverrides(baseline, values), [baseline, values]);

  const canRun = !!(runId && stepIndex != null && submoduleId && entityName) && !experiment.isPending;

  const selectRun = (id: string | null) => {
    setRunId(id); setStepIndex(null); setSubmoduleId(null); setEntityName(null); setEdits({}); setResult(null);
  };
  const selectStep = (i: number | null) => {
    setStepIndex(i); setSubmoduleId(null); setEntityName(null); setEdits({}); setResult(null);
  };
  const selectSubmodule = (id: string | null) => {
    setSubmoduleId(id); setEdits({}); setResult(null);
  };

  const run = () => {
    if (!canRun) return;
    setResult(null);
    experiment.mutate(
      {
        source_run_id: runId!,
        step_index: stepIndex!,
        submodule_id: submoduleId!,
        entity_name: entityName!,
        ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      },
      { onSuccess: (res) => setResult(res) },
    );
  };

  const selectClass =
    'w-full bg-white border border-gray-300 rounded px-3 py-2 text-gray-900 text-sm focus:outline-none focus:border-[#0891B2]';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Submodule Workbench</h2>
        <p className="text-sm text-gray-500 mt-1">
          Replay a submodule from a finished run with edited options. Experiments never touch real-run data.
        </p>
      </div>

      {/* Pickers */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
        <div>
          <label className="block text-xs text-gray-600 mb-1">Source run (terminal runs, newest first)</label>
          <select className={selectClass} value={runId ?? ''} onChange={(e) => selectRun(e.target.value || null)}>
            <option value="">{runsLoading ? 'Loading runs…' : 'Select a run…'}</option>
            {(runs || []).map((r) => (
              <option key={r.id} value={r.id}>
                {(r.project_name || r.id.slice(0, 8))}
                {r.entity_names.length > 0 ? ` — ${r.entity_names.slice(0, 3).join(', ')}${r.entity_names.length > 3 ? ` +${r.entity_names.length - 3}` : ''}` : ''}
                {r.started_at ? ` — ${new Date(r.started_at).toLocaleDateString()}` : ''} ({r.status})
              </option>
            ))}
          </select>
        </div>

        {tree && (
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">Step</label>
              <select className={selectClass} value={stepIndex ?? ''} onChange={(e) => selectStep(e.target.value === '' ? null : Number(e.target.value))}>
                <option value="">Select…</option>
                {tree.steps.map((s) => (
                  <option key={s.step_index} value={s.step_index}>Step {s.step_index}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Submodule</label>
              <select className={selectClass} value={submoduleId ?? ''} onChange={(e) => selectSubmodule(e.target.value || null)} disabled={!step}>
                <option value="">Select…</option>
                <optgroup label="In this run">
                  {(step?.submodules || []).map((m) => (
                    <option key={m.submodule_id} value={m.submodule_id}>{m.submodule_id}</option>
                  ))}
                </optgroup>
                {/* Any catalog submodule can replay against the step's pool
                    (endpoint resolves manifest defaults when the run has no
                    config for it) — e.g. tone-seo-editor on a run that never
                    configured it. */}
                <optgroup label="All submodules">
                  {(allSubmodules || [])
                    .filter((m) => !step?.submodules.some((s) => s.submodule_id === m.id))
                    .map((m) => (
                      <option key={m.id} value={m.id}>{m.id}</option>
                    ))}
                </optgroup>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Entity</label>
              <select className={selectClass} value={entityName ?? ''} onChange={(e) => { setEntityName(e.target.value || null); setResult(null); }} disabled={!step}>
                <option value="">Select…</option>
                {(step?.entities || []).map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Options */}
      {manifest && submoduleId && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-900">Options — {manifest.name}</h3>
            {Object.keys(overrides).length > 0 && (
              <button type="button" className="text-xs text-[#0891B2] hover:underline" onClick={() => setEdits({})}>
                Reset edits ({Object.keys(overrides).length} override{Object.keys(overrides).length === 1 ? '' : 's'})
              </button>
            )}
          </div>
          <SubmoduleOptions
            options={manifest.options}
            values={values}
            onChange={(name, value) => setEdits((prev) => ({ ...prev, [name]: value }))}
            projectId={tree?.project_id || ''}
            submoduleId={submoduleId}
          />
        </div>
      )}

      {/* Replay-fidelity caveat — sits directly above RUN so it's read before running */}
      {submoduleId && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
          <span className="font-semibold">Replay fidelity:</span> replays reconstruct the input from the
          <span className="font-mono"> current</span> pool state — revisions made after the original run are visible,
          so a replay is not a byte-frozen snapshot. Back-to-back experiment arms are comparable with each other;
          comparing a replay against the historical run&apos;s verdict is not sound.
        </div>
      )}

      {/* Run */}
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={run}
          disabled={!canRun}
          className={`px-6 py-2 rounded text-sm font-medium ${canRun ? 'bg-[#0891B2] text-white hover:bg-[#0E7490]' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
        >
          {experiment.isPending ? 'Running…' : 'RUN'}
        </button>
        {experiment.isPending && (
          <p className="text-sm text-gray-500 animate-pulse">
            Replaying {submoduleId} for {entityName}… LLM submodules can take several minutes (ceiling 15 min).
          </p>
        )}
      </div>

      {/* Transport-level failure (no experiment row came back) */}
      {experiment.isError && !result && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          Experiment failed: {experiment.error instanceof Error ? experiment.error.message : 'unknown error'}
        </div>
      )}

      {result && <ExperimentResult result={result} />}
    </div>
  );
}

function ExperimentResult({ result }: { result: WorkbenchExperimentResponse }) {
  const exp = result.experiment;
  const usage = exp.ai_usage || exp.output_data?.meta?.ai_usage || null;
  const meta = exp.output_data?.meta;
  const items = exp.output_data?.items || [];
  const failed = exp.status !== 'completed';
  const stopReasons = [...new Set((usage?.calls || []).map((c) => c.stop_reason).filter(Boolean))];

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-medium text-gray-900">Result</h3>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${failed ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
          {exp.status}
        </span>
        {meta?.truncated && (
          <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-800">truncated</span>
        )}
      </div>

      {/* status:'error' is a legitimate experiment outcome (e.g. truncation
          fail-closed), rendered as a result with its reason — not a crash. */}
      {(exp.error || meta?.error) && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-xs text-red-700">
          {exp.error || meta?.error}
        </div>
      )}

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div>
          <dt className="text-gray-400">Duration</dt>
          <dd className="text-gray-900 font-medium">{exp.duration_ms != null ? `${(exp.duration_ms / 1000).toFixed(1)}s` : '—'}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Tokens in / out</dt>
          <dd className="text-gray-900 font-medium">
            {usage ? `${usage.tokens_in_total.toLocaleString()} / ${usage.tokens_out_total.toLocaleString()}` : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-gray-400">Cache read / write</dt>
          <dd className="text-gray-900 font-medium">
            {usage ? `${usage.cache_read_tokens_total.toLocaleString()} / ${usage.cache_write_tokens_total.toLocaleString()}` : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-gray-400">Stop reason</dt>
          <dd className="text-gray-900 font-medium">{stopReasons.length > 0 ? stopReasons.join(', ') : '—'}</dd>
        </div>
      </dl>
      {/* Cost: ai_usage records tokens + model per call but no dollar figure — none stored, so none shown. */}

      {Object.keys(exp.overrides || {}).length > 0 && (
        <div>
          <p className="text-xs text-gray-400 mb-1">Overrides applied</p>
          <pre className="bg-gray-50 border border-gray-200 rounded p-2 text-[11px] text-gray-700 overflow-x-auto">
            {JSON.stringify(exp.overrides, null, 2)}
          </pre>
        </div>
      )}

      <div>
        <p className="text-xs text-gray-400 mb-1">Output items ({items.length})</p>
        {items.length === 0 ? (
          <p className="text-xs text-gray-400 italic">No items returned</p>
        ) : (
          <pre className="bg-gray-50 border border-gray-200 rounded p-2 text-[11px] text-gray-700 overflow-auto max-h-96">
            {JSON.stringify(items, null, 2)}
          </pre>
        )}
      </div>

      <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
        {result.replay_fidelity}
      </p>
    </div>
  );
}
