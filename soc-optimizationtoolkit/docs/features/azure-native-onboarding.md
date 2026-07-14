# Feature Plan: Azure Native Source Onboarding (content-preserving)

Status: Proposed (plan only, no code)
Author-context: derived from a verified research digest, 2026-07-02
Related: [feature-catalog.md](../feature-catalog.md), [roadmap.md](../roadmap.md), [ADR-0001 dual-target architecture](../adr/0001-dual-target-architecture.md)

## Summary

An "easy button" that onboards an Azure-native diagnostic-settings source (the flagship example is Microsoft Entra Non-Interactive Sign-in logs) through Cribl Stream into Microsoft Sentinel, while keeping the downstream Sentinel content that assumes the native table (analytics rules, workbooks, hunting queries, parsers, UEBA) working. Today this is painful manual refactoring: the moment a native source is rerouted through a pipeline it lands in a custom `_CL` table, the physical table name diverges from what every out-of-the-box detection queries, and that content silently stops matching. This feature automates both the ingestion wiring and the content-compatibility work, choosing the cleanest available path per table and previewing the impact before anything changes.

This document is a plan, not an implementation. It carries the caveats from the research digest verbatim where the underlying facts are version-sensitive or unverified; those caveats are load-bearing and must not be smoothed over in the build.

---

## 1. Problem statement

Microsoft Entra ID emits its highest-volume security telemetry through diagnostic settings: sign-in logs (interactive, non-interactive, service-principal, managed-identity) and audit logs. Normally these flow through the built-in Entra -> Sentinel connector straight into Microsoft-defined native tables. A SOC that wants pre-ingestion volume reduction, cheaper tiers, or vendor-neutral routing reroutes the diagnostic setting to an Event Hub and interposes Cribl Stream. That reroute breaks a subtle contract.

**The native tables cannot be written back to through an external pipeline.** The Logs Ingestion API + Data Collection Rule (DCR) model can only target tables on Microsoft's published "Supported tables" list. As of the `logs-ingestion-api-overview` snapshot read for this plan (page date 2025-06-16, content updated 2026-06-03), **no** Entra identity table is on that list - not `SigninLogs`, `AADNonInteractiveUserSignInLogs`, `AADServicePrincipalSignInLogs`, `AADManagedIdentitySignInLogs`, nor `AuditLogs`. Microsoft states the list "may be added to," so this is explicitly version-sensitive, but today those tables are not ingestible via the API. Cribl's own native Microsoft Sentinel destination reflects the same constraint: it writes to any custom table but to only four built-in tables (`CommonSecurityLog`, `SecurityEvent(s)`, `WindowsEvent(s)`, `Syslog`).

So rerouted sign-in data must land in a custom `_CL` table (`SigninLogs_CL`, `AADNonInteractiveUserSignInLogs_CL`, ...) whose schema the operator authors. Two categories of breakage follow, and both are silent - queries return zero rows rather than erroring:

- **Name breakage.** Microsoft's out-of-the-box Entra content (analytics rules, NRT rules, hunting queries, workbooks, parsers) references the native table names *literally*. A query written `AADNonInteractiveUserSignInLogs | where ...` returns nothing against `AADNonInteractiveUserSignInLogs_CL`.
- **UEBA / entity-analytics breakage.** The Sentinel UEBA engine consumes a fixed set of *named* native tables as its Entra inputs (`SigninLogs`, `AuditLogs`, `AADServicePrincipalSignInLogs` (preview), `AADManagedIdentitySignInLogs` (preview)). Data diverted into `_CL` tables is not picked up; identity behavioral baselines, `BehaviorAnalytics`, and entity enrichment are simply not produced. **UEBA cannot be redirected at all** - this is a hard limit the feature must surface, not hide.

A naming nuance the tooling must encode: the diagnostic-setting *category* identifier and the destination *table* name are not the same string. Sign-in categories gain an `AAD` prefix on the table, with two exceptions:

| Diagnostic category | Sentinel table |
|---|---|
| `AuditLogs` | `AuditLogs` (no prefix) |
| `SignInLogs` | `SigninLogs` (note: table is lowercase "i") |
| `NonInteractiveUserSignInLogs` | `AADNonInteractiveUserSignInLogs` |
| `ServicePrincipalSignInLogs` | `AADServicePrincipalSignInLogs` |
| `ManagedIdentitySignInLogs` | `AADManagedIdentitySignInLogs` |
| `ProvisioningLogs` | `AADProvisioningLogs` |
| `RiskyUsers` | `AADRiskyUsers` |
| `NetworkAccessTrafficLogs` | `NetworkAccessTraffic` |
| `MicrosoftGraphActivityLogs` | `MicrosoftGraphActivityLogs` |

