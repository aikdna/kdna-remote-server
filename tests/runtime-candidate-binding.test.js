'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const {
  BINDING_PATH,
  NPM_RELEASE_PATH,
  assertRegistryReleaseReady,
  readTarFileEntries,
  resolveTrustedNpmInvocation,
  strictRegistryLookup,
  verifyCandidateBinding,
  verifyInstalledAikdnaGraph,
} = require('../scripts/runtime-candidate-binding');
const {
  CORE_CANDIDATE_EVIDENCE_PATH,
  CORE_CANDIDATE_WORKFLOW_PATH,
} = require('../scripts/core-candidate');
const {
  assertCleanPinnedRepository,
  candidatePackArguments,
  exportPinnedPackageTree,
} = require('../scripts/verify-core-candidate-tar');

const ROOT = path.resolve(__dirname, '..');
const CORE = '@aikdna/kdna-core';

function copyAuthorityRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remote-binding-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of [
    'package.json',
    'package-lock.json',
    BINDING_PATH,
    CORE_CANDIDATE_EVIDENCE_PATH,
    CORE_CANDIDATE_WORKFLOW_PATH,
    NPM_RELEASE_PATH,
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  const binding = JSON.parse(fs.readFileSync(path.join(root, BINDING_PATH), 'utf8'));
  for (const entry of binding.packages) {
    fs.mkdirSync(path.dirname(path.join(root, entry.artifact)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, entry.artifact), path.join(root, entry.artifact));
  }
  return root;
}

function mutateJson(root, file, mutate) {
  const target = path.join(root, file);
  const value = JSON.parse(fs.readFileSync(target, 'utf8'));
  mutate(value);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function installedRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remote-installed-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: '@test/remote', dependencies: { [CORE]: '0.20.0' } }, null, 2)}\n`,
  );
  const core = path.join(root, 'node_modules', '@aikdna', 'kdna-core');
  fs.mkdirSync(core, { recursive: true });
  fs.writeFileSync(
    path.join(core, 'package.json'),
    `${JSON.stringify({ name: CORE, version: '0.20.0' }, null, 2)}\n`,
  );
  return root;
}

function createAdjacentSelfReportedNpm(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remote-npm-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const npmRoot = path.join(root, 'npm');
  const cli = path.join(npmRoot, 'bin', 'npm-cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, '#!/usr/bin/env node\n');
  fs.writeFileSync(
    path.join(npmRoot, 'package.json'),
    `${JSON.stringify({ name: 'npm', version: '11.17.0' })}\n`,
  );
  return fs.realpathSync(cli);
}

function createSourceRepository(t) {
  const repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remote-source-')));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const run = (args) => {
    const result = spawnSync('git', args, {
      cwd: repository,
      encoding: 'utf8',
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  run(['init', '--quiet']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'user.email', 'test@example.com']);
  const packageRoot = path.join(repository, 'packages', 'kdna-core');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: CORE, version: '0.20.0' })}\n`,
  );
  run(['add', '--all']);
  run(['commit', '--quiet', '-m', 'fixture']);
  return { repository, packageRoot, head: run(['rev-parse', 'HEAD']), run };
}

test('default install is one exact Core 0.20.0 registry artifact and the release gate accepts it', () => {
  const binding = verifyCandidateBinding(ROOT);
  assert.equal(binding.packages.length, 1);
  assert.equal(binding.packages[0].name, CORE);
  assert.equal(binding.packages[0].commit, '1e77e3e0d486c330fe9f9262b514ef24c859d469');
  assert.deepEqual(verifyInstalledAikdnaGraph(ROOT), { [CORE]: '0.20.0' });
  assert.doesNotThrow(() => assertRegistryReleaseReady(ROOT, strictRegistryLookup));
});

