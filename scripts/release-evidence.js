'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readTarFileEntries } = require('./runtime-candidate-binding');
const { exactCommitFiles, gitAuthority } = require('./git-authority');

const PACKAGE_NAME = '@aikdna/kdna-remote-server';
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const REQUIRED_FILES = Object.freeze([
  'package/package.json',
  'package/bin/kdna-remote-server.js',
  'package/src/audit.js',
  'package/src/entitlement.js',
  'package/src/index.js',
  'package/src/projection.js',
  'package/src/server.js',
  'package/CHANGELOG.md',
  'package/LICENSE',
  'package/NOTICE',
  'package/README.md',
]);
const ALLOWED_ROOTS = Object.freeze([
  'package/bin/',
  'package/src/',
]);
const ALLOWED_FILES = new Set([
  'package/CHANGELOG.md',
  'package/LICENSE',
  'package/NOTICE',
  'package/README.md',
  'package/package.json',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha(bytes, algorithm, encoding = 'hex') {
  return crypto.createHash(algorithm).update(bytes).digest(encoding);
}

function gitText(root, args) {
  return gitAuthority(root, args, { maxBuffer: 4 * 1024 * 1024 });
}

function assertCanonicalRepositoryState(root, expectedCommit) {
  const canonicalRoot = fs.realpathSync(root);
  const rootStat = fs.lstatSync(root);
  assert(
    rootStat.isDirectory() && !rootStat.isSymbolicLink() && canonicalRoot === root,
    'release repository must be one canonical non-symlink directory',
  );
  assert(
    gitText(root, ['rev-parse', '--show-toplevel']) === root,
    'release source must be the exact repository root',
  );
  assert(gitText(root, ['rev-parse', 'HEAD']) === expectedCommit, 'release source HEAD changed');
  assert(
    gitText(root, ['for-each-ref', '--format=%(refname)', 'refs/replace']) === '',
    'release source repository contains forbidden Git replace refs',
  );
  const noncanonicalIndex = gitText(root, ['ls-files', '-v'])
    .split('\n')
    .filter(Boolean)
    .filter((line) => !line.startsWith('H '));
  assert(
    noncanonicalIndex.length === 0,
    'release source index contains assume-unchanged, skip-worktree, or noncanonical flags',
  );
  assert(
    gitText(root, ['status', '--porcelain', '--untracked-files=all']) === '',
    'release source worktree must be clean',
  );
  return { root, commit: expectedCommit };
}

function exportReleaseCommitTree(root, commit, destination) {
  const entries = exactCommitFiles(root, commit);
  assert(entries.length > 0, 'release commit archive is empty');
  for (const entry of entries) {
    const target = path.join(destination, ...entry.path.split('/'));
    const relative = path.relative(destination, target);
    assert(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      'release commit archive escapes its extraction root',
    );
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, entry.bytes, {
      flag: 'wx',
      mode: entry.mode === '100755' ? 0o755 : 0o644,
    });
  }
  return destination;
}

function assertCurrentReleaseBinding(root, evidence = null) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert(pkg.name === PACKAGE_NAME, `package name must be ${PACKAGE_NAME}`);
  assert(SEMVER_RE.test(pkg.version || ''), 'package version must be exact natural SemVer');
  const commit = gitText(root, ['rev-parse', 'HEAD']);
  assert(COMMIT_RE.test(commit), 'source commit is invalid');
  assert(process.env.GITHUB_REF === `refs/tags/${pkg.version}`, 'release ref must be the exact package version tag');
  assert(process.env.GITHUB_SHA === commit, 'release event commit must equal source HEAD');
  const tagCommit = gitText(root, ['rev-parse', `${pkg.version}^{commit}`]);
  assert(tagCommit === commit, 'release tag must resolve to source HEAD');
  assertCanonicalRepositoryState(root, commit);
  if (evidence) {
    assert(evidence.package?.name === pkg.name, 'release evidence package mismatch');
    assert(evidence.package?.version === pkg.version, 'release evidence version mismatch');
    assert(evidence.source?.commit === commit, 'release evidence commit mismatch');
    assert(evidence.source?.ref === process.env.GITHUB_REF, 'release evidence ref mismatch');
  }
  return { pkg, commit };
}

