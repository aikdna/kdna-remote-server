# @aikdna/kdna-remote-server

**Experimental self-hostable HTTP projection server for KDNA `remote` assets.**

KDNA makes judgment portable across models and runtimes. This repository is an
experimental reference implementation of the remote projection part of that
open protocol; it is not an AIKDNA-hosted service.

This server holds a single `.kdna` asset locally and returns
**task-scoped projections** — never the full payload — to
authorized callers. It implements the candidate
projection contract in [`specs/kdna-runtime-projection.md`][1]
and the self-hosting invariant from [`docs/REMOTE_MODE.md`][2].

The server never opens or decodes asset entries itself. It asks KDNA Core 0.20.0
for one authorized `full` Runtime Capsule, then narrows that Capsule context at
the HTTP boundary for each remote request.

Remote sends entitlement refreshes only to the canonical
`/entitlements/sync` route. Deploy Activation 0.2.0 before Remote 0.4.1 or
later. Remote's test and release gates start the exact installed Activation
0.2.0 package and execute an activate-to-sync exchange before publication.

[1]: https://github.com/aikdna/kdna/blob/main/specs/kdna-runtime-projection.md
[2]: https://github.com/aikdna/kdna/blob/main/docs/REMOTE_MODE.md

---

## Self-hosting is the default

> The KDNA protocol MUST NOT assume a single official KDNA
> server. Any asset creator can run their own remote server.
> No AIKDNA-hosted remote endpoint is part of the current public baseline.

This server is the deployer's own. The protocol does not
hardcode any KDNA Inc. URL; the activation server URL is a
deployer-controlled configuration value (see
`--activation-server` below).

---

## Quick start (self-hosting)

```bash
# 1. Install (any Node 22.9+ server)
npm install -g @aikdna/kdna-remote-server

# 2. Point at a .kdna asset on local disk
kdna-remote-server \
  --asset /path/to/your-asset.kdna \
  --port 3000 \
  --activation-server https://licenses.yoursite.com

# 3. Test
curl http://localhost:3000/healthz
curl -X POST http://localhost:3000/project \
  -H 'Content-Type: application/json' \
  -d '{"kdna_id":"kdna:yourname:your-asset","license_key":"<license-key>","task":"review_article"}'
```

That's it. No AIKDNA registration or hardcoded AIKDNA endpoint. Entitlement
checks go only to the activation server selected by the deployer.

---

## CLI options

```
Required:
  --asset <path>           Path to a packaged .kdna asset file
                           the server will hold locally. The
                           server NEVER fetches assets from the
                           network.

Options:
  --port <n>               Port to listen on. Default 3000.
                           Use 0 for an OS-assigned port (tests).
  --host <addr>            Host to bind. Default 127.0.0.1.
  --activation-server <url>
                           URL of the activation server (see
                           @aikdna/kdna-activation-server).
                           The projection server calls the
                           sync endpoint on every request.
                           Self-hosted; no default URL is
                           hardcoded.
  --dry-run                Skip entitlement verification. For
                           local development without a real
                           activation server. Dry-run may bind
                           only to exact 127.0.0.1 or ::1.
  --audit-log <path>       Append audit events to this file.
                           Default
                           ~/.kdna/remote-server-audit.jsonl.
  --rate-limit-ms <n>      Minimum gap between requests from
                           the same client. Default 100ms.
  --help                   Print this help.
```

---

## HTTP API

### `GET /healthz`

Health check. Returns 200 with asset metadata (no judgment
content).

### `GET /asset/metadata`

Returns the asset's identity (asset_id, title, version, access)
but NEVER any judgment content. Safe to expose to any caller
who needs to introspect the asset.

### `POST /project`

Returns a task projection. The full payload is NEVER returned.

Request body:

```json
{
  "kdna_id": "kdna:yourname:your-asset",
  "license_key": "<license-key>",
  "license_id": "lic_customer_1",
  "task": "review_article",
  "context": "Pre-publish review of a technical blog post",
  "mode": "judge"
}
```

When the server is not running with `--dry-run`, `license_key` is required.
`license_id` is optional and, when supplied, becomes an additional exact
binding. `kdna_id` is also optional, but it must exactly match the canonical
identity in the loaded Runtime Capsule when present. Caller-supplied machine
identity is forbidden: the remote deployment derives its own stable machine
fingerprint and sends it to the configured activation server. Projection is
allowed only when the response returns a canonical nonempty `license_id`, the
exact asset domain and machine fingerprint, `status: "active"`,
`revoked: false`, and `require_machine_binding: true`. License keys and raw
machine fingerprints are never written to the projection audit log.

