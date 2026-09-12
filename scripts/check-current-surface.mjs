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
for (const [key, value] of Object.entries(lock.packages)) {
  if (value.resolved?.startsWith('file:')) {
    const bytes = readFileSync(new URL('../' + value.resolved.slice(5), import.meta.url));
    assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), value.integrity, key);
  } else if (key) assert.equal(value.optional, true, `Only omitted optional metadata may use registry references: ${key}`);
}
console.log(JSON.stringify({ current: pkg.version, installedCore: lock.packages['node_modules/@aikdna/kdna-core'].version,
  fullSrcInventory: readdirSync(new URL('../src/', import.meta.url)).sort(), exactPackageFiles: [...pkg.files, 'package.json'], oldModulesExcluded: true }));
