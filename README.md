# KDNA Remote public Read candidate

`@aikdna/kdna-remote-server@0.6.0-rc.component-semantics.1` exposes one bounded HTTP adapter over the existing reference Host. It is a candidate for independent evaluation, with no publication or deployment claim.

```js
import http from 'node:http';
import { createRemoteReadHandler } from '@aikdna/kdna-remote-server';

// All five inputs below belong to the deploying application, outside the HTTP body.
const handler = createRemoteReadHandler({
  assetBytes, bindingId, authorizationDomainId,
  resolveContext, verifyContext, observePolicy,
});
const server = http.createServer(handler);
server.listen(0, '127.0.0.1');
// At the end of this binding's bounded lifetime: handler.dispose(); server.close();
```

The application supplies a `Uint8Array` asset, captured by copy at construction. `resolveContext(req)` obtains a context using the application's trusted server-side mechanism; `verifyContext(context)` must verify that context for this exact binding on every Host check. Matching caller JSON or a self-reported identifier is not verification. No verifier is bundled here. Missing context verification rejects, and a missing policy observer denies. `observePolicy` receives the original Host observation: current formal request, Core snapshot data including A/C/E, context, and current time. It returns the existing Host policy, including exact node scope, epoch, and policy ID. Any mapping of issuer, authorization domain, exact asset/version/digests, current entitlement, revocation or scope belongs to that trusted deployment observer.

Each handler represents one server-owned asset and one authorization-domain/context binding. It retains one original Core snapshot/provider and supports fresh request IDs and existing expansion handles until its bounded session ends. It does not route tenants from HTTP fields or reopen a closed session. The application must dispose it and decide explicitly when to create a new independently authorized binding. Construction does not grant access.

Send `POST /read` with `Content-Type: application/json` and a body containing the complete existing ReadRequest itself: `request_id`, the complete current `tuple`, `budget_bytes`, `mode`, `selection`, and `handle`. Read admits the closed schema and preserves its diagnostic ordering. No file upload, filesystem path, callback, dynamic module, trust source, asset selector or operation override is accepted. Query strings are not routes. Compressed request bodies are unsupported. Task/axiom input returns `REMOTE_LEGACY_TASK_UNSUPPORTED` (501); `/activate`, `/load`, `/execute`, `/export`, `/plan`, `/plan-load` and `/projection` return `REMOTE_CAPABILITY_UNAVAILABLE` (501). The former loader, projection, entitlement, audit and CLI exports are absent from this package.

HTTP responses use the public Host `readResultResponse` without an outer wrapper: 200 only for a formal ready envelope, 422 for formal rejection, 413 with no body for a control budget too small, and 502 with no body for transport failure. HTTP admission errors use sanitized adapter/Host error codes. Exact public request, asset, snapshot, receipt and budget fields are preserved; `states.action_authorization` remains `not_evaluated`. Encrypted assets, encryption descriptors, signatures and checksums unsupported by the fixed Core remain refused; Remote does not decrypt, strip metadata, repack, interpret axioms or fall back to an older Core.

The retained Host's `deliverResponse` receives the actual Node response sink. It confirms only Node's server-side `finish` event; socket close, error or timeout fails confirmation and Host handle commitment. The handler returns the Host result to its trusted local caller, allowing it to observe `transport_failure` after an unsuccessful sink. A prepared envelope already contains its receipt; bytes already written cannot be recalled if a later policy check or disconnect fails. A server-side finish is not remote acknowledgement or proof that a client processed the result.

Consumers should use the public `admitReadTransportResponse` with their independently established expected tuple, asset, digests, request correlation and endpoint association. Accepted transport results retain `origin: remote`; remote identity, authorization, current revocation and network replay remain `NOT_PROVEN`, receipt delivery remains `REMOTE_CLAIM_ONLY`, and every local capability remains false. This adapter creates no cross-host trust root, issuer verifier, license signature format, cryptographic algorithm or global replay protection.

Configuration is closed. In addition to the required binding/asset inputs and server functions, options are `hostId`, `clock`, `ttlMs`, `maxReads`, `maxInputBytes`, `maxResponseBytes`, `admissionResponseBytes`, `policyTimeoutMs`, `maxRequestBytes`, `requestTimeoutMs`, and `deliveryTimeoutMs`. Existing Host maxima remain: 16 attempts/reads, 10 MiB asset, 1 MiB response, 4096-byte admission control, 300000 ms session TTL and 30000 ms policy timeout. JSON input is at most 65536 bytes; request and delivery timeouts default to 5000 ms and cannot exceed 30000 ms. Concurrent reads reject with `HOST_BUSY`; rejected and busy attempts count toward the handler limit. Host limits, current context, policy rechecks, terminal close, and Core brands are not recreated by Remote.

This candidate is evaluated only against these exact artifacts, with one Core instance in the dependency graph:

| Package | Version | SHA-256 |
| --- | --- | --- |
| `@aikdna/kdna-core` | `0.24.0-rc.component-semantics.2` | `a9cb3f08735b00657e4848766f0ac517abdcb256121a841f01e662525a0858ea` |
| `@aikdna/kdna-read` | `0.3.0-rc.component-semantics.2` | `43d0f12a1a63a88d26570bfff821919a5cd478fdbd0568bd9c819bc56078b0f0` |
| `@aikdna/kdna-web-server` | `0.5.0-rc.component-semantics.1` | `4057a84b76d173470c59f95dc0e73af81aa21d36876f6daf4226c1ceaefc7551` |

Peer version labels alone do not establish these artifact identities. Deploying or independently evaluating a different artifact graph requires a fresh compatibility decision. This package has no production credentials, filesystem loader, automatic policy allow rule, service startup on import, or dependency installation script.


## Repository development

The current repository entry is `npm test`; it runs `scripts/check-current-surface.mjs` and the explicitly named `tests/current-read.test.mjs`. `npm run lint` checks current sources. First materialize the development graph with `npm ci --ignore-scripts --omit=optional --no-audit --no-fund`; one lock entry, the pako dev tarball, resolves to its canonical registry coordinate rather than to `vendor/`, so this step reaches the registry once and the exact bytes a consumer installs are unchanged. Exact Core/Read/Host development inputs are in `vendor/`; the remaining third-party development tarballs are reproducible local repacks of the retained installed graph, with provenance and true npm integrity recorded. Optional native cbor-extract lock records are retained verbatim from the old repository lock as metadata and are omitted; their native artifacts are not needed or newly verified. No old Core 0.21 entry remains in the current lock.

The old `src/server.js`, `src/projection.js`, `src/entitlement.js`, `src/audit.js`, older tests, development fixtures and release scripts remain historical source, outside the explicit seven-file package and current test entry. They do not describe the current exported API. The old CLI entry explicitly reports unavailable. Previous CHANGELOG sections are unchanged historical records. Current CI runs the same `npm ci` flags this section documents, then the current test entry, the lint check and a dry-run pack. The candidate has no publication authorization: release/prepublish and the publication workflow are explicit blocked gates pending a separately reviewed current release process.

## Current component graph

This candidate binds the current public Core, Read and reference Host. Taxonomy, candidate-set and discriminator-set content is carried in the public Read projection; this package adds no component interpreter or action permission. Exact versions, artifact hashes and scope limits are recorded in `public-contract-binding.json`.
