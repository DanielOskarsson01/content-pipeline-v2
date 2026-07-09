/**
 * HTTP transport factory for the submodule `tools.http` surface.
 *
 * Extracted from stageWorker.js::buildTools so the transport is unit-testable in
 * isolation — stageWorker.js starts a live BullMQ Worker at import and cannot be
 * loaded in a unit test. Mirrors the applyDataOperation.js extraction pattern.
 *
 * PIPELINE-AGNOSTIC: pure transport, no content-type/domain assumptions.
 *
 * Capabilities (BACKLOG #45):
 *   - Verbs: get, head, post, put, patch
 *   - Binary-safe response: pass options.responseType = 'buffer' | 'arraybuffer'
 *       to receive a Node Buffer instead of a decoded string (default stays text).
 *   - Binary-safe request: Buffer / Uint8Array / ArrayBuffer / DataView bodies
 *       are sent as-is (not JSON-stringified). Set Content-Type via options.headers.
 *   - Multipart: pass a FormData (or Blob) body — fetch sets multipart/form-data
 *       with the boundary; no application/json is injected.
 *
 * @param {object} deps
 * @param {typeof fetch} deps.fetch - injected fetch (real global in prod, fake in tests)
 * @param {(fn: (signal: AbortSignal) => Promise<any>, ms: number) => Promise<any>} deps.withTimeout
 * @returns {{ get: Function, head: Function, post: Function, put: Function, patch: Function }}
 */

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Serialize a request body and decide whether the JSON Content-Type default applies.
 *
 * String and plain-object bodies keep the legacy behavior (application/json default;
 * objects are JSON-stringified). Binary and streaming body types are passed through
 * untouched so fetch can send them correctly (and, for FormData, set its own boundary).
 *
 * @returns {{ body: any, jsonDefault: boolean }}
 */
export function prepareRequestBody(body) {
  if (body === undefined || body === null) {
    return { body: undefined, jsonDefault: false };
  }
  if (typeof body === 'string') {
    return { body, jsonDefault: true };
  }
  // Binary payloads — send raw, never JSON-encode.
  if (Buffer.isBuffer(body) || ArrayBuffer.isView(body) || body instanceof ArrayBuffer) {
    return { body, jsonDefault: false };
  }
  // Streaming / multipart / urlencoded bodies — let fetch set the Content-Type.
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return { body, jsonDefault: false };
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return { body, jsonDefault: false };
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return { body, jsonDefault: false };
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return { body, jsonDefault: false };
  }
  // Plain object → JSON.
  return { body: JSON.stringify(body), jsonDefault: true };
}

/**
 * Read a fetch Response body honoring options.responseType.
 * 'buffer' / 'arraybuffer' → Node Buffer (binary-safe). Otherwise decoded text.
 */
export async function readResponseBody(res, responseType) {
  if (responseType === 'buffer' || responseType === 'arraybuffer') {
    return Buffer.from(await res.arrayBuffer());
  }
  return res.text();
}

/**
 * Clone caller headers and apply the application/json default only when the body
 * warrants it AND the caller has not already set a Content-Type (case-insensitive).
 */
export function applyJsonContentType(headers, jsonDefault) {
  const merged = { ...(headers || {}) };
  if (jsonDefault) {
    const hasContentType = Object.keys(merged).some((k) => k.toLowerCase() === 'content-type');
    if (!hasContentType) merged['Content-Type'] = 'application/json';
  }
  return merged;
}

export function createHttp({ fetch, withTimeout }) {
  async function sendWithBody(method, url, body, options = {}) {
    const timeout = options.timeout || DEFAULT_TIMEOUT_MS;
    const { body: preparedBody, jsonDefault } = prepareRequestBody(body);
    const headers = applyJsonContentType(options.headers, jsonDefault);
    return withTimeout(async (signal) => {
      const res = await fetch(url, { method, signal, headers, body: preparedBody });
      const responseBody = await readResponseBody(res, options.responseType);
      return { status: res.status, headers: Object.fromEntries(res.headers), body: responseBody, url: res.url };
    }, timeout);
  }

  return {
    get: async (url, options = {}) => {
      const timeout = options.timeout || DEFAULT_TIMEOUT_MS;
      return withTimeout(async (signal) => {
        const res = await fetch(url, { signal, headers: options.headers || {} });
        const body = await readResponseBody(res, options.responseType);
        return { status: res.status, headers: Object.fromEntries(res.headers), body, url: res.url };
      }, timeout);
    },
    head: async (url, options = {}) => {
      const timeout = options.timeout || DEFAULT_TIMEOUT_MS;
      return withTimeout(async (signal) => {
        const res = await fetch(url, { method: 'HEAD', signal, headers: options.headers || {} });
        return { status: res.status, headers: Object.fromEntries(res.headers), url: res.url };
      }, timeout);
    },
    post: (url, body, options) => sendWithBody('POST', url, body, options),
    put: (url, body, options) => sendWithBody('PUT', url, body, options),
    patch: (url, body, options) => sendWithBody('PATCH', url, body, options),
  };
}
