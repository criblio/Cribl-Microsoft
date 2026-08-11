# Release notes

Newest first. One accumulating file rather than the per-version directory used
by the deprecated PowerShell toolkit: this app releases often, and a single file
is harder to forget to update than a directory that has to be remembered.

---

## 1.6.0

**Packs stopped shipping placeholder Sentinel destinations.** Reported
2026-08-11. A rebuilt pack could carry
`dcr-00000000000000000000000000000000` and `UPDATE-DCE-ENDPOINT` as its
destination - installing cleanly, showing green, and sending nothing anywhere.

The cause: the pack read real DCR values ONLY from the Integrate screen's
in-session deploy outcomes. Those are React state - cleared on every deploy and
gone on reload - so deploying, reloading, and rebuilding produced placeholders
while the real rules sat in Azure the whole time. The "Rebuild pack" button was
the flow that hit it hardest, and its tooltip promised the opposite.

**The pack now asks Azure.** Anything the session does not know is resolved from
the deployed DCRs themselves, matched on the tables a rule actually routes - so
a renamed or hand-created DCR resolves too, which name prediction would have
missed.

**It refuses to guess.** Two rules routing one table is a real situation, and
picking either would bake the wrong endpoint into a pack that installs without
complaint. That resolves to placeholders with both rule names in the reason.
A DCE-based rule (no logs-ingestion endpoint) is reported differently from no
rule at all, because the fixes differ.

**And it is never silent again.** Every table shipping placeholders is named in
the build log with why, and carried into the Deploy summary - a green summary
over a pack that sends nowhere is the worst thing this screen can produce.
`assemblePack` now returns `placeholderTables` so no caller has to re-derive it.

Minor rather than patch: `AssembledPack` gained a field.

---

## 1.5.5

**The permission check now measures everything the change request asks for.**
1.5.3 started asking for Microsoft Sentinel Contributor and RBAC Administrator,
and nothing verified either - so an identity holding neither passed Permission
Verification clean and then failed at content install and at the DCR ingestion
grant, one request at a time.

Three checks added to the existing-workspace path (Sentinel analytic rules,
Sentinel workspace onboarding, and the DCR role grant) and one to the
bring-your-own-lab-RG path.

**They report without blocking.** Deploy readiness is a single boolean, so
adding a check for anything short of essential would have told an operator who
can deploy DCRs perfectly well that they were not ready. Checks are now `core`
or `feature`: only core gates readiness, feature ones are measured and shown.
A scope with everything but the optional grants now reads "all required actions
granted; 1 optional action(s) missing" rather than a flat MISSING, and those
rows render `[optional]` instead of `[missing]`.

A contract test now pins that the two lists agree - the ticket cannot ask for a
role the preflight does not measure without failing the build.

---

## 1.5.4

**Change-request permission blocks wrap properly.** Caught reviewing 1.5.3 in a
live preview: the justification and "if not granted" lines ran to 300-plus
characters unwrapped, so they reflowed to the left margin and destroyed the
block alignment, in a document that hard-wraps everything else. They now wrap at
78 columns with a hanging indent under the value. Resource ids longer than the
wrap width overhang rather than break, since a split id is worse than a long
line.

---

## 1.5.3

**The app-registration change request now asks for every permission the app
needs.** It used to ask only for the registration and a client secret - so an
operator who got exactly what they requested had an app that could
authenticate and do nothing else, then met each missing permission one failed
request at a time, each needing a fresh ticket.

The ticket now carries the full plan, in two sections because they are usually
two different approvers:

- **Microsoft Graph** - `Application.Read.All`, admin-consented on the
  registration. This was documented nowhere an operator would look: the app
  needs it to list service principals so you can pick Cribl's ingestion
  identity by name rather than hunting for its object id. Requested instead of
  the broader `Directory.Read.All`, which also works but reads the whole
  directory.
- **Azure RBAC** - the setup path's roles, plus two that no setup path grants:
  **Microsoft Sentinel Contributor** (content install writes
  `Microsoft.SecurityInsights` resources; Log Analytics Contributor grants read
  but no write there) and **RBAC Administrator**, constrained, for granting
  Cribl's identity Monitoring Metrics Publisher on each deployed DCR.

