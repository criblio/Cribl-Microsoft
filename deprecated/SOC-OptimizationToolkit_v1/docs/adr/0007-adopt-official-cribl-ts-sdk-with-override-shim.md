# 7. Adopt the official Cribl TS SDK with an override shim

Date: 2026-06-22

## Status

Accepted

## Context

An official Cribl TypeScript SDK now exists. This is what collapsed the main argument for a Python
core (see [ADR 0002](0002-choose-typescript-monorepo-over-python-core.md)). However, like the Python
control-plane/management-plane SDKs, the official Cribl SDKs are early (Preview / pre-1.0 /
not-for-production) and their versions move with Cribl releases. The existing app's hand-rolled REST
surface exists precisely because the real API varies by Cribl version and by Cloud-vs-self-managed
deployment; that knowledge cannot simply be deleted by adopting an SDK.

## Decision

Use the official Cribl TS SDK where it cleanly covers an operation, to shrink the hand-rolled
surface — but keep the load-bearing behavior as a thin **override shim** on top of it, not as
deleted code.

- The shim retains: cloud-vs-self-managed audience/base selection, the `/packs` PUT-then-install
  conflict-delete-retry, and multi-path version-drift probing.
- The shim is the **supported path** until the SDK reaches >= 1.0 and proves stable in our contract
  tests; we do not treat the SDK as authoritative for the operations the shim covers.
- The SDK is pinned to an exact version and upgrades are gated by a contract-test refresh against a
  real workspace (consistent with [ADR 0005](0005-pin-and-vendor-the-cribl-client.md)).
- We budget for the possibility that the SDK never stabilizes for our needs; in that case the
  hand-rolled REST path is retained, and the "delete the hand-rolled client" benefit is simply not
  realized — no part of the architecture depends on that benefit materializing.

## Consequences

- We get typed ergonomics and upstream maintenance for the parts of the Cribl API the SDK covers
  well, while staying safe against its instability for the parts that matter most.
- We maintain both the SDK adapter and the override shim during the Preview period; this is explicit,
  contract-tested cost, not hidden risk.
- If/when the SDK reaches GA and our contract tests are green against it, a later ADR can supersede
  this one to retire parts of the shim.