The five most security-relevant for the SOC use case are `AuditLogs`, `SigninLogs`, `AADNonInteractiveUserSignInLogs`, `AADServicePrincipalSignInLogs`, `AADManagedIdentitySignInLogs`.

The goal of this feature: make the reroute a guided, reversible action that either preserves the native table outright (when possible) or automatically installs the compatibility shim that keeps content working (when not) - and always shows the operator exactly what content is affected before committing.

---

## 2. Two ingestion modes, auto-selected

The app selects the ingestion mode per target table by consulting a native-table catalog that records, for each table, whether it is currently on the Logs Ingestion API supported-tables list.

### Mode A - DCR into the native table (the clean path)

When the target table is supported by the Logs Ingestion API, the app builds a Direct DCR whose `outputStream` is `Microsoft-<TableName>` and whose `transformKql` reshapes the incoming stream to the fixed native schema. Data lands in the real table with its real name and schema; **no downstream content refactor is needed** because nothing about the table changed from the content's point of view. This is exactly the stream declaration that the existing `schema-mapping` core module already emits for native tables (`buildStreamDeclaration` -> `outputStream: "Microsoft-{table}"`, `transformKql: "source"`).

Constraints Mode A must respect:
- Native/built-in tables have **fixed schemas**. The transform output schema must match the destination exactly: omitted columns are stored empty, extra columns must be excluded, you may only add custom columns carrying a `_CF` suffix, and the names `_ResourceId`, `id`, `_SubscriptionId`, `TenantId`, `Type`, `UniqueId`, `Title` are reserved.
- Being on the supported-tables list is necessary but **may not be sufficient**: see the biggest open risk in section 8 - it is unverified whether the Microsoft-managed Entra identity tables accept a custom `Kind:Direct` DCR inbound stream even if they were added to the list. Mode A is the intended path for tables that are genuinely ingestible (e.g. `CommonSecurityLog`, `SecurityEvent`, `Syslog`, `WindowsEvent`, the ASim* tables); for the Entra flagship it is currently unavailable and the app must fall through to Mode B.

Do **not** conflate "tables that support transformations" (a broad set, used by workspace-transformation DCRs on data already arriving natively) with "tables supported by the Logs Ingestion API" (a narrow set, the only valid direct-ingestion targets for externally pushed data). Rerouting through Cribl is the latter scenario, so transformation-support does not help.

### Mode B - custom `_CL` table + generated KQL function-alias (the refactor-avoidance path)

When native ingestion is unsupported (the Entra case today), the app creates a custom `_CL` table with a schema that mirrors the native columns, then generates a **KQL function-alias** so downstream content keeps resolving the native name.

A Log Analytics/Sentinel "function" is a saved KQL query stored as a `savedSearch` resource (`Microsoft.OperationalInsights/workspaces/savedSearches`) with `properties.functionAlias` set. When the alias equals the native table name and the function body reads the `_CL` table and `project`/`extend`-renames every type-suffixed custom column (`_s`/`_d`/`_g`/`_b`/`_t`) back to the native column name and type, a legacy query written `AADNonInteractiveUserSignInLogs | where ...` transparently resolves to the function, which reads `AADNonInteractiveUserSignInLogs_CL`. This is the same mechanism ASIM parsers use, pointed at one custom table and projecting to the native (not ASim) schema. Native Sentinel table names contain no spaces or underscores, so they are legal function aliases (Azure Monitor forbids a leading underscore, reserved for solution functions).

**The table-vs-function name-collision rule is the critical constraint.** Per Kusto, "if a stored function and a table both have the same name, then any reference to that name resolves to the stored function, not the table" - so the function wins, and `table("Name")` forces the real table. But in Log Analytics/Sentinel practice this is *not* something to rely on blindly:

- Sentinel actively resists registering a function whose alias equals a *currently existing* real table; the known-issues guidance notes Log Analytics errors when more than one function is created with the same name, and community reports indicate the create may be rejected or the table may shadow the function. **This behavior is inconsistently documented and MUST be empirically tested in the target workspace before the app depends on it.**
- Even where the function wins, if the native table still holds data (partial reroute, retained history), a function that reads only the `_CL` table would *hide* the residual native rows and silently change results.

