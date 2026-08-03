import type { WorkbenchExperimentMetrics, WorkbenchAiUsage } from '../../types/step';

/**
 * The ONE experiment-metrics renderer — the server-computed `metrics` block
 * (server/lib/experimentMetrics.js) shown identically wherever an experiment's
 * numbers appear: the run view's Try-It result, the /workbench result, and the
 * step-10 tuning summary (one attempt at a time). No second metrics path.
 *
 * The summary carries ONLY `metrics` (no ai_usage); ExperimentResultView also
 * has the raw ai_usage — passed as a fallback so pre-metrics rows still show
 * tokens/cache rather than an all-dashes row.
 */
const fmtNum = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString());
const fmtCost = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(4)}`);

export function ExperimentMetrics({
  metrics,
  fallbackUsage,
  fallbackDurationMs,
}: {
  metrics: WorkbenchExperimentMetrics | null | undefined;
  fallbackUsage?: WorkbenchAiUsage | null;
  fallbackDurationMs?: number | null;
}) {
  const durationMs = metrics?.duration_ms ?? fallbackDurationMs ?? null;
  const tokensIn = metrics?.tokens_in ?? fallbackUsage?.tokens_in_total ?? null;
  const tokensOut = metrics?.tokens_out ?? fallbackUsage?.tokens_out_total ?? null;
  const cacheRead = metrics?.cache_read_tokens ?? fallbackUsage?.cache_read_tokens_total ?? null;
  const cacheWrite = metrics?.cache_write_tokens ?? fallbackUsage?.cache_write_tokens_total ?? null;
  const stopReason = metrics?.stop_reason
    ?? ([...new Set((fallbackUsage?.calls || []).map((c) => c.stop_reason).filter(Boolean))].join(', ') || null);

  // Content metrics only exist for text-producing arms (writer/editor/bundle) —
  // hide the whole row for checkers/non-AI modules where every field is null.
  const hasContent = metrics != null && (
    metrics.words != null || metrics.h2_sections != null
    || metrics.thin_sections != null || metrics.distinct_citations != null
  );

  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div>
          <dt className="text-gray-400">Duration</dt>
          <dd className="text-gray-900 font-medium">{durationMs != null ? `${(durationMs / 1000).toFixed(1)}s` : '—'}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Tokens in / out</dt>
          <dd className="text-gray-900 font-medium">{tokensIn != null || tokensOut != null ? `${fmtNum(tokensIn)} / ${fmtNum(tokensOut)}` : '—'}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Cache read / write</dt>
          <dd className="text-gray-900 font-medium">{cacheRead != null || cacheWrite != null ? `${fmtNum(cacheRead)} / ${fmtNum(cacheWrite)}` : '—'}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Cost</dt>
          <dd className="text-gray-900 font-medium">{fmtCost(metrics?.cost_usd)}</dd>
        </div>
      </dl>
      {hasContent && (
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <dt className="text-gray-400">Words</dt>
            <dd className="text-gray-900 font-medium">{fmtNum(metrics?.words)}</dd>
          </div>
          <div>
            <dt className="text-gray-400">H2 / thin sections</dt>
            <dd className="text-gray-900 font-medium">{fmtNum(metrics?.h2_sections)} / {fmtNum(metrics?.thin_sections)}</dd>
          </div>
          <div>
            <dt className="text-gray-400">Citations (distinct)</dt>
            <dd className="text-gray-900 font-medium">{fmtNum(metrics?.distinct_citations)}</dd>
          </div>
          <div>
            <dt className="text-gray-400">Broken refs</dt>
            <dd className="text-gray-900 font-medium">{fmtNum(metrics?.broken_refs)}</dd>
          </div>
        </dl>
      )}
      <p className="text-[11px] text-gray-400">Stop reason: {stopReason || '—'}</p>
    </div>
  );
}
