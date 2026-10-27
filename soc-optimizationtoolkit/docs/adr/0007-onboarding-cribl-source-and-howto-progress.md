# ADR 0007: Azure onboarding How-to progress, read-only Validate, live dataflow, and a create-only Cribl source

Date: 2026-10-26
Status: Accepted - not verified live. Every pin below proves the code; none of
        it has run against a real tenant or a real worker group. The
        live-verification list at the end is what closes AZR-30 to AZR-34.
Invalidates: backlog.md
        backlog.md section 6h records AZR-S2 as "write when connected, export
        when not", with the write "gated on `source.manage`".
        This slice builds the write only, with no export fallback and no
        capability gate (section 9). Section 6g says "do not build a new
        diagram implementation"; this slice lifts the Logging Map's hand-SVG
        canvas into one shared shell and builds the onboarding diagram on it
        (section 8). ADR 0005 is amended in place by an addendum, because the
        drift check reads only documents, not ADRs.

## Context

AZR-18 (ADR 0005) shipped the Azure Native Source Onboarding screen with one
working item, the Defender for Cloud continuous export, automated by the app.
The operator asked for five more things on the same screen (2026-10-26):

- **AZR-30**, a dataflow diagram per source, readable from the Azure side, the
  Cribl side or end to end;
- **AZR-31**, a How-to path for customers who will not let the app write to
  Azure: choose what to onboard, read the instructions in a dialog, tick each
  step when done;
- **AZR-32**, a READ-ONLY check of the Azure configuration;
- **AZR-33**, a new live flow on the diagram once Cribl's metrics show data
  arriving;
- **AZR-34**, the Cribl source (Event Hub or Blob) created by the app, always,
  behind a confirm.

Four existing facts shaped the design:

1. The AZR-18 Event Hub prerequisite picks a SEND-capable rule, because the
   Defender export writes. A Cribl Event Hub SOURCE reads, so it needs a
   LISTEN-capable rule. Reusing the Send rule's key would fail at the broker.
2. `apps/cribl-app/config/policies.yml` declared input creation as not shipped,
   with only the inputs READ granted.
3. Three existing Cribl writers (`wire-source.ts`, `onboard-table.ts`,
   `deploy-flowlog-pack.ts`) treat commit and deploy failures as warnings,
   commit the whole group and report the literal `committed` (DBT-149). None
   of them is a model to copy.
4. The app already had two diagram engines: React Flow in the Dataflow screen
   and hand SVG in the Azure Logging Map (AZR-19). A third was the obvious
   risk.

## Decision

### 1. How-to progress is a SECOND KV document (D1)

Progress lives under the KV key `azure-onboarding-progress`
(`ONBOARDING_PROGRESS_KEY`, kind `azure-onboarding-progress`, version 1), in
`packages/core/src/domain/onboarding-howto/progress-document.ts`. The AZR-18
`azure-coverage-selection` v1 document is byte-for-byte unchanged:
`encodeSelection` strips unknown keys and `inCatalogOrder` drops unknown ids,
so folding progress into it would have been silently erased by the next Save.

`readProgressDocument` copies `readCoverageDocument`'s gate exactly: wrong
kind is `foreign`, any version other than 1 is `unreadable`, and a refused
load is `read-unknown`. A write is allowed only after an `absent` or `ok`
load. Ticks, mode changes and choosing a source each save at once, serialized
through one in-flight promise. Plan values save only on Apply. The selection
document keeps its explicit Save.

**Mount now makes TWO KV loads.** The AZR-18 pin at
`azure-onboarding-screen.dom.test.tsx` was edited deliberately, that one
assertion and its title only, from `[COVERAGE_SELECTION_KEY]` to
`[COVERAGE_SELECTION_KEY, ONBOARDING_PROGRESS_KEY]`. It still asserts zero
Azure and zero Cribl calls on mount.

