# 3. Hexagonal ports and adapters

Date: 2026-06-22

## Status

Accepted

## Context

The single biggest defect in the legacy code is untestability: the valuable business logic (DCR name
abbreviation, schema/column mapping, the field-matcher cascade, the onboarding state machine) is
interleaved with side effects (`Invoke-AzRestMethod`, `Read-Host`, `child_process.spawn`, `fetch`,
`fs`). Roughly 80% of the PowerShell functions are side-effecting, and the React component
`SentinelIntegration.tsx` is ~3500 lines mixing logic with rendering. None of this can be exercised
without a cloud, a runtime, or a UI. The product also needs three frontends (desktop, CLI, service)
that must share one implementation of the logic, not three drifting copies.

## Decision

Adopt hexagonal architecture (ports and adapters). The governing rule:

> Source-level dependencies point inward. `packages/core` imports no infrastructure. The interfaces
> the core needs are **ports** the core owns; the outside world provides **adapters** that implement
> them; frontends inject concrete adapters into core usecases at a single composition root.

Concretely:

- `packages/core` may not import `@azure/*`, the Cribl client, `powershell.exe`, `electron`, or
  `fs`. This is enforced by an ESLint boundary rule that fails CI on violation.
- Driven ports (the core calls out): `DcrDeployer`, `CriblClient`, `AzureClient`, `ContentRepo`,
  `SchemaStore`, `Keystore`, `Clock`, `FileSystem`, `ProgressSink`.
- Driving ports: the usecase interfaces, called by the frontends.
- Adapters live in `packages/adapters-*` and depend on `core`, never the reverse.
- Frontends (`apps/*`) are composition roots only; they hold no business logic.

## Consequences

- The whole domain is unit-testable against in-memory fakes in milliseconds; cloud integrations are
  faked for speed and pinned with cassettes/test-proxy for fidelity (see
  [testing-strategy.md](../testing-strategy.md)).
- Adding or swapping a frontend (CLI, service) is wiring, not a rewrite.
- There is up-front cost in defining ports and writing fakes, and a discipline cost in not letting
  IO leak into the core; the ESLint boundary rule makes the violation mechanical to catch.
- Progress reporting must be abstracted (`ProgressSink`) rather than `console`/`Write-Host`/SSE
  baked into logic; this is a deliberate constraint that pays off across all three frontends.
