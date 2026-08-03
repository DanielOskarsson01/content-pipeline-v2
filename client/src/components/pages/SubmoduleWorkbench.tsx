import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { usePanelStore } from '../../stores/panelStore';
import { computeOverrides } from '../../api/workbenchOverrides';
import { useWorkbenchSourceRuns, useWorkbenchSourceRun, useCreateWorkbenchExperiment, usePinWorkbenchRun, useRunWorkbenchChain, useWorkbenchChainTree } from '../../hooks/useWorkbench';
import { SubmoduleOptions } from '../primitives/SubmoduleOptions';
import { ExperimentResultView } from '../shared/ExperimentResultView';
import type { WorkbenchExperiment, WorkbenchExperimentResponse, WorkbenchChainResponse } from '../../types/step';

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
  const pinRun = usePinWorkbenchRun();
  const setLastExperiment = usePanelStore((s) => s.setLastExperiment);
  const selectedRun = (runs || []).find((r) => r.id === runId) || null;

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
      {
        onSuccess: (res) => {
          setResult(res);
          // Record for the run-view panel's U8 chaining affordance.
          const exp = res.experiment;
          setLastExperiment({
            id: exp.id,
            source_run_id: exp.source_run_id,
            submodule_id: exp.submodule_id,
            entity_name: exp.entity_name,
            status: exp.status,
          });
        },
      },
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
            {/* Entity names + date + time + short id — several runs of the same
                project on the same day must stay distinguishable. */}
            {(runs || []).map((r) => (
              <option key={r.id} value={r.id}>
                {(r.project_name || r.id.slice(0, 8))}
                {r.entity_names.length > 0 ? ` — ${r.entity_names.slice(0, 3).join(', ')}${r.entity_names.length > 3 ? ` +${r.entity_names.length - 3}` : ''}` : ''}
                {r.started_at ? ` — ${new Date(r.started_at).toLocaleDateString()} ${new Date(r.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
                {` — ${r.id.slice(0, 8)} (${r.status})`}
              </option>
            ))}
          </select>
          {/* T5: pin BEFORE experimenting — replayable runs keep vanishing to the
              7-day retention sweep; until now a run was only pinned as a side
              effect of its first experiment. */}
          {selectedRun && (
            selectedRun.status === 'archived' ? (
              <p className="text-[11px] text-gray-500 mt-1">Pinned — protected from the 7-day retention sweep.</p>
            ) : (
              <button
                type="button"
                onClick={() => pinRun.mutate(selectedRun.id)}
                disabled={pinRun.isPending}
                className="mt-1 text-xs text-[#0891B2] hover:underline disabled:opacity-50"
              >
                {pinRun.isPending ? 'Pinning…' : 'Pin this run (protect from the 7-day sweep)'}
              </button>
            )
          )}
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

      {result && <ExperimentResultView result={result} />}

      {/* A2: run the rest of the pipeline forward from this experiment */}
      {result && result.experiment.status === 'completed' && (
        <ForwardChainSection key={result.experiment.id} start={result.experiment} />
      )}
    </div>
  );
}

/**
 * A2 forward chain: launch steps N→M from a completed experiment, watch hops
 * appear, see the accumulated cost. Estimate first (dry run), then run under
 * a hard cost cap the server enforces (refuses rather than overspends).
 */
function ForwardChainSection({ start }: { start: WorkbenchExperiment }) {
  const [fromStep, setFromStep] = useState(Math.min(start.step_index + 1, 9));
  const [toStep, setToStep] = useState(8);
  const [maxCost, setMaxCost] = useState(3);
  const [estimate, setEstimate] = useState<WorkbenchChainResponse | null>(null);
  const [chainResult, setChainResult] = useState<WorkbenchChainResponse | null>(null);
  const [expandedHop, setExpandedHop] = useState<string | null>(null);
  // CTO A2 finding: the POST can outlive its connection (nginx timeout,
  // laptop sleep) while the server keeps executing and spending. A transport
  // error must NOT stop the progress view — keep polling and say the chain
  // may still be running server-side.
  const [transportLost, setTransportLost] = useState(false);
  // Critic F8: dry-run and real-run share the mutation — 'running' gates the
  // executing banner so an estimate round-trip never flashes it.
  const [running, setRunning] = useState(false);
  // Critic F2: GET /chains/:startId returns EVERY descendant of the start
  // (older chains, manual one-hop experiments). Only rows created after THIS
  // launch belong in the progress list.
  const [launchedAt, setLaunchedAt] = useState<string | null>(null);
  const chain = useRunWorkbenchChain();
  // While the POST is in flight, each finished hop is already a row — poll the
  // linked-list reconstruction so progress is visible mid-run.
  const { data: liveTree } = useWorkbenchChainTree(start.id, running || transportLost);
  const liveHops = (liveTree?.hops || []).filter(h => !launchedAt || h.created_at >= launchedAt);

  const estimateChain = () => {
    setEstimate(null);
    chain.mutate(
      { start_experiment_id: start.id, from_step: fromStep, to_step: toStep, max_cost_usd: maxCost, dry_run: true },
      { onSuccess: setEstimate },
    );
  };
  const runChain = () => {
    setChainResult(null);
    setTransportLost(false);
    setRunning(true);
    setLaunchedAt(new Date().toISOString());
    chain.mutate(
      { start_experiment_id: start.id, from_step: fromStep, to_step: toStep, max_cost_usd: maxCost },
      {
        onSuccess: (res) => { setChainResult(res); setTransportLost(false); },
        // Transport-level failure only (a refused/stopped chain still resolves
        // with chain_status): the server may still be executing — keep watching.
        onError: () => setTransportLost(true),
        onSettled: () => setRunning(false),
      },
    );
  };

  const inputClass = 'w-24 bg-white border border-gray-300 rounded px-2 py-1 text-sm text-gray-900 focus:outline-none focus:border-[#0891B2]';
  const statusColor: Record<string, string> = {
    completed: 'text-green-700', dry_run: 'text-gray-700',
    stopped_error: 'text-red-700', refused_cost_cap: 'text-amber-700',
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
      <h3 className="text-sm font-medium text-gray-900">
        Forward chain from {start.submodule_id} <span className="text-gray-400">({start.id.slice(0, 8)})</span>
      </h3>
      <p className="text-xs text-gray-500">
        Runs each configured submodule for steps {fromStep}–{toStep} as chained experiments (siblings within a
        step share the same input; step 7&apos;s routing verdict is reported but never gates the chain, matching
        production). Writes only workbench_experiments rows.
      </p>
      <div className="flex items-end gap-3 flex-wrap">
        <label className="text-xs text-gray-600">From step<br />
          <input type="number" min={1} max={9} className={inputClass} value={fromStep} onChange={(e) => setFromStep(Number(e.target.value))} />
        </label>
        <label className="text-xs text-gray-600">To step<br />
          <input type="number" min={1} max={9} className={inputClass} value={toStep} onChange={(e) => setToStep(Number(e.target.value))} />
        </label>
        <label className="text-xs text-gray-600">Cost cap (USD)<br />
          <input type="number" min={0.01} step={0.5} className={inputClass} value={maxCost} onChange={(e) => setMaxCost(Number(e.target.value))} />
        </label>
        <button type="button" onClick={estimateChain} disabled={chain.isPending}
          className="px-3 py-1.5 rounded text-sm border border-[#0891B2] text-[#0891B2] hover:bg-cyan-50 disabled:opacity-50">
          Estimate cost
        </button>
        <button type="button" onClick={runChain} disabled={chain.isPending}
          className={`px-4 py-1.5 rounded text-sm font-medium ${chain.isPending ? 'bg-gray-200 text-gray-400' : 'bg-[#0891B2] text-white hover:bg-[#0E7490]'}`}>
          {chain.isPending ? 'Chain running…' : 'RUN FORWARD CHAIN'}
        </button>
      </div>

      {estimate && (
        <div className="bg-gray-50 border border-gray-200 rounded p-3 text-xs text-gray-700">
          <span className="font-semibold">Estimate:</span> ${estimate.estimate_total_usd.toFixed(2)} across{' '}
          {estimate.planned_hops.length} hops —{' '}
          {estimate.planned_hops.map((h) => `${h.step_index}:${h.submodule_id} ($${h.estimate_usd.toFixed(2)})`).join(', ')}
          {estimate.estimate_total_usd > maxCost && (
            <span className="text-amber-700 font-medium">
              {' '}— estimates exceed the ${maxCost} cap: the chain will refuse before the hop that crosses it
              (cheaper earlier hops still run and bill).
            </span>
          )}
          {(estimate.warnings || []).map((w: string) => (
            <p key={w} className="text-amber-700 mt-1">⚠ {w}</p>
          ))}
        </div>
      )}

      {running && (
        <div className="bg-cyan-50 border border-cyan-200 rounded p-3 text-sm text-cyan-900">
          <p className="font-semibold animate-pulse">Forward chain executing — cap ${maxCost.toFixed(2)}.</p>
          <p className="text-xs mt-1">Each LLM hop can take minutes (per-hop ceiling 15 min). Completed hops so far:</p>
          <ul className="text-xs mt-1 space-y-0.5">
            {liveHops.map((h) => (
              <li key={h.experiment_id}>
                step {h.step_index} · {h.submodule_id} · {h.status} · ${h.cost_usd.toFixed(4)}
              </li>
            ))}
            {liveHops.length === 0 && <li className="text-cyan-700">starting…</li>}
          </ul>
        </div>
      )}

      {chain.isError && !transportLost && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
          Chain failed: {chain.error instanceof Error ? chain.error.message : 'unknown error'}
        </div>
      )}

      {transportLost && (
        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800">
          <p className="font-semibold">Connection to the chain request was lost — the server may still be executing (and spending, up to the ${maxCost.toFixed(2)} cap).</p>
          <p className="text-xs mt-1">Completed hops keep appearing below as rows land. The final chain verdict is lost with the connection; the last hop&apos;s status tells you how far it got.</p>
          <ul className="text-xs mt-1 space-y-0.5">
            {liveHops.map((h) => (
              <li key={h.experiment_id}>step {h.step_index} · {h.submodule_id} · {h.status} · ${h.cost_usd.toFixed(4)}</li>
            ))}
          </ul>
          <button type="button" className="mt-2 text-xs text-amber-700 underline" onClick={() => setTransportLost(false)}>
            Stop watching
          </button>
        </div>
      )}

      {chainResult && (
        <div className="space-y-2">
          <p className={`text-sm font-medium ${statusColor[chainResult.chain_status] || 'text-gray-900'}`}>
            Chain {chainResult.chain_status.replace('_', ' ')} — {chainResult.hops.length} hop{chainResult.hops.length === 1 ? '' : 's'},
            ${chainResult.totals.cost_usd.toFixed(4)}, {chainResult.totals.tokens_in.toLocaleString()} in / {chainResult.totals.tokens_out.toLocaleString()} out tokens,
            {' '}{Math.round(chainResult.totals.duration_ms / 1000)}s
          </p>
          {chainResult.stop && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">{chainResult.stop.reason}</p>
          )}
          <div className="border border-gray-200 rounded divide-y divide-gray-100">
            {chainResult.hops.map((h) => (
              <div key={h.experiment_id || `${h.step_index}:${h.submodule_id}`}>
                <button
                  type="button"
                  onClick={() => setExpandedHop(expandedHop === h.experiment_id ? null : h.experiment_id)}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 flex items-center gap-3"
                >
                  <span className={`font-medium ${h.status === 'completed' ? 'text-green-700' : 'text-red-700'}`}>
                    step {h.step_index} · {h.submodule_id}
                  </span>
                  <span className="text-gray-500">${h.cost_usd.toFixed(4)} · {Math.round((h.duration_ms || 0) / 1000)}s</span>
                  <span className="text-gray-500 truncate">
                    {Object.entries(h.summary).map(([k, v]) => `${k}=${String(v)}`).join(' · ')}
                  </span>
                  {h.overlay_warning && <span className="text-amber-600" title={h.overlay_warning}>⚠</span>}
                </button>
                {expandedHop === h.experiment_id && h.experiment && (
                  <div className="p-3 bg-gray-50">
                    {/* Critic F3: parent_experiment_id is the LINKED-LIST
                        predecessor (a sibling the hop never read). What the
                        hop actually consumed is read_from — list it, and hand
                        the result chip read_from[0] (the artifact under test). */}
                    <p className="text-[11px] text-gray-500 mb-2">
                      read from: {h.read_from.map((id) => id.slice(0, 8)).join(' → ')}
                    </p>
                    <ExperimentResultView
                      result={{
                        experiment: h.experiment,
                        replay_fidelity: '',
                        source: 'chained',
                        chain: {
                          parent_experiment_id: h.read_from[0],
                          pool_items_dropped: h.pool_items_dropped ?? 0,
                          pool_items_kept: h.pool_items_kept ?? 0,
                        },
                      }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
