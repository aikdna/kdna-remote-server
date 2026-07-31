'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  ACTIVATION_BINDING_PATH,
  EXPECTED_ACTIVATION_HEAD,
  EXPECTED_ACTIVATION_TREE,
  EXPECTED_ACTIVATION_VERSION,
  extractActivationCandidate,
  verifyActivationCandidate,
} = require('../scripts/activation-candidate');

const ROOT = path.resolve(__dirname, '..');

function authorityCopy(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-activation-binding-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binding = JSON.parse(fs.readFileSync(path.join(ROOT, ACTIVATION_BINDING_PATH), 'utf8'));
  for (const file of [ACTIVATION_BINDING_PATH, binding.artifact.path]) {
    const destination = path.join(root, ...file.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, ...file.split('/')), destination);
  }
  return { binding, root };
}

function writeBinding(root, binding) {
  fs.writeFileSync(
    path.join(root, ...ACTIVATION_BINDING_PATH.split('/')),
    `${JSON.stringify(binding, null, 2)}\n`,
  );
}

test('Remote binds and extracts the exact reproducible Activation source candidate', () => {
  const verified = verifyActivationCandidate(ROOT);
  assert.equal(verified.binding.package.version, EXPECTED_ACTIVATION_VERSION);
  assert.equal(verified.binding.source.git_head, EXPECTED_ACTIVATION_HEAD);
  assert.equal(verified.binding.source.git_tree, EXPECTED_ACTIVATION_TREE);

  const extracted = extractActivationCandidate(ROOT);
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(extracted.packageRoot, 'package.json'), 'utf8'),
    );
    assert.deepEqual(
      { name: manifest.name, version: manifest.version },
      {
        name: '@aikdna/kdna-activation-server',
        version: EXPECTED_ACTIVATION_VERSION,
      },
    );
  } finally {
    extracted.cleanup();
  }
  assert.equal(fs.existsSync(extracted.packageRoot), false);
});

test('Activation candidate binding rejects source, digest, byte, and authority drift', (t) => {
  {
    const { binding, root } = authorityCopy(t);
    binding.source.git_head = '0'.repeat(40);
    writeBinding(root, binding);
    assert.throws(() => verifyActivationCandidate(root), /source coordinate/);
  }
  {
    const { binding, root } = authorityCopy(t);
    binding.artifact.sha256 = '0'.repeat(64);
    writeBinding(root, binding);
    assert.throws(() => verifyActivationCandidate(root), /digest mismatch/);
  }
  {
    const { binding, root } = authorityCopy(t);
    fs.appendFileSync(path.join(root, ...binding.artifact.path.split('/')), Buffer.from([0]));
    assert.throws(() => verifyActivationCandidate(root), /size mismatch/);
  }
  {
    const { root } = authorityCopy(t);
    const bindingPath = path.join(root, ...ACTIVATION_BINDING_PATH.split('/'));
    const target = path.join(root, 'binding.json');
    fs.renameSync(bindingPath, target);
    fs.symlinkSync(target, bindingPath);
    assert.throws(() => verifyActivationCandidate(root), /regular non-symlink/);
  }
});
