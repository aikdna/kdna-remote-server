# Contributing to KDNA

## Issues

Open an issue at the repository. Include:
- Node.js version and the exact package/dependency coordinates
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
   - install with `npm ci --ignore-scripts --omit=optional --no-audit --no-fund`;
     the locked pako tarball needs registry access or a prepared cache;
   - run `npm test`, `npm run lint` and `npm run check:public-surface`;
   - verify the actual package with `npm pack --ignore-scripts --dry-run --json`;
   - keep the exact current dependency archives and public binding consistent.
     The old candidate-tar verifier and older test runner retain their original
     historical scope; they do not replace the current test entry.

PRs that fail any verification command will be reviewed with requested changes.

## Developer Certificate of Origin (DCO)

All commits must include a `Signed-off-by:` line. Use `git commit -s` to add it automatically.

This certifies that you wrote the code or have the right to submit it under the project's license (Apache-2.0). No CLA is required.

## Repository boundaries

This repository owns the bounded public Read HTTP adapter. Core and Read own
container admission and disclosure. The deployment independently supplies
context verification and current policy observations; the co-located Activation
observer is one explicit integration, not an implicit entitlement authority.
Do not reimplement these contracts or infer trust from request fields.

Do not introduce generation-style version labels, compatibility aliases for
removed HTTP paths, source-directory loading, caller-controlled machine
identity, full-payload responses, or public coordination files. Natural SemVer
coordinates identify actual package or protocol versions, not capability names.
