# Phase 0 findings - the three unknowns, answered

Status: Record - the phase 0 verification, answered 2026-08-19 and re-run live 2026-08-25.

Executed 2026-08-18 against [sample-acquisition-plan.md](sample-acquisition-plan.md)
Phase 0. Two of the three are answered from authoritative sources; one has a
residual live-API gap that is named precisely below rather than guessed at.

Sources: the vendored `packages/core/assets/cribl-openapi.json` (Cribl's
official spec, 517 paths), `apps/cribl-app/config/policies.yml`, and a live
read of the parsing/intake code.

**Verdict: all of Phases 1-5 are buildable.** The one live gate (0.1b) was
answered on 2026-08-19 against a real Cribl.Cloud workspace - `/search/*` is
group-scoped. Nothing found here contradicts the plan's direction; two details
change, both recorded below.

> **STATUS (2026-08-20).** Findings 0.2 and 0.3 have since been acted on and
> both have `[SUPERSEDED]` blocks in place: the capture path shipped (0.2, with
> a deliberate departure on the filter anchor) and the raw-line defect was fixed
> (0.3, which also turned up a second parsing defect recorded there). 0.1's
> synchronous `/search/query` is still spec-only - the lake-query path is being
> built now.
>
> **STATUS (2026-08-25) - EVERY REMAINING SPEC-ONLY CLAIM HERE IS NOW LIVE, AND
> ONE OF THEM WAS WRONG.** All eight beliefs in the plan's "Needs live
> verification" table were settled against the lab workspace
> `main-busy-yonath-kz1bxn7`. The correction that lands in this document:
> **`GET /search/query` is NOT synchronous** - it creates a job. The 0.1 table
> row and the "Synchronous path" section below are corrected in place. The
> regex/JavaScript-evaluator assumption in 0.2 held, and the capture path ran.

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
| Synchronous? | ~~**Yes** - `GET /search/query` returns results directly~~ **NO.** Corrected 2026-08-25: it CREATES A JOB. See below | spec, falsified live |
| Auth? | Platform-injected; the app sets no headers | `adapters.ts:479` |
| Permission? | Declare the path in `config/policies.yml` | same-PR contract |

