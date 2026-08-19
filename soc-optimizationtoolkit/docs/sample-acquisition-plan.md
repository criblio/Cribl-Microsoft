# Sample acquisition plan - replacing the browser with a log-type recommendation

**START HERE. This is the only document you need to execute this work.**
[ADR 0003](adr/0003-remove-sample-browser.md) is the durable decision record and
is worth reading if you want the full argument - but everything required to do
the work is below, including the reasoning you need to avoid undoing it.

Written 2026-08-18 by a planning session, from a live read of the code.

> **EXECUTION STATUS (2026-08-19), branch `feature/log-type-recommendation`,
> PR #119:** **Phases 0, 1, 2 and 3 are done.** Phases 4-5 are not started.
>
> Phase 3 shipped as `discoverSampleSources` (usecase), `domain/sample-sources`
> (pure inventory) and `SampleSourcePicker` (UI). It DISCOVERS and lets the
> operator choose; it acquires nothing - that is Phase 4, which now has a
> selected `SampleSourceRef` to act on.
>
> Phase 0's answers are in **[sample-acquisition-phase0.md](sample-acquisition-phase0.md)**
> and they change four things written below. Read that document before Phase 3;
> the corrections are marked inline here as **[SUPERSEDED]**.
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
| PAN-OS: 8 log types + documented column order, cited to vendor docs | `domain/sample-parsing/panos-dictionary.ts` |
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

`summarize count() by <discriminator>` over the selected dataset. Returns the
complete log-type list AND per-type volumes. The discriminator field comes from
`selectDiscriminatorField` run over a small sample; Search then enumerates that
field's values at scale. **Capture answers "which field"; Search answers "what
values".**

### Filtered capture (bounded evidence)

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

Filter expressions are **generated into the same vendor-knowledge asset as the
packs** (`generate-vendor-packs.mjs`, extended to keep the `data_stream`
dimension it already walks), with hand-verified overrides winning - the same
precedence rule `vendor-mapping-packs.ts` already pins. Not a hand-maintained
second list.

### Manual upload (fallback)

The existing intake path, unchanged. The only path needing no Cribl integration.

### When the splitter finds no discriminator

Name it rather than silently producing one undifferentiated log type. The
failure is already modelled one step later - `route-value-discriminator.ts`
emits a placeholder filter and tells the operator instead of a match-all that
swallows every route. Same failure, earlier.

---

## Phase 5 - volume findings (flagged, not scoped)

If Search runs, per-log-type counts come back free. Crossing "log types present"
against "log types any enabled detection reads" yields findings of the form
*"GLOBALPROTECT - 890K events/day, no enabled detection consumes it"*, which is
closer to the toolkit's stated purpose than sample selection is.

**Verify before treating this as new work** - `coverage-analysis` may already
cover part of it. It was raised late in planning and was not checked. Out of
scope unless explicitly wanted.

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