function validateArtifactPolicy(tarball) {
  const entries = readTarFileEntries(tarball);
  const paths = entries.map((entry) => entry.path).sort();
  const pathSet = new Set(paths);
  for (const required of REQUIRED_FILES) {
    assert(pathSet.has(required), `required packed file is missing: ${required}`);
  }
  for (const entry of entries) {
    assert(
      ALLOWED_FILES.has(entry.path) || ALLOWED_ROOTS.some((root) => entry.path.startsWith(root)),
      `unexpected packed file: ${entry.path}`,
    );
    assert(!entry.path.endsWith('.tgz'), `nested package artifact was packed: ${entry.path}`);
    assert(!/(?:^|\/)(?:AGENTS|WORKLOG)\.md$/i.test(entry.path), 'private coordination file was packed');
  }
  return entries.map(({ path: entryPath, size }) => ({ path: entryPath, size }));
}

function buildEvidence({ report, tarball, source }) {
  assert(Array.isArray(report) && report.length === 1, 'npm pack must report exactly one artifact');
  const item = report[0];
  assert(item.name === source.pkg.name && item.version === source.pkg.version, 'npm pack identity mismatch');
  const files = validateArtifactPolicy(tarball);
  const integrity = `sha512-${sha(tarball, 'sha512', 'base64')}`;
  const shasum = sha(tarball, 'sha1');
  assert(item.integrity === integrity, 'npm pack integrity does not match artifact bytes');
  assert(item.shasum === shasum, 'npm pack shasum does not match artifact bytes');
  assert(item.size === tarball.length, 'npm pack size does not match artifact bytes');
  return {
    schema: 'kdna.remote-server.release-evidence',
    schema_version: '0.1.0',
    source: { ref: process.env.GITHUB_REF, commit: source.commit },
    package: { name: source.pkg.name, version: source.pkg.version },
    artifact: {
      filename: item.filename,
      size: tarball.length,
      sha256: sha(tarball, 'sha256'),
      shasum,
      integrity,
      files,
    },
  };
}

function validateEvidenceArtifact(evidence, tarball) {
  assert(evidence?.schema === 'kdna.remote-server.release-evidence', 'release evidence schema mismatch');
  assert(evidence.schema_version === '0.1.0', 'release evidence schema version mismatch');
  assert(evidence.package?.name === PACKAGE_NAME, 'release evidence package mismatch');
  assert(SEMVER_RE.test(evidence.package?.version || ''), 'release evidence version invalid');
  assert(COMMIT_RE.test(evidence.source?.commit || ''), 'release evidence commit invalid');
  assert(evidence.source?.ref === `refs/tags/${evidence.package.version}`, 'release evidence ref mismatch');
  assert(Buffer.isBuffer(tarball) && tarball.length > 0, 'release artifact is empty');
  assert(evidence.artifact?.size === tarball.length, 'release artifact size mismatch');
  assert(evidence.artifact?.sha256 === sha(tarball, 'sha256'), 'release artifact sha256 mismatch');
  assert(evidence.artifact?.shasum === sha(tarball, 'sha1'), 'release artifact shasum mismatch');
  assert(
    evidence.artifact?.integrity === `sha512-${sha(tarball, 'sha512', 'base64')}`,
    'release artifact integrity mismatch',
  );
  const files = validateArtifactPolicy(tarball);
  assert(JSON.stringify(evidence.artifact.files) === JSON.stringify(files), 'release artifact file evidence mismatch');
  return evidence;
}

module.exports = {
  assertCanonicalRepositoryState,
  assertCurrentReleaseBinding,
  buildEvidence,
  exportReleaseCommitTree,
  validateArtifactPolicy,
  validateEvidenceArtifact,
};
