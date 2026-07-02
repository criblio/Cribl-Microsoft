# ADR 0001: Dual-target architecture (Cribl.Cloud app + local Node-host app)

Date: 2026-07-01
Status: Accepted

## Context

Cribl Apps (Preview) run only on Cribl.Cloud leaders (docs.cribl.io/apps). A Cribl App Platform app is the strategic delivery vehicle (auth, API access, KV storage, and distribution provided by the platform), but a significant set of Cribl customers run customer-managed (on-prem) leaders and need the same SOC optimization capability. A cloud-only product would exclude them; an on-prem-only product would forfeit the platform's advantages.

## Decision

Ship two deployment targets from one shared codebase, with target differences confined to a thin adapter layer behind port interfaces:

- npm workspaces: packages/core (pure domain logic + ports: CriblClient, AzureManagement, GraphClient, SecretsStore, JobStore, UserContext, ArtifactSink), packages/ui (shared React screens), apps/cribl-app (Cloud shell, .tgz), apps/local-app (Node host serving the same UI, launched from source).
- The local shell is a Node host + browser, not Electron or Tauri: it reuses the Integration Solution's proven web-mode pattern, avoids EDR false positives from packaged executables (established repo lesson), and keeps a single React codebase.
- The local app's first run is the onboarding GUI for BOTH targets: it explains the tradeoffs, then either guides packaging/uploading the .tgz to Cribl.Cloud with admin approval, or connects itself to a customer-managed leader.
- Boundaries are lint-enforced: core imports nothing; ui imports only core; apps bind adapters.

Related decisions adopted the same day: redesign-first principle (legacy repo is a capability reference, not an implementation spec, with named compatibility contracts); AWS and LDAP scenarios dropped from scope; consolidation endgame - legacy trees archived (tag legacy-final, removed from main) once feature domains reach parity in both targets.

## Consequences

- Feature code is written once; each capability ships to both targets by default. The local target is a capability superset (private network reach, scheduling, no proxy limits, air-gap operation); cloud features degrade gracefully rather than being designed out.
- The port seam adds indirection, but it sits exactly where the two targets genuinely differ, and it is what makes domain logic testable with fakes.
- Two release artifacts must be versioned and tested per feature domain; parity in BOTH targets gates legacy archival.
- The platform constraints of the cloud target (30s proxy timeout, 100 req/min, write-only encrypted KV) shape shared designs: long operations are polled jobs, secrets are injected server-side on the cloud path.
