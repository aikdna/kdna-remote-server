#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const stages = Object.freeze([
  'scripts/verify-release-context.cjs',
  'scripts/release-readiness.js',
  'scripts/run-tests.js',
]);

function main() {
  for (const script of stages) {
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    });
    if (result.error || result.signal != null || result.status !== 0) {
      throw new Error(`release check failed: ${script}`);
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Release check rejected: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main };
