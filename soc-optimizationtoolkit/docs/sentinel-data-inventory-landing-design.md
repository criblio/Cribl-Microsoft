# Sentinel Data Inventory as the app's landing page, driven by an ATT&CK heat map

Status: Proposed - the app opens on an ATT&CK coverage heat map of the Sentinel workspace's data,
and every onboarding page is reached from a coverage gap; not yet planned or built.
Last-confirmed: 2026-11-11

## Intent

Today the app opens on a journey of tools (Dataflow, Setup, Sentinel Integration, DCR Automation,
...), and the operator has to know which tool to pick. The operator decided (2026-11-11) to open
the app on WHAT THE WORKSPACE CAN DETECT instead: an ATT&CK heat map built from the data the
Sentinel workspace already ingests. A red tactic is the question; the ranked list of sources that
would close it is the answer; each source opens the page that onboards it. The tools stay, but
they are reached from a gap rather than from a menu.

This is the same pattern as the Azure Native Source Onboarding inventory heat map
(`docs/tenant-inventory-heatmap-design.md`): show what exists first, act from the gap. The Data
Volume Inventory page becomes this landing page under the name Sentinel Data Inventory (board epic
SDI; SDI-1 rename, SDI-2 heat map).

## Goals

1. The app's landing page is Sentinel Data Inventory: volume, allowances and ATT&CK coverage of
   the same workspace data.
2. Coverage reads by tactic, drills to technique.
3. A technique that is not covered lists EVERY source that would cover it, ranked by coverage
   added, and each source links to the page that onboards it, opened on that source.
4. Before Azure and Sentinel are connected, the landing page is a setup prompt, not an empty map.

## Non-goals

- Writing or enabling analytics rules from this page (Sentinel content install is its own page).
- Replacing the other pages; they remain in the nav.
- Live fetching of ATT&CK at runtime.

## Anti-goals

- Red for something the app could not read. Unreadable tables, an unreadable workspace or rule
  list make the affected tactic or technique blue ("could not check", with the reason), never red
  (claude-kit `inventory-honesty.md`).
- A ranked list that recommends a source the customer already ingests, or one the app cannot say
  how to onboard.
- A landing page that issues expensive reads (Log Analytics queries, Search jobs) on every open.

## Decided by the operator (2026-11-11)

- **Landing page:** Sentinel Data Inventory is where the app opens.
- **Heat map:** one card per ATT&CK tactic, coloured by coverage; click to drill into techniques.
- **Click target, example:** red on Credential Access leads to Entra ID onboarding (Azure Native
  Source Onboarding opened on the Entra ID tile with the missing sign-in log types selected).
- **Several candidate sources:** show them ALL, ranked by coverage added.
- **The Data Volume Inventory stays, whole.** Its By table and By source views, the allowance cards
  (Free, E5, Defender for Servers P2), the tenant-wide allowance comparison and every drill-down
  remain on the Sentinel Data Inventory page. Nothing of MIG-F2 / MIG-F3 is removed by the rename
  or the landing change. (Designer call on placement: the ATT&CK heat map is the first view and the
  volume views sit beside it as views of the same page; a technique tile and a ranked source can
  link into the volume view of the tables it names.)
- **First visit:** a setup prompt to connect Azure and Sentinel first.
- **ATT&CK data:** pulled from MITRE's official `mitre-attack/attack-stix-data` bundles (see SDI-2
  for the research, including the 2025 move from data-component "detects" edges to detection
  strategies and analytics).
- The mockup `landing-attack.html` (brainstorming session, not committed) was approved as the
  shape: setup card on first visit; header stats; tactic cards with "n of m" techniques; technique
  tiles; a ranked source table with techniques added (in tactic / overall), estimated volume, and a
  button per source to the page that onboards it.

- **Two views, not one verdict (2026-11-11).** (1) DATA VIEW: are the data sources onboarded that
  are needed to detect the technique? (2) DETECTION VIEW: is a detection rule available AND enabled
  that uses that data to detect it? The heat map switches between them.
- **No false sense of security.** One detection rule over a limited dataset does not make a
  technique "covered". Coverage is graded, not binary, and the grading method is to be taken from
  how established ATT&CK coverage mappings score it - research first (in progress), then decide.
- **Microsoft built-in detections count** (Defender XDR, Defender for Identity, Fusion, UEBA),
  labelled "Microsoft built-in" so a tile says where its detection comes from.
- **The ranked source list is a curated set** in the first release: Azure native log types,
  Windows Security Events, the Defender XDR tables and a short list of common third-party
  products, each with a working link to the page that onboards it.
- **The technique count is filtered by the platforms the operator runs** (Windows, Linux,
  Azure/IaaS, SaaS, Identity Provider, Office Suite), chosen at setup, defaulted from what the
  workspace ingests.

- **Onboarded data and an active detection are both shown**, each graded, and the tile navigates to
  the rules and to the volume view of the tables behind the grade.
- **Questions on the tiles, where the app is blind** (data outside Sentinel, another SIEM, an EDR
  console, data only in Cribl Lake / S3). Answers are stored with who and when, and ONLY feed the
  ranked "would close this gap" list: a source the operator says they already have is no longer
  recommended. Answers never change a tile's measured grade.
