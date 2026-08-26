# Zscaler NSS lab: three Lake datasets, three wire formats

Built 2026-08-25 on the `busy-yonath-kz1bxn7` workspace, Stream group
`DatacenterEast`. Purpose: give the Lake sample-selection feature a test bed
where the SAME four log types arrive in three different wire formats, because
that is the variation customers actually have.

## What exists now

| Lake dataset | Format | Datagen | Sample file | Route |
|---|---|---|---|---|
| `zscaler_csv` | comma-delimited, headerless | `dg_zscaler_csv` | `3mYWOf` (`zscaler_csv.log`) | `zscaler_csv_to_lake` |
| `zscaler_cef` | CEF over syslog | `dg_zscaler_cef` | `b9ZtKx` (`zscaler_cef.log`) | `zscaler_cef_to_lake` |
| `zscaler_leef` | LEEF 1.0 over syslog | `dg_zscaler_leef` | `7wXSIo` (`zscaler_leef.log`) | `zscaler_leef_to_lake` |

Each sample file holds 68 events; each datagen replays at 4 events/sec into
`out_zscaler_<fmt>` (a `cribl_lake` Destination, `destPath` = the dataset).
Routes filter on `__inputId=='datagen:dg_zscaler_<fmt>'`, are `final: true`, and
sit immediately before `garbagecollection` so the catch-all cannot swallow them.

Verified live the same day - each dataset returns FOUR log types under
`| summarize count() by sourcetype`, in the vendor's own spelling:

```
zscaler_csv    4 log types, 2974 events   tunnel 866 / dns 708 / fw 702 / web 698
zscaler_cef    4 log types, 2984 events   tunnel 860 / dns 712 / fw 708 / web 704
zscaler_leef   4 log types, 2976 events   tunnel 863 / dns 711 / fw 703 / web 699
```

`sourcetype` is a REAL field on the event, not something recovered by parsing
`_raw`, which is the condition `query-lake-samples` needs: step two asks the
search engine to `summarize by` that field, so it has to be a field the engine
can see. The values are Zscaler's own - `zscalernss-dns`, `zscalernss-fw`,
`zscalernss`, `zscalernss-tunnel` - taken from the `sourcetype` key in Zscaler's
published `cloud-nss-*.fof` feed definitions, not invented here.

## The three scenarios, and why they differ

This is the point of building three rather than one.

- **`zscaler_cef` / `zscaler_leef`** - self-describing. Extension keys are named
  in the payload, so the operator supplies nothing. These exercise the ordinary
  path.
- **`zscaler_csv`** - positional. The meaning IS the column order and the order
  is nowhere in the bytes, so this is the one dataset that must reach the
  column-naming dialog (see `vendor-field-definition-plan.md`). Zscaler NSS's
  **default** Feed Output Type is comma-separated, so this is not a contrived
  case; it is what an admin gets by not changing the dropdown.

## Provenance - what is cited and what is not

Every field NAME and ORDER traces to a Zscaler source. Values are the vendor's
own documented examples except where noted.

**CEF - vendor-published, all four feeds.** `github.com/zscaler/microsoft-resources`,
`microsoft-sentinel/zia-log-feeds/{dns,fw,web,tunnel}/nss-*.cef`. These are
Zscaler's own CEF Feed Output Format strings; the generator substitutes values
token for token into them.

**LEEF - vendor-published for WEB ONLY.** Zscaler populates a QRadar LEEF
format string when you select "QRadar LEEF" as the Feed Output Type; it is
reproduced at `docs.rapid7.com/insightidr/zscaler-nss/` and begins
`LEEF:1.0|Zscaler|NSS|4.1|%s{reason}|`. Zscaler publishes **no** LEEF layout for
DNS, firewall or tunnel - IBM's and Rapid7's guidance is that those feeds go to
QRadar as JSON. So the DNS/FW/Tunnel LEEF events here are **operator-authored**:
the vendor's own CEF field set re-emitted as LEEF key=value pairs, which is what
an admin does in the Custom output box. They are realistic, they are NOT a
vendor standard, and nothing here should imply otherwise.

