# Vendor field definitions: naming positional columns

Status: BUILT 2026-08-25, all four steps. Kept as the record of WHY, not as a
to-do list - the sequencing and the decisions below are what the code now
implements, and the two remaining gaps are named at the end.

Confirmed working against the live preview the same day: pasting a PAN-OS
USERID line (a type with no bundled column order) opens "Headerless CSV
detected (15 columns)"; the mapper shows each position with two rows of its own
values; naming two columns reports "2 of 15 columns named, 13 stay positional";
and reopening the saved definition comes back as two named and thirteen
unmapped rather than claiming to be finished.

The operator question this answers: **"my samples came back as `field_3` and
`_17` - how do I tell the app what those columns are?"**

## The answer is decided by FORMAT FAMILY, not by vendor

This is the whole design, and everything below follows from it.

| Family | Needs the operator to supply anything? | Why |
|---|---|---|
| JSON / NDJSON | **No** | field names are in the data |
| key=value (FortiGate, Zscaler NSS in kv mode) | **No** | names are in the data |
| CEF / LEEF | **No** | extension keys are named |
| **Positional CSV** (PAN-OS, some legacy feeds) | **YES** | the meaning is the column ORDER, and the order is nowhere in the bytes |

So the app must ask about exactly one family. For the other four it must ask
nothing, and asking anyway would be a worse product.

**The ambiguity is real, not an implementation gap.** On 2026-08-25 a change
stripped the syslog header before detection and immediately reclassified
`<134>Jan  1 12:00:00 host app: a, b, c, d, e, f, g` from `syslog` to `csv` -
because once the envelope is gone, `a, b, c, d, e, f, g` IS a valid identifier
header row. There is no content signal separating them. That reverted change is
the evidence that positional data cannot be self-describing, and the
characterization suite pins that line as syslog precisely to hold the line.

## Most of this already exists - build on it, do not rebuild it

`CsvHeaderDialog` (`packages/ui/src/screens/samples/csv-header-dialog.tsx`)
already implements the core of what was asked for:

- **Header row tab** - upload a header file OR paste a header row (one column
  per line or comma-separated), both through the pure `parseHeaderFileText`.
- **Feed config tab** - paste a vendor OUTPUT config and recover the field order
  from it, via core `parseFeedConfig`. It already understands **Zscaler NSS**,
  the PAN-OS syslog profile, FortiGate, Cloudflare Logpush and CrowdStrike.
- **Preview zip** - each resolved header aligned to the first data row's real
  value, which is the live-preview idea already shipped in miniature.
- **Mismatch warning** - when the header count differs from the column count.
  This is the off-by-one guard, and it is the single most valuable part: an
  empty column (`1,<ts>,,CONFIG`) silently shifts every name after it.
- **Skip** leaves positional names; **Apply** re-parses through core
  `parseCsvWithHeaders` and re-keys the tagged sample.

The queue is built from `samples.filter(isHeaderlessCsvSample)`
(`csv-resolution-state.ts`), and `sample-intake-section.tsx` both auto-opens it
after a paste/upload and computes `headerless` per stored sample chip.

**So the feature is not missing. It is not REACHING the samples that need it.**

## The three gaps

### Gap 1 - a naming-convention collision hides PAN-OS from the dialog

Two modules independently decided how to name a positional column:

- `parseCsv` (`parsers.ts`) emits `_0, _1, _2 ...`
- `parsePanosLine` (`panos-dictionary.ts`) emits `field_0, field_1 ...` for any
  log type with no recorded column order

`isHeaderlessCsv` (`log-type.ts`) tests `/^_\d+$/`. So a headerless CSV sample is
offered the naming dialog and a PAN-OS sample with unknown columns is **not** -
it is positional, it needs names, and the app's own naming dialog cannot see it.

Measured against a live Cribl Lake dataset on 2026-08-25, PAN-OS column orders
exist for seven types (TRAFFIC, THREAT, SYSTEM, CONFIG, GLOBALPROTECT,
DECRYPTION, AUTHENTICATION) and are absent for six that the lake actually
carries: **AUDIT, AUTH, CORRELATION, HIPMATCH, IPTAG, USERID**. Those six parse
to `field_N` and have no route to being named.

> **UPDATE 2026-08-25 - five of those six are now resolved.** This plan argued
> against shipping the missing orders, on the grounds that it "would fix one
> vendor and teach the app nothing". The user asked for them directly, which
> supersedes that; the general path is untouched, because these are BUNDLED
> orders that pre-fill the dialog and an operator-supplied order still beats
> them.
>
> - **HIPMATCH was never actually missing** - the dictionary keys it
>   `HIP-MATCH` and `panosHeadersFor` folds the separator, so it resolved all
>   along. This paragraph was stale on that one point.
> - **AUDIT, CORRELATION, IPTAG, USERID** now have orders transcribed from Palo
>   Alto's published syslog field descriptions, each cross-checked against the
>   current NGFW page, a second PAN-OS version, and the vendor's own fixture
>   data. Citations sit beside each entry in `panos-dictionary.ts`.
> - **AUTH is deliberately still absent.** Palo Alto publishes no log type
>   called AUTH, so there is nothing to transcribe; inferring one from sample
>   values or borrowing AUTHENTICATION's would mislabel every column after the
>   first mistake. It still parses positionally and is still offered the
>   dialog - which is exactly the case Gap 2 and Gap 3 exist to serve.

This is the cheapest fix with the largest effect and should land first, on its
own. It is also exactly the class the architecture audit calls a duplicated
decision: one question - "what do we call an unnamed column?" - answered twice.

