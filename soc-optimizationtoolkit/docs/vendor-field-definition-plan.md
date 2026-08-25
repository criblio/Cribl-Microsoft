# Vendor field definitions: naming positional columns

Status: PLAN. Decision to build taken 2026-08-25; no code moved yet.

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

## Open questions

- Does a resolved column order belong to the SOLUTION (like learned mappings) or
  to the vendor/log type independent of solution? A PAN-OS TRAFFIC order is true
  regardless of which Sentinel solution is selected, which argues for the second
  and against reusing the learned-mappings key directly.
- Should a shipped `parseFeedConfig` vendor pre-fill the dialog when the sample's
  vendor is already known from the solution, so the operator confirms rather than
  supplies?
- `PANOS_CSV_HEADERS` is a bundled column order. If operator-supplied orders are
  persisted, which wins when they disagree? The operator's, on the same reasoning
  that learned mappings beat bundled packs - but it should be recorded, and the
  operator should be able to see that they are overriding something.