test('manifest and lock graph reject aliases, name omission, duplicates, and encoded paths', (t) => {
  const root = copyAuthorityRoot(t);
  const originals = new Map(
    ['package.json', 'package-lock.json'].map((file) => [file, fs.readFileSync(path.join(root, file))]),
  );
  const reset = () => {
    for (const [file, bytes] of originals) fs.writeFileSync(path.join(root, file), bytes);
  };
  const reject = (file, mutate, pattern) => {
    reset();
    mutateJson(root, file, mutate);
    assert.throws(() => verifyCandidateBinding(root), pattern);
  };

  reject('package.json', (pkg) => {
    pkg.dependencies['shadow-core'] = 'npm:@aikdna/kdna-core@0.18.0';
  }, /alias or encoded dependency spec/);
  reject('package-lock.json', (lock) => {
    lock.packages['node_modules/shadow-core'] = {
      version: '0.18.0',
      resolved: 'https://registry.npmjs.org/@aikdna/kdna-core/-/kdna-core-0.18.0.tgz',
    };
  }, /resolution\/path mismatch/);
  reject('package-lock.json', (lock) => {
    lock.packages[`node_modules/foreign/node_modules/${CORE}`] = {
      ...lock.packages[`node_modules/${CORE}`],
    };
  }, /must appear exactly once|resolution\/path mismatch/);
  reject('package-lock.json', (lock) => {
    lock.packages['node_modules/foreign/node_modules/%2540aikdna%252fkdna-core'] = {
      version: '0.20.0',
    };
  }, /package name invalid/);
  reject('package-lock.json', (lock) => {
    lock.packages['node_modules/foreign'] = {
      version: '1.0.0',
      resolved: 'file:tests/fixtures/foreign.tgz',
    };
  }, /unbound file lock package/);
});

test('candidate artifact paths and authority files reject encoding, symlinks, and hardlinks', (t) => {
  for (const artifact of [
    'tests\\fixtures\\runtime-candidates\\kdna-core-0.20.0.tgz',
    'tests/fixtures/runtime-candidates//kdna-core-0.20.0.tgz',
    'tests/fixtures/runtime-candidates/./kdna-core-0.20.0.tgz',
    'tests/fixtures/runtime-candidates/%2e%2e.tgz',
    'tests/fixtures/runtime-candidates/KDNA-core-0.20.0.tgz',
  ]) {
    const root = copyAuthorityRoot(t);
    mutateJson(root, BINDING_PATH, (binding) => { binding.packages[0].artifact = artifact; });
    assert.throws(() => verifyCandidateBinding(root), /candidate artifact path invalid/);
  }

  {
    const root = copyAuthorityRoot(t);
    const target = path.join(root, 'binding-real.json');
    fs.renameSync(path.join(root, BINDING_PATH), target);
    fs.symlinkSync(target, path.join(root, BINDING_PATH));
    assert.throws(() => verifyCandidateBinding(root), /regular non-symlink/);
  }
  {
    const root = copyAuthorityRoot(t);
    fs.linkSync(path.join(root, 'package.json'), path.join(root, 'package-hardlink.json'));
    assert.throws(() => verifyCandidateBinding(root), /exactly one hard link/);
  }
});

test('installed graph rejects aliases, duplicates, vendored identities, and symlinked packages', (t) => {
  {
    const root = installedRoot(t);
    assert.deepEqual(verifyInstalledAikdnaGraph(root), { [CORE]: '0.20.0' });
  }
  {
    const root = installedRoot(t);
    const alias = path.join(root, 'node_modules', 'shadow-core');
    fs.mkdirSync(alias);
    fs.writeFileSync(
      path.join(alias, 'package.json'),
      `${JSON.stringify({ name: CORE, version: '0.18.0' })}\n`,
    );
    assert.throws(() => verifyInstalledAikdnaGraph(root), /not at its canonical top-level path/);
  }
  {
    const root = installedRoot(t);
    const vendored = path.join(root, 'node_modules', 'foreign', 'vendor');
    fs.mkdirSync(vendored, { recursive: true });
    fs.writeFileSync(
      path.join(vendored, 'package.json'),
      `${JSON.stringify({ name: CORE, version: '0.20.0' })}\n`,
    );
    assert.throws(() => verifyInstalledAikdnaGraph(root), /not at its canonical top-level path/);
  }
  {
    const root = installedRoot(t);
    const target = path.join(root, 'outside-package');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'package.json'), '{}\n');
    fs.symlinkSync(target, path.join(root, 'node_modules', 'linked-package'));
    assert.throws(() => verifyInstalledAikdnaGraph(root), /symlink/);
  }
});