**Plan values are names and ids only**: subscription, management group,
resource group, namespace, hub, rules, consumer group (default `cribl`, never
`$Default`), region, storage account, container, queue, system topic, network
watcher, flow-log name and the Cribl principal object id. No key and no
connection string is ever stored. A tick stores a fingerprint, the canonical
JSON of the plan values its step depends on, and reads "done against older
values" when they change. The AZR-18 picker is still not seeded from the
plan (AZR-24 stays open).

### 2. A source is Automated or How-to, and Automated is a function

`isAutomatable(id)` is `itemAvailability(id).status === 'available'`, a
function over ADR 0005's `ITEM_AVAILABILITY`, never a stored field. Today
only `defenderExport` is automatable. A stored `automate` mode for any other
id decodes to `manual`. The How-to step catalog is data in
`packages/core/src/domain/onboarding-howto-steps/`, built from the ported
builders and constants, never retyped. A step whose content is inferred
rather than ported carries a visible "not yet confirmed against live Azure"
tag.

### 3. Validate is read-only by construction (D16)

`validateAzureOnboarding` takes the `AzureManagement` port and issues GETs
only; the test fake fails on any other method, and listKeys is never called
(ADR 0005 section 4). Lists are read through the EXISTING `readAllPages` and
`readSingle` in `usecases/read-logging-map/arm-pager.ts`. No third pager was
written.

Each check returns one of `as-expected`, `present-differs`,
`present-other-name`, `absent` or `unknown` with a reason (`denied`, `failed`,
`truncated`, `unregistered`, `unmeasurable`, `missing-value`). `absent` comes
ONLY from a by-name 404 or a complete listing without the item. Defender XDR
streaming is always `unknown: unmeasurable`.

Hub arrival (`IncomingMessages`) is an `ArrivalReading`, not a verdict.
A measured 0 is its own state, "no messages in the window", and is never
folded into unknown or absent.

**Pacing is the caller's, and it is per run.** The screen gains a `pacing`
prop, which App passes as `BATCH_PACING`, and wraps the Azure port with core's
`paceAzureManagement` at 40 requests a minute. Without the prop, Validate is
disabled with "pacing unavailable". The budget is per Validate run and is NOT
coordinated with the Logging Map's 60 a minute or any other screen. Two
screens running at once could exceed either budget.

### 4. The Cribl Event Hub input type is `eventhub` (D8)

`azure_eventhub` is the DESTINATION type; the vendored OpenAPI input enum is
`eventhub`. The input id is `azure_onb_eh_{ns}_{hub}`. The body reads the
Kafka endpoint `{ns}.servicebus.windows.net:9093` with SASL PLAIN, username
`$ConnectionString`, `authType: 'secret'` and `textSecret` naming a Cribl
secret, TLS on, the plan's consumer group, `fromBeginning` and
`sendToRoutes`. It never contains `sasl.password` or `_metadata`. A Basic-tier
namespace has no Kafka endpoint, so the plan refuses it (and refuses an
unknown sku).

The Blob input is type `azure_blob`, id `azure_onb_blob_{account}_{queue}`,
with a backtick-quoted `queueName` JS expression and service-principal
`clientSecret` auth. An account-key connection string is never offered.

**Which hubs a lane reads (D9).** When the emitter names its hub (Defender, or
a diagnostic setting with `eventHubName`), `topics` is that hub. When Azure
creates the hubs itself (Entra, Activity Log, policy), `topics` is only the
expected `insights-logs-<category>` hubs that the last Validate MEASURED in a
fully read hub list. With none measured, the create refuses.

### 5. The credential: a Listen rule, a paste, or nothing (D7)

The secret value comes from one of two places:

- **listKeys** on an operator-picked Listen-capable rule (`ruleCanListen`:
  Listen or Manage), run only inside the confirmed apply. This is the default
  for an Automated source.
- **A pasted connection string**, the default for a How-to source. It is held
  in a React ref, never in state. It is parsed on input into a NON-SECRET
  descriptor `{host, keyName, entityPath}`, and only the descriptor reaches the
  plan.