- **Answers expire after 90 days (2026-11-11).** Each answer carries "answered by <name> on
  <date>, review by <date>". An expired answer's source returns to the ranked gap list as "your
  answer from <date> expired - still true?" with Confirm / Change, and the landing page counts the
  answers due for review. The same review surfaces measured drift since the last review (e.g. a
  rule whose data stopped arriving).

## Grading (from the 2026-11-11 research; designer's synthesis, open to change)

Research record: DeTT&CT 2.2.0 visibility 0-4 and detection -1..5 scales and its data-quality
dimensions; ATT&CK v18 detection strategies -> analytics -> log sources (a per-technique data
requirement); Sentinel's MITRE page counts active rules by their own technique tags and does not
check that their tables receive data; CTID Summiting the Pyramid and Mappings Explorer reject a
binary covered/uncovered; Splunk Security Essentials separates Active / Available / Needs data and
says coverage is not completeness. Sources are listed in the SDI-2 card.

- **Ordinal grades, never a tick or a percentage on a tile.** Each tile names the factor that
  capped it. Sub-technique grades roll up to the parent with MIN.
- **Data view:** No data / Context only / Partial visibility (n of m platforms) / Broad. Required
  data comes from ATT&CK v18 analytic log sources translated to Sentinel tables by a curated asset
  the app ships. A table counts only when it ingested recently and has volume; "Broad" stays
  "Broad, scope unknown" unless host completeness is computed or known.
- **Detection view:** None / Available - not enabled / Rule enabled - data missing (red: the broken
  rule case) / Basic (one rule) / Multi-signal / Validated (only with test or emulation evidence).
  Microsoft built-in detections are a separate "vendor detection" marker that never lifts a tile
  above Basic, because their logic and scope are not inspectable.
- **Words to use:** "No data", "Context only", "Partial visibility", "Available - not enabled",
  "Rule enabled - data missing", "Basic detection", "Multi-signal", "Validated". **Never**
  "Covered" or "Protected". Every tile's info says the mapping is by rule tag and not validated.

## Calls made by the designer (open to change)

- **Sub-techniques roll up to their parent** for the cards and the count; the parent tile lists them.
- **One workspace on the landing page**, chosen at setup, with a tenant selector for multi-tenant
  customers (ADR 0009). The first read runs once automatically after setup, then results are cached
  in the app's KV store (shared across users) with a "read at" stamp and a Refresh button.
- **Colour thresholds** follow the grading the research settles on, not a fixed share.
- **Estimated volume beside each ranked source**, so coverage can be weighed against cost; "unknown"
  when the app has no estimate.
- **The ATT&CK version is pinned** in the build and shown in the header; updating it is a deliberate
  change with its own PR.
- **The rest of the nav stays.** Only the landing route and the way onboarding pages are reached
  change. Existing route ids stay so links keep working (SDI-1's call).
- **Deep links carry a selection.** Each onboarding page accepts "open on source X with log types Y"
  so the click lands ready to act; a page that cannot take a selection yet opens at its top with a
  banner naming what was asked for.

## The source catalogue the ranking needs

Ranking needs, per source the app can onboard: which ATT&CK techniques it supports, which page
onboards it, and a volume estimate. Destinations named in the mockup:

| Source (example) | Onboards on |
|---|---|
| Entra ID sign-in and audit log types | Azure Native Source Onboarding (Entra ID tile) |
| Azure Activity Log, Defender for Cloud, resource logs | Azure Native Source Onboarding |
| Windows Security Events | DCR Automation (and the planned Windows Events screen) |
| Defender XDR tables (e.g. IdentityLogonEvents) | XDR streaming How-to |
| Third-party products (e.g. Okta) | Sentinel Integration |

## Where the facts come from

| Fact | Exists today? |
|---|---|
| Tables carrying data and daily volume | yes (Data Volume Inventory) |
| Analytics rule tactics and techniques | yes, parsed (`domain/coverage-analysis`, `domain/siem-migration`) |
| Rules enabled in the workspace | to check: the app parses rule content; whether it reads the workspace's ENABLED rules is unconfirmed |
| ATT&CK tactics, techniques, detection strategies | no - pull from attack-stix-data (SDI-2) |
| Technique-to-source catalogue for the ranking | no |
| Connection and setup state | yes (Setup, connection profiles) |

## Assumptions not yet true

- **Inferred:** that ATT&CK detection strategies / analytics / log sources can be mapped to Sentinel
  tables well enough to say "this table can detect this technique". Microsoft does not publish
  such a mapping as data; building it is the main cost of the "possible coverage" layer.
- **Unmeasured:** how expensive it is to read enabled rules and table activity on every landing
  page open; the page must use cached results with a "read at" stamp.

## What would make this wrong

- The technique-to-source mapping proving too unreliable to rank on; then the ranked list must fall
  back to rule-based coverage only (sources that the shipped Sentinel content's rules query).
- An operator decision that the landing page should stay a tool menu.

## Board impact

- Extends epic SDI: SDI-1 (rename) and SDI-2 (heat map) stand; new cards for the landing route,
  the first-visit setup prompt, the ranked source list and its catalogue, and deep-link selections
  on each onboarding page.
- The Azure tenant inventory heat map is one of the pages this lands on.
