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
  const artifactPath = argument('--artifact');
  if (!evidencePath || !artifactPath || process.argv.length !== 6) {
    throw new Error('usage: registry-duplicate-guard.js --evidence <json> --artifact <tgz>');
  }
  const evidence = JSON.parse(fs.readFileSync(path.resolve(evidencePath), 'utf8'));
  validateEvidenceArtifact(evidence, fs.readFileSync(path.resolve(artifactPath)));
  assertCurrentReleaseBinding(root, evidence);
  const npm = resolveTrustedNpmInvocation(root);
  const spec = `${evidence.package.name}@${evidence.package.version}`;
  let result;
  try {
    result = spawnSync(
      npm.command,
      [
        ...npm.prefixArgs,
        'view',
        spec,
        'name',
        'version',
        'dist.integrity',
        'dist.shasum',
        '--json',
        '--loglevel=silent',
        '--registry=https://registry.npmjs.org/',
        '--@aikdna:registry=https://registry.npmjs.org/',
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024, shell: false, timeout: 30_000 },
    );
  } finally {
    npm.cleanup();
  }
  if (result.error || result.signal != null || ![0, 1].includes(result.status)) {
    throw new Error('registry lookup did not complete safely');
  }
  let decision;
  if (result.status === 1) {
    let body;
    try {
      body = JSON.parse(result.stdout);
    } catch {
      throw new Error('registry absence response was not exact JSON');
    }
    if (body?.error?.code !== 'E404') throw new Error('registry lookup failure was not package absence');
    decision = { shouldPublish: true, name: 'publish' };
  } else {
    if (result.stderr !== '') throw new Error('successful registry lookup wrote unexpected stderr');
    let metadata;
    try {
      metadata = JSON.parse(result.stdout);
    } catch {
      throw new Error('registry metadata was not exact JSON');
    }
    const keys = Object.keys(metadata || {}).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['dist.integrity', 'dist.shasum', 'name', 'version'])) {
      throw new Error('registry metadata fields are not exact');
    }
    if (
      metadata.name !== evidence.package.name ||
      metadata.version !== evidence.package.version ||
      metadata['dist.integrity'] !== evidence.artifact.integrity ||
      metadata['dist.shasum'] !== evidence.artifact.shasum
    ) {
      throw new Error('registry version collides with different artifact bytes');
    }
    decision = { shouldPublish: false, name: 'skip-identical' };
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `should_publish=${decision.shouldPublish ? 'true' : 'false'}\ndecision=${decision.name}\n`,
    );
  }
  console.log(`Registry duplicate policy: ${decision.name}`);
}

try {
  main();
} catch (error) {
  console.error(`Registry duplicate policy rejected: ${error.message}`);
  process.exitCode = 1;
}
