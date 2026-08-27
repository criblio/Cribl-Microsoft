# ADR 0004: Cast guid columns instead of dropping them

Date: 2026-08-23
Status: Accepted
Invalidates: none
Breaks, deliberately: the v1 bug-compatibility contract in
`domain/schema-mapping` (RULE 2b) and two `legacy-fixtures.json` fixtures

## Context

`buildDcrColumnSet` removes any column whose Log Analytics type is
`guid`/`uniqueidentifier`/`uuid` from the DCR stream declaration entirely
(RULE 2b, `schema-mapping.ts:367-370`). This is a faithful port of the v1
PowerShell (`Get-TableColumns`, lines 1475-1617), and the module header names it
as one of the legacy quirks the port preserves on purpose.

**The consequence was not understood when it was ported.** `transformKql` is the
frozen literal `"source"` - a pass-through of DECLARED columns. In a Kind:Direct
DCR the stream declaration IS the input contract: a field present in the posted
payload but absent from the declaration is discarded at the DCR boundary and
never reaches the output column. The affected columns are content columns, not
Azure-managed ones, so nothing repopulates them.

So Cribl sends `AwsEventId`, the DCR drops it, and the `AwsEventId` column in the
table stays null forever. The DCR deploys successfully. No error is raised.

The v1 script this was ported from had a DIFFERENT and less harmful bug: it
emitted `guid` into `streamDeclarations`, which is not a legal DCR column type
(the legal set is string/int/long/real/boolean/datetime/dynamic), so Azure
rejected the deployment with a 400. The operator got a loud failure and no DCR.
We removed the 400 and kept the data loss - and made it silent.

This was found by following up external PR #26 (open and unreviewed since
2026-06-11), in which a contributor hit the v1 400 against `AWSCloudTrail` and
fixed it correctly: declare `string`, promote with `toguid()` in the transform.
Their diff targets `deprecated/`, but their diagnosis applies to us.

Three further facts established while confirming it:

1. **The mapping already exists and is dead code.** `typeMap` maps the guid
   family to `string` (`schema-mapping.ts:255-257`), reachable only from the
   schema-FILE path. The DCR path drops the column before it can be used. The
   two paths already disagree about the same column: the schema file makes it a
   `string` column, the Azure path makes it no column at all.
2. **The diagnostics already exist and reach nobody.** `buildDcrColumnSet`
   returns a populated `dropped: [{name, reason: "guid-type"}]`, propagated
   through `dcr-request.ts` as `droppedColumns`. Repo-wide, the only consumers
   are two test files. No usecase, no UI, no log, no preview reads it.
3. **The field matcher offers what the generator discards.**
   `bundled-schema-catalog.ts:43-63` filters by system NAME only, with no type
   filter, so all seven bundled guid columns are offered to an operator as valid
   mapping targets that the generator then silently drops.

Blast radius in the bundled catalog is 2 tables and 7 columns
(`ADAssessmentRecommendation` 4, `AWSCloudTrail` 3), but deploy-time column sets
come from the LIVE Azure tables API, so any Sentinel table with a guid column is
affected. `TenantId` is guid on essentially every table and is NOT affected - it
is excluded earlier as a system column, which is correct, since Azure populates
it.

## Decision

**Declare guid-typed columns as `string` and promote them with `toguid()` in
`transformKql`.** They stop being dropped.

`transformKql` stops being the constant `"source"` and becomes
`source | extend Col = toguid(Col), ...` when, and only when, a table has guid
columns to promote. A table with none still emits exactly `"source"`, byte for
byte.

This deliberately breaks the compatibility contract stated in the
`schema-mapping.ts` header and in `schema-mapping.characterization.test.ts`,
whose header currently reads "if one of these fails, the implementation is wrong
- never the fixture". **For guid columns, that sentence is now false.** The
fixtures record v1's behaviour, and v1's behaviour loses data. Two fixtures
change: `AWSCloudTrail` (3 columns) and `SyntheticTypeMatrix` (3 columns).

The contract still holds everywhere else, and the header is amended to say so
precisely rather than deleted.

### What is NOT decided here

- `AwsRequestId` is deprecated in favour of `AwsRequestId_` because CloudTrail's
  `requestID` is frequently not a UUID, so `toguid()` returns null on it and
  drops the value silently. Routing deprecated guid columns to a `_`-suffixed
  string successor is a real improvement but is a per-table content decision,
  not a schema-mapping rule. Deferred, and recorded in the backlog.
- Surfacing `droppedColumns`/`unknownTypeColumns` in the UI is still worth doing
  - system-column drops and unknown-type fallbacks remain invisible. Deferred.
- Reconciling the field matcher's target list with the generator's output is
  deferred: after this change the two agree about guid columns, which removes
  today's only known instance of the mismatch.

## Consequences

**Data that was silently discarded now arrives.** That is the point.

**The emitted transform must round-trip.** `gap-analysis/kql-parser.ts` did not
know `toguid`: it is absent from `RENAME_SKIP_NAMES`, from `TYPE_MAP`, and from
the coercion regex. Emitting `toguid()` without teaching the parser injects a
phantom destination field literally named `toguid` into gap analysis. The parser
is extended in the same change - verified empirically, not assumed.

**`DropReason` loses its `guid-type` variant.** Nothing produces it once the drop
is gone, and keeping a dead variant would leave the type describing behaviour the
code no longer has.

**Existing DCRs are not migrated.** A DCR already deployed with the guid columns
missing keeps its old stream declaration until it is redeployed. `update-dcr`
regenerates the declaration, so an update fixes it; nothing sweeps for affected
DCRs. Operators who deployed before this change and never update keep losing
those fields, and nothing tells them. That is a gap, and it is the strongest
argument for doing the deferred `droppedColumns` UI work next.

**We diverge from v1 in generated output for these tables.** Any future
comparison against script-generated templates will differ on guid columns, and
should - the divergence is the fix.

**Not verified against live Azure.** The data-loss conclusion rests on documented
Direct-DCR stream semantics plus the verified absence of any repopulation path in
this codebase; no DCR was deployed to observe the null column, and no DCR has yet
been deployed to observe the cast working. `toguid()` silently returns null on
malformed input rather than erroring, so a wrong cast fails the same quiet way
the drop did. **This belongs in the live-verification suite alongside the
Cribl beliefs** - see `packages/core/src/testing/live-verify.test.ts`.
