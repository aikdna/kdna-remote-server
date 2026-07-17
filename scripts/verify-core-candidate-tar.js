#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  resolveTrustedNpmInvocation,
  verifyCandidateBinding,
} = require('./runtime-candidate-binding');
const { readPinnedCoreCommit } = require('./core-candidate');
const { exactCommitFiles, gitAuthority } = require('./git-authority');

const ROOT = path.resolve(__dirname, '..');
const CORE_NAME = '@aikdna/kdna-core';
const CORE_VERSION = '0.20.0';
const CORE_SUBDIRECTORY = path.join('packages', 'kdna-core');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  assert.equal(result.error, undefined, 'candidate source command failed to start');
  assert.equal(result.signal, null, 'candidate source command was interrupted');
  assert.equal(result.status, 0, 'candidate source command failed');
  assert.equal(result.stderr, '', 'candidate source command wrote unexpected stderr');
  return result.stdout;
}

function git(repository, args) {
  return gitAuthority(repository, args, { maxBuffer: 1024 * 1024 });
}

function assertCleanPinnedRepository(repositoryInput, expectedCommit) {
  assert.equal(typeof repositoryInput, 'string', 'KDNA_CORE_CANDIDATE_SOURCE is required');
  const repository = path.resolve(repositoryInput);
  const repositoryStat = fs.lstatSync(repository);
  assert.ok(
    repositoryStat.isDirectory() && !repositoryStat.isSymbolicLink(),
    'candidate source repository must be a regular non-symlink directory',
  );
  assert.equal(
    fs.realpathSync(repository),
    repository,
    'candidate source repository path must be canonical',
  );
  assert.equal(
    git(repository, ['rev-parse', '--show-toplevel']),
    repository,
    'candidate source path must be the exact Git repository root',
  );
  assert.equal(
    git(repository, ['rev-parse', `${expectedCommit}^{commit}`]),
    expectedCommit,
    'candidate source repository does not contain the exact CI-pinned commit',
  );
  assert.equal(
    git(repository, ['rev-parse', 'HEAD']),
    expectedCommit,
    'candidate source HEAD does not match the exact CI pin',
  );
  assert.equal(
    git(repository, ['for-each-ref', '--format=%(refname)', 'refs/replace']),
    '',
    'candidate source repository contains forbidden Git replace refs',
  );
  const indexTags = git(repository, ['ls-files', '-v'])
    .split('\n')
    .filter(Boolean)
    .filter((line) => !line.startsWith('H '));
  assert.equal(
    indexTags.length,
    0,
    'candidate source index contains assume-unchanged, skip-worktree, or noncanonical flags',
  );
  assert.equal(
    git(repository, ['status', '--porcelain', '--untracked-files=all']),
    '',
    'candidate source worktree is not clean',
  );
  const source = path.resolve(repository, CORE_SUBDIRECTORY);
  const relative = path.relative(repository, source);
  assert.ok(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'candidate package path escapes its repository',
  );
  const sourceStat = fs.lstatSync(source);
  assert.ok(
    sourceStat.isDirectory() && !sourceStat.isSymbolicLink(),
    'candidate package path must be a regular non-symlink directory',
  );
  assert.equal(fs.realpathSync(source), source, 'candidate package path is not canonical');
  const manifestPath = path.join(source, 'package.json');
  const manifestStat = fs.lstatSync(manifestPath);
  assert.ok(
    manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.nlink === 1,
    'candidate package manifest must be one regular non-symlink file',
  );
  assert.equal(
    fs.realpathSync(manifestPath),
    manifestPath,
    'candidate package manifest path must be canonical',
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.name, CORE_NAME, 'candidate source package name mismatch');
  assert.equal(manifest.version, CORE_VERSION, 'candidate source package version mismatch');
  return { repository, source, commit: expectedCommit };
}

