'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.resolve(__dirname, '..', 'bin', 'kdna-remote-server.js');

test('--print-machine-fingerprint prints a canonical 64-hex fingerprint', () => {
  const result = spawnSync(process.execPath, [BIN, '--print-machine-fingerprint'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^[0-9a-f]{64}$/);
});