Activation transport must use a canonical HTTPS origin. Plain HTTP is accepted
only for exact `127.0.0.1` or `[::1]` development origins. Credentials, paths,
queries, fragments, redirects, non-JSON responses, and responses over 64 KiB
are rejected before any projection is returned.

Response body (200):

```json
{
  "task_projection": {
    "diagnosis_focus": ["...", "..."],
    "constraints": ["..."],
    "self_check": ["..."]
  },
  "projection_policy": "remote",
  "trace_id": "uuid",
  "asset_id": "kdna:yourname:your-asset",
  "asset_version": "1.0.0"
}
```

Projection strategies by task verb:

| `task` starts with… | Returns |
|---------------------|---------|
| `review` / `evaluate` / `assess` | constraints + self-checks + a few axioms |
| `decide` / `choose` / `select` | highest_question + axioms + boundaries |
| `explore` / `discover` / `browse` | highest_question + 1 axiom |
| `audit` / `comply` / `check` | boundaries + self-checks + failure-modes |
| anything else | highest_question only (minimal) |

Error responses (4xx/5xx) use the shape from
[`specs/kdna-entitlement-api.md`][3]:

```json
{
  "ok": false,
  "error": {
    "code": "EXTRACTION_BLOCKED",
    "message": "request pattern flagged as extraction attempt: asks_for_full_content",
    "retryable": false
  }
}
```

[3]: https://github.com/aikdna/kdna/blob/main/specs/kdna-entitlement-api.md

---

## Security properties

This server enforces the following regardless of deployment:

- **No full payload return** — the projection is structurally
  smaller than the content. The HTTP layer never sends
  `asset.content` or any equivalent.
- **Layer isolation without semantic censorship** — the server never adds
  content-certification fields or claims. Selected asset text is preserved
  verbatim even when the asset itself discusses words such as “official”,
  “trusted”, or “recommended”.
- **Extraction detection** — requests that look like bulk
  extraction ("all axioms", "dump", "extract every", etc.) are
  rejected with `EXTRACTION_BLOCKED`.
- **Rate limiting** — minimum gap of `--rate-limit-ms` per
  client. The default is 100ms.
- **Deployment-bound authorization** — every non-dry-run request requires a
  license key and an exact Activation response bound to the loaded asset and
  the server's own machine fingerprint. A caller cannot override either
  identity.
- **Bounded secure Activation transport** — entitlement credentials are sent
  only to the configured canonical HTTPS origin (or exact loopback HTTP for
  development); redirects are never followed and responses are capped at
  64 KiB.
- **Bounded origin-independent HTTP parsing** — projection request bodies are
  capped by UTF-8 bytes at 64 KiB; malformed Host headers and absolute request
  targets receive one stable 400 response and never influence route parsing.
- **Loopback-only dry-run** — authorization bypass can bind only to exact
  `127.0.0.1` or `::1`; wildcard, hostname, and external binds fail at startup.
- **Audit log** — a successful projection is returned only after its event is
  appended and synchronized to one regular audit file (default
  `~/.kdna/remote-server-audit.jsonl`). If persistence fails, the server
  returns `AUDIT_UNAVAILABLE` without projection content. Rejected requests
  remain rejected even if their best-effort audit write also fails. Records
  contain no request plaintext, raw task/mode, license key, or raw machine
  fingerprint.
- **No network fetches** — the server holds the asset in
  memory from `--asset`. No external asset URLs are honored
  at request time.

---

## Deployment models

This server is a building block, not a policy decision. Two public deployment
models are described here:

1. **Self-hosted (default)** — you run this on your own
   infrastructure. The asset stays on your server; your
   `.kdna.json` points at your server's URL.
2. **Third-party hosting** — any third party can run this
   server. KDNA Inc. does not certify or endorse third-party
   hosts. The protocol is transparent to the hosting
   provider.

The protocol does not control which model you pick. You do.

---

## Local development

```bash
git clone https://github.com/aikdna/kdna-remote-server
cd kdna-remote-server
node scripts/trusted-npm.js ci --ignore-scripts \
  --registry=https://registry.npmjs.org/ \
  --@aikdna:registry=https://registry.npmjs.org/
node scripts/run-tests.js
```

The tests start the server in `--dry-run` mode on an
OS-assigned port. No external services are required.

---

## License

Apache 2.0. See [LICENSE](./LICENSE).

This server does not transmit or store the full judgment payload outside its
local runtime. It returns only task-scoped projections and makes no content
certification claim; interpretation remains the consumer's responsibility.