test('registry lookup uses trusted npm 11.17 with fixed global and scoped registries', (t) => {
  const trusted = resolveTrustedNpmInvocation(ROOT);
  try {
    assert.equal(trusted.command, process.execPath);
    assert.equal(trusted.prefixArgs.length, 1);
    assert.match(trusted.prefixArgs[0], /kdna-npm-11\.17\.0-.*\/package\/bin\/npm-cli\.js$/);
    assert.equal(fs.existsSync(trusted.prefixArgs[0]), true);
  } finally {
    trusted.cleanup();
  }
  let registryInvocation;
  strictRegistryLookup(CORE, '0.20.0', {
    root: ROOT,
    nodeExecPath: process.execPath,
    runner(command, args, options) {
      registryInvocation = { command, args, options };
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          name: CORE,
          version: '0.20.0',
          'dist.integrity': `sha512-${Buffer.alloc(64).toString('base64')}`,
        }),
        stderr: '',
      };
    },
  });
  assert.equal(registryInvocation.command, process.execPath);
  assert.match(registryInvocation.args[0], /\/package\/bin\/npm-cli\.js$/);
  assert.ok(registryInvocation.args.includes('--registry=https://registry.npmjs.org/'));
  assert.ok(registryInvocation.args.includes('--@aikdna:registry=https://registry.npmjs.org/'));
  assert.equal(registryInvocation.options.shell, false);

  const selfReportedCli = createAdjacentSelfReportedNpm(t);
  assert.throws(
    () => resolveTrustedNpmInvocation(ROOT, selfReportedCli, process.execPath),
    /exact canonical authority path/,
  );

  const corruptedRoot = copyAuthorityRoot(t);
  const corruptedRelease = path.join(corruptedRoot, NPM_RELEASE_PATH);
  const bytes = fs.readFileSync(corruptedRelease);
  bytes[0] ^= 0xff;
  fs.writeFileSync(corruptedRelease, bytes);
  assert.throws(
    () => resolveTrustedNpmInvocation(corruptedRoot, corruptedRelease, process.execPath),
    /official npm 11\.17\.0 integrity/,
  );

  const symlinkRoot = copyAuthorityRoot(t);
  const symlinkRelease = path.join(symlinkRoot, NPM_RELEASE_PATH);
  const symlinkTarget = `${symlinkRelease}.real`;
  fs.renameSync(symlinkRelease, symlinkTarget);
  fs.symlinkSync(symlinkTarget, symlinkRelease);
  assert.throws(
    () => resolveTrustedNpmInvocation(symlinkRoot, symlinkRelease, process.execPath),
    /one regular non-symlink file/,
  );

  const hardlinkRoot = copyAuthorityRoot(t);
  const hardlinkRelease = path.join(hardlinkRoot, NPM_RELEASE_PATH);
  fs.linkSync(hardlinkRelease, `${hardlinkRelease}.alias`);
  assert.throws(
    () => resolveTrustedNpmInvocation(hardlinkRoot, hardlinkRelease, process.execPath),
    /one regular non-symlink file/,
  );
});

