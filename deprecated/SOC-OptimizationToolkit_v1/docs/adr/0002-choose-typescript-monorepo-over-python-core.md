# 2. Choose a TypeScript monorepo over a Python/.NET/Go core

Date: 2026-06-22

## Status

Accepted

## Context

We are consolidating the PowerShell automation (`Azure/`) and the Electron/TypeScript app
(`Cribl-Microsoft_IntegrationSolution/`) into one production-ready product structured as a core
engine plus frontends. The owner is explicitly open to any language; the choice should be on merits,
weighing migration cost honestly.

A 29-agent evaluation inventoried every capability, researched the language and architecture options,
designed a full architecture per candidate stack, scored each with three lens-diverse judges
(testability/maintainability, ecosystem fit, delivery risk), and red-teamed the top two. The scored
ranking:

| Stack                                 | Avg score |
| ------------------------------------- | --------- |
| TypeScript monorepo (evolve existing) | 7.33      |
| Python core + frontends               | 6.67      |
| Polyglot (Python core + TS GUI)       | 6.67      |
| .NET / C#                             | 6.33      |
| Go                                    | 6.00      |

Decisive findings, verified against the code:

1. The product's GUI is ~34k LOC of working React, and the desktop seam this product needs already
   exists in the repo: `src/server/electron-stub.ts` + `api-router.ts` already remount every IPC
   handler as a REST route, an args-in/result-out boundary. Staying in TypeScript reuses that and the
   existing field-matcher/sample-parser tests; any other language reimplements them.
2. The main argument for a Python core was "the only typed Cribl SDK is Python." That has collapsed:
   an official TypeScript Cribl SDK now exists, and the Python control-plane/management-plane SDKs are
   explicitly Preview / pre-1.0 / not-for-production.
3. The hardest work — the Azure DCR/DCE/AMPLS deploy engine — is net-new code in **every** stack.
   `azure-deploy.ts` has zero `@azure` imports and ~10 PowerShell spawns; it shells the PowerShell
   engine. So no stack gets a head start there; Python's claimed scope reduction is illusory.
4. A single language across core plus three frontends is what a solo maintainer fluent in PowerShell
   and TypeScript can actually sustain. Python/.NET/Go all demote the owner's strongest stacks and add
   a cross-language or unfamiliar-GUI rebuild that scored 3-4 on delivery risk.

## Decision

Build the product in **TypeScript (Node 20 LTS)** as a **pnpm + Turborepo monorepo** with TypeScript
project references, structured as a pure hexagonal core, typed adapters, and three thin frontends
(Electron desktop, oclif CLI, Express service).

## Consequences

- We reuse the React GUI, the `electron-stub`/`api-router` seam, and the existing TS tests rather
  than reimplementing them.
- We accept one durable liability: there is no first-party-guaranteed-forever JS/TS Cribl SDK, so we
  permanently own a vendored Cribl client. This is contained by
  [ADR 0005](0005-pin-and-vendor-the-cribl-client.md) and
  [ADR 0007](0007-adopt-official-cribl-ts-sdk-with-override-shim.md).
- We accept that TypeScript's structural typing is weaker than C#/Go on external cloud shapes, and
  compensate with runtime validation at adapter boundaries (zod/io-ts).
- The Azure engine is budgeted as net-new development, not a transliteration (see
  [ADR 0006](0006-strangler-fig-with-old-app-as-fallback.md)).
