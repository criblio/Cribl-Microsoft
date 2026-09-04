# Release notes

Status: Record - an append-only log of what shipped, newest first. Every entry is true of its own release and is never edited afterwards.

Newest first. One accumulating file rather than the per-version directory used
by the deprecated PowerShell toolkit: this app releases often, and a single file
is harder to forget to update than a directory that has to be remembered.

---

## 1.12.4

**AWS VPC Flow Logs are read, and the pack built from them extracts what the
screen showed.** A user uploaded a 22-line VPC Flow sample and got no events:
the format is whitespace-positional, `SampleFormat` had no positional member, so
detection fell through to `unknown` and nothing parsed - while the app's own
catalog advertised the source as supported. Positional parsing now names the v2
columns when it recognises the shape and numbers them `field1..fieldN` when it
does not, which is the honest answer for a format that keeps its schema outside
the file.

That fix left a second half open, and it is the one that would have cost an
operator the most: `pipeline-conf.ts` had never been taught about positional
either, so the generated pack's extract step ran Cribl's JSON serde over a
whitespace line and extracted nothing. The app showed success at every screen and
handed over a pack that could not reproduce any of it. The pipeline now splits
`_raw` itself and assigns the same names the parser produced - the case where the
app mints the runtime name, so parse and pack agree by construction.

**A Cribl capture of a positional log unwraps to the events, not the envelope.**
Reported with a live capture off an S3 feed: uploading it gave 100 events and 13
fields, and the 13 were `__criblEventType`, `__channel`, `cribl_breaker` and the
rest of the Cribl wrapper, with an empty error list. The capture unwrap exists
and is first-class; it declines when it cannot identify the inner format, and its
detector had no positional branch. Same file now yields the 14 VPC columns. The
app's own capture path shared the detector and is fixed with it.

**Field names are no longer silently truncated, collided, or overwritten.**
`src-ip=1.1.1.1 dst-ip=2.2.2.2` parsed to a single field `ip` - the prefixes
discarded and the two fields collapsed onto one, so one value was lost with no
error. CEF was worse: its extension parser truncated the key AND swallowed the
pairs that followed into the previous value. Both key classes are widened, with
the escape rules, empty values and syslog prefixes each pinned.

**A CEF header written to the spec is read to the spec.** `CEF:0|V\|W|P|...`
escapes the pipe exactly as CEF requires; the parser split on it anyway and every
header field shifted by one, silently, since all seven names were still present.
The parser and the generated pack now share one escape-consuming pattern, so they
cannot disagree.

**Names Cribl cannot address are reported at the sample, and refused at the
build.** A hyphen fails loudly in Cribl; a dot is worse, because `a.b` is a valid
accessor for a nested field, so a rename addressing it silently does nothing and
reports success. The sample screen now names such fields when it reads them, and
pack generation refuses them on a rename - including names containing whitespace,
which the validator's line matcher could not previously see.

**A log type that cannot be routed says so, and says what does work.** Routes are
evaluated before the pipeline extracts, so for CSV, whitespace-positional and
syslog the field names shown in the app do not exist yet at route time. Those log
types were getting filters in which every disjunct was false - a dead route that
previewed clean. They now get a placeholder and an explanation that points at the
raw line instead of sending the operator to collect more samples, which could
never have helped.

**The SIEM migration knowledge base no longer points two vendors at the wrong
solution.** Every `f5_` sourcetype resolved to Cisco ASA, and `zeek_` to Windows
Security Events, with the same confidence as every correct mapping. Solutions
that name no Sentinel folder are now declared rather than offering a pivot that
cannot complete.

**The pivot into Sentinel Integration says that it discards samples.** It reaches
the same branch the Clear button does, and Clear has carried that warning since
1.11; this button was presented as navigation and said nothing.

The solution deep-link chip is gone: it advertised a URL the shipped shell cannot
serve, so an operator who copied it got nothing. The mechanism behind it is
unchanged and still carries the SIEM pivot.

## 1.12.3

