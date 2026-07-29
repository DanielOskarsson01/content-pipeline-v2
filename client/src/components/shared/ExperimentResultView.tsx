import type { WorkbenchExperimentResponse } from '../../types/step';

/**
 * Shared renderer for a workbench experiment result — used by the /workbench
 * view (SubmoduleWorkbench) and the run view's "Try it (doesn't save)" panel.
 * Lifted from SubmoduleWorkbench so both surfaces render results identically.
 *
 * status:'error' is a legitimate experiment outcome (e.g. the truncation
 * fail-closed guard in aiCallMeta.js), NOT a crash: it renders as a result
 * with status, truncated badge, stop_reason, tokens, duration and the error
 * text — never a bare "Unknown error".
 */
export function ExperimentResultView({ result }: { result: WorkbenchExperimentResponse }) {
  const exp = result.experiment;
  const usage = exp.ai_usage || exp.output_data?.meta?.ai_usage || null;
  const meta = exp.output_data?.meta;
  const items = exp.output_data?.items || [];
  const failed = exp.status !== 'completed';
  const stopReasons = [...new Set((usage?.calls || []).map((c) => c.stop_reason).filter(Boolean))];
  const errorText = exp.error || meta?.error
    || (failed ? `experiment ended with status '${exp.status}' — no error text recorded` : null);

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="text-sm font-medium text-gray-900">Result</h3>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${failed ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
          {exp.status}
        </span>
        {meta?.truncated && (
          <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-800">truncated</span>
        )}
      </div>

      {errorText && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-xs text-red-700">
          {errorText}
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
