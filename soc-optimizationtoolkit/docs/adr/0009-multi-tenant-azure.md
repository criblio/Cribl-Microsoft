# ADR 0009: Multi-tenant Azure customers - one connection per tenant, tenants read one at a time, one least-privilege registry

Date: 2026-11-03
Status: Accepted - not built. AZR-61 to AZR-65 build it on
        feature/multi-tenant-azure. The lab has one tenant, so multi-tenant
        behaviour is proven with fakes until a second test tenant exists.
Invalidates: none
        No living document instructed single-tenant design; the "single
        tenant only" rule lived in project memory, which was rewritten the
        same day. backlog.md section 6i records the request and the three
        operator decisions this ADR implements.

## Context

The operator asked (2026-11-03) for multi-tenant Azure support: a gap
dashboard per tenant (configured in Azure vs not, onboarded to Cribl vs not),
a Setup option that takes a comma-delimited list of tenant ids and produces a
change request per tenant, and an audit of every app function's least
privilege so those change requests are accurate.

Three operator decisions (backlog.md 6i): one app registration per tenant,
stored as one connection profile per tenant; the Cribl side supports both one
workspace for every tenant and a worker group per tenant; built on a parallel
branch.

Two facts measured the same day shape everything below:

- **The least-privilege audit** (docs/audit/2026-11-03-least-privilege-audit.json):
  462 outbound call rows across 12 provider families, each family's least
  role and narrowest scope researched against Microsoft Learn and checked by
  two skeptics (84 rows corrected), then diffed against the app's plans: 24
  discrepancies (3 high), and 24 single-tenant assumptions in the code (7
  high). **Measured** (code read and docs fetched by the audit agents; not
  exercised against Azure).
- **The Cribl app proxy cannot choose a credential per request.** A spike in
  Live Preview echoed `typeof` probes through an echo host: the inject
  template sees only `kv`; no request context; a computed key
  (`kv["azure" + "Basic"]`) resolves to undefined. **Measured** (recorded in
  claude-kit standards/cribl-app-platform.md). Every Azure credential is
  injected from one fixed key per host (`azureBasic`, `azureArmToken`,
  `azureGraphToken`).

## Decision

### 1. One connection profile per tenant (existing model, extended)

A tenant is a connection profile (domain/azure-profiles) holding that tenant's
app registration client id, tenant id and encrypted secret. Setup gains a
"paste tenant ids" input (comma or newline delimited, GUIDs validated,
duplicates collapsed) that creates a profile per new tenant and never
overwrites an existing profile's secret.

### 2. Tenants are read ONE AT A TIME through a tenant session

Because the proxy injects from fixed keys, reading tenant N means: put N's
Basic credential into `azureBasic`, mint N's ARM (and Graph) token into
`azureArmToken`/`azureGraphToken`, run N's reads, release. A `TenantSession`
port owns that sequence; usecases receive ordinary ports and never know a swap
happened. Two guards, because the app KV store is shared by every tab and
user of the app and has no compare-and-swap:

- **A lease** (a KV document naming the holder and an expiry) is taken before
  a swap and released after. It is best-effort: it stops this app's own tabs
  from interleaving, not a determined race.
- **Proof of tenant before AND after a batch.** Before tenant N's reads run,
  and again after them, the session reads `GET /subscriptions/{sub}` and
  checks the returned `tenantId` is N; the batch counts only when both answer
  as N and the lease is still this holder's and unexpired when the work ends.
  A mismatch, a refused proof or a lost lease (another tab swapped underneath)
  makes N's batch unknown, never red. Save and connect and the secret probe
  read the lease too, and do not write the slot while another tab holds it.
- **What the proof does not prove.** The read names the subscription's HOME
  tenant, not the token's issuer: a token from a tenant the subscription is
  delegated to (Azure Lighthouse, `managedByTenants`) reads it too, so a
  delegated subscription is unknown rather than proven. The Graph token is not
  proven at all - no Graph read the app holds a permission for names the
  token's tenant.
- **Within one tab**, the credential slot admits ordinary requests for one
  tenant at a time: a request for another tenant waits until those drain,
  so no tenant can mint into the slot between another's token check and send.

A multi-tenant read is therefore sequential and slower than single-tenant;
results are cached per tenant so the dashboard does not re-read on every view.

### 3. Every persisted Azure fact is tenant-scoped

KV keys that hold Azure state - the onboarding selection and progress, the
How-to plan values, Cribl source records, capability and permission results,
the logging map - gain the tenant id in the key (or become a map keyed by
tenant), with a one-time migration that files today's unscoped document under
the active tenant. Cribl source and secret ids gain a short tenant component
so two tenants' sources never collide in one worker group.

### 4. One least-privilege registry

AZR-61 lands the audit as ONE registry in @soc/core: function -> calls ->
operation -> least built-in role -> narrowest scope -> citation. The
change-request generators, app-permissions, the permission preflight, the
How-to rbac lines and AZR-60's banners read it; none restates a role. A pin
fails when an Azure call site in the code has no registry row.

### 5. Tenant to Cribl mapping is configuration

A KV document maps each tenant to the shared worker group or to its own; it
defaults to unset rather than guessing, and the dashboard and the onboarding
create read it.

### 6. The dashboard

A grid: tenants down, Azure native logging sources across, two indicators per
cell (configured in Azure; onboarded to Cribl), each green, red or unknown -
unknown whenever a read was refused, not run, or not proven to be that
tenant's. Reads happen only when asked (per tenant or all), through the tenant
session, paced inside the shared request budget; mounting the screen makes no
Azure call. Every tile carries an (i).

## Unverified

- **Inferred:** swapping `azureBasic` and re-minting the token takes effect on
  the next proxied request (no proxy-side caching of injected values). The
  existing connection switch suggests it does; measure it with two tenants.
- **Inferred:** `GET /subscriptions/{sub}` returns `tenantId` for the token's
  tenant under Reader (the field exists in the ARM schema).
- **Unknown:** how long a full multi-tenant scan takes per tenant at the
  shared budget; measure before promising operators a time.

## What this breaks or constrains

- **Open defect AZR-92 (2026-11-03): other tabs are not protected.** The lease
  and the tenant proof guard the session's own batch. Another tab's, or another
  user's, ordinary Azure reads and writes during a session go out under the
  session's tenant credential and are attributed to their own tenant. Until
  AZR-92 is fixed, run a multi-tenant read only when no one else is using the
  app.
- The 7 high-severity single-tenant assumptions in the audit become defects
  to fix (AZR-65 and its sweep), not notes.
- Every KV key named in decision 3 changes shape; old documents are migrated
  once, never read in two shapes.
- Change requests are generated per tenant from the registry; the existing
  single-tenant ticket is one tenant's output.

## What is NOT decided here

- A single multi-tenant app registration with admin consent per tenant, and
  Azure Lighthouse (both rejected in backlog.md 6i).
- A backend endpoint that would let tenants be read in parallel.
