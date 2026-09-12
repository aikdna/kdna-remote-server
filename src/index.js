import { createReferenceHost, readResultResponse, KDNAWebServerError } from '@aikdna/kdna-web-server';

const OPTION_KEYS = new Set(['assetBytes', 'bindingId', 'authorizationDomainId', 'verifyContext', 'resolveContext',
  'observePolicy', 'hostId', 'clock', 'ttlMs', 'maxReads', 'maxInputBytes', 'maxResponseBytes',
  'admissionResponseBytes', 'policyTimeoutMs', 'maxRequestBytes', 'requestTimeoutMs', 'deliveryTimeoutMs']);
const UNAVAILABLE = new Set(['/activate', '/load', '/execute', '/export', '/plan', '/plan-load', '/projection']);
const typedByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const errorResponse = (code, status) => new Response(JSON.stringify({ error: { code } }), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
function limit(value, fallback, maximum) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) throw new TypeError('Invalid Remote limit.');
  return selected;
}
function fail(code, status = 400) { throw new KDNAWebServerError(code, status); }
function readBody(req, maximum, timeoutMs, signal) {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    req.pause(); return Promise.reject(new KDNAWebServerError('REMOTE_REQUEST_TOO_LARGE', 413));
  }
  return new Promise((resolve, reject) => {
    let total = 0; const chunks = [];
    const finish = (error, value) => {
      clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', bad);
      req.off('aborted', abort); signal.removeEventListener('abort', abort);
      if (error) { req.pause(); reject(error); } else resolve(value);
    };
    const data = chunk => { total += chunk.length;
      if (total > maximum) finish(new KDNAWebServerError('REMOTE_REQUEST_TOO_LARGE', 413)); else chunks.push(chunk); };
    const end = () => finish(null, Buffer.concat(chunks, total));
    const bad = () => finish(new KDNAWebServerError('REMOTE_REQUEST_INVALID', 400));
    const abort = () => finish(new KDNAWebServerError('HOST_REQUEST_ABORTED', 408));
    const timer = setTimeout(() => finish(new KDNAWebServerError('REMOTE_REQUEST_TIMEOUT', 408)), timeoutMs);
    req.on('data', data); req.once('end', end); req.once('error', bad); req.once('aborted', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
async function send(res, response, timeoutMs) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (res.destroyed || res.writableEnded) return false;
  return new Promise(resolve => {
    let settled = false;
    const done = ok => { if (settled) return; settled = true; clearTimeout(timer);
      res.off('finish', finish); res.off('close', close); res.off('error', close); resolve(ok); };
    const finish = () => done(true), close = () => done(false);
    const timer = setTimeout(() => { done(false); res.destroy(); }, timeoutMs);
    res.once('finish', finish); res.once('close', close); res.once('error', close);
    try { res.statusCode = response.status; response.headers.forEach((v, k) => res.setHeader(k, v)); res.end(bytes); }
    catch { done(false); if (!res.destroyed) res.destroy(); }
  });
}

/** One bounded, server-owned asset/context binding. No credential verifier is supplied by Remote. */
export function createRemoteReadHandler(options = {}) {
  if (!options || typeof options !== 'object' || Object.keys(options).some(k => !OPTION_KEYS.has(k))) {
    throw new TypeError('Unsupported Remote configuration.');
  }
  if (!(options.assetBytes instanceof Uint8Array)) throw new TypeError('assetBytes must be server-owned bytes.');
  const maxInputBytes = limit(options.maxInputBytes, 10 * 1024 * 1024, 10 * 1024 * 1024);
  if (typedByteLength.call(options.assetBytes) > maxInputBytes) throw new TypeError('Asset exceeds input limit.');
  for (const key of ['verifyContext', 'resolveContext', 'observePolicy', 'clock']) {
    if (options[key] !== undefined && typeof options[key] !== 'function') throw new TypeError('Invalid server-owned provider.');
  }
  const asset = new Uint8Array(options.assetBytes);
  const maximum = limit(options.maxRequestBytes, 64 * 1024, 64 * 1024);
  const requestTimeout = limit(options.requestTimeoutMs, 5000, 30000);
  const deliveryTimeout = limit(options.deliveryTimeoutMs, 5000, 30000);
  const maxReads = limit(options.maxReads, 16, 16);
  const resolveContext = options.resolveContext;
  const host = createReferenceHost({
    hostId: options.hostId, clock: options.clock, observePolicy: options.observePolicy,
    maxInputBytes, maxResponseBytes: options.maxResponseBytes, admissionResponseBytes: options.admissionResponseBytes,
    policyTimeoutMs: options.policyTimeoutMs, maxReads,
    retainedSession: { binding_id: options.bindingId, authorization_domain_id: options.authorizationDomainId,
      verifyContext: options.verifyContext ?? (() => false), ttlMs: options.ttlMs, maxReads },
  });
  let active = false, attempts = 0, disposed = false;
  const dispose = () => { disposed = true; asset.fill(0); host.dispose(); };
  const handler = async (req, res) => {
    let sent = false, ownsActive = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!res.writableFinished) abort(); };
    res.once('close', close); res.once('error', abort); req.once('aborted', abort);
    try {
      // Exact path: query strings and caller-selected operation overrides are unsupported.
      if (UNAVAILABLE.has(req.url)) fail('REMOTE_CAPABILITY_UNAVAILABLE', 501);
      if (req.url !== '/read') fail('REMOTE_ROUTE_NOT_FOUND', 404);
      if (req.method !== 'POST') fail('REMOTE_METHOD_NOT_ALLOWED', 405);
      if (disposed || host.retentionState().state === 'closed') fail('HOST_SESSION_CLOSED', 410);
      if (attempts >= maxReads) { dispose(); fail('HOST_SESSION_EXHAUSTED', 429); }
      attempts++;
      if (active) fail('HOST_BUSY', 429);
      active = true; ownsActive = true;
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('REMOTE_JSON_REQUIRED', 415);
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail('REMOTE_ENCODING_UNSUPPORTED', 415);
      const bytes = await readBody(req, maximum, requestTimeout, controller.signal);
      let candidate;
      try { candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { fail('REMOTE_JSON_INVALID'); }
      // Never infer a formal request from the removed task/axiom interface.
      if (candidate && typeof candidate === 'object' && ['task', 'axiom', 'axioms'].some(k => Object.hasOwn(candidate, k))) {
        fail('REMOTE_LEGACY_TASK_UNSUPPORTED', 501);
      }
      const context = { then(resolve, reject) { Promise.resolve().then(() => resolveContext?.(req)).then(resolve, reject); } };
      const result = await host.read(asset, candidate, { context, signal: controller.signal,
        async deliverResponse(prepared) {
          const response = readResultResponse(prepared);
          sent = true;
          return send(res, response, deliveryTimeout);
        },
      });
      if (!sent && !res.destroyed) { sent = true; await send(res, readResultResponse(result), deliveryTimeout); }
      // Trusted local observation only; the HTTP body is the exact public Host response.
      return result;
    } catch (error) {
      if (!sent && !res.destroyed) {
        const known = error instanceof KDNAWebServerError;
        res.setHeader('connection', 'close'); sent = true;
        await send(res, errorResponse(known ? error.code : 'REMOTE_INTERNAL_ERROR', known ? error.status : 500), deliveryTimeout);
      } else if (!res.writableFinished && !res.destroyed) res.destroy();
      return undefined;
    } finally {
      if (ownsActive) active = false;
      res.off('close', close); res.off('error', abort); req.off('aborted', abort);
    }
  };
  return Object.freeze(Object.defineProperties(handler, {
    dispose: { value: dispose }, retentionState: { value: () => host.retentionState() },
  }));
}
