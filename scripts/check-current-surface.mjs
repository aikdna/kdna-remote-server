import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
assert.deepEqual(pkg.files, ['src/index.js', 'src/index.d.ts', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'public-contract-binding.json']);
assert.equal(pkg.version, lock.version); assert.equal(pkg.version, lock.packages[''].version);
assert.equal(pkg.bin, undefined); assert.deepEqual(Object.keys(pkg.exports), ['.']);
assert.equal(lock.packages['node_modules/@aikdna/kdna-core'].version, '0.24.0-rc.component-semantics.2');
assert.equal(lock.packages['node_modules/@aikdna/kdna-read'].version, '0.3.0-rc.component-semantics.2');
assert.equal(lock.packages['node_modules/@aikdna/kdna-web-server'].version, '0.5.0-rc.component-semantics.1');
// A `file:` coordinate must still carry the vendored bytes it names. A registry reference stays
// exceptional: omitted optional metadata, or a third-party dev dependency pinned to one exact version
// whose tarball URL is the canonical registry URL for that version. @aikdna/* packages stay
// candidate-bound, and the lock integrity (sha512) still binds the installed bytes, so a registry
// coordinate here can only resolve to bytes identical to the vendored archive.
const REGISTRY_TARBALL = /^https:\/\/registry\.npmjs\.org\/(?:@[^/]+\/)?[^/]+\/-\/[^/]+-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/u;
for (const [key, value] of Object.entries(lock.packages)) {
  if (value.resolved?.startsWith('file:')) {
    const bytes = readFileSync(new URL('../' + value.resolved.slice(5), import.meta.url));
    assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), value.integrity, key);
  } else if (key) {
    const name = key.replace(/^node_modules\//u, '');
    const exactRegistryDevDependency = value.dev === true
      && !name.startsWith('@aikdna/')
      && /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value.integrity ?? '')
      && typeof value.resolved === 'string'
      && REGISTRY_TARBALL.test(value.resolved)
      && value.resolved.endsWith(`/${name.replace(/^@[^/]+\//u, '')}-${value.version}.tgz`);
    assert(
      value.optional === true || exactRegistryDevDependency,
      `Only omitted optional metadata or a third-party exact registry pin may use registry references: ${key}`,
    );
  }
}
console.log(JSON.stringify({ current: pkg.version, installedCore: lock.packages['node_modules/@aikdna/kdna-core'].version,
  fullSrcInventory: readdirSync(new URL('../src/', import.meta.url)).sort(), exactPackageFiles: [...pkg.files, 'package.json'], oldModulesExcluded: true }));