**CSV - vendor-default format, operator-chosen order.** Zscaler documents that
"the output is a comma-separated (CSV) list by default"
(`help.zscaler.com/zia/adding-nss-feeds-web-logs`), but the COLUMN ORDER is
whatever the admin types into Feed Output Format - there is no canonical vendor
order. The orders in `CSV_ORDER` are therefore one plausible admin choice drawn
from the documented field lists. That absence is the whole reason the app has to
ask, so it is the honest thing to model.

Zscaler also warns against comma delimiters ("Avoid using commas and spaces
because they could be in some output values") and offers a Feed Escape Character
that hex-encodes them. The generator honours this: an embedded comma is written
`%2C`, so `Req(allow),Res(allow)` does not shift every later column.

**Values** come from Zscaler's own sample logs
(`microsoft-sentinel/cloud-nss-test/sample-{dns,fw,web}.log`) and the Example
column of `help.zscaler.com/zia/nss-feed-output-format-{web,tunnel}-logs`.

**Tunnel, specifically.** Layout from `nss-tunnel.cef` + `cloud-nss-tunnel.fof`,
which define four record types. Only TWO are emitted here - IKE Phase 1 and
Tunnel Events - because those are the two whose `tunnelactionname` token the
vendor states outright (`WL_TUNNEL_IPSECPHASE1`, `WL_TUNNEL_EVENT`). The Phase 2
and Sample record types have published layouts but their action-name token was
not stated on the pages read, and minting one would put a fabricated vendor
token in the data. Documented values used: `sourceip` 116.113.61.135, `destvip`
165.225.104.35, `locationname` Headquarters, `vpncredentialname`
jdoe@safemarch.com, `dstport` 500, P1 `lifetime` 86400, `tz` GMT, `event` ∈
{UP,DOWN,REKEY,...}, `eventreason` ∈ {None,EXPIRED,DPD_TIMEOUT,...}, `tunneltype`
∈ {GRE,IPSEC_IKEV1,IPSEC_IKEV2}, `vendorname` ∈ {CISCO,STRONGSWAN,...}.
**Lab-authored:** `algo`, `authentication`, `authtype` - protocol-standard
values (AES_CBC_256 / HMAC_SHA2_256_128 / PSK); the vendor pages read do not
give examples for these three.

## The API fact this cost the most to find

**Creating a Cribl sample file needs `context.events`, and it is not in the
OpenAPI spec.**

```
POST /api/v1/m/{group}/system/samples
{"sampleName": "x.log", "ttl": 24, "context": {"events": [ {…}, … ]}}
```

No `id` - the server mints a short one (`3mYWOf`). The spec's `DataSample`
schema requires `id` and `sampleName` and declares `additionalProperties: true`,
so it names no content property at all.

What does NOT work, all of which return HTTP 200 and look successful:

- `PATCH /system/samples/{id}` with a **`lines`** array. This is what
  `jphltech/projects/cribl-stream-datagen-research` recorded as the verified
  create call, and it stores the array in the sample's metadata - `GET` reads it
  back. But no sample FILE is produced: the entry has no `size` or `numEvents`,
  `GET /system/samples/{id}/content` answers **500 "Unable to find sample"**,
  the Cribl UI's Sample Files list does not show it, and a datagen bound to it
  emits **nothing** while reporting `health: Green`. That research note should be
  corrected.
- `POST` with any of `lines`, `events`, `sampleData`, `data`, `content` at the
  top level, with or without `id` - all 500 "Unable to find sample with
  id=undefined". POST is wired to the update handler unless the body carries
  `context`.
- `PUT /system/samples/{id}`, multipart upload, `?filename=` + octet-stream -
  404 or schema error.

Found by intercepting `window.fetch` in the Cribl UI and driving its own
Add Sample File -> Capture -> Save flow. Reading the product's own traffic
settled in one shot what six body-shape guesses could not.

**A datagen bound to a broken sample is silent, not red.** `eventCount: 0` with
`health: Green` is also what the KNOWN-GOOD `paloaltorfc5424` datagen reports, so
that field proves nothing either way. The only reliable check is
`POST /m/{group}/system/capture` with `{"filter": "__inputId=='datagen:<id>'",
"level": 0}` - events or no events.

Allow ~60s after deploy before capturing (a capture run 45s post-deploy returned
nothing; the same capture at 85s returned 24 events per datagen), and ~5 minutes
before searching Lake - the `cribl_lake` Destination holds a file open for
`maxFileOpenTimeSec: 300`.

## Three more benches, for the families Zscaler does not cover

Added 2026-08-26. Built by `scripts/zscaler-lab/build_more_benches.py`, wired
the same way (sample file -> datagen -> `cribl_lake` Destination -> route ahead
of `garbagecollection`).

| Dataset | Family | Discriminator | Verified |
|---|---|---|---|
| `fortigate_kv` | key=value, self-describing | `type` (3 values) | traffic 1849 / utm 1225 / event 612 |
| `okta_json` | nested JSON, no `_raw` | `eventType` (5 values) | 5 groups, session.start 2x the rest |
| `broken_feed` | ragged CSV | **none, on purpose** | 1 group, whole dataset |

`fortigate_kv` uses field names from the toolkit's OWN alias table
(`field-matcher/knowledge-bases.ts` - `srcintf`, `sentbyte`, `policyid` and
friends all map to Sentinel columns there), so the bench exercises mappings the
app really has. `okta_json` uses the System Log event-type families the repo
already records in `log-type-catalog/vendor-log-types.ts`, and emits PARSED
fields with no `_raw` - which is what a JSON source produces.

**It does NOT reach `rowRawText`'s `JSON.stringify(row)` fallback, despite what
this doc first said.** Measured 2026-08-26: a capture on `datagen:dg_okta_json`
shows `_raw` on 0 of 20 events at the source, but 40 of 40 events READ BACK FROM
LAKE carry a `_raw` holding the JSON as a string. The Lake write path adds it -
the route is `passthru`, so nothing in the pipeline did. It round-trips exactly
(no key appears only in `_raw`), and the nesting survives whole: `actor`,
`client.geographicalContext.geolocation`, `outcome`, and `target` as a real
list, on 40 of 40.

So the structured path is still exercised, but the `_raw`-absent branch is not,
and no Lake-sourced bench can exercise it. Reaching that branch needs a sample
that never went through Lake - a paste or an upload.

`broken_feed` is twelve hand-built hazards: an empty column that shifts every
name after it, short and long rows for the same nominal type, an unescaped comma
inside a value next to a correctly-quoted one, a trailing delimiter, a truncated
row, a row of only delimiters, free text and a JSON object smuggled into a CSV
feed, and ragged whitespace. It carries no field beyond `_raw`, so it also
exercises the `datasetAsLogType` path.

## Verified against the live app, 2026-08-26

Driven in the Cribl Live Preview (`/apps/a/__local__`), solution scoped to
Zscaler Internet Access.

- **The Lake panel found all four log types** in `zscaler_csv` with byte
  estimates, and the ordering is a real check rather than a smoke test: Web is
  the largest per event (widest CSV row, ~56 MB over ~133k events) while Tunnel
  is the most numerous (20 of the 68 rows) - which is what the generator makes.
- **The user-reported bug is fixed.** "Add as samples" now opens the naming
  dialog: *"Headerless CSV detected (20 columns) ... Resolving file 1 of 4"*,
  each position beside its real value.
- **The feed-config tab recognised the vendor.** Pasting a Zscaler NSS format
  string chipped **"Zscaler nss (20 fields)"**, reported *"Names all 20
  columns"*, and the live preview put every name against the right value with no
  off-by-one. Applied for Tunnel (20) and DNS (21).
- **Column counts round-tripped exactly** - tunnel 20, dns 21, fw 29, web 36,
  matching `CSV_ORDER`. The hex-escaped comma survived: `_2` reads
  `Req(allow)%2CRes(allow)`, one column, not two.
- **Naming the columns is what makes the feed recognisable.** After resolving
  DNS and Tunnel, the solution's feed list flipped those two from `not provided`
  to **`provided`**, while Firewall and Web - deliberately skipped - stayed
  unmatched and kept their **Resolve headers** button. That is the reopen path
  and the value of the feature in one screen.
- **`broken_feed` answered honestly**: *"Nothing on these events tells one log
  type from another, so 'broken_feed' is offered as a single log type."*

### `eventsPerSec` is per worker process - a 2x multiplier here

**Corrected 2026-08-26 after measuring it properly.** This section first claimed
~330 events/sec and a multiplier "of something like 80x". That was wrong, and
wrong in an instructive way: it divided a `-24h` count by an ASSUMED ~2h of
runtime, when `zscaler_csv` already held 20.5h of history. Dividing a real
number by a guessed one produces a confident wrong answer, which is the same
defect class this app exists to avoid.

Measured by bucketing `| summarize n=count() by bin(_time, 30m)`, the rate has a
hard changepoint at the moment the config changed:

```
eventsPerSec: 4   ->  8.00 events/sec
eventsPerSec: 1   ->  2.00 events/sec
```

So the multiplier is **2**, which is the worker-process count (inferred - not
confirmed against worker config). Still worth knowing, because the knob is not
what it says: the number to trust is the one you measure off the dataset.

One consequence while reading counts: the drop to 1 happened partway through the
`-24h` window the app queries, so for a day afterwards the Zscaler trio's totals
read roughly 4x higher than the current rate implies and shrink as the old
volume ages out.

Dropped to 1 on all six benches on 2026-08-26, and their Lake retention dropped
from 30 days to **7** the same day. Seven days is all the benches need - the app
queries Lake over `-24h` - and it caps what a continuously-fed lab can
accumulate. The PaloAlto dataset is untouched at 30.

## Sibling bench: the `PaloAlto` dataset, and the origin defect it had

The PAN-OS bench predates this one and is wired differently - datagen
`paloaltorfc5424` -> pipeline `paloalto_loopback_msg` -> a **syslog Destination**
looping back to `127.0.0.1:4514`, which the `PaloAlto` syslog Source receives and
route `paloalto_to_lake` writes to the `PaloAlto` dataset. The loop exists so the
data arrives through a real syslog Source rather than straight off a datagen.

**The defect (fixed 2026-08-26).** A Syslog Destination fills any frame field the
event does not carry from its own config or the local machine. The pipeline lifted
`appname`, `msgid` and `message` out of the inner RFC5424 frame but not HOSTNAME,
so every PAN-OS log in Lake claimed `host=cribl-hw01` / `cribl-hw02` - the Cribl
workers - and PRI was rewritten from the device's `134` (local0.info) to `13` from
the Destination's `facility: 1, severity: 5`. An analyst reading that dataset sees
Cribl as the device.

The pipeline now lifts HOSTNAME, both PRI halves and the timestamp as well, from
a single regex match reused across all fields (it previously re-ran the same
regex once per field). Verified after deploy: a `-6m` window returns **292 events
across 24 distinct device hosts and zero claiming a Cribl worker**, `facility 16`
/ `severity 6` restored, `msgid` still parsing across 11 log types, and `_time`
within ~2 minutes of now so the data stays inside a `-24h` search.

HOSTNAME is taken **verbatim**, including RFC5424 nil (`-`, 2 of the 118 sample
events) and the vendor fixture's literal `<serial-number>` placeholder (7 of 118).
PAN-OS puts the device SERIAL in HOSTNAME, and a nil means the device did not say;
substituting something prettier would be inventing an origin, which is the defect
being fixed.

The Zscaler benches avoid this class entirely by routing datagen -> Lake directly,
with no syslog re-framing hop in between.

## Rebuilding or topping up

`scripts/zscaler-lab/build_samples.py` regenerates the three event sets from the
tables in that file; `scripts/zscaler-lab/cribl.py` carries the API helper (it
reads the bearer from `jphltech/scripts/cribl-token.json` - no credential is
stored in the repo). To change the CSV column orders, edit `CSV_ORDER` - that is
the knob the naming dialog is meant to be tested against.

```bash
cd soc-optimizationtoolkit/scripts/zscaler-lab
python build_samples.py          # writes zscaler_{csv,cef,leef}_events.json
```

Then POST each set with the `context.events` shape above and repoint the
datagen's `samples[].sample` at the new id.
