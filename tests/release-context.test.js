'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  verifyReleaseContext,
  verifyReleaseEvent,
} = require('../scripts/verify-release-context.cjs');
const {
  assertCanonicalRepositoryState,
  assertCurrentReleaseBinding,
  exportReleaseCommitTree,
} = require('../scripts/release-evidence');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
const SCRIPT = path.join(ROOT, 'scripts/verify-release-context.cjs');

function changelogFor(heading, extra = '') {
  return `# Changelog

${heading}

- Release notes.
${extra}`;
}

function createReleaseRepository(t) {
  const repository = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-release-state-')));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const run = (args) => {
    const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  run(['init', '--quiet']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repository, 'package.json'), '{"name":"fixture"}\n');
  run(['add', '--all']);
  run(['commit', '--quiet', '-m', 'fixture']);
  return { repository, head: run(['rev-parse', 'HEAD']), run };
}

test('release context accepts the exact natural SemVer tag and literal top CHANGELOG heading', () => {
  const version = PACKAGE_JSON.version;
  assert.equal(
    verifyReleaseContext({
      packageJson: PACKAGE_JSON,
      changelog: changelogFor(`## ${version}`),
      releaseTag: version,
    }).changelogHeading,
    `## ${version}`,
  );
  assert.deepEqual(
    verifyReleaseContext({
      packageJson: PACKAGE_JSON,
      changelog: changelogFor(`## ${version} (2026-07-16)`),
      releaseTag: version,
    }),
    {
      version,
      releaseTag: version,
      changelogHeading: `## ${version} (2026-07-16)`,
    },
  );

  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      RELEASE_EVENT_ACTION: 'published',
      RELEASE_IS_DRAFT: 'false',
      RELEASE_IS_PRERELEASE: 'false',
      RELEASE_TAG: version,
    },
  });
  assert.equal(result.status, 0, result.stderr);
});
test('release event gate rejects draft, prerelease, and non-published contexts', () => {
  assert.deepEqual(
    verifyReleaseEvent({ action: 'published', isDraft: 'false', isPrerelease: 'false' }),
    { action: 'published', isDraft: 'false', isPrerelease: 'false' },
  );
  for (const context of [
    { action: 'created', isDraft: 'false', isPrerelease: 'false' },
    { action: 'published', isDraft: 'true', isPrerelease: 'false' },
    { action: 'published', isDraft: 'false', isPrerelease: 'true' },
    { action: undefined, isDraft: undefined, isPrerelease: undefined },
  ]) {
    assert.throws(() => verifyReleaseEvent(context), /published|draft|prerelease/);
  }
});
test('release context rejects version drift and generation-shaped tag forms', () => {
  const version = PACKAGE_JSON.version;
  for (const releaseTag of [
    '9.9.9',
    `0${version}`,
    `v${version}`,
    `V${version}`,
    `${version}-preview`,
    `${version}+build`,
  ]) {
    assert.throws(
      () => verifyReleaseContext({
        packageJson: PACKAGE_JSON,
        changelog: changelogFor(`## ${version} (2026-07-16)`),
        releaseTag,
      }),
      /natural SemVer|release tag must be exactly/,
      releaseTag,
    );
  }
  for (const packageVersion of [
    `0${version}`,
    `v${version}`,
    `${version}-preview`,
    `${version}+build`,
  ]) {
    assert.throws(
      () => verifyReleaseContext({
        packageJson: { ...PACKAGE_JSON, version: packageVersion },
        changelog: changelogFor(`## ${version}`),
        releaseTag: version,
      }),
      /package version must be an exact natural SemVer coordinate/,
      packageVersion,
    );
  }
});

test('a command-injection-shaped legal Git tag is data, never shell source', () => {
  const version = PACKAGE_JSON.version;
  const maliciousTag = `${version}';printf\${IFS}TAG_INTERPOLATION_EXECUTED;#`;
  const git = spawnSync('git', ['check-ref-format', `refs/tags/${maliciousTag}`]);
  assert.equal(git.status, 0, 'hostile fixture must remain a Git-legal tag');

  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      RELEASE_EVENT_ACTION: 'published',
      RELEASE_IS_DRAFT: 'false',
      RELEASE_IS_PRERELEASE: 'false',
      RELEASE_TAG: maliciousTag,
    },
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /TAG_INTERPOLATION_EXECUTED/);
  assert.match(result.stderr, /exact natural SemVer/);
});

