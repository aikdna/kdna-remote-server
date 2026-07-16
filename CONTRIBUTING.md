# Contributing to KDNA

## Issues

Open an issue at the repository. Include:
- `kdna version` output
- OS and shell
- Minimal reproduction steps
- Expected vs actual behavior

If proposing a feature, tag with `[RFC]` and describe the problem before the solution.

## Pull Requests

1. Fork and branch from `main`.
2. Keep PRs focused — one logical change per PR.
3. All commits must be signed off: `git commit -s`
4. Use the PR template. Title format: `area: what changed`.
5. Verify before opening:
   - use Node 22.9.0 or newer;
   - install with `node scripts/trusted-npm.js ci --ignore-scripts --registry=https://registry.npmjs.org/ --@aikdna:registry=https://registry.npmjs.org/`;
   - run `node scripts/run-tests.js`;
   - if candidate binding changes, reproduce the exact pinned Core commit with
     `KDNA_CORE_CANDIDATE_SOURCE=/canonical/path/to/kdna node scripts/verify-core-candidate-tar.js`.

PRs that fail any verification command will be reviewed with requested changes.

## Developer Certificate of Origin (DCO)

All commits must include a `Signed-off-by:` line. Use `git commit -s` to add it automatically.

This certifies that you wrote the code or have the right to submit it under the project's license (Apache-2.0). No CLA is required.

## Repository boundaries

This repository owns the self-hosted HTTP projection boundary. KDNA Core is the
only component that decodes packaged assets, and the Activation server is the
authority for entitlement state. Do not reimplement either contract here.

Do not introduce generation-style version labels, compatibility aliases for
removed HTTP paths, source-directory loading, caller-controlled machine
identity, full-payload responses, or public coordination files. Natural SemVer
coordinates identify real package releases only.