**A rebuilt pack no longer inherits the previous build's pipelines.** Building a
pack over one that was already installed took Cribl's "Upgrade a Pack" (`PATCH
/packs/{id}`), and an upgrade MERGES the archive over what is there. Pipeline
directory ids are derived from the operator's log type, so the moment a log type
was renamed between builds the earlier ids were no longer in the archive - and
the merge left them behind with no configuration. In the Cribl UI they appear as
nameless pipelines with 0 functions reading "Missing pipeline configuration".
The trigger is the rename rather than the rebuild: across five app-built packs
in one workspace, the two whose log types changed between builds carried four
and twelve-plus leftovers, while a never-rebuilt pack and two rebuilt ones whose
log types stayed put carried none. Re-deriving log types from a fresh sample set
is exactly what renames them, so the common case hits it - and an operator could
not tell a leftover from a pipeline the build had failed to write.

An overwrite now REPLACES: the existing pack is deleted and reinstalled, so its
old tree goes with it. The documented upgrade is kept for the one case that
needs it - a pack whose pipelines are referenced by routes outside it cannot be
deleted - and that path now says so out loud instead of passing as a clean
overwrite, because it still leaves the earlier pipelines in place. This makes
the code do what the button already promised: "Building will overwrite it
there."

**Verified against the deployed pack, not the preview.** A report that the
`AdditionalExtensions` catch-all was missing from generated pipelines was closed
as not reproduced, after building a pack end to end from live Cribl Lake samples
and reading it back in Cribl: with a non-zero overflow (8 fields for one log
type) every transform pipeline carries an Overflow Collection group whose
`Serialize` writes to `AdditionalExtensions`.

**Correcting the record on 1.12.0: it HAS now run against a real workspace.**
The 1.12.0 entry below ends "What this release has NOT done: run against a real
workspace", which was true when written and has been false since 2026-08-25.
That entry is left as it stands - it is a record of its own release - so the
correction lives here, at the top, because a reader working newest-first was
otherwise still concluding that ADR-0003 shipped unverified.

All eight platform beliefs in `live-verify.test.ts` are settled, against the lab
workspace `main-busy-yonath-kz1bxn7`, Stream group `DatacenterEast`, Lake dataset
`winevt_plwindows`. Rows 1-7 confirmed. Row 8 answered the OTHER way: Cribl
tolerates a filter referencing an undeclared field, so the `typeof` guards in
`capture-filter.ts` are insurance rather than load-bearing. The guards stay -
what was wrong was the module's stated model, not its code.

**The run's yield was defects, not confirmations**, which is the case for having
run it. Four product defects, all silent, the first three each enough on their
own to stop the Lake path: job status was read at the top level when it lives at
`items[0].status` inside the `{items,count}` envelope, so every job reported
"still pending"; no clock was injected into the poll loop, so twenty polls fired
inside about four seconds and only an EMPTY dataset could finish in time;
`data_source` was missing from `DISCRIMINATOR_FIELDS`, so the one
security-shaped dataset reported no log types at all for 789K events already
split by Windows channel; and `GET /search/query` turned out not to be a query
route - it creates a job and returns `{isFinished:false, job:{...}}` - so
preferring it orphaned a job on every Lake query and put a raw platform error
under a success headline. It has been deleted from `queryLakeSamples` and its
grant withdrawn from `policies.yml`.

Plus seven harness defects, four of which had been returning confident wrong
answers rather than failing: row 1 could never have passed, because it read
`__inputId` off the payload strings after the envelope carrying `__inputId` had
been discarded. A green run of a lying harness is worse than a red one, because
nobody investigates it.

---

## 1.12.2

**Cribl Lake is a working sample source.** The Lake query ran but returned
nothing usable; it now runs, enumerates the log types a dataset actually holds,
and sizes them in bytes. Log-type detection was a coin flip - a dataset whose
events carry no discriminator was assigned one at random - and now reports what
it found, including an explicit group for events carrying no `msgid` rather than
silently folding them elsewhere. A single-log-type dataset is offered as such
instead of being described as a mixture of one.

**Positional CSV columns can be named.** A comma-delimited vendor feed arrives
as `field1..fieldN` and nothing said which was which. Columns can now be named
from a bundled vendor order, the naming is visible before it is applied, a
half-named definition stays reopenable rather than being lost, and samples that
arrive by Lake query or capture get the same offer as pasted ones. Four PAN-OS
column orders were transcribed from Palo Alto's published field descriptions -
transcribed, not inferred: a fifth (`AUTH`) was declined because Palo Alto
publishes no such log type and guessing one would mislabel every column after
the first mistake.

**Four live defects, all found by driving the product rather than reading it.**

- A successful commit erased its own summary. The re-seed effect was keyed on a
  value rebuilt from coverage, and committing samples always changes coverage -
  so the panel fell back to "Nothing is added until you confirm" immediately
  after adding something.
- A hand-edited capture filter was recomposed away by the same identity change,
  and to a NARROWER filter than the operator wrote, because the just-committed
  log types came back `provided` and un-ticked themselves.
- The dataflow canvas discarded a node drag and the undo history that would have
  recovered it, whenever the diagram was redrawn for a reason not in its storage
  key - ticking a flow was enough.
- The mapping review would not let a field be kept: with "Drop unneeded fields"
  on, a field moved back to overflow was re-dropped on the next render.

**Azure targeting finishes its own initial load.** It sat on "Checking Azure
permissions..." and "Loading subscriptions..." indefinitely, with no request in
flight and no error. Refresh from Azure appeared to fix it - it only worked
because it changes the loader key. The cause was a claim that outlived the run
that made it: the loader marks a key claimed before awaiting, the cleanup
cancels the run and discards its answer, and the claim stayed behind, so the
next run skipped a fetch nobody was waiting for.

**Workbook parameters are no longer offered as log types.** Sentinel workbooks
parameterise their queries, so `PaloAlto-PAN-OS` recommended `{activities}` and
`{EventClass}` beside TRAFFIC and THREAT - pre-ticked, compiled into a live
capture filter where nothing can match them, and counted in a warning that could
therefore never reach zero.

**Documentation is checked like code.** Nine documents were found asserting
things the repo had already disproved, the worst an unbuilt plan still telling a
future reader to build for a shell deleted six weeks earlier. Every document now
declares whether its instructions bind (`Living` / `Proposed` / `Record` /
`Superseded`), accepted ADRs must name what they invalidate, proposed plans
expire, and `npm run check-docs` fails the build on a live document naming a
deleted path. `docs/board.md` is new: the Kanban index over the backlog.

**Also**: a Zscaler NSS lab (three Lake datasets, three wire formats) and three
more Lake benches, capped at 7-day retention; the acquisition panels report what
a commit actually stored rather than what was requested.

**What this release has NOT done.** It is not installed anywhere: the lab
workspace still runs its own installed build, and packaging does not deploy.
One guard in the Azure targeting fix - that a cancelled run stops working rather
than merely stopping its state writes - is verified only against the live
product and resisted three attempts at a unit pin; it is called out in
`azure-targeting-screen.dom.test.tsx` so a green suite is not mistaken for
cover.

---

## 1.12.1

**Guid columns are no longer dropped, and the data no longer disappears with
them.** Any column typed `guid`/`uniqueidentifier`/`uuid` in Log Analytics was
removed from the DCR stream declaration entirely. Because a Kind:Direct DCR
treats its stream declaration as the input contract, and `transformKql` is a
pass-through of declared columns, the field was discarded at the DCR boundary
and the table column stayed **null forever** - with the DCR deploying
successfully and no error raised.

Guid columns are now declared as `string` and promoted with `toguid()` in the
transform. The gap analysis KQL parser learned `toguid` in the same change,
because without it a phantom field named `toguid` appears in the analysis.

This deliberately breaks the v1 bug-compatibility contract in
`domain/schema-mapping` (RULE 2b) and two `legacy-fixtures.json` fixtures. The
reasoning is recorded in
[ADR 0004](adr/0004-cast-guid-columns.md): the v1 script this was ported from
emitted an illegal `guid` type and got a loud Azure 400, so the port removed the
400 and kept the data loss, silently. Found by following up external PR #26,
open and unreviewed since 2026-06-11, whose author diagnosed it correctly.

Not verified against live Azure - the conclusion rests on documented
Direct-DCR stream semantics plus the absence of any repopulation path.

**Housekeeping** from the 2026-08-24 architecture audit, which came back clean
on layering, core purity, duplicated decisions and test-pin integrity: the dead
`screens/review/` module is deleted (1,232 LOC, no consumer since the Review
route retired), two nav comments that no longer matched the route table are
corrected, eleven provenance paths pointing at the pre-`deprecated/` PowerShell
tree are repaired, and five documents that contradicted the code are reconciled
- including the capability-model plan, which now records that its "every blocked
action falls back to a downloadable artifact" rule is **not actually clickable**.

---

## 1.12.0

**The Browse Samples modal is gone, and the app now says which log types to
bring instead of guessing which file fits.** This is ADR-0003 executed in full,
phases 0 through 5. A minor bump rather than a patch because a whole acquisition
path was replaced, not repaired.

Why the browser went: `scoreFileName` was the entire selection mechanism, and it
scored the FILENAME against vendor-name keywords - it never opened the file. The
one content check only ever rejected, so nothing confirmed a sample fit. The
operator got many files per vendor, most wrong for their solution, with no way to
tell which. A smarter fit check was designed and deliberately rejected: it is
real work to make a browser trustworthy that should not exist, and even a correct
one still hands the operator someone else's data as the starting point for their
own integration.

**What replaced it: `LogTypeRecommendation`, with three tiers of evidence.**

- `detection` - a shipped analytic rule filters on this value. The strongest
  claim available: the solution demonstrably breaks without it.
- `workbook` - a shipped workbook queries it. Real, and weaker; a dashboard panel
  is not a detection. Workbooks were already fetched, but only inside the
  workbooks section's Analyze button, pressed long after samples are chosen. They
  now come from the same content-first mount effect as the rules, which also
  fixed a real inconsistency - the early content requirements saw rules alone and
  under-counted the columns content needs.
- `vendor` - the vendor documents this feed. Says nothing about what the solution
  needs and everything about what exists to be collected, which is exactly the
  decision facing an operator whose solution ships no detections at all.

The tier is on every row and in the lead sentence. Collapsing them would tell an
operator their solution requires data it has never mentioned, so it is pinned. A
list built entirely from vendor docs reads "this solution ships no detections
that name a log type; Zscaler documents ...", never "your solution needs".

The panel and the completeness confirmation below the intake section now read ONE
coverage result, computed once, with a pin asserting they agree.

**The vendor catalog is both halves.** Thirteen hand-curated vendors, each cited
to the vendor's own documentation, plus 157 packs mined from elastic/integrations
(197 KB). Hand packs win the per-value dedupe - the same precedence the mapping
packs already settled. Packs carry `excludeKeywords` because substring matching
cannot express "most specific wins": every Zscaler Private Access solution name
contains "zscaler", so the ZIA pack would have told a ZPA operator to collect a
feed their product does not emit, and "Palo Alto Networks Cortex XDR" contains
"palo alto" and would have been handed the firewall's TRAFFIC and THREAT.
Recommending the wrong product's feeds is worse than recommending nothing, and
both cases are pinned from both directions.

**Two ways to acquire, and upload is still always there.** The panel asks one
question first - query a Cribl Lake dataset, or capture from a live source.
Search is not a third surface: it is HOW a Lake dataset is queried, verified live
by finding the same datasets in both listings. Discovery is lazy, so page load
costs one request and nothing else.

- **Lake query** returns the complete log-type list and per-type volumes. Counts
  and events are two separate reads on purpose.
- **Filtered capture** runs one bounded `POST /system/capture` and splits the
  result by discriminator. It PREVIEWS - nothing is tagged without a click,
  because the sample store is replace-by-logType and a capture is the one intake
  path where the app chose the content rather than the operator.

Two capture traps worth knowing. A capture request has NO source field, so the
source is an `__inputId` clause inside the filter string; deleting that clause
silently widens the capture to every source in the group, and that is the one
edit the warning checks. And the log-type predicate anchors on the SET of
delimiters this app's parsers use rather than on a comma - the operator picks a
source, not a format, so a comma anchor against a pipe-delimited CEF vendor
matches nothing, which reads as "this source does not carry that log type". `/`
is excluded on purpose so a URL path cannot match. The predicates are pinned by
EVALUATING them as JavaScript, not by asserting on their text.

**Volumes rank the recommendation (phase 5).** Lake counts reach the
recommendation, entries and the unreferenced set carry an event count, and both
rank by it. There is no threshold, nothing is flagged, and no headline mentions a
volume: a cutoff correct in one tenant is wrong in the next, and this module
already documents unreferenced log types as "NOT a problem - a vendor emits more
than any one solution detects on". Ranking asserts only what was measured. Two
rules the pins hold: unmeasured renders NOTHING - not 0, not "unknown" - and
volume ranks WITHIN a tier, never across one, so a vendor-documented feed with
890K events stays below a detection-tier log type with three.

**A parsing defect found and fixed along the way.** A syslog-prefixed PAN-OS
upload used to parse to ZERO events: detection called it syslog, and the syslog
parser cannot match a PAN-OS body. Detection now recognises the PAN-OS positional
fingerprint ahead of the syslog check, characterized first across both modes and
every format, because that detector is one every vendor depends on. RFC 5424's
`msgid` is now a discriminator too.

**Removed, with the salvage recorded:** the browse modal, its state module, the
`acquire-samples` usecase, `repo-samples` and the solution map. The splitter
SURVIVED - rehomed to `domain/sample-parsing`, because it is load-bearing for
capture and for mixed uploads and its only caller was on the deleted path.
`consolidateByTableRouting` was deleted as a capability the app never had: both
callers pass two arguments, so its branch had never executed. CEF/LEEF raw-line
preservation turned out to be a live defect on the INTAKE path rather than a
browse-path risk, so it was fixed in `parseSampleContent` and every intake path
benefits - LEEF, syslog, headerless CSV and Cribl captures included.

**What this release has NOT done: run against a real workspace.** Every platform
belief behind the Lake and capture paths is pinned against a fake Cribl client,
which catches our own logic and cannot catch a wrong belief about the platform.
`packages/core/src/testing/live-verify.test.ts` holds those eight beliefs as
runnable rows and skips unless `CRIBL_LIVE_BASE` and `CRIBL_LIVE_TOKEN` are set,
so the normal gate stays hermetic. The case for running it is already on the
record: `__inputId` turned out to be `<type>:<id>` rather than the bare id, so
every capture would have come back empty and been reported as an idle source -
caught by reading the vendored spec, not by any of the sixty-odd green tests over
it.

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
