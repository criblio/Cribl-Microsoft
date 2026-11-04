# Data Volume Inventory: a By source view beside By table

Status: Proposed - design agreed in brainstorming 2026-11-04; not built.
Last-confirmed: 2026-11-04

## Intent

The Data Volume Inventory answers "how much does this workspace ingest" from
Microsoft's `Usage` table, per table (the **table lens**), and the data
allowances build on it (`docs/features/inventory-data-allowances.md`). It does
not answer "who sends it": the per-table Sources drill-down names each row's
source by the first of `_ResourceId`, `Computer`, `DeviceVendor DeviceProduct`,
so CEF arriving through a forwarder is listed as the forwarder.

Measured 2026-11-04 on `sentinel-new`: all 1.68 GB of CommonSecurityLog in 30
days is **Cisco ASA**, through three collectors (`localhost` 1.36 GB, `:` 0.20
GB, `SNL-ASA-VPN-A01` 0.12 GB). Today's breakdown shows three sources named
after the collectors and never says Cisco ASA.

This feature adds a **source lens** built from the rows themselves - product
identity, the collector that carried it, and billed vs free volume from each
row's `_IsBillable` - and presents both lenses side by side. It complements the
table lens; it does not replace it (user direction 2026-11-04).

## What each lens is the authority for

| Question | Lens | Data |
|---|---|---|
| How much is ingested and billed, per table | table | `Usage.Quantity`, `Usage.IsBillable` (Microsoft's billing aggregate) |
| Which allowance a table falls under | table + catalog | `allowance-catalog.ts` (unchanged) |
| Who sends it (vendor/product), through which collector | source | the rows: identity columns per the map below |
| How much of a source is billed vs free | source | `sumif(_BilledSize, _IsBillable == true)` per source |

The two are different measurements (`Usage` vs `_BilledSize`); they agreed to
0.06% when measured (MIG-1). The UI never subtracts one from the other; it
states how far they agree.

`_IsBillable` marks the always-free data types. It does NOT reflect the E5 or
Defender for Servers grants (applied on the bill), so it cannot settle MIG-17;
the allowance cards keep doing that.

## Decisions (user, 2026-11-04)

1. **Option B: two views of one inventory.** "By table" is today's view
   (default). "By source" lists products across tables.
2. **Per-table identity map** (one dated module in core, extended table by
   table): CommonSecurityLog -> `DeviceVendor` + `DeviceProduct`; SecurityAlert
   -> `ProductName` (fallback `ProviderName`); Syslog -> `Computer` + `Facility`;
   every other table -> today's order (`_ResourceId`, then `Computer`, then
   `DeviceVendor DeviceProduct`).
3. **Collector shown as "via"**: when identity comes from product columns, the
   collector (`_ResourceId` name, else `Computer`) is kept. The breakdown groups
   by identity AND collector; "By source" shows a collector count with a
   drill-down.
4. **Measured wins, catalog explains**: each source shows billed and free
   volume from `_IsBillable`. A table the catalog tags Free whose sources are
   billed is flagged in both views ("catalog says free; 2 sources billed"), with
   the reason one click down. The reverse is flagged too (MIG-32): a table the
   catalog tags Billable whose measured volume is all free reads "measured free;
   the catalog tags <tables> Billable" (never for a partial or not-read table). Allowance arithmetic keeps using `Usage` per table
   as today.
5. **Tables with no product columns** appear in By source as one row each,
   named for the table ("AWSCloudTrail (no product columns)"), so every MB is on
   the page and the By source total reconciles to `Usage`.

## What the operator sees

**By table** (unchanged layout). The Sources drill-down now names product
sources as "Cisco ASA via localhost", shows billed / free per source, and ends
with the reconciliation line ("sources account for 56.0 of 56.0 MB/day").

**By source** (new). One row per source identity across tables:

| Column | Content |
|---|---|
| Source | vendor / product, or "<table> (no product columns)" |
| Lands in | the tables it appears in |
| Daily avg | sum over its rows, 30-day average |
| Billed / Free | from `_IsBillable`, with a small proportional bar |
| Collectors | count; drill-down lists each collector with its volume |
| Allowance | the allowance tag(s) of the tables it lands in, and the catalog-disagreement flag when it applies |

