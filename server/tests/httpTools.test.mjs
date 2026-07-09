/**
 * Unit tests for the `tools.http` transport factory (server/lib/httpTools.js).
 *
 * No API, no DB, no network. `fetch` and `withTimeout` are injected so every
 * request/response is scripted and asserted in isolation. stageWorker.js cannot
 * be imported in a unit test (it starts a live BullMQ Worker at load), so the
 * http surface is extracted here — mirroring the applyDataOperation.js pattern.
 *
 * Run: node server/tests/httpTools.test.mjs
 *
 * Covers BACKLOG #45: PUT/PATCH verbs, binary-safe request+response, multipart.
 */
import {
  createHttp,
  prepareRequestBody,
  readResponseBody,
} from '../lib/httpTools.js';

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else            { failed++; console.log(`  ❌ ${label}`); }
}

// Fake fetch: records each request's (url, init) and returns a scripted response.
function makeFetch({ status = 200, headersObj = {}, textBody = '', arrayBufferBody = null, url } = {}) {
  const fetch = async (reqUrl, init = {}) => {
    fetch.calls.push({ url: reqUrl, init });
    return {
      status,
      url: url ?? reqUrl,
      headers: new Headers(headersObj),
      text: async () => textBody,
      arrayBuffer: async () => (arrayBufferBody ?? new TextEncoder().encode(textBody).buffer),
    };
  };
  fetch.calls = [];
  return fetch;
}

// Pass-through withTimeout that records the ms it was called with.
function makeWithTimeout() {
  const withTimeout = (fn, ms) => { withTimeout.ms.push(ms); return fn({ aborted: false }); };
  withTimeout.ms = [];
  return withTimeout;
}

const ctOf = (headers) => headers['Content-Type'] ?? headers['content-type'];

async function test_put_sendsJsonBody() {
  const fetch = makeFetch({ status: 200, textBody: '{"ok":true}', url: 'https://api.example.com/x' });
  const http = createHttp({ fetch, withTimeout: makeWithTimeout() });
  const res = await http.put('https://api.example.com/x', { a: 1 });
  const init = fetch.calls[0].init;
  assert(init.method === 'PUT', 'put → method PUT');
  assert(init.body === JSON.stringify({ a: 1 }), 'put → JSON-stringified body');
  assert(ctOf(init.headers) === 'application/json', 'put → default application/json');
  assert(res.status === 200 && res.body === '{"ok":true}', 'put → returns status + text body');
  assert(res.url === 'https://api.example.com/x', 'put → returns url');
}

async function test_patch_sendsPatchMethod() {
  const fetch = makeFetch({ status: 200, textBody: 'ok' });
  const http = createHttp({ fetch, withTimeout: makeWithTimeout() });
  await http.patch('u', { b: 2 });
  assert(fetch.calls[0].init.method === 'PATCH', 'patch → method PATCH');
  assert(fetch.calls[0].init.body === JSON.stringify({ b: 2 }), 'patch → JSON body');
}

async function test_post_backwardCompat() {
  const fetch = makeFetch({ status: 201, textBody: 'created' });
  const http = createHttp({ fetch, withTimeout: makeWithTimeout() });
  const res = await http.post('u', { x: 1 });
  assert(fetch.calls[0].init.method === 'POST', 'post → POST');
  assert(fetch.calls[0].init.body === JSON.stringify({ x: 1 }), 'post object → JSON body');
  assert(ctOf(fetch.calls[0].init.headers) === 'application/json', 'post object → application/json');
  assert(res.status === 201 && res.body === 'created', 'post → status + body');

  const fetch2 = makeFetch({ textBody: '' });
  const http2 = createHttp({ fetch: fetch2, withTimeout: makeWithTimeout() });
  await http2.post('u', '{"raw":true}');
  assert(fetch2.calls[0].init.body === '{"raw":true}', 'post string → passthrough body');
  assert(ctOf(fetch2.calls[0].init.headers) === 'application/json', 'post string → application/json default');
}

async function test_get_binaryResponse() {
  const bytes = new Uint8Array([0, 159, 146, 150, 255]); // includes non-UTF8 bytes
  const fetch = makeFetch({ arrayBufferBody: bytes.buffer });
  const http = createHttp({ fetch, withTimeout: makeWithTimeout() });
  const res = await http.get('u', { responseType: 'buffer' });
  assert(Buffer.isBuffer(res.body), 'get buffer → body is Buffer');
  assert(Buffer.compare(res.body, Buffer.from(bytes)) === 0, 'get buffer → exact bytes preserved');
}

async function test_post_binaryResponse() {
  const bytes = new Uint8Array([1, 2, 3, 250]);
  const fetch = makeFetch({ arrayBufferBody: bytes.buffer });
  const http = createHttp({ fetch, withTimeout: makeWithTimeout() });
  const res = await http.post('u', { q: 1 }, { responseType: 'arraybuffer' });
  assert(Buffer.isBuffer(res.body), 'post arraybuffer → Buffer body');
  assert(Buffer.compare(res.body, Buffer.from(bytes)) === 0, 'post arraybuffer → exact bytes');
}

async function test_put_binaryRequestBody() {
  const payload = Buffer.from([10, 20, 30, 240]);
  const fetch = makeFetch({ textBody: 'ok' });
  const http = createHttp({ fetch, withTimeout: makeWithTimeout() });
  await http.put('u', payload, { headers: { 'Content-Type': 'audio/mpeg' } });
  const init = fetch.calls[0].init;
  assert(init.body === payload, 'put Buffer → body passed through unchanged (not JSON)');
  assert(ctOf(init.headers) === 'audio/mpeg', 'put Buffer → caller Content-Type preserved');
}

