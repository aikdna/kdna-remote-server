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

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const MACHINE_FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const LICENSE_ID_RE = /^[A-Za-z0-9_\-:.]{1,128}$/;
const MAX_ACTIVATION_RESPONSE_BYTES = 64 * 1024;

function machineFingerprint() {
  const parts = [os.hostname(), String(os.userInfo().uid), os.platform(), os.arch()];
  if (os.platform() === 'linux') {
    try {
      const machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
      if (machineId) parts.push(machineId);
    } catch {
      // The stable OS/user tuple remains available in minimal containers.
    }
  } else if (os.platform() === 'darwin') {
    const result = spawnSync('/usr/sbin/ioreg', ['-d2', '-c', 'IOPlatformExpertDevice'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 3000,
    });
    if (!result.error && result.status === 0 && result.signal == null) {
      const uuid = result.stdout.match(/"IOPlatformUUID"\s*=\s*"([A-F0-9-]{36})"/)?.[1];
      if (uuid) parts.push(uuid);
    }
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function activationEndpoint(activationUrl) {
  if (typeof activationUrl !== 'string' || activationUrl.length === 0) {
    throw new Error('activation server URL is required');
  }
  let parsed;
  try {
    parsed = new URL(activationUrl);
  } catch {
    throw new Error('activation server URL must be an absolute canonical URL');
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (activationUrl !== parsed.origin && activationUrl !== `${parsed.origin}/`)
  ) {
    throw new Error('activation server URL must be an origin without credentials, path, query, or fragment');
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('activation server must use HTTPS except for an exact loopback development origin');
  }
  return `${parsed.origin}/entitlements/sync`;
}

async function readActivationResponse(res) {
  const contentType = res.headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    return { httpStatus: res.status, body: null, invalid: true };
  }
  const contentLength = res.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(0|[1-9]\d*)$/.test(contentLength) || Number(contentLength) > MAX_ACTIVATION_RESPONSE_BYTES) {
      return { httpStatus: res.status, body: null, invalid: true };
    }
  }
  if (!res.body) return { httpStatus: res.status, body: null, invalid: true };
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ACTIVATION_RESPONSE_BYTES) {
        await reader.cancel();
        return { httpStatus: res.status, body: null, invalid: true };
      }
      chunks.push(Buffer.from(value));
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    const body = JSON.parse(text);
    return { httpStatus: res.status, body, invalid: false };
  } catch {
    return { httpStatus: res.status, body: null, invalid: true };
  } finally {
    reader.releaseLock();
  }
}

function verifyEntitlement({
  activationUrl,
  kdnaId,
  licenseKey,
  licenseId,
  machineFingerprint: suppliedMachineFingerprint,
}) {
  if (!activationUrl) {
    return Promise.resolve({
      ok: false,
      status: 500,
      error: { code: 'NO_ACTIVATION_SERVER', message: 'activation server URL not configured' },
    });
  }
  let url;
  try {
    url = activationEndpoint(activationUrl);
  } catch {
    return Promise.resolve({
      ok: false,
      status: 500,
      error: {
        code: 'INVALID_ACTIVATION_SERVER',
        message: 'activation server configuration is not safe',
      },
    });
  }
  if (!licenseKey) {
    return Promise.resolve({
      ok: false,
      status: 400,
      error: {
        code: 'MISSING_LICENSE_KEY',
        message: 'license_key is required for entitlement verification',
      },
    });
  }
  if (licenseId != null && !LICENSE_ID_RE.test(licenseId)) {
    return Promise.resolve({
      ok: false,
      status: 400,
      error: {
        code: 'INVALID_LICENSE_ID',
        message: 'license_id is not canonical',
      },
    });
  }
  if (!MACHINE_FINGERPRINT_RE.test(suppliedMachineFingerprint || '')) {
    return Promise.resolve({
      ok: false,
      status: 500,
      error: {
        code: 'REMOTE_MACHINE_IDENTITY_INVALID',
        message: 'remote runtime machine identity is unavailable',
      },
    });
  }

  // The activation server's sync endpoint is used for the
  // refresh path. For a one-shot projection call we POST a
  // minimal request body — domain plus license_key and optional license_id —
  // and the server replies with the current entitlement record.
  const body = JSON.stringify({
    domain: kdnaId,
    ...(licenseKey ? { license_key: licenseKey } : {}),
    ...(licenseId ? { license_id: licenseId } : {}),
    machine_fingerprint: suppliedMachineFingerprint,
    client: 'kdna-remote-server',
    client_version: require('../package.json').version,
  });

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    redirect: 'error',
    // No retries; the server should treat failure as 502.
    signal: AbortSignal.timeout(5000),
  })
    .then(readActivationResponse)
    .then(({ httpStatus, body, invalid }) => {
      // Activation server responds with the entitlement record.
      // Status "active" + revoked:false → ok.
      // Anything else → fail closed.
      if (invalid) {
        return {
          ok: false,
          status: 502,
          error: {
            code: 'ACTIVATION_SERVER_BAD_RESPONSE',
            message: 'activation server returned an invalid response',
          },
        };
      }
      if (httpStatus !== 200) {
        return {
          ok: false,
          status: 403,
          error: {
            code: 'ENTITLEMENT_DENIED',
            message: 'activation server denied the entitlement',
          },
        };
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return {
          ok: false,
          status: 502,
          error: {
            code: 'ACTIVATION_SERVER_BAD_RESPONSE',
            message: 'activation server returned an invalid response',
          },
        };
      }
      if (
        typeof body.license_id !== 'string' ||
        !LICENSE_ID_RE.test(body.license_id) ||
        body.domain !== kdnaId ||
        (licenseId && body.license_id !== licenseId) ||
        body.require_machine_binding !== true ||
        body.machine_fingerprint !== suppliedMachineFingerprint
      ) {
        return {
          ok: false,
          status: 502,
          error: {
            code: 'ACTIVATION_SERVER_CONTRACT_MISMATCH',
            message: 'activation server response does not match the requested authorization',
          },
        };
      }
      if (body.revoked === true) {
        return {
          ok: false,
          status: 403,
          error: {
            code: 'LICENSE_REVOKED',
            message: 'license has been revoked',
          },
        };
      }
      if (body.status !== 'active' || body.revoked !== false) {
        if (typeof body.status === 'string' && body.status !== 'active' && body.revoked === false) {
          return {
            ok: false,
            status: 403,
            error: {
              code: 'LICENSE_NOT_ACTIVE',
              message: 'license is not active',
            },
          };
        }
        return {
          ok: false,
          status: 502,
          error: {
            code: 'ACTIVATION_SERVER_CONTRACT_MISMATCH',
            message: 'activation server response does not match the requested authorization',
          },
        };
      }
      return {
        ok: true,
        status: 200,
        entitlement: {
          license_id: body.license_id,
          domain: body.domain,
          status: body.status,
          revoked: false,
          require_machine_binding: true,
        },
      };
    })
    .catch(() => ({
      ok: false,
      status: 502,
      error: {
        code: 'ACTIVATION_SERVER_UNREACHABLE',
        message: 'activation server could not be reached',
      },
    }));
}

module.exports = {
  LICENSE_ID_RE,
  MAX_ACTIVATION_RESPONSE_BYTES,
  MACHINE_FINGERPRINT_RE,
  activationEndpoint,
  verifyEntitlement,
  machineFingerprint,
};
