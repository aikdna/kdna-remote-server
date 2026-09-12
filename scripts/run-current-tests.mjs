import { spawnSync } from 'node:child_process';
for (const args of [['scripts/check-current-surface.mjs'], ['--test', '--test-timeout=10000', 'tests/current-read.test.mjs'], ['tests/components/current-components.mjs', 'remote']]) {
 const r = spawnSync(process.execPath, args, { stdio: 'inherit' }); if (r.status !== 0 || r.error || r.signal) process.exit(r.status || 1);
}
