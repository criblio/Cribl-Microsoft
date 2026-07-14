# Testing Strategy — SOC-OptimizationToolkit

The goal is the one the owner stated: the codebase must be **thoroughly, automatically tested as
changes are made**. This document defines the test pyramid keyed to the hexagonal architecture, the
non-negotiable rule for porting legacy behavior, how we fake Azure and Cribl without live calls, and
how coverage is gated.

Starting point (verified): the existing app has ~6 test files on Vitest + jsdom + Testing Library;
the PowerShell tree has zero tests across ~40k LOC. We are not improving that baseline — we are
building a new tree where tests come first.

## 1. The non-negotiable rule: characterization-from-legacy-FIRST

Most of the high-value logic we port (DCR name abbreviation, `ConvertTo-DCRColumnType`, the
`Get-TableColumns` TenantId-only heuristic, reserved-column blocklist, ARM injection, the Cribl
overrides) currently lives tangled inside side-effecting legacy code, and has no tests pinning it.

> Before porting a behavior, write a **characterization test that records the CURRENT output of the
> legacy implementation** for a representative set of inputs. Port against that test. Never write the
> pinning test against the new TypeScript — that just freezes whatever the new code happens to do and
> lets edge cases drift silently.

For pure TS-to-TS ports, the characterization inputs come from the legacy module directly. For
PowerShell-resident logic, capture golden inputs/outputs from the script (run it against fixtures, or
extract its tables/maps verbatim) and assert the TS port reproduces them byte for byte.

This rule is review-gated: a port PR without a legacy-derived characterization test is not approved.

## 2. The pyramid, keyed to the hexagon

### Base — unit tests on `packages/core` (broadest, milliseconds, zero IO)

Every pure function in `core` gets exhaustive unit tests. This is where the bulk of coverage lives,
because this is where the bulk of the logic lives. Concretely, port and multiply the existing tests
(`field-matcher.test.ts`, `sample-parser.test.ts`, the `analyze-workflow`/`azure-resources` hook
tests already in the old tree) and extend to every ported function:

- DCR name abbreviation map and length rules (Direct 30 / DCE 64)
- `ConvertTo-DCRColumnType` (every alias, including guid -> string)
- `Get-TableColumns` branches including the TenantId-only heuristic and MMA detection
- reserved-column blocklist and `_CL` normalization
- per-table ARM column injection
- the 6-phase field-match cascade (`ALIAS_TABLE`, `COALESCE_PRIORITY`, `EVENT_TYPE_BOOSTS`)
- sample-parser format detection and inner-`_raw` re-parse, PAN-OS positional maps
- kql-parser extraction/gap/route
- SIEM parsers, reduction-rule lookups, change-detection fingerprints

These run on every save (`vitest` watch) and every commit.

### Extract-then-move for IO-entangled modules

Several modules that should become pure currently import `fs`/`path`/`crypto`/`electron`
(kql-parser, sample-parser, change-detection). Do not relocate them wholesale. First extract the pure
functions out of the IO-mixed file **in place in the new tree** with unit tests pinning behavior,
then assemble them in `core`. This decouples refactor risk from relocation risk and follows the
pattern the old tree already started with `analyze-workflow.ts` / `azure-resources.ts`.

### Adapter boundary — contract tests (the most important new layer)

Because there is no SDK guaranteeing us against drift, the adapter boundary is where correctness is
won or lost. Two complementary techniques per external system:

- **In-memory fakes** (`FakeAzureClient`, `FakeDcrDeployer`, `FakeCriblClient`, in-memory
  `ContentRepo`) for fast usecase tests. These make the whole onboarding flow testable in
  milliseconds.
