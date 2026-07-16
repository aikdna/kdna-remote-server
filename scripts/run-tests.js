#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const testFiles = fs.readdirSync(path.join(root, 'tests'))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => `tests/${name}`);
const commands = Object.freeze([
  ['scripts/check-public-surface.js'],
  ['scripts/check-protocol-names.js'],
  ['scripts/check-runtime-candidate.js'],
  ['--test', ...testFiles],
]);

function main() {
  for (const args of commands) {
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    });
    if (result.error || result.signal != null || result.status !== 0) {
      throw new Error(`test stage failed: ${args.join(' ')}`);
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Test orchestration rejected: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main };
