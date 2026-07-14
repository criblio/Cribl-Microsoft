# 5. Pin and vendor the Cribl client

Date: 2026-06-22

## Status

Accepted

## Context

Cribl does not ship a first-party JS/TS SDK with a maintenance guarantee that we can lean on
indefinitely. The existing app already carries substantial hand-won Cribl knowledge in untyped
territory inside `auth.ts` (~2000 lines mixing credential persistence, child processes, and fetch):
cloud-vs-self-managed base/audience selection, the `/packs` PUT-then-install conflict-delete-retry,
and multi-endpoint version-drift probing. These overrides are load-bearing — they exist because the
Cribl API varies by version and by Cloud-vs-self-managed deployment, and removing them breaks pack
publishing for real customers. Whatever client we use, every Cribl API change is a manual
client-maintenance event for us. The risk is that a regenerated or upgraded client silently clobbers
these overrides and reintroduces fixed bugs.

## Decision

We own the Cribl client deliberately and defensively.

- **Vendor** the generated-from-OpenAPI client output into the repo; do not fetch/regenerate it as
  part of the build.
- Keep the **load-bearing overrides in a separate, non-generated layer** that wraps the generated
  client, so regeneration never overwrites them.
- **Snapshot-test the overrides** and add a **contract test** that fails loudly when a regeneration
  changes the shape of a load-bearing operation (`/packs` install flow, `system/outputs`, auth).
- **Pin** the generated client and any official Cribl SDK to exact versions; upgrades are a
  deliberate PR gated by a contract-test refresh against a real workspace, never an automatic bump.

See [ADR 0007](0007-adopt-official-cribl-ts-sdk-with-override-shim.md) for using the official Cribl
TS SDK alongside this to shrink the hand-rolled surface.

## Consequences

- Cribl API drift becomes a controlled, test-gated event instead of a silent runtime failure.
- We carry permanent maintenance of the client and the override layer; this is the one liability we
  accepted when choosing TypeScript (see [ADR 0002](0002-choose-typescript-monorepo-over-python-core.md)).
- Regeneration is a manual, reviewed step that must reconcile against the snapshot tests, not a
  black-box build artifact.
