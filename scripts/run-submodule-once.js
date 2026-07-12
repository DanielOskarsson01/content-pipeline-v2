/**
 * One-shot submodule harness — sub-plan 4 prerequisite (V5 Verification amendment 4).
 *
 * Runs a single submodule's execute() directly with a constructed tools object
 * (logger, http, ai), bypassing BullMQ + entity_stage_pool + the step-approval
 * cycle. Purpose: validate v2-card prompts against reference entities for the
 * sub-plan-4 ENTRY GATE without ~5x-slower full-pipeline runs.
 *
 * Faithful to production: reuses the SAME module loader (moduleLoader), the SAME
 * #21 cache helper (buildCachedUserContent) and SSE parser (parseAnthropicSSE),
 * the SAME MODEL_MAP, and the SAME execute() input/options/result contract as
 * server/workers/stageWorker.js. (The ai.complete orchestration is mirrored from
 * stageWorker rather than imported — stageWorker starts a live BullMQ Worker on
 * import. A future shared ai-client extraction would remove this one duplication.)
 *
 * Usage (CLI):
 *   node --env-file=.env scripts/run-submodule-once.js spec.json [--out result.json]
 *
 * spec.json:
 *   {
 *     "submodule_id": "content-writer",
 *     "entity": { "name": "Acme", "items": [ { "text_content": "...", "analysis_json": {...} } ] },
 *     "options": { "ai_model": "haiku", "temperature": 0.4 },          // merged over manifest defaults
 *     "prompt_override": { "mode": "merge_sections", "sections": { "tone": "..." } },  // optional
 *     "reference_docs": { "format_spec.md": "<content>", "tone_guide.md": "<content>" } // optional; resolves {doc:...}
 *   }
 *
 * Programmatic: `import { runSubmoduleOnce } from './scripts/run-submodule-once.js'`.
 */

import path from 'path';
import { pathToFileURL } from 'url';
import { readFileSync, writeFileSync } from 'fs';
import { loadModules, getSubmoduleById } from '../server/services/moduleLoader.js';
import { buildCachedUserContent } from '../server/services/promptCache.js';
import { parseAnthropicSSE } from '../server/services/aiStream.js';
import { applyPromptOverride } from '../server/utils/promptOverrides.js';

// Mirror of stageWorker.MODEL_MAP — keep in sync (adding a model is one line).
const MODEL_MAP = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-5-20250929',
  opus: 'claude-opus-4-6',
  'gpt-4o-mini': 'gpt-4o-mini',
  'gpt-4o': 'gpt-4o',
  sonar: 'sonar',
  'sonar-pro': 'sonar-pro',
};

const AI_REQUEST_TIMEOUT_MS = 600_000;
const RETRYABLE = new Set([429, 500, 502, 503, 529]);

function withTimeout(fn, ms) {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { controller.abort(); reject(new Error(`request timed out after ${ms}ms`)); }, ms);
    fn(controller.signal).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Build a tools object faithful to stageWorker.buildTools, minus DB progress writes. */
