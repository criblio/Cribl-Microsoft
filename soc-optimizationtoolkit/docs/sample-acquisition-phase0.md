# Phase 0 findings - the three unknowns, answered

Executed 2026-08-18 against [sample-acquisition-plan.md](sample-acquisition-plan.md)
Phase 0. Two of the three are answered from authoritative sources; one has a
residual live-API gap that is named precisely below rather than guessed at.

Sources: the vendored `packages/core/assets/cribl-openapi.json` (Cribl's
official spec, 517 paths), `apps/cribl-app/config/policies.yml`, and a live
read of the parsing/intake code.

**Verdict: Phases 1, 2 and 4-capture are buildable. Phase 4-Search and Phase 3's
dataset half carry one live-verification gate (0.1b).** Nothing found here
contradicts the plan's direction; two details change, both recorded below.

---

## 0.1 - Cribl Search / Lake API

**Answer: the API exists, both sync and async, and dataset listing exists.**
The toolkit's "Search is an architecture concept only" note is about the
*toolkit*, not the platform - the platform surface is fully specced.

| Question | Answer | Where |
|---|---|---|
| List Search datasets? | Yes - `GET /search/datasets` | spec, tag `datasets` |
| Federated datasets? | Yes - `GET /search/federated_search/engines` | spec |
| List Lake datasets? | Yes - `GET /products/lake/lakes/{lakeId}/datasets` | spec, tag `lake` |
| Run a query? | Yes, two ways (below) | spec, tags `query` / `search` |
| Synchronous? | **Yes** - `GET /search/query` returns results directly | spec |
| Auth? | Platform-injected; the app sets no headers | `adapters.ts:479` |
| Permission? | Declare the path in `config/policies.yml` | same-PR contract |