- **Recorded fidelity tests**:
  - Azure: the language-agnostic **Azure SDK test-proxy** in record-once/replay mode, with secret
    sanitizers, so `@azure/arm-*` traffic is recorded against a maintained test tenant and replayed
    offline. Recordings must cover `Direct`, `DCE+AMPLS`, `custom/_CL`, and MMA-migrate before any
    DCR mode is declared production-ready.
  - Cribl: **MSW** (`onUnhandledRequest: 'error'`) replaying recorded cassettes, plus a contract
    test proving the in-memory fake matches the real `/packs` PUT-then-install + `system/outputs`
    responses. The generated/SDK client is pinned and vendored; a regeneration that changes a
    load-bearing shape fails the build (see [adr/0005](adr/0005-pin-and-vendor-the-cribl-client.md)).
  - ContentRepo: MSW cassettes of GitHub Trees/raw; the two-layer EDR blocklist and its
    crash-detection get dedicated unit tests.

Add **zod (or io-ts) runtime validation at every adapter boundary** that returns an external cloud
shape into the core. This compensates for TypeScript's weaker compile-time guarantees on dynamic
cloud responses (the weakness flagged across the evaluation), turning a silent shape mismatch into a
loud, located failure.

### Integration — usecases against fakes

Wire usecases to in-memory fakes and assert full sequences headlessly (via the existing
`electron-stub` alias used in the old tree's Vitest config). The key target is `OnboardSource`
idempotency/skip semantics: a subtle divergence here could create duplicate DCRs or destinations in a
customer tenant, so the skip logic is pinned by full-sequence integration tests before the CLI/old
PowerShell entry point is retired.

### Source-connector and AI adapters (new boundaries)

- **AWS source connector** (`adapters-aws`): in-memory `FakeSourceConnector` for fast usecase tests,
  plus recorded-response contract tests against the AWS SDK for JS v3 (the SDK's middleware makes
  request/response interception straightforward). The decisive test is that `OnboardSource` runs green
  with the AWS `SourceConnector` injected and the **Sentinel destination fake** — proving a new source
  lands in Sentinel without touching the destination
  ([adr/0008](adr/0008-sentinel-destination-pluggable-sources.md)).
- **AI** (`adapters-ai`): the LLM is faked with recorded responses; the embedded prompts are pinned
  with golden-output tests. Crucially, every AI-generated artifact is run through the SAME
  deterministic pack contract/golden tests as hand-built packs — the AI's non-determinism never
  reaches an assertion, only its validated output does ([adr/0009](adr/0009-ai-assisted-pack-generation.md)).
  Drift detection is deterministic and unit-tested like any other domain logic.

### E2E — thin, last

- Playwright-electron for 1-2 flagship GUI flows.
- A CLI smoke run of `dcr deploy --mode TemplateOnly` (template generation, no deploy).
- One **live smoke deploy into a throwaway resource group** as the per-mode DCR cutover gate (see
  [adr/0006](adr/0006-strangler-fig-with-old-app-as-fallback.md)).

### Golden-file tests for format emitters

The heaviest format-coupled modules (the `.crbl` pack emitter ported from `pack-builder.ts`) get
golden-file tests that byte-pin output against the legacy result, plus a contract test against a real
Cribl install. Byte-pinning catches accidental drift; the contract test catches the case where the
legacy bytes were themselves slightly wrong.

## 3. Coverage gates

- Per-glob coverage thresholds (Vitest v8 provider) with the strictest gate on `packages/core`.
- A coverage **ratchet** (`thresholds.autoUpdate`) on `packages/core` so the floor only moves up.
- Coverage is a **required CI check** on the protected branch, so a change that lowers core coverage
  cannot merge.
- We do not chase a single repo-wide number; frontends (`apps/*`) carry thin smoke coverage by
  design, while `core` carries the high bar.

## 4. What "tested as changes are made" looks like in practice

- Pre-commit runs Prettier + ESLint on staged files; pre-push runs `tsc` + `vitest related`.
- The fast unit base runs in watch mode during development and in full on every push.
- CI gates lint + typecheck + unit on every PR, with integration/build/package downstream (see
  [ci-cd.md](ci-cd.md)).
- Every ported slice arrives with its characterization test, so the behavior is locked the moment it
  lands and regressions surface on the next change.
