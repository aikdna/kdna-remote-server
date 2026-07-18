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

const ASSET_ID = 'kdna:conformance:activation-remote';
const LICENSE_KEY = 'conformance-license-secret';
const MACHINE_FINGERPRINT = 'a'.repeat(64);

function activationPackageRoot(input) {
  if (input) return path.resolve(input);
  try {
    return path.dirname(require.resolve('@aikdna/kdna-activation-server/package.json'));
  } catch (error) {
    throw new Error(
      'Exact @aikdna/kdna-activation-server@0.2.0 package is not installed',
      { cause: error },
    );
  }
}

async function verifyActivationContract(input) {
  const activationRoot = activationPackageRoot(input);
  const packageJsonPath = path.join(activationRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(
      'Activation package not found; pass an installed package root as the first argument',
    );
  }

  const activationPackage = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  assert.equal(
    activationPackage.version,
    '0.2.0',
    'Remote requires the exact Activation 0.2.0 contract package',
  );

  const activation = require(path.join(activationRoot, 'src', 'index.js'));
  assert.equal(
    activation.ENTITLEMENT_ROUTES.sync,
    ENTITLEMENT_SYNC_PATH,
    'Activation and Remote must use one canonical sync route',
  );
  assert.equal(activation.CORE_CONFORMANCE_VERSION, '0.20.0');
  assert.equal(activation.isCanonicalAssetId(ASSET_ID), true);

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
      coreVersion: activation.CORE_CONFORMANCE_VERSION,
      remoteVersion: require('../package.json').version,
      route: ENTITLEMENT_SYNC_PATH,
    };
  } finally {
    if (context?.server) await activation.stopServer(context.server);
    fs.rmSync(dataDir, { recursive: true, force: true });
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
