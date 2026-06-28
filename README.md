# @aikdna/kdna-remote-server

**Self-hostable HTTP projection server for KDNA `remote`-mode assets.**

This server holds a single `.kdna` asset locally and returns
**task-scoped projections** — never the full payload — to
authorized callers. It is the open-source reference
implementation of roadmap-2026.md Story 18 and implements the
projection contract in [`specs/kdna-runtime-projection.md`][1]
and the self-hosting invariant from [`docs/REMOTE_MODE.md`][2].

[1]: https://github.com/aikdna/kdna/blob/main/specs/kdna-runtime-projection.md
[2]: https://github.com/aikdna/kdna/blob/main/docs/REMOTE_MODE.md

---

## Self-hosting is the default

> The KDNA protocol MUST NOT assume a single official KDNA
> server. Any asset creator can run their own remote server.
> Official KDNA hosting is one deployment option, not the
> protocol requirement.

This server is the deployer's own. The protocol does not
hardcode any KDNA Inc. URL; the activation server URL is a
deployer-controlled configuration value (see
`--activation-server` below).

---

## Quick start (self-hosting)

```bash
# 1. Install (any Node 18+ server)
npm install -g @aikdna/kdna-remote-server

# 2. Point at a .kdna asset on local disk
kdna-remote-server \
  --asset /path/to/your-asset.kdna \
  --port 3000 \
  --activation-server https://licenses.yoursite.com

# 3. Test
curl http://localhost:3000/healthz
curl -X POST http://localhost:3000/v1/project \
  -H 'Content-Type: application/json' \
  -d '{"kdna_id":"@yourname/your-asset","task":"review_article"}'
```

That's it. No registration, no phone-home, no KDNA Inc. URL.

---

## CLI options

```
Required:
  --asset <path>           Path to a .kdna asset (or source dir)
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
                           activation server.
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

### `GET /v1/asset/metadata`

Returns the asset's identity (asset_id, title, version, access)
but NEVER any judgment content. Safe to expose to any caller
who needs to introspect the asset.

### `POST /v1/project`

Returns a task projection. The full payload is NEVER returned.

Request body:

```json
{
  "kdna_id": "@yourname/your-asset@1.0.0",
  "task": "review_article",
  "context": "Pre-publish review of a technical blog post",
  "mode": "judge"
}
```

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
  "asset_id": "@yourname/your-asset",
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
- **Layer isolation** — the response never includes the
  content-trust vocabulary (`official`, `trusted`,
  `recommended`, `high_quality`, `quality_badge`,
  `officially_approved`). If a downstream string accidentally
  contains one of these words, it is scrubbed at the response
  boundary.
- **Extraction detection** — requests that look like bulk
  extraction ("all axioms", "dump", "extract every", etc.) are
  rejected with `EXTRACTION_BLOCKED`.
- **Rate limiting** — minimum gap of `--rate-limit-ms` per
  client. The default is 100ms.
- **Audit log** — every projection request is recorded to the
  audit log (default `~/.kdna/remote-server-audit.jsonl`) with
  no plaintext content.
- **No network fetches** — the server holds the asset in
  memory from `--asset`. No external asset URLs are honored
  at request time.

---

## Deployment models

This server is a building block, not a policy decision. Three
deployment models are valid:

1. **Self-hosted (default)** — you run this on your own
   infrastructure. The asset stays on your server; your
   `.kdna.json` points at your server's URL.
2. **KDNA hosted service** — KDNA Inc. may also offer a
   hosted version of this server. That is a product built
   on top of this open-source implementation. Using the
   hosted service is optional.
3. **Third-party hosting** — any third party can run this
   server. KDNA Inc. does not certify or endorse third-party
   hosts. The protocol is transparent to the hosting
   provider.

The protocol does not control which model you pick. You do.

---

## Local development

```bash
git clone https://github.com/aikdna/kdna-remote-server
cd kdna-remote-server
npm install
npm test
```

The tests start the server in `--dry-run` mode on an
OS-assigned port. No external services are required.

---

## License

Apache 2.0. See [LICENSE](./LICENSE).

This server does not transmit, store, or certify judgment
content. It is a structural selection layer; trust is the
consumer's decision, not the server's claim.
