/**
 * kdna-remote-server — self-hostable HTTP projection server (Story 18)
 *
 * Implements specs/kdna-runtime-projection.md and the self-hosting
 * invariant from docs/REMOTE_MODE.md:
 *
 *  - Holds ONE .kdna asset locally at startup; never fetches
 *    assets from the network at request time.
 *  - Returns a task projection — never the full payload.
 *  - Verifies entitlement on every request (or runs in --dry-run
 *    mode for local development without an activation server).
 *  - Rate-limits projection calls; detects extraction patterns;
 *    refuses to return complete axiom sets in one response.
 *  - Emits audit events without plaintext.
 *  - Requires zero KDNA Inc. registration to start.
 *
 * Layer isolation: the server never adds content-trust claims
 * like "official", "trusted", "recommended", "high_quality" to
 * its response. Per SPEC §13.1 and KDNA_TRUST_BOUNDARY.md,
 * "trust" is not a Core-emitted property; it is not a server-
 * emitted property either. The server's job is to serve a
 * projection, not to certify the projection.
 *
 * This file is the HTTP layer. Projection logic lives in
 * `./projection.js`. Entitlement verification lives in
 * `./entitlement.js`. Audit log lives in `./audit.js`.
 */

'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const crypto = require('node:crypto');
const { selectProjection } = require('./projection');
const { verifyEntitlement } = require('./entitlement');
const { appendAudit } = require('./audit');

/**
 * Build the HTTP request handler.
 *
 * @param {object} opts
 * @param {object} opts.asset          — the loaded asset (from kdna-core's loadAuthorized)
 * @param {string} opts.activationUrl — activation server URL (or null for --dry-run)
 * @param {boolean} opts.dryRun       — bypass entitlement verification
 * @param {object} [opts.auditLog]    — audit log path (default ~/.kdna/remote-server-audit.jsonl)
 * @param {number} [opts.rateLimitMs] — minimum gap between requests from same client (default 100ms)
 * @returns {Function} (req, res) => void
 */