test('candidate source verification requires exact canonical clean repository containment', (t) => {
  const fixture = createSourceRepository(t);
  assert.deepEqual(assertCleanPinnedRepository(fixture.repository, fixture.head), {
    repository: fixture.repository,
    source: fixture.packageRoot,
    commit: fixture.head,
  });

  assert.throws(
    () => assertCleanPinnedRepository(path.join(fixture.repository, 'packages'), fixture.head),
    /exact Git repository root/,
  );

  fs.writeFileSync(path.join(fixture.repository, 'untracked.txt'), 'dirty\n');
  assert.throws(
    () => assertCleanPinnedRepository(fixture.repository, fixture.head),
    /worktree is not clean/,
  );
  fs.rmSync(path.join(fixture.repository, 'untracked.txt'));

  const symlink = path.join(path.dirname(fixture.repository), `${path.basename(fixture.repository)}-link`);
  t.after(() => fs.rmSync(symlink, { force: true }));
  fs.symlinkSync(fixture.repository, symlink);
  assert.throws(
    () => assertCleanPinnedRepository(symlink, fixture.head),
    /regular non-symlink directory/,
  );

  const manifest = path.join(fixture.packageRoot, 'package.json');
  fs.linkSync(manifest, path.join(fixture.packageRoot, 'manifest-hardlink.json'));
  assert.throws(
    () => assertCleanPinnedRepository(fixture.repository, fixture.head),
    /worktree is not clean|one regular non-symlink file/,
  );
});

test('candidate source rejects hidden index flags instead of trusting porcelain status', (t) => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const fixture = createSourceRepository(t);
    const result = spawnSync(
      'git',
      ['update-index', flag, 'packages/kdna-core/package.json'],
      { cwd: fixture.repository, encoding: 'utf8', shell: false },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.throws(
      () => assertCleanPinnedRepository(fixture.repository, fixture.head),
      /index contains assume-unchanged, skip-worktree, or noncanonical flags/,
    );
  }
});

test('candidate source rejects Git replace refs before resolving or archiving the pinned commit', (t) => {
  const fixture = createSourceRepository(t);
  fs.writeFileSync(path.join(fixture.repository, 'replacement.txt'), 'replacement tree\n');
  fixture.run(['add', '--all']);
  fixture.run(['commit', '--quiet', '-m', 'replacement']);
  const replacement = fixture.run(['rev-parse', 'HEAD']);
  fixture.run(['checkout', '--quiet', '--detach', fixture.head]);
  fixture.run(['replace', fixture.head, replacement]);
  fixture.run(['reset', '--quiet', '--hard', fixture.head]);
  assert.equal(fixture.run(['status', '--porcelain', '--untracked-files=all']), '');
  assert.throws(
    () => assertCleanPinnedRepository(fixture.repository, fixture.head),
    /forbidden Git replace refs/,
  );
});

test('candidate Git authority ignores inherited alternate replacements and Git environment poisoning', (t) => {
  const fixture = createSourceRepository(t);
  const replacementFile = path.join(fixture.packageRoot, 'replacement.js');
  fs.writeFileSync(replacementFile, 'replacement-content\n');
  fixture.run(['add', '--all']);
  fixture.run(['commit', '--quiet', '-m', 'replacement']);
  const replacement = fixture.run(['rev-parse', 'HEAD']);
  fixture.run(['checkout', '--quiet', '--detach', fixture.head]);
  fixture.run(['update-ref', `refs/alternate-replacements/${fixture.head}`, replacement]);

  const poisoned = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.useReplaceRefs',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_REPLACE_REF_BASE: 'refs/alternate-replacements/',
  };
  const raw = spawnSync(
    'git',
    ['-C', fixture.repository, 'archive', '--format=tar', fixture.head, '--', 'packages/kdna-core'],
    { encoding: null, env: { ...process.env, ...poisoned }, maxBuffer: 16 * 1024 * 1024, shell: false },
  );
  assert.equal(raw.status, 0, raw.stderr?.toString('utf8'));
  assert.ok(raw.stdout.includes(Buffer.from('replacement-content')));

  const prior = Object.fromEntries(
    [
      ...Object.keys(poisoned),
      'GIT_DIR',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_WORK_TREE',
    ].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, poisoned, {
    GIT_DIR: '/nonexistent/poisoned-git-dir',
    GIT_INDEX_FILE: '/nonexistent/poisoned-index',
    GIT_OBJECT_DIRECTORY: '/nonexistent/poisoned-objects',
    GIT_WORK_TREE: '/nonexistent/poisoned-worktree',
  });
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  assert.doesNotThrow(() => assertCleanPinnedRepository(fixture.repository, fixture.head));
  const destination = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-core-authority-')));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  exportPinnedPackageTree(fixture.repository, fixture.head, destination);
  assert.equal(fs.existsSync(path.join(destination, 'replacement.js')), false);
});

