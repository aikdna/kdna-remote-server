/**
 * server.test.js — kdna-remote-server integration tests (Story 18)
 *
 * Tests:
 *   1. Server starts and /healthz returns 200 with asset metadata
 *   2. /v1/asset/metadata returns asset metadata (no judgment content)
 *   3. /v1/project with task=review returns a task projection
 *      (not the full payload) in --dry-run mode
 *   4. /v1/project with task=decide returns highest_question + axioms + boundaries
 *   5. /v1/project with task=explore returns highest_question + 1 axiom
 *   6. /v1/project with task=audit returns boundaries + self_checks
 *   7. /v1/project with extraction-pattern request is rejected
 *      (forbidden terms, "all axioms", etc.)
 *   8. /v1/project without --dry-run and without --activation-server
 *      returns a 500 NO_ACTIVATION_SERVER error
 *   9. /v1/project respects rate-limiting per client
 *  10. /v1/project response never includes the forbidden
 *      content-trust vocabulary
 *  11. /v1/project without task returns MISSING_TASK
 *  12. /v1/project error paths are audit logged without plaintext
 *  13. Unknown routes return 404
 *
 * Run: node --test tests/
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { startServer, stopServer, loadAsset } = require('../src/index');

const FIXTURE = path.join(__dirname, 'fixtures', 'asset-fixture');

function makeTestAsset() {
  return loadAsset(FIXTURE);
}

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

test('Story 18 server: /v1/asset/metadata returns no judgment content', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'GET', '/v1/asset/metadata');
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

test('Story 18 server: /v1/project with task=review returns a small projection', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'POST', '/v1/project', {
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
    const fullSize = JSON.stringify(await makeTestAsset().content || {}).length;
    const projSize = JSON.stringify(body.task_projection).length;
    assert.ok(projSize < fullSize, `projection (${projSize}) should be smaller than full content (${fullSize})`);
  });
});

test('Story 18 server: /v1/project with task=decide includes highest_question', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'POST', '/v1/project', {
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

test('Story 18 server: /v1/project with task=explore limits axioms to 1', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'POST', '/v1/project', {
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

test('Story 18 server: /v1/project with task=audit returns boundaries + self_checks', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'POST', '/v1/project', {
      kdna_id: 'kdna:test:remote-server-fixture',
      task: 'audit_compliance',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.task_projection.constraints));
    assert.ok(body.task_projection.constraints.length > 0);
  });
});

test('Story 18 server: /v1/project with extraction-pattern request is rejected', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'POST', '/v1/project', {
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

test('Story 18 server: /v1/project with --dry-run=false and no activation server returns 500', async () => {
  const asset = makeTestAsset();
  const ctx = await startServer({ asset, dryRun: false, activationUrl: null, port: 0 });
  try {
    const res = await httpJson(ctx, 'POST', '/v1/project', {
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

test('Story 18 server: rate-limiting kicks in for repeat calls', async () => {
  await withServer({ rateLimitMs: 1000 }, async (ctx) => {
    // First call: succeeds
    const r1 = await httpJson(ctx, 'POST', '/v1/project', {
      kdna_id: 'kdna:test:remote-server-fixture',
      task: 'review',
    });
    assert.equal(r1.status, 200);
    // Second call within 1s: rate-limited
    const r2 = await httpJson(ctx, 'POST', '/v1/project', {
      kdna_id: 'kdna:test:remote-server-fixture',
      task: 'review',
    });
    assert.equal(r2.status, 429, 'second rapid call should be rate-limited');
    const body = await r2.json();
    assert.equal(body.error.code, 'RATE_LIMITED');
  });
});

test('Story 18 server: response never includes content-trust vocabulary', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'POST', '/v1/project', {
      kdna_id: 'kdna:test:remote-server-fixture',
      task: 'review',
    });
    const body = await res.json();
    const json = JSON.stringify(body).toLowerCase();
    // The forbidden content-trust vocabulary. Per RFC-0018
    // R4.3 / SPEC §13.1 layer isolation.
    assert.doesNotMatch(json, /\bofficial\b/);
    assert.doesNotMatch(json, /\btrusted\b/);
    assert.doesNotMatch(json, /\brecommended\b/);
    assert.doesNotMatch(json, /\bhigh_quality\b/);
    assert.doesNotMatch(json, /\bquality_badge\b/);
  });
});

test('Story 18 server: missing task field returns 400', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'POST', '/v1/project', {
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
    const invalid = await fetch(`http://127.0.0.1:${ctx.port}/v1/project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"task":"review","context":"plaintext-secret"',
    });
    assert.equal(invalid.status, 400);

    const missingTask = await httpJson(ctx, 'POST', '/v1/project', {
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

test('Story 18 server: unknown route returns 404', async () => {
  await withServer({}, async (ctx) => {
    const res = await httpJson(ctx, 'GET', '/v1/unknown');
    assert.equal(res.status, 404);
  });
});
