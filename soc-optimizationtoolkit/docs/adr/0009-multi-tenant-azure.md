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
- **Across tabs (added 2026-11-03, AZR-92, operator decision: an owner check
  per batch).** The lease and the proof guard only the session's own batch,
  so every OTHER Azure request in every tab checks the credential-owner
  record (`azure-credential-owner`) before it is sent and again after it
  settles. The record names a tenant AND an app registration, and a
  request is admitted only when both match the active connection. The
  session marks the record "switching" before its first slot write and
  names the new owner only after both tokens are in; Save and connect does
  the same, and names no owner at all when its token step failed. The
  restore never installs a credential under a record naming another
  tenant: if neither the marker (retried once) nor the cleared record can
  be written, it does not restore. The session's own requests are exempt -
  they never read the record. What this costs and what it still does not
  prove are under "What this breaks or constrains".

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

- **Other tabs are protected by an owner check per batch (AZR-92, built
  2026-11-03; proven with fakes only, the lab has one tenant).**
  - *What is checked.* Every ordinary ARM and Graph request (reads and
    writes) passes through the shell's credential slot
    (`apps/cribl-app/src/platform/credential-slot.ts`, `shared`), which
    reads the owner record before anything is sent, token mint included.
    The Diagnostics panels go through it too: the raw ARM call rides the
    same check, and the token panel uses the guarded secret-probe path. A
    record naming another tenant, or the same tenant under another app
    registration, a "switching" marker, a cleared record, or a read that
    failed or does not decode refuses the request: a read rejects (the
    port's could-not-reach path, so a screen shows unknown - never red,
    never an empty list) with a message saying another tab is reading a
    different tenant through the shared credential, and a write (any
    non-GET) is never sent. Anything sent later on that verdict reads the
    record again first and is refused if it changed: every resend of a
    write after a 429, and the re-mint after a 401 (ARM) or 401/403 (Graph).
    After the requests settle the record is read again; unless it is the
    very record read before (every write carries its own write id, so an
    A -> N -> A session in between is caught), the answers are discarded
    as unknown and a write's outcome is reported as unknown. A batch
    admitted on a record other than the one this tab last saw drops the
    tab's token caches, so the next request mints its own token instead of
    trusting a slot another tab rewrote. A record that was never written
    (an install from before it existed) admits, because every session
    writes the marker before it swaps. A live secret probe over a record
    naming nobody (absent or cleared) records its connection; it treats a
    switching marker as left behind only when it is older than ten minutes
    and the lease, read after the record, is free, and it re-reads both
    inside its exclusive section before it mints.
  - *What it costs.* A batch is one tab's reads for one connection admitted
    while it is open - until its first member settles, and for at most two
    seconds after its before-read - and a write always opens its own. Each
    batch costs 2 KV reads of the record (1 when the before-read refuses or
    every member fails), so N reads issued together cost 2, not 2N. A read
    batch opened within two seconds of the previous batch's after-read
    reuses it as its before-read, so a sequential chain (nextLink paging)
    costs about 1 per request. Each write resend after a 429 and each
    re-mint costs 1 more. A record rewritten by another tab costs each tab
    one extra token mint. These are app KV store reads, like the lease
    reads, not proxied Azure requests; whether the platform counts KV reads
    against the 100 requests a minute is NOT measured, and the session's
    pacer does not see them. Building adapters or mounting a screen reads
    nothing.
  - *What it still does not prove.* That the slot holds what the record
    says: the record is plain KV with no compare-and-swap, written only by
    this app, so it is evidence of the last write, not of the slot. A write
    is refused only when the swap had begun before its own owner read (or
    re-check); one that started just before a swap still goes out and is
    reported as unknown, not undone. The same holds for a read: it is sent,
    and only its answer is discarded. A write landing between the probe's
    re-read and its mint is not caught. A tab still running a bundle from
    before AZR-92 writes no marker and no write id, so mixed versions are
    not covered. A screen that builds its adapters without the active
    connection's client id is checked on tenant alone.
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
