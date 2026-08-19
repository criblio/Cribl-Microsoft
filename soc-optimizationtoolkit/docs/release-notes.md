# Release notes

Newest first. One accumulating file rather than the per-version directory used
by the deprecated PowerShell toolkit: this app releases often, and a single file
is harder to forget to update than a directory that has to be remembered.

---

## 1.11.15

**The workspace table list is gone from DCR Gap Analysis; the listing is not.**
Reported 2026-08-18: the section was making the screen busy for no return. It
was built as a picker - list the workspace's tables, choose ONE for the whole
analysis - and when the choice became per log type in 1.11.13 the picking moved
onto the mapping-review cards while the panel kept its filter box, its ~842-row
list and its count line. Nobody selected from any of it.

The fetch stays, because the workspace's table inventory is one fact shared by
every log type - what is per log type is the choice over it - so it remains one
call rather than one per card. It is now a hook with no surface: on success it
renders nothing, and the tables appearing in each Destination selector are the
evidence that it worked.

A failed listing is one line in the mapping review's existing routing-notes
block, naming what the failure cost ("the destination selectors below offer only
this solution's tables and the common natives") with an inline Retry. It is not
re-attempted automatically, so one 403 cannot become a request storm.

**Two overflow fixes ride along.** The triage now NAMES the fields with no
destination equivalent instead of only counting them, and says when the pairing
itself is the suspect - an ASim authentication sample pointed at
CrowdStrikeAlerts left 161 of 161 overflow fields unmappable against 108
columns, where the useful next step is checking the sample, not adding a column.
And the remedy now depends on who owns the table: "add a column" is sound for a
custom `_CL` table and impossible for a Microsoft-managed one, which is exactly
what shipped for those 161 fields.

**Also:** the run button reads "Deploy" in every state rather than renaming
itself to "Deploy everything", and choosing a destination table now asks ARM
whether it exists rather than consulting a listing that may not have loaded -
which had been analysing against the derived schema while the UI promised live
columns from Azure.

---

## 1.11.14

**The live schema is now awaited before the analysis re-runs.** Choosing a
destination table fetched its live columns and re-analysed in the same breath,
so the run could read a catalog the new columns had not reached yet - the
results looked like the new table and were computed against the old schema.
`changeTable` now fetches first and passes the schema into the run it starts.

## 1.11.13

**A destination table is chosen PER LOG TYPE, not per analysis.** A solution
rarely lands in one table - CrowdStrike alone spreads its log types across
several, and each destination is its own DCR with its own schema. The live
schema tier holds a map of every table any log type was pointed at, and
replacement is scoped to the tables in that map; everything else still resolves
through the derived fallback, because pointing one log type at a real table says
nothing about the others.

## 1.11.12

**The gap analysis can be pointed at a table that already exists.** The workspace
table listing feeds every log type's Destination selector, and picking a real
table replaces the derived schema with the live columns from Azure rather than
blending the two - a blend would match neither source, and every verdict computed
against it would describe a table that does not exist. A `table.read` denial
annotates the picker; it never hides or disables it, because Azure's own 403 is
the real gate.

## 1.11.11

**CSV operators are told the truth about route filters.** Both route
discriminators return early for CSV - data rows are positional, so at route time
the event is unparsed and the field name never appears in `_raw` - which means
every CSV log type placeholders by construction. That is correct, and it made
the write-a-filter hint the only routing guidance a CSV vendor's operator ever
got. It was offering `event_type === 'dns'`, a parsed-field test that cannot
work at route time for exactly the reason the discriminators bail. The hint is
now format-aware: CSV gets a `_raw`-based example and a line explaining why a
field test is undefined there.

## 1.11.10

**One definition of "characteristic field", and an honest header.** The two
route discriminators asked the same question - is this field characteristic of
the log type, or of one event? - and gave different answers to the same input,
each with its own inline arithmetic. They now share `fieldPresence`, which
returns three states rather than a boolean so the one place the callers
genuinely differ (`not-in-evidence`) has to be stated rather than drifted into.
The value-discriminator header was also rewritten to describe the guards that
actually run, after two dead ones were removed.

## 1.11.9

**The presence discriminator stops over-fitting on per-event ids.** A field
present in only some of a log type's events yielded a filter that missed the
rest; a per-event id lands there by construction across a large sample.

## 1.11.8

**A route filter's value must NAME its log type.** The governing rule: each
vendor log type can be defined with the contents of the log itself, so the field
that defines a log type carries a value that names it - `action` is "Cautioned"
in CAUTIONED. Measured live on the Zscaler pack, the previous fewest-distinct-
values ranking offered `client_tls_sig_pqc_offers === '1'` for ALLOWED and
`client_tls_keyex_hybrid_offers === '0'` for web-BLOCKED: TLS capability flags,
structurally perfect and semantically meaningless, three of four offers wrong and
one click from being applied. Fewest-distinct-values actively favours binary
incidental flags, because a two-valued flag scores better than a real column.

## 1.11.7

**Both rule-reading paths report the same count.** They disagreed, which meant
one of the two numbers an operator saw was always wrong.

## 1.11.6

**A route filter is written for the rest, and three blocks got their styling.**
Log types with no qualifying discriminator now get a placeholder filter that
matches no event, so the route, pipeline, lookup and sample all survive and start
working the moment an operator writes a filter - rather than a match-all, which
made every later route unreachable because routes are final. A class-name sweep
also found `.link-button` rendering as full chrome and the identity-mismatch
block with no container or row layout.

## 1.11.5

**Route derivation gained the column test.** A discriminator must behave like a
column across the whole corpus: every log type carrying the field is single-valued
on it, and those values are pairwise distinct. The looser "no sibling sends this
value" test let incidental fields through that partitioned three sample events and
would not have survived live traffic.

## 1.11.3

**A pack sample id collision no longer drops every sample.** Two samples that
hashed to the same id left the pack with one.

## 1.11.1

**The identity module reads the fields it owns.** It was reading fields resolved
elsewhere, so a correction applied in one place did not reach the other.

## 1.11.0

**The CEF identity override is surfaced on the analysis card.** The finding used
to exist only in the model. `IdentityBlock` and `IdentityMismatchBlock` now render
inside each mapping-review card, including "Vendor identity does not match this
solution's rules" with its one-click correction - and the override is carried into
the GENERATED PIPELINE by `buildCefIdentityOverrideFn`, placed right after CEF
extraction so the reduction rules see the corrected value. An override that only
changed the analysis would leave deployed data still carrying the wrong vendor.

## 1.10.0

**The inventory standard applies across every lister.** An empty result is only a
zero once the read was verified: an RBAC-filtered `200 []` is byte-identical to a
genuinely empty workspace and would read as one. Every lister now distinguishes
"nothing has been loaded" from "the read completed and found nothing", and only a
measured capability may call the second a fact about the environment.

---

## 1.9.0

**DeviceVendor and DeviceProduct can be changed after they are set.** Reported
2026-08-12. Picking NSSWeblog left a read-only row whose hint pointed at another
section, so correcting a one-click choice meant leaving the card you made it on.
A value the SAMPLE provided could not be corrected at all - a wrong
DeviceProduct in the data was simply unfixable in the app.

Every identity row is now the same editable control in every state: the current
value, a text box, a Replace button, and the vendor's known values as one-click
chips. Only the framing changes - Required while missing. Candidates are still
offered and never auto-picked, because the wrong constant silently breaks
Sentinel's content filters.

Replacing a sample-provided value now says what it costs: the constant
overwrites the per-event value for every event.

**A `startswith` filter is no longer read as a product value.** Zscaler's
connector filters `DeviceProduct startswith "NSS"`, and the app took `NSS` as
the product and auto-seeded it - a value Zscaler never emits (the real ones are
NSSWeblog and NSSFWlog). It satisfied the one connector query it came from and
failed every analytic rule comparing the product with `==`; being seeded, it
also looked settled, so nothing prompted a correction.

Stems are now offered as candidates. A single `==` product is still seeded -
that one names a constant the vendor actually emits.

---

## 1.8.0

**Pipelines now do what the DCR Gap Analysis says.** Reported 2026-08-12 while
testing Zscaler: the analysis promised 133 of 170 fields would land in
`AdditionalExtensions`, and the generated pipeline had no function that put them
there. It happened for every solution, not just Zscaler.

The planner resolves a table's fields through a priority ladder. Only the rung
fed by the field matcher ever supplied a real overflow config; the rung the gap
analysis actually uses hardcoded a DISABLED one. So a field marked `overflow`
fell through the emitter completely - excluded from the renames (correct), then
skipped by the serialize step (gated on enabled) and missed by the cleanup drops
(which only remove `drop`). It reached the DCR under its raw vendor name and was
discarded there.

Silent by construction: nothing errored, the YAML validated, the pack installed,
and the only symptom was fields missing from the table.

Overflow is now enabled by the FIELDS - if any field asks for it, the table's own
catch-all column collects them. That fixes the reviewer-edit path too, which had
the same hole. The field matcher's own config still wins when it is present.

**Dropping stays per-field.** Fields bound for the catch-all are never removed as
a block, so you can send most of them to `AdditionalExtensions` and drop just the
noisy handful. Marking a row `drop` keeps it out of the catch-all AND removes it
from the event; everything else still lands there.

---

## 1.7.1

**Fixes a crash in 1.7.0 that blanked the Sentinel Integration screen.** The
pack-name change read the selected solution from a `useState` initializer, which
runs immediately on first render - before the line that declares it. Every visit
to the screen threw and rendered nothing.

If you installed 1.7.0, upgrade. Nothing else in it was affected, and no data or
configuration is involved.

Typecheck could not see it (the read sits inside a closure, where TypeScript
cannot know when it runs) and 3,498 tests passed, because none of them rendered
that screen - the flagship of the app. There is now a smoke test that mounts it,
verified to fail on exactly this bug.

---

## 1.7.0

**The pack name now includes the solution.** It was prefilled from the Cribl
destination prefix alone, so EVERY solution proposed the same name -
`MS-Sentinel`. Building a second solution therefore landed on the first one's
pack, and the only thing between that and a silent replacement was an operator
reading the overwrite prompt carefully.

The pack's *display* name was already solution-derived ("Gigamon Sentinel",
"Cloudflare Sentinel"), which made the collision harder to spot: two packs
reading as different things, sharing one id.

Now `MS-Sentinel-Gigamon`, `MS-Sentinel-Cloudflare`, and so on. The vendor is
shortened by the same rule the pipeline ids and sample filenames use, so a pack
and its contents never abbreviate a vendor differently, and underscores become
hyphens to match the prefix.

The name also **re-derives when you change solution** - previously the prefill
ran only on first load, so switching solutions silently kept the old name. A
name you have typed yourself is never overwritten.

`naming.ts` had no test file of its own until now, which is how the pack name
came to ignore the solution entirely without a suite noticing.

**Existing packs are untouched.** This changes the proposed default only; a pack
already installed keeps its name until you rebuild with the new one.

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
