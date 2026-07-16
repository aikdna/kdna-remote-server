/**
 * audit.js — projection server audit log (Story 18)
 *
 * Per docs/REMOTE_MODE.md §"Self-hosting requirements" for the
 * projection server, the server MUST "Emit audit events per
 * specs/kdna-entitlement-api.md §Audit — without plaintext".
 *
 * Per specs/kdna-entitlement-api.md §11, audit events MUST NOT
 * include:
 *   - license_key
 *   - decrypted KDNA content
 *   - ciphertext
 *   - raw machine fingerprint (unless enterprise policy requires)
 *
 * This module writes one JSON object per line to the configured
 * audit log file (default ~/.kdna/remote-server-audit.jsonl). The
 * file is append-only; rotation is the deployer's responsibility. The caller
 * receives an exact persistence result so a successful projection can fail
 * closed when its audit evidence cannot be committed.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_AUDIT_LOG = path.join(
  os.homedir(),
  '.kdna',
  'remote-server-audit.jsonl',
);
const FORBIDDEN_AUDIT_KEYS = new Set([
  'licensekey',
  'machinefingerprint',
  'decryptedcontent',
  'ciphertext',
  'plaintext',
  'key',
]);

function appendAudit(event, auditLogPath) {
  const target = auditLogPath || DEFAULT_AUDIT_LOG;
  let descriptor = null;
  try {
    const record = {
      timestamp: new Date().toISOString(),
      server: '@aikdna/kdna-remote-server',
      server_version: require('../package.json').version,
      ...scrubSecrets(event),
    };
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    descriptor = fs.openSync(
      target,
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const targetStat = fs.fstatSync(descriptor);
    if (!targetStat.isFile() || targetStat.nlink !== 1) {
      throw new Error('audit target is not one regular file');
    }
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The persistence result has already failed closed or been committed.
      }
    }
  }
}

function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (FORBIDDEN_AUDIT_KEYS.has(normalizedKey)) continue;
    out[key] = scrubSecrets(child);
  }
  return out;
}

module.exports = { appendAudit, DEFAULT_AUDIT_LOG, scrubSecrets };