Design rule that follows: **the function-alias shim is only clean when the native table is genuinely empty or absent** (data 100% rerouted, no legacy rows, table never provisioned). If both the native and custom tables can hold relevant data, the generated body must `union` them (`union isfuzzy=true (<native rows>), (AADNonInteractiveUserSignInLogs_CL | project-rename ...)`), and the app must validate that the workspace actually accepts the alias registration before relying on it.

**ASIM as the Microsoft-blessed alternative.** For sign-in/authentication content the app can instead register a source-specific ASIM parser rather than a name-alias. Sign-ins map to the ASIM **Authentication** schema, whose unifying parser is `_Im_Authentication` (parameter-less `ASimAuthentication`) - note there is no parser literally named `imSignin`. The app authors a custom `vimAuthentication<Vendor><Product>` that reads the `_CL` table and maps to the Authentication schema, then registers it in the (editable) custom unifying parser. Content written against `_Im_Authentication`/`ASimAuthentication` then works unchanged because it queries normalized field names and is table-name-independent. The trade-off: ASIM only helps content that was already written to ASIM; a large amount of legacy/OOTB content still references raw native tables and needs the function-alias or a rewrite. It is also unverified whether the built-in ASIM Authentication parser already covers the non-interactive table specifically (vs only interactive `SigninLogs`), so a custom source-specific parser may still be required.

### Auto-selection logic

```
resolve target table from diagnostic category (AAD-prefix mapping)
if table is on the Logs Ingestion API supported-tables list (catalog lookup)
   AND validated DCR-ingestible for a Kind:Direct custom inbound stream:
      -> Mode A (native DCR, no content work)
else:
   -> Mode B (custom _CL table)
      choose compatibility layer:
        - ASIM parser   if the schema has an ASIM unifying parser and content is ASIM-based
        - function-alias if content references the raw native name (default for Entra today)
      require: native table empty/absent OR generate a UNION body
```

The supported-tables membership check is a **version-sensitive lookup**: the catalog encodes a snapshot and must be refreshable, and the app should prefer a live check where an API affords one rather than trusting a stale bundle.

---

## 3. The content-reconciliation engine

Whichever mode is chosen, the app must show the operator what downstream content references the onboarded table and whether it will keep working. The engine enumerates Sentinel content via the Sentinel/ARM REST surface, scans each item's KQL for the native table name, and produces a reconciliation worklist.

Content types and where their KQL lives (all enumerable via ARM/REST so an app can inventory them):

| Content type | ARM resource | Where the KQL is |
|---|---|---|
| Scheduled + NRT analytics rules | `Microsoft.SecurityInsights/alertRules` | `properties.query`; `kind` = `Scheduled`/`NRT` |
| Hunting queries | `Microsoft.OperationalInsights/workspaces/savedSearches` | `properties.query`; `properties.category = "Hunting Queries"` |
| Parsers / workspace functions (incl. ASIM) | `savedSearches` | `properties.query`; identified by `properties.functionAlias` being set |
| Workbooks | `Microsoft.Insights/workbooks` | KQL embedded inside `properties.serializedData` JSON (must be parsed out) |
| Playbooks | `Microsoft.Logic/workflows` | KQL inside Log Analytics connector action definitions in the workflow JSON |
| Watchlists | `Microsoft.SecurityInsights/watchlists` | referenced from other content via `_GetWatchlist('alias')` |

The engine:
1. Enumerates each content type via its REST endpoint (pin/confirm the api-version per type - see risks).
2. Extracts the query string(s), including the buried cases (workbook `serializedData`, playbook workflow JSON).
3. Runs a text/AST scan of each query for references to the onboarded native table name (Kusto has no built-in "find all references to table X" API, so this is a scan over the extracted strings).
4. Builds a reconciliation worklist, classifying each hit as: **covered by function-alias/ASIM** (no rewrite needed), **needs guided rewrite** (point at the `_CL` table and reconcile column/type differences), or **UEBA-bound** (cannot be redirected - flag and warn).
5. **Previews the impact** to the operator before any change, and supports **rollback** (the alias/parser is a discrete `savedSearch` resource that can be deleted; rewrites are staged and reversible).