### Gap 2 - no interactive mapping when there is no artifact to paste

Both existing tabs assume the operator HAS something: a header row or a vendor
feed config. When they have neither, there is no path. A third tab should show
each position with its real example values and let them name it directly.

The example values are what make this usable rather than clerical: naming
`field_7` is guesswork, naming the column that reads `192.168.0.2` is not.

### Gap 3 - nothing is remembered

Resolution is per sample. The same vendor and log type re-acquired next week
asks again. `learned-mappings.ts` already solved this shape for field mappings -
diff against the analyzed baseline, persist per solution through
`ports.contentCache`, replay on every analysis - and a column order is the same
kind of durable operator knowledge.

## The live preview

Requested, and it is the part that makes positional mapping safe. Show, as the
operator types:

1. **Named fields with their real values** - `dst_ip -> 192.168.0.2`, re-rendered
   on every edit. An off-by-one stops being an invisible mistake and becomes an
   obvious one, because the values stop making sense next to their names.
2. **The unmapped remainder** - the positions still called `field_N`, counted.
   A definition that covers 12 of 38 columns must LOOK like it covers 12 of 38.

The existing preview zip is (1) for the header-row tab. Extend rather than
replace, and make it the shared surface all input paths render into.

Constraint carried from the rest of this app: **never invent a name.** An
unmapped position keeps its positional name and is shown as unmapped. Guessing
from a value shape would produce a confident wrong name, which is worse than a
`field_17` the operator can see is unfinished.

## Sequencing

1. **Gap 1 alone.** One convention for unnamed columns, so PAN-OS reaches the
   dialog that already exists. Smallest change, unblocks the six live log types.
2. **The live preview**, shared by every input path.
3. **Gap 2**, the interactive tab.
4. **Gap 3**, persistence, following the learned-mappings precedent.

Filling in the six missing PAN-OS column orders is deliberately NOT on this
list. It would fix this vendor and teach the app nothing; step 1 lets the
operator fix any vendor, including the next one.

> **SUPERSEDED 2026-08-25** - the user asked for those orders directly and four
> shipped (AUDIT, CORRELATION, IPTAG, USERID); HIPMATCH was never missing and
> AUTH is declined because the vendor publishes no such log type. See the fuller
> UPDATE note under Gap 1. The paragraph above is kept because its REASONING
> still holds - step 1 is what lets an operator fix the next vendor, and these
> are bundled orders that only pre-fill the dialog.

## Decisions taken 2026-08-25 (user)

**1. A column order is keyed to VENDOR + LOG TYPE, not to the solution.**

It is a fact about the data, not about the workflow: a PAN-OS TRAFFIC order is
true whichever Sentinel solution is selected. So it deliberately does NOT reuse
the learned-mappings key, even though that is the closest existing machinery and
would have been cheaper - reusing it would re-ask for the same vendor under a
different solution and would record a vendor fact in a solution-shaped slot.

Not scoped per connection. This is a single-tenant deployment (one Azure tenant,
one Cribl workspace), so a per-connection scope would be machinery guarding
against a situation that cannot arise here. If that ever stops being true, this
is the paragraph to revisit - the key gains a connection component, nothing else
changes.

**2. A known vendor PRE-FILLS the dialog, and the operator confirms.**

When the solution already names the vendor, the bundled order is applied and
shown with real values beside each name, so the operator is confirming rather
than supplying. This is the fastest path and it is only safe BECAUSE of the live
preview: a bundled order that is wrong for their firmware shows up as values
that stop making sense next to their names, immediately, before anything is
stored.

Note this differs from how vendor IDENTITY chips behave (offered, never
auto-picked) and the difference is deliberate: an identity chip asserts
something about the operator's environment that we cannot see, while a column
order is checkable on screen against their own data the instant it is applied.

**3. An operator-supplied order beats the bundled one, AND THEY ARE TOLD.**

Same precedence as learned mappings beating bundled packs: the person looking at
their own data outranks a shipped table, not least because vendor column orders
change between firmware versions. But the override is recorded and shown - a
mistaken paste replacing a correct shipped order must be visible rather than
silent, which is the whole difference between this and "operator wins quietly".

## What is NOT built

- ~~**The override notice reaches the dialog but not the chip.**~~ **BUILT
  2026-08-26.** The chip now renders `describeColumnOrder`'s sentence, guarded by
  a check that runs sample -> order and compares SEQUENCE rather than membership,
  because the subject is positional and a real export is routinely narrower than
  the order that named it. `forget` is wired too - it had been returned by
  `useVendorColumnOrder` since it was written, documented as "the way back from a
  mistaken paste", with no caller anywhere but its own test.
- **Only curated vendors are remembered.** The vendor is derived from
  `detectVendorIdentity(solutionName)`, so a solution outside
  `KNOWN_VENDOR_IDENTITIES` yields no vendor and nothing is stored - honest per
  "absent is absent", but it means the feature reaches about eighteen vendors.
  Letting the operator name the vendor themselves closes it and needs a UI seam
  that was deliberately not built.

## Open questions

- ~~Where does the override notice live?~~ **Answered 2026-08-26: both.** The
  dialog is where the decision is made, so it stays there; the chip is where
  someone looking later needs it, and without it a sample named from a bundled
  dictionary, from a stored order, or by hand were indistinguishable afterwards.
- Does a persisted order need a version or a captured-on date, so a firmware
  change can be reasoned about later rather than silently disagreeing with a
  future bundled update?
