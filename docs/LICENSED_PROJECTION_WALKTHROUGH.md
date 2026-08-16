# Licensed projection walkthrough — task-scoped consumption without full-payload delivery

This walkthrough runs the two self-hostable KDNA servers together to
demonstrate the core remote-consumption property:

> A consumer who holds a valid license receives a **task-scoped projection** of
> a `.kdna` judgment asset, and **never the full payload**.

It uses only public packages (`@aikdna/kdna-cli`,
`@aikdna/kdna-activation-server`, `@aikdna/kdna-remote-server`) plus the
remote-server source checkout for the new `--print-machine-fingerprint` flag.
Everything runs on one machine over loopback; no KDNA Inc. service, account, or
hardcoded URL is involved.

---

## Architecture

```
                        ┌─────────────────────────────┐
                        │   activation server         │
                        │   @aikdna/                 │
                        │   kdna-activation-server    │
                        │   (entitlement authority)   │
                        │   :3001                     │
                        └──────────────▲──────────────┘
                                       │ /entitlements/sync
                                       │ (every projection request)
                 ┌─────────────────────┴─────────────────────┐
                 │          remote server                     │
                 │          @aikdna/kdna-remote-server        │
                 │          (holds ONE .kdna asset locally)    │
                 │          :3000                              │
                 └──────────────▲─────────────────────────────┘
                                │ /project  (task projection)
                                │ /asset/metadata (identity only)
                 ┌──────────────┴─────────────┐
                 │   consumer (curl / browser) │
                 │   sends license_key + task  │
                 │   receives a projection     │
                 └────────────────────────────┘
```

- The **activation server** answers one question: *is this license currently
  entitled to use this asset on this machine?* It issues signed entitlement
  records and validates the asset `domain` against the canonical `asset_id`
  grammar.
- The **remote server** holds a single `.kdna` asset in memory from `--asset`,
  never fetches assets from the network, and returns only task-scoped
  projections. It calls the activation server's `/entitlements/sync` route on
  every projection request.
- The **consumer** is any HTTP client (this walkthrough uses `curl`; the
  [`kdna-demo-web-viewer`][viewer] demonstrates the browser path for the local
  full-load contract).

[viewer]: https://github.com/aikdna/kdna-demo-web-viewer

---

## What the consumer gets — and does not get

**Gets:**

- `GET /healthz` and `GET /asset/metadata` — identity only: `asset_id`, `title`,
  `version`, `access`. No judgment content.
