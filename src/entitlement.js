/**
 * entitlement.js — entitlement verification for the projection server (Story 18)
 *
 * Per docs/REMOTE_MODE.md, the projection server MUST verify
 * entitlement on every request. The default is to call the
 * activation server's `/entitlements/sync` endpoint (defined
 * in specs/kdna-entitlement-api.md §7) and require `status:
 * "active"`.
 *
 * In --dry-run mode, this function is bypassed entirely.
 *
 * The activation server is identified by the same URL the kdna-cli
 * uses for `kdna license sync`. The protocol does not hardcode
 * any KDNA Inc. URL; the deployer sets it at startup.
 */

'use strict';

function verifyEntitlement({ activationUrl, kdnaId, licenseKey, licenseId }) {
  if (!activationUrl) {
    return Promise.resolve({
      ok: false,
      status: 500,
      error: { code: 'NO_ACTIVATION_SERVER', message: 'activation server URL not configured' },
    });
  }
  if (!licenseKey && !licenseId) {
    return Promise.resolve({
      ok: false,
      status: 400,
      error: {
        code: 'MISSING_ENTITLEMENT_IDENTIFIER',
        message: 'license_key or license_id is required for entitlement verification',
      },
    });
  }

  // The activation server's sync endpoint is used for the
  // refresh path. For a one-shot projection call we POST a
  // minimal request body — domain plus license_key or license_id —
  // and the server replies with the current entitlement record.
  const url = joinUrl(activationUrl, '/entitlements/sync');
  const body = JSON.stringify({
    domain: kdnaId,
    ...(licenseKey ? { license_key: licenseKey } : {}),
    ...(licenseId ? { license_id: licenseId } : {}),
    client: 'kdna-remote-server',
    client_version: require('../package.json').version,
  });

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    // No retries; the server should treat failure as 502.
    signal: AbortSignal.timeout(5000),
  })
    .then((res) => res.json().then((j) => ({ httpStatus: res.status, body: j })))
    .then(({ httpStatus, body }) => {
      // Activation server responds with the entitlement record.
      // Status "active" + revoked:false → ok.
      // Anything else → fail closed.
      if (httpStatus !== 200) {
        return {
          ok: false,
          status: 403,
          error: {
            code: (body && body.error && body.error.code) || 'ENTITLEMENT_DENIED',
            message:
              (body && body.error && body.error.message) ||
              `activation server returned HTTP ${httpStatus}`,
          },
        };
      }
      if (!body || typeof body !== 'object') {
        return {
          ok: false,
          status: 502,
          error: { code: 'ACTIVATION_SERVER_BAD_RESPONSE', message: 'non-JSON body' },
        };
      }
      if (body.status !== 'active' || body.revoked === true) {
        return {
          ok: false,
          status: 403,
          error: {
            code: body.revoked ? 'LICENSE_REVOKED' : 'LICENSE_NOT_ACTIVE',
            message: `license status is "${body.status || 'unknown'}"`,
          },
        };
      }
      return { ok: true, status: 200, entitlement: body };
    })
    .catch((e) => ({
      ok: false,
      status: 502,
      error: { code: 'ACTIVATION_SERVER_UNREACHABLE', message: e.message },
    }));
}

function joinUrl(base, path) {
  if (!base) return path;
  if (base.endsWith('/') && path.startsWith('/')) return base + path.slice(1);
  if (!base.endsWith('/') && !path.startsWith('/')) return base + '/' + path;
  return base + path;
}

module.exports = { verifyEntitlement, joinUrl };
