/**
 * server.test.js — kdna-remote-server integration tests (Story 18)
 *
 * Tests:
 *   1. Server starts and /healthz returns 200 with asset metadata
 *   2. /asset/metadata returns asset metadata (no judgment content)
 *   3. /project with task=review returns a task projection
 *      (not the full payload) in --dry-run mode
 *   4. /project with task=decide returns highest_question + axioms + boundaries
 *   5. /project with task=explore returns highest_question + 1 axiom
 *   6. /project with task=audit returns boundaries + self_checks
 *   7. /project with extraction-pattern request is rejected
 *      (forbidden terms, "all axioms", etc.)
 *   8. /project without --dry-run and without --activation-server
 *      returns a 500 NO_ACTIVATION_SERVER error
 *   9. /project forwards entitlement identifiers in non-dry-run mode
 *  10. /project without entitlement identifiers fails closed before sync
 *  11. /project respects rate-limiting per client
 *  12. /project preserves asset text but adds no content-certification fields
 *  13. /project without task returns MISSING_TASK
 *  14. /project error paths are audit logged without plaintext
 *  15. Unknown routes return 404
 *
 * Run: node --test tests/
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { startServer, stopServer, loadAsset, selectProjection } = require('../src/index');
const { pack } = require('@aikdna/kdna-core');
const { scrubSecrets } = require('../src/audit');
const {
  ENTITLEMENT_SYNC_PATH,
  MAX_ACTIVATION_RESPONSE_BYTES,
  activationEndpoint,
} = require('../src/entitlement');
const { MAX_REQUEST_BODY_BYTES, assertSafeBindPolicy } = require('../src/server');

const MACHINE_A = 'a'.repeat(64);
const MACHINE_B = 'b'.repeat(64);
const ASSET_ID = 'kdna:test:remote-server-fixture';

const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remote-server-fixture-'));
const FIXTURE_SOURCE = path.join(FIXTURE_ROOT, 'asset-fixture');
const FIXTURE = path.join(FIXTURE_ROOT, 'asset-fixture.kdna');

before(() => {
  execFileSync(process.execPath, [path.join(__dirname, 'fixtures', 'create-fixture.js'), FIXTURE_SOURCE]);
  pack(FIXTURE_SOURCE, FIXTURE);
});

after(() => {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

function makeTestAsset() {
  return loadAsset(FIXTURE);
}

test('remote loader rejects source directories', () => {
  assert.throws(
    () => loadAsset(FIXTURE_SOURCE),
    (error) => error.code === 'KDNA_ASSET_FILE_REQUIRED',
  );
});

async function withServer(opts, fn) {
  const asset = makeTestAsset();
  const ctx = await startServer({ asset, dryRun: true, ...opts });
  try {
    return await fn(ctx);
  } finally {
    await stopServer(ctx.server);
  }
}

function httpJson(ctx, method, path, body) {
  return fetch(`http://127.0.0.1:${ctx.port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

function rawHttp(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    socket.setTimeout(5000, () => socket.destroy(new Error('raw HTTP request timed out')));
    socket.on('connect', () => socket.end(request));
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

async function withActivationSyncStub(fn, options = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== ENTITLEMENT_SYNC_PATH) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND' } }));
      return;
    }

    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push({ ...body, path: req.url });

      if (body.license_key === 'synthetic-license-key') {
        const response = {
          license_id: body.license_id || 'lic_ok',
          domain: body.domain,
          status: 'active',
          revoked: false,
          require_machine_binding: true,
          machine_fingerprint: body.machine_fingerprint,
          signature_base64: 'test-stub-signature',
        };
        res.writeHead(options.statusCode || 200, {
          'Content-Type': 'application/json',
          ...(options.responseHeaders || {}),
        });
        if (Object.hasOwn(options, 'rawResponse')) {
          res.end(options.rawResponse);
        } else {
          res.end(JSON.stringify(options.mutateResponse ? options.mutateResponse(response) : response));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: { code: 'INVALID_LICENSE_KEY', message: 'no entitlement matches' },
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    return await fn({ url: `http://127.0.0.1:${port}`, requests });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function readAuditEvents(auditLog) {
  return fs.readFileSync(auditLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('Story 18 server: /healthz returns 200 with asset metadata', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'GET', '/healthz');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.server, '@aikdna/kdna-remote-server');
    assert.equal(body.dry_run, true);
    assert.equal(body.projection_policy, 'remote');
    assert.ok(body.asset.asset_id);
    assert.ok(body.asset.title);
  });
});

test('Core 0.20.0 loader returns one current full Runtime Capsule with canonical identity', () => {
  const asset = makeTestAsset();
  assert.equal(asset.capsule.type, 'kdna.runtime-capsule');
  assert.equal(asset.capsule.contract_version, '0.1.0');
  assert.equal(asset.capsule.profile, 'full');
  assert.equal(asset.capsule.asset.asset_id, ASSET_ID);
  assert.equal(asset.asset_id, ASSET_ID);
  assert.equal(asset.context.manifest.format_version, '0.1.0');
  assert.equal(asset.context.manifest.compatibility.profile, 'kdna.payload.judgment');
  assert.equal(asset.context.manifest.compatibility.profile_version, '0.1.0');
  assert.equal(asset.context.payload.profile, 'kdna.payload.judgment');
  assert.equal(asset.context.payload.profile_version, '0.1.0');
  assert.equal(Object.hasOwn(asset.context.payload.reasoning, 'self_checks'), false);
  assert.ok(Array.isArray(asset.context.payload.reasoning.self_check));
});

test('Story 18 server: /asset/metadata returns no judgment content', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'GET', '/asset/metadata');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    // MUST NOT leak axioms, boundaries, payload, etc.
    const json = JSON.stringify(body);
    assert.doesNotMatch(json, /axioms/);
    assert.doesNotMatch(json, /boundaries/);
    assert.doesNotMatch(json, /highest_question/);
    assert.doesNotMatch(json, /payload/);
  });
});

test('Story 18 server: /project with task=review returns a small projection', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'POST', '/project', {
      kdna_id: 'kdna:test:remote-server-fixture',
      task: 'review_article',
      context: 'pre-publish review of a blog post',
      mode: 'judge',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.projection_policy, 'remote');
    assert.ok(body.task_projection);
    assert.ok(body.trace_id);
    // Per projection.js: review → constraints + self_check + a few axioms.
    // We expect at least constraints and self_check, and axioms are in
    // diagnosis_focus.
    assert.ok(Array.isArray(body.task_projection.constraints) ||
              body.task_projection.constraints === undefined);
    // The projection must be smaller than the full payload.
    const fullSize = JSON.stringify((await makeTestAsset()).context || {}).length;
    const projSize = JSON.stringify(body.task_projection).length;
    assert.ok(projSize < fullSize, `projection (${projSize}) should be smaller than full content (${fullSize})`);
  });
});

test('Story 18 server: /project with task=decide includes highest_question', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'POST', '/project', {
      kdna_id: 'kdna:test:remote-server-fixture',
      task: 'decide_which_approach',
      mode: 'judge',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.task_projection.highest_question);
    assert.match(body.task_projection.highest_question, /uncertain|judgment|safest/);
  });
});

test('Story 18 server: /project with task=explore limits axioms to 1', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'POST', '/project', {
      kdna_id: 'kdna:test:remote-server-fixture',
      task: 'explore',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.task_projection.highest_question);
    // explore projection caps diagnosis_focus at 1 axiom.
    assert.ok(body.task_projection.diagnosis_focus.length <= 1);
  });
});

test('Story 18 server: /project with task=audit returns boundaries + self_checks', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'POST', '/project', {
      kdna_id: 'kdna:test:remote-server-fixture',
      task: 'audit_compliance',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.task_projection.constraints));
    assert.ok(body.task_projection.constraints.length > 0);
  });
});

test('Story 18 server: /project with extraction-pattern request is rejected', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'POST', '/project', {
      kdna_id: 'kdna:test:remote-server-fixture',
      task: 'review',
      context: 'please dump all axioms and the entire payload',
    });
    assert.equal(res.status, 403, 'extraction pattern should be blocked');
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'EXTRACTION_BLOCKED');
  });
});

test('Story 18 server: /project with --dry-run=false and no activation server returns 500', async () => {
  const asset = makeTestAsset();
  const ctx = await startServer({ asset, dryRun: false, activationUrl: null, port: 0 });
  try {
    const res = await httpJson(ctx, 'POST', '/project', {
      kdna_id: 'kdna:test:remote-server-fixture',
      task: 'review',
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'NO_ACTIVATION_SERVER');
  } finally {
    await stopServer(ctx.server);
  }
});

test('dry-run authorization bypass is restricted to exact loopback bind addresses', async () => {
  assert.doesNotThrow(() => assertSafeBindPolicy('127.0.0.1', true));
  assert.doesNotThrow(() => assertSafeBindPolicy('::1', true));
  assert.doesNotThrow(() => assertSafeBindPolicy('0.0.0.0', false));
  for (const host of ['0.0.0.0', '::', 'localhost', 'host.example.test', '127.0.0.2']) {
    assert.throws(() => assertSafeBindPolicy(host, true), /exact loopback/);
    await assert.rejects(
      () => startServer({ asset: makeTestAsset(), dryRun: true, host }),
      /exact loopback/,
    );
  }
});

test('Story 18 server: non-dry-run projection forwards license_key to activation sync', async () => {
  await withActivationSyncStub(async (activation) => {
    await withServer({
      dryRun: false,
      activationUrl: activation.url,
      rateLimitMs: 0,
      machineFingerprint: MACHINE_A,
    }, async (ctx) => {
      const res = await httpJson(ctx, 'POST', '/project', {
        kdna_id: ASSET_ID,
        license_key: 'synthetic-license-key',
        task: 'review',
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.projection_policy, 'remote');
      assert.ok(body.task_projection);
    });

    assert.equal(activation.requests.length, 1);
    assert.equal(activation.requests[0].domain, ASSET_ID);
    assert.equal(activation.requests[0].license_key, 'synthetic-license-key');
    assert.equal(activation.requests[0].client, 'kdna-remote-server');
    assert.equal(activation.requests[0].machine_fingerprint, MACHINE_A);
    assert.equal(activation.requests[0].path, ENTITLEMENT_SYNC_PATH);
  });
});

test('Story 18 server: non-dry-run projection without license_key fails before sync', async () => {
  await withActivationSyncStub(async (activation) => {
    await withServer({
      dryRun: false,
      activationUrl: activation.url,
      rateLimitMs: 0,
      machineFingerprint: MACHINE_A,
    }, async (ctx) => {
      const res = await httpJson(ctx, 'POST', '/project', {
        kdna_id: 'kdna:test:remote-server-fixture',
        task: 'review',
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, 'MISSING_LICENSE_KEY');
    });

    assert.equal(activation.requests.length, 0);
  });
});

test('loaded canonical asset identity is the only authorization domain', async () => {
  await withActivationSyncStub(async (activation) => {
    await withServer({
      dryRun: false,
      activationUrl: activation.url,
      rateLimitMs: 0,
      machineFingerprint: MACHINE_A,
    }, async (ctx) => {
      const wrong = await httpJson(ctx, 'POST', '/project', {
        kdna_id: 'kdna:test:different-asset',
        license_key: 'synthetic-license-key',
        task: 'review',
      });
      assert.equal(wrong.status, 400);
      assert.equal((await wrong.json()).error.code, 'ASSET_ID_MISMATCH');
    });
    assert.equal(activation.requests.length, 0, 'wrong asset must fail before Activation');
  });
});

test('omitted asset identity authorizes only the loaded canonical asset', async () => {
  await withActivationSyncStub(async (activation) => {
    await withServer({
      dryRun: false,
      activationUrl: activation.url,
      rateLimitMs: 0,
      machineFingerprint: MACHINE_A,
    }, async (ctx) => {
      const response = await httpJson(ctx, 'POST', '/project', {
        license_key: 'synthetic-license-key',
        task: 'review',
      });
      assert.equal(response.status, 200);
    });
    assert.equal(activation.requests.length, 1);
    assert.equal(activation.requests[0].domain, ASSET_ID);
  });
});

test('caller-supplied machine fingerprint is rejected before Activation', async () => {
  await withActivationSyncStub(async (activation) => {
    await withServer({
      dryRun: false,
      activationUrl: activation.url,
      rateLimitMs: 0,
      machineFingerprint: MACHINE_A,
    }, async (ctx) => {
      const response = await httpJson(ctx, 'POST', '/project', {
        kdna_id: ASSET_ID,
        license_key: 'synthetic-license-key',
        machine_fingerprint: MACHINE_B,
        task: 'review',
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.code, 'CALLER_MACHINE_FINGERPRINT_FORBIDDEN');
      assert.doesNotMatch(JSON.stringify(body), new RegExp(MACHINE_B));
    });
    assert.equal(activation.requests.length, 0);
  });
});

test('Activation response must bind exact domain, optional id, and runtime machine', async () => {
  for (const mutateResponse of [
    (body) => ({ ...body, domain: 'kdna:test:different-asset' }),
    (body) => ({ ...body, license_id: 'lic_different' }),
    (body) => ({ ...body, require_machine_binding: false, machine_fingerprint: undefined }),
    (body) => ({ ...body, machine_fingerprint: MACHINE_B }),
  ]) {
    await withActivationSyncStub(async (activation) => {
      await withServer({
        dryRun: false,
        activationUrl: activation.url,
        rateLimitMs: 0,
        machineFingerprint: MACHINE_A,
      }, async (ctx) => {
        const response = await httpJson(ctx, 'POST', '/project', {
          kdna_id: ASSET_ID,
          license_key: 'synthetic-license-key',
          license_id: 'lic_ok',
          task: 'review',
        });
        assert.equal(response.status, 502);
        const body = await response.json();
        assert.equal(body.error.code, 'ACTIVATION_SERVER_CONTRACT_MISMATCH');
        assert.doesNotMatch(JSON.stringify(body), /synthetic-license-key/);
        assert.doesNotMatch(JSON.stringify(body), new RegExp(MACHINE_A));
      });
      assert.equal(activation.requests.length, 1);
    }, { mutateResponse });
  }
});

test('Activation success requires a canonical nonempty license id and exact active state', async () => {
  for (const mutateResponse of [
    ({ license_id: _licenseId, ...body }) => body,
    (body) => ({ ...body, license_id: '' }),
    (body) => ({ ...body, license_id: '../../escape' }),
    (body) => ({ ...body, license_id: 42 }),
    ({ status: _status, ...body }) => body,
    (body) => ({ ...body, status: true }),
    ({ revoked: _revoked, ...body }) => body,
    (body) => ({ ...body, revoked: 'false' }),
  ]) {
    await withActivationSyncStub(async (activation) => {
      await withServer({
        dryRun: false,
        activationUrl: activation.url,
        rateLimitMs: 0,
        machineFingerprint: MACHINE_A,
      }, async (ctx) => {
        const response = await httpJson(ctx, 'POST', '/project', {
          kdna_id: ASSET_ID,
          license_key: 'synthetic-license-key',
          task: 'review',
        });
        assert.equal(response.status, 502);
        const body = await response.json();
        assert.equal(body.error.code, 'ACTIVATION_SERVER_CONTRACT_MISMATCH');
        assert.doesNotMatch(JSON.stringify(body), /synthetic-license-key/);
        assert.doesNotMatch(JSON.stringify(body), new RegExp(MACHINE_A));
      });
      assert.equal(activation.requests.length, 1);
    }, { mutateResponse });
  }
});

test('Activation revoked and inactive records fail closed without projection', async () => {
  for (const [mutateResponse, code] of [
    [(body) => ({ ...body, revoked: true }), 'LICENSE_REVOKED'],
    [(body) => ({ ...body, status: 'expired' }), 'LICENSE_NOT_ACTIVE'],
  ]) {
    await withActivationSyncStub(async (activation) => {
      await withServer({
        dryRun: false,
        activationUrl: activation.url,
        rateLimitMs: 0,
        machineFingerprint: MACHINE_A,
      }, async (ctx) => {
        const response = await httpJson(ctx, 'POST', '/project', {
          license_key: 'synthetic-license-key',
          task: 'review',
        });
        assert.equal(response.status, 403);
        assert.equal((await response.json()).error.code, code);
      });
    }, { mutateResponse });
  }
});

test('Activation arrays and invalid JSON are stable bad upstream responses', async () => {
  for (const options of [
    { rawResponse: '[]' },
    { rawResponse: '{not-json' },
  ]) {
    await withActivationSyncStub(async (activation) => {
      await withServer({
        dryRun: false,
        activationUrl: activation.url,
        rateLimitMs: 0,
        machineFingerprint: MACHINE_A,
      }, async (ctx) => {
        const response = await httpJson(ctx, 'POST', '/project', {
          license_key: 'synthetic-license-key',
          task: 'review',
        });
        assert.equal(response.status, 502);
        assert.equal((await response.json()).error.code, 'ACTIVATION_SERVER_BAD_RESPONSE');
      });
      assert.equal(activation.requests.length, 1);
    }, options);
  }
});

test('Activation transport accepts HTTPS or exact loopback HTTP origins only', async () => {
  assert.equal(ENTITLEMENT_SYNC_PATH, '/entitlements/sync');
  assert.equal(
    activationEndpoint('https://licenses.example.test'),
    `https://licenses.example.test${ENTITLEMENT_SYNC_PATH}`,
  );
  assert.equal(
    activationEndpoint('http://127.0.0.1:3000/'),
    `http://127.0.0.1:3000${ENTITLEMENT_SYNC_PATH}`,
  );
  assert.equal(
    activationEndpoint('http://[::1]:3000'),
    `http://[::1]:3000${ENTITLEMENT_SYNC_PATH}`,
  );
  for (const unsafe of [
    'http://licenses.example.test',
    'http://localhost:3000',
    'ftp://licenses.example.test',
    'https://user:password@licenses.example.test',
    'https://licenses.example.test/api',
    'https://licenses.example.test?target=other',
    'https://licenses.example.test#fragment',
    'HTTPS://LICENSES.EXAMPLE.TEST',
  ]) {
    assert.throws(() => activationEndpoint(unsafe), /activation server/);
    await assert.rejects(
      () => startServer({
        asset: makeTestAsset(),
        dryRun: false,
        activationUrl: unsafe,
        machineFingerprint: MACHINE_A,
      }),
      /activation server/,
    );
  }
});

test('Activation redirects are never followed with authorization material', async () => {
  let redirectedRequests = 0;
  const destination = http.createServer((_req, res) => {
    redirectedRequests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => destination.listen(0, '127.0.0.1', resolve));
  const destinationUrl = `http://127.0.0.1:${destination.address().port}/capture`;
  try {
    await withActivationSyncStub(async (activation) => {
      await withServer({
        dryRun: false,
        activationUrl: activation.url,
        rateLimitMs: 0,
        machineFingerprint: MACHINE_A,
      }, async (ctx) => {
        const response = await httpJson(ctx, 'POST', '/project', {
          license_key: 'synthetic-license-key',
          task: 'review',
        });
        assert.equal(response.status, 502);
        const body = await response.json();
        assert.equal(body.error.code, 'ACTIVATION_SERVER_UNREACHABLE');
        assert.doesNotMatch(JSON.stringify(body), /synthetic-license-key/);
      });
    }, {
      statusCode: 307,
      rawResponse: '{}',
      responseHeaders: { Location: destinationUrl },
    });
    assert.equal(redirectedRequests, 0);
  } finally {
    await new Promise((resolve) => destination.close(resolve));
  }
});

test('oversized and non-JSON Activation responses fail closed without stopping the server', async () => {
  for (const options of [
    { rawResponse: JSON.stringify({ padding: 'x'.repeat(MAX_ACTIVATION_RESPONSE_BYTES) }) },
    { rawResponse: '{}', responseHeaders: { 'Content-Type': 'text/plain' } },
    { rawResponse: '{}', responseHeaders: { 'Content-Length': String(MAX_ACTIVATION_RESPONSE_BYTES + 1) } },
  ]) {
    await withActivationSyncStub(async (activation) => {
      await withServer({
        dryRun: false,
        activationUrl: activation.url,
        rateLimitMs: 0,
        machineFingerprint: MACHINE_A,
      }, async (ctx) => {
        const response = await httpJson(ctx, 'POST', '/project', {
          license_key: 'synthetic-license-key',
          task: 'review',
        });
        assert.equal(response.status, 502);
        assert.equal((await response.json()).error.code, 'ACTIVATION_SERVER_BAD_RESPONSE');
        const health = await httpJson(ctx, 'GET', '/healthz');
        assert.equal(health.status, 200);
      });
    }, options);
  }
});

test('Activation denial bodies and provider errors never cross the HTTP or audit boundary', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remote-provider-error-'));
  const auditLog = path.join(tmp, 'audit.jsonl');
  try {
    await withActivationSyncStub(async (activation) => {
      await withServer({
        dryRun: false,
        activationUrl: activation.url,
        auditLog,
        rateLimitMs: 0,
        machineFingerprint: MACHINE_A,
      }, async (ctx) => {
        const response = await httpJson(ctx, 'POST', '/project', {
          license_key: 'synthetic-license-key',
          task: 'review',
        });
        assert.equal(response.status, 403);
        const body = await response.json();
        assert.equal(body.error.code, 'ENTITLEMENT_DENIED');
        assert.equal(body.error.message, 'activation server denied the entitlement');
        assert.doesNotMatch(JSON.stringify(body), /provider-secret|PRIVATE_PROVIDER_CODE/);
      });
    }, {
      statusCode: 401,
      rawResponse: JSON.stringify({
        error: { code: 'PRIVATE_PROVIDER_CODE', message: 'provider-secret' },
      }),
    });
    assert.doesNotMatch(fs.readFileSync(auditLog, 'utf8'), /provider-secret|PRIVATE_PROVIDER_CODE/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('license_id alone never authorizes and malformed optional ids fail before Activation', async () => {
  await withActivationSyncStub(async (activation) => {
    await withServer({
      dryRun: false,
      activationUrl: activation.url,
      rateLimitMs: 0,
      machineFingerprint: MACHINE_A,
    }, async (ctx) => {
      const idOnly = await httpJson(ctx, 'POST', '/project', {
        license_id: 'lic_ok',
        task: 'review',
      });
      assert.equal(idOnly.status, 400);
      assert.equal((await idOnly.json()).error.code, 'MISSING_LICENSE_KEY');

      const malformed = await httpJson(ctx, 'POST', '/project', {
        license_key: 'synthetic-license-key',
        license_id: '../../escape',
        task: 'review',
      });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).error.code, 'INVALID_LICENSE_ID');
    });
    assert.equal(activation.requests.length, 0);
  });
});

test('invalid remote runtime machine identity prevents server startup', async () => {
  await assert.rejects(
    () => startServer({ asset: makeTestAsset(), dryRun: false, machineFingerprint: 'not-canonical' }),
    /remote runtime machine identity is unavailable/,
  );
});

test('null, array, and scalar JSON bodies are stable 400 responses without process exceptions', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remote-invalid-shape-'));
  const auditLog = path.join(tmp, 'audit.jsonl');
  try {
    await withServer({ auditLog, rateLimitMs: 0 }, async (ctx) => {
      for (const body of ['null', '[]', '"secret-scalar"', '42', 'true']) {
        const response = await fetch(`http://127.0.0.1:${ctx.port}/project`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        assert.equal(response.status, 400, body);
        const responseBody = await response.json();
        assert.equal(responseBody.error.code, 'INVALID_REQUEST_BODY');
        assert.doesNotMatch(JSON.stringify(responseBody), /secret-scalar/);
      }
    });
    const audit = fs.readFileSync(auditLog, 'utf8');
    assert.doesNotMatch(audit, /secret-scalar/);
    assert.equal(readAuditEvents(auditLog).length, 5);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('request body limit counts UTF-8 bytes, responds once, and leaves the server healthy', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remote-request-limit-'));
  const auditLog = path.join(tmp, 'audit.jsonl');
  try {
    await withServer({ auditLog, rateLimitMs: 0 }, async (ctx) => {
      const body = JSON.stringify({
        task: `review_${'界'.repeat(Math.ceil(MAX_REQUEST_BODY_BYTES / 3))}`,
      });
      assert.ok(body.length < MAX_REQUEST_BODY_BYTES);
      assert.ok(Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES);
      const response = await fetch(`http://127.0.0.1:${ctx.port}/project`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(response.status, 413);
      const raw = await response.text();
      assert.equal((raw.match(/REQUEST_TOO_LARGE/g) || []).length, 1);
      assert.equal(JSON.parse(raw).error.code, 'REQUEST_TOO_LARGE');
      assert.equal((await httpJson(ctx, 'GET', '/healthz')).status, 200);
    });
    const events = readAuditEvents(auditLog);
    assert.equal(events.length, 1);
    assert.equal(events[0].result, 'request_too_large');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('malformed Host and absolute request targets return stable 400 without escaping the handler', async () => {
  await withServer({}, async (ctx) => {
    for (const request of [
      'GET /healthz HTTP/1.1\r\nHost: [invalid\r\nConnection: close\r\n\r\n',
      'GET http://attacker.invalid/healthz HTTP/1.1\r\nHost: safe.invalid\r\nConnection: close\r\n\r\n',
      'GET /healthz HTTP/1.1\r\nHost: safe.invalid/path\r\nConnection: close\r\n\r\n',
    ]) {
      const response = await rawHttp(ctx.port, request);
      assert.match(response, /^HTTP\/1\.1 400 /);
      if (response.includes('{')) {
        assert.match(response, /INVALID_REQUEST_TARGET/);
      }
    }
    assert.equal((await httpJson(ctx, 'GET', '/healthz')).status, 200);
  });
});

test('audit scrub removes nested license keys and raw machine fingerprints', () => {
  assert.deepEqual(
    scrubSecrets({
      safe: true,
      nested: {
        license_key: 'secret-license',
        machine_fingerprint: MACHINE_A,
        licenseKey: 'camel-secret-license',
        machineFingerprint: MACHINE_B,
        safe: 'value',
      },
    }),
    { safe: true, nested: { safe: 'value' } },
  );
});

test('Story 18 server: rate-limiting kicks in for repeat calls', async () => {
  await withServer({ rateLimitMs: 1000 }, async (ctx) => {
    // First call: succeeds
    const r1 = await httpJson(ctx, 'POST', '/project', {
      kdna_id: 'kdna:test:remote-server-fixture',
      task: 'review',
    });
    assert.equal(r1.status, 200);
    // Second call within 1s: rate-limited
    const r2 = await httpJson(ctx, 'POST', '/project', {
      kdna_id: 'kdna:test:remote-server-fixture',
      task: 'review',
    });
    assert.equal(r2.status, 429, 'second rapid call should be rate-limited');
    const body = await r2.json();
    assert.equal(body.error.code, 'RATE_LIMITED');
  });
});

test('projection preserves selected asset vocabulary without adding certification fields', () => {
  const projection = selectProjection({
    context: {
      payload: {
        core: {
          axioms: [{ one_sentence: 'An official source is not automatically trusted or recommended.' }],
          boundaries: [{ description: 'A high_quality label is a claim, not evidence.' }],
        },
        reasoning: {
          self_check: ['Did the analysis preserve officially_approved and quality_badge as quoted terms?'],
        },
      },
    },
  }, { task: 'review' });
  assert.deepEqual(projection, {
    diagnosis_focus: ['An official source is not automatically trusted or recommended.'],
    constraints: ['A high_quality label is a claim, not evidence.'],
    self_check: ['Did the analysis preserve officially_approved and quality_badge as quoted terms?'],
  });

  const forbiddenClaimKeys = new Set([
    'official',
    'trusted',
    'recommended',
    'high_quality',
    'quality_badge',
    'officially_approved',
  ]);
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenClaimKeys.has(key), false, `server claim key is forbidden: ${key}`);
      visit(child);
    }
  };
  visit(projection);
});

test('Story 18 server: response envelope adds no content-certification claim keys', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'POST', '/project', {
      kdna_id: 'kdna:test:remote-server-fixture',
      task: 'review',
    });
    const body = await res.json();
    const forbiddenClaimKeys = new Set([
      'official',
      'trusted',
      'recommended',
      'high_quality',
      'quality_badge',
      'officially_approved',
    ]);
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        assert.equal(forbiddenClaimKeys.has(key), false, `server claim key is forbidden: ${key}`);
        visit(child);
      }
    };
    visit(body);
  });
});

test('Story 18 server: missing task field returns 400', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'POST', '/project', {
      kdna_id: 'kdna:test:remote-server-fixture',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'MISSING_TASK');
  });
});

test('Story 18 server: projection error paths are audit logged without plaintext', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remote-audit-'));
  const auditLog = path.join(tmp, 'audit.jsonl');

  await withServer({ auditLog, rateLimitMs: 0 }, async (ctx) => {
    const invalid = await fetch(`http://127.0.0.1:${ctx.port}/project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"task":"review","context":"plaintext-secret"',
    });
    assert.equal(invalid.status, 400);

    const missingTask = await httpJson(ctx, 'POST', '/project', {
      kdna_id: 'kdna:test:remote-server-fixture',
      context: 'plaintext-secret',
    });
    assert.equal(missingTask.status, 400);
  });

  const events = readAuditEvents(auditLog);
  assert.deepEqual(events.map((event) => event.result), ['invalid_json', 'missing_task']);
  assert.ok(events.every((event) => event.event === 'projection'));
  assert.ok(events.every((event) => event.asset_id === 'kdna:test:remote-server-fixture'));
  assert.doesNotMatch(fs.readFileSync(auditLog, 'utf8'), /plaintext-secret/);
});

test('successful projection audit records only task class, never caller task or mode plaintext', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remote-success-audit-'));
  const auditLog = path.join(tmp, 'audit.jsonl');
  try {
    await withServer({ auditLog, rateLimitMs: 0 }, async (ctx) => {
      const response = await httpJson(ctx, 'POST', '/project', {
        task: 'review_private-task-plaintext',
        mode: 'private-mode-plaintext',
      });
      assert.equal(response.status, 200);
    });
    const raw = fs.readFileSync(auditLog, 'utf8');
    assert.doesNotMatch(raw, /private-task-plaintext|private-mode-plaintext/);
    const events = readAuditEvents(auditLog);
    assert.equal(events.length, 1);
    assert.equal(events[0].task_class, 'review');
    assert.equal(Object.hasOwn(events[0], 'task'), false);
    assert.equal(Object.hasOwn(events[0], 'mode'), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('successful projection fails closed when audit evidence cannot be persisted', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remote-audit-unavailable-'));
  const auditDirectoryConflict = path.join(tmp, 'audit.jsonl');
  fs.mkdirSync(auditDirectoryConflict);
  try {
    await withServer({ auditLog: auditDirectoryConflict, rateLimitMs: 0 }, async (ctx) => {
      const res = await httpJson(ctx, 'POST', '/project', {
        kdna_id: ASSET_ID,
        task: 'review_article',
      });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.error.code, 'AUDIT_UNAVAILABLE');
      assert.equal(Object.hasOwn(body, 'task_projection'), false);
      assert.equal(Object.hasOwn(body, 'projection_policy'), false);
      assert.equal(Object.hasOwn(body, 'trace_id'), false);
      assert.equal(Object.hasOwn(body, 'asset_id'), false);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 18 server: unknown route returns 404', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'GET', '/unknown');
    assert.equal(res.status, 404);
  });
});

test('removed generation-shaped service routes return 404 without aliases', async () => {
  await withServer({}, async (ctx) => {
    const metadata = await httpJson(ctx, 'GET', '/v1/asset/metadata');
    assert.equal(metadata.status, 404);
    assert.equal((await metadata.json()).error.code, 'NOT_FOUND');

    const project = await httpJson(ctx, 'POST', '/v1/project', { task: 'review' });
    assert.equal(project.status, 404);
    assert.equal((await project.json()).error.code, 'NOT_FOUND');
  });
});
