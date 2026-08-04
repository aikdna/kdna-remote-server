#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ENTITLEMENT_SYNC_PATH,
  verifyEntitlement,
} = require('../src/entitlement');
const {
  EXPECTED_ACTIVATION_VERSION,
  extractActivationCandidate,
} = require('./activation-candidate');

const ASSET_ID = 'kdna:conformance:activation-remote';
const LICENSE_KEY = 'conformance-license-secret';
const MACHINE_FINGERPRINT = 'a'.repeat(64);

function activationPackageRoot(input) {
  if (input) return path.resolve(input);
  return null;
}

async function verifyActivationContract(input) {
  const extractedCandidate = input ? null : extractActivationCandidate();
  const activationRoot = activationPackageRoot(input) || extractedCandidate.packageRoot;
  if (extractedCandidate) {
    const installedCore = fs.realpathSync(
      path.join(__dirname, '..', 'node_modules', '@aikdna', 'kdna-core'),
    );
    const activationScope = path.join(activationRoot, 'node_modules', '@aikdna');
    fs.mkdirSync(activationScope, { recursive: true, mode: 0o700 });
    fs.symlinkSync(installedCore, path.join(activationScope, 'kdna-core'), 'dir');
  }
  const packageJsonPath = path.join(activationRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(
      'Activation package not found; pass an installed package root as the first argument',
    );
  }

  const activationPackage = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  assert.equal(
    activationPackage.version,
    EXPECTED_ACTIVATION_VERSION,
    `Remote requires the exact Activation ${EXPECTED_ACTIVATION_VERSION} contract package`,
  );

  const activation = require(path.join(activationRoot, 'src', 'index.js'));
  assert.equal(
    activation.ENTITLEMENT_ROUTES.sync,
    ENTITLEMENT_SYNC_PATH,
    'Activation and Remote must use one canonical sync route',
  );
  assert.equal(activation.CORE_CONFORMANCE_VERSION, '0.21.0');
  assert.equal(activation.isCanonicalAssetId(ASSET_ID), true);

  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-activation-remote-contract-'));
    const store = activation.makeStore(dataDir);
    const keys = activation.ensureKeyPair(dataDir);
    const license = store.create({
      domain: ASSET_ID,
      license_key: LICENSE_KEY,
      require_machine_binding: true,
    });
    let context;
    try {
      context = await activation.startServer({ dataDir, store, keys, port: 0 });
      const origin = `http://127.0.0.1:${context.port}`;
      const activated = await fetch(`${origin}${activation.ENTITLEMENT_ROUTES.activate}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: ASSET_ID,
          license_key: LICENSE_KEY,
          machine_fingerprint: MACHINE_FINGERPRINT,
        }),
      });
      assert.equal(activated.status, 200, await activated.text());

      const result = await verifyEntitlement({
        activationUrl: origin,
        kdnaId: ASSET_ID,
        licenseKey: LICENSE_KEY,
        licenseId: license.license_id,
        machineFingerprint: MACHINE_FINGERPRINT,
      });
      assert.deepEqual(result, {
        ok: true,
        status: 200,
        entitlement: {
          license_id: license.license_id,
          domain: ASSET_ID,
          status: 'active',
          revoked: false,
          require_machine_binding: true,
        },
      });
      return {
        activationVersion: activationPackage.version,
        activationSourceHead: extractedCandidate?.binding.source.git_head || null,
        coreVersion: activation.CORE_CONFORMANCE_VERSION,
        remoteVersion: require('../package.json').version,
        route: ENTITLEMENT_SYNC_PATH,
      };
    } finally {
      if (context?.server) await activation.stopServer(context.server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  } finally {
    extractedCandidate?.cleanup();
  }
}

async function main() {
  const evidence = await verifyActivationContract(process.argv[2]);
  process.stdout.write(`${JSON.stringify({ ok: true, ...evidence })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Activation contract verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { verifyActivationContract };
