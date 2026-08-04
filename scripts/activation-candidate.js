'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { readTarFileEntries } = require('./runtime-candidate-binding');

const ACTIVATION_BINDING_PATH =
  'tests/fixtures/runtime-candidates/activation-binding.json';
const EXPECTED_ACTIVATION_HEAD = '4d03973f1b171d90e6532a1cf962971fef8274e0';
const EXPECTED_ACTIVATION_TREE = 'bbeb6f621508907b6a60fe35be5ee2bdc7cb04fb';
const EXPECTED_ACTIVATION_VERSION = '0.2.1';
const ACTIVATION_PACKAGE = '@aikdna/kdna-activation-server';
const HEX_40_RE = /^[0-9a-f]{40}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;
const SHA512_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(JSON.stringify(actual) === JSON.stringify(wanted), `${label} fields are not exact`);
}

function authorityFile(file, expected, label) {
  const stat = fs.lstatSync(file);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
    `${label} must be one regular non-symlink file`,
  );
  assert(fs.realpathSync(file) === expected, `${label} escapes its canonical path`);
}

function digest(bytes, algorithm, encoding) {
  return crypto.createHash(algorithm).update(bytes).digest(encoding);
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function verifyActivationCandidate(root = path.resolve(__dirname, '..')) {
  const rootReal = fs.realpathSync(root);
  const bindingPath = path.join(rootReal, ...ACTIVATION_BINDING_PATH.split('/'));
  authorityFile(bindingPath, bindingPath, 'Activation candidate binding');
  const binding = JSON.parse(UTF8.decode(fs.readFileSync(bindingPath)));

  exactKeys(binding, ['schema', 'schema_version', 'package', 'source', 'artifact'], 'binding');
  exactKeys(binding.package, ['name', 'version'], 'binding package');
  exactKeys(binding.source, ['git_head', 'git_tree', 'worktree_clean'], 'binding source');
  exactKeys(
    binding.artifact,
    [
      'path',
      'size',
      'unpacked_size',
      'entry_count',
      'sha1',
      'sha256',
      'integrity',
      'reproducible_runs',
    ],
    'binding artifact',
  );
  assert(binding.schema === 'kdna.activation-candidate-binding', 'binding schema mismatch');
  assert(binding.schema_version === '0.1.0', 'binding schema version mismatch');
  assert(binding.package.name === ACTIVATION_PACKAGE, 'Activation candidate package mismatch');
  assert(
    binding.package.version === EXPECTED_ACTIVATION_VERSION,
    'Activation candidate version does not match the Remote pin',
  );
  assert(HEX_40_RE.test(binding.source.git_head), 'Activation candidate commit is invalid');
  assert(HEX_40_RE.test(binding.source.git_tree), 'Activation candidate tree is invalid');
  assert(
    binding.source.git_head === EXPECTED_ACTIVATION_HEAD &&
      binding.source.git_tree === EXPECTED_ACTIVATION_TREE &&
      binding.source.worktree_clean === true,
    'Activation candidate source coordinate does not match the Remote pin',
  );

  const expectedArtifactPath =
    `tests/fixtures/runtime-candidates/kdna-activation-server-${EXPECTED_ACTIVATION_VERSION}.tgz`;
  assert(binding.artifact.path === expectedArtifactPath, 'Activation candidate artifact path mismatch');
  const artifactPath = path.join(rootReal, ...binding.artifact.path.split('/'));
  assert(within(rootReal, artifactPath), 'Activation candidate artifact escapes the repository');
  authorityFile(artifactPath, artifactPath, 'Activation candidate artifact');

  const bytes = fs.readFileSync(artifactPath);
  assert(
    Number.isSafeInteger(binding.artifact.size) && binding.artifact.size === bytes.length,
    'Activation candidate artifact size mismatch',
  );
  assert(/^[0-9a-f]{40}$/.test(binding.artifact.sha1), 'Activation candidate SHA-1 is invalid');
  assert(HEX_64_RE.test(binding.artifact.sha256), 'Activation candidate SHA-256 is invalid');
  assert(SHA512_RE.test(binding.artifact.integrity), 'Activation candidate integrity is invalid');
  assert(
    digest(bytes, 'sha1', 'hex') === binding.artifact.sha1 &&
      digest(bytes, 'sha256', 'hex') === binding.artifact.sha256 &&
      `sha512-${digest(bytes, 'sha512', 'base64')}` === binding.artifact.integrity,
    'Activation candidate artifact digest mismatch',
  );

  const entries = readTarFileEntries(bytes);
  const unpackedSize = entries.reduce((total, entry) => total + entry.size, 0);
  assert(
    binding.artifact.entry_count === entries.length &&
      binding.artifact.unpacked_size === unpackedSize &&
      binding.artifact.reproducible_runs === 2,
    'Activation candidate reproducibility evidence mismatch',
  );
  const manifests = entries.filter((entry) => entry.path === 'package/package.json');
  assert(manifests.length === 1, 'Activation candidate package manifest is not exact');
  const manifest = JSON.parse(UTF8.decode(manifests[0].bytes));
  assert(
    manifest.name === ACTIVATION_PACKAGE && manifest.version === EXPECTED_ACTIVATION_VERSION,
    'Activation candidate package identity mismatch',
  );

  return Object.freeze({ binding, artifactPath, entries });
}

function extractActivationCandidate(root = path.resolve(__dirname, '..')) {
  const verified = verifyActivationCandidate(root);
  const extractionRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-activation-candidate-')),
  );
  const packageRoot = path.join(extractionRoot, 'package');
  try {
    for (const entry of verified.entries) {
      assert(entry.path.startsWith('package/'), 'Activation candidate entry is outside package root');
      const relative = entry.path.slice('package/'.length);
      assert(relative, 'Activation candidate contains an empty package path');
      const destination = path.join(packageRoot, ...relative.split('/'));
      assert(within(packageRoot, destination), 'Activation candidate entry escapes extraction root');
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, entry.bytes, {
        flag: 'wx',
        mode: entry.mode === 0o755 ? 0o700 : 0o600,
      });
    }
    let cleaned = false;
    return Object.freeze({
      binding: verified.binding,
      packageRoot,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        fs.rmSync(extractionRoot, { recursive: true, force: true });
      },
    });
  } catch (error) {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  ACTIVATION_BINDING_PATH,
  EXPECTED_ACTIVATION_HEAD,
  EXPECTED_ACTIVATION_TREE,
  EXPECTED_ACTIVATION_VERSION,
  extractActivationCandidate,
  verifyActivationCandidate,
};
