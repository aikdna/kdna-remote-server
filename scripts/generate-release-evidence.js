#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveTrustedNpmInvocation } = require('./runtime-candidate-binding');
const {
  assertCurrentReleaseBinding,
  buildEvidence,
  exportReleaseCommitTree,
} = require('./release-evidence');

const root = path.resolve(__dirname, '..');

function fail(message) {
  throw new Error(message);
}

function runNpm(npm, args, cwd = root) {
  const result = spawnSync(npm.command, [...npm.prefixArgs, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0 || result.signal != null || result.stderr !== '') {
    fail('trusted npm pack invocation failed');
  }
  return result.stdout;
}

function packOnce(npm, destination, sourceRoot = root) {
  const stdout = runNpm(npm, [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    destination,
    '--registry=https://registry.npmjs.org/',
    '--@aikdna:registry=https://registry.npmjs.org/',
  ], sourceRoot);
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    fail('npm pack output must be one complete JSON document');
  }
  if (!Array.isArray(report) || report.length !== 1 || !report[0]?.filename) {
    fail('npm pack must report exactly one artifact');
  }
  return {
    report,
    bytes: fs.readFileSync(path.join(destination, report[0].filename)),
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
  const output = argument('--out');
  const artifact = argument('--artifact');
  if (!output || !artifact || process.argv.length !== 6) {
    fail('usage: generate-release-evidence.js --out <outside-repository> --artifact <outside-repository>');
  }
  const outputPath = path.resolve(output);
  const artifactPath = path.resolve(artifact);
  for (const candidate of [outputPath, artifactPath]) {
    const relative = path.relative(root, candidate);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      fail('release outputs must be outside the repository');
    }
  }
  if (outputPath === artifactPath) fail('release evidence and artifact paths must differ');
  const source = assertCurrentReleaseBinding(root);
  const npm = resolveTrustedNpmInvocation(root);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remote-release-'));
  let complete = false;
  try {
    const firstDir = path.join(temporary, 'first');
    const secondDir = path.join(temporary, 'second');
    const sourceDir = path.join(temporary, 'source');
    fs.mkdirSync(firstDir);
    fs.mkdirSync(secondDir);
    fs.mkdirSync(sourceDir);
    exportReleaseCommitTree(root, source.commit, sourceDir);
    const first = packOnce(npm, firstDir, sourceDir);
    const second = packOnce(npm, secondDir, sourceDir);
    if (!first.bytes.equals(second.bytes)) fail('two npm pack runs produced different bytes');
    const evidence = buildEvidence({ report: first.report, tarball: first.bytes, source });
    fs.writeFileSync(artifactPath, first.bytes, { flag: 'wx' });
    fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    complete = true;
  } finally {
    npm.cleanup();
    fs.rmSync(temporary, { recursive: true, force: true });
    if (!complete) {
      fs.rmSync(outputPath, { force: true });
      fs.rmSync(artifactPath, { force: true });
    }
  }
  console.log('Verified release evidence and artifact created.');
}

try {
  main();
} catch (error) {
  console.error(`Release evidence rejected: ${error.message}`);
  process.exitCode = 1;
}