**Synchronous path (what Phase 4's Search option should use):**
`GET /search/query?query=<kql>&earliest=-24h&latest=now` returns
`application/x-ndjson` (`SearchJobResults`) in the response body. No job
polling. This is the cheap one.

> **[SUPERSEDED 2026-08-25 - THERE IS NO SYNCHRONOUS PATH. This was the one
> claim in this document that the live run falsified.]**
>
> Read from the spec, `GET /search/query` looked like a single round trip that
> returns results in the body. Called against a real workspace it behaves like
> this:
>
> - **without `earliest`/`latest` it 400s.** They are not optional.
> - **with them it CREATES A JOB** and returns
>   `{isFinished:false, job:{id, status:"queued"}}`. No results.
> - **re-called with that `jobId` it returns results.**
>
> So it is the SAME job lifecycle as `POST /search/jobs`, entered through a
> different door - not a cheaper alternative to it. "No job polling" is wrong;
> "this is the cheap one" is wrong. The right mental model is one lifecycle with
> two entry points, and its `200 with no rows` is not an answer about the data -
> it is the job sitting in `queued`.
>
> **The route has been DELETED from `queryLakeSamples`** (2026-08-25) and its
> `/m/:gid/search/query` grant WITHDRAWN from `policies.yml`. Trying it first was
> not free: the fallback fired on every query and created a SECOND job, so every
> Lake query orphaned one and a full operator flow orphaned two, and the dead
> route's failure note was rendered to the operator under a success headline.
> Polling its `job.id` instead would have been correct but pointless - both doors
> cost create + poll + read - so what remains is the lifecycle Cribl's own UI was
> observed running. Item 4 of "What changes in the plan" below still recommends
> preferring the sync route; it is corrected there.

**Async path:** `POST /search/jobs` (`CreateSearchJobSchema`: `query` required,
plus `earliest`/`latest`/`timezone`/`sampleRate`) then
`GET /search/jobs/{id}/status` and `GET /search/jobs/{id}/results`.

> **[LIVE DETAIL, 2026-08-25 - the status is in an ENVELOPE.]**
> `GET /search/jobs/{id}/status?advanced=true` answers in Cribl's standard
> `{items:[...], count}` shape, and the status is at **`items[0].status`**. There
> is NO top-level `status`. This is not a nicety: the app read it at the top
> level, got `undefined` on all twenty polls, and reported every Lake job "still
> pending" - including jobs that were `completed` on the first poll. Fixed in
> `readJobStatus`, which mirrors the `readJobId` helper that had been handling
> the same envelope correctly two functions away.

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

> **[ANSWERED LIVE 2026-08-25 - the `lakeId` we did not have is `default`.]**
> `GET /products/lake/lakes/default/datasets` is a LEADER route (no `/m/` prefix)
> and answered with **31 datasets** in the lab workspace. So the specced path is
> usable directly and no probe of the undocumented one was needed. One number
> worth carrying: **24 of those 31 are EMPTY over `-24h`**, which is why anything
> walking this listing must report which datasets it walked - "0 log types" alone
> cannot tell an empty dataset from one whose rows never arrived.

### 0.1b - RESOLVED 2026-08-19: `/search/*` is GROUP-scoped

**Answer: `/m/{searchGroupId}/search/...`, and the group is `default_search`.**

Verified live, not inferred: Cribl's own Search UI was opened in a browser
against a real Cribl.Cloud workspace and its network calls read off. Every
Search call carries the `/m/` prefix, while the app shell's own calls do not:

```
GET  /api/v1/version                                          <- leader, no prefix
GET  /api/v1/system/settings/git-settings                     <- leader, no prefix

GET  /api/v1/m/default_search/search/datasets?vtables=1       200
GET  /api/v1/m/default_search/search/macros                   200
GET  /api/v1/m/default_search/search/dataset-providers        200
POST /api/v1/m/default_search/search/jobs                     200
GET  /api/v1/m/default_search/search/jobs/{id}/status?advanced=true   200
GET  /api/v1/m/default_search/search/jobs/{id}/results-poll?offset=0&limit=200
GET  /api/v1/m/default_search/search/jobs/{id}/results?offset=0&limit=200
```

So the call is `cribl.request({ method, path: "/search/...", groupId })`, which
the adapter renders as `/m/{groupId}/search/...`. `policies.yml` needs
`/m/:gid/search/*` entries, not leader-level ones.

Finding the group id needs no new code: `deriveGroupProduct`
(`ports/cribl-client.ts:88`) already returns `"search"` from the `type`
discriminator or the deprecated `isSearch` boolean, and `listGroups()` returns
every group - only the *UI pickers* filter to Stream via `isStreamWorkerGroup`.
Do not hard-code `default_search`; it is this workspace's id, not a constant.

**Two caveats on what this does and does not prove.**

1. The UI uses the ASYNC job path. `GET /search/query` - the synchronous one
   Phase 4 wants - was never called, so its behaviour is still spec-only. The
   addressing question is settled for the whole `/search/*` family, which was
   the actual gate; if `/search/query` disappoints, the job lifecycle above is
   a proven fallback and its full shape is now known.

   > **[RESOLVED 2026-08-25, and the caution was well placed.]** It was called,
   > and it disappointed in the most instructive way: it is not synchronous at
   > all - it creates a job. Preferring the async lifecycle as the fallback is
   > what kept the feature working. See the `[SUPERSEDED]` block under
   > "Synchronous path" above.
2. The UI authenticates by session cookie; the app authenticates through the
   platform's injected credential. Path shape is what transfers here, not auth.

**Bonus, and it corroborates 0.2 independently of the spec:** the UI's own
job-list call passes `filterExp` as a JavaScript expression with method calls -

```
filterExp=user !== '__system_search__' && type !== 'scheduled' &&
          String(user).toLowerCase().includes('auth0|...')
```

Cribl really does evaluate these as JavaScript on a live system, which is the
assumption the whole regex-filter design in Phase 4 rests on.

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

> **[SUPERSEDED - the anchored form is a DELIMITER SET, not `/,TRAFFIC,/i`]**
> (2026-08-19, shipped as `logTypePredicate` in `domain/capture-filter`)
>
> The comma anchor assumes the vendor's format, and the operator selects a
> SOURCE. Against a pipe-delimited CEF vendor a comma anchor matches nothing,
> which produces the same zero-event answer the anchor was introduced to prevent.
> The shipped predicate anchors on the set of delimiters the app's own parsers
> use - comma, pipe, tab, quote, colon, equals, whitespace, line ends - and
> excludes `/` deliberately, which is what keeps a URL path from matching. The
> full reasoning is in the plan's Phase 4 `[SUPERSEDED]` block.
>
> **The live call is still unmade.** The predicates are pinned by evaluating
> them as JavaScript locally, which proves the regexes, not Cribl's evaluator.
> The residual risk above is unchanged and now applies to the delimiter-set form.
>
> **[MADE 2026-08-25. The residual risk is closed.]** Captures ran against the
> lab workspace and returned events, so Cribl's evaluator does run these
> expressions. Three things came out of it that the local pins could not have
> reached:
>
> - **`__inputId` really is `<type>:<id>` - and sometimes `<type>:<a>:<b>`.**
>   Observed on 40 of 40 captured events: `cribl_tcp:in_cribl_tcp_WinEvt_customer`,
>   `syslog:PaloAlto:tcp`, `datagen:paloaltorfc5424`, `cribl:CriblLogs`. The
>   shipped `inputPredicate` matches the SECOND colon segment, which is exactly
>   why it survives the three-segment form; an `.endsWith(":" + id)` rule would
>   have matched nothing on any syslog source.
> - **Cribl TOLERATES a filter referencing a field the event lacks.** Bare and
>   guarded filters both returned events. The `typeof` guards in
>   `capture-filter.ts` are therefore INSURANCE, not load-bearing, and that
>   module's stated model - an undeclared name is a ReferenceError that drops the
>   event - is wrong. The guards stay: they are harmless and correct, and only the
>   reason given for them was a guess.
> - **A capture needs a worker.** `POST /system/capture` against a worker group
>   with no connected workers returns
>   `400 {"message":"No worker nodes are connected to this worker group."}`
>   before any filter is evaluated. The capture runs ON a worker, so choosing a
>   group means choosing one that has some.

**Permission:** `/m/:gid/system/capture` needs a `POST` entry in
`policies.yml`. It is the first *write-shaped* product-API path this app would
add for a read-only purpose - worth a sentence in the install-time policy
comment, since admins read that list.

> **[DONE 2026-08-19.]** Declared, with the comment: the verb overstates it,
> because `POST /system/capture` creates nothing - it opens a bounded diagnostic
> read and returns events already flowing.

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

> **[SUPERSEDED - fixed in Phase 1, and every row above marked "broken" now
> carries the original line]** (2026-08-19)
>
> Fixed at the parse, as recommended. Every line-oriented parser takes an
> optional accumulator and pushes its SOURCE LINE at the point it emits a record,
> so a parser that filters (`parseCef` skips non-CEF lines, `parseCsv` drops
> one-field rows) cannot drift the pairing; `parseSampleContent` stores originals
> only when the counts match, so a MIS-alignment is impossible rather than
> unlikely - it is all-or-nothing per sample (`rawEventsFor`). The capture unwrap
> keeps the WRAPPER's `_raw`, which is the vendor's own bytes, instead of
> discarding it.
>
> Nothing in 3,704 tests failed when that behaviour changed, which is why the new
> pins assert BYTES and pairing rather than presence.

### PAN-OS format detection: recorded as a KNOWN GAP, then FIXED

Found on 2026-08-19 while writing the raw-line pins above, and pinned in
`raw-lines.test.ts` as a characterization rather than a fix: **a syslog-prefixed
PAN-OS export uploaded directly parsed to ZERO events.** A PAN-OS source ships
CSV behind a syslog header, so the file matched the `<14>` priority prefix and
was classified "syslog"; `parseSyslog`'s RFC 3164/5424 regexes cannot match a
PAN-OS body, so every record failed its >1-field filter and a perfectly good
export reported *"could not parse any events"* with no way to tell why. The
`>=5-comma` rescue for this shape lived only in `detectCaptureInnerFormat`, so it
fired for capture-WRAPPED input and not for an upload.

The judgement at the time was to leave it: fixing it means touching format
detection, which decides CEF vs CSV vs syslog vs kv for EVERY vendor the toolkit
touches, and that did not belong inside the browser-deletion change. So it was
made visible and deliberately not fixed.

> **[SUPERSEDED - fixed the same day, 2026-08-19]**
>
> The gap is closed and the pin now asserts the opposite: the file parses as
> `csv`, both records survive, and `errors` is empty.
>
> **How.** `detectSampleFormat`'s lenient path now recognises the PAN-OS
> POSITIONAL FINGERPRINT via `isPanosFormat` - the `1,<date> <time>,<serial>,
> <KNOWN-TYPE>` shape checked against a whitelist of log types - and it runs
> AHEAD of the syslog check. It is emphatically NOT a comma count, and that
> distinction is the whole safety argument: a chatty syslog line carrying six
> commas stays syslog, and a CEF or kv line full of commas keeps its own format.
> Both directions are pinned.
>
> **Characterized first**, because a regression in this detector does not throw -
> it silently reroutes a sample to the wrong parser and surfaces much later as an
> empty field list or a broken pack. A new suite pins BOTH modes across every
> format, including the divergences that look like bugs and are not (strict is
> prefix-only, so a syslog header hides CEF; strict calls any brace `json`
> without validating). Run before the change it was 16 passing and 1 failing -
> the PAN-OS case, and only that. After, 17. Nothing else in 3,761 tests moved.
>
> **The asymmetry with `detectCaptureInnerFormat` is deliberate and now
> documented in both places.** That one keeps its looser `>=5-comma` rule because
> it inspects ONE already-split `_raw` value where the content is known to be a
> single vendor line, so a loose rule is cheap and catches comma-delimited
> vendors beyond PAN-OS. The lenient detector classifies a WHOLE UPLOADED FILE,
> which could be anything, so it takes the precise shape.

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
   *DONE 2026-08-19 - and the log-type half of the conjunction departs from the
   plan's comma anchor; see the `[SUPERSEDED]` block in 0.2.*
2. **Phase 1 salvage**: raw-line preservation is a real fix and should land in
   `parseSampleContent`, covering LEEF, syslog, headerless CSV and
   capture-wrapped input - not just CEF, which already half-works.
   *DONE 2026-08-19.*
3. **Phase 1 salvage**: `consolidateByTableRouting` needs no salvage. It is
   unreachable. Delete it with the module and record it as a deleted capability.
   *DONE 2026-08-19.*
4. **Phase 3/4 Search**: ANSWERED (0.1b). Pass a `groupId` resolved from
   `listGroups()` by product `"search"`; declare `/m/:gid/search/*` in
   `policies.yml`. Prefer `GET /search/query` for the count-by-discriminator
   query, with the proven `POST /search/jobs` lifecycle as the fallback.
   *IN PROGRESS 2026-08-20. `policies.yml` carries a note where the entries go
   and says why they are not declared yet - nothing calls them.*
   *DONE, and the preference was HOLLOW (2026-08-25): `GET /search/query` creates
   a job like the other door does, so "prefer it, fall back to jobs" described one
   lifecycle tried twice rather than a cheap path with a safety net - and it cost
   an orphaned job per query plus a platform error rendered under a success
   headline. The route is DELETED and its policy grant withdrawn; only
   `POST /search/jobs` remains. `/m/:gid/search/*` addressing and the
   `listGroups()` resolution are unchanged and confirmed.*
5. **New, from doing (2)**: PAN-OS format detection dropped every event of a
   syslog-prefixed upload. Recorded as a KNOWN GAP, then fixed the same day -
   see the section above 0.3's dead-code note.