The plan refuses a paste whose host is not the namespace, whose key name is
not a rule on the namespace, whose rule cannot Listen, or whose EntityPath is
not the lane's one topic. If the rules list cannot be read, it refuses with
`rule-rights-unknown` unless the operator ticks an explicit "This key has
Listen rights" attestation, which the confirm then names. At apply time the
paste is parsed again, and a changed descriptor refuses `pasted-changed`.

**Creating a Listen rule and a dedicated consumer group is NOT built.** It is
a How-to step today and story AZR-36.

### 6. Cribl writes follow claude-kit config-plane-writes, through the kit (D10, D12, D19)

`usecases/create-cribl-source` does not reuse `wire-source.ts` or
`secret-provisioning.ts` (DBT-149, DBT-151, DBT-152).

**PLAN is GETs only:** `GET /system/inputs` (absent, ours-matching, differs or
foreign), `GET /system/secrets/:id` (absent, ours or foreign) and
`GET /version/status`, fed to the kit's `commitScope`. A path the kit cannot
place refuses.

**The confirm** names the group, the input id and type, the secret id, the key
name actually used (or the principal), the attestation if ticked, every file
the commit will carry, and the worker restart. Any change to those disarms it.

**APPLY**, in this order:

1. `GET /version/status` again. If the scope grew, refuse `scope-grew`.
2. Re-check that the secret and the input are still absent.
3. listKeys, or re-parse the paste.
4. `POST /system/secrets` with `secretType: 'text'`. A 409 refuses
   `secret-exists`. It is never PATCHed.
5. Re-list the inputs, then `POST /system/inputs`.
6. The kit's `verifyStored` read-back.
7. The kit's `commitAndDeploy`, unedited: status, commit `{message, files}`,
   status again, HEAD, then
   `PATCH /products/stream/groups/:g/deploy`, falling back to
   `/master/groups/:g/deploy` only on a 404.
8. On `deployed`, the kit's `deployedVersion` (products first, master on a
   404), compared by prefix with `sameCommit`.

**Outcomes** are `created-running`, `created-deployed-unconfirmed`,
`created-not-deployed` (keeping every kit outcome by its own name, plus
`stored-mismatch`, `stored-unreadable` and `commit-sequence-failed`),
`refused` and `failed`. The literal `committed` is never produced. There is no
input PATCH and no DELETE.

A refusal after the secret POST landed carries `leftBehind: {secretId}`, so
the operator is told a secret exists that no input uses, and to remove it in
Cribl if they do not retry. The app never deletes it.

**Commit markers are a guess until measured.** `COMMIT_MARKERS` in
`domain/cribl-onboarding-source/classify-existing.ts` is
`local/cribl/inputs.yml`, `local/cribl/secrets.yml` and
`local/cribl/auth/cribl.secret`. Which files an input create and a secret
create actually dirty is unknown. Until it is measured, a real pending path
outside the list makes the plan refuse as unplaced. That is the safe failure:
it refuses rather than commits a file it cannot name.

**Kit adoption.** `packages/core/src/kit/config-writes/` (readModifyWrite,
commitDeploy, ownership, fakes and the kit test) and
`packages/core/src/kit/metrics/` (metricsQuery, counting) are verbatim copies
recorded in `.claude-kit.json`. The kit's `transport.ts` is NOT copied: its
`systemClock` reads `Date.now` and arms `setTimeout`, which core forbids.
**Core's kit transport therefore diverges from the kit's.** A core-local
`kit/config-writes/transport.ts` holds only the types plus `isOk` and
`abortError`, and the adopted files resolve to it unedited.
`kit/metrics/transport.ts` re-exports it, so there is one transport.
`kit-purity.test.ts` fails if `Date.now`, `new Date(`, a timer,
`Math.random`, `crypto.` or `systemClock` appears in the kit or in the new
onboarding folders. A kitDrift sync that pulled the kit transport back in would
fail that pin.