function buildHarnessTools(submoduleId, logs) {
  const log = (level, message) => { console.error(`[${submoduleId}] ${message}`); logs.push({ level, message }); };
  const logger = { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) };

  const http = {
    get: async (url, o = {}) => withTimeout(async (signal) => {
      const res = await fetch(url, { signal, headers: o.headers || {} });
      return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text(), url: res.url };
    }, o.timeout || 30000),
    head: async (url, o = {}) => withTimeout(async (signal) => {
      const res = await fetch(url, { method: 'HEAD', signal, headers: o.headers || {} });
      return { status: res.status, headers: Object.fromEntries(res.headers), url: res.url };
    }, o.timeout || 30000),
    post: async (url, body, o = {}) => withTimeout(async (signal) => {
      const res = await fetch(url, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', ...(o.headers || {}) },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
    }, o.timeout || 30000),
  };

  const progress = { update: () => {}, get lastTotal() { return 1; } };

  const ai = {
    complete: async ({ prompt, model = 'haiku', provider = 'anthropic', temperature, max_tokens, cache_prefix }) => {
      const modelId = MODEL_MAP[model] || model;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const started = Date.now();
          if (provider === 'anthropic') {
            const apiKey = process.env.ANTHROPIC_API_KEY;
            if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in environment');
            const streamed = await withTimeout(async (signal) => {
              const res = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST', signal,
                headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({
                  model: modelId, max_tokens: max_tokens ?? 16384, stream: true,
                  messages: [{ role: 'user', content: buildCachedUserContent(prompt, cache_prefix) }],
                  ...(temperature != null && { temperature }),
                }),
              });
              if (res.status !== 200) { const e = new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 400)}`); e.statusCode = res.status; throw e; }
              return parseAnthropicSSE(res.body);
            }, AI_REQUEST_TIMEOUT_MS);
            return {
              text: streamed.text || '', tokens_in: streamed.tokens_in || 0, tokens_out: streamed.tokens_out || 0,
              cache_write_tokens: streamed.cache_creation_input_tokens || 0, cache_read_tokens: streamed.cache_read_input_tokens || 0,
              model: modelId, provider, stop_reason: streamed.stop_reason || 'unknown', duration_ms: Date.now() - started,
            };
          }
          // openai / perplexity (non-streamed), mirroring stageWorker
          const endpoints = { openai: 'https://api.openai.com/v1/chat/completions', perplexity: 'https://api.perplexity.ai/chat/completions' };
          const keys = { openai: 'OPENAI_API_KEY', perplexity: 'PERPLEXITY_API_KEY' };
          const apiKey = process.env[keys[provider]];
          if (!apiKey) throw new Error(`${keys[provider]} not set in environment`);
          const { status, body } = await withTimeout(async (signal) => {
            const res = await fetch(endpoints[provider], {
              method: 'POST', signal,
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
              body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: prompt }], ...(max_tokens && { max_tokens }), ...(temperature != null && { temperature }) }),
            });
            return { status: res.status, body: await res.text() };
          }, AI_REQUEST_TIMEOUT_MS);
          if (status !== 200) { const e = new Error(`${provider} ${status}: ${body.slice(0, 400)}`); e.statusCode = status; throw e; }
          const data = JSON.parse(body);
          return { text: data.choices?.[0]?.message?.content || '', tokens_in: data.usage?.prompt_tokens || 0, tokens_out: data.usage?.completion_tokens || 0, model: modelId, provider, duration_ms: Date.now() - started };
        } catch (err) {
          if (attempt < 3 && (err.statusCode == null || RETRYABLE.has(err.statusCode))) {
            await new Promise((r) => setTimeout(r, 2000 * attempt));
            continue;
          }
          throw err;
        }
      }
    },
  };

  return { logger, http, progress, ai, _partialItems: [] };
}

async function loadExecuteFunction(manifest) {
  const mod = await import(pathToFileURL(path.join(manifest._path, 'execute.js')).href);
  const fn = mod.default || mod;
  if (typeof fn !== 'function') throw new Error(`execute.js in ${manifest.id} does not export a function`);
  return fn;
}

/**
 * Run one submodule once.
 * @param {{submodule_id:string, entity:{name:string,items:any[]}, options?:object, prompt_override?:object, reference_docs?:Record<string,string>}} spec
 */
export async function runSubmoduleOnce(spec) {
  if (!spec?.submodule_id) throw new Error('spec.submodule_id is required');
  if (!spec?.entity?.name) throw new Error('spec.entity.name is required (entity = { name, items })');

  loadModules();
  const manifest = getSubmoduleById(spec.submodule_id);
  if (!manifest) throw new Error(`Submodule '${spec.submodule_id}' not found (is MODULES_PATH set / does it exist?)`);

  const executeFn = await loadExecuteFunction(manifest);

  // options = manifest defaults <- spec.options, plus reference docs map for {doc:...}
  const options = { ...(manifest.options_defaults || {}), ...(spec.options || {}) };
  if (spec.reference_docs) options.reference_docs = { ...(options.reference_docs || {}), ...spec.reference_docs };

  // Resolve prompt_override against the base prompt (spec.options.prompt or manifest default).
  let promptInfo = null;
  if (spec.prompt_override) {
    const basePrompt = options.prompt ?? '';
    promptInfo = applyPromptOverride(basePrompt, spec.prompt_override);
    options.prompt = promptInfo.prompt;
  }

  const logs = [];
  const tools = buildHarnessTools(spec.submodule_id, logs);
  const input = {
    entities: [{ name: spec.entity.name, items: spec.entity.items || [] }],
    run_id: 'harness-once',
    step_index: manifest.step ?? 0,
    submodule_id: spec.submodule_id,
  };

  const result = await executeFn(input, options, tools);
  return { submodule_id: spec.submodule_id, version: manifest.version, resolvedPrompt: options.prompt, promptInfo, result, logs };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const specPath = args.find((a) => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  if (!specPath) {
    console.error('usage: node --env-file=.env scripts/run-submodule-once.js <spec.json> [--out result.json]');
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  try {
    const out = await runSubmoduleOnce(spec);
    const items = out.result?.results?.[0]?.items || out.result?.results || [];
    console.error('\n──────── HARNESS RESULT ────────');
    console.error(`submodule: ${out.submodule_id} v${out.version}`);
    if (out.promptInfo) {
      console.error(`prompt_override: mode=${out.promptInfo.mode} applied=[${out.promptInfo.appliedSections}] missing=[${out.promptInfo.missingSections}]`);
      out.promptInfo.warnings.forEach((w) => console.error(`  ⚠ ${w}`));
    }
    console.error(`summary: ${JSON.stringify(out.result?.summary || {})}`);
    console.error(`result items: ${Array.isArray(items) ? items.length : 'n/a'}`);
    if (outPath) { writeFileSync(outPath, JSON.stringify(out, null, 2)); console.error(`→ wrote ${outPath}`); }
    else { console.log(JSON.stringify(out, null, 2)); }
  } catch (err) {
    console.error(`\n❌ harness failed: ${err.message}`);
    process.exit(1);
  }
}
