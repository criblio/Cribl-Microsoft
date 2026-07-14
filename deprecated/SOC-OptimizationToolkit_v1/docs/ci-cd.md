# CI/CD — SOC-OptimizationToolkit

There is no CI anywhere in the repository today. This document defines the GitHub Actions pipeline
for the new tree, scoped to `SOC-OptimizationToolkit/`, designed so that every change is gated and PR
feedback stays fast.

## 1. Principles

- **Cheap gates first, expensive work downstream.** Lint, typecheck, and unit tests run in parallel
  and must pass before integration/build/package run (`needs:`).
- **Required checks on the protected branch.** Lint + typecheck + unit are required status checks on
  `main`, so every strangled slice is gated the moment it lands.
- **Fast PRs, thorough nightlies.** Heavy E2E and the cassette/test-proxy re-recording run on a
  nightly cron, not on every PR. The per-mode DCR cutover adds an on-demand live smoke-deploy job.
- **Content-hash caching.** Turborepo skips unchanged packages; `actions/setup-node` caches the pnpm
  store. `concurrency` cancels superseded runs; `paths-ignore` skips docs-only changes for the heavy
  jobs.

## 2. Pipeline (PR and push to `main`)

Job graph (parallel where independent, gated where dependent):

```
            lint ─┐
        typecheck ─┼─(all green)─> integration ─> build ─> package
             unit ─┘
```

| Job           | Command (intent)                                                                                          | Notes                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `lint`        | `eslint --max-warnings 0 --cache`                                                                         | includes the hexagonal boundary rule (core may not import infra) |
| `typecheck`   | `tsc -b` (project references, per package)                                                                | no emit                                                          |
| `unit`        | `vitest run` with v8 coverage + per-glob thresholds + ratchet on `packages/core`                          | required check                                                   |
| `integration` | `vitest run` integration suite: MSW cassettes + Azure SDK test-proxy replay; renderer DOM tests via jsdom | offline, deterministic                                           |
| `build`       | `turbo run build`                                                                                         | TS project-reference build of all packages/apps                  |
| `package`     | `electron-builder` (signed/notarized desktop installers) + oclif CLI artifact                             | release branches/tags                                            |

Setup steps shared by all jobs: `actions/setup-node@v4` with pnpm cache, `pnpm install
--frozen-lockfile`. `fail-fast: true`. Turborepo remote/local cache keyed on content hashes so
unchanged packages are skipped (FULL TURBO).

## 3. Nightly and on-demand jobs

- **Nightly cron:** re-record the Azure SDK test-proxy cassettes against the maintained Azure test
  tenant and the Cribl cassettes against a real workspace, then run the full integration + E2E
  suite. This catches upstream Azure/Cribl drift without slowing PRs. A failed nightly opens an issue;
  it does not block unrelated PRs.
- **On-demand live smoke deploy (DCR cutover gate):** a manually-dispatched job that deploys the
  target mode (`DirectNative`, then `DCE+AMPLS`, then `custom/_CL`) into a throwaway resource group
  and tears it down. This is the gate that must be green before a mode's path is declared
  production-ready in the new tree (see [adr/0006](adr/0006-strangler-fig-with-old-app-as-fallback.md)).

## 4. Pre-commit and pre-push hooks

- **pre-commit** (Husky + lint-staged): Prettier + ESLint on **staged files only**. Never `tsc` here
  (it is a whole-project operation and too slow for a commit hook).
- **pre-push**: full `tsc -b` + `vitest related` so broken types/tests do not reach the remote.

## 5. Branch protection

`main` requires: `lint`, `typecheck`, `unit` green, at least one review, and up-to-date with base.
`integration`/`build` are required on release branches. Coverage on `packages/core` is a required
check and can only ratchet up.

## 6. Secrets and the test tenant

- Live smoke deploys and cassette recording use a dedicated Azure test subscription and a dedicated
  Cribl workspace, with credentials in GitHub Actions secrets / OIDC federation, never in the repo.
- Cassettes are committed with secrets scrubbed by the test-proxy sanitizers; the offline replay
  jobs need no credentials, which is what keeps PR CI fast and safe.

## 7. Source-connector and AI jobs (added as those phases land)

- The integration job runs the contract suites for every adapter that exists: the Sentinel
  destination (Azure test-proxy cassettes), the AWS source connector (recorded AWS SDK responses),
  Cribl (MSW cassettes), and the AI golden-output tests.
- The `SourceConnector` check is a required integration test: `OnboardSource` with the AWS source
  connector injected lands data in the Sentinel destination fake — green without any change to the
  destination.
- The AI engine's nightly drift run (the autonomous loop) is a scheduled workflow that opens a PR
  rather than deploying; the Anthropic key is an Actions secret, and a cost ceiling fails the job if
  exceeded.

## 8. Phase 0 deliverable

The CI skeleton (the PR pipeline above with the required checks wired and the empty package/app
shells building green) is part of Phase 0 in [roadmap.md](roadmap.md). No module is ported until that
skeleton is green, so every later slice is gated from the first line of real logic.