function exportPinnedPackageTree(repository, expectedCommit, destination) {
  const entries = exactCommitFiles(repository, expectedCommit, CORE_SUBDIRECTORY);
  const prefix = `${CORE_SUBDIRECTORY.split(path.sep).join('/')}/`;
  assert.ok(entries.length > 0, 'candidate commit package tree is empty');
  for (const entry of entries) {
    assert.ok(
      entry.path.startsWith(prefix),
      `candidate commit archive contains an out-of-scope file: ${entry.path}`,
    );
    const relative = entry.path.slice(prefix.length);
    assert.ok(relative, 'candidate commit archive contains an invalid package path');
    const target = path.join(destination, ...relative.split('/'));
    const containment = path.relative(destination, target);
    assert.ok(
      containment && !containment.startsWith('..') && !path.isAbsolute(containment),
      'candidate commit archive escapes its extraction root',
    );
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, entry.bytes, {
      flag: 'wx',
      mode: entry.mode === '100755' ? 0o755 : 0o644,
    });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
  assert.equal(manifest.name, CORE_NAME, 'candidate commit package name mismatch');
  assert.equal(manifest.version, CORE_VERSION, 'candidate commit package version mismatch');
  return destination;
}

function candidatePackArguments(destination) {
  return [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    destination,
    '--registry=https://registry.npmjs.org/',
    '--@aikdna:registry=https://registry.npmjs.org/',
  ];
}

function packOnce(invocation, source, destination) {
  const reports = JSON.parse(
    run(
      invocation.command,
      [...invocation.prefixArgs, ...candidatePackArguments(destination)],
      { cwd: source },
    ),
  );
  assert.equal(reports.length, 1, 'candidate source pack must emit one artifact');
  assert.equal(reports[0].name, CORE_NAME, 'candidate pack package name mismatch');
  assert.equal(reports[0].version, CORE_VERSION, 'candidate pack package version mismatch');
  assert.equal(typeof reports[0].filename, 'string', 'candidate pack filename missing');
  return fs.readFileSync(path.join(destination, reports[0].filename));
}

function verifyCoreCandidateSource({
  root = ROOT,
  repositoryInput = process.env.KDNA_CORE_CANDIDATE_SOURCE,
  npmReleasePath,
  nodeExecPath = process.execPath,
} = {}) {
  const binding = verifyCandidateBinding(root);
  const entry = binding.packages.find(({ name }) => name === CORE_NAME);
  assert.ok(entry, 'Core candidate binding is missing');
  const expectedCommit = readPinnedCoreCommit(root);
  const before = assertCleanPinnedRepository(repositoryInput, expectedCommit);
  const invocation = resolveTrustedNpmInvocation(root, npmReleasePath, nodeExecPath);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remote-core-source-'));
  try {
    const exportedSource = path.join(temporary, 'source');
    const firstDirectory = path.join(temporary, 'first');
    const secondDirectory = path.join(temporary, 'second');
    fs.mkdirSync(exportedSource);
    fs.mkdirSync(firstDirectory);
    fs.mkdirSync(secondDirectory);
    exportPinnedPackageTree(before.repository, expectedCommit, exportedSource);
    const first = packOnce(invocation, exportedSource, firstDirectory);
    const second = packOnce(invocation, exportedSource, secondDirectory);
    assert.deepEqual(first, second, 'candidate source pack is not reproducible');
    assert.deepEqual(
      first,
      fs.readFileSync(path.join(root, ...entry.artifact.split('/'))),
      'candidate artifact differs from the exact CI-pinned source',
    );
    assertCleanPinnedRepository(repositoryInput, expectedCommit);
  } finally {
    invocation.cleanup();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return entry;
}

if (require.main === module) {
  try {
    const entry = verifyCoreCandidateSource();
    console.log(`Exact Core candidate source verified: ${entry.name}@${entry.version}`);
  } catch (error) {
    console.error(`Core candidate source verification blocked: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  assertCleanPinnedRepository,
  candidatePackArguments,
  exportPinnedPackageTree,
  verifyCoreCandidateSource,
};