test('near-match, stale, and duplicate CHANGELOG headings fail closed', () => {
  const version = PACKAGE_JSON.version;
  const approximateHeadings = [
    `## ${version}.1 (2026-07-16)`,
    `## ${version}1 (2026-07-16)`,
    `### ${version} (2026-07-16)`,
    `## v${version} (2026-07-16)`,
    `## ${version}-preview (2026-07-16)`,
    `## ${version} notes`,
    `## ${version}\t(2026-07-16)`,
    `## ${version}\v(2026-07-16)`,
    `## ${version}: duplicate`,
    `## ${version}  (2026-07-16)`,
    `## ${version}\u00a0(2026-07-16)`,
    `##\t${version}`,
    ` ## ${version}`,
    '## 01.2.3',
    '## 1.2.3-preview',
    '## 1.2.3+build',
  ];
  for (const heading of approximateHeadings) {
    assert.throws(
      () => verifyReleaseContext({
        packageJson: PACKAGE_JSON,
        changelog: changelogFor(heading),
        releaseTag: version,
      }),
      /CHANGELOG/,
      heading,
    );
  }

  assert.throws(
    () => verifyReleaseContext({
      packageJson: PACKAGE_JSON,
      changelog: changelogFor(
        '## 9.9.9 (2026-07-16)',
        `
## ${version} (2026-07-15)
`,
      ),
      releaseTag: version,
    }),
    /first CHANGELOG release heading/,
  );
  assert.throws(
    () => verifyReleaseContext({
      packageJson: PACKAGE_JSON,
      changelog: changelogFor(
        `## ${version} (2026-07-16)`,
        `
## ${version}
`,
      ),
      releaseTag: version,
    }),
    /exactly one heading/,
  );

  const approximateDuplicates = [
    `## ${version}\t(2026-07-15)`,
    `## ${version}\v(2026-07-15)`,
    `## ${version}: duplicate`,
    `## ${version}  (2026-07-15)`,
    `## ${version}\u2003(2026-07-15)`,
  ];
  for (const duplicate of approximateDuplicates) {
    assert.throws(
      () => verifyReleaseContext({
        packageJson: PACKAGE_JSON,
        changelog: changelogFor(
          `## ${version} (2026-07-16)`,
          `\n${duplicate}\n`,
        ),
        releaseTag: version,
      }),
      /CHANGELOG/,
      duplicate,
    );
  }

  assert.throws(
    () => verifyReleaseContext({
      packageJson: PACKAGE_JSON,
      changelog: changelogFor(
        `## ${version} (2026-07-16)`,
        `\u2028## ${version}\u2029`,
      ),
      releaseTag: version,
    }),
    /exactly one heading/,
  );

  assert.throws(
    () => verifyReleaseContext({
      packageJson: PACKAGE_JSON,
      changelog: changelogFor(
        `## ${version} (2026-07-16)`,
        `\u0085## ${version}\u0085`,
      ),
      releaseTag: version,
    }),
    /exactly one heading/,
  );

  for (const changelog of [
    changelogFor(`## ${version}`, `\n${version}\n---\n`),
    `# Changelog\n\n9.9.9\n---\n\n## ${version}\n`,
  ]) {
    assert.throws(
      () => verifyReleaseContext({ packageJson: PACKAGE_JSON, changelog, releaseTag: version }),
      /Setext H2/,
    );
  }
});

test('publish workflow is release-only and passes the tag only through env', () => {
  assert.match(WORKFLOW, /release:\s*\n\s+types: \[published\]/);
  assert.doesNotMatch(WORKFLOW, /workflow_dispatch/);
  assert.match(WORKFLOW, /node scripts\/run-release-check\.js/);
  assert.doesNotMatch(WORKFLOW, /npm install|npm --version|process\.env\.npm_execpath/);
  assert.match(WORKFLOW, /node scripts\/trusted-npm\.js ci --ignore-scripts/);
  assert.doesNotMatch(WORKFLOW, /^\s*run:\s+npm\b/m);

  for (const [name, command] of Object.entries(PACKAGE_JSON.scripts)) {
    assert.doesNotMatch(command, /(?:^|\s)npm(?:\s|$)/, `${name} must not resolve npm through PATH`);
  }

  const expression = '$' + '{{ github.event.release.tag_name }}';
  const expressionLines = WORKFLOW
    .split(/\r?\n/)
    .filter((line) => line.includes(expression))
    .map((line) => line.trim());
  assert.deepEqual(expressionLines, [
    'group: $' + '{{ github.workflow }}-' + expression,
    `RELEASE_TAG: ${expression}`,
    `ref: ${expression}`,
  ]);
  assert.equal(
    WORKFLOW
      .split(/\r?\n/)
      .some((line) => line.includes(expression) && line.trimStart().startsWith('run:')),
    false,
  );
});