`kit/cribl-request.ts` maps the kit's `Request` onto the `CriblClient` port:
`/m/<g>/...` binds group g, `/products/...` and `/master/...` are leader-level,
any other path binds the bound group, and with no bound group it resolves
status 0 without reaching the leader. A `?query` suffix is split into
`CriblRequest.query`. `commitDeployTimeouts` lets the two slow kit calls wait
longer than the adapter default; the right value is not measured.

### 7. policies.yml grants exactly what the code calls, and a test holds it (D11)

Added: `/m/:gid/system/inputs` POST (beside GET), `/m/:gid/system/inputs/:id`
GET, `/m/:gid/system/secrets/:id` GET, `/m/:gid/version/status` GET,
`/m/:gid/version` GET, `/m/:gid/system/metrics/query` POST,
`/products/stream/groups/:id/deploy` PATCH and `/products/stream/groups/:id`
GET. The existing `/master` grants stay, as the kit's 404 fallback and for the
older callers.

**Input creation is now shipped, create-only.** The policies.yml header that
said otherwise is rewritten.

`apps/cribl-app/src/platform/policies/policies-coverage.test.ts` checks both
directions against `paths.ts`'s `API_CALLS`: every registered call is
declared, and every declaration is called. `KNOWN_EXCEPTIONS` must EQUAL the
set of `*` entries actually in policies.yml (DBT-153), so a stale or missing
waiver fails. `request-scan.ts` extracts Cribl request paths from the source
and requires each one in `API_CALLS`, telling Cribl calls apart from ARM
builders by an import rule plus a reviewed `MIXED_FILES` list.

### 8. One diagram canvas shell (D13, D14)

The canvas shell moved to `packages/ui/src/components/diagram/`: the pan, zoom
and fit viewport hook (4px pan threshold, 0.55 legible floor), the in-SVG (i)
hit circle drawn as a sibling of the card, the `role=dialog` popover, the card
drag hook (4px threshold, session-only positions, Reset), the measured-only
`AnimatedEdge`, and the pure geometry. It is ported from the claude-kit
cribl-dataflow-diagram reference and from the Logging Map canvas.

**The Logging Map now runs on the shared shell.** It uses the viewport, the
popover and the info circle under its existing, unmodified pins. It does NOT
use drag, so its recorded no-drag deviation (AZR-20) is unchanged. The
onboarding diagram uses the whole shell with its own pure left-to-right
column layout (`dataflow/lane-layout.ts`), one band per source. React Flow
and the Dataflow screen are untouched; that screen's
animate-from-configuration defect is DBT-150.

**Perspectives.** "Azure side" expands the emitter, the transport and the
step cards, and folds Cribl into one card. "Cribl side" folds Azure into one
card carrying the aggregate verdict. "End to end" shows every card except the
steps. A shared namespace or storage account is drawn once per section.

### 9. Live flow is opt-in, measured, and rides the one poller (D15)

A "Watch for data" toggle keeps mount at zero calls. While it is on, the route
is mounted, the document is visible and a group is chosen, one poll registers
through the new `PollRegistry` into App's single `useConsolidatedPolling`
(60s, priority 5, 30 a minute). `main.tsx` wraps `<App/>` in
`PollRegistryProvider` so App's hook sees screen registrations. Each run sends
exactly ONE `POST /m/<g>/system/metrics/query`, splitting `total.in_events`
by input.

The first run asks a cumulative 24-hour lookback; later runs ask a 300-second
window. A failed lookback is retried every fifth run. Lane states are
`flowing` (window row above 0, the ONLY animated state), `idle`, `never seen`
in the lookback actually queried, and `not measured` with a reason
(`waiting`, `no-permission`, `http-error`, `unexpected-shape`, `no-source`,
`lookback-failed`). A 403 is never a zero. The route-to-destination leg is
always "not measured: no counter". The (i) shows the method, path and literal
body.

**AZR-S2 as built.** The app writes the source when connected and builds no
export fallback; the create is not gated on the `source.manage` capability,
so a role without the grant learns it from Cribl's refusal, which surfaces as
a `refused` or `failed` outcome naming the step. Both are departures from
the 2026-08-28 decision in backlog.md section 6h, recorded there.