async function test_post_binaryRequestBody_noJsonDefault() {
  const payload = Buffer.from([1, 2, 3]);
  const fetch = makeFetch({ textBody: '' });
  const http = createHttp({ fetch, withTimeout: makeWithTimeout() });
  await http.post('u', payload);
  assert(ctOf(fetch.calls[0].init.headers) === undefined, 'post Buffer w/o CT → no application/json injected');
}

async function test_post_formDataMultipart() {
  const form = new FormData();
  form.append('field', 'value');
  const fetch = makeFetch({ textBody: 'ok' });
  const http = createHttp({ fetch, withTimeout: makeWithTimeout() });
  await http.post('u', form);
  const init = fetch.calls[0].init;
  assert(init.body === form, 'post FormData → body is the FormData (fetch sets multipart boundary)');
  assert(ctOf(init.headers) === undefined, 'post FormData → no application/json injected');
}

async function test_headerOverride_caseInsensitive() {
  const fetch = makeFetch({ textBody: 'ok' });
  const http = createHttp({ fetch, withTimeout: makeWithTimeout() });
  await http.post('u', { a: 1 }, { headers: { 'content-type': 'application/xml' } });
  const h = fetch.calls[0].init.headers;
  assert(h['content-type'] === 'application/xml', 'override → caller CT preserved');
  assert(h['Content-Type'] === undefined, 'override → no duplicate application/json key added');
}

async function test_timeoutPassthrough() {
  const wt = makeWithTimeout();
  const http = createHttp({ fetch: makeFetch({ textBody: 'ok' }), withTimeout: wt });
  await http.get('u');
  assert(wt.ms[0] === 30000, 'get → default timeout 30000');
  await http.post('u', {}, { timeout: 5000 });
  assert(wt.ms[1] === 5000, 'post → custom timeout forwarded');
}

async function test_get_textDefault() {
  const fetch = makeFetch({ status: 200, textBody: 'hello', headersObj: { 'x-test': '1' } });
  const http = createHttp({ fetch, withTimeout: makeWithTimeout() });
  const res = await http.get('u');
  assert(typeof res.body === 'string' && res.body === 'hello', 'get default → text body');
  assert(res.headers['x-test'] === '1', 'get → headers flattened');
  assert(res.status === 200 && res.url === 'u', 'get → status + url');
}

async function test_head() {
  const fetch = makeFetch({ status: 204, headersObj: { 'content-length': '42' } });
  const http = createHttp({ fetch, withTimeout: makeWithTimeout() });
  const res = await http.head('u');
  assert(fetch.calls[0].init.method === 'HEAD', 'head → method HEAD');
  assert(!('body' in res), 'head → no body field');
  assert(res.headers['content-length'] === '42' && res.status === 204, 'head → status + headers');
}

async function test_post_urlSearchParams() {
  const params = new URLSearchParams({ grant_type: 'client_credentials' });
  const fetch = makeFetch({ textBody: 'ok' });
  const http = createHttp({ fetch, withTimeout: makeWithTimeout() });
  await http.post('u', params);
  const init = fetch.calls[0].init;
  assert(init.body === params, 'post URLSearchParams → passthrough (fetch sets urlencoded)');
  assert(ctOf(init.headers) === undefined, 'post URLSearchParams → no application/json injected');
}

function test_prepareRequestBody_units() {
  assert(prepareRequestBody(null).body === undefined, 'prepare(null) → undefined body');
  assert(prepareRequestBody(undefined).jsonDefault === false, 'prepare(undefined) → no json default');
  const u8 = new Uint8Array([1, 2]);
  assert(prepareRequestBody(u8).body === u8 && prepareRequestBody(u8).jsonDefault === false, 'prepare(Uint8Array) → passthrough, no json');
  const ab = new ArrayBuffer(4);
  assert(prepareRequestBody(ab).body === ab && prepareRequestBody(ab).jsonDefault === false, 'prepare(ArrayBuffer) → passthrough, no json');
  assert(prepareRequestBody('s').jsonDefault === true && prepareRequestBody('s').body === 's', 'prepare(string) → passthrough, json default true');
  assert(prepareRequestBody({ a: 1 }).body === '{"a":1}', 'prepare(object) → JSON string');
}

async function test_readResponseBody_units() {
  const fakeRes = { text: async () => 'txt', arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer };
  assert((await readResponseBody(fakeRes, undefined)) === 'txt', 'read default → text');
  const buf = await readResponseBody(fakeRes, 'buffer');
  assert(Buffer.isBuffer(buf) && buf[0] === 9, 'read buffer → Buffer');
}

async function run() {
  await test_put_sendsJsonBody();
  await test_patch_sendsPatchMethod();
  await test_post_backwardCompat();
  await test_get_binaryResponse();
  await test_post_binaryResponse();
  await test_put_binaryRequestBody();
  await test_post_binaryRequestBody_noJsonDefault();
  await test_post_formDataMultipart();
  await test_headerOverride_caseInsensitive();
  await test_timeoutPassthrough();
  await test_get_textDefault();
  await test_head();
  await test_post_urlSearchParams();
  test_prepareRequestBody_units();
  await test_readResponseBody_units();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
