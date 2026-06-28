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
 * file is append-only; rotation is the deployer's responsibility.
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

function appendAudit(event, auditLogPath) {
  const target = auditLogPath || DEFAULT_AUDIT_LOG;
  const record = {
    timestamp: new Date().toISOString(),
    server: '@aikdna/kdna-remote-server',
    server_version: require('../package.json').version,
    ...event,
  };
  // Strip forbidden fields if the caller accidentally included
  // them. Defensive scrub: the server must never log secrets.
  for (const forbidden of ['license_key', 'decrypted_content', 'ciphertext', 'plaintext', 'key']) {
    if (forbidden in record) delete record[forbidden];
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch (e) {
    // Audit write failure MUST NOT block the projection. Per
    // SPEC.md §13.1 layer isolation: audit is best-effort.
  }
}

module.exports = { appendAudit, DEFAULT_AUDIT_LOG };
