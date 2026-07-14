# 6. Strangler-fig migration with the old app as fallback

Date: 2026-06-22

## Status

Accepted

## Context

The new tree is greenfield and independent ([ADR 0004](0004-greenfield-independent-toolkit-directory.md)),
and the hardest capability to port — the Azure DCR/DCE/AMPLS deploy engine — is net-new code, not a
transliteration (`azure-deploy.ts` has zero `@azure` imports and shells the ~3356-line
`Create-TableDCRs.ps1`). The red-team's central warning is the classic stuck-strangler: a long
window where two implementations of the same capability must be kept behaviorally identical, which
can become the permanent steady state if a slice stalls. The DCR engine encodes under-documented
Azure behavior (AMPLS create-then-link ordering, the `logsIngestion` endpoint cmdlets do not surface,
reserved-column 400s, MMA->DCR migration) that can only be validated against live Azure.

## Decision

Migrate capability by capability using the strangler-fig pattern, with the **existing app as the
fallback** rather than an in-tree PowerShell adapter.

- A capability is **cut over** to the new tree only after it passes its gate; until then, users run
  the old app for that capability. The old tree stays untouched and runnable the whole time.
- For the DCR engine, cut over **one mode at a time** in order: `DirectNative` ->
  `DCE+AMPLS` -> `custom/_CL`.
- Each mode's gate is: a recorded-cassette contract test that passes offline **plus one live smoke
  deploy into a throwaway resource group**. Only after the gate is green is that mode declared
  production-ready in the new tree.
- **Hard kill-criteria / time-box:** if a mode cannot reach parity by its time-box, users keep the
  old app for that mode. **Partial cutover is an acceptable terminal state** — we do not carry two
  half-finished, drifting implementations of the same mode indefinitely.
- Capture golden behavior from the legacy implementation FIRST, then port (see
  [testing-strategy.md](../testing-strategy.md)); writing the pinning tests against the new code
  instead lets edge cases (abbreviation, reserved columns, AMPLS ordering) drift silently.

## Consequences

- There is never a flag day; each cutover is independently validated and reversible (point users
  back at the old app).
- "Done" for a risky capability has an explicit, observable definition (cassette + live smoke), and
  "not worth finishing" is an allowed, declared outcome rather than an open-ended dual-runtime.
- The old tree must be frozen as a read-only reference during the migration to avoid a moving parity
  target; new feature work happens only in the new tree.
