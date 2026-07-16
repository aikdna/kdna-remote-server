#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveTrustedNpmInvocation } = require('./runtime-candidate-binding');

const root = path.resolve(__dirname, '..');

function main(args = process.argv.slice(2)) {
  if (args.length === 0) throw new Error('trusted npm command is required');
  const npm = resolveTrustedNpmInvocation(root);
  let result;
  try {
    result = spawnSync(npm.command, [...npm.prefixArgs, ...args], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    });
  } finally {
    npm.cleanup();
  }
  if (result.error || result.signal != null || result.status !== 0) {
    throw new Error('trusted npm command failed');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Trusted npm command rejected: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main };