**Synchronous path (what Phase 4's Search option should use):**
`GET /search/query?query=<kql>&earliest=-24h&latest=now` returns
`application/x-ndjson` (`SearchJobResults`) in the response body. No job
polling. This is the cheap one.

**Async path:** `POST /search/jobs` (`CreateSearchJobSchema`: `query` required,
plus `earliest`/`latest`/`timezone`/`sampleRate`) then
`GET /search/jobs/{id}/status` and `GET /search/jobs/{id}/results`.

Every `/search/*` operation is marked **"(Cribl.Cloud only)"** in the spec.
That is not a constraint for us - ADR 0002 already made this app Cribl.Cloud
single-target.

**NDJSON, not JSON.** `/search/query` and `/system/capture` both answer
`application/x-ndjson`. `readPortBody` (`adapters.ts:73`) does `JSON.parse` and
falls back to the raw text on failure, so an NDJSON body arrives at the port as
a **string** that the caller must split by line. Do not `JSON.parse` it whole.

**A Lake route the app already uses:** `POST /system/lake/datasets`, a LEADER
route with no `/m/` prefix, is pinned at `wire-source.ts:33`
(`LAKE_DATASETS_API_PATH`) and declared in `policies.yml`. It is *not* in the
vendored spec - it is a real route the codebase established for Unit 20's Lake
dataset create. Its GET is the obvious candidate for listing Lake datasets from
the app, and is a cheaper first probe than the specced
`/products/lake/lakes/{lakeId}/datasets` (which needs a `lakeId` we do not have).

### 0.1b - the one live gate

**Unresolved: does `/search/*` need a Worker Group context?** The spec declares
paths without prefixes and its `servers` is bare `/`, so it is silent. The
`cribl-api` skill's lab evidence uses the classic proxy form
`/m/default_search/search/jobs`. So the call is either

- `GET /search/query` (leader-level, like `/system/lake/datasets`), or
- `GET /m/{searchGroupId}/search/query` (group-level, like `/system/inputs`).

This cannot be settled from the spec, and this session has no Cribl.Cloud
credentials. **It is one GET against a live workspace to settle.**

Good news: finding the Search group id needs no new code.
`deriveGroupProduct` (`ports/cribl-client.ts:88`) already returns `"search"` for
a Search group - from the `type` discriminator or the deprecated `isSearch`
boolean. `listGroups()` returns every group; only the *UI pickers* filter to
Stream via `isStreamWorkerGroup`. So a Search-group lookup is a filter change,
not a new fetch.

**Risk if it goes the wrong way: none to the schedule.** Both forms go through
the same `CriblClient.request({path, groupId?})` seam. The difference is one
`groupId` argument and one line in `policies.yml`.

---

## 0.2 - Capture API

**Answer: it exists, and the regex assumption holds - but the plan's mental
model of source selection is wrong.**

`POST /system/capture` (spec tag `preview`), body `CaptureParamsReq`:

| Field | Meaning |
|---|---|
| `filter` | **JavaScript expression** evaluated per event; omitted = capture everything |
| `level` | 0 = at the source, before pipelines (what we want for raw vendor bytes) |
| `maxEvents` | default 100, **max 10000** |
| `duration` | seconds to hold the capture open, default 5 |
| `workerId`, `workerThreshold`, `stepDuration` | worker fan-out controls |

Response: `application/x-ndjson`, a stream of `CapturedEvent`. Bounded by
`maxEvents` and `duration`, so the request terminates on its own.

### The correction: there is no source parameter

`CaptureParamsReq` has **no source / input field**. Source selection is part of
the filter expression, via the `__inputId` event field. The spec's own
`CaptureExamplesComplexFilter` shows it:

```js
__inputId.startsWith("http:") && status >= 400 && status < 500
```

The plan's Phase 4 reads *"Chosen source + operator filter"* as two inputs. In
the API they are one string. That does not change the UI - the operator still
picks a source from a dropdown and edits a filter - but the composed request is

```js
__inputId === "<selected input id>" && /,TRAFFIC,/i.test(_raw)
```

so the generated filter must **conjoin the source predicate with the log-type
predicate**, and the editable filter shown to the operator has to include the
`__inputId` clause or editing it will silently widen the capture to every
source. That is the same class of failure the plan's rule 1 warns about.

### The regex question: confirmed as far as a spec can confirm it

The plan asks whether `/traffic/i.test(_raw)` works in a Cribl filter. The spec
describes `filter` as *"JavaScript expression evaluated against each event"*, and
its own examples call JavaScript methods (`.startsWith(...)`). A regex literal
with the `i` flag is ordinary JavaScript. **No evidence of a restricted
expression subset anywhere in the spec.**

Residual risk: low, but it is the same one live call as 0.1b to be certain, and
it should be made with the *anchored* form the plan mandates (`/,TRAFFIC,/i`),
not the bare one.

**Permission:** `/m/:gid/system/capture` needs a `POST` entry in
`policies.yml`. It is the first *write-shaped* product-API path this app would
add for a read-only purpose - worth a sentence in the install-time policy
comment, since admins read that list.

---

## 0.3 - Does the upload path preserve CEF/LEEF raw lines?

**Answer: NO. And the second half of the question is moot - the code it asks
about is already dead.**

### Raw lines are not preserved

`parseSampleContent` (`parse-sample.ts:240`) builds `rawEvents` as

```ts
const rawEvents = records.slice(0, RAW_EVENTS_CAP).map((r) => JSON.stringify(r));
```

- always a re-serialization of the parsed record, never the original bytes.
`buildTaggedSample` (`sample-intake-state.ts:179`) stores exactly that. So every
uploaded or pasted sample carries JSON in `rawEvents`, whatever its input format.

Only `splitRepoFile` (`repo-samples.ts:400,428,486`) keeps the original line, by
holding `content.split("\n")` alongside the parse and indexing into it - and that
is on the path being deleted.

**A stale comment to fix while we are here.** `rawPreviewLines`
(`sample-intake-state.ts:144`) documents its return as *"the ORIGINAL vendor
bytes when the sample was a non-JSON format"*. That has never been true on the
intake path. It is the kind of comment that makes the next person skip the check.

### What actually breaks, per format

The damage is narrower than the plan assumes, because `generateSampleFile`
(`pack-assembly/sample-file.ts:195`) already compensates for one format:

| Input format | `rawEvents` holds | Pack `_raw` ends up as | Verdict |
|---|---|---|---|
| CEF | JSON of parsed fields | a **reconstructed** `CEF:...` line, via `reconstructCefLine` | works, lossily |
| LEEF | JSON of parsed fields | the JSON object | **broken** |
| Syslog | JSON, with the original line nested under `_raw` | the JSON object | **broken** |
| Headerless CSV (PAN-OS) | JSON of exploded columns | the JSON object | **broken** |
| Cribl capture wrapping any of the above | JSON of the *unwrapped inner* fields | the JSON object | **broken, and worst** |

CEF survives because `reconstructCefLine` rebuilds the header and extension from
the parsed object. It is lossy - it drops `_syslogHeader`, drops empty-valued
extension keys, and emits extension order as parsed rather than as sent - but a
CEF pipeline can still parse the result.

LEEF has no equivalent reconstruction, and `reconstructCefLine` returns `null`
for it (no `CEFVersion`), so a LEEF pack ships JSON in `_raw`. Same for syslog
and for headerless PAN-OS CSV.

The capture-wrapped case is the worst and the most likely: `unwrapCapture`
(`parse-sample.ts:262`) **replaces** the wrapper records with the inner parse, so
the `_raw` the operator's own Cribl capture handed us is discarded outright.

**This is a live defect on the path we are keeping**, not a browse-path
regression risk. It is the reason the salvage in Phase 1 is worth doing - but the
right fix is at `parseSampleContent`/`buildTaggedSample`, so every intake path
gets it, rather than porting `splitRepoFile`'s line-index trick.

### `consolidateByTableRouting` is dead code

`resolveRepoSamples` consolidates only when `options.eventToTable` is non-empty
(`repo-samples.ts:611-618`). Both call sites -
`acquire-samples.ts:254` and `:348` - call it with **two arguments**:

```ts
repo = resolveRepoSamples(solutionName, gathered.candidates);
```

so `options` is `{}`, `hasSolutionTables` is false, and the consolidation branch
has never executed in this codebase. Its only exercise is its own unit test.

**Consequence for Phase 1:** the plan's warning that *"losing the second means a
CrowdStrike upload fragments across destination tables instead of
consolidating"* describes a capability the app does not currently have. Deleting
`consolidateByTableRouting` costs nothing that works today. If per-table
consolidation is wanted, it is new work with a new caller - and it should be
scoped as such, not smuggled in as a salvage.

---

## What changes in the plan

1. **Phase 4 capture**: source selection is a `__inputId` clause inside the
   filter string, not a separate field. The suggested filter must conjoin it.
2. **Phase 1 salvage**: raw-line preservation is a real fix and should land in
   `parseSampleContent`, covering LEEF, syslog, headerless CSV and
   capture-wrapped input - not just CEF, which already half-works.
3. **Phase 1 salvage**: `consolidateByTableRouting` needs no salvage. It is
   unreachable. Delete it with the module and record it as a deleted capability.
4. **Phase 3/4 Search**: one live GET decides leader-vs-group addressing. Until
   then, build behind `CriblClient.request({path, groupId?})`, which absorbs
   either answer.