Sorted by daily volume. Under the table, one reconciliation sentence: "These
sources account for X of the Y MB/day Usage reports (Z%)". Every figure has an
InfoTip saying which lens it comes from. Unknowns follow the inventory standard:
a table whose breakdown failed or was not requested appears as "(sources not
read)" with its Usage volume - never as zero, never dropped.

## Constraints

- `docs/inventory-standard.md` binds: a failed or partial breakdown is never
  shown as zero or omitted.
- Core stays pure: the identity map, the KQL and the fold to source rows are in
  `packages/core`; the existing breakdown query (one query per 10 tables, 25
  rows per table cap) is extended, not duplicated. The cap now applies to
  identity+collector rows; the remainder stays one "other" row per table and is
  shown as such in By source.
- `column_ifexists` for every identity column (a table missing one must not fail
  the batch - measured SEM0100 behaviour).
- Proxy budget: no new query per table; the extra columns ride on the existing
  breakdown query.

## Non-goals

- Changing the allowance arithmetic or the catalog.
- A flow diagram (option C) - may follow later beside the table.
- Identity maps for tables beyond the three named; they are added later, one
  dated row at a time.

## Calls made after the builder review (2026-11-04)

Designer's calls, not the user's; each is cheap to reverse.

1. **Units and reconciliation.** Every source figure is `_BilledSize` / 30 days
   in decimal MB - never scaled to `Usage`. The "other" remainder is a
   `_BilledSize` aggregate from the same query (the query already rolls rank >
   25 into one row), never `Usage` minus the listed rows. The reconciliation
   sentence COMPARES the two lenses: "Sources (measured from the rows) total
   X MB/day; Usage reports Y MB/day; they agree within Z%".
2. **The "other" row carries billed and free too**, so the catalog flag cannot
   miss billed volume hidden past the 25-row cap.
3. **Collector only where identity is a product.** For CommonSecurityLog and
   SecurityAlert the collector is `_ResourceId`'s name, else `Computer`. For
   Syslog (identity `Computer` + `Facility`) and every fallback table there is
   no separate collector: the Collectors cell reads "-", and the group key is
   the identity alone.
4. **Merge key** = identity kind (product / resource / computer / table) +
   the value trimmed and case-folded. Rows merge across tables only within the
   same kind, so a product ("Cisco ASA") merges across tables but a resource
   name never merges with a computer name. Display keeps the most common
   original casing.
5. **The catalog flag is per table.** By table shows it on the table row; on a
   By source row it reads "billed in a table the catalog tags Free
   (SecurityAlert)" listing those tables. The reverse flag (a Billable-tagged table
   measured all free) is per table the same way: on the By table row when every
   read source of the table is free, and on a By source row listing the tables
   where that row measured volume and none of it billed.
6. **Sources not read.** Per table, exactly as the existing breakdown decides
   (a failed batch is retried table by table). By source shows one row per such
   table, "<table> (sources not read)", with its `Usage` volume and Billed /
   Free reading "not read"; the reconciliation sentence names that volume
   separately ("plus N MB/day from 2 tables whose sources were not read").
7. **Granularity of By source.** Only the mapped tables (the identity map)
   contribute identity rows. Every other table is ONE By source row (decision
   5); its resource- and computer-level detail stays in the By table
   drill-down, so call 4's resource/computer merging applies to Syslog
   computers only.
8. **CSV.** Existing columns keep their names and order; new columns append.
   Rows become one per identity + collector, so a product through two
   collectors is two rows (the CSV is for people and tickets; no machine
   consumer is known).

## Open, for the builder

1. Whether `Facility` reads well enough as part of the Syslog identity or should
   be the "via" side - decide from a live Syslog sample and record it.
2. The CSV: whether By source exports as its own file or as extra columns on
   the existing per-source rows (prefer extra columns on the existing file:
   `SourceIdentity`, `Collector`, `BillableDailyMB`, `FreeDailyMB`).