The app reuses the existing analytics-rule coverage analyzer (ENG-11: loads a solution's analytics rules, extracts KQL fields, computes per-rule covered/missing field coverage against a destination schema) as the proof that analytics rules survive onboarding. The other content types (hunting queries, workbooks, parsers, playbooks) have **no** existing analyzer and are net-new (see sections 5 and 6).

---

## 4. End-to-end flow

The chain is: **diagnostic setting -> Event Hub -> Cribl source -> pipeline -> Sentinel destination via DCR.**

1. **Diagnostic setting (Azure-side, not a Cribl call).** Attach a tenant Entra ID (`microsoft.aadiam`) diagnostic setting selecting the desired categories (e.g. `NonInteractiveUserSignInLogs`, `SignInLogs`, `AuditLogs`) and stream them to an Event Hub. Logs arrive as JSON in an envelope of the form `{"records":[ {...}, {...} ]}`. This is exactly what LOG-07 automates today.
2. **Event Hub.** An Event Hub namespace with the `RootManageSharedAccessKey` policy so Azure auto-creates the per-category hubs (`insights-logs-noninteractiveusersigninlogs`, `insights-logs-signinlogs`, ...). LOG-03 deploys this; EVH-04 can discover which hub a given diagnostic setting lands in.
3. **Cribl source.** An "Azure Event Hubs" source - OpenAPI schema `InputEventhub`, `type="eventhub"` (Kafka protocol: `brokers = <ns>.servicebus.windows.net:9093`, `topics = <hub>`, SASL PLAIN with username literally `$ConnectionString`, TLS on). An AMQP variant (`InputEventhubAmqp`, `type="eventhub_amqp"`) also exists; which is preferred is version/namespace-dependent. LOG-16 already emits a complete Cribl Event Hub source config with a secret reference.
4. **Pipeline (net-new content).** Functions to unroll the `{"records":[...]}` envelope and JSON-parse each record, then **normalize the camelCase diagnostic property bags into the target table schema** (Mode A: the native `Microsoft-<Table>` schema; Mode B: the `_CL` schema), plus **optional volume reduction**: drop/sample the noisy non-interactive sign-ins, suppress repetitive successful token refreshes, trim low-value fields, dedupe. The exact function chain is design-dependent and is not prescribed by the repo or the spec.
5. **Sentinel destination.** Cribl `sentinel` destination - OpenAPI schema `OutputSentinel`, `type="sentinel"`, posting to the Logs Ingestion API against the DCR. Key fields: `endpointURLConfiguration` (`ID` recommended), `dcrID` (immutable id), `streamName` (must match the DCR stream exactly, e.g. `Custom-<Table>`), `dceEndpoint`, OAuth `loginUrl`, `client_id`, `secret`, `scope = https://monitor.azure.com/.default`. The ingestion app registration needs `Monitoring Metrics Publisher` on the DCR; `Kind:Direct` DCRs (Cribl Stream 4.1.4+; repo automation notes 4.14+) need no standalone DCE unless the workspace is private-endpoint-restricted. DCR-27 already generates this destination JSON (secret intentionally left as `<replace me>`); ENG-28 can POST it to the Cribl product API (`POST /system/outputs`).

**Volume-reduction value proposition.** Non-interactive sign-in logs are the largest Entra category, driven by client apps and OS components acting on behalf of users, largely outside admin control, and they grow uncontrollably - expensive at Sentinel per-GB pricing. Interposing Cribl lets the SOC filter, sample, suppress, trim, and dedupe before ingestion, so Sentinel receives a smaller, higher-signal dataset, while Cribl can simultaneously fork a full-fidelity copy to cheap storage (Cribl Lake / Blob) for compliance and can target lower-cost Sentinel tiers via custom DCR tables. This reduction is the entire reason to reroute, and it is precisely why the content-preservation problem in sections 1-3 exists.

---

## 5. Composition with existing capabilities

The end-to-end chain assembles almost entirely from building blocks that already exist in the repo (as PowerShell/TS references) and the `@soc/core` domain modules already ported. Per the redesign-first principle (ADR-0001), legacy code is a capability reference and edge-case archive, not an implementation to transplant.

**Source / diagnostic-settings half (reuse):**
- LOG-07 `Deploy-EntraIDDiagnostics.ps1` - deploys the tenant Entra diagnostic setting; its HighVolume profile already includes `NonInteractiveUserSignInLogs`, the flagship example.
- LOG-03 `Deploy-EventHubNamespaces.ps1` - Event Hub namespace so Azure auto-creates the per-category hubs.
- LOG-16 `Generate-CriblEventHubSources.ps1` - emits the Cribl Event Hub source config with SASL/secret references.
- EVH-03/EVH-04/EVH-06 - Resource Graph inventory of namespaces/hubs, discovery of which hub a diagnostic setting targets, consumer-group/auth-rule enumeration to seed the source.
- ENG-13 `source-types.ts` - the `azure_event_hub` source definition with `azure_ad`/`azure_diagnostics` presets and `generateInputsYml`.

**DCR / native-table half (reuse):**
- DCR-06..DCR-16 `Create-TableDCRs.ps1` - the native-table DCR engine: schema retrieval that refuses `_CL` matches in native mode, column filtering, ARM template gen with the `Custom-`/`Microsoft-` stream rule, DCE, deploy.
- `@soc/core` `schema-mapping` (`packages/core/src/domain/schema-mapping/schema-mapping.ts`) - `mapColumnType` (DCR-08), `selectSchemaColumns`, `buildDcrColumnSet` (DCR-09), and `buildStreamDeclaration` which emits `outputStream: Microsoft-{table}` + `transformKql: "source"` for native tables. This directly produces the schema-preserving native DCR (Mode A). Plus `normalizeCustomSchemaColumns`/`stripReservedTableCreationColumns` for the `_CL` variant (Mode B). This is a compatibility contract pinned by characterization tests.
- `@soc/core` `dcr-naming` (`dcr-naming.ts`) - `generateDcrName`, the byte-faithful 30/64-char DCR/DCE naming port (DCR-10), works for native and custom.
- AST-01/AST-02 - 100 prebuilt native-table DCR ARM templates (incl. 10 ASim tables) whose embedded `streamDeclarations` double as an offline native-schema catalog. **Gap:** the Entra sign-in native tables (`SigninLogs`, `AADNonInteractiveUserSignInLogs`, `AADServicePrincipalSignInLogs`, `ADFSSignInLogs`) are **not** in that census, so the flagship DCR must be generated dynamically from a live Log Analytics schema query (DCR-07), not pulled from a template.

**Cribl destination half (reuse):**
- DCR-27 `Generate-CriblDestinations.ps1` (+ DCR-25/26/28/29) - Cribl `sentinel` destination generator from a deployed DCR.
- ENG-28 `auth.ts` Cribl config API client - create sources/outputs/secrets/routes via the Cribl REST API.

**Content-preservation half (partial reuse):**
- ENG-11 `pack-builder.ts` rule-coverage (backed by `sentinel-repo.ts` `listAnalyticRules` + `extractKqlFields`) - analytics-rule field-coverage analysis; the mechanism to prove analytics rules survive.
- ENG-12 `kql-parser.ts` - `parseDcrJson`/`parseTransformKql` + `analyzeDcrGap` (passthrough / DCR-handled / Cribl-must-handle) + route-condition generation; reusable to reshape the diagnostic payload and derive the Cribl transform/route.
- ENG-42 `preIngested` flag - detects already-Sentinel-schema data (Entra diagnostic logs are close to, but not identical to, native schema).

**Cross-cutting core modules (reuse as-is):** `azure-permissions` (`hasEffectiveAction` + `REQUIRED_ACTIONS['existing-rg']` already lists `dataCollectionRules/write`, `workspaces/tables/write`, `deployments/write` - the deploy preflight for this feature); `azure-config`, `azure-profiles`, `connection-invalidation`, `azure-resource-id`.

**What is genuinely net-new:**
1. **Native-table catalog with an ingestion-support flag** - the category->table->schema map plus the version-sensitive Logs Ingestion API supported-tables membership. No such catalog exists (AST covers 50 tables and none of the Entra sign-in tables).
2. **Diagnostic-envelope-to-native-schema reshape** - a Cribl pipeline/transform that unrolls the `records[]` camelCase envelope into the `Microsoft-<Table>`/`_CL` schema. Existing pipeline generation (ENG-01) is CEF/CSV/vendor-oriented; ENG-12/ENG-42 only detect/flag pre-ingested data, they do not map the Azure diagnostic envelope.
3. **Function-alias / ASIM-parser generator** - no existing module emits a `savedSearch` `functionAlias` shim or a `vimAuthentication` parser.
4. **Content-reference analyzer beyond analytics rules** - ENG-11 covers analytics rules only; workbooks, hunting queries, parsers, and playbooks have no analyzer.
5. **The composed orchestration** - no single "diagnostic-settings source -> Cribl Event Hub source -> native-table DCR destination -> Sentinel" orchestrator exists. The halves are all present but unwired; ENG-39 `e2e-orchestrator.ts` is built for the vendor/custom-table/field-matcher pack path and needs a new native-preservation branch. LOG-16 emits an Event Hub source but does not wire its routing to a Sentinel native-table DCR destination - that routing glue is net-new.

---

## 6. Proposed architecture

Follows the workspace discipline in CONTEXT.md and ADR-0001: pure, testable domain logic in `@soc/core`; port interfaces are the only seam; every capability ships to BOTH targets (cloud app + local Node host); compatibility contracts pinned with characterization tests; redesign-first (harvest legacy edge cases as test cases, design fresh against platform primitives); no emojis.

### New `@soc/core` domain modules (pure, zero IO, zero fetch, zero React)

- **`native-table-catalog`** - maps diagnostic-setting category -> Sentinel table (encoding the AAD-prefix rules and the `SignInLogs` -> `Signin` and `AuditLogs` no-prefix exceptions), holds the native column schema per table, and carries an `ingestionSupported` flag derived from a version-pinned snapshot of the Logs Ingestion API supported-tables list. Refreshable; the flag is explicitly time-sensitive and the module must make the snapshot date first-class so callers can warn on staleness.
- **`table-alias-kql`** - generates the function-alias shim: the `savedSearch` body that projects `_CL` type-suffixed columns (`_s`/`_d`/`_g`/`_b`/`_t`) back to native column names and types, preserving `TimeGenerated`, and decides union-vs-replace from whether the native table retains data. Emits the deployable `savedSearches` resource shape (`functionAlias`, `query`, `category`, `version`). A sibling generator emits the ASIM `vimAuthentication<Vendor><Product>` variant for the Authentication schema.
- **`content-reference-analyzer`** - given a set of extracted content items (each a `{type, id, queries[]}` record produced by the api layer) and a target table name, scans the KQL for references and classifies each as covered-by-alias / needs-rewrite / UEBA-bound; produces the reconciliation worklist and the preview/rollback plan. Pure text/AST scanning; no IO.
- **`native-onboarding-planner`** - the composition brain. Takes a selected diagnostic category + target workspace/schema and produces an ordered plan: diagnostic-setting spec, Event Hub/source spec, DCR + (native or `_CL`) table spec, Cribl pipeline+destination spec, and the content-reconciliation actions. Runs the Mode A/B auto-selection using `native-table-catalog`. Reuses `schema-mapping`, `dcr-naming`, and `azure-permissions` rather than duplicating them.
- **`diagnostic-envelope-mapping`** (may fold into the pipeline-generation domain) - the pure spec of how the Azure `records[]` camelCase envelope maps to the destination schema, driving the generated Cribl pipeline functions and the optional reduction rules for noisy non-interactive sign-ins.

### API clients (adapter layer, behind ports)

Written against the existing `AzureManagement`, `GraphClient`, and `CriblClient` ports so both shells bind their own transport (cloud proxy vs local Node host):
- Sentinel/ARM content clients: `alertRules` (SecurityInsights), `savedSearches` (Log Analytics - hunting queries + parsers + the alias shim deploy), `workbooks` (Insights, parse `serializedData`), `workflows` (Logic, parse query actions), `watchlists`. Pin/confirm api-versions per type.
- Cribl product API: source (`POST /system/inputs`), pipeline (`POST /pipelines`), destination (`POST /system/outputs`), plus commit/push/deploy in distributed mode - reusing the ENG-28 client pattern.

### UI feature folder (`packages/ui`)

A guided "Onboard an Azure native source" flow: pick category -> preview mode selection and the content-reconciliation impact -> confirm reduction options -> deploy -> validate. Shares screens across both targets; performs no IO directly (consumes ports via context).

### Discipline carried from existing docs
- Dual-target: works in `apps/cribl-app` AND `apps/local-app`; cloud-specific limits (30s proxy timeout -> polled DCR deploys, 100 req/min -> batched content enumeration, write-only encrypted KV -> server-side secret injection) shape the shared design.
- `schema-mapping`/`dcr-naming` remain compatibility contracts with characterization tests; the new alias/parser generators get characterization vectors too once a canonical shim shape is agreed.
- proxies.yml/policies.yml (cloud) and the local host allowlist change in the same PR as the feature.

---

## 7. Roadmap placement

**This is arguably the flagship differentiator.** The built-in Entra -> Sentinel connector cannot reduce volume; the DCR/`_CL` reroute reduces volume but breaks content; no Microsoft feature auto-remaps content from a native table to a custom table. An "easy button" that does the reroute AND preserves downstream content is a capability neither Microsoft nor the raw Cribl destination offers.

It sits at the seam of two existing tiers in `feature-catalog.md`:
- **Tier 1 (the onboarding thread).** This feature *is* an onboarding thread instance - pick a source, resolve schema, deploy DCR + table, generate pipeline, create the Cribl destination, validate flow - specialized to Azure-native diagnostic sources. It extends the Phase 1 walking skeleton rather than replacing it and reuses the entire DCR engine.
- **Tier 2 (discovery and governance).** The content-reconciliation engine is governance: inventory Sentinel content, prove coverage, reconcile. It draws on the Azure Log Collection subsystem (LOG-07/03/16) and the analytics-rule coverage work (ENG-11) that Tier 2 already schedules (Phase 4).

**Placement recommendation.** Build it as a dedicated onboarding vertical that *depends on* Phase 2 (the full DCR engine, custom-table creation, DCE/Private Link) and *pulls forward* the LOG-07/03/16 Event Hub source path from Phase 4. Concretely, slot the walking-skeleton slice immediately after Phase 2 completes the DCR engine, then thicken it in parallel with the Phase 3 pipeline/pack work (the diagnostic-envelope reshape is a pipeline concern) and the Phase 4 Log Collection + content-governance work (the reconciliation engine shares the content analyzers).

**Phased build order:**
1. **Walking skeleton (one source, end-to-end, both shells).** `NonInteractiveUserSignInLogs` only. Deploy the tenant diagnostic setting (LOG-07 capability) -> Event Hub (LOG-03) -> Cribl `eventhub` source (LOG-16/ENG-13) -> a minimal pipeline that unrolls `records[]` and maps to `AADNonInteractiveUserSignInLogs_CL` -> `_CL` table + DCR (schema-mapping/dcr-naming) -> Cribl `sentinel` destination (DCR-27/ENG-28) -> generate the function-alias shim (table-alias-kql) -> validate one analytics rule still matches via ENG-11. This proves every seam, including the Mode B compatibility path, on the flagship example. **Before this slice, empirically validate the two biggest unknowns in a live workspace** (see section 8): whether the native Entra table accepts a Kind:Direct DCR at all, and whether the workspace lets you register a function-alias equal to a native table name.
2. **Mode A + auto-selection.** Add the native-table catalog with the supported-tables flag and the Mode A native-DCR path; wire the auto-selector. Prove Mode A on a supported table (e.g. `SecurityEvent` or an ASim table) so the clean path is exercised even while Entra stays on Mode B.
3. **Content-reconciliation engine breadth.** Extend beyond analytics rules to hunting queries, parsers, workbooks (parse `serializedData`), and playbooks (parse workflow JSON); add the preview + rollback UX.
4. **ASIM path + reduction depth.** Add the `vimAuthentication` parser generator as an alternative to the name-alias; deepen the volume-reduction rules for non-interactive sign-ins and the full-fidelity fork to cheap storage.
5. **Multi-category.** Generalize to the other four security-relevant categories (`AuditLogs`, `SigninLogs`, `AADServicePrincipalSignInLogs`, `AADManagedIdentitySignInLogs`) and the union-vs-replace shim logic for partial-reroute states.

---

## 8. Open questions and risks

**Version-sensitivity of the supported-tables list (time-sensitive).** The Mode A/B decision hinges on a list Microsoft says "may be added to." The snapshot read for this plan (content updated 2026-06-03) contains no Entra identity table. The catalog must record the snapshot date and be refreshable, and the app should prefer a live check where possible. If Microsoft adds the Entra tables later, previously Mode-B-onboarded sources could migrate to Mode A - the app should detect and offer that.

**BIGGEST TECHNICAL RISK - are the native Entra tables even DCR-ingestible?** It is *unverified* whether the Microsoft-managed identity tables (`SigninLogs`, `AADNonInteractiveUserSignInLogs`, ...) accept a custom `Kind:Direct` DCR inbound stream even if they appeared on the supported list. Some native Sentinel tables are simply not DCR-eligible. This must be validated against a live Azure workspace before the plan commits to Mode A ever being reachable for Entra. Until validated, treat Entra as Mode-B-only.

**Table-vs-function collision behavior is inconsistently documented.** Whether Log Analytics permits registering a `functionAlias` equal to an *existing* native table is not settled by any authoritative Microsoft statement; community evidence and known-issues suggest the platform may reject or shadow it. **Empirically test in the target workspace** before depending on the alias. The safe regime is native table empty/absent; otherwise the shim must `union` native + custom rows.

**Native-table decommissioning tradeoff.** The clean function-alias regime requires the native table to be empty - i.e. the operator must decommission native ingestion (turn off the built-in connector for that category) to gain the reroute. That is a real loss: you trade native ingestion (and everything bound to it) for pipeline-side reduction. In particular, **UEBA cannot be redirected at all** - diverting sign-ins away from the native `SigninLogs`/`AuditLogs`/`AADServicePrincipalSignInLogs`/`AADManagedIdentitySignInLogs` tables starves UEBA, BehaviorAnalytics, and entity enrichment, and no shim fixes that. The app must surface this explicitly and offer the documented mitigations: keep the native connector for tables that must stay native, or send a full copy natively while Cribl handles a reduced/duplicate copy into `_CL`.

**ASIM vs function-alias.** ASIM is Microsoft-blessed and table-agnostic but only helps content already written to ASIM; the function-alias covers raw-native-name content but is a community pattern layered on the UDF name-resolution rule. It is also unverified whether the built-in ASIM Authentication parser already covers the *non-interactive* table (vs only interactive `SigninLogs`), so a custom source-specific parser may still be needed. The feature likely needs both generators and a per-workspace choice.

**Dedup / double-ingestion during cutover.** While migrating, both the native connector and the Cribl path may run, producing duplicate rows and inflated cost. The plan needs a cutover strategy (union shim during overlap, then flip to replace once the native table stops receiving), and the reconciliation engine should detect the dual-write window.

**Permissions.** Writing the pieces this feature touches spans several scopes: `savedSearches`/`alertRules`/workbook writes (workspace), DCR + table writes (`dataCollectionRules/write`, `workspaces/tables/write` - already in `azure-permissions` `existing-rg`), diagnostic settings, and specifically the **tenant Entra diagnostic setting (LOG-07) needs an elevated Entra directory role (Security Administrator)** - keep it a guided step, not a silent automation. The ingestion SP needs only `Monitoring Metrics Publisher` on the DCR (least-privilege, separate from the management SP), consistent with the onboarding requirements.

**REST api-version pinning.** The content enumeration spans `securityinsights` (alertRules), `loganalytics` (savedSearches - versions seen include `2020-03-01-preview` and `2025-07-01`), `Microsoft.Insights` (workbooks), and `Microsoft.Logic` (workflows). Versions evolve; the api layer must pin and confirm current versions rather than trust the digest's cited numbers.

**Buried KQL.** Workbook KQL lives inside `properties.serializedData` and playbook KQL inside Logic App workflow JSON - not first-class query properties. These are extra parsing work and a source of missed references if the scan is shallow; treat them as a known analyzer risk.

**Per-rule rewrite effort is variable.** The exact column-by-column schema each OOTB analytics rule requires of a `_CL` replacement was not exhaustively verified; the effort to make cloned/rewritten detections actually work will vary per rule, and entity-mapping behavior against a schema-matched `_CL` table (vs UEBA, which definitely does not follow) was not directly confirmed.

**Cribl deployment addressing.** The Cribl product API base URL and worker-group/commit-push-deploy semantics are deployment-specific (on-prem leader vs Cloud workspace, single-instance vs distributed); the api layer must confirm per environment. The eventhub-vs-eventhub_amqp source choice is also version/namespace-dependent. The legacy HTTP Data Collector API retires 2026-09-14 in favor of the Logs Ingestion API, and Cribl's older Azure Monitor Logs destination is deprecated in favor of the Sentinel destination - the plan targets the current APIs only.
