# Security Policy

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, use one of these private channels:

- **GitHub Private Vulnerability Reporting**: Go to the [Security Advisories](https://github.com/aikdna/kdna-remote-server/security/advisories/new) page
- **Email**: security@aikdna.com

We aim to respond within 72 hours and provide a timeline for resolution within 1 week.
Please do not disclose the vulnerability publicly until we have had a chance to address it.

## Supported Versions

`kdna-remote-server` is a self-hosted public Read HTTP adapter support surface.
Until the first stable server release, security support tracks the latest
mainline pre-release and the canonical KDNA protocol/runtime surfaces.

| Component | Supported Versions |
|-----------|-------------------|
| KDNA Protocol | Latest tagged release |
| kdna-cli | Latest minor release |
| kdna-remote-server | Latest mainline pre-release |

Older pre-release versions may receive critical security patches on a
case-by-case basis.

## Security Model

`createRemoteReadHandler` exposes the bound reference Host's public Read
contract for one server-owned asset and authorization-domain/context binding.
Exact Core, Read and Host coordinates and artifact digests are recorded in
`public-contract-binding.json`. Core and Read own admission, component
interpretation, disclosure and handle authority; Remote does not parse payloads,
reconstruct component bodies or grant action permission.

The deploying application must independently establish and verify context and
supply policy. Caller JSON or matching identifiers do not authenticate a request.
Missing context verification rejects, and missing policy denies disclosure.
Legacy load, projection, activation and execution operations remain unavailable.

Responses carry the existing public Read envelope, not raw asset bytes. Node's
server-side `finish` event can confirm only that delivery boundary; it does not
prove remote receipt or client processing. This adapter supplies no cross-host
trust root, issuer verifier or global replay protection. See the README for the
retained Host lifecycle, resource limits and transport proof limits.

For the KDNA Protocol security architecture, see
[GOVERNANCE.md](https://github.com/aikdna/kdna/blob/main/docs/GOVERNANCE.md)
in the main protocol repository.
