# Sentinel repo mapping sources (research 2026-07-12)

How Microsoft Sentinel solutions in github.com/Azure/Azure-Sentinel declare
destination tables and field mappings, surveyed across eight representative
solutions (CrowdStrike FDR V2, Zscaler, Cloudflare, Netskopev2, SentinelOne,
Fortinet FortiGate, Cortex XDR CCP, Okta SSO) in concert with each vendor's
own documentation. Drives the adoption plan at the bottom. All paths relative
to the repo master branch.

## What we already read

- Connector UI dataTypes labels ("CommonSecurityLog (Zscaler)") -> table hints
- CustomTables/*.json filenames -> _CL table hints
- Data Connector DCR JSON: dataFlows outputStream + event_simpleName routing
  (matchLogTypeToDcrFlow ships in 1.2.54)

## Key finding

For most non-CEF vendors the Azure-Sentinel repo IS the primary
machine-readable mapping authority - Cloudflare, Netskope, and SentinelOne
publish no independent field-mapping docs (unlike Zscaler's NSS feed format
tables). The DCR transformKql and Parsers/ YAML functions are
Microsoft/vendor-maintained crosswalks we are not yet mining.

## Ranked additional sources (with parse shape)

1. CCP DCR transformKql project maps - vendor field -> destination column,
   maintained per feed. Zscaler ships 15 CCP bundles (CloudNSS*_ccp/DCR.json)
   whose transformKql is a COMPLETE NSS-JSON -> CommonSecurityLog projection
   (`source | project TimeGenerated, DeviceAction=tostring(act), ...`);
   Cortex XDR ships one per stream. Parse: ARM resource
   properties.dataFlows[].transformKql -> tokenize project/project-rename/
   extend clauses into dest = f(source) pairs. Feeds the pack generator with
   a THIRD provenance tier: "Microsoft Sentinel solution DCR".
2. CrowdStrike EventsToTableMapping.json + RequiredFieldsSchema.json
   (CrowdstrikeReplicatorCLv2/CrowdstrikeFalconAPISentinelConn/QueueTriggerCS/)
   - flat dicts: event_simpleName -> table category, and per-category
   required/optional field lists. Cleanest FDR router + schema validator.
3. Poller/push dataConnector resources - dcrConfig.streamName +
   request.apiEndpoint + response.eventsJsonPaths: binds endpoint/feed to
   stream/table AND names the JSON envelope to unwrap before matching
   (Netskope: 13 alert endpoints fan IN to one table, 8 event endpoints fan
   OUT to 8 tables, all $.result; Zscaler Push: $.messages; SentinelOne
   GraphQL: $.data.alerts.edges[*].node).
4. Parsers/*.yaml function definitions - (a) first table token / union list
   names the operative tables incl. legacy generations (OktaSSO.yaml unions
   Okta_CL v1 _s/_d with OktaV2_CL; SentinelOne.yaml unifies v1 + 5 V2
   tables); (b) column_ifexists/rename pairs are a maintained vendor-field ->
   friendly-name dictionary (Netskopev2 has 30 parsers; Cloudflare.yaml
   coalesces alternate Logpush dataset field names).
5. Table ARM resources - Microsoft.OperationalInsights/workspaces/tables in
   CCP bundles and Package/mainTemplate.json: full typed column schemas
   (OktaV2_CL 58 cols). mainTemplate alone can yield tables + parsers +
   connectors in one fetch per solution.
6. ASIM transformation YAMLs - CrowdStrike ships 8
   (Data Collection Rules/Transformations/ASim*.yaml) with per-event
   EventType/EventResult logic; repo-root Parsers/ASim* tree generalizes.
7. Connector UI vendor-identity KQL - graphQueries.baseQuery /
   connectivityCriterias: the only machine-readable identity signal for
   shared-table vendors (Fortinet: DeviceVendor == "Fortinet" and
   DeviceProduct startswith "Fortigate"). Can auto-derive the
   DeviceVendor/DeviceProduct constants the identity ladder seeds today from
   the curated list.
8. Analytic rules requiredDataConnectors.dataTypes + query-head table token -
   confirms operative tables, BUT dataTypes may name a parser FUNCTION alias
   (SentinelOne rules query the `SentinelOne` function, not a table). Resolve
   aliases through the Parsers folder before treating as a table.

## CrowdStrike FDR V2 routing shape (verified)

One CCP DCR (CrowdStrikeS3FDR_ccp/DCR.json) with 2 input streams and 10
dataFlows; the primary stream fans to 9 tables, each flow's transformKql
starting `source | where event_simpleName in (...)`:

- Network_Events: RawBindIP4/6, NetworkConnectIP4/6, NetworkListenIP4/6, ...
- DNS_Events: DnsRequest, SuspiciousDnsRequest
- Process_Events: ProcessRollup2, SyntheticProcessRollup2, WmiCreateProcess,
  TerminateProcess, ProcessInjection, ProcessBlocked, EndOfProcess, ...
- Auth_Events: UserLogon, UserLogoff, UserLogonFailed(2), IoSessionLoggedOn
- Additional_Events: catch-all (UserIdentity, ScheduledTask*, ...)
- Secondary_Data: no event filter (AdditionalFields as dynamic)

The function-app variant routes BEFORE the DCR via EventsToTableMapping.json
and ships a SECOND normalization DCR dual-routing the same events to ASIM
tables (3 native Microsoft-ASim* streams + 5 Custom-ASim*_CL clones).

## Per-vendor uniqueness notes

- CrowdStrike: routing truth in 3 places; events DUAL-ROUTE to CrowdStrike_*
  and ASIM tables; catch-all Additional_Events absorbs unmapped events.
- Zscaler: native CSL table fed by JSON push (not CEF agent); feed identity
  is positional (which push stream), not content-derived; 15 DCR crosswalks.
- Cloudflare: ONE wide table (CloudflareV2_CL) for all Logpush datasets,
  dataset identity in the LogType field; legacy _s/_d generation coexists.
- Netskope: asymmetric fan (13 alert endpoints -> 1 table, 8 event endpoints
  -> 8 tables); parser-function indirection is the documented query surface;
  FOUR overlapping solutions across generations.
- SentinelOne: ENTITY-typed tables (Activities/Agents/Groups/Threats), not
  log-typed; content binds to the parser alias, never tables.
- Fortinet: zero field mappings in the repo - pure CEF -> CSL; identity KQL
  is the only signal.
- Cortex XDR: cleanest CCP pattern but TimeGenerated = now() (ingestion
  time); vendor timestamps are ms-epoch fields.
- Okta: three connector generations targeting different tables; no routing
  problem (one endpoint -> one table); DCR transform embeds a severity
  lookup dict - transforms are not always pure renames.

## Adoption plan (maps to existing components)

- Wave A (generator): mine CCP DCR transformKql project maps into generated
  packs with provenance "Microsoft Sentinel solution DCR" and docUrl = the
  DCR's repo path. Zscaler alone contributes 15 feed-specific crosswalks;
  Cortex XDR, Okta v2, SentinelOne V2, Netskope follow the same shape.
- Wave B (routing): read EventsToTableMapping.json when present (CrowdStrike
  function-app path) as a second routing source beside DCR eventSimpleNames.
- Wave C (identity): derive DeviceVendor/DeviceProduct constants from
  connector-UI identity KQL instead of (or validating) the curated ladder.
- Wave D (rule coverage): resolve dataTypes parser-alias indirection through
  Parsers/*.yaml so rule coverage works for SentinelOne-style solutions.
- Wave E (schemas): read workspaces/tables ARM resources from CCP bundles /
  mainTemplate as a live schema tier above the bundled catalog.
