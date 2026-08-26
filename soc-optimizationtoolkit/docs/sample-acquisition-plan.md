# Sample acquisition plan - replacing the browser with a log-type recommendation

**START HERE. This is the only document you need to execute this work.**
[ADR 0003](adr/0003-remove-sample-browser.md) is the durable decision record and
is worth reading if you want the full argument - but everything required to do
the work is below, including the reasoning you need to avoid undoing it.

Written 2026-08-18 by a planning session, from a live read of the code.

> **EXECUTION STATUS (2026-08-23), branch `feature/log-type-recommendation`,
> PR #119: ALL PHASES 0-5 ARE DONE.** Phase 4 shipped both its paths, capture
> and lake query, in core and UI. Phase 5 shipped 2026-08-23 - the Lake counts
> now reach the recommendation, entries and the unreferenced set both carry a
> volume, and both rank by it. No threshold was added, by decision.
>
> **VERIFIED against a real workspace 2026-08-25 - the gate is CLOSED.** All
> EIGHT rows of "Needs live verification" are settled against the lab workspace
> `main-busy-yonath-kz1bxn7` (Stream group `DatacenterEast`, Lake dataset
> `winevt_plwindows`). The suite that settled them is
> `packages/core/src/testing/live-verify.test.ts`. Read the
> **"Attempt 2026-08-25 - CLOSED"** section before trusting any earlier sentence
> in this document about what is unverified; it also records the four PRODUCT
> defects and seven HARNESS defects the run exposed, four of the latter having
> been returning confident wrong answers rather than failing.
>
> Phase 3 shipped as `discoverSampleSources` (usecase), `domain/sample-sources`
> (pure inventory) and `SampleSourcePicker` (UI). It DISCOVERS and lets the
> operator choose; it acquires nothing - that is Phase 4, which now has a
> selected `SampleSourceRef` to act on.
>
> Phase 4 capture shipped as `domain/capture-filter` (filter composition),
> `captureSamples` (usecase) and `CapturePanel` (UI). It conjoins the
> `__inputId` clause with the log-type predicates, runs ONE bounded
> `POST /system/capture`, splits the result with `splitSamplesByLogType`, and
> PREVIEWS it - nothing is tagged without a click (user direction 2026-08-19),
> because the sample store is replace-by-logType and a capture is the one intake
> path where the APP chose the content rather than the operator. The filter
> anchor departs from what is written below, on purpose: see the
> **[SUPERSEDED]** block under "Filtered capture".
>
> Phase 2's recommendation grew from one source of evidence to THREE - shipped
> detections, shipped workbooks, and the vendor's own documentation, each
> labelled. See the second **[SUPERSEDED]** block under Phase 2; it also records
> the one command that has to be run to populate the generated half of the
> vendor tier, which ships empty.
>
> Phase 0's answers are in **[sample-acquisition-phase0.md](sample-acquisition-phase0.md)**
> and they change four things written below. Read that document before finishing
> Phase 4; the corrections are marked inline here as **[SUPERSEDED]**.
>
> **Nothing is blocked any more.** The one open question - whether `/search/*`
> is addressed at the leader or under `/m/{searchGroupId}` - was answered on
> 2026-08-19 by reading Cribl's own Search UI network calls against a live
> workspace: it is **group-scoped**, `/m/{searchGroupId}/search/...`. Details and
> caveats in the phase 0 doc, section 0.1b.