Every line names the feature that needs it, why, and **what stops working
without it**, marked `[core]` or `[feature]`. An approver who can grant some of
it and not the rest can now see the cost of each refusal instead of guessing -
and a partial grant leaves a working app with fewer features, never a broken
one.

The plan is composed from the existing role model rather than restated, so a
lab path whose Contributor grant already covers Sentinel content is not asked
for both. `1.5.2` shipped the credential form in the wizard's Connect Azure
step, which previously offered the change request and no way to connect.

---

## 1.5.0

Additive. Nothing an operator does changes, and there is no migration.

**DeviceVendor / DeviceProduct override.** These two CEF header fields are what
Sentinel content keys off - rules filter on them by literal string, so a sample
whose vendor does not match what the rules expect deploys cleanly, ingests
cleanly, and never fires a rule. Nothing errors, because nothing is broken.

The toolkit can now derive what a solution's rules expect (from the literals
coverage analysis already extracts), compare it against the sample, and force
the corrected value into the generated pipeline. Wrong CASING is reported
separately from a wrong vendor, because the rule corpus mixes `==` and `=~` and
only one of them cares.

**Workspace table listing.** The tables in the connected Log Analytics workspace
can be listed and a table's live schema fetched - the groundwork for pointing
DCR gap analysis at any existing table.

**Not yet reachable from the UI.** Both arrived as capability this release; the
screens that expose them come next. The pipeline override is live for anything
that sets a value, so a pack built with one carries the corrected vendor.

---

## 1.4.0

**Operating modes are gone. What this app can do is now MEASURED, not chosen.**

### Read this first: every existing install sees the setup wizard once

Upgrading from 1.3.x or earlier lands you in the first-run wizard on the next
load. This is expected and it is not a reset of your configuration.

The old app persisted an operating mode, and a missing mode was also how the app
knew setup had never been completed - one value doing two jobs. Removing modes
meant giving "setup is finished" its own record, and existing installs do not
have one yet. Nothing else is touched: **connections, the GitHub token, the
committed Azure target and the stored client secret all survive.** Click through
the wizard once and the next load goes straight to the app.

Verified on a live workspace before release, not just in tests.

### What changed

**Modes are replaced by a permission audit.** Full / Azure Only / Cribl Only /
Air-Gapped are removed. The app now audits what the connected identity can
actually do - effective Azure RBAC actions plus live Cribl capability probes -
and adapts to the answer.

**The menu tells you what you cannot do; it no longer hides it.** Previously a
mode removed screens from the sidebar. Now every screen is listed, and anything
unavailable carries a short flag and a reason:

| Flag | Meaning |
| --- | --- |
| `no access` | Measured: the identity cannot do this |
| `unchecked` | Not measured yet - run the permission check |
| `not connected` | No Azure/Cribl connection at all |

`unchecked` is deliberately quiet: not having measured is not the same as having
been refused, and the app never renders the first as the second.

**Nothing is disabled.** A screen flagged `no access` still opens, and the action
still runs. The audit informs and offers; Azure's own 403 is the real gate. A
stale or wrong audit costs you an annotation, never the ability to work.

**The permission check moved to the end of the setup wizard** - verify what the
identity can do, then Get Started - and finishing no longer requires choosing a
mode.

**Settings:** the "Operating mode" section is now "Setup". Reconfigure still
works; it reopens the first-run wizard instead of the mode chooser.

### Known gaps

- **Blocked actions do not yet offer their downloadable artifact.** The model
  decides correctly that a blocked action should hand you an ARM template, a
  change request or a `.crbl` to pass to someone with access, but no screen
  renders that offer yet. It is annotation only for now.
- **The audit's age is not shown**, and there is no manual re-check button. The
  audit refreshes on connection switch, scope commit and secret entry.
- **Event Hub Discovery is never flagged.** It reads through Azure Resource
  Graph, which the capability taxonomy does not cover. Rather than mis-report it
  as a workspace or DCR read, it is left unannotated and the screen reports its
  own errors.

### Upgrade notes

Nothing to do beyond clicking through the wizard once. No configuration
migration, no re-entering credentials.

---

## 1.3.0 and earlier

Not documented here; this file starts at 1.4.0.
