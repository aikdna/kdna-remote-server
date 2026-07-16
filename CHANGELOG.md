# Changelog

## 0.4.0 (2026-07-16)

- Move the runtime boundary to the exact KDNA Core 0.19.0 candidate and consume
  one current full Runtime Capsule before producing task-scoped projections.
- Bind every non-dry-run authorization to the loaded Capsule identity, a
  required license key, a canonical license identifier, and the remote
  deployment's own machine fingerprint; reject caller identity overrides and
  malformed or incomplete Activation responses.
- Require canonical HTTPS Activation origins (with exact loopback HTTP as the
  only development exception), refuse redirects, and cap JSON responses at
  64 KiB so credentials cannot be redirected and upstream bodies cannot cause
  unbounded memory use.
- Count inbound limits in UTF-8 bytes, emit only one 413 response for oversized
  bodies, parse routes against a fixed internal base instead of the Host
  header, and record only fixed task classes rather than caller task/mode text.
- Restrict `--dry-run` entitlement bypass to exact loopback bind addresses and
  fail startup for wildcard, hostname, or external exposure.
- Fail successful projections closed with `AUDIT_UNAVAILABLE` unless their
  scrubbed audit event is appended and synchronized to one regular file.
- Add reproducible candidate-source verification from the exact pinned Git
  commit tree, integrity-pinned isolated npm execution, deterministic package
  evidence, registry collision checks, and verified-artifact publication.
- Add public-surface, protocol-vocabulary, hostile authorization, alias,
  symlink, hardlink, hidden-index-flag, and package-content gates.
- Preserve selected asset text verbatim while preventing only server-authored
  content-certification fields, so layer isolation never rewrites judgment.
- Set the server security baseline to Node 22.9.0 or newer and test Node 22,
  24, and 26 so the integrity-pinned npm 11.17.0 client and Remote server run
  only on supported Node release lines.
- Replace generation-shaped asset metadata and project paths with the
  responsibility routes `/asset/metadata` and `/project`.
- Send entitlement refresh requests only to `/entitlements/sync` and remove
  all compatibility aliases for the former HTTP paths.
- Add hostile route coverage proving the removed metadata and project paths
  return 404, and adopt natural SemVer presentation for package output and
  future release checks.

## 0.3.2 (2026-07-14)

- Run remote projection loading on KDNA Core 0.17.0 so hosts do not silently
  install and execute a second Core 0.16 runtime beside the current Core.
- Revalidate packaged loading, task projections, entitlement forwarding,
  privacy-safe audit logs, and failure paths against Core 0.17.0.

## 0.3.1 (2026-07-13)

- Normalize npm repository metadata so the source package and published
  tarball are reproducible without registry-side rewrites.

## 0.3.0 (2026-07-13)

- Require an existing packaged `.kdna` file at the remote runtime boundary and
  reject authoring source directories before Core loading.
- Exercise projection tests through packed CBOR assets.
- Align remote projection loading with KDNA Core 0.16.0.

## 0.2.0 (2026-07-13)

- Load authorized index and compact Runtime Capsules through KDNA Core 0.15.12
  (historical behavior, replaced in 0.4.0).
- Build remote projections from Capsule context without reading asset internals.
- Migrate test fixtures to the single CBOR runtime container.
- Remove committed legacy JSON runtime fixtures.

## 0.1.0 (2026-06-28)

- Initial experimental self-hosted projection server.