**Where to branch from.** This document was committed on `fix/live-schema-race`
(PR #118) and may not be on `main` yet. Check before you branch:

```sh
git cat-file -e origin/main:soc-optimizationtoolkit/docs/sample-acquisition-plan.md \
  && echo "on main - branch from main" \
  || echo "not on main yet - branch from fix/live-schema-race, or merge #118 first"
```

Branching from `main` while this file is only on the feature branch removes the
document you are reading. The toolkit is npm workspaces (`packages/core`,
`packages/ui`, `apps/cribl-app`) and `main` is protected, so the work lands
through a PR either way.

## The decision, in one page

The Browse Samples modal finds sample files for the selected Sentinel solution.
It does not work the way its surface implies: `scoreFileName`
(`domain/sample-acquisition/repo-samples.ts:278`) is the entire selection
mechanism, and it scores the **filename** against vendor-name keywords -

```ts
const fileLower = fileName.toLowerCase().replace(/[^a-z0-9]/g, "");
for (const kw of keywords) {
  if (kw.length < SHORT_KEYWORD_MIN) continue;
  if (fileLower.includes(kw)) score += kw.length;   // the file is never opened
}
```

The one content check, `detectPreIngested`, only ever REJECTS. Nothing confirms
a sample fits. The operator gets many files per vendor, most wrong for their
solution, with no way to tell which - reported as complicating the flow and
causing confusion.

**A smarter fit check was designed and rejected.** Auditing each sample against
vendor log-type documentation and the columns of the tables the solution writes
to is buildable - the machinery exists as the gap analysis - but it is real work
to make a browser trustworthy that should not exist. Even a correct fit check
still hands the operator someone else's data as the starting point for their own
integration. **Do not revive it**; ADR 0003 records the full argument, including
the `vendor-mapping-packs.ts` comment showing the repo already hit the
log-type-ambiguity problem and worked around it by dropping fields.

**What replaces it:** samples come from the operator, deliberately named, and the
app recommends WHICH log types to provide based on the operator's own
environment - Cribl Search over a Lake or federated dataset (complete log types
plus volumes), a filtered capture from a Cribl source (bounded, with
vendor-derived filter suggestions), or manual upload (needs no Cribl
integration). The recommendation itself comes from `deriveExpectedLogTypes`,
which already recovers the log types a solution's detections discriminate on.

## How to start

1. Read the verified-facts table below - it is a live read of the code, not
   recollection. Do not spend your first hour re-deriving it.
2. Do **Phase 0**. It is three verification questions, it is cheap, and it
   decides what is buildable. Phases 1-2 do not depend on any of it.
3. Work the phases in order. Phase 2 is worth shipping even if Phases 3-5 are
   abandoned.

Before deleting anything, read **Phase 1's "Keep - this is the trap"**. There is
one module that a reasonable person deletes by accident.

---

## Facts already verified - do not re-derive these

Every line below was read from the code during planning. Trust them; spot-check
only if the file has moved.

| Fact | Where |
|---|---|
| Selection is filename-substring scoring; the file is never opened | `domain/sample-acquisition/repo-samples.ts:278` (`scoreFileName`) |
| Keywords = solution words + ~70 vendor abbreviations | same file, `buildSampleKeywords:253`, `ABBREVIATIONS:99` |
| Survival threshold is score >= 8 | `REPO_MATCH_MIN_SCORE:211` |
| The only content check rejects, never confirms | `detectPreIngested:81` |
| Upload/paste/tag/CSV-resolution already exist and are independent | `packages/ui/src/screens/samples/sample-intake-section.tsx` (675 lines) |
| The browse modal is the ONLY consumer of the browse path | `sample-intake-section.tsx:664` |
| `SOLUTION_SAMPLE_MAP` has no non-test consumer outside its own module | grep: only `index.ts:31` + its own test |
| Log-type splitting by discriminator already works | `domain/sample-acquisition/splitting.ts:64` (`splitSamplesByLogType`) |
| 16 reconciled discriminator fields; first six are high-confidence | `domain/sample-parsing/discriminators.ts` (`DISCRIMINATOR_FIELDS`) |
| *(count corrected: EIGHTEEN as of 2026-08-25 - `msgid` was added 2026-08-21 for RFC 5424, `data_source` 2026-08-25 from live Lake data. Both sit in the LOW-confidence tail; the reconciled sixteen and the high-confidence six are unchanged)* | same file |
| PAN-OS: 8 log types + documented column order, cited to vendor docs | `domain/sample-parsing/panos-dictionary.ts` |
| *(count corrected: TWELVE as of 2026-08-25 - AUDIT, CORRELATION, IPTAG and USERID were transcribed from Palo Alto's published `Format:` lines and confirmed against four sources each. AUTH remains absent on purpose: the vendor publishes no such log type, so there is nothing to transcribe)* | same file |
| Expected log types are already derived from solution detections | `domain/coverage-analysis/expected-log-types.ts` (`deriveExpectedLogTypes`) |
| Expected-vs-provided comparison already exists | same domain, `compareLogTypeCoverage` |
| We already GET `/system/inputs` and `/routes` from the operator's Cribl | `usecases/live-architecture/fetch-live-architecture.ts:22,24` |
| The vendor-pack generator already walks per-log-type directories | `scripts/generate-vendor-packs.mjs:394` (`data_stream/<stream>/`) |
| Cribl Lake / Cribl Search exist as architecture concepts only - no API client | `domain/architecture-patterns/architecture-patterns.ts:78,83` |

---

## Phase 0 - verify the unknowns (blocking, cheap)

Three things were NOT verified during planning. Do these first; they gate what
is buildable.

1. **Cribl Search / Lake API from inside a Cribl.Cloud app.** Can we list
   datasets? Run a query? Is it synchronous? What auth and what permission? The
   `cribl-api` skill is the starting point. The toolkit knows Search as
   architecture only - there is no client anywhere.
2. **Capture API.** Source selection plus a filter expression, and the
   permission it needs. Also confirm a **regex literal with the `i` flag works
   in a Cribl filter expression** (`/traffic/i.test(_raw)`) - the whole
   filter-suggestion design in Phase 4 assumes it does.
3. **Does the UPLOAD path already preserve CEF/LEEF raw lines?** Today that
   lives only at `repo-samples.ts:400,428,486`, on the path being deleted. The
   shared `parse-sample.ts` does Cribl-capture inner-`_raw` UNWRAPPING, which is
   a different operation. Same question for `consolidateByTableRouting:505`.

**If (1) fails, Phases 1-2 still ship** and the product is better than today.
That is why they are ordered first - no Cribl API risk on the critical path.

---

## Phase 1 - remove the browser

**Delete:**

- `packages/ui/src/screens/samples/browse-samples-modal.tsx` (462 lines)
- `packages/ui/src/screens/samples/browse-samples-state.ts` - **except
  `plannedTagged`**, which `sample-intake-section.tsx` imports (3 refs)
- `packages/core/src/usecases/acquire-samples/` (whole usecase)
- `domain/sample-acquisition/repo-samples.ts` - AFTER salvage, below
- `domain/sample-acquisition/solution-map.ts`
- The browse entry point in `sample-intake-section.tsx:664`

**Keep - this is the trap:**

`splitting.ts` (`splitSamplesByLogType`, `browseSampleId`) must survive. It
separates a mixed stream by discriminator and is load-bearing for capture AND
for a mixed upload. Its only current caller is `precedence.ts`, which is itself
on the browse path - so deleting "the sample-acquisition domain" as a unit takes
the splitter with it. Rehome it (or keep the module and delete around it).

**Salvage before deleting `repo-samples.ts`** (per Phase 0.3): if the intake path
lacks them, move CEF/LEEF raw-line preservation and `consolidateByTableRouting`
across, with pins. Losing the first means CEF packs ship parsed JSON in `_raw`
instead of the raw line; losing the second means a CrowdStrike upload fragments
across destination tables instead of consolidating.

> **[SUPERSEDED - done, but not as written]**
> - `consolidateByTableRouting` needed NO salvage. It runs only when
>   `eventToTable` is non-empty and both callers pass two arguments, so it has
>   never executed. Deleted as a dead capability.
> - Raw-line preservation was a LIVE defect on the intake path, not a browse-path
>   risk, and CEF was the one format that already half-worked (pack-assembly
>   reconstructs a CEF line). It was fixed in `parseSampleContent` so every intake
>   path benefits - LEEF, syslog, headerless CSV and Cribl captures included -
>   rather than by porting `splitRepoFile`'s line-index trick.
> - Two more modules had live consumers off the browse path and were rehomed, not
>   deleted: `RemoteSampleSource` (used by the Repositories screen) to `ports/`,
>   and `matchSolutionName` (used by `analyze-samples`) to `domain/sentinel-content`.
> - `plannedTagged` was NOT kept. Its three references are all inside
>   `loadBrowsed`, which was the modal's Load handler.
> - `browseSampleId` is now `splitSampleId`; `splitting.ts` lives in
>   `domain/sample-parsing`.

**Test accounting:** state the before/after test count and where every removed
test went, the same way the 2026-08-18 table-picker removal did. A removed pin
must be traceable to either a replacement pin or a deleted capability.

---

## Phase 2 - the recommendation panel (no new Cribl API)

Fills the browser's slot in `sample-intake-section.tsx`. A join of three things
that all already exist:

- `deriveExpectedLogTypes` - what this solution's detections discriminate on
- the tagged-sample store - what the operator has provided
- `compareLogTypeCoverage` - the gap

Reads roughly: *"This solution's detections need TRAFFIC, THREAT and CONFIG.
You have provided TRAFFIC and THREAT."*

**Advisory, never blocking.** `expected-log-types.ts` is explicit that it is a
lower bound - rules that filter table-wide contribute nothing, ASIM-normalized
rules hide the discriminator behind a parser, and a solution with no shipped
detections yields an empty result that must read as "nothing to compare
against". Blocking the build on a lower bound blocks on a guess.

This phase alone is worth shipping even if every later phase is abandoned.

> **[SUPERSEDED - done, but the join already existed]** The 2026-08-04
> completeness confirmation below the intake section already computed this exact
> join. What was missing is the FORWARD-looking reading: the confirmation is
> backward-looking and gates the build, which is useful when the pack is built
> and useless when the operator is deciding what to fetch. Both halves now read
> ONE coverage result computed once in `integrate-screen`, and a pin asserts they
> agree. The panel is `LogTypeRecommendation`; the confirmation stopped
> re-listing the same names.

> **[SUPERSEDED - one source of evidence became three]** (2026-08-19)
>
> `deriveExpectedLogTypes` reads analytic rules and nothing else, so a Sentinel
> solution shipping few or no detections got "the app cannot say which log types
> it needs". Honest, and useless - precisely when the operator most needs
> telling. The recommendation now merges THREE tiers, each making a DIFFERENT
> claim, and the tier is on every row and in the lead sentence:
>
> - `detection` - a shipped analytic rule filters on this value. The strongest
>   evidence there is: the solution demonstrably breaks without it.
> - `workbook` - a shipped workbook queries it. Real, weaker; a dashboard panel
>   is not a detection. Workbooks were already being fetched, but only inside the
>   workbooks section's `analyze()`, which is a button pressed long after the
>   operator chooses samples. They now come from the same content-first mount
>   effect that already fetched the rules, which also fixed a real inconsistency:
>   the early `contentRequirements` saw rules alone and under-counted the columns
>   content needs, while `analyze()` had always merged both.
> - `vendor` - the VENDOR documents this feed. Says nothing about what this
>   solution needs, everything about what exists to be collected - which is
>   exactly the decision facing an operator whose solution ships no detections.
>
> Collapsing them would tell an operator their solution requires data it has
> never mentioned, so the tier is pinned. A list built entirely from vendor docs
> reads *"this solution ships no detections that name a log type; Zscaler
> documents ..."* and never *"your solution needs"*. The merge is
> `mergeLogTypeSources` in `domain/log-type-catalog`; the type is
> `DocumentedLogType`, NOT `VendorLogType`, because `sentinel-content` already
> exports that name for the connector-decoder's per-table projection.
>
> **[SUPERSEDED 2026-08-23 - the generated tier is POPULATED.** Commit df3ad5e
> ran the miner: `generated-vendor-log-types.json` carries 157 packs (197 KB).
> The "someone has to run it" instruction below is a FALSE TO-DO - it was true
> when written and has been satisfied. The precedence and trap notes are still
> accurate; only the emptiness claim is not.]**
>
> **The vendor tier has two sub-tiers and the generated one ships EMPTY.** The
> precedence mirrors `vendor-mapping-packs` deliberately - same problem, same
> answer, already settled here: HAND packs, each cited to the vendor's own
> documentation, are declared first and win the per-value dedupe over GENERATED
> packs mined from the elastic/integrations `data_stream` directory names.
> Thirteen hand packs (Zscaler ZIA and ZPA, PAN-OS, CrowdStrike FDR, FortiGate,
> Cisco ASA, Check Point, Okta, Netskope, SentinelOne, Cortex XDR,
> Corelight/Zeek, pfSense) therefore ARE the vendor tier today, and a breadth pin
> asserts all thirteen ids are present - with the generated tier empty, a silent
> shrink here removes the only fallback a solution with no detections has.
>
> **To populate the generated tier, someone has to run:**
>
> ```sh
> node scripts/generate-vendor-packs.mjs --bulk <elastic-integrations-checkout>
> ```
>
> It needs a local checkout and network, which the environment this shipped in
> did not have. Curated mode deliberately does NOT write the catalog: it fetches
> streams by name from `TARGETS` and never enumerates a package, so it would
> replace the catalog with a partial one that looks complete.
>
> Two matching traps surfaced while widening to thirteen, both worth knowing
> before adding a fourteenth. Substring keywords cannot express "most specific
> wins", and EVERY Zscaler Private Access solution name contains "zscaler", so
> the ZIA pack would have told a ZPA operator to collect ZIA Web - a feed that
> does not exist in the product they are onboarding. Same trap on "Palo Alto
> Networks Cortex XDR", which contains "palo alto" and would have been handed the
> firewall's TRAFFIC and THREAT. Recommending the WRONG product's feeds is worse
> than recommending nothing, so packs carry `excludeKeywords` and both cases are
> pinned from both directions. Okta is the one vendor that does not fit the model
> cleanly and says so in its own provenance: it emits ONE stream partitioned by a
> dotted `eventType`, so its entries are prefixes (`user.session`,
> `user.authentication`) rather than separate feeds.

---

## Phase 3 - source discovery

Validate and list what the operator can actually reach, then let them choose:

- Cribl Lake datasets and federated Search datasets (Phase 0.1 decides whether
  this is possible)
- Cribl sources - `/system/inputs` is already fetched by
  `fetch-live-architecture.ts` for the dataflow diagram; nothing reads it for
  sample guidance

Dropdown selection per the 2026-08-18 user direction: *"validate which Cribl Lake
dataset or Search dataset has access [to] the logs to search and have the user
select via dropdown which dataset applies and/or ask if they would prefer to
upload the samples manually or capture them with a user provided filter and
source selection."*

> **[SUPERSEDED - shipped, but as TWO modes, not three surfaces]**
> (user direction 2026-08-19)
>
> "Search dataset" is NOT a listed surface. Cribl Search exposes Lake datasets in
> its own dataset list - verified live: `cribl_metrics`, `Corelight` and
> `LogSources` appear in both `/search/datasets` and
> `/products/lake/lakes/default/datasets` - so listing both double-listed the
> same dataset and asked the operator to choose between a place and the
> mechanism for reading it. **Search is HOW a Lake dataset is queried.**
>
> The panel now asks one question first: **query a Cribl Lake dataset**, or
> **capture from a live source**. The mode decides what is read:
> Lake is ONE leader request needing no worker group; capture needs a group
> first. Routing a source INTO Lake was considered and deferred.
>
> Discovery is also LAZY: page load costs one request (`listGroups`) and nothing
> else. The first cut fanned out across every Stream worker group, which was up
> to nine, and needed a cap that silently hid groups.

---

## Phase 4 - the acquisition paths

Operator-chosen, each labelled for the evidence it gives.

> **[SUPERSEDED - TWO modes, not three paths]** (user direction 2026-08-19)
> Phase 3 shipped the choice as **query a Lake dataset** or **capture from a
> live source**; manual upload is not a mode, it is the permanently-available
> intake below. "Search" is the MECHANISM for querying a Lake dataset, not a
> separate path - see the note under Phase 3. The Search section below still
> describes the right QUERY (`summarize count() by <discriminator>`); read it as
> the lake-query mode's implementation.

### Search (best evidence)

> **STATUS: DONE (2026-08-20), and RUN LIVE (2026-08-25).** Shipped as
> `queryLakeSamples` + `fetchLakeLogTypeEvents` (usecase), `lake-panel-state`
> (pure) and `LakePanel`, wired from `integrate-screen`. The counts and the
> events are two separate reads on purpose - see the usecase header for why.
>
> It did NOT work when first pointed at a real workspace, and it failed silently
> both ways: the job status was read at the top level when it lives at
> `items[0].status`, and no clock was injected so the poll loop never waited.
> Only an EMPTY dataset could complete in time. Both are fixed, and the end-to-end
> path is now confirmed - `winevt_plwindows` -> 2 log types by `data_source`.
> Details in "Attempt 2026-08-25".

`summarize count() by <discriminator>` over the selected dataset. Returns the
complete log-type list AND per-type volumes. The discriminator field comes from
`selectDiscriminatorField` run over a small sample; Search then enumerates that
field's values at scale. **Capture answers "which field"; Search answers "what
values".**

### Filtered capture (bounded evidence)

> **STATUS: DONE (2026-08-19), core and UI.** `domain/capture-filter`,
> `captureSamples`, `CapturePanel`. Read the two `[SUPERSEDED]` blocks in this
> section before changing any of it.

Chosen source + operator filter, then `splitSamplesByLogType`.

> **[SUPERSEDED - there is no source parameter]** `CaptureParamsReq` has no
> source field. Source selection is a `__inputId` clause INSIDE the filter
> string, so the generated filter must conjoin it:
> `__inputId === "<input>" && /,TRAFFIC,/i.test(_raw)`. The editable filter shown
> to the operator has to include that clause, or editing it silently widens the
> capture to every source. See phase0 doc section 0.2.

**Vendor-derived filter suggestions, as checkboxes** (user direction
2026-08-18). Pre-tick the log types `deriveExpectedLogTypes` says the solution
needs; show the rest unticked but visible. The operator can always edit a filter
before capturing.

Two correctness rules, both learned the hard way and both easy to get wrong:

1. **Case-insensitive, via regex - not `toLowerCase()`.** PAN-OS emits
   `GLOBALPROTECT`, not `GlobalProtect`, so `_raw.includes("Traffic")` silently
   returns zero events, which reads as "this source does not carry that log
   type" - the worst possible failure for a capture filter. Use
   `/traffic/i.test(_raw)`; `_raw.toLowerCase().includes(...)` allocates a
   lowercased copy of every event passing the filter.
2. **Anchor on delimiters, not bare substrings.** `route-value-discriminator.ts`
   already documents why: *"a JSON document would need the bare value as a
   token, which matches anywhere in the event and would route unrelated traffic
   here - a false positive is worse than no fallback"*. `/traffic/i` matches a
   URL, a hostname, a user-agent. PAN-OS syslog is comma-delimited with the type
   at field index 3, so `/,TRAFFIC,/i` costs nothing and kills the false
   positives. Full positional anchoring (`/^[^,]*,[^,]*,[^,]*,TRAFFIC,/i`) is
   brittle against real `_raw`, which carries a syslog priority and header
   before the CSV (`<14>Aug 13 10:49:03 host 1,2026/...`). Comma-bounded is the
   sweet spot.

> **[SUPERSEDED - the anchor is a DELIMITER SET, not a comma]** (2026-08-19,
> shipped as `logTypePredicate` in `domain/capture-filter`)
>
> Rule 2 is right about the danger and wrong about the anchor. The operator picks
> a SOURCE, not a format - so a comma anchor against a pipe-delimited CEF vendor
> matches nothing, which is rule 1's zero-events failure again wearing a
> different hat: an empty capture reads as "this source does not carry that log
> type", an answer rather than an error. The shipped anchor is the SET of
> delimiters the formats this app actually parses use - comma (CSV/PAN-OS), pipe
> (CEF/LEEF), tab (LEEF extension), quote and colon (JSON), equals (KV),
> whitespace, and the line ends:
>
> ```js
> __inputId === "in_syslog" && /(^|[,|\t"':= \r\n])TRAFFIC([,|\t"':= \r\n]|$)/i.test(_raw)
> ```
>
> `/` is excluded ON PURPOSE, and that exclusion is what still kills the false
> positive rule 2 exists for: a URL path like `/api/traffic/list` does not match.
> Pinned in both directions by EVALUATING the generated predicates as JavaScript
> rather than asserting on their text - CSV, CEF, JSON and KV all match; the URL
> and TRAFFICKING do not.
>
> Rule 1 shipped exactly as written, and it is not cosmetic: PAN-OS emits
> `GLOBALPROTECT`, and a case-sensitive test returns zero events.
>
> One warning is emitted, and it checks ONE thing - the edit that costs you:
> deleting the `__inputId` clause, after which the capture runs against every
> source in the group and returns a mixture the operator believes came from one
> place. `captureFilterWarning` deliberately does NOT validate the JavaScript;
> Cribl evaluates the expression, and a filter that fails to compile comes back
> carrying Cribl's own message, which beats a guess from here.

Filter expressions are **generated into the same vendor-knowledge asset as the
packs** (`generate-vendor-packs.mjs`, extended to keep the `data_stream`
dimension it already walks), with hand-verified overrides winning - the same
precedence rule `vendor-mapping-packs.ts` already pins. Not a hand-maintained
second list.

> **[SUPERSEDED - the checkboxes come from the log-type CATALOG, and the
> generated half of it is empty]** (2026-08-19)
>
> The suggestions are not computed here as a second opinion. They are the Phase 2
> recommendation's three tiers, rendered as checkboxes: content-derived types
> (detection and workbook) are PRE-TICKED, vendor-documented ones are offered
> unticked, and an already-provided type is unticked with the reason
> ("capturing again replaces that sample"). Unticking everything captures the
> whole source, which is a legitimate choice - an operator who does not yet know
> what a source sends should be able to look first.
>
> The generator was extended to keep the `data_stream` dimension as planned.
> **[CORRECTED 2026-08-23: its output is no longer empty** - the miner was run
> in df3ad5e and the catalog carries 157 generated packs. The hand-verified
> packs still WIN the per-value dedupe, which is the point; they are no longer
> the whole tier.]
>
> Editing the filter by hand STOPS the checkboxes rewriting it. Silently
> discarding someone's edit is worse than letting the two disagree, and the
> `__inputId` warning still fires either way.

### Manual upload (fallback)

The existing intake path, unchanged. The only path needing no Cribl integration.

### When the splitter finds no discriminator

Name it rather than silently producing one undifferentiated log type. The
failure is already modelled one step later - `route-value-discriminator.ts`
emits a placeholder filter and tells the operator instead of a match-all that
swallows every route. Same failure, earlier.

> **[DONE 2026-08-19, for the capture path.]** A capture whose events share no
> discriminator is FLAGGED rather than presented as one invented log type, and an
> empty capture is returned as a RESULT with both likely causes named - the
> filter matched nothing, or the source is idle - because "no events" is what the
> operator will otherwise read as a fact about their source. Two more things this
> path had to get right and did: the response is read for the THREE shapes the
> platform returns (documented NDJSON, an already-parsed array when the bridge
> decoded it, and a `{count, items}` envelope), and a committed sample goes
> through `tagSampleFromContent`, the SAME content-first parse an upload uses, so
> the format is re-detected from the captured bytes rather than carried over -
> pinned by capturing CEF that the split labelled "unknown" and asserting it
> lands as "cef". A capture and an upload of the same events are
> indistinguishable afterwards, which is the equivalence that made keeping the
> splitter through the browser's removal worthwhile.
>
> A pin written for this caught a real gap in the implementation rather than
> confirming it: `plannedCaptureSamples` skipped splits with zero LINES, but a
> split holding a whitespace-only line - or a partial event caught at the edge of
> the capture window - produced a tagged sample with zero RECORDS. That husk
> satisfies the "samples provided" check while giving the mapping nothing to work
> with. Having lines is not the same as having events; both are checked now.

---

## Phase 5 - volume findings

> **STATUS: DONE (2026-08-23).** Shipped as `LogTypeVolume` +
> `rankUnreferencedByVolume` in `domain/log-type-catalog/merge.ts`, an optional
> `volumes` input to `mergeLogTypeSources`, `eventCount` on `MergedLogType` and
> `RecommendedLogType`, and `volumeWindow` on the recommendation. The counts are
> lifted out of the Lake panel in `integrate-screen`'s `onQuery` handler - the
> panel is unchanged and still receives exactly what it returned - so the query
> that produced them is the one that reports them.
>
> **THE LAST ITEM CLOSED 2026-08-25: events to BYTES.** A volume now reaches the
> operator as a count AND an estimate of what it weighs, because Sentinel bills
> by volume and a count alone leaves them doing arithmetic they have no inputs
> for. `meanEventBytes` (drop-savings) x the Search count, via the single
> `estimatedLogTypeBytes`; the mean is measured off step one's own sample rows,
> per log type, for no extra search job. It renders as "~2.1 GB estimated" beside
> the count on the Lake panel and the recommendation, and is ABSENT - never zero -
> wherever it cannot be computed. Item 4 in both lists below has the detail.
>
> WHAT WAS BUILT TO THE DECISION BELOW, not around it: the number is attached
> and the list is ordered; nothing is flagged, no threshold exists, and no
> headline mentions a volume. Two rules the pins hold and a future change must
> not quietly drop:
>
> - **Unmeasured renders nothing** - not 0, not "unknown". The `eventCount` key
>   is absent rather than undefined, so nothing downstream can print a number
>   nobody measured. A measured zero, which IS an answer, is carried.
> - **Volume ranks WITHIN a tier, never across one.** A vendor-documented feed
>   with 890K events stays below a detection-tier log type with three. The tier
>   says whether you need it; the volume says how much there is. Letting volume
>   cross tiers would dress a catalog entry in a requirement's authority, which
>   is what the tier split exists to prevent.
>
> Matching rows are SUMMED rather than picked between, because they come from
> one `summarize ... by` and therefore partition the window - disjoint sets add
> safely. If they ever come from separate queries, that stops being true.
>
> Events-to-bytes is still absent, deliberately: `estimateDropSavings`'s mean
> bytes/event could multiply a Search count, but that is a second claim (what it
> costs) on top of the measured one (how much there is), and it was not asked
> for. Counts only.

If Search runs, per-log-type counts come back free. Crossing "log types present"
against "log types any enabled detection reads" yields findings of the form
*"GLOBALPROTECT - 890K events/day, no enabled detection consumes it"*, which is
closer to the toolkit's stated purpose than sample selection is.

**Verify before treating this as new work** - `coverage-analysis` may already
cover part of it. It was raised late in planning and was not checked. Out of
scope unless explicitly wanted.

> **[CHECKED 2026-08-20 - it was right to ask. Roughly 70% already exists.]**
>
> **The cross-product IS `compareLogTypeCoverage`'s `unreferenced` field**
> (`domain/coverage-analysis/expected-log-types.ts`): "provided log types that
> matched nothing expected". The other half - what any detection reads - is
> `deriveExpectedLogTypes`. Both are already merged, ranked and ON SCREEN via
> `mergeLogTypeSources` and `LogTypeRecommendation`. The cost premise is stated
> too: `packShapeSummary` already says N log types means 2N routes and 2N
> pipelines. What is missing is a NUMBER attached to it.
>
> **Genuinely missing** (small, in this order):
> 1. `MergedLogType` / `RecommendedLogType` / `LogTypeCoverage.unreferenced`
>    carry no count - `unreferenced` is a bare `string[]`, so there is nowhere
>    to hang 890K.
> 2. `provided` is tagged samples only. Phase 5 needs a SECOND "present" source:
>    what the dataset actually holds, tagged or not.
> 3. A THRESHOLD, and this is a real decision rather than a copy edit.
>    `expected-log-types.ts` deliberately documents `unreferenced` as *"NOT a
>    problem - a vendor emits more than any one solution detects on"*, and the UI
>    says "fine". Phase 5 wants the same set to read as cost. Volume is what
>    reconciles them - 12 events/day unreferenced is fine, 890K is a finding -
>    but somebody has to pick the line.
> 4. ~~No events-to-bytes conversion anywhere. `estimateDropSavings` measures
>    FIELD bytes inside a sample already collected; it has no notion of a daily
>    rate. Its mean-bytes-per-event could be multiplied by a Search count,
>    though, so the pieces exist.~~ **BUILT 2026-08-25** - see the same numbered
>    item in the "Remaining" list below for how, and for what it refuses to
>    estimate. Still no daily rate: the estimate covers the QUERIED WINDOW, which
>    is the only period anything here measured.
>
> **On "no ENABLED detection consumes it" - the wording is reachable, but not
> for free, and BOTH the obvious readings of the code are wrong.**
>
> An investigation reported the claim unprovable, on the grounds that rules come
> from the GitHub repo and carry no enablement state, so it would need a new ARM
> read and new permission surface. Checking that directly: `installedContentState`
> (`usecases/content-install/content-install.ts`) ALREADY issues a paginated
> `GET {scope}/alertRules`. So the read is written and the ARM surface is not new.
>
> But it does not simply work either: that function extracts ONLY
> `properties.displayName`, and it currently has NO production consumer - it is
> exported and tested and called from nowhere. So the honest position is that
> Phase 5's original wording needs the existing read wired up and two more
> fields taken off it (`properties.enabled`, `properties.query`), not a new
> capability.
>
> Two scoping facts that survive regardless:
> - expected log types are derived from ONE SELECTED SOLUTION's repo content,
>   while deployed rules are workspace-wide. Those are different universes and
>   a finding must not silently mix them.
> - until that wiring exists, the strongest honest wording is *"no rule or
>   workbook shipped by THIS SOLUTION filters on it"* - which is a weaker claim
>   than the plan's, and should be written that way rather than overstated.
>
> **The actual blocker is upstream:** Phase 5 has no input until the Lake query
> has a UI consumer. That is Phase 4's remaining half, not Phase 5's gap.
>
> **[UNBLOCKED 2026-08-20.]** That half shipped. `queryLakeSamples` is wired
> through `LakePanel` from `integrate-screen.tsx:1476`, and `LakeLogTypeVolume`
> carries `eventCount` - with `undefined` kept distinct from `0`, because a
> volume of zero is a claim about the data. So gap 2 above ("a SECOND present
> source: what the dataset holds, tagged or not") is answered: the dataset's own
> counts are on screen.
>
> Remaining:
> 1. Counts have nowhere to live once merged - `unreferenced` is still a bare
>    `string[]` and `MergedLogType` has no volume field.
> 4. ~~Events-to-bytes remains absent; `estimateDropSavings`'s mean bytes/event
>    could be multiplied by a Search count, so the pieces exist.~~
>    **BUILT 2026-08-25.** It was assembled from exactly those pieces:
>    `meanEventBytes(savings)` in `drop-savings.ts` divides the measured bytes by
>    the measured events, and `estimatedLogTypeBytes(volume)` in
>    `log-type-catalog/merge.ts` is the ONLY multiplication in the app.
>
>    WHERE THE MEAN COMES FROM, which was the open question: step one of the Lake
>    query. It already pulls up to `DISCRIMINATOR_SAMPLE_LIMIT` real events to
>    decide which field discriminates and then discards their bodies; those rows
>    are now also grouped by that same field and measured, so each log type's mean
>    is drawn from ITS OWN events at the cost of no extra search job. A dataset
>    offered as one log type measures the whole sample, which is the one case a
>    dataset-wide mean is not a substitution.
>
>    THE REFUSALS ARE THE FEATURE. `meanEventBytes` returns undefined for zero
>    events and for zero bytes; `estimatedLogTypeBytes` returns undefined without
>    a count, without a mean, for a non-finite figure, and for a zero mean - so a
>    counted-but-unsampled log type (the skew case) shows its count alone rather
>    than "~0 B". Summing is all-or-nothing: if any summed row lacks a mean the
>    whole estimate goes, because a partial byte total beside a full count
>    under-reports a cost while reading as measured.
>
>    RANKING is a LIST-LEVEL choice - bytes when every measured entry carries an
>    estimate, events otherwise. Mixing the keys per entry would not be a total
>    order, and promoting the estimated entries would rank on how well we measured
>    rather than on what we measured. No threshold was added; the 2026-08-20
>    decision holds.
>
> **THE THRESHOLD - DECIDED 2026-08-20 (user): there is no threshold.**
>
> Attach the volume and RANK by it. Do not render a verdict, do not flag, do not
> call anything a finding. The 890K entry rises to the top of the list on its own
> and the operator draws their own conclusion.
>
> Why this and not a cutoff. This module already documents `unreferenced` as
> "NOT a problem - a vendor emits more than any one solution detects on", and any
> threshold makes the app contradict its own comment on a set it was right about.
> A cutoff is also a claim we cannot support: the line that is obviously correct
> in one tenant is obviously wrong in the next, so it would need defending and
> tuning forever, and every environment where it was wrong would produce a
> confident false finding. Ranking asserts nothing that is not measured. It is
> the same rule the vendor tier already follows - OFFERED, never assumed - and
> the same one behind `eventCount` being optional rather than defaulting to 0.
>
> So Phase 5 is now entirely typing: give the merged types somewhere to carry a
> volume, sort by it, and render the number beside the existing evidence label.
> The wording next to an unreferenced entry stays "no rule or workbook shipped by
> THIS SOLUTION filters on it" - see below.
>
> One thing NOT to lose when this is built: the honest wording is still "no rule
> or workbook shipped by THIS SOLUTION filters on it", because expected log types
> come from one selected solution's repo content while deployed rules are
> workspace-wide. Volume does not make the stronger claim true.

---

## Needs live verification (added 2026-08-20) - ALL EIGHT SETTLED 2026-08-25

> **STATUS: CLOSED 2026-08-25.** Every row below was answered against the lab
> workspace `main-busy-yonath-kz1bxn7`. The table of beliefs is KEPT as written -
> it is the record of what the code was resting on, and the "If wrong" column is
> what made the run worth doing - and the verdicts follow it in a second table.
> Where a belief turned out to be wrong, the second table says so.

Phases 3 and 4 are pinned entirely against `FakeCriblClient`. That catches our
own logic and cannot catch a wrong belief about the platform - every row below
is a belief the code now depends on, ordered by what it costs if wrong.

The case for doing this before shipping is already on the record: `__inputId`
turned out to be `<type>:<id>`, not the bare id `/system/inputs` returns, so the
source clause matched nothing and **every capture would have come back empty** -
reported to the operator as an idle source. Sixty-odd tests were green over it.
It was caught by reading the vendored spec's examples, not by a test.

| # | Belief | Rests on | If wrong |
|---|---|---|---|
| 1 | `__inputId` is `<type>:<id>`, and `.endsWith(":id")` selects the source | Spec examples (`__inputId.startsWith("http:")`, `cribl_http:pan_traffic_syslog`) | Every capture empty, or captures the wrong source |
| 2 | A level-0 capture of a JSON source (Event Hub, HEC, Kafka) carries broken-out fields, not just `_raw` | Spec's own level-0 example filters `sourcetype==="pan:traffic"` | The structured-field OR never fires; those sources still capture nothing |
| 3 | Cribl Search accepts `tostring(field)` in a `where` clause | Standard Kusto; Cribl Search speaks Kusto | Numeric log types 400 instead of returning events |
| 4 | A one-line NDJSON capture response reaches us as a decoded OBJECT | `readPortBody` JSON.parses the whole body | Single-event captures read as empty (the bug we fixed - confirm the fix, not just the diagnosis) |
| 5 | 12s is under the real capture ceiling | `http.ts:47` `timeoutMs = 15000`, minus dispatch headroom | Captures fail blaming the bridge, or we clamp shorter than needed |
| 6 | The Lake dataset listing is a LEADER route, and the managed lake's id is `default` | Phase 0 spike | The Lake mode has no dataset list to offer |
| 7 | Capture needs a permission the app's own credentials hold | Not established | 403 on the primary path |
| 8 | A Cribl filter referencing a field the event lacks is a ReferenceError that DROPS the event | `capture-filter.ts`'s stated model - never tested against the real evaluator | If Cribl tolerates undeclared names, the typeof guards are insurance rather than load-bearing. Either answer is fine; the guess is not |

### The verdicts (observed 2026-08-25, lab workspace `main-busy-yonath-kz1bxn7`)

| # | Verdict | What was actually observed |
|---|---|---|
| 1 | **CONFIRMED**, and the shipped predicate selects the source | 40 of 40 captured events carried `__inputId`. Values seen: `cribl_tcp:in_cribl_tcp_WinEvt_customer`, `syslog:PaloAlto:tcp` (THREE segments), `datagen:paloaltorfc5424`, `cribl:CriblLogs`. The shipped `inputPredicate` matches on the SECOND colon segment, which is why it survives the three-segment form that `.endsWith(":id")` would have missed |
| 2 | **CONFIRMED** | A level-0 capture carries broken-out fields beside `_raw`, not `_raw` alone. The structured-field OR can fire |
| 3 | **CONFIRMED - and this had never run before, in any form** | Cribl Search accepted `tostring()` in a `where` clause. Numeric discriminators do not 400 |
| 4 | **CONFIRMED** | A one-line NDJSON capture response reaches us as a decoded OBJECT, exactly as `readPortBody` implies. The fix is confirmed, not just the diagnosis |
| 5 | **CONFIRMED** | A 10s capture completed inside the ceiling; the 12s clamp has headroom |
| 6 | **CONFIRMED, both halves** | `GET /products/lake/lakes/default/datasets` is a LEADER route and answered with 31 datasets, so the managed lake's id IS `default`. `queryLakeSamples` also ran END TO END: `winevt_plwindows` resolved to 2 log types by `data_source` |
| 7 | **CONFIRMED** | 15 enabled inputs listed and captures succeed on the app's own credential. No 403 |
| 8 | **ANSWERED - Cribl TOLERATES undeclared fields.** The belief as stated was WRONG | Bare and guarded filters BOTH returned events. So the `typeof` guards in `capture-filter.ts` are INSURANCE, not load-bearing, and that module's stated model - "a ReferenceError that DROPS the event" - is the thing that was wrong. **The guards stay.** They are harmless, they are correct, and they cost one `typeof` per clause; what was wrong was the reason given for them, not the code |

**Also established live 2026-08-25, as facts rather than beliefs:**

- **`POST /system/capture` needs a worker.** Against a worker group with no
  connected workers it returns `400 {"message":"No worker nodes are connected to
  this worker group."}`. The capture runs ON a worker, not on the leader, so
  "which group" is really "which group has workers" - see "How to run it".
- **`GET /search/jobs/{id}/status?advanced=true` answers in the Cribl envelope.**
  The status is at `items[0].status` inside `{items:[...], count}`; there is NO
  top-level `status`. A top-level read returns `undefined` on every poll, which
  reads as a job that never finishes.
- **`GET /search/query` is NOT a synchronous route.** See the correction below.
- **24 of the 31 lake datasets are EMPTY over `-24h`**, which is why the suite
  walks the listing instead of taking `entries[0]`: alphabetical order is
  uncorrelated with holding data, and "0 log types" alone cannot tell an empty
  dataset from one whose rows never arrived.

### `GET /search/query` is the job lifecycle with a different door

> **[SUPERSEDED 2026-08-25 - the "SYNC FIRST" framing is FALSIFIED]**
>
> Phase 0 recorded `GET /search/query` as the synchronous route and this plan
> preferred it for its single round trip. Observed live, it is not synchronous:
>
> - without `earliest`/`latest` it **400s**;
> - with them it **CREATES A JOB** and returns
>   `{isFinished:false, job:{id, status:"queued"}}` - no results;
> - re-called with that `jobId` it returns results.
>
> That is the same job lifecycle `POST /search/jobs` drives, entered through a
> different door. There was never a round trip to save, so "prefer the cheap
> route, fall back to jobs" described one lifecycle attempted twice.
>
> **What the wrong premise cost, which is why this is worth the words.** The
> fallback fired on EVERY query and issued its own `POST /search/jobs`, so every
> Lake query ORPHANED a job; the "sync is unusable" verdict was memoized per
> runner and there is one runner per usecase call, so a full operator flow
> (`queryLakeSamples`, then `fetchLakeLogTypeEvents`) orphaned two. Worse, the
> dead route's failure note was unshifted to the FRONT of `notes`, which the Lake
> panel renders under a SUCCESS headline - raw platform error text shown to an
> operator whose query had in fact worked. And its `200 with no rows` was never an
> answer about the data: it was the job sitting in `queued`, every time.
>
> **The route is now DELETED from the product** (2026-08-25), along with its
> `/m/:gid/search/query` grant in `policies.yml`. Polling its `job.id` instead was
> considered and rejected: both doors cost create + poll + read, so keeping the
> GET buys nothing and costs a second create route, a second job-id envelope to
> read (`job.id`, not the `items[].id` the POST answers with), and a second thing
> to keep working - and it is the door Cribl's own UI does not use. One behaviour
> change follows: **an empty answer is now BELIEVED.** With only the proven route
> left, "the job completed and returned no rows" IS an empty window and is
> reported as one - still `ok` with a note, never as a failure. Phase 0's
> "Synchronous? **Yes**" row is corrected in place.

**Cheapest order:** one real capture against a syslog source settles 1, 4 and 5
and 7 at once. One capture of a JSON source settles 2. One Lake query with a
numeric discriminator settles 3 and 6.

`packages/core/src/testing/live-verify.test.ts` runs all eight. It SKIPS unless
`CRIBL_LIVE_BASE` and `CRIBL_LIVE_TOKEN` are set, so the normal gate stays
hermetic.

### How to run it (2026-08-23, corrected 2026-08-25 by doing it)

**Do the traffic step first.** It is the one that sank the 2026-08-20 attempt,
and no amount of fixing the others rescues a run without events: rows 1, 2 and 4
are all observations of a captured event, so an idle source produces an empty
capture that is indistinguishable from a broken filter. Step 2 was added after
the 2026-08-25 run, which had traffic and still could not capture - a group
without workers 400s before a filter is ever evaluated.

1. **Generate traffic through a SYSLOG source**, and leave it running. Check
   Stream Home shows events in AND out before going further - the 2026-08-20
   attempt read zero over 15 minutes. One capture against a live syslog source
   settles rows 1, 4, 5 and 7 together, which is why it is worth the setup.
2. **Pick a worker group that HAS CONNECTED WORKERS.** This is a platform
   precondition, not a preference: `POST /system/capture` against a group with
   none returns `400 {"message":"No worker nodes are connected to this worker
   group."}` before any filter is evaluated. The capture runs on a worker. The
   suite resolves a group with workers on its own and filters on the stream
   TYPE - "not a search group" had been letting edge fleets through - but pin
   one with `CRIBL_LIVE_GROUP` when the workspace has several.
3. **Get a token.** Vault is on an internal address, so this needs the lab
   network. The token is a bearer for the workspace API, not a browser session -
   the suite calls the API directly and does not go through the app's proxy.
4. **Run it:**

```sh
cd soc-optimizationtoolkit
CRIBL_LIVE_BASE=https://<workspace>.cribl.cloud/api/v1 \
CRIBL_LIVE_TOKEN=<bearer> \
CRIBL_LIVE_GROUP=DatacenterEast \
CRIBL_LIVE_DATASET=winevt_plwindows \
npx vitest run --root packages/core src/testing/live-verify.test.ts
```

| Variable | Required? | What it does |
|---|---|---|
| `CRIBL_LIVE_BASE` | **yes** - the suite SKIPS without it | `https://<workspace>.cribl.cloud/api/v1` |
| `CRIBL_LIVE_TOKEN` | **yes** - the suite SKIPS without it | Bearer for the workspace API |
| `CRIBL_LIVE_GROUP` | optional | Pins the CAPTURE group. Without it the suite resolves a Stream group that has connected workers, which is the part that matters |
| `CRIBL_LIVE_DATASET` | optional | Pins the Lake dataset. Without it the suite WALKS the listing (up to 12 datasets, ~1.4s each when empty). Worth setting: 24 of the lab's 31 datasets are empty over `-24h`, so an unpinned walk spends most of its time proving nothing |

Read the `[live-verify]` lines, not just the pass/fail. Each row prints its
verdict AND what it observed, because "row 6: CONFIRMED" is worth nothing
without the count beside it. The Lake row also prints every dataset it walked
and each one's notes - "0 log types" alone cannot tell an empty dataset from one
whose rows never arrived.

5. **Then a JSON source** (Event Hub, HEC, Kafka) for row 2, and **one Lake
   query over a dataset with a numeric discriminator** for rows 3 and 6.

**What a green run does NOT settle.** Row 8 asserts nothing either way by
design; the suite reports what the evaluator did and leaves the conclusion to a
human. (It has since been read: Cribl TOLERATES undeclared fields - see the
verdicts table.) One trap in reading row 8 was itself a defect and is fixed: a
`400` was being read as "Cribl rejected the undeclared field", which is a
verdict about the JavaScript evaluator drawn from a request that never reached
one. The GUARDED request is now the control, and a failed control yields no
verdict at all.

> **[SUPERSEDED 2026-08-25]** This section used to end by telling you to
> "check which `path` the query row reports", on the belief that
> `GET /search/query` was a synchronous route that might simply be
> unimplemented. It is implemented, and it is not synchronous - it creates a job.
> See "`GET /search/query` is the job lifecycle with a different door" above.

### Attempt 2026-08-25 - CLOSED. All eight settled

Run against the lab workspace `main-busy-yonath-kz1bxn7` with a token, Stream
group `DatacenterEast`, Lake dataset `winevt_plwindows`. The verdicts are in the
table above. What it took, recorded because the interesting half is not the
verdicts:

**THE HARNESS WAS ANSWERING FOUR OF THE EIGHT WRONGLY** - each a confident wrong
answer rather than a failure, which is worse, because a red run gets
investigated and a green one does not:

- **Row 1 could never have passed.** It read `__inputId` from
  `extractCapturedEvents`' output, which returns the `_raw` PAYLOAD strings - so
  the capture ENVELOPE, where `__inputId` lives beside `_raw`, was gone before
  the check ran. It had reported "no captured event carried `__inputId`" on every
  run since it was written. It parses the envelope now: 40 of 40.
- **Row 1's id match restated `.endsWith(":" + id)`** - the exact form the
  shipped `inputPredicate` REPLACED on 2026-08-21, because `syslog:PaloAlto:tcp`
  does not end with `:PaloAlto`. It would have failed on any syslog source and
  blamed the platform for a defect the product had already fixed. It now uses the
  shipped rule: the second colon segment.
- **Row 2 looked for four hardcoded field names** and reported "only `_raw` on
  this source" about events carrying sixteen broken-out fields - printing the
  very keys that refuted it. It asks the actual question now: is there anything
  besides the envelope.
- **Row 8 read any 400 as a rejection** of the undeclared field. The guarded
  request is the control now, and a failed control yields no verdict.
- **The control capture took 20 events**, and a busy worker's own internal stats
  events do not all carry `__inputId`, so a small grab came back entirely
  internal. Raised to 50; the duration stays 10s because row 5 pins the clamp
  on it.
- **The Lake row took `entries[0]`** - whichever dataset id sorts first
  alphabetically, uncorrelated with holding data, and 24 of 31 are empty. It
  walks now and reports what it walked.
- **It took the first Stream group**, which in this lab has no connected workers,
  so every capture 400'd on a platform precondition. It resolves a group with
  workers now (`CRIBL_LIVE_GROUP` pins one) and filters on the stream TYPE
  rather than "not search", which had been letting edge fleets through.

**FOUR PRODUCT DEFECTS, all silent.** The first three each stopped the Lake path
on their own; the fourth degraded every query that did work:

1. **The Lake job status was never read.** The poll did
   `readString(poll.body, "status")`, a TOP-LEVEL read, but the live response is
   `{items:[...], count}` with the status at `items[0].status`. The read returned
   `undefined` on all twenty polls, the loop burned its budget, and every Lake
   query reported the job "still pending" - for jobs that were `completed` on the
   FIRST poll.
2. **The shell never injected a clock.** Core reads no clock by design and calls
   `await config.sleep?.(ms)`, so a missing injection is a no-op rather than an
   error: twenty polls fired inside ~4s, measurably shorter than any populated
   dataset takes to search. Only an EMPTY dataset could finish in time - the
   failure mode disguised as a pass.
3. **`data_source` was missing from `DISCRIMINATOR_FIELDS`.** Cribl's Windows
   Event source puts the Windows CHANNEL there, and for Windows events the
   channel IS the log type. Without it the lab's one genuinely security-shaped
   dataset reported NO log types at all and the operator was told to go capture
   from a live source - for data already in their lake, already split, already
   counted:

   ```
   dataset="winevt_plwindows" | summarize count() by data_source
     Microsoft-Windows-DNS-Client/Operational   766,570
     Security                                    22,792
   ```

   It sits in the LOW-CONFIDENCE tail, so a single-channel dataset still reports
   no discriminator rather than claiming the whole dataset is one named type.

4. **The preferred query route was never a query route.** `GET /search/query`
   creates a job, so its "200 with no rows" was the job sitting in `queued` -
   read by the app as disappointment, every single time. The fallback then issued
   its own `POST /search/jobs`, so every Lake query ORPHANED a job and a full
   operator flow orphaned two; and the dead route's failure note was unshifted to
   the FRONT of `notes`, which the Lake panel renders under a SUCCESS headline.
   Operators saw raw platform error text on queries that had worked. The route
   and its `/m/:gid/search/query` grant are both gone - see the correction above.

**What was deliberately NOT added, and this is the more useful half:**
`datatype`, `schemaId` and `source` are on every Lake row and look like obvious
additions. Measured live, each carries exactly ONE distinct value in every
dataset sampled - they describe the DATASET, not the event, so they can never
split one. Pinned negatively so the next reader does not re-derive it.

**A FIFTH DEFECT, found in the same run and fixed 2026-08-25: for most real
datasets the Lake mode yielded NOTHING.** Not a failure - a dead end, which is
harder to notice because every gate was green and every sentence on screen was
true. Of the 31 datasets in the lab lake, 24 held no events over -24h and only
ONE of the populated remainder yielded a discriminator. `winevt_dcronly` (1,216
events, a single Windows channel) and `azure_alerts_validation` (265) are
single-log-type BY DESIGN: the data is already split per dataset, which is how
people organise a lake. Each of them was answered with "No field on these events
distinguishes one log type from another ... capture a sample and name the log
type yourself instead" - the app sending the operator to a DIFFERENT acquisition
mode for data sitting in front of it, already named by the dataset itself.

What was wrong was the inference, not the observation. A populated dataset that
nothing splits holds ONE log type, so:

- Step two still runs, without its `by` clause: `dataset="X" | summarize
  eventCount=count()`. One extra job, exactly what the grouped form costs, so
  the two-jobs-per-query budget is unchanged. The count could NOT come from step
  one's rows - those are capped at `DISCRIMINATOR_SAMPLE_LIMIT`, so a
  1,216-event dataset would have reported 500, a measurement of our own bound.
- The log type is named after the DATASET, and `datasetAsLogType: true` says so
  all the way to the panel, which prints the caveat beside the row. The app does
  not get to claim a vendor log type it never observed - the same rule that
  keeps `data_source` in the low-confidence tail.
- The commit path took the field as optional: no field means no `where` clause
  and the whole dataset is fetched, which is only addressable for ONE log type.
  Asking for several with no field is refused rather than served, because the
  unfiltered query answers identically for each and would write the same events
  into the store under names nobody observed.
- EMPTY and SINGLE-LOG-TYPE are pinned side by side, in core and in the panel.
  They rendered as the same dead end before, and they are opposite facts.

A lost count costs the number and never the offer: `ok` stays true, the volume
stays undefined rather than becoming a zero, and the sample is still takeable.

**A SIXTH DEFECT, reported from the live app 2026-08-25: the group with NO
discriminator value was reported and then discarded.** Querying the Lake dataset
`PaloAlto` answered "13 log types in PaloAlto, highest volume first" and then "1
group carried no msgid value and was left out". `summarize count() by msgid`
returns a group for the events that carry no msgid, with a real count - and
`readGroupValue` collapsed that group's key into the same `undefined` it used for
a key it could not read at all, so the row was dropped. Reported beats silent,
but those events then had no route to becoming a sample: nothing could shape
them, and in the generated pack they would arrive unshaped.

It is the fifth defect's bargain one level down, and it is resolved the same way:

- The group is OFFERED as a row of its own, with the platform's `summarize`
  count. Several value-less groups (an engine may return `null` and `""`
  separately) fold into ONE row and their counts sum, because one filter selects
  all of them. If any part of that sum came back unreadable the whole count stays
  undefined - a partial total understates the events it speaks for, which is the
  same all-or-nothing rule `merge.ts` keeps for summed bytes.
- It is NAMED `(no msgid)` - minted from the FIELD, never read out of the data -
  and `LakeLogTypeVolume.unnamed` says so per row, all the way to the caveat the
  panel prints beside it. This is the harder case than the dataset-named row: it
  sits IN a list of twelve names the data really did supply, so an uncaveated
  label reads as a thirteenth vendor log type.
- The byte estimate follows the standing rule untouched: measured from that
  row's OWN sampled events when step one held any, absent otherwise.
- Ambiguity is REFUSED rather than resolved. If a real log type in the dataset is
  already spelled `(no msgid)`, no row is minted - two rows sharing one name
  would send the fetch, which recognises the pick BY its name, after the wrong
  events.
- **The fetch filter is grounded in the spec, not guessed.**
  `where tostring(field)=="value"` cannot express "there is no value": every
  literal IS a value. The vendored `cribl-openapi.json` attests exactly one
  null-ish Kusto predicate for Cribl Search - `isnotempty(vendor)`, as a dataset
  ruleset's `kustoExpression` - alongside `| where <expr>`, `field == "literal"`
  and the bare literal `false`. So the filter is `isnotempty(msgid)==false`,
  built from those forms alone. `isempty`, `isnull` and `not()` appear NOWHERE in
  the spec and are not used. The obvious alternative - excluding the known values
  with `!in` - is unattested AND semantically wrong: Kusto's null comparisons are
  not true, so the null key would be filtered out by the very predicate meant to
  select it, returning nothing while looking right.
- **And the filter is CHECKED rather than trusted**, because a composition of
  attested atoms is still a query no one here has run. `fetchLakeLogTypeEvents`
  reads the rows that come back and refuses the haul if any of them DOES carry a
  value in that field. All three outcomes are then honest: Cribl rejects the
  filter and the existing failure path names the HTTP error; Cribl accepts it and
  means something else, and the note says so; or it works. An empty answer for
  this row is reported as AMBIGUOUS - unlike every other log type, where empty
  just means the window holds none of it - and the count the operator has on
  screen is what tells the two apart.

Still unverified against a live workspace: whether Cribl Search accepts
`isnotempty(field)==false`. The check above is what makes shipping it safe
without that answer.

### Attempt 2026-08-20 - blocked, with two things settled anyway

Tried against the lab workspace through the browser rather than a token. What
came out of it:

- **CONFIRMED live:** `GET /api/v1/m/{groupId}/system/inputs` answers 200. The
  group-scoped addressing this app uses for inputs is right.
- **NOTED:** the Cribl UI reaches groups via `/api/v1/products/stream/groups/{id}`
  (the spec's normalized form) where `listGroups` uses the classic
  `/master/groups`. Both are documented as coexisting; not a defect, but if
  `/master/groups` ever 404s, this is the first thing to try.
- **Corroborating only:** the UI labels a source `cribl_tcp:in_cribl_tcp` -
  the `<type>:<id>` shape row 1 asserts. That is a UI label, NOT an observation
  of `__inputId` on an event, so row 1 stays unverified. *(Settled 2026-08-25 by
  reading `__inputId` off 40 captured events - see the section above. The label
  was right, and it was also incomplete: `syslog:PaloAlto:tcp` has THREE
  segments.)*

What blocked it, so the next attempt does not repeat it:

1. The stored Cribl token had expired, and Vault is on an internal address that
   is unreachable without the lab network.
2. The Sources page does not render in either worker group that has workers -
   it spins indefinitely while its own inputs API returns 200. That page is the
   way into the UI's Live Data capture, which was the no-token route.
3. Stream Home reported no events in or out over 15 minutes. If that is real
   rather than the same rendering fault, a capture returns nothing whatever
   else is fixed, and rows 1, 2 and 4 stay inconclusive. **Generate traffic
   before the next attempt.**

The token route avoids 2 entirely: the suite talks to the API and never touches
the UI.

> **[CLOSED 2026-08-25.]** The token route was taken and it did avoid 2. Blocker
> 3 was real rather than a rendering fault, and generating traffic first was the
> right instruction - but it was not sufficient on its own: the group the suite
> picked had no connected workers, so captures 400'd on a precondition before any
> event mattered. "Generate traffic" and "pick a group with workers" are two
> requirements, and only the first was written down.

---

## Open assumptions

Flagged during planning, not contradicted, but never explicitly confirmed:

- Capture filter expressions are generated into the vendor-knowledge asset
  rather than hand-maintained.
- An operator can always edit a suggested filter before capturing.
- The recommendation is per-solution (start from the chosen Sentinel solution,
  work outward). Starting from what Cribl receives and working toward Sentinel
  is a different product - closer to "here is what you could onboard".

## Model note

Planned on Claude Opus 5 and recommended to stay there. Claude Fable 5's safety
classifiers target most cybersecurity content, and this corpus is firewall, EDR,
GlobalProtect auth and proxy telemetry - the docs are explicit that benign
security tooling can trip false positives. Fable also requires 30-day data
retention (unavailable under ZDR) and costs 2x ($10/$50 per MTok vs $5/$25).