test('release source rejects hidden index flags and exports exact commit bytes', (t) => {
  const fixture = createReleaseRepository(t);
  assert.deepEqual(assertCanonicalRepositoryState(fixture.repository, fixture.head), {
    root: fixture.repository,
    commit: fixture.head,
  });

  fixture.run(['update-index', '--assume-unchanged', 'package.json']);
  assert.throws(
    () => assertCanonicalRepositoryState(fixture.repository, fixture.head),
    /index contains assume-unchanged, skip-worktree, or noncanonical flags/,
  );
  fixture.run(['update-index', '--no-assume-unchanged', 'package.json']);

  fs.writeFileSync(path.join(fixture.repository, 'package.json'), '{"name":"dirty"}\n');
  assert.throws(
    () => assertCanonicalRepositoryState(fixture.repository, fixture.head),
    /worktree must be clean/,
  );

  const destination = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-release-export-')));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  exportReleaseCommitTree(fixture.repository, fixture.head, destination);
  assert.equal(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'), '{"name":"fixture"}\n');
});

test('release source rejects Git replace refs before tag or archive authority checks', (t) => {
  const fixture = createReleaseRepository(t);
  fs.writeFileSync(path.join(fixture.repository, 'replacement.txt'), 'replacement tree\n');
  fixture.run(['add', '--all']);
  fixture.run(['commit', '--quiet', '-m', 'replacement']);
  const replacement = fixture.run(['rev-parse', 'HEAD']);
  fixture.run(['checkout', '--quiet', '--detach', fixture.head]);
  fixture.run(['replace', fixture.head, replacement]);
  fixture.run(['reset', '--quiet', '--hard', fixture.head]);
  assert.equal(fixture.run(['status', '--porcelain', '--untracked-files=all']), '');
  assert.throws(
    () => assertCanonicalRepositoryState(fixture.repository, fixture.head),
    /forbidden Git replace refs/,
  );
});

test('release Git authority ignores inherited alternate replacements and Git environment poisoning', (t) => {
  const fixture = createReleaseRepository(t);
  fs.writeFileSync(path.join(fixture.repository, 'replacement.txt'), 'replacement-content\n');
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
    ['-C', fixture.repository, 'archive', '--format=tar', fixture.head],
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

  assert.doesNotThrow(() => assertCanonicalRepositoryState(fixture.repository, fixture.head));
  const destination = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-release-authority-')));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  exportReleaseCommitTree(fixture.repository, fixture.head, destination);
  assert.equal(fs.existsSync(path.join(destination, 'replacement.txt')), false);
});

test('release exact-object export ignores repository-private info attributes', (t) => {
  const fixture = createReleaseRepository(t);
  fs.writeFileSync(path.join(fixture.repository, 'format.txt'), '$Format:%H$\n');
  fixture.run(['add', '--all']);
  fixture.run(['commit', '--quiet', '-m', 'attribute fixture']);
  const commit = fixture.run(['rev-parse', 'HEAD']);
  const info = path.join(fixture.repository, '.git', 'info');
  fs.mkdirSync(info, { recursive: true });
  fs.writeFileSync(
    path.join(info, 'attributes'),
    'package.json export-ignore\nformat.txt export-subst\n',
  );

  const raw = spawnSync(
    'git',
    ['-C', fixture.repository, 'archive', '--format=tar', commit],
    { encoding: null, maxBuffer: 16 * 1024 * 1024, shell: false },
  );
  assert.equal(raw.status, 0, raw.stderr?.toString('utf8'));
  assert.equal(raw.stdout.includes(Buffer.from('{"name":"fixture"}')), false);
  assert.equal(raw.stdout.includes(Buffer.from('$Format:%H$')), false);

  assert.doesNotThrow(() => assertCanonicalRepositoryState(fixture.repository, commit));
  const destination = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-release-attributes-')));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  exportReleaseCommitTree(fixture.repository, commit, destination);
  assert.equal(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'), '{"name":"fixture"}\n');
  assert.equal(fs.readFileSync(path.join(destination, 'format.txt'), 'utf8'), '$Format:%H$\n');
});

test('actual release binding preflight ignores poisoned Git environment for HEAD and tag authority', (t) => {
  const fixture = createReleaseRepository(t);
  fs.writeFileSync(
    path.join(fixture.repository, 'package.json'),
    `${JSON.stringify({ name: '@aikdna/kdna-remote-server', version: '0.4.0' })}\n`,
  );
  fixture.run(['add', '--all']);
  fixture.run(['commit', '--quiet', '-m', 'release fixture']);
  const commit = fixture.run(['rev-parse', 'HEAD']);
  fixture.run(['tag', '0.4.0']);

  const poison = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.useReplaceRefs',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_DIR: '/nonexistent/poisoned-git-dir',
    GIT_INDEX_FILE: '/nonexistent/poisoned-index',
    GIT_OBJECT_DIRECTORY: '/nonexistent/poisoned-objects',
    GIT_REPLACE_REF_BASE: 'refs/alternate-replacements/',
    GIT_WORK_TREE: '/nonexistent/poisoned-worktree',
    GITHUB_REF: 'refs/tags/0.4.0',
    GITHUB_SHA: commit,
  };
  const prior = Object.fromEntries(
    Object.keys(poison).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, poison);
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  assert.deepEqual(assertCurrentReleaseBinding(fixture.repository), {
    pkg: { name: '@aikdna/kdna-remote-server', version: '0.4.0' },
    commit,
  });
});

test('release exact-object export rejects tracked symlink and non-file modes', (t) => {
  const fixture = createReleaseRepository(t);
  fs.symlinkSync('package.json', path.join(fixture.repository, 'linked-manifest'));
  fixture.run(['add', '--all']);
  fixture.run(['commit', '--quiet', '-m', 'symlink fixture']);
  const commit = fixture.run(['rev-parse', 'HEAD']);
  assert.doesNotThrow(() => assertCanonicalRepositoryState(fixture.repository, commit));
  const destination = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-release-mode-')));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  assert.throws(
    () => exportReleaseCommitTree(fixture.repository, commit, destination),
    /unsupported mode or object type/,
  );
});
