/**
 * LIVE E2E GATE — LLM provider stub (harness, NOT product code).
 *
 * Loaded via `node --import ./server/tests/harness/llm_fetch_stub.mjs <entry>`.
 * Monkey-patches globalThis.fetch to intercept ONLY the three LLM provider
 * hostnames (api.anthropic.com / api.openai.com / api.perplexity.ai) and return
 * a deterministic canned completion. Every other fetch (localhost auto-executor
 * callbacks, tools.http QA URL checks, Supabase REST) passes through to the real
 * fetch untouched. This is the OUTERMOST provider seam — it sits above
 * tools.ai.complete and above stageWorker's provider branch, so ALL engine +
 * worker + module + DB code runs for real; only the model call is faked.
 *
 * Why product code is untouched: stageWorker.js is FROZEN. This patches the
 * global fetch the frozen code already calls, so no product edit is required.
 *
 * The canned text carries ZERO square-bracket markers on purpose:
 *   - citation-coverage-checker (step 6) auto-fails an article with no inline
 *     [#n] citations → deterministic citation:fail → drives multi-card routing.
 *   - tone-seo-editor's W1.5 marker-preservation gate finds no markers in the
 *     input → passes trivially, so the round-2 editor succeeds and pools output.
 */

const realFetch = globalThis.fetch;
const PROVIDER_HOSTS = ['api.anthropic.com', 'api.openai.com', 'api.perplexity.ai'];

const STUB_TEXT =
  '# Stub Article\n\n' +
  'This content is produced by the live-e2e LLM stub. It deliberately contains ' +
  'no inline citations, so the citation QA check fails deterministically and the ' +
  'multi-card routing path is exercised. LLM_STUB_MARKER.\n\n' +
  '## Section Two\n\n' +
  'A second section so word_count and section_count are non-zero for the pipeline.';

function anthropicSSE(text) {
  const enc = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
  const frames = [
    enc({ type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } }),
    enc({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    enc({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    enc({ type: 'content_block_stop', index: 0 }),
    enc({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } }),
    enc({ type: 'message_stop' }),
  ];
  return (async function* () { for (const f of frames) yield f; })();
}

globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : (url && url.url) || String(url);
  const host = PROVIDER_HOSTS.find((h) => u.includes(h));
  if (!host) return realFetch(url, opts);

  if (host === 'api.anthropic.com') {
    // stageWorker checks res.status then reads res.body as an async iterable.
    return { status: 200, ok: true, body: anthropicSSE(STUB_TEXT) };
  }
  // openai / perplexity JSON shape (these modules default to anthropic, but be safe)
  const json = JSON.stringify({
    choices: [{ message: { content: STUB_TEXT } }],
    usage: { prompt_tokens: 12, completion_tokens: 40 },
    citations: [],
  });
  return { status: 200, ok: true, text: async () => json };
};

console.error(`[llm_fetch_stub] global fetch patched; intercepting: ${PROVIDER_HOSTS.join(', ')}`);
