# Changelog

## 0.3.1 (2026-07-13)

- Normalize npm repository metadata so the source package and published
  tarball are reproducible without registry-side rewrites.

## 0.3.0 (2026-07-13)

- Require an existing packaged `.kdna` file at the remote runtime boundary and
  reject authoring source directories before Core loading.
- Exercise projection tests through packed CBOR assets.
- Align remote projection loading with KDNA Core 0.16.0.

## 0.2.0 (2026-07-13)

- Load authorized index and compact Runtime Capsules through KDNA Core 0.15.12.
- Build remote projections from Capsule context without reading asset internals.
- Migrate test fixtures to the single CBOR runtime container.
- Remove committed legacy JSON runtime fixtures.

## 0.1.0 (2026-06-28)

- Initial experimental self-hosted projection server.
