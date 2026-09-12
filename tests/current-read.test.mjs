import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRemoteReadHandler } from '../src/index.js';
import { fixture, readRequest, allowAll } from './current-fixture.mjs';
async function withServer(observer, run) {
  const context = Object.freeze({ synthetic: true });
  const h = createRemoteReadHandler({ assetBytes: fixture(), bindingId: 'binding:repo', authorizationDomainId: 'domain:repo',
    resolveContext: () => context, verifyContext: c => c === context, observePolicy: observer });
  const s = http.createServer(h); await new Promise(r => s.listen(0, '127.0.0.1', r));
  try { await run(body => fetch(`http://127.0.0.1:${s.address().port}/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })); }
  finally { h.dispose(); s.closeAllConnections(); await new Promise(r => s.close(r)); }
}
test('current formal Read over actual HTTP', async () => withServer(allowAll, async send => {
  const r = await send(readRequest()); const text = await r.text(); const b = JSON.parse(text);
  assert.equal(r.status, 200); assert.equal(b.status, 'ready'); assert.equal(b.states.action_authorization, 'not_evaluated');
  assert.equal(Buffer.byteLength(text), Number(b.budget.actual_bytes)); assert.equal(b.request_id, b.receipt.request_id);
}));
test('default deny and old task refusal stay explicit', async () => {
  await withServer(undefined, async send => { const r = await send(readRequest()); assert.notEqual(r.status, 200); assert.equal((await r.json()).diagnostics[0].code, 'READ_HOST_DENIED'); });
  await withServer(allowAll, async send => { const r = await send({ task: 'review' }); assert.equal(r.status, 501); assert.equal((await r.json()).error.code, 'REMOTE_LEGACY_TASK_UNSUPPORTED'); });
});