test('candidate exact-object export ignores repository-private info attributes', (t) => {
  const fixture = createSourceRepository(t);
  const formatPath = path.join(fixture.packageRoot, 'format.txt');
  fs.writeFileSync(formatPath, '$Format:%H$\n');
  fixture.run(['add', '--all']);
  fixture.run(['commit', '--quiet', '-m', 'attribute fixture']);
  const commit = fixture.run(['rev-parse', 'HEAD']);
  const info = path.join(fixture.repository, '.git', 'info');
  fs.mkdirSync(info, { recursive: true });
  fs.writeFileSync(
    path.join(info, 'attributes'),
    'packages/kdna-core/package.json export-ignore\npackages/kdna-core/format.txt export-subst\n',
  );

  const raw = spawnSync(
    'git',
    ['-C', fixture.repository, 'archive', '--format=tar', commit, '--', 'packages/kdna-core'],
    { encoding: null, maxBuffer: 16 * 1024 * 1024, shell: false },
  );
  assert.equal(raw.status, 0, raw.stderr?.toString('utf8'));
  assert.equal(raw.stdout.includes(Buffer.from('{"name":"@aikdna/kdna-core"')), false);
  assert.equal(raw.stdout.includes(Buffer.from('$Format:%H$')), false);

  assert.doesNotThrow(() => assertCleanPinnedRepository(fixture.repository, commit));
  const destination = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-core-attributes-')));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  exportPinnedPackageTree(fixture.repository, commit, destination);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8')).name,
    CORE,
  );
  assert.equal(fs.readFileSync(path.join(destination, 'format.txt'), 'utf8'), '$Format:%H$\n');
});

test('candidate exact-object export rejects tracked symlink and non-file modes', (t) => {
  const fixture = createSourceRepository(t);
  fs.symlinkSync('package.json', path.join(fixture.packageRoot, 'linked-manifest'));
  fixture.run(['add', '--all']);
  fixture.run(['commit', '--quiet', '-m', 'symlink fixture']);
  const commit = fixture.run(['rev-parse', 'HEAD']);
  assert.doesNotThrow(() => assertCleanPinnedRepository(fixture.repository, commit));
  const destination = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-core-mode-')));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  assert.throws(
    () => exportPinnedPackageTree(fixture.repository, commit, destination),
    /unsupported mode or object type/,
  );
});

test('candidate source pack arguments disable scripts and pin global plus scoped registries', () => {
  const args = candidatePackArguments('/tmp/destination');
  assert.ok(args.includes('--ignore-scripts'));
  assert.ok(args.includes('--registry=https://registry.npmjs.org/'));
  assert.ok(args.includes('--@aikdna:registry=https://registry.npmjs.org/'));
  assert.equal(args.includes('--scripts'), false);
});

test('published package contains no candidate artifact, binding, evidence, tests, or release scripts', (t) => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remote-pack-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const npm = resolveTrustedNpmInvocation(ROOT);
  let result;
  try {
    result = spawnSync(
      npm.command,
      [...npm.prefixArgs, 'pack', '--json', '--ignore-scripts', '--pack-destination', destination],
      { cwd: ROOT, encoding: 'utf8', shell: false },
    );
  } finally {
    npm.cleanup();
  }
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const artifact = path.join(destination, report[0].filename);
  const paths = readTarFileEntries(artifact).map((entry) => entry.path);
  assert.equal(paths.some((entry) => /runtime-candidates|candidate-evidence/.test(entry)), false);
  assert.equal(paths.some((entry) => /^package\/(?:tests|scripts)\//.test(entry)), false);
  assert.equal(paths.some((entry) => entry.endsWith('.tgz')), false);
});
