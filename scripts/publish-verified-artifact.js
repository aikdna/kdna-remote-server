#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveTrustedNpmInvocation } = require('./runtime-candidate-binding');
const { assertCurrentReleaseBinding, validateEvidenceArtifact } = require('./release-evidence');

const root = path.resolve(__dirname, '..');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
  const evidencePath = argument('--evidence');
  const artifactArgument = argument('--artifact');
  if (!evidencePath || !artifactArgument || process.argv.length !== 6) {
    throw new Error('usage: publish-verified-artifact.js --evidence <json> --artifact <tgz>');
  }
  const artifactPath = path.resolve(artifactArgument);
  const evidence = JSON.parse(fs.readFileSync(path.resolve(evidencePath), 'utf8'));
  validateEvidenceArtifact(evidence, fs.readFileSync(artifactPath));
  assertCurrentReleaseBinding(root, evidence);
  const npm = resolveTrustedNpmInvocation(root);
  let result;
  try {
    result = spawnSync(
      npm.command,
      [
        ...npm.prefixArgs,
        'publish',
        artifactPath,
        '--ignore-scripts',
        '--provenance',
        '--access',
        'public',
        '--registry=https://registry.npmjs.org/',
        '--@aikdna:registry=https://registry.npmjs.org/',
      ],
      { stdio: 'inherit', shell: false },
    );
  } finally {
    npm.cleanup();
  }
  if (result.error || result.status !== 0 || result.signal != null) {
    throw new Error('verified package publication failed');
  }
}

try {
  main();
} catch (error) {
  console.error(`Verified artifact publication rejected: ${error.message}`);
  process.exitCode = 1;
}