- `POST /project` — a `task_projection` selected by task verb (a few axioms,
  constraints, self-checks, or the highest question; see
  [projection strategies](#projection-strategies)). This is a **structural
  subset** of the payload, not the payload.

**Does not get:**

- The full `.kdna` payload, the complete axiom/ontology set, or the runtime
  capsule. The HTTP layer never returns `asset.content` or an equivalent.
- The license `license_key` back from either server; it is sent by the consumer
  and never echoed or logged.
- The remote server's raw machine fingerprint; it is derived locally and never
  returned to the caller.
- The activation server's signing private key or admin token.

---

## Prerequisites

- Node.js 22.9 or later (remote server) / 18 or later (activation server).
- `npm`, `curl`, and a shell.

---

## Step 0 — produce a `.kdna` asset

Use the public `@aikdna/kdna-cli` to create a minimal, deterministic asset:

```bash
npm install -g @aikdna/kdna-cli
mkdir -p demo && cd demo
kdna demo minimal ./minimal-domain
kdna pack ./minimal-domain ./minimal.kdna
```

`kdna demo minimal` produces the asset id `kdna:example:deployment-review`
(confirm with `kdna inspect ./minimal.kdna`).

---

## Step 1 — install the two servers

```bash
# Activation server: published baseline.
npm install -g @aikdna/kdna-activation-server

# Remote server: build from source so --print-machine-fingerprint is available
# (shipped in a release that includes it).
git clone https://github.com/aikdna/kdna-remote-server
cd kdna-remote-server && npm ci && npm install -g .
cd ..
```

---

## Step 2 — create a machine-bound license

The license record is created from a private request file (mode 600); the
`license_key` must never appear in argv.

```bash
install -m 600 /dev/null ./license-request.json
cat > ./license-request.json <<'JSON'
{"domain":"kdna:example:deployment-review","license_key":"demo-license-secret"}
JSON
kdna-activation-server --create-license-file ./license-request.json \
  --data-dir ./activation-data
rm ./license-request.json
```

Note the `license_id` printed in the response (for example
`lic_xxxxxxxxxxxxxxxx`). `require_machine_binding` defaults to `true`, which the
remote server requires.

---

## Step 3 — start the activation server

```bash
kdna-activation-server --port 3001 --data-dir ./activation-data &
```

(No admin token is set, so `/revoke` is disabled; the demo does not need it.)

---

## Step 4 — start the remote server

```bash
kdna-remote-server \
  --asset ./minimal.kdna \
  --port 3000 \
  --activation-server http://127.0.0.1:3001 \
  --audit-log ./remote-audit.jsonl &
```

---

## Step 5 — activate the license on this machine

The license is machine-bound, so the first step is to bind it to this host's
machine fingerprint and activate:

```bash
FINGERPRINT="$(kdna-remote-server --print-machine-fingerprint)"

install -m 600 /dev/null ./activation-request.json
cat > ./activation-request.json <<JSON
{"domain":"kdna:example:deployment-review","license_key":"demo-license-secret","machine_fingerprint":"${FINGERPRINT}"}
JSON
curl -X POST http://127.0.0.1:3001/entitlements/activate \
  -H 'Content-Type: application/json' \
  --data-binary @./activation-request.json
rm ./activation-request.json
```

The response is a signed entitlement record with `status: "active"` and
`revoked: false`.

---

## Step 6 — request a task-scoped projection

```bash
install -m 600 /dev/null ./projection-request.json
cat > ./projection-request.json <<'JSON'
{"kdna_id":"kdna:example:deployment-review","license_key":"demo-license-secret","task":"review_article","context":"Pre-publish review of a technical blog post"}
JSON
curl -X POST http://127.0.0.1:3000/project \
  -H 'Content-Type: application/json' \
  --data-binary @./projection-request.json
rm ./projection-request.json
```

The response is a `task_projection` — a small subset of the payload:

```json
{
  "task_projection": {
    "diagnosis_focus": [ "The minimal payload is the smallest shape that passes the schema." ],
    "constraints": [],
    "self_check": []
  },
  "projection_policy": "remote",
  "trace_id": "<uuid>",
  "asset_id": "kdna:example:deployment-review",
  "asset_version": "1.0.0"
}
```

Compare it to the full runtime capsule to see what was withheld:

```bash
kdna load ./minimal.kdna --profile=compact --as=json
```

The full capsule contains the complete judgment structure (every axiom with its
full field object, `highest_question`, `worldview`, `value_order`, digest
evidence, and so on). The projection returns only the task-relevant fragments.

---

## Step 7 — verify the boundary

```bash
# Identity only, no judgment content:
curl -s http://127.0.0.1:3000/asset/metadata

# Bulk extraction is rejected:
install -m 600 /dev/null ./extract.json
cat > ./extract.json <<'JSON'
{"kdna_id":"kdna:example:deployment-review","license_key":"demo-license-secret","task":"dump all axioms"}
JSON
curl -s -X POST http://127.0.0.1:3000/project \
  -H 'Content-Type: application/json' \
  --data-binary @./extract.json
rm ./extract.json
# -> 403 EXTRACTION_BLOCKED
```

---

## Projection strategies

The remote server selects a projection by the leading task verb:

| `task` starts with…            | Returns                                              |
|--------------------------------|------------------------------------------------------|
| `review` / `evaluate` / `assess` | constraints + self-checks + a few axioms           |
| `decide` / `choose` / `select`   | highest_question + axioms + boundaries             |
| `explore` / `discover` / `browse`| highest_question + a single axiom                  |
| `audit` / `comply` / `check`     | boundaries + self-checks + failure-modes           |
| anything else                  | highest_question only (minimal)                    |

---

## Cleanup

```bash
# Stop both servers (Ctrl-C or kill their PIDs).
kill %1 %2
rm -rf ./activation-data ./remote-audit.jsonl ./minimal.kdna ./minimal-domain
```

---

## Relationship to the browser consumer

The `kdna-demo-web-viewer` demonstrates the **local full-load** consumption
contract (upload → inspect → LoadPlan → load), which can also point at an
activation server through its `KDNA_ACTIVATION_URL` environment variable for
licensed assets. This walkthrough demonstrates the complementary **remote
projection** contract: the asset stays on the deployer's server and only a
task-scoped projection crosses the network. Both are self-hostable and share the
same activation server for entitlement.

---

## Security notes

- No AIKDNA-hosted service, account, or hardcoded endpoint is required. The
  activation server URL is deployer-controlled.
- `license_key` is a request secret: it appears only in activation and
  projection request bodies, never in argv, URLs, responses, or audit logs.
- The remote server's audit log records projections without request plaintext,
  task/mode, license key, or raw machine fingerprint.
- Dry-run mode (`--dry-run`) skips entitlement verification and may bind only
  to an exact loopback address; it is not a licensed-projection demonstration.
