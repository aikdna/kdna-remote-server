'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function sourceGitEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_')) delete environment[key];
  }
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  environment.GIT_REPLACE_REF_BASE = 'refs/replace';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function gitAuthority(repository, args, { encoding = 'utf8', maxBuffer = 64 * 1024 * 1024 } = {}) {
  const result = spawnSync(
    'git',
    [
      '--no-replace-objects',
      '--literal-pathspecs',
      '-c',
      'core.useReplaceRefs=false',
      '-C',
      repository,
      ...args,
    ],
    {
      cwd: path.parse(repository).root,
      encoding,
      env: sourceGitEnvironment(),
      maxBuffer,
      shell: false,
    },
  );
  if (result.error || result.status !== 0 || result.signal != null) {
    throw new Error('Git authority command failed');
  }
  const stderrEmpty = Buffer.isBuffer(result.stderr) ? result.stderr.length === 0 : result.stderr === '';
  if (!stderrEmpty) throw new Error('Git authority command wrote unexpected stderr');
  return Buffer.isBuffer(result.stdout) ? result.stdout : result.stdout.trim();
}

function exactCommitFiles(repository, commit, pathspec = null) {
  const args = ['ls-tree', '-r', '-z', '--full-tree', commit];
  if (pathspec !== null) args.push('--', pathspec);
  const listing = gitAuthority(repository, args, { encoding: null });
  const records = [];
  let start = 0;
  for (let index = 0; index < listing.length; index += 1) {
    if (listing[index] !== 0) continue;
    if (index > start) records.push(listing.subarray(start, index));
    start = index + 1;
  }
  if (start !== listing.length) throw new Error('exact commit tree listing is not NUL terminated');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const seen = new Set();
  return Object.freeze(records.map((record) => {
    let text;
    try {
      text = decoder.decode(record);
    } catch {
      throw new Error('exact commit tree contains a non-UTF-8 path');
    }
    const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(text);
    if (!match) throw new Error('exact commit tree contains an unsupported mode or object type');
    const [, mode, object, filePath] = match;
    if (
      !filePath ||
      /[\u0000-\u001f\u007f]/u.test(filePath) ||
      filePath.includes('\\') ||
      path.posix.isAbsolute(filePath) ||
      path.posix.normalize(filePath) !== filePath ||
      filePath.split('/').some((segment) => ['', '.', '..'].includes(segment)) ||
      seen.has(filePath)
    ) {
      throw new Error(`exact commit tree path is invalid: ${filePath}`);
    }
    seen.add(filePath);
    const bytes = gitAuthority(repository, ['cat-file', 'blob', object], { encoding: null });
    return Object.freeze({ path: filePath, mode, object, bytes });
  }));
}

module.exports = { exactCommitFiles, gitAuthority, sourceGitEnvironment };