function makeRequestHandler(opts) {
  if (!opts.asset) throw new Error('asset is required');
  const asset = opts.asset;
  const activationUrl = opts.activationUrl || null;
  const dryRun = Boolean(opts.dryRun);
  const rateLimitMs = typeof opts.rateLimitMs === 'number' ? opts.rateLimitMs : 100;
  const lastSeen = new Map(); // clientKey -> last request timestamp

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const clientKey = req.socket.remoteAddress || 'unknown';

    // Health check (always 200, no audit)
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, {
        ok: true,
        server: '@aikdna/kdna-remote-server',
        version: require('../package.json').version,
        asset: {
          asset_id: asset.asset_id || null,
          title: asset.title || null,
          version: asset.version || null,
        },
        projection_policy: 'remote',
        dry_run: dryRun,
      });
      return;
    }

    // Asset metadata (introspection; no judgment content)
    if (req.method === 'GET' && url.pathname === '/asset/metadata') {
      json(res, 200, {
        ok: true,
        asset: {
          asset_id: asset.asset_id || null,
          title: asset.title || null,
          version: asset.version || null,
          access: asset.access || 'remote',
        },
        projection_policy: 'remote',
      });
      return;
    }

    // Projection endpoint
    if (req.method === 'POST' && url.pathname === '/project') {
      // Rate limit per client
      const now = Date.now();
      const last = lastSeen.get(clientKey) || 0;
      if (now - last < rateLimitMs) {
        appendAudit({
          event: 'projection',
          result: 'rate_limited',
          client: clientKey,
          asset_id: asset.asset_id,
        }, opts.auditLog);
        jsonError(res, 429, 'RATE_LIMITED', 'too many requests; slow down');
        return;
      }
      lastSeen.set(clientKey, now);

      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) {
          req.destroy();
          jsonError(res, 413, 'REQUEST_TOO_LARGE', 'request body exceeds 64KB');
        }
      });
      req.on('end', async () => {
        let payload;
        try {
          payload = body.length === 0 ? {} : JSON.parse(body);
        } catch (e) {
          appendAudit({
            event: 'projection',
            result: 'invalid_json',
            client: clientKey,
            asset_id: asset.asset_id,
          }, opts.auditLog);
          jsonError(res, 400, 'INVALID_JSON', `request body is not valid JSON: ${e.message}`);
          return;
        }

        const kdnaId = typeof payload.kdna_id === 'string' ? payload.kdna_id : null;
        const licenseKey = typeof payload.license_key === 'string' ? payload.license_key : null;
        const licenseId = typeof payload.license_id === 'string' ? payload.license_id : null;
        const task = typeof payload.task === 'string' ? payload.task : '';
        const context = typeof payload.context === 'string' ? payload.context : '';
        const mode = typeof payload.mode === 'string' ? payload.mode : 'judge';

        if (!task) {
          appendAudit({
            event: 'projection',
            result: 'missing_task',
            client: clientKey,
            asset_id: asset.asset_id,
          }, opts.auditLog);
          jsonError(res, 400, 'MISSING_TASK', 'task field is required');
          return;
        }

        // Extraction-pattern detection (best-effort, heuristic)
        const extractionFlag = detectExtractionAttempt(payload);
        if (extractionFlag) {
          appendAudit({
            event: 'projection',
            result: 'extraction_blocked',
            client: clientKey,
            asset_id: asset.asset_id,
            signal: extractionFlag,
          }, opts.auditLog);
          jsonError(
            res,
            403,
            'EXTRACTION_BLOCKED',
            `request pattern flagged as extraction attempt: ${extractionFlag}`,
          );
          return;
        }

        // Entitlement check (skip in dry-run)
        if (!dryRun) {
          try {
            const result = await verifyEntitlement({
              activationUrl,
              kdnaId: kdnaId || asset.asset_id,
              licenseKey,
              licenseId,
            });
            if (!result.ok) {
              appendAudit({
                event: 'projection',
                result: 'entitlement_denied',
                client: clientKey,
                asset_id: asset.asset_id,
                reason: result.error && result.error.code,
              }, opts.auditLog);
              jsonError(
                res,
                result.status || 403,
                (result.error && result.error.code) || 'ENTITLEMENT_DENIED',
                (result.error && result.error.message) || 'entitlement not valid',
              );
              return;
            }
          } catch (e) {
            appendAudit({
              event: 'projection',
              result: 'activation_server_error',
              client: clientKey,
              asset_id: asset.asset_id,
              reason: e.message,
            }, opts.auditLog);
            jsonError(res, 502, 'ACTIVATION_SERVER_ERROR', e.message);
            return;
          }
        }

        // Build the projection. Never include the full payload.
        const projection = selectProjection(asset, { task, context, mode });

        const traceId = crypto.randomUUID();
        appendAudit({
          event: 'projection',
          result: 'success',
          client: clientKey,
          asset_id: asset.asset_id,
          task,
          mode,
          trace_id: traceId,
        }, opts.auditLog);

        json(res, 200, {
          task_projection: projection,
          projection_policy: 'remote',
          trace_id: traceId,
          asset_id: asset.asset_id,
          asset_version: asset.version,
        });
      });
      return;
    }

    // Unknown route
    jsonError(res, 404, 'NOT_FOUND', `no handler for ${req.method} ${url.pathname}`);
  }

  return handle;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2) + '\n');
}

function jsonError(res, status, code, message) {
  json(res, status, { ok: false, error: { code, message, retryable: false } });
}

/**
 * Best-effort extraction-pattern detection. The rules in
 * specs/kdna-runtime-projection.md §5 say we should detect
 * extraction-like patterns and refuse them. This is a small
 * heuristic; it is not a security boundary, but it raises the
 * bar for accidental bulk extraction.
 */
function detectExtractionAttempt(payload) {
  const s = JSON.stringify(payload).toLowerCase();
  if (/\ball axioms\b/.test(s)) return 'asks_for_all_axioms';
  if (/\bentire\b|\bcomplete\b|\bfull list\b|\bwhole\b/.test(s)) return 'asks_for_full_content';
  if (/\bdump\b|\bexport\b|\bdownload\b/.test(s)) return 'asks_for_dump';
  if (/\bextract.*all\b|\bextract.*every\b/.test(s)) return 'asks_to_extract_all';
  if (payload.context && payload.context.length > 4096) return 'oversized_context';
  return null;
}

/**
 * Start the server. Returns the listening port (useful when
 * `--port 0` is passed for tests).
 */
function startServer(opts = {}) {
  return new Promise((resolve, reject) => {
    const handler = makeRequestHandler(opts);
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(typeof opts.port === 'number' ? opts.port : 0, opts.host || '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port, host: addr.address });
    });
  });
}

/**
 * Stop the server. Resolves once the server is closed.
 */
function stopServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

module.exports = {
  makeRequestHandler,
  startServer,
  stopServer,
  detectExtractionAttempt,
  json,
  jsonError,
};