## What this breaks or constrains

- **The AZR-18 mount pin changed** from one KV load to two.
- **ADR 0005's "not decided here" item "the Cribl Event Hub source (AZR-S2)"
  is superseded** by sections 4 to 7.
- **policies.yml no longer says input creation is not shipped.** Any future
  input write beyond POST needs its own grant, and the coverage test will
  refuse an undeclared one.
- **Core's kit transport is not the kit's.** kitDrift must keep
  `transport.ts` skipped.
- **The Validate budget is per run, not global.**
- **The Logging Map's viewport, popover and info circle are now shared code.**
  A change in `components/diagram/` is a change to both screens.
- **A new paths.ts rule.** A new Cribl call must be added to `API_CALLS` in the
  same commit, or the coverage and request-scan tests fail.

## What is NOT decided here

Filed as cards, not built:

- routing the source to the Sentinel destination, with diagnostic records
  unrolled (AZR-35); the route and destination are only READ today;
- creating a Listen rule and a dedicated consumer group (AZR-36);
- a persisted last-seen beyond the 24-hour lookback (AZR-37);
- one definition of the Defender coverage item id (AZR-38);
- Validate checks for the How-to steps that have no check kind yet
  (AZR-39): `eh-rule-manage` for the diagnostic-setting Manage rule, using
  `ruleCanManage`, and `policy-definition` for the Activity Log and community
  definitions at the management group. Those steps read "confirm by hand"
  until then; the networking step stays confirm-only by design;
- the export fallback and the `source.manage` gate from AZR-S2.

## Live verification (outstanding)

Run by the operator in Cribl Live Preview (`/apps/a/__local__` on the leader).
None of these ran during the build:

1. **Mount** makes exactly two KV loads and no ARM or Cribl call; worker
   groups load only on click. The AZR-18 Defender deploy, picker and Save are
   unchanged.
2. **How-to**: the computed names (CriblDefenderExport, CriblEntraIDLogs,
   Cribl-AU-Central, the system topic, the subscription filter) are right; a
   tick persists across reload; changing the namespace marks the step stale.
3. **Validate** sends only GETs, at no more than 40 a minute. A reader-only
   principal reads Entra as "could not be read", not absent. A Basic namespace
   reads "present but different". A renamed Defender export reads "present
   under another name". A quiet hub reads "no messages in the window". Record
   the real response shapes and api-versions for the aadiam and subscription
   diagnosticSettings, Event Grid, the storage queue, the flow log and
   `IncomingMessages`.
4. **Before any write**: whether `/products/stream/groups/<g>` and its
   `/deploy` answer through the app proxy under the new grants, or 403 or 404;
   which files an input create and a secret create dirty in
   `GET /m/<g>/version/status`, against `COMMIT_MARKERS`.
5. **Cribl source create** (test group, operator present): the paste
   descriptor shows the key name and never the key, and parses a real
   connection string; a Send-only paste refuses "cannot listen" before any
   write; the secret lands with `secretType: text`; the input is `eventhub`
   with no password field; the commit carries only the named files; the deploy
   route taken (products or the master fallback) is recorded; configVersion
   matches the commit by prefix; a repeat reports already applied; a
   hand-edited input refuses and names the field; the commit and deploy
   timeouts are long enough.
6. **Live flow**: one metrics POST a minute while watching; the real answer's
   label form for the new input is captured as a fixture; no animation before
   data; the Azure-to-Cribl hop animates once data arrives; a hidden tab
   pauses; a role without the metrics grant reads "not measured: no
   permission".
7. **Blob**: Cribl accepts the backtick `queueName` expression, and a new
   flow-log blob lights the lane.
8. **Logging Map regression**: zoom, fit, the (i) popovers and no-drag are
   unchanged after the shell migration.

AZR-30 to AZR-34 close only after this pass, with `verified` set to `live` or
`both`.
