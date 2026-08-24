# ADR 0003: Remove the sample browser; recommend log types from the operator's own environment

Date: 2026-08-18
Status: Accepted; EXECUTED in full 2026-08-23 (all phases 0-5, PR #119).
        Not yet verified against a live workspace - see the plan's
        "Needs live verification" table and live-verify.test.ts.

> **To DO this work, read [sample-acquisition-plan.md](../sample-acquisition-plan.md)
> instead.** That document is self-contained: verified file:line facts, the
> phases, the deletion list, and the traps. This ADR is the decision record -
> read it for the full argument, or when you are tempted to reverse the decision.

## Context

The Integrate flow offers a Browse Samples modal that finds sample files for the
selected Sentinel solution. It does not work the way its surface implies.

`scoreFileName` (packages/core/src/domain/sample-acquisition/repo-samples.ts:278)
is the entire selection mechanism:

```ts
const fileLower = fileName.toLowerCase().replace(/[^a-z0-9]/g, "");
for (const kw of keywords) {
  if (kw.length < SHORT_KEYWORD_MIN) continue;
  if (fileLower.includes(kw)) score += kw.length;   // filename only
}
```

Keywords come from `buildSampleKeywords(solutionName)` - the solution's own words
plus ~70 vendor abbreviations. **The file is never opened.** Files scoring >= 8
survive. So "this sample belongs to this solution" means "its filename contains
part of the vendor name".

There is exactly one content check, `detectPreIngested` (3+ Sentinel schema
markers => already-transformed data, drop). It only ever REJECTS. Nothing
confirms a sample actually fits.

The consequence the user reported: the browser presents many files per vendor,
most of which are wrong for the selected solution, and the operator cannot tell
which. It complicates the flow and causes confusion.

### The path considered and rejected

The first design explored was to make the fit check real: audit every sample
against (a) vendor documentation describing each log type's raw fields, and (b)
the columns of the tables that specific solution writes to, then present only the
samples that fit. The machinery for (b) already exists - it is the gap analysis
(`resolveDestinationTables`, `matchParsedSampleToColumns`, `triageOverflow`), and
the 2026-08-18 pairing warning is that verdict rendered one screen too late.

That path was rejected. It is real work to make a browser trustworthy that
should not exist: even a correct fit check still hands the operator someone
else's data as the starting point for their own integration.

Note for anyone tempted to revive it: `vendor-mapping-packs.ts` already records
why per-solution vendor knowledge is too coarse -

> Log-type-AMBIGUOUS fields are deliberately absent from packs (e.g. Zscaler's
> `proto` means HTTP_PROXY in web logs but TCP in firewall logs); those stay
> with the alias ladder.

The repo hit the log-type problem and worked around it by dropping the ambiguous
fields. PAN-OS is the one vendor that got the real treatment
(`panos-dictionary.ts`: eight log types, documented column order each, cited to
the Palo Alto syslog field-descriptions page). That shape is right; it exists
once.

## Decision

Remove the sample browser. Samples come from the operator, deliberately named.

In its place, **recommend which log types to provide**, derived from the
operator's own environment rather than from a corpus of other people's files.
Three acquisition paths, operator-chosen:

1. **Cribl Search** over a Lake dataset or a federated Search dataset -
   enumerates the distinct log types a source actually produces, with volumes.
2. **Filtered capture** from a Cribl source, with a user-supplied filter and
   vendor-derived filter suggestions.
3. **Manual upload** with naming - the fallback, and the only path that needs no
   Cribl integration.

The recommendation of WHICH log types to provide comes from
`deriveExpectedLogTypes` (domain/coverage-analysis/expected-log-types.ts), which
already recovers the vendor log types a solution's detections discriminate on
(`where DeviceEventClassID == "TRAFFIC"`). Its own header states the reason this
is the right source:

> decodeConnector yields the DESTINATION TABLE (Palo Alto resolves to
> CommonSecurityLog, one entry), which says nothing about Traffic vs Threat vs
> Config.

### Why Search rather than capture alone

A capture is time-bounded. Capture 100 events from a PAN source at 2pm and you
get what flowed at 2pm - TRAFFIC, probably THREAT. CONFIG changes, SYSTEM,
HIPMATCH will not be there, and the app would conclude the source does not carry
them. That is the exact wrong conclusion: **a rare log type whose detection
silently never fires is the failure this toolkit exists to prevent.**

Search queries data at rest across a time range and returns cardinality as well
as presence. Capture answers "what is flowing now"; Search answers "what does
this source produce". Both are offered because not every customer has a
searchable dataset, and each is labelled for what it is.

A FILTERED capture is a different instrument from a blind one - it confirms a log
type there is reason to expect rather than hoping it appears in the window - so
capture remains useful even where Search is unavailable.

## What this decision does NOT do

- **It does not remove the splitter.** `splitSamplesByLogType`
  (domain/sample-acquisition/splitting.ts:64) separates a mixed stream by
  discriminator, and its only current caller is `precedence.ts` on the browse
  path. It is load-bearing for ANY mixed input - a capture or a mixed upload -
  and must survive. A naive "delete the sample-acquisition domain" removes it.
- **It does not remove sample intake.** `SampleIntakeSection` (675 lines) is
  already the foundation: upload, paste, content-based format detection, CSV
  header resolution, per-log-type chips, rename-with-re-keying. The browse modal
  was bolted onto it in Unit 16, not the reverse.
- **It does not remove the vendor knowledge.** `PANOS_LOG_TYPES`,
  `DISCRIMINATOR_FIELDS`, and the generated vendor packs gain a new consumer -
  capture-filter suggestions - rather than losing their old one.
- **It does not make the recommendation authoritative.**
  `expected-log-types.ts` is explicit that it is a lower bound, never a vendor
  catalog, and that an empty result must read as "nothing to compare against"
  and never as "you have everything". The panel stays advisory.

## Consequences

- **There is no longer a zero-effort path to a sample.** An operator evaluating
  the toolkit without their own data cannot get to a gap analysis. That is the
  real cost of this decision and it is accepted deliberately: a fast path to the
  wrong sample was worse than a slower path to the right one.
- **Cribl Search and Lake become product dependencies for the best experience.**
  The toolkit already recommends this architecture (`architecture-patterns.ts`
  ships a `Cribl Lake` resource, a `Cribl Search` resource, and the
  `cribl-lake-tiering` pattern). It will now also consume it. Customers without
  a searchable dataset fall back to capture, then upload.
- **Two capabilities must be salvaged before deletion**, both currently living
  only on the browse path: CEF/LEEF raw-line preservation (repo-samples.ts:400,
  428, 486 - "the pack needs the raw line in `_raw`, not the parsed JSON") and
  `consolidateByTableRouting` (repo-samples.ts:505). If the upload path lacks
  either, deleting `repo-samples.ts` silently costs uploads their raw fidelity
  and fragments CrowdStrike events across tables.
- **The Sentinel-repo sample corpus stops being a dependency.**
  `REPO_SAMPLE_DATA_DIRS`, `SOLUTION_SAMPLE_MAP` and the ~70-entry
  `ABBREVIATIONS` list retire with the browser.
