# Feature Catalog: Cribl-Microsoft Repository

Generated 2026-07-01 by a 14-agent parallel audit of every subsystem, for planning the integration of existing repository capabilities into the Cribl App Platform app in `soc-optimizationtoolkit/`. Total: 299 cataloged features (267 primary + 32 from the v1 prior-analysis cross-check).

## How to read this catalog

Every feature has a stable ID (e.g. DCR-03) for review discussion, a repo-relative source path, and a portability verdict against the Cribl app's runtime constraints (browser-only TypeScript in a sandboxed iframe; Cribl product API via policies.yml; external HTTPS via proxies.yml with 30s timeout and 100 req/min; app-scoped KV store; no filesystem, no child processes, no PowerShell).

| Verdict | Meaning |
|---|---|
| direct | Pure logic/data; ports to browser TS as-is |
| needs-proxy | Portable, but outbound calls must go through proxies.yml declared domains |
| needs-redesign | User value ports, but the mechanism must change (PowerShell + files to REST + KV + downloads) |
| not-portable | Fundamentally requires local host access (daemons, file watchers, processes) |
| platform-provided | The Cribl platform already provides this; drop |
| out-of-scope | Lab/test/dev infrastructure, not a product feature |

## Rollup (excluding v1 cross-check)

By verdict:

| Verdict | Count |
|---|---|
| needs-redesign | 96 |
| direct | 64 |
| needs-proxy | 42 |
| out-of-scope | 34 |
| platform-provided | 21 |
| not-portable | 10 |

By category:

| Category | Count |
|---|---|
| infra-tooling | 57 |
| dcr-deployment | 45 |
| pipeline-generation | 30 |
| discovery | 24 |
| labs-testing | 22 |
| pack-management | 21 |
| reporting | 20 |
| documentation | 18 |
| identity-auth | 15 |
| ai-automation | 8 |
| enrichment | 7 |

By maturity:

| Maturity | Count |
|---|---|
| production | 158 |
| dev | 84 |
| docs-only | 14 |
| placeholder | 7 |
| experimental | 4 |

By subsystem:

| Subsystem | ID prefix | Features |
|---|---|---|
| DCR Automation Engine | DCR | 35 |
| DCR Template Library and Static Assets | AST | 6 |
| Integration Solution - Backend Engine | ENG | 52 |
| Integration Solution - GUI Workflows | GUI | 32 |
| Event Hub Discovery | EVH | 16 |
| vNet Flow Log Discovery | VNF | 15 |
| Azure Log Collection | LOG | 19 |
| Cribl Pack Packaging | PKG | 5 |
| Windows Schema Sync (AI Drift Engine) | SYN | 32 |
| AWS Source Integration | AWS | 15 |
| Enrichment Lookups | LKP | 8 |
| Pack Library, Knowledge Articles, Root Docs | DOC | 9 |
| Labs and Test Environments | LAB | 23 |
| v1 Monorepo Prior Analysis (cross-check) | V1 | 32 |

## Review guide: proposed disposition

This section is the entry point for the review. It groups the 267 primary features into decision tiers. IDs reference the detail sections below.

### Review decisions (2026-07-01)

- Lab infrastructure is IN scope for the app (user decision). The out-of-scope verdicts on LAB-* and AWS lab items in the detail sections record the original audit judgment; the effective verdict for lab provisioning features is needs-redesign (PowerShell orchestration becomes ARM REST deployments through the proxy). See the "Lab environments" tier entry below. Rollup tables above still reflect the original audit verdicts.
- Platform confirmation: Cribl Apps (Preview) run only on Cribl.Cloud leaders (docs.cribl.io/apps). See "Cribl.Cloud runtime implications" below.
- Onboarding requirements added (user decision): the setup wizard must obtain informed consent before storing Azure credentials in the Cribl KV store (with a no-storage device-code alternative), and must state the app registration permissions required per enabled capability. See "Onboarding requirements" below.
- Redesign-first principle adopted (user decision): the legacy codebase is a capability reference, not an implementation specification. See "Redesign-first principle" below; it governs how every verdict in this catalog is read.
- Dual-target delivery required (user decision): Cribl Apps run only on Cribl.Cloud, but customer-managed (on-prem) Cribl customers need this capability too. The product ships as TWO targets from ONE shared codebase - the Cribl-hosted app and a local app - plus a locally run onboarding GUI that guides users through setting up either option. End goal: consolidate everything and archive the old codebase. See "Proposed architecture: dual-target" below.
- Scope cuts (user decision, 2026-07-01): AWS and LDAP scenarios are dropped entirely. AWS-* features remain cataloged for reference only; lookups use Microsoft Graph exclusively on both targets, with no local LDAP adapter.
- Local shell and restructure confirmed (user decision, 2026-07-01): Node host + browser for the local app (open question 8), and the scaffold moves into an npm-workspaces layout as apps/cribl-app (open question 9, executed same day).
- Review complete (2026-07-01): all nine open questions resolved (see Open questions section). Tier 1 = onboarding thread as a walking skeleton; drift = on-demand cloud + scheduled local; air-gap accepted as designed; UnifiedLab first with mandatory TTL. Implementation roadmap: docs/roadmap.md.

### Redesign-first principle

The catalog's verdicts describe whether a CAPABILITY can be delivered in the app, not an instruction to transplant code. Even verdict-direct features get a fresh design pass. For each feature, the method is:

1. Extract the capability contract from legacy: inputs, outcomes, and the embedded domain knowledge (naming rules, type maps, reduction-rule knowledge bases, schema heuristics).
2. Harvest the edge-case archive: legacy code encodes hard-won real-world lessons that a fresh design would rediscover expensively (the handler.control endpoint correction DCR-28, schema variant fallbacks DCR-07, serialize overflow ENG-03, capture inner-format detection ENG-15). These carry over as test cases, not as code shape.
3. Design fresh against the platform's primitives, consulting legacy only for the why.

Efficiency redesigns already identified during the audit:

- DCR/DCE deployment: skip ARM template generation-then-deployment entirely; PUT the resource bodies directly to the ARM resource APIs (simpler, better errors, easier polling). Template generation survives only as an export artifact for air-gap and review.
- Event Hub discovery: keep only the single-query Resource Graph path (EVH-04); the legacy per-resource loop (EVH-05) exists solely because the optimized path came later. Drop it.
- Sentinel Content Hub: query the GitHub API on demand with KV caching instead of mirroring the repo (ENG-21's local mirror was an Electron-era workaround).
- Cribl wiring: direct product API calls replace the entire export/import config dance (already noted in Tier 1).
- Run state: KV-backed job records replace marker files, timestamped JSON snapshots, and console summaries.
- Custom table + DCR creation: legacy sequences these as separate phases with polling between; the app can pipeline them as one job with combined status.

Compatibility exceptions - places where legacy BEHAVIOR is itself the contract and must be preserved exactly, because customers have deployed resources with these outputs:

- DCR/DCE name generation and abbreviation (DCR-10): re-runs against existing deployments must produce identical names or idempotency breaks.
- Stream names and custom table schemas already in production workspaces.
- Pack naming conventions (succinct vendorPrefix pattern) for packs already distributed.

For these, characterization tests recorded from legacy output are mandatory; everywhere else, tests assert the re-derived capability contract, not legacy quirks.

### Tier 1: Core product (port first)

The Sentinel onboarding thread that every other feature supports. Together these form one coherent workflow: pick a source, resolve its schema, deploy DCR + custom table, generate pipeline + pack, create the Cribl destination, validate flow.

- DCR deployment engine: DCR-06 through DCR-22 (schema retrieval/variant resolution, column type mapping, 30/64-char name abbreviation, ARM template generation, DCE and Private Link/AMPLS support, custom table creation and MMA migration). The pure logic (DCR-08, DCR-09, DCR-10, DCR-12, DCR-13) ports directly; deployment calls go through the ARM proxy. V1-30 already has the name abbreviation in tested TypeScript.
- Cribl destination wiring: DCR-25 through DCR-30 and ENG-35 collapse into something simpler than the original: the app runs inside Cribl, so instead of exporting JSON for manual import, it creates Sentinel destinations directly via the product API (policies.yml grant).
- Pipeline generation and pack building: ENG-01 through ENG-19 (multi-format CEF/CSV/JSON/KV pipelines, volume-reduction rules knowledge base, 6-phase field matcher, sample parser and capture auto-detection, pack scaffolding and .crbl assembly, lookup generation). Almost all verdict "direct" — this is the highest-value, lowest-friction port.
- Template and schema assets: AST-01, AST-02, DCR-20, DCR-33 (the ARM template library and static schema catalogs become bundled JSON data modules).
- Guided workflows re-skinned from the Electron GUI: GUI-03 (setup wizard), GUI-05 (solution browser), GUI-08 (gap analysis review), GUI-10 through GUI-14 (Azure targeting, RBAC preflight, resource preview, deploy orchestration), GUI-17/GUI-18 (validation and monitoring), GUI-19/GUI-20 (pack inventory/builder).

### Tier 2: Discovery and governance (second wave)

- Azure Log Collection (LOG-02 through LOG-16): policy-driven diagnostic settings at scale, Entra ID / Defender export setup, compliance gap analysis, remediation. High customer value; all ARM/Graph REST via proxy.
- Event Hub discovery (EVH-03 through EVH-08): Resource Graph inventory, sender inference, activity detection.
- vNet Flow Log discovery (VNF-01, VNF-02) plus the finished AzureFlowLogs pack content (VNF-08 through VNF-14 — event breakers, dedup pipelines, collector jobs ship as pack assets, installable via the Cribl API).
- Enrichment lookups (LKP-01 through LKP-05): the Cribl-side upload/commit/deploy is native product API; the AD query (LKP-02) should be redesigned from on-prem LDAP to Microsoft Graph through the proxy.
- Analytics rule coverage and SIEM migration analysis (ENG-11, ENG-40, GUI-09, GUI-22).

### Tier 3: Advanced / decide later

- AI schema drift engine (SYN-02 through SYN-17): the detection and AI pack-generation logic ports (Anthropic API via proxy), but the autonomous scheduled loop (SYN-16, SYN-18) cannot run in a browser app — decision needed: on-demand "check drift now" in-app, an external scheduled companion (keep the GitHub Actions flow), or both.
- AWS as a source: DROPPED per the 2026-07-01 scope cut; AWS-* entries below are reference-only.
- Reporting (DOC-07 Power BI / Cribl Search connector; VNF-14 dashboards).
- Guided-doc features (DOC-03 through DOC-06, O365/Private Link guides) as in-app checklists; DOC-02 (O365 permission validation) is a natural in-app tool via Graph proxy.

### Lab environments (re-scoped IN per review, 2026-07-01)

A "Labs" feature module: provision disposable Azure test environments from the app, run the onboarding thread against them end-to-end, then tear down. Everything the PowerShell orchestrators do is ARM REST, so the port mechanism is identical to the DCR engine (submit deployment, poll status):

- UnifiedLab phases as guided, resumable deployments: LAB-01 through LAB-08, LAB-10, LAB-12 (resource group with TTL self-destruct Logic App, networking, storage, Event Grid wiring, monitoring with Sentinel and AMPLS, Event Hub and ADX, flow logs, VPN gateway). Long-running phases (VPN gateway is 30-45 minutes) are polled jobs, which the store/ job model already covers.
- Test data generation: LAB-09 (test VMs with auto-shutdown) deploys via ARM including custom script extensions for traffic generation; the original not-portable verdict applied to running scripts locally, not to VM provisioning itself.
- Cribl wiring: LAB-05, LAB-11, LAB-19 (generating Cribl sources/collectors from deployed lab resources) merge with the Tier 2 discovery features rather than being duplicated.
- AzureFlowLogLab: LAB-17 through LAB-21 fold in as a lab profile alongside UnifiedLab.
- AWS labs: dropped with the AWS scope cut (2026-07-01 review decision).
- Naming/validation logic (LAB-13, LAB-14) joins the domain/ layer beside the DCR naming engine.

Cost guardrails matter here: the TTL self-destruct pattern (LAB-02) should be mandatory, not optional, when deployed from the app.

Permission design (2026-07-02): the lab wizard offers two modes because RG creation is subscription-scoped. Create-new-RG mode needs Contributor plus RBAC Administrator at the subscription (the TTL Logic App identity receives its RG-delete role at deploy time); bring-your-own-RG mode needs only Contributor on an admin-pre-created RG with the TTL identity rights pre-assigned - the least-privilege path for security-conscious customers.

### Drop (platform-provided or obsolete)

All 21 platform-provided items: Azure/Cribl auth plumbing (DCR-23, ENG-27, LKP-03 — the platform proxy injects auth), Electron shell/IPC/file/log infra (ENG-44, ENG-47 through ENG-51, GUI-31), EDR blocklist and crash detection (ENG-22 — no local processes to block), console menu frameworks (VNF-04, PKG-03, LOG-17, LOG-18, LAB-15), CLI override shim (DCR-04), root launchers, and the stale v1 CI workflow.

### Not portable (explicit decisions needed)

ENG-45/ENG-46/GUI-02/GUI-23/GUI-26 (dependency installers, PowerShell runners and terminal) — drop; their purpose disappears. SYN-18/SYN-25 (GitHub Actions scheduling) — external companion if Tier 3 drift automation is wanted. EVH-12 (module auto-install) — obsolete. LAB-09 (test VMs) — stays lab-side.

### Out of scope (stays in repo, not in app)

Dev harnesses (EVH-15, ENG-50) and dev-mode switching (DCR-05, PKG-05, EVH-14). Labs were originally in this bucket but were re-scoped into the app per the 2026-07-01 review decision above; only the HomeLab placeholder (LAB-23) and lab documentation sets remain repo-side.

## Cross-cutting redesign themes

Recurring mechanics every ported feature shares — these become the app's shared infrastructure:

1. PowerShell + Az modules become typed ARM REST clients through proxies.yml (management.azure.com, login.microsoftonline.com, graph.microsoft.com, plus api.github.com, api.anthropic.com, raw.githubusercontent.com for Tier 2/3).
2. Local config/output files become app KV store entries plus browser downloads (air-gap export remains a download of generated artifacts).
3. Manual Cribl config import/export becomes direct product API calls (destinations, packs, lookups created in place; policies.yml declares each path).
4. Console menus and Read-Host prompts become React routes and forms.
5. The 30-second proxy timeout means ARM deployments are submitted then polled; the 100 req/min limit means batch table deployments run through a client-side queue.
6. Secrets (Azure service principal, GitHub PAT, Anthropic key) live in the encrypted KV store and are injected as headers by proxies.yml, never touching app code.
7. Anything scheduled or long-lived (drift daemon, startup refresh, file watchers) becomes on-demand actions, or stays outside the app as a scheduled companion.

## Cribl.Cloud runtime implications

Cribl Apps (Preview) run only on Cribl.Cloud leaders (docs.cribl.io/apps). Everything in this section applies to the Cribl-hosted target only; the local app target (see dual-target architecture) runs its own Node host and is not subject to the platform proxy's constraints. Consequences for the Cloud target:

- The fetch proxy executes on Cribl's cloud infrastructure. All Azure/Graph/GitHub/Anthropic calls originate from Cribl.Cloud egress IPs, not the user's network. Azure tenants with conditional access or service-principal IP restrictions must allow that egress, or the token/ARM calls will be rejected.
- The proxy's SSRF protections block private and reserved IPs, and Cribl.Cloud has no route into customer networks. Anything private-only is unreachable from the app: on-prem LDAP (hence the Graph redesign for LKP-02), private-endpoint-only workspaces, internal Git servers. Note the AMPLS features (DCR-17, LAB-06) are unaffected: they configure Private Link through the public ARM management plane; the private data path belongs to Cribl workers, not the app.
- Azure authentication works via standard OAuth2 client-credentials: the app POSTs to login.microsoftonline.com/{tenant}/oauth2/v2.0/token through the proxy using a service principal, holds the ~1-hour access token in memory, and calls management.azure.com with it. This is the same service principal model the repo already uses (azure-parameters.json tenant/client/secret, Monitoring Metrics Publisher role, KnowledgeArticles app-registration guides). The client secret is stored in the app's KV store with encrypted=true (PUT /kvstore/key?encrypted=true); encrypted entries are write-only from the client (reads return a redacted placeholder) and are resolved server-side only by proxies.yml header-injection expressions. Because of that write-only semantic, the token request must carry the credential in a header, not the POST body: store base64(clientId:clientSecret) encrypted in KV and inject Authorization: Basic ${kv.azureBasic} on login.microsoftonline.com requests (the Microsoft identity platform accepts client_secret_basic). The secret never exists in browser code; the app only ever handles short-lived access tokens. Device-code flow is the fallback if a customer requires delegated (per-user) permissions instead of a service principal.
- Admins see and approve every proxies.yml domain and policies.yml path at install time, so the external surface (login.microsoftonline.com, management.azure.com, graph.microsoft.com, api.github.com, api.anthropic.com, raw.githubusercontent.com) is an explicit, reviewable contract.
- Discovered in live testing (2026-07-02): the proxy forwards the browser's Origin header upstream by default. Azure AD rejects confidential-client token redemption on requests carrying an Origin (AADSTS9002326, SPA-only rule), so every Azure-facing proxies.yml entry must set a headers allowlist (Content-Type/Accept only) to keep Origin from reaching the upstream. Do NOT work around this by converting the app registration to SPA - client_credentials is not permitted cross-origin at all.

## Onboarding requirements (added per review, 2026-07-01)

The setup wizard (extends GUI-03, with the permission preflight from ENG-38/GUI-11) must handle two things explicitly:

### 1. Informed consent for credential storage

Before accepting an Azure client secret, the wizard states where it goes and what that means: stored in the app's Cribl KV store with encrypted=true; write-only from the browser (reads return a redacted placeholder); resolved only server-side by the platform proxy when injecting the Authorization header on token requests; resident in Cribl.Cloud. The user then chooses:

- Store credentials (recommended): persistent service principal auth; all automation available across sessions.
- Do not store: device-code flow per session (user signs in interactively, delegated permissions); nothing persisted; automation limited to the signed-in user's own Azure permissions.

Rotation is re-entering the secret (KV overwrite). The wizard should also recommend two separate app registrations: a management SP the app uses (roles below) and an ingestion SP that Cribl destinations use, which needs only Monitoring Metrics Publisher on the DCRs — keeping the credential that lives in worker configs least-privileged.

### 2. Required app registration permissions, stated per capability

The wizard shows only the rows for features the user enables (progressive, least-privilege), then verifies actual access with the permission preflight before proceeding:

| Capability (features) | Scope | Required role / permission |
|---|---|---|
| DCR/DCE deployment, custom tables, MMA migration (Tier 1 DCR-*) | Target resource group + workspace | Monitoring Contributor + Log Analytics Contributor |
| Assign Monitoring Metrics Publisher to the ingestion SP (ENG-37) | Deployed DCRs | Role Based Access Control Administrator (or User Access Administrator) |
| Resource discovery via Resource Graph (EVH-03/04, VNF-01, LOG-10) | Subscription(s) | Reader |
| Event Hub connection-string generation (EVH-06, LOG-16) | Event Hub namespaces | listKeys action (Azure Event Hubs Data Owner or equivalent) |
| Policy initiatives, diagnostic settings at scale, remediation (LOG-02 through LOG-06, LOG-14) | Subscription or management group | Resource Policy Contributor + Monitoring Contributor |
| Entra ID tenant diagnostic settings (LOG-07) | Tenant | Entra directory role: Security Administrator (elevated; keep as guided step) |
| Defender for Cloud continuous export (LOG-08) | Subscription | Security Admin |
| Lab provisioning, create-new-RG mode (LAB-01/02) | Subscription | Contributor (RG creation is subscription-scoped) + RBAC Administrator (the TTL self-destruct Logic App identity is granted its RG-delete role at deploy time, which needs roleAssignments/write) |

RBAC Administrator assignments should carry a role-assignment condition (Azure portal: "Constrain roles and principal types"): allow assigning ONLY Contributor and Monitoring Metrics Publisher, ONLY to service principals. The app never assigns other roles or grants to users/groups, and the condition caps blast radius if the app credential is compromised. "Constrain roles and principals" cannot be used instead because the lab TTL Logic App managed identity does not exist until deploy time.

Connection management (2026-07-02 decisions): the app stores NAMED connection profiles, not a single config. Each profile = { id, name, clientId, tenantId, subscriptionId, resourceGroup, workspaceName, setupPath } persisted plain in KV (e.g. azureConfig:<id>), with an active-profile pointer; the client secret is NEVER in the profile - it stays in a per-profile encrypted, write-only KV entry (azureBasic:<id>). A profile switcher selects the active connection.

Switching identity is an EXPLICIT action (a "Switch connection" button), never silent on field edit - correcting a mistyped tenant GUID must not wipe a stored secret. Derived-state invalidation rules (belong in the core/state layer, testable, identical in both shells):
- Identity change (tenant or clientId): clear that profile's secret and ARM token; re-prompt for the secret. A new tenant means a new app registration, so the old secret is invalid.
- Scope change (subscription or workspace RG, same identity): keep the secret and token (the client_credentials ARM token is tenant-scoped and works across subscriptions); clear only the cached permission-validation results and any workspace-derived state, then re-validate.

Resource discovery replaces free-text where read access exists: once connected (token acquired), subscription, workspace, and resource group are DROPDOWNS populated from ARM (GET /subscriptions; GET .../Microsoft.OperationalInsights/workspaces; GET .../resourcegroups). Selecting a workspace DERIVES its resource group by parsing the workspace ARM resource ID (a pure, tested core helper). Text inputs remain only for what cannot be discovered pre-auth (tenant, clientId, secret) or does not exist yet (a new lab RG name). Empty discovery results double as a permission signal (the SP has no access yet - run the role script). Discovery is gated on a live connection; switching subscription re-queries the dependent lists.

Setup-path gating (2026-07-02): the wizard asks WHICH environment the user is targeting before asking for any scope names. A user with no workspace yet (nothing deployed, unwilling to touch production) is never asked for a workspace resource group: on the lab create-new-RG path, subscription Contributor subsumes the workspace-scoped roles entirely; on the bring-your-own-RG path the only input is the pre-created lab RG. Three paths: existing workspace (least privilege, RG-scoped), lab create-new-RG (subscription Contributor + conditioned RBAC Administrator), lab bring-your-own-RG (RG-scoped Contributor only). The spike harness panel 3 prototypes this selector.
| Lab provisioning, bring-your-own-RG mode | Pre-created lab resource group | Contributor on that RG only; the admin pre-assigns the TTL identity its delete rights, so no subscription-scope or RBAC rights are needed |
| KQL validation and monitoring (ENG-32, GUI-17/18, SYN drift checks) | Workspace | Log Analytics Reader |
| AD user lookups via Graph (LKP-02 redesign) | Tenant (Graph) | User.Read.All application permission, admin consent |
| O365 app permission validation (DOC-02) | Tenant (Graph) | Application.Read.All application permission, admin consent |
| Cribl ingestion (separate SP recommended, existing repo pattern) | Per DCR | Monitoring Metrics Publisher |

The preflight should test these with real read/no-op calls rather than trusting role names, since customers use custom roles; the checked-actions list also doubles as the definition of a least-privilege custom role for security-conscious customers.

## Proposed architecture: dual-target (for review)

Requirement (2026-07-01): one shared codebase, two deployment targets, so on-prem Cribl customers are first-class. The differences between targets are confined to a thin adapter layer; domain logic and feature UI are written once.

### The two targets

| | Cribl-hosted app (Cloud) | Local app (on-prem / anywhere) |
|---|---|---|
| Shell | Cribl App Platform iframe, installed as .tgz | Browser UI served by a small local Node host, launched from source (EDR-friendly, like the existing launchers) |
| Cribl API access | Platform fetch, auth injected automatically | Local host talks to the leader directly (on-prem bearer login or Cloud org token) |
| Azure/Graph calls | Platform proxy: proxies.yml, 30s timeout, 100 req/min | Local host outbound; no platform limits |
| Secrets | Cribl KV, encrypted, write-only | OS-local encrypted store, or no-storage device-code mode |
| Private network reach | None (SSRF-blocked) | Yes: on-prem LDAP, private endpoints, internal Git |
| Background jobs | None; on-demand only | Node host can schedule (drift checks, refreshes) |
| Air-gap story | Generate and download artifacts, carry across | Can run entirely inside the isolated network beside a local leader |

The capability matrix is therefore a superset in local mode; features degrade gracefully on the Cloud target (LDAP, scheduling) rather than being designed out.

### Workspace layout

npm workspaces - deliberately lighter than the abandoned v1 pnpm/turborepo setup, but with real package boundaries:

```
packages/core       Domain logic + port interfaces. Zero IO, zero React.
packages/ui         Shared React feature screens and components; consume ports via context.
apps/cribl-app      Cloud shell (the current scaffold moves here): Vite build -> .tgz;
                    binds platform adapters (locked fetch, /kvstore, proxies/policies.yml).
apps/local-app      Local shell: same UI served by a Node host that fulfills the same port
                    contracts (outbound HTTP for Azure/Cribl, encrypted secret store, job
                    scheduler) and hosts the onboarding GUI as its first-run experience.
```

Ports defined in packages/core: CriblClient, AzureManagement, GraphClient, SecretsStore, JobStore, UserContext, ArtifactSink (browser download vs local file write). Feature code depends only on ports; each shell binds its own adapters. Lint-enforced boundaries: core imports nothing; ui imports only core; apps import both. This is v1's hexagonal discipline at the altitude where it pays for itself - the port seam is exactly where the two targets differ.

### Onboarding GUI (locally run, guides both setups)

The local app doubles as the entry point for both targets, so there is one artifact to distribute and no third tool to maintain. First run opens a guided wizard that:

1. Explains the two deployment models and their tradeoffs (the table above), and asks which the user is setting up.
2. Cribl-hosted path: walks through the Azure app registration (permission matrix from the Onboarding requirements section), packages the .tgz, guides upload into the Cribl.Cloud organization and admin policy approval, then hands off to the installed app.
3. Local path: connects to the leader (URL plus credentials), runs the same Azure consent and permission flow with local secret storage choices, and lands directly in the running app.

### AI readability and maintainability practices

- CONTEXT.md at the repo root plus a short one per package (purpose, boundaries, invariants); ADR log restarted with ADR-0001 recording this dual-target decision. Decision history stays greppable by humans and agents.
- Small, single-purpose modules; explicit types at every package boundary; no clever metaprogramming. Typed API clients written against the vendored openapi.json, pinned per Cribl version.
- Tests colocated with source, asserting re-derived capability contracts (see Redesign-first principle); characterization fixtures only for compatibility-critical outputs.
- The external-surface declarations (policies.yml/proxies.yml for Cloud; the local host's outbound allowlist for local) change in the same PR as the feature that needs them.

### Consolidation and archival plan

Strangler-fig confirmed (resolves open question 6): the old trees stay untouched and runnable throughout the build. As each feature domain reaches parity in BOTH targets, its legacy source is marked superseded in this catalog. End state: tag the repo (legacy-final), then remove Cribl-Microsoft_IntegrationSolution/, the Azure PowerShell trees, and SOC-OptimizationToolkit_v1/ from main - git history and the tag preserve them permanently. The DCR template library and schema assets migrate into packages/core assets before archival so nothing load-bearing lives in the archived trees.

### Internal structure of the shared code

The earlier single-app layout survives as the internal shape of the shared packages (domain becomes packages/core, api becomes the per-shell adapters, features/components become packages/ui, store becomes the JobStore/SecretsStore ports):

```
src/
  domain/        Pure TypeScript business logic. Zero IO, zero fetch. The 64 "direct"
                 features land here: dcr-naming, schema-mapping, pipeline-gen,
                 field-matcher, pack-assembly, reduction-rules, sample-parsing.
                 Unit-tested with vitest against re-derived capability contracts;
                 characterization tests from legacy only for compatibility-critical
                 outputs (see Redesign-first principle).
  api/           Typed clients over the platform's locked fetch(): criblApi, azureArm,
                 msGraph, github, anthropic. Thin: auth is the proxy's job. Each client
                 maps 1:1 to proxies.yml/policies.yml declarations.
  features/      One folder per catalog domain (onboarding, dcr, packs, discovery,
                 governance, lookups, migration, drift, labs). UI + hooks only; calls
                 domain and api, never other features' internals.
  store/         KV-backed settings, secrets references, and job/run state.
  components/    Shared presentational UI.
```

Rules carried into the workspace layout: every outbound call goes through a port client; long operations are modeled as polled jobs behind JobStore so any screen in either shell can resume them; the package boundaries above are lint-enforced in CI.

## Open questions for the review

1. RESOLVED (2026-07-01): the onboarding thread (source to validated data flow) is Tier 1, built as a walking-skeleton vertical slice; governance follows in Tier 2.
2. RESOLVED (2026-07-01): one shared drift-check implementation - on-demand in the Cribl-hosted app, additionally scheduled by the local app's Node host. The GitHub Actions flow retires with the legacy archive.
3. RESOLVED (2026-07-01): LDAP is dropped; lookups use Microsoft Graph exclusively on both targets.
4. RESOLVED (2026-07-01): AWS is out of scope entirely; AWS-* features remain cataloged for reference only.
5. Air-gapped support: are browser downloads of generated artifacts (packs, templates, scripts) an acceptable replacement for the Electron export folder? Feasibility (2026-07-01): the generation logic is pure client-side TS (pack tarballs, ARM templates, scripts, configs can all be assembled in-browser and bundled), and the core generation path needs no external fetches because template/schema assets ship inside the app pack. One mechanical verification is needed early: confirm the platform's sandboxed iframe permits Blob downloads (spike in the first milestone). Fallbacks if it does not: create packs in Cribl via the product API and export them through Cribl's own UI, or render artifacts as copyable text. Note the app itself always needs Cribl.Cloud; air-gapped mode means generating and downloading artifacts on the connected side, then carrying them across the gap, exactly as the Electron export folder works today. Dual-target update: the local app can run entirely inside the isolated network beside a customer-managed leader, which is the stronger air-gap answer; download-and-carry remains the Cloud-target story. RESOLVED (2026-07-01): accepted as designed; the iframe Blob-download spike remains a first-milestone task.
6. RESOLVED (2026-07-01): the old trees stay untouched as fallback until both targets reach parity, then the repo is tagged and the legacy trees are removed from main (see Consolidation and archival plan).
7. RESOLVED (2026-07-01): UnifiedLab ships first (superset profile, directly supports validating the onboarding thread); the TTL self-destruct is MANDATORY for every app-provisioned lab.
8. RESOLVED (2026-07-01): Node host + browser confirmed for the local shell, launched from source (EDR-friendly, reuses the web-mode pattern ENG-49).
9. RESOLVED (2026-07-01): approved and executed; the scaffold now lives at apps/cribl-app inside the npm-workspaces layout (packages/core, packages/ui, apps/cribl-app, apps/local-app).

<!-- END REVIEW-GUIDE -->


## DCR Automation Engine (DCR)

DCR-Automation is the repository's production core: a PowerShell toolkit (menu entry point Run-DCRAutomation.ps1, ~3,350-line engine core/Create-TableDCRs.ps1, exporter core/Generate-CriblDestinations.ps1) that creates Azure Data Collection Rules (Direct or DCE-based, optionally Private-Link/AMPLS-scoped), creates/migrates Log Analytics custom tables from JSON schemas, generates standalone ARM templates, and exports ready-to-import Cribl Stream Sentinel destination configs with DCR immutable IDs and ingestion endpoints. It is configuration-driven (azure-parameters.json, operation-parameters.json, cribl-parameters.json, table lists) and mature (v1.2.0 with release notes), though a few modes/parameters are vestigial stubs. Nearly all Azure interaction is plain ARM REST (management.azure.com), so the logic ports well to a browser app via the platform proxy; the filesystem-centric config/artifact handling and console prompts need redesign around KV store, UI dialogs, downloads, and direct Cribl REST API calls.

Reader-noted gaps: 1) CollectCribl mode is a stub - Run-DCRAutomation.ps1 line ~711 contains only the comment "[Rest of CollectCribl implementation remains the same...]" then prints success; a real implementation may exist in git history or in copies of this engine elsewhere (Azure/Labs/UnifiedLab and the Electron Cribl-Microsoft_IntegrationSolution both invoke this script per repo status). 2) ValidateSet on -Mode accepts legacy values "Native", "Custom", "Both" that have no handler in the Execute-Mode switch (silent no-op). 3) Engine parameters SkipKnownIssues, ValidateTablesOnly, and PreserveLargeTemplates are declared but never referenced in the script body (vestigial), as is operation-parameters scriptBehavior.skipKnownIssues/validateTablesOnly. 4) The CLAUDE.md-documented dev/ vs core/ pattern is only half-present here: the .dev-mode selector code exists but there is no dev/ directory in DCR-Automation. 5) core/azure-parameters.json is committed with real-looking tenant/subscription/client IDs and ownerTag (jpederson@cribl.io) - a hygiene issue to note when porting defaults. 6) Generated artifacts are committed (core/generated-templates/, core/cribl-dcr-configs/ incl. 20+ destination JSONs, and 100+ logs/ files); I treated these as outputs, not features. 7) Role assignment (Monitoring Metrics Publisher on DCRs) is documented as a manual step in README, not automated - a natural add for the app (ARM roleAssignments API). 8) The related static template library (~120 ARM templates) lives in the sibling DCR-Templates directory, outside this subsystem's scope. 9) Deployment polling/timeout behavior (deployment.deploymentTimeout=600) is configured but I did not find it consumed by the engine; long ARM deployments in the app must be polled under the proxy's 30-second per-request limit regardless.

### DCR-01. Interactive deployment menu

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/Run-DCRAutomation.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- Console menu (options 1-7) showing current config (subscription, workspace, RG, tenant/client IDs, DCR mode), Quick Deploy from operational parameters, targeted Native/Custom x Direct/DCE deployments, Private Link variants, per-deployment Y/N confirmation, and press-any-key pacing.
- In/Out: In: user menu selections, azure-parameters.json, operation-parameters.json, CustomTableList.json. Out: invocations of Create-TableDCRs.ps1 with computed switch combinations; combined summaries.
- Depends on: PowerShell console (Read-Host/Clear-Host), local JSON config files, Create-TableDCRs.ps1 child invocation.
- Portability: Console Read-Host menu becomes React UI screens; the option structure (Quick Deploy, 4 targeted modes, 2 Private Link modes) maps directly to app navigation. All underlying actions go through the ARM proxy.

### DCR-02. Non-interactive mode dispatcher and native+custom orchestration

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/Run-DCRAutomation.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- -NonInteractive -Mode dispatcher (DirectNative/DirectCustom/DirectBoth/DCENative/DCECustom/DCEBoth/PrivateLinkNative/PrivateLinkCustom/TemplateOnly/Status/CollectCribl/ValidateCribl/ResetCribl) for CI/CD; Both modes run native then custom passes and render a combined summary (Show-CombinedSummary) aggregating DCRs/DCEs created/existed, tables created/migrated/skipped/failed. Auto-disables name-confirmation prompts in non-interactive runs. A .cribl-collection-in-progress marker file guards runs.
- In/Out: In: -Mode string plus pass-through switches (-ShowCriblConfig, -SkipCriblExport, -MigrateCustomTablesToDCR, -AutoMigrateCustomTables, -ConfirmDCRNames, -Quiet, -LogPath). Out: engine executions, combined summary hashtables printed to console, exit codes.
- Depends on: PowerShell child-script invocation (& $ScriptPath), filesystem marker file, Register-EngineEvent exit handler.
- Portability: Mode dispatch and summary aggregation are pure logic (direct); child-process invocation of the engine script becomes in-app function calls; marker-file run guard becomes KV-based state. Long deployments must be chunked/polled under the 30s proxy timeout.

### DCR-03. Azure parameters preflight validation

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/Run-DCRAutomation.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **direct**
- Test-AzureParametersConfiguration validates azure-parameters.json exists, parses, and that subscriptionId/resourceGroupName/workspaceName/location/tenantId/clientId are neither empty nor known placeholder values (e.g. <YOUR-TENANT-ID-HERE>); interactive mode loops (Wait-ForConfigurationUpdate) until fixed, non-interactive mode exits 1.
- In/Out: In: azure-parameters.json. Out: boolean pass/fail plus itemized missing/placeholder field lists.
- Depends on: Local JSON file read only.
- Portability: Pure validation logic; becomes settings-form validation in the SPA with config stored in the app KV store.

### DCR-04. CLI parameter override injection (Integration Solution embed hook)

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/Run-DCRAutomation.ps1` | Maturity: production | Category: infra-tooling | Verdict: **platform-provided**
- Optional -SubscriptionId/-ResourceGroupName/-WorkspaceName/-Location/-TenantId/-ClientId/-OwnerTag/-DcrPrefix/-DcrSuffix parameters are written into azure-parameters.json before validation, letting the Electron Integration Solution drive the scripts without editing config files; also supports external -LogPath append and -Quiet for embedded runs.
- In/Out: In: CLI override parameters. Out: mutated azure-parameters.json on disk.
- Depends on: Filesystem write access to config JSON.
- Portability: In a Cribl app this shim disappears: app state/KV store holds the Azure context directly and there is no external caller mutating config files.

### DCR-05. dev/core environment switching via .dev-mode flag

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/Run-DCRAutomation.ps1` | Maturity: production | Category: infra-tooling | Verdict: **out-of-scope**
- A hidden .dev-mode flag file in the script root selects the dev/ subdirectory over core/ for all scripts and config; in the current tree only core/ exists and no .dev-mode file is present, so the mechanism is dormant.
- In/Out: In: presence/absence of .dev-mode file. Out: $Environment path segment (dev|core) used for every file resolution.
- Depends on: Filesystem Test-Path.
- Portability: Developer-environment plumbing; a browser app would use build-time environments or feature flags instead. Catalogued so it is not silently dropped.

### DCR-06. Per-table DCR deployment engine orchestration

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- Main pipeline: load config and table list, optionally filter to one table (-SpecificDCR), per table resolve schema (native or custom path), build/confirm DCR name, optionally create DCE, skip already-existing DCRs (idempotent, still capturing their Cribl config), generate ARM template, validate structure, deploy or stop at template-only, apply ownerTag tags, accumulate a rich summary (created/existed/not-found/manual-recommended/failures) and print next-step guidance. Command-line switches override operation-parameters.json values; -IgnoreOperationParameters uses CLI only.
- In/Out: In: azure-parameters.json, operation-parameters.json, NativeTableList.json/CustomTableList.json, dcr-template-*.json, ~20 CLI parameters. Out: deployed DCRs/DCEs, generated-templates/*.json, cribl-dcr-configs/cribl-dcr-config.json, execution summary object.
- Depends on: Az.OperationalInsights, Az.Monitor, Az.Resources modules (auto-installed), management.azure.com REST, filesystem, PowerShell 5.1+.
- Portability: The workflow itself is portable state-machine logic, but PowerShell cmdlets become ARM REST calls through the proxy, local template files become KV entries/downloads, and console prompts become UI. Batch runs across many tables must respect the 100 req/min proxy limit.

### DCR-07. Log Analytics table schema retrieval with variant resolution

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **needs-proxy**
- Get-LogAnalyticsTableSchema GETs the workspace tables ARM API (api-version 2022-10-01) trying name variants: custom mode checks TableName_CL first, native mode checks only Microsoft-TableName and exact name and explicitly refuses _CL matches to prevent native/custom collisions. Flattens nested schema, returns columns/standardColumns, retention values, and existence tri-state (true/false/unknown).
- In/Out: In: workspace resource ID, table name, custom/native mode. Out: {Exists, TableName (resolved variant), Schema, RetentionInDays, TotalRetentionInDays}.
- Depends on: ARM REST (management.azure.com tables API), Azure AD access token.
- Portability: Plain HTTPS GET to management.azure.com; port variant/collision logic verbatim to TypeScript, route the call through proxies.yml with an injected Azure AD token.

### DCR-08. Column type mapping to DCR-legal types

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **direct**
- ConvertTo-DCRColumnType maps ~25 source type names (int32, bigint, double, decimal, bool, timestamp, object, json, guid, uniqueidentifier, uuid, etc.) to the DCR-supported set (string/int/long/real/boolean/datetime/dynamic), converting GUID-family types to string and defaulting unknowns to string with a warning.
- In/Out: In: source column type string. Out: DCR-legal type string.
- Depends on: None.
- Portability: Pure lookup table; trivial TypeScript function.

### DCR-09. Schema column filtering and DCR column-set generation

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **direct**
- Get-TableColumns picks the right schema property (.columns for DCR-based custom tables, .standardColumns for native/MMA-legacy, with a suspicious-standardColumns heuristic), applies mode-specific system-column blocklists (minimal for custom: _ResourceId/_SubscriptionId/_ItemId/_IsBillable/_BilledSize/Type; broad for native incl. TenantId, MG, PartitionKey, TimeCollected...), drops GUID-typed columns, converts remaining types, and reports a filtering/type-conversion summary.
- In/Out: In: table name, schema object, custom/native mode. Out: array of {name, type} columns for the DCR streamDeclaration, or null.
- Depends on: ConvertTo-DCRColumnType.
- Portability: Pure data transformation over the fetched schema JSON; ports as-is. This encoding of Azure quirks (MMA vs DCR-based schema shapes, reserved columns) is high-value domain knowledge.

### DCR-10. DCR/DCE name generation with 30/64-char abbreviation

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **direct**
- Builds names as prefix+table+location(+suffix); Direct DCRs over 30 chars use a curated abbreviation map (CommonSecurityLog->CSL, SecurityEvent->SecEvt, WindowsEvent->WinEvt, DeviceEvents->DevEvt, BehaviorAnalytics->BehAna) falling back to first-6-chars, then hard-truncates to 30 and trims hyphens; DCE-based DCRs (64-char limit) truncate only the table segment preserving prefix/location/suffix; enforces 3-char minimum. Custom tables drop _CL for naming brevity.
- In/Out: In: dcrPrefix/dcrSuffix/dcePrefix/dceSuffix, table name, location, mode. Out: valid resource name plus was-abbreviated flag.
- Depends on: None.
- Portability: Pure string logic; port verbatim including the abbreviation dictionary.

### DCR-11. Interactive resource-name confirmation with edit mode

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- Confirm-ResourceName (v1.2.0 feature) shows each proposed DCR/DCE name with length/abbreviation context and offers [Y]es accept / [N]o skip-this-resource / [E]dit with a pre-filled validation loop (max length, min 3 chars, hyphen trimming, retry-or-fallback). Skipping a DCE also skips its DCR. Controlled by -ConfirmDCRNames (default on, forced off in non-interactive mode).
- In/Out: In: resource type, proposed name, table name, max length, abbreviated flag. Out: {Action: Accept|Skip, Name}.
- Depends on: Console Read-Host (to be replaced by UI).
- Portability: Validation rules are direct-port logic; the Read-Host loop becomes a review-and-edit table/dialog in the SPA (arguably a better fit than sequential prompts).

### DCR-12. Standalone ARM template generation with embedded schema

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **direct**
- Deep-copies the base template, replaces [variables('streamName')] references with hardcoded stream names, injects the column array into streamDeclarations, rewrites dataFlows streams/outputStream, removes tableName/columns parameters, and encodes the critical stream-naming rule: input is always Custom-<Table>; output is Microsoft-<Table> for native tables but Custom-<Table> for custom tables. Template-only variant adds defaultValues (name, location) and blank resource IDs for portal upload; deployment variant embeds metadata (deploymentMode, tableName, tableType, streamName, outputStreamName, generatedOn) later mined for Cribl export.
- In/Out: In: base ARM template JSON, column array, names, mode flags. Out: <Table>-<timestamp>.json and <Table>-latest.json ARM templates.
- Depends on: dcr-template-direct.json / dcr-template-with-dce.json assets; filesystem writes (replace with KV/download).
- Portability: Pure JSON templating; in-browser generation with download or direct ARM deployment. The Custom-/Microsoft- stream rule and metadata block should be preserved exactly.

### DCR-13. Template complexity analysis and manual-deployment gate

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **direct**
- Get-TemplateDeploymentRecommendation classifies complexity by column count (>50 Medium, >100 High, >150 Very High), blocks automatic deployment when template exceeds 4 MB (ARM limit) or table exceeds 300 columns, warns above 2 MB, and Show-ManualDeploymentInstructions directs users to Azure Portal custom-template deployment with the saved file. Failed deployments also route into this manual path.
- In/Out: In: schema, table name, template byte size. Out: {ShouldDeploy, Reason, EstimatedComplexity, Warnings}; console instructions.
- Depends on: None.
- Portability: Pure heuristics; in the app this becomes a pre-flight warning plus a download-template-and-portal-link flow.

### DCR-14. Template versioning and cleanup

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- Every generation writes both a timestamped archive copy and a *-latest.json; Invoke-TemplateCleanup prunes timestamped versions beyond keepTemplateVersions (operation-parameters templateManagement.cleanupOldTemplates/keepTemplateVersions, default keep 1) while never deleting -latest files; end-of-run report counts latest vs archived templates.
- In/Out: In: generated-templates/ directory, table name, keep count. Out: pruned template files.
- Depends on: Local filesystem.
- Portability: Filesystem versioning becomes KV-store keyed history (or is dropped in favor of on-demand regeneration plus downloads).

### DCR-15. ARM template deployment with error diagnostics

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **needs-proxy**
- Deploys the generated template via New-AzResourceGroupDeployment with a truncated-to-64-char deployment name; on success extracts dataCollectionRuleId output and applies the ownerTag; on InvalidTemplateDeployment failures re-fetches the deployment StatusMessage, parses nested error.details for actionable messages, and downgrades the table to the manual-deployment path instead of aborting the batch.
- In/Out: In: template JSON, DCR name, location, workspaceResourceId, optional endpointResourceId. Out: deployed DCR, DCR resource ID, Owner tag, or manual-deployment case record.
- Depends on: ARM REST deployments + resources/tags APIs (management.azure.com); Az.Resources today.
- Portability: Maps to ARM deployments REST API (PUT deployment, then poll provisioningState and GET status for error details) through the proxy; polling replaces the synchronous cmdlet within the 30s/request limit.

### DCR-16. DCE creation and reuse with network access control

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **needs-proxy**
- In DCE modes: checks for an existing Data Collection Endpoint by name, otherwise creates one with NetworkAclsPublicNetworkAccess Enabled or Disabled (from privateLink.dcePublicNetworkAccess), applies ownerTag, tracks created/existed counts, and in template-only mode substitutes a placeholder DCE resource ID.
- In/Out: In: dcePrefix/dceSuffix, table name, location, network access setting. Out: DCE resource ID consumed by the DCR template.
- Depends on: ARM REST dataCollectionEndpoints API; Az.Monitor today.
- Portability: GET/PUT Microsoft.Insights/dataCollectionEndpoints via ARM REST through the proxy; logic is straightforward.

### DCR-17. Private Link (AMPLS) automation

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **needs-proxy**
- New-AMPLSIfNotExists creates/reuses an Azure Monitor Private Link Scope (global location, auto-named ampls-<workspace>); Add-WorkspaceToAMPLS and Add-DCEToAMPLS create privateLinkScopedResource associations (idempotent, with manual-portal fallback messaging). PrivateLink menu modes in Run-DCRAutomation.ps1 temporarily flip operation-parameters privateLink.enabled and dcePublicNetworkAccess=Disabled for the run, then restore the file.
- In/Out: In: privateLink.* settings (enabled, dcePublicNetworkAccess, amplsResourceId or name+RG), workspace/DCE resource IDs. Out: AMPLS resource, workspace and DCE scoped-resource associations, private-only DCEs.
- Depends on: ARM REST Microsoft.Insights/privateLinkScopes APIs; Az.Monitor Get/New-AzInsightsPrivateLinkScope(dResource) today. Note: actual private endpoint/VNet wiring is left to the user.
- Portability: All AMPLS operations are ARM REST (privateLinkScopes / scopedResources) and proxy cleanly; the temporary config-file mutation pattern should become explicit per-run options instead of mutating stored settings.

### DCR-18. Custom table creation from JSON schema

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **needs-proxy**
- New-LogAnalyticsCustomTable PUTs the workspace tables API (2022-10-01) with plan Analytics, retentionInDays/totalRetentionInDays, and the schema columns after stripping 13 Azure-reserved column names (Type, ItemCount, SourceSystem, Computer, RawData, TenantId, _ResourceId, ...) that cause 400s; enforces the _CL suffix; surfaces HTTP status/response-body diagnostics and detects already-exists conflicts.
- In/Out: In: workspace resource ID, table name, column array, retention values. Out: created _CL table (or AlreadyExists signal) plus API response.
- Depends on: ARM REST tables PUT (management.azure.com), Azure AD token.
- Portability: Already a raw REST call; ports directly through the proxy. Keep the reserved-column blocklist and detailed 4xx diagnostics.

### DCR-19. Custom table schema file format and loader

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/custom-table-schemas/README.md` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- Documented JSON schema format ({description, retentionInDays, totalRetentionInDays, columns:[{name,type,description}]}) with supported types string/int/long/real/boolean/datetime/dynamic; Get-CustomTableSchemaFromFile (Create-TableDCRs.ps1) resolves TableName_CL.json or TableName.json, validates name/type presence, converts types, auto-appends TimeGenerated:datetime if missing, and applies retention defaults; the engine also writes a SampleTable_CL.json.sample scaffold on first run.
- In/Out: In: TableName_CL.json schema files in custom-table-schemas/. Out: normalized {columns, retentionInDays, totalRetentionInDays, description} object feeding table creation and DCR generation.
- Depends on: Local filesystem (to be replaced by KV/upload); ConvertTo-DCRColumnType.
- Portability: Parsing/validation logic is direct-port; the local schema directory becomes KV-stored schema documents plus a file-upload/paste editor in the app.

### DCR-20. Bundled vendor schema library (CrowdStrike, Cloudflare)

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/custom-table-schemas/CrowdStrike_Process_Events_CL.json` | Maturity: production | Category: dcr-deployment | Verdict: **direct**
- Fourteen ready-made custom-table schema files: eleven CrowdStrike FDR event tables (Process/Network/DNS/File/Auth/Registry/Audit/User/Additional/Secondary), CloudFlare_CL, CloudflareV2_CL, and MyCustomApp_CL example; the Process Events schema alone defines ~146 columns. Paired with CustomTableList.json pre-populated with the ten CrowdStrike tables.
- In/Out: In: none (static). Out: column definitions consumed by table creation and DCR streamDeclarations.
- Depends on: None.
- Portability: Static JSON data assets; bundle with the app as a built-in schema catalog users can deploy or clone.

### DCR-21. Classic/MMA to DCR-based table migration

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **needs-proxy**
- Convert-CustomTableToDCRBased checks a table's current ingestion mode then POSTs the tables/{name}/migrate endpoint (api-version 2021-12-01-preview), handling 409 already-migrated, 404, and 400 not-eligible cases distinctly. Process-CustomTable auto-detects MMA legacy tables (schema only in standardColumns), recommends/forces migration for them (MMA tables cannot get DCRs otherwise), and supports prompt-based (migrateExistingTablesToDCRBased) or silent (autoMigrateExistingTables) migration of existing tables only.
- In/Out: In: workspace resource ID, table name, auto/prompt flags. Out: migration result {Success, AlreadyMigrated, NotEligible, Error}; updated summary CustomTablesMigrated count.
- Depends on: ARM REST tables migrate endpoint (preview API), Azure AD token.
- Portability: Raw REST already; MMA detection heuristics and the eligibility error taxonomy port as-is. Prompts become UI confirmations.

### DCR-22. Custom table processing orchestration

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- Process-CustomTable is the decision tree per custom table: exists-in-Azure -> reuse schema (+optional/forced migration); missing -> load schema file and create table (then wait ~10s and re-fetch schema); neither -> interactive guidance offering skip-and-continue or stop-with-a-generated-PowerShell-snippet for authoring the schema file; races (created between check and create) handled via AlreadyExists re-fetch.
- In/Out: In: table name, workspace ID, schema directory, retention defaults, migration flags. Out: {Success, TableName, Schema, Source: Azure|Created, Skipped/Error}.
- Depends on: Get-LogAnalyticsTableSchema, Get-CustomTableSchemaFromFile, New-LogAnalyticsCustomTable, Convert-CustomTableToDCRBased.
- Portability: Decision flow is portable; Read-Host branches become wizard steps, and the fixed sleep becomes polling until the table GET returns the schema.

### DCR-23. Azure session management, token refresh, and auth-retry wrapper

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: identity-auth | Verdict: **platform-provided**
- Ensure-AzureConnection / Ensure-ValidAzureConnection verify Get-AzContext, test token validity with a probe call, silently refresh via Get-AzAccessToken or cached Connect-AzAccount -AccountId; Test-TokenRefresh re-checks every N operations during long batches; Invoke-AzureOperationWithRetry retries operations up to 2 times on auth-signature errors (401/403/expired/acquire token) after refreshing. Engine startup also auto-installs missing Az modules and sets subscription context from config.
- In/Out: In: existing Az session / stored credentials. Out: valid bearer tokens for management.azure.com; retried operations.
- Depends on: Az.Accounts today; replaced by Azure AD token endpoint via proxies.yml + KV secrets.
- Portability: The platform proxy injects auth headers from the encrypted KV store and the app performs OAuth client-credential flows against login.microsoftonline.com; only a thin retry-on-401-with-token-refresh wrapper needs reimplementing client-side. Module installation is moot.

### DCR-24. Resource group and workspace verification with discovery hints

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: discovery | Verdict: **needs-proxy**
- Before processing, verifies the configured resource group and Log Analytics workspace exist; on failure lists up to 10 available resource groups or all workspaces in the RG to help the user correct azure-parameters.json, then exits.
- In/Out: In: resourceGroupName, workspaceName. Out: workspaceResourceId for the run, or guided error with candidate names.
- Depends on: ARM REST resourceGroups/workspaces list APIs.
- Portability: ARM REST GET/list calls; in the app this improves into dropdown pickers populated from the same list APIs rather than error-time hints.

### DCR-25. Cribl config capture from deployed DCRs

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **needs-proxy**
- Get-CriblConfigFromDCR assembles {DCRName, DCRImmutableId, StreamName, TableName, IngestionEndpoint, Type} per DCR: fetches the full DCR via REST api-version 2023-03-11 to read properties.endpoints.logsIngestion (Direct DCRs, March-2024 ARM shape) with multiple legacy property-path fallbacks and a hard error if absent; for DCE-based DCRs resolves the DCE's logsIngestionEndpoint with constructed-URL fallbacks; recovers stream/table names from generated-template metadata, DCR dataFlows, or 3/4-part DCR-name regex parsing as last resort.
- In/Out: In: RG, DCR name, optional DCE resource ID, table name. Out: Cribl config record per DCR.
- Depends on: ARM REST dataCollectionRules/dataCollectionEndpoints GET; generated-templates metadata files (optional).
- Portability: Core value for Cribl integration; the REST fetch and property-path fallback chain (much of it PowerShell-object-shape noise) simplifies in TS to a couple of JSON paths on the raw ARM response. Name-parsing fallbacks port verbatim.

### DCR-26. Cribl DCR config export aggregation

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- On every run (unless -SkipCriblExport) loads any existing cribl-dcr-configs/cribl-dcr-config.json, appends newly captured configs including those of pre-existing DCRs, dedupes by DCRName, sorts, and writes {GeneratedAt, Purpose, ResourceGroup, Workspace, DCRCount, DCRs[]}; then auto-invokes Generate-CriblDestinations.ps1. -ShowCriblConfig additionally prints each config (Show-CriblConfiguration).
- In/Out: In: per-DCR Cribl config records, existing export file. Out: cribl-dcr-config.json master file; chained destination generation.
- Depends on: Filesystem (to KV); Generate-CriblDestinations.ps1 chaining.
- Portability: Merge/dedupe logic is direct; the JSON file becomes a KV-store document, and 'export' becomes both a download and the seed for direct Cribl destination creation.

### DCR-27. Cribl Sentinel destination config generator

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Generate-CriblDestinations.ps1` | Maturity: production | Category: pipeline-generation | Verdict: **needs-redesign**
- For each DCR in cribl-dcr-config.json produces an import-ready Cribl Stream 'sentinel' destination JSON from dst-cribl-template.json by ordered string replacement: destination ID = IDprefix+Table+IDsuffix from cribl-parameters.json (with _CL stripping, non-alphanumeric to underscore, and an Azure-region blocklist so a location never becomes the table name); fills dceEndpoint, dcrID, streamName, url (dataCollectionRules/{id}/streams/{stream}?api-version=2021-11-01-preview), loginUrl with tenantId, client_id; secret always '<replace me>' so real secrets are never written. Regenerates missing Stream/Table names from DCR-name regexes; writes destinations/*.json plus destinations-metadata.json and destinations-summary.json.
- In/Out: In: cribl-dcr-config.json, dst-cribl-template.json, azure-parameters.json (tenant/client IDs), cribl-parameters.json (IDprefix/IDsuffix). Out: per-DCR Cribl destination JSON files + metadata/summary manifests.
- Depends on: Local files today; Cribl product REST API + KV in the app.
- Portability: Template substitution is direct TS; the big win in a Cribl app is skipping file export entirely and POSTing the destination to the Cribl REST API (/system/outputs) via capability 1, with the client secret stored in Cribl secrets rather than a placeholder. Keep file download as a secondary export path.

### DCR-28. handler.control endpoint correction

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Generate-CriblDestinations.ps1` | Maturity: production | Category: pipeline-generation | Verdict: **direct**
- Fix-HandlerControlEndpoint detects DCE configuration-access URLs of the form https://<dce>.<region>-N.handler.control.monitor.azure.com that Azure sometimes returns instead of ingestion URLs, and rewrites them to the correct https://<dce>.<region>-1.ingest.monitor.azure.com form via two regex patterns.
- In/Out: In: endpoint URL string. Out: corrected ingestion URL (or original if not applicable).
- Depends on: None.
- Portability: Pure regex utility encoding a real Azure API quirk; port verbatim.

### DCR-29. Live ingestion-endpoint re-verification

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Generate-CriblDestinations.ps1` | Maturity: production | Category: pipeline-generation | Verdict: **needs-proxy**
- Get-DirectDCRIngestionEndpoint re-fetches each Direct DCR (api-version 2023-03-11) at generation time to get its true per-DCR logsIngestion endpoint, detects and rejects generic regional endpoints (https://<region>.ingest.monitor.azure.com), reclassifies DCRs that are actually DCE-based, and for DCE-based DCRs with unusable stored endpoints guesses DCE names from naming-pattern permutations and queries them until an endpoint is found; skips destinations whose endpoint remains unresolved.
- In/Out: In: subscription, RG, DCR name, stored endpoint. Out: verified per-DCR ingestion endpoint or skip decision.
- Depends on: ARM REST dataCollectionRules/dataCollectionEndpoints GET.
- Portability: REST GETs through the proxy; the generic-endpoint rejection and DCE-name guessing heuristics port directly, though guessing loops should be bounded for the rate limit.

### DCR-30. Cribl config utility modes (Status/ValidateCribl/ResetCribl)

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/Run-DCRAutomation.ps1` | Maturity: production | Category: reporting | Verdict: **needs-redesign**
- Status prints effective configuration (DCR mode, custom-table/template-only flags, table lists, Azure resources, export toggles); ValidateCribl checks the exported config for DCRs missing IngestionEndpoint, StreamName, or TableName and reports counts; ResetCribl backs up cribl-dcr-config.json to a timestamped .backup file then deletes it.
- In/Out: In: config and export JSON files. Out: console reports, backup file, cleared config.
- Depends on: Local JSON files (to KV).
- Portability: Validation checks are direct logic over the KV-stored config; Status becomes a dashboard; Reset becomes KV delete with history.

### DCR-31. CollectCribl mode (collect config from existing DCRs)

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/Run-DCRAutomation.ps1` | Maturity: placeholder | Category: dcr-deployment | Verdict: **needs-proxy**
- Advertised mode to rebuild the Cribl config by scanning existing DCRs in the resource group; the handler loads parameters and prints headers but the body is literally a comment '[Rest of CollectCribl implementation remains the same...]' followed by a success message - it performs no collection.
- In/Out: In: azure-parameters (RG, workspace, dcrPrefix, location). Out: intended cribl-dcr-config.json; currently nothing.
- Depends on: ARM REST dataCollectionRules list + Get-CriblConfigFromDCR equivalent.
- Portability: Must be (re)implemented: list dataCollectionRules in the RG via ARM REST filtered by dcrPrefix and run the existing Get-CriblConfigFromDCR logic per DCR. Valuable app feature (import existing DCR estate), currently a stub.

### DCR-32. Output/verbosity/logging infrastructure

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/Output-Helper.ps1` | Maturity: production | Category: infra-tooling | Verdict: **platform-provided**
- Shared Write-DCR* functions (Info/Success/Warning/Error/Progress/Verbose/Header) with global verbose toggle, -Quiet mode (errors only, for embedded runs), and timestamped file logging to logs/DCR_Automation_<ts>.log (or append to an external -LogPath for callers like UnifiedLab/Integration Solution).
- In/Out: In: log messages with levels. Out: colored console output and UTF-8 log files.
- Depends on: PowerShell console and filesystem.
- Portability: Browser app uses its own UI status panes/toasts and console logging; a lightweight in-app activity log (KV-persisted) can replace file logs if audit history is desired.

### DCR-33. DCR ARM template assets (Direct and DCE-based)

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/dcr-template-direct.json` | Maturity: production | Category: dcr-deployment | Verdict: **direct**
- Two parameterized base ARM templates: dcr-template-direct.json creates kind:Direct DCRs (apiVersion 2023-03-11) with streamDeclarations, logAnalytics destination, transformKql 'source', Custom-/Microsoft- stream variables, and a dataCollectionRuleId output; dcr-template-with-dce.json is the DCE-based variant adding a dataCollectionEndpointId bound to the endpointResourceId parameter.
- In/Out: In: dataCollectionRuleName, location, workspaceResourceId, tableName, columns (+endpointResourceId for DCE). Out: DCR resource definition.
- Depends on: None (consumed by the engine).
- Portability: Static JSON assets; bundle in the app and feed the template-generation logic unchanged. Kind:Direct requires Cribl Stream 4.14+ per root docs.

### DCR-34. Operation and naming configuration schema

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/core/operation-parameters.json` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- The behavior-controlling option set, each self-documented in _comments: deployment.createDCE (Direct vs DCE mode switch), skipExistingDCRs/DCEs, deploymentTimeout; scriptBehavior.templateOnly/verboseOutput (skipKnownIssues and validateTablesOnly are declared but unused); templateManagement.cleanupOldTemplates/keepTemplateVersions/preserveLargeTemplates(unused); privateLink.{enabled,dcePublicNetworkAccess,amplsResourceId|Name|ResourceGroupName}; customTableSettings.{enabled,schemasDirectory,customTableListFile,nativeTableListFile,defaultRetentionDays,defaultTotalRetentionDays,autoCreateTables,migrateExistingTablesToDCRBased,autoMigrateExistingTables}. Companion files: azure-parameters.json (subscription/RG/workspace/location, tenantId/clientId, dcr/dcePrefix+Suffix, ownerTag), cribl-parameters.json (destination IDprefix/IDsuffix), NativeTableList.json and CustomTableList.json table selections.
- In/Out: In: user-edited JSON. Out: effective engine behavior (mode, retention, migration, cleanup, private link).
- Depends on: Local JSON files (to KV).
- Portability: Becomes the app's settings model in the KV store with a settings UI; CLI-over-file precedence rules simplify to one source of truth. Every option above is a behavior switch the app must expose or consciously drop.

### DCR-35. Subsystem documentation set

- Source: `Azure/CustomDeploymentTemplates/DCR-Automation/README.md` | Maturity: docs-only | Category: documentation | Verdict: **direct**
- README (features, config reference, mode table, troubleshooting matrix, security guidance, expected output), QUICK_START.md, custom-table-schemas/README.md (schema format spec), and RELEASE_NOTES/v1.0.0-v1.2.0 documenting feature evolution (name confirmation, directory reorg).
- In/Out: In: none. Out: user guidance.
- Depends on: None.
- Portability: Content ports into in-app help/onboarding; the mode table, schema format spec, and troubleshooting matrix are the highest-value pieces to carry over.


## DCR Template Library and Static Assets (AST)

The static-assets subsystem is essentially one real deliverable: a production-quality library of 100 prebuilt ARM templates (50 Sentinel native tables in both Direct and DCE-based DCR flavors) with complete column schemas embedded, plus a thorough deployment README. The templates are pure JSON data and port to a browser app as-is, with in-app deployment becoming a proxied ARM REST call and the embedded streamDeclarations doubling as an offline schema catalog for pipeline/destination generation. The other three paths (SentinelPacks, Diagrams, FabricRTI) are entirely empty placeholder directories -- zero files, never committed -- whose intent (future pack library, diagram assets, Fabric RTI destination) is documented only in the SOC-OptimizationToolkit planning docs.

Reader-noted gaps: Three of the four paths (Azure/SentinelPacks, Azure/Diagrams, Azure/dev/FabricRTI) are empty local directories with no git history at all -- they exist only in the working tree (git does not track empty dirs), so their intent is reconstructed from SOC-OptimizationToolkit_v1/CONTEXT.md and docs/roadmap.md rather than from any content. CLAUDE.md advertises "~120 pre-built ARM templates" but the actual count is exactly 100 (50 tables x 2 modes); the subsystem hint's mention of a "custom" table family does not exist here -- DCR-Templates contains only SentinelNativeTables, and custom (_CL) table templates are generated dynamically by the DCR-Automation engine (a different subsystem). The static schemas are point-in-time snapshots with no versioning or refresh mechanism, so schema drift versus live Azure Log Analytics is unassessed. Whether any generated-template output directories elsewhere (core/generated-templates/) overlap with this static library is a DCR-Automation subsystem question.

### AST-01. Prebuilt Sentinel native-table DCR ARM template library

- Source: `Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables` | Maturity: production | Category: dcr-deployment | Verdict: **direct**
- A library of 100 static, ready-to-deploy ARM templates (50 Sentinel native tables x 2 deployment modes) that create Azure Data Collection Rules with full column schemas baked in. Two config variations of one capability: DataCollectionRules(NoDCE)/ holds Direct DCRs (kind:Direct, apiVersion 2023-03-11, 3 parameters: dataCollectionRuleName, location, workspaceResourceId) and DataCollectionRules(DCE)/ holds DCE-based DCRs (adds endpointResourceId parameter and omits kind:Direct). Table family census (50 tables per mode): 10 ASIM normalized tables (ASimAuditEventLogs, ASimAuthenticationEventLogs, ASimDhcpEventLogs, ASimDnsActivityLogs, ASimFileEventLogs, ASimNetworkSessionLogs, ASimProcessEventLogs, ASimRegistryEventLogs, ASimUserManagementActivityLogs, ASimWebSessionLogs); 4 AWS (CloudTrail, CloudWatch, GuardDuty, VPCFlow); 2 GCP (GCPAuditLogs, GoogleCloudSCC); 8 core Microsoft/Azure security tables (SecurityEvent, CommonSecurityLog, Syslog, WindowsEvent, Event, AzureActivity, AzureDiagnostics, Anomalies); 4 Defender device tables (DeviceEvents, DeviceFileEvents, DeviceTvmSecureConfigurationAssessmentKB, DeviceTvmSoftwareVulnerabilitiesKB); 14 assessment/recommendation tables (AD, ADSecurity, Azure, Exchange, ExchangeOnline, SCCM, SCOM, SP, SharePointOnline, SQL, SfB, SfBOnline, WindowsClient, WindowsServer); 8 Update Compliance tables (UCClient, UCClientReadinessStatus, UCClientUpdateStatus, UCDOAggregatedStatus, UCDOStatus, UCDeviceAlert, UCServiceUpdateStatus, UCUpdateAlert). Each template wires stream Custom-{TableName} -> transformKql "source" -> outputStream Microsoft-{TableName} into a parameterized Log Analytics workspace and outputs the created dataCollectionRuleId. No custom (_CL) table templates exist here; those are generated dynamically by DCR-Automation.
- In/Out: In: user-supplied parameters (DCR name, Azure region, Log Analytics workspaceResourceId, and DCE endpointResourceId for the DCE variant). Out: a deployed Microsoft.Insights/dataCollectionRules resource plus its resource ID as an ARM output; the JSON files themselves are the distributable artifact.
- Depends on: Pure static JSON assets, no runtime dependencies. Deployment (documented as Azure Portal, az CLI, or New-AzResourceGroupDeployment) requires the Azure Resource Manager deployments API and an existing Log Analytics workspace (plus an existing DCE for the DCE variant).
- Portability: The library itself is pure data: bundle all 100 JSON files (or a deduplicated schema+mode generator) into the SPA as static assets and offer download or one-click deploy. In-app deployment of a selected template is a thin POST to the ARM deployments endpoint via proxies.yml (management.azure.com) with an Entra token, so the deploy action is needs-proxy, but the asset ports as-is. Note the 30-char Direct / 64-char DCE name limits when generating names client-side.

### AST-02. Static schema catalog for 50 Sentinel native tables (streamDeclarations)

- Source: `Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables/DataCollectionRules(NoDCE)` | Maturity: production | Category: pipeline-generation | Verdict: **direct**
- Embedded inside every template is a complete column-level schema (name/type pairs under streamDeclarations, e.g. Custom-SecurityEvent's full column list) for each of the 50 Sentinel native tables. This doubles as an offline schema reference usable independently of deployment: validating events, generating Cribl destination stream names, building field mappers, or seeding pipeline generation without a live Azure schema query. The README explicitly flags these as static snapshots versus DCR-Automation's dynamic schema retrieval from Azure.
- In/Out: In: table name selection. Out: ordered column name/type arrays per table (Log Analytics types: string, datetime, int, long, real, bool, dynamic, guid).
- Depends on: None at runtime; content derived from Azure Log Analytics table schemas at authoring time, so it can drift from Azure's current schemas (schema immutability caveat noted in the README).
- Portability: Extract the streamDeclarations into a TypeScript schema module or app KV data and use it browser-side for schema-aware features (event validation, Cribl destination config generation, column pickers). Consider a freshness strategy: fall back to these static schemas when live retrieval via the Log Analytics management API (proxy) is unavailable.

### AST-03. DCR template deployment guide and mode-selection documentation

- Source: `Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables/README.md` | Maturity: production | Category: documentation | Verdict: **direct**
- Documentation covering the library's directory layout, the Direct-vs-DCE decision matrix (cost, private link, routing, name-length limits 30 vs 64 chars), parameter reference tables, three deployment walkthroughs (Azure Portal custom template, az CLI, PowerShell New-AzResourceGroupDeployment), template anatomy (streamDeclarations/destinations/dataFlows/transformKql), and operational caveats (region must match workspace, schemas immutable after creation, DCE must pre-exist, DCE cost implications).
- In/Out: In: none (reference material). Out: user understanding; deployment commands to copy.
- Depends on: None; cross-references ../../DCR-Automation/ for the automated path.
- Portability: Content ports directly as in-app help text or a mode-selection wizard (the Direct-vs-DCE decision matrix maps naturally to a UI chooser). The az CLI / PowerShell command examples become irrelevant once the app deploys via ARM REST; keep the Portal path as a fallback instruction.

### AST-04. Sentinel pack library (placeholder)

- Source: `Azure/SentinelPacks` | Maturity: placeholder | Category: pack-management | Verdict: **out-of-scope**
- Completely empty directory: zero files, and no files were ever committed to git for this path. Per SOC-OptimizationToolkit_v1/CONTEXT.md (line 250) it is the intended future home for additional prebuilt Cribl packs targeting Sentinel; nothing has been built.
- In/Out: Nothing in, nothing out; no content exists.
- Depends on: None.
- Portability: Nothing to port. If prebuilt Sentinel packs materialize, the target app pattern is clear: bundle .crbl/.tgz pack artifacts as static assets and install them via the Cribl packs REST API (platform-native), so plan for that in the pack-management feature area rather than carrying this directory forward.

### AST-05. Architecture diagrams asset directory (placeholder)

- Source: `Azure/Diagrams` | Maturity: placeholder | Category: documentation | Verdict: **out-of-scope**
- Completely empty directory (created Sep 2025, zero files, never committed). Intended as a home for architecture/documentation diagram assets; the only actual diagram content in the repo lives elsewhere, as Mermaid/markdown in KnowledgeArticles/PrivateLinkConfiguration/Network-Architecture-Diagrams.md.
- In/Out: Nothing in, nothing out; no content exists.
- Depends on: None.
- Portability: Nothing to port from this path. Diagram content that does exist (KnowledgeArticles/PrivateLinkConfiguration/Network-Architecture-Diagrams.md, markdown/Mermaid) is trivially renderable in a React SPA if the app wants embedded architecture help; that file belongs to the KnowledgeArticles subsystem, not this one.

### AST-06. Microsoft Fabric RTI integration (placeholder)

- Source: `Azure/dev/FabricRTI` | Maturity: placeholder | Category: dcr-deployment | Verdict: **out-of-scope**
- Completely empty directory (created Dec 2025, zero files, never committed). Per SOC-OptimizationToolkit_v1/CONTEXT.md (line 249) and docs/adr/0008 it marks a possible future alternative Microsoft destination: Cribl-to-Fabric Real-Time Intelligence, as a second destination adapter alongside Sentinel. Explicitly out of scope until built; Sentinel remains the primary destination.
- In/Out: Nothing in, nothing out; no content exists.
- Depends on: None yet; a future implementation would involve Microsoft Fabric APIs (Eventstream/Eventhouse endpoints) and Entra auth.
- Portability: Nothing to port. If built later, a Fabric RTI destination onboarding flow would fit the app model well (Fabric REST APIs via proxies.yml plus Cribl destination creation via the product API), so reserve it as a roadmap item rather than a migrated feature.


## Integration Solution - Backend Engine (ENG)

The Electron main process plus an Express "web mode" twin for the Cribl SOC Optimization Toolkit desktop app. It contains the deepest business logic in the repository: multi-format Cribl pipeline/pack generation (CEF/LEEF/CSV/JSON/KV), a 6-phase field-matching engine with serialize-overflow handling, a tiered sample resolver (Sentinel repo, Elastic integrations, Cribl packs, synthesis, user upload), a GitHub-API-based Sentinel Content Hub mirror with an EDR blocklist and crash detection, a full Cribl REST API client (auth, pack upload, destinations, routes, capture, preview, search), and Azure DCR deployment driven by PowerShell (Az module + the repo's Run-DCRAutomation.ps1). Roughly two-thirds of the code is pure TypeScript logic that ports directly to a browser SPA; the Azure side (PowerShell/child processes) and all filesystem-based storage (%APPDATA%, local repo mirrors, pack directories) require redesign onto proxied REST, the KV store, and browser downloads.

Reader-noted gaps: 1) The React renderer (src/renderer, ~pages like SentinelIntegration/Packs/Settings/SetupWizard) is a separate subsystem and was not cataloged here; several backend behaviors (integration modes full/azure-only/cribl-only/air-gapped, wizard flows) are only fully visible there. 2) The PowerShell DCR Automation engine itself (Azure/CustomDeploymentTemplates/DCR-Automation, ~4600 lines) lives outside this subsystem but is the actual implementation behind azure:deploy-dcrs - porting effort estimates for dcr-deployment features depend on mining that script (template generation, name abbreviation, table creation, DCE handling). 3) Several Cribl API integrations use multi-endpoint guessing (routes write paths, commit/deploy paths, Lake datasets, capture strategies 2-3), suggesting they were not fully validated against a specific Cribl version - when porting into the leader UI these should be pinned to the leader's real OpenAPI surface, which will simplify them substantially. 4) sample-resolver's SOLUTION_SAMPLE_MAP was only partially read (first ~120 of ~210 mapping lines); the full curated vendor list is longer than the entries quoted. 5) vendor-research static registry schema URLs (OpenAPI endpoints per vendor) were not individually enumerated - each becomes a proxies.yml domain entry and needs listing during implementation planning. 6) knowledge.md at the solution root and the uncommitted WIP changes to auth.ts/azure-deploy.ts/preload.ts/SetupWizard.tsx (per git status) may contain in-flight auth improvements not reflected in this catalog. 7) Change-detection and e2e-orchestrator middle sections were surveyed via signatures rather than full reads; their step internals may hold additional small behaviors (e.g. e2e uses powershell.exe not pwsh, unlike azure-deploy).

### ENG-01. Multi-format transformation pipeline generation

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/pack-builder.ts` | Maturity: production | Category: pipeline-generation | Verdict: **direct**
- generatePipelineConf() emits Cribl pipeline conf.yml with grouped functions (Field Extraction, Volume Reduction, Enrich & Classify, Overflow Collection, Sentinel Cleanup). Format-specific extraction: CEF two-step (eval header split + serde kvp extensions), LEEF (kvp tab-delimited), CSV (syslog-prefix strip + positional split, PAN-OS named columns for TRAFFIC/THREAT), JSON/KV serde. Timestamp handling includes CrowdStrike FDR epoch-ms eval with auto_timestamp backup and CEF 'rt' fallback. Generates rename/coerce/enrich evals from field mappings with buildCoercionExpr() type conversions.
- In/Out: In: table list with field mappings, vendor mappings, source format, overflow config, reduction rules. Out: pipeline conf.yml YAML strings.
- Depends on: Pure TS string building; consumes field-matcher, reduction-rules, vendor-research outputs. fs only for the final write (separable).
- Portability: Pure logic; ports as-is to browser TS. Only the fs.writeFileSync at the call site changes (in-memory pack tree, then push via Cribl pipelines API or pack download).

### ENG-02. Volume reduction pipeline generation with rules knowledge base

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/reduction-rules.ts` | Maturity: production | Category: pipeline-generation | Verdict: **direct**
- Curated keep/drop/suppress rule knowledge base per table/vendor (CommonSecurityLog, Syslog, WindowsEvent/SecurityEvent, AzureActivity, Cloudflare, PaloAlto, CrowdStrike, Fortinet) with findReductionRules() fuzzy lookup. pack-builder generateReductionPipelineConf()/generateFallbackReductionConf() emit self-contained reduction pipelines (triage serde, __keep tagging for analytics-critical events, drop functions, suppress with keyExpr/window, cleanup) claiming 40-80 percent ingest reduction; a no-op scaffold is emitted when no rules match.
- In/Out: In: table name + solution name. Out: TableReductionRules (keep/drop/suppress filters) and reduction pipeline conf.yml.
- Depends on: Pure TS data + string building.
- Portability: Directly portable data and logic.

### ENG-03. Serialize overflow handling

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/field-matcher.ts` | Maturity: production | Category: pipeline-generation | Verdict: **direct**
- Unmatched source fields are routed into a per-table overflow column instead of being dropped: TABLE_OVERFLOW_FIELDS maps tables to catch-all fields (CommonSecurityLog->AdditionalExtensions string, WindowsEvent/SecurityEvent->EventData dynamic, AzureActivity->Properties, _CL default AdditionalData_d). pack-builder (line ~701) emits a native Cribl serialize function with exclusion patterns (!__*, !schemaField, then *) writing JSON into the overflow field; OverflowConfig only enables when the overflow column exists in the destination schema.
- In/Out: In: match result (unmatched fields) + destination table name. Out: OverflowConfig + serialize function YAML in the pipeline.
- Depends on: Pure TS.
- Portability: Directly portable.

### ENG-04. 6-phase field matching engine

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/field-matcher.ts` | Maturity: production | Category: pipeline-generation | Verdict: **direct**
- matchFields() maps every source field to its best DCR destination column: Phase 0 vendor-specific mappings (case-insensitive, preserves actual casing), Phase 0.5 coalesce priority pre-assignment (e.g. TimeGenerated prefers timestamp>event_time>rt), then scored matching: exact (100), case-insensitive (95), 300+ entry alias table incl. full CEF extension dictionary cs1-cs6/cn1-cn3/c6a/cfp/flex (90), reverse alias (88), normalized (80), affix-stripped (70), substring (50-55) with vendor-prefix and Label-field guards. Boosts: event-type classification (network/auth/dns/web/firewall/process/file) and type-aware sample-value inspection (IP/port/timestamp/URL/MAC/protocol/action). Also exports VALUE_NORMALIZATIONS dictionaries (DeviceAction/LogSeverity/Protocol/EventOutcome/CommunicationDirection). Has unit tests (field-matcher.test.ts).
- In/Out: In: source fields (name/type/sampleValue), dest schema columns, optional vendor mappings, table name. Out: MatchResult {matched, overflow, unmatchedSource/Dest, overflowConfig, matchRate}.
- Depends on: Pure TS; fields:match-to-schema IPC loads DCR schema from pack-builder.
- Portability: Directly portable, including tests.

### ENG-05. DCR destination schema resolution

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/pack-builder.ts` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- loadDcrTemplateSchema()/loadDcrTemplateSchemaPublic() resolve a table's column schema by searching: bundled DCR ARM templates in app data (DataCollectionRules(DCE)/(NoDCE), Microsoft- prefix normalization), linked-repo DCR-Templates, custom-table-schemas JSON, and recursive Sentinel repo CustomTables/<table>.json scan. Filters ~17 Azure system columns (TenantId, _ResourceId, Type, etc.).
- In/Out: In: table name. Out: [{name,type}] column list.
- Depends on: fs reads across app-data templates, linked repo, and local Sentinel repo mirror.
- Portability: Logic is simple; storage must change: bundle the ~120 DCR template schemas as app assets or KV entries, and fetch solution CustomTables JSON from GitHub via proxies.yml on demand.

### ENG-06. Pack scaffolding (full pack tree build)

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/pack-builder.ts` | Maturity: production | Category: pack-management | Verdict: **needs-redesign**
- pack:scaffold builds a complete Cribl pack directory: package.json (vendorPrefix naming that strips noise words, minLogStreamVersion 4.14.0), pack.yml, breakers.yml (JSON array + NDJSON breakers; CrowdStrike gets 768KB maxEventBytes and timestamp-anchored breaking), per-table sample JSON files + samples.yml registry, per-logtype transformation and Reduction_ pipelines, route.yml with paired reduction (enabled, final) and passthrough (disabled) routes filtered by DCR-derived route conditions, outputs.yml Sentinel destinations (real deployed values or placeholders with !{sentinel_client_secret}), optional inputs.yml, plus FIELD_MAPPING_*.txt / VENDOR_RESEARCH.txt / DCR_GAP_ANALYSIS_*.txt reports. Orchestrates vendor research, sample field enrichment (case-priority from real data), CEF detection, field matching, kql routing and gap analysis. Captures a change-detection snapshot after build.
- In/Out: In: PackScaffoldOptions (solution, packName, version, tables+mappings, vendorSamples, sourceConfig, fieldMappingOverrides). Out: pack directory + .crbl path.
- Depends on: fs (pack dir under %APPDATA%/packs), field-matcher, sample-parser, vendor-research, kql-parser, sentinel-repo, azure-deploy destinations, reduction-rules, source-types.
- Portability: All generation logic is portable; replace the filesystem pack directory with an in-memory file map, then either push files via Cribl packs/pipelines REST API or package to .crbl for download. Reports become UI panels or downloadable text.

### ENG-07. CSV lookup file generation (field-mapping lookups)

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/pack-builder.ts` | Maturity: production | Category: enrichment | Verdict: **direct**
- During scaffold, writes data/lookups/{logType}_field_mapping.csv per log type (source_field,source_type,dest_field,dest_type,confidence,action,needs_coercion,description rows from the field matcher or user overrides, with proper CSV quoting) and registers them in default/lookups.yml.
- In/Out: In: match results or user mapping overrides per table. Out: CSV lookup files + lookups.yml registry inside the pack.
- Depends on: field-matcher, sample-parser; fs write only.
- Portability: CSV/YAML string generation is directly portable; write into the in-memory pack tree or push via Cribl lookups API.

### ENG-08. .crbl packaging (tar.gz builder)

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/pack-builder.ts` | Maturity: production | Category: pack-management | Verdict: **needs-redesign**
- packagePack() creates a Cribl-compatible .crbl: collects files, orders dirs-first/package.json-last, excludes report files and inputs.yml, then uses Windows system tar.exe (execFileSync) with a pure-Node fallback (hand-built POSIX ustar headers with checksums + zlib gzip level 9).
- In/Out: In: pack directory. Out: {name}_{version}.crbl gzipped tarball.
- Depends on: fs, child_process (tar.exe), zlib; Node Buffer.
- Portability: Drop the tar.exe path; the pure-JS ustar builder (tarHeader/buildNodeTar, ~70 lines) ports nearly verbatim to Uint8Array + CompressionStream('gzip') in the browser, producing a downloadable Blob or a binary body for the Cribl packs upload API.

### ENG-09. Pack storage lifecycle management

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/pack-builder.ts` | Maturity: production | Category: pack-management | Verdict: **needs-redesign**
- pack:list (reads package.json metadata, groups versioned .crbl files newest-first), pack:delete, pack:delete-crbl, pack:clean (removes orphaned and old-version .crbl files, reports freed bytes), pack:storage-info (sizes, orphan/old-version counts). Path traversal guarded.
- In/Out: In: pack/crbl names. Out: pack inventories, deletion results, storage stats.
- Depends on: fs over %APPDATA%/packs.
- Portability: Local pack cache becomes KV-stored build artifacts/metadata; listing installed packs is better served by the Cribl packs API (partially platform-provided). Storage-size accounting mostly loses meaning in KV.

### ENG-10. Air-gapped deployment artifact export

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/pack-builder.ts` | Maturity: production | Category: pack-management | Verdict: **needs-redesign**
- pack:export-artifacts assembles ~/Downloads/{packName}-artifacts/: the .crbl, per-table ARM templates (generated-templates or DCR-Templates NoDCE/DCE), custom table schema JSON, matching Cribl destination configs, and a generated README-deployment.md with step-by-step manual instructions.
- In/Out: In: packDir, crblPath, tables, solutionName. Out: export directory + artifact list.
- Depends on: fs, Downloads folder, linked-repo template paths.
- Portability: Port as an in-browser ZIP (or multi-file) download: templates come from bundled assets/KV, destination configs from KV, README generated in memory. High-value feature for the air-gapped persona.

### ENG-11. Analytics rule coverage analysis

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/pack-builder.ts` | Maturity: production | Category: reporting | Verdict: **needs-proxy**
- pack:rule-coverage loads a solution's analytics rules from the Sentinel repo mirror (sentinel-repo.listAnalyticRules + extractKqlFields KQL field extraction, filtered against the union of destination table schemas), merges user-uploaded custom rule YAML (pack:parse-rule-yaml extracts name/severity/query fields/entity columnNames), and computes per-rule field coverage (covered/missing, coverage ratio), fully/partially covered counts, and missing fields ranked by frequency.
- In/Out: In: solutionName, source/dest field names, optional custom rule YAML, dest tables. Out: per-rule coverage + summary.
- Depends on: Sentinel repo mirror (local files), regex-based KQL parsing (pure TS).
- Portability: KQL extraction and coverage math port directly; rule YAML must be fetched from github.com/Azure/Azure-Sentinel via proxies.yml (or a prebuilt rules index) instead of the local mirror.

### ENG-12. DCR gap analysis and KQL transform parsing

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/kql-parser.ts` | Maturity: production | Category: dcr-deployment | Verdict: **needs-proxy**
- parseDcrJson()/parseTransformKql() parse Sentinel solution DCR JSON: dataFlows, transformKql renames (project-rename/extend), type conversions, event_simpleName groupings; generateRouteCondition() builds route filters from event name lists; getTableRoutingForSolution() resolves per-table route conditions; analyzeDcrGap() splits transformation work into passthrough / DCR-handled / Cribl-must-handle (renames, coercions, overflow, enrichments). Surfaced through pack:analyze-samples (per-sample source-vs-DCR analysis with field mappings) and written as DCR_GAP_ANALYSIS reports during scaffold.
- In/Out: In: DCR template JSON content, source fields, dest schema. Out: routing conditions, gap analysis structures, analyze-samples summaries.
- Depends on: Pure TS parsing; DCR JSON sourced from Sentinel repo mirror.
- Portability: Parsers are directly portable; the DCR JSON inputs must be fetched from GitHub via proxy instead of local mirror.

### ENG-13. Cribl source type catalog and inputs.yml generation

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/source-types.ts` | Maturity: production | Category: pipeline-generation | Verdict: **direct**
- SOURCE_TYPES registry of 9 Cribl source definitions (syslog, rest_collector, http, azure_event_hub, azure_blob, kafka, office365, s3, windows_event) with field schemas, static config, discovery config, and ~25 vendor presets (cloudflare, crowdstrike, okta, qualys, microsoft_graph, paloalto, fortinet, cisco_asa, azure_activity/ad/diagnostics/nsg, aws_cloudtrail/vpc_flow/guardduty, splunk_hec, etc.). VENDOR_SOURCE_HINTS + suggestSourceType() map solution names to source type/preset. generateInputsYml() merges static config, preset defaults, field defaults, and user values into inputs.yml YAML.
- In/Out: In: source type id + preset + user field values. Out: source catalog for UI, inputs.yml YAML.
- Depends on: Pure TS data.
- Portability: Directly portable; generated input configs can be created live via the Cribl inputs API instead of only YAML text.

### ENG-14. Multi-format sample parser and field discovery

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/sample-parser.ts` | Maturity: production | Category: pipeline-generation | Verdict: **direct**
- detectFormat() + parsers for JSON array, NDJSON, CSV (header detection; headerless PAN-OS TRAFFIC/THREAT positional column dictionaries), key=value with quoted values, CEF (header + extension kv, syslog header preserved), LEEF, RFC3164/RFC5424 syslog (priority->facility/severity); unknown format falls through all parsers. collectFields() infers types (int/real/boolean/datetime/dynamic/string) with occurrence counts, sample values, required flags; guessTimestampField() candidate list. Keeps first 200 raw events for pack samples. Electron file-open dialog variant and Express multer upload variant exist. Has unit tests.
- In/Out: In: pasted text or uploaded files. Out: ParsedSample {format, fields with types/samples, rawEvents, timestampField, errors}.
- Depends on: Pure TS; Electron dialog only for the file-picker path.
- Portability: Parsing is directly portable. The dialog/multer entry points are replaced by a standard browser file input (trivial).

### ENG-15. Cribl capture auto-detection (inner _raw format)

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/sample-parser.ts` | Maturity: production | Category: pipeline-generation | Verdict: **direct**
- When parsed events are NDJSON/JSON with a _raw field (the standard Cribl capture envelope), detectInnerRawFormat() inspects _raw values (CEF:, LEEF:, JSON, 5+ comma CSV after syslog-prefix strip, 3+ kv pairs, syslog priority/timestamp) and re-parses the inner vendor format so field discovery reflects real vendor fields instead of the Cribl wrapper.
- In/Out: In: Cribl capture JSON/NDJSON. Out: re-parsed sample using inner vendor format and fields.
- Depends on: Pure TS.
- Portability: Directly portable; pairs naturally with the platform's capture API as the sample source.

### ENG-16. Headerless CSV parsing with external headers

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/sample-parser.ts` | Maturity: production | Category: pipeline-generation | Verdict: **direct**
- parseCsvWithHeaders() names headerless CSV columns from user-supplied headers (from a header file or feed config), skips future_use columns, captures overflow columns as _extra_N, and strips RFC3164/RFC5424/PAN-OS syslog prefixes first (stripSyslogPrefix). Targets Zscaler NSS and PAN-OS style feeds.
- In/Out: In: CSV content + header list + skipFirstRow. Out: ParsedSample with named fields.
- Depends on: Pure TS.
- Portability: Directly portable.

### ENG-17. Vendor feed configuration parser

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/sample-parser.ts` | Maturity: production | Category: discovery | Verdict: **direct**
- parseVendorFeedConfig() recognizes vendor log-forwarding configs and extracts expected format/fields/transport/port: Zscaler NSS (three format-string patterns incl. %s{field}), Palo Alto syslog-server-profile (BSD/IETF, log types), FortiGate 'config log syslogd', Cloudflare Logpush job JSON (logpull_options fields), CrowdStrike SIEM connector/event streams, generic rsyslog/syslog-ng.
- In/Out: In: pasted feed config text. Out: VendorFeedConfig {vendor, feedType, format, fields, transport, port}.
- Depends on: Pure TS regex parsing.
- Portability: Directly portable.

### ENG-18. Sample tagging and log-type auto-detection

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/sample-parser.ts` | Maturity: production | Category: pipeline-generation | Verdict: **direct**
- samples:tag-sample associates parsed sample content with vendor+logType (in-memory map, re-parses content to JSON events); samples:get-tagged / list-tagged-vendors retrieve them for pack building. samples:auto-detect-types splits pasted data into log types using discriminator fields (event_simpleName, type, subtype, eventType, category, DeviceEventClassID, dataset, etc.).
- In/Out: In: vendor, logType, raw content. Out: tagged sample store; detected log types with counts and discriminator.
- Depends on: Pure TS; in-memory Map (session state).
- Portability: Directly portable; persist tagged samples in the app-scoped KV store instead of process memory (note: tagSample re-parses everything to JSON, so downstream format detection reads rawEvents content, not declared format).

### ENG-19. Tiered sample resolver

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/sample-resolver.ts` | Maturity: production | Category: discovery | Verdict: **needs-proxy**
- Resolves raw vendor samples for pack building through tiers: Tier 0 Sentinel repo Sample Data, Tier 1 Elastic integrations test pipeline files (SOLUTION_SAMPLE_MAP ~22 curated vendors + fuzzyMatchElasticPackage against the live package list, data-stream discovery), Tier 2 criblpacks GitHub sample files, Tier 3 synthesis from vendor registry/analytics rules, Tier 4 user uploads (highest priority). Includes log-type splitting by discriminator fields, PAN-OS syslog+CSV->JSON conversion with named fields, Elastic event unwrapping (extracts inner event from agent envelopes), named-field validation (rejects _0,_1 positional data), format detection, disk caching, and browse-then-load-selected UX (samples:list-available / samples:load-selected).
- In/Out: In: solution name (+ optional user files or selected sample IDs). Out: ResolvedSample[] {tableName, format, rawEvents, source, tier, logType}.
- Depends on: GitHub API + raw.githubusercontent.com (Elastic integrations, criblpacks), GitHub PAT, fs caches under app data, default-samples, sentinel-repo.
- Portability: Resolution/splitting/conversion logic is pure TS. GitHub calls go through proxies.yml (api.github.com, raw.githubusercontent.com); disk caches become KV entries. Watch the 100 req/min platform rate limit when prefetching many streams.

### ENG-20. Elastic samples prefetch and status tracking

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/sample-resolver.ts` | Maturity: production | Category: discovery | Verdict: **needs-proxy**
- prefetchElasticSamples() downloads test pipeline files for all mapped vendors via GitHub raw URLs (no git clone, ~5MB total), requires a GitHub PAT (50+ API calls exceed anonymous limits), reports per-stream progress to the UI, persists status (ready/cloning/error, file counts, lastUpdated) and auto-refreshes when >12h stale at startup. elastic-repo:* IPC for status/clone/reset.
- In/Out: In: trigger (startup or manual). Out: cached sample files + status broadcasts with progress pct.
- Depends on: GitHub API + PAT, fs cache, BrowserWindow broadcast.
- Portability: Port as lazy on-demand fetch per selected solution rather than bulk prefetch (rate limits); status/progress becomes app state; cache in KV.

### ENG-21. Sentinel Content Hub repo mirror (GitHub API fetcher)

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/sentinel-repo.ts` | Maturity: production | Category: discovery | Verdict: **needs-redesign**
- Maintains a local mirror of Azure/Azure-Sentinel Solutions/ + Sample Data/ WITHOUT git: tree listing via GitHub API, parallel raw-file fetch with progress events, strict filtering (INCLUDED_EXTENSIONS yaml/json/csv/txt/md/kql; BLOCKED_EXTENSIONS scripts/binaries/archives never fetched; SKIP_DIRS), incremental update by commit SHA, status persistence and broadcasts. Exposes listSolutions (with deprecation detection), listSolutionFiles, listConnectorFiles, readRepoFile, getFileHash, listAnalyticRules, extractKqlFields; auto-updates when >12h stale; sync/reclone/reset IPC.
- In/Out: In: GitHub repo. Out: local file mirror + solution/connector/rule accessors used by nearly every other module.
- Depends on: GitHub API (+optional PAT), fs mirror under %APPDATA%/sentinel-repo.
- Portability: A full multi-thousand-file mirror does not fit browser/KV storage or the 100 req/min proxy limit. Redesign to on-demand per-solution fetch (tree query + targeted raw fetches) with KV caching of visited solutions, or a server-side prebuilt index shipped as app data. The accessor API surface can be preserved.

### ENG-22. EDR blocklist with crash detection

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/sentinel-repo.ts` | Maturity: production | Category: infra-tooling | Verdict: **platform-provided**
- Two-layer blocklist preventing EDR (CrowdStrike etc.) from killing the app while fetching Sentinel content: built-in edr-blocklist.json (BloodHound Enterprise, FalconFriday, Attacker Tools, MITRE ATT&CK) plus a per-user local list auto-populated by crash detection - a fetching.json marker names the in-progress solution, and on startup a marker younger than 60s means the process was killed mid-fetch, so that solution is auto-blocklisted. UI can list/retry/add blocklist entries; blocked solutions and executable extensions are skipped during fetch.
- In/Out: In: fetch lifecycle events, user add/retry. Out: merged blocklist, skipped solutions during sync.
- Depends on: fs marker/blocklist files, bundled edr-blocklist.json (also at src/main/ipc/edr-blocklist.json).
- Portability: The threat model disappears in a sandboxed browser app: no files are written to the host disk, so EDR cannot flag or kill anything. Drop the crash-detection machinery; optionally keep the built-in list only as a content filter if raw IOC-laden rule files are ever persisted to KV.

### ENG-23. GitHub Sentinel solution browsing and schema/sample mining

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/github.ts` | Maturity: production | Category: discovery | Verdict: **needs-proxy**
- Direct GitHub API access (independent of the mirror): list Sentinel solutions, fetch solution details, extract destination table schemas from Data Connector JSON (extractSchemasFromConnector with DCR type normalization), and mine vendor samples from SampleData directories, sampleQueries KQL hints (extractTableFromKql), and instructionSteps code/JSON blocks. Tracks and reports API rate limits; uses saved PAT when present.
- In/Out: In: solution path. Out: solution lists, table schemas, vendor sample events tagged by source, rate-limit info.
- Depends on: api.github.com + raw.githubusercontent.com via HTTPS, GitHub PAT from auth module.
- Portability: Straight fetch() port through proxies.yml with PAT injected from the KV secret store; extraction logic is pure TS.

### ENG-24. Vendor research engine

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/vendor-research.ts` | Maturity: production | Category: discovery | Verdict: **needs-proxy**
- performVendorResearch() returns vendor log-type schemas driving auto field mapping. Static VENDOR_REGISTRY for 6 vendors (Cloudflare, CrowdStrike Falcon, Palo Alto, Okta, Fortinet, Microsoft Graph Security) with remote schema parsers (OpenAPI spec, Sentinel connector JSON, JSON Schema) + static fallbacks, per-log-type sourceFormat/timestampField/fieldMappings/destTable; 24h disk cache; falls back to the dynamic registry (registry-sync) resolving any solution from the Sentinel repo. vendor:list/research/clear-cache IPC.
- In/Out: In: vendor/solution name. Out: VendorResearchResult {logTypes with fields, mappings, formats, sourceType/preset, docs URL, cache flag}.
- Depends on: HTTPS fetch to vendor doc/spec URLs, fs cache, registry-sync, sentinel-repo.
- Portability: Registry data and parsers port directly; remote schema fetches need each vendor doc domain declared in proxies.yml (or pre-bundle the static schemas); cache moves to KV.

### ENG-25. Dynamic vendor registry sync and search

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/registry-sync.ts` | Maturity: production | Category: discovery | Verdict: **needs-redesign**
- performFullSync() scans every solution in the local Sentinel repo mirror, extracts log types/fields from data connector JSON (extractLogTypesFromConnector with type normalization), and builds a persistent searchable index (vendor, displayName, solutionPath, logTypes, dataConnectorFiles). registry:search/lookup/stats/sync IPC with progress broadcasts; runs automatically at startup after repo update.
- In/Out: In: local Sentinel repo mirror. Out: registry index JSON (searchable vendor->log types) + sync progress events.
- Depends on: sentinel-repo mirror on disk, fs index cache.
- Portability: Depends on the full local mirror. Redesign to either query per-solution on demand via proxied GitHub, or ship a prebuilt registry index as an app asset refreshed out-of-band; store in KV.

### ENG-26. Upstream change detection for built packs

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/change-detection.ts` | Maturity: dev | Category: pack-management | Verdict: **needs-proxy**
- captureSnapshot() records at pack-build time the solution's connector file SHAs and schema fingerprints (hashed field lists) plus build commit; runChangeDetection() periodically compares against current GitHub state producing categorized alerts (severity critical/warning/info: schema field changes, connector file adds/removes/modifications); getPackDiff() gives full diff with GitHub commit log, per-file diffs since build commit, and a rebuild recommendation; alerts persist with dismiss support and status broadcasts.
- In/Out: In: build snapshots + GitHub current state. Out: ChangeAlert[] with per-change severity, pack diff reports, status broadcasts.
- Depends on: GitHub API (commits, contents, compare) + PAT, fs snapshot/alert storage under app data.
- Portability: Diff/fingerprint logic ports directly; GitHub calls via proxy; snapshots/alerts persist in KV; scheduled checks become on-app-load or user-triggered checks.

### ENG-27. Cribl authentication and credential storage

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/auth.ts` | Maturity: production | Category: identity-auth | Verdict: **platform-provided**
- getCriblToken(): Cribl Cloud OAuth client-credentials against login.cribl.cloud (audience api.cribl.cloud) or self-managed /api/v1/auth/login username/password; in-memory token cache with 60s expiry buffer; testCriblConnection() health probing. Credentials stored per deployment type encrypted with Electron safeStorage (Windows DPAPI/macOS Keychain) with plaintext fallback in web mode, dual cloud/self-managed profiles, legacy migration, reconnect-with-overrides without re-entering the secret; connect/disconnect/saved/reconnect IPC.
- In/Out: In: clientId/secret, baseUrl, deploymentType, orgId. Out: bearer tokens, connection status, saved profiles (secret-redacted).
- Depends on: Electron net.fetch/safeStorage, https fallback, fs credential files.
- Portability: Inside the Cribl leader UI, product-API auth comes free via the platform's authenticated fetch - drop token plumbing for the local deployment. Only keep a variant (via proxy to login.cribl.cloud + KV secrets) if cross-deployment targeting (managing a different Cribl org) remains a requirement.

### ENG-28. Cribl configuration API client

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/auth.ts` | Maturity: production | Category: pack-management | Verdict: **direct**
- Full worker-group-scoped REST client (/api/v1/m/{group}/...): create Sentinel destinations (system/outputs), two-step pack upload+install (PUT packs?filename= then POST packs, with automatic delete-and-retry on duplicate pack ID conflict), list destinations/worker groups (fleet filtering)/packs/sources/routes, multi-group pack deploy, create/update event breaker rulesets (lib/breakers), create/update secrets (system/secrets), create routes prepended to the route table (multi-endpoint/multi-shape fallback handling for version differences), version commit and worker-group config deploy (Cloud auto-commit awareness), and a debug endpoint tester.
- In/Out: In: destination/route/breaker/secret configs, .crbl binary, worker group ids. Out: created/updated Cribl config objects, deploy results.
- Depends on: Cribl REST API via HTTPS + bearer token; fs read of the .crbl for upload.
- Portability: Maps 1:1 to platform capability (1): authenticated fetch to product REST paths declared in policies.yml. Pack binary comes from the in-browser tar builder instead of fs. The multi-endpoint fallback guessing should be replaced by the leader's actual API version.

### ENG-29. Cribl live data operations (capture, preview, search, Lake)

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/auth.ts` | Maturity: dev | Category: pipeline-generation | Verdict: **direct**
- criblCaptureSample(): 3-strategy sample acquisition (system/samples library with fuzzy source-name matching + content fetch; ad-hoc collection job via lib/jobs; /preview capture mode). criblPreviewPipeline(): run sample events through a pipeline config server-side. criblSearch(): create search job, poll to completion (60s cap), fetch results. criblListDatasets()/criblCreateDataset(): Cribl Lake dataset ops with multi-path endpoint fallbacks. Used for end-to-end data flow validation.
- In/Out: In: workerGroup, sourceId/pipeline conf/query. Out: captured/previewed/search result events.
- Depends on: Cribl REST API (samples, jobs, preview, search) + bearer token.
- Portability: Product-API calls port to platform fetch; the platform explicitly exposes samples/captures/search. Search polling fits the poll-long-operations model (each poll under the 30s request timeout). Endpoint-guessing fallbacks (datasets) should be pinned to the leader's real API.

### ENG-30. GitHub PAT management

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/auth.ts` | Maturity: production | Category: identity-auth | Verdict: **needs-redesign**
- Save/validate/clear a GitHub personal access token: validated against api.github.com/user (returns login), encrypted at rest with safeStorage, consumed by sentinel-repo, sample-resolver, change-detection, and github.ts for higher rate limits.
- In/Out: In: PAT string. Out: validation result + encrypted storage; auth headers for GitHub calls.
- Depends on: safeStorage/fs, api.github.com.
- Portability: Store in the app-scoped encrypted KV; inject as Authorization header via proxies.yml header injection for api.github.com/raw.githubusercontent.com; validation call goes through the proxy.

### ENG-31. Azure session and resource management (PowerShell-driven)

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/auth.ts` | Maturity: production | Category: identity-auth | Verdict: **needs-redesign**
- Azure operations shell out to powershell.exe with Az modules: checkAzureSession (Get-AzContext parse), interactive azureLogin (spawns visible PS window running Connect-AzAccount browser flow), set subscription context, list subscriptions/Log Analytics workspaces/resource groups, create resource group, create workspace (PerGB2018, 90d retention), enable Microsoft Sentinel via inline ARM template deployment (SecurityInsights solution), and select-workspace persisting to azure-parameters.json. GUID validation and quote-escaping guard against PS injection.
- In/Out: In: subscription/workspace/RG names. Out: session status, resource lists, created resources, updated azure-parameters config.
- Depends on: powershell.exe + Az.Accounts/Az.Resources/Az.OperationalInsights, child_process, interactive browser login.
- Portability: Rebuild on Azure ARM REST via proxy (management.azure.com + login.microsoftonline.com token endpoint in proxies.yml): every listed operation has a direct ARM REST equivalent. Interactive Connect-AzAccount must become service-principal client-credentials (or device-code) with secrets in KV. This is the largest porting effort in the subsystem.

### ENG-32. Azure Log Analytics KQL query

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/auth.ts` | Maturity: production | Category: reporting | Verdict: **needs-proxy**
- auth:azure-query runs a KQL query against the first Log Analytics workspace: PowerShell obtains a token (Get-AzAccessToken for api.loganalytics.io) and POSTs to /v1/workspaces/{id}/query, converting columnar results to row objects. Used as the destination-validation stage of end-to-end data flow checks.
- In/Out: In: KQL query + timespan. Out: result rows as objects.
- Depends on: powershell.exe wrapper around the Log Analytics REST API.
- Portability: The inner call is already REST - port as direct fetch to api.loganalytics.io via proxy with an AAD token from the proxied token endpoint; drop the PowerShell wrapper. Workspace selection should come from config instead of 'first workspace'.

### ENG-33. DCR deployment orchestration

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/azure-deploy.ts` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- azure:deploy-dcrs runs the repo's DCR Automation PowerShell (Run-DCRAutomation.ps1/Create-TableDCRs.ps1) in an isolated temp dir: copies read-only scripts/templates, writes NativeTableList.json/CustomTableList.json, passes Azure params as CLI overrides, spawns pwsh with live stdout/stderr streaming to the UI, harvests generated cribl-dcr-configs destination files into app data, and cleans up. Supports all six modes (DirectNative/Custom/Both, DCE*) plus templateOnly.
- In/Out: In: table list + mode + azure-parameters. Out: deployed DCRs/custom tables in Azure + Cribl destination config JSONs + streamed logs.
- Depends on: pwsh (PowerShell 7+), linked Cribl-Microsoft repo scripts, temp dirs, Az session.
- Portability: Replace the ~4600-line PS engine with browser-side ARM template generation (templates are already data in DCR-Templates/) and ARM REST deployments via proxy (tables PUT, DCR PUT, deployments API), with polled deployment status. Highest-effort, highest-value port; the temp-dir/git-cleanliness machinery disappears entirely.

### ENG-34. Custom table schema auto-generation from Sentinel repo

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/azure-deploy.ts` | Maturity: production | Category: dcr-deployment | Verdict: **needs-proxy**
- generateCustomTableSchemas() finds _CL table definitions in Sentinel solution connector files, converts columns to Log Analytics types (mapColumnType), and writes schema JSON (retention defaults 30/90 days) in the format the PS script expects, so custom tables can be created without hand-written schemas.
- In/Out: In: _CL table names. Out: custom-table-schemas/*.json schema files.
- Depends on: sentinel-repo mirror, fs.
- Portability: Conversion logic ports directly; source the table definitions via proxied GitHub fetch and feed the schema straight into the ARM tables API instead of writing files.

### ENG-35. Cribl destination config management and outputs.yml generation

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/azure-deploy.ts` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- readGeneratedDestinations()/findDestinationForTable() read deployed Sentinel destination JSONs (dcrID, dceEndpoint, streamName, client_id, loginUrl, url); generateOutputsYmlFromDestinations() renders complete Cribl sentinel-type outputs.yml with real values and !{sentinel_client_secret} placeholder; azure:refresh-destinations re-derives destination configs by querying Azure for DCR immutableId + logsIngestion endpoint (Invoke-AzRestMethod, handler.control->ingest rewrite); azure:embed-destinations rewrites a built pack's outputs.yml with matched deployed destinations.
- In/Out: In: deployed DCR state / table names. Out: destination JSON configs, outputs.yml content, updated packs.
- Depends on: fs config store, powershell.exe for the Azure queries.
- Portability: YAML/JSON generation is directly portable. DCR detail resolution becomes an ARM REST GET via proxy; destination configs persist in KV; embedding writes into the in-memory pack or directly creates destinations via the Cribl outputs API.

### ENG-36. Existing-resource check and deployment preview

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/azure-deploy.ts` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- azure:check-existing lists DCRs live in the selected resource group (Get-AzResource) and resolves each match's immutableId/ingestion endpoint via ARM REST, returning per-table destination info or null; azure:preview-resources composes the resource plan (DCR name from prefix/suffix rules, custom table resource, ARM template JSON loaded from templates) before deployment.
- In/Out: In: table list + subscription/RG/workspace/location. Out: per-table existing-DCR results; preview resource list with ARM templates.
- Depends on: powershell.exe + Az, template files on disk.
- Portability: Both are single ARM REST list/get calls plus template lookup - port to proxied fetch + bundled template assets.

### ENG-37. DCR role assignment (Monitoring Metrics Publisher)

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/azure-deploy.ts` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- azure:assign-dcr-role grants role definition 3913510d-42f4-4e42-8a64-420c390055eb to a service principal scoped to each DCR resource (idempotent - detects existing assignment); azure:get-dcr-ids maps deployed tables to DCR resource IDs for scoping.
- In/Out: In: SP objectId + DCR resource IDs / table names. Out: per-DCR assignment results.
- Depends on: powershell.exe (New-AzRoleAssignment, Get-AzDataCollectionRule).
- Portability: Direct ARM REST equivalent (PUT roleAssignments with GUID name) via proxy; requires the caller's token to have Microsoft.Authorization/roleAssignments/write.

### ENG-38. Permission preflight checks

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/permission-check.ts` | Maturity: production | Category: identity-auth | Verdict: **needs-redesign**
- permissions:check produces a combined deployability report: Cribl side probes auth/info for role and maps to capabilities (canManagePacks/Outputs/Inputs/Routes/CaptureSamples/Search) with per-resource permission items; Azure side checks RBAC for DCR/DCE/table creation, resource group write, workspace read; returns canDeploy + human summary so users see exactly what will fail before deploying.
- In/Out: In: workerGroup (optional). Out: PermissionReport {cribl caps, azure caps, canDeploy, summary}.
- Depends on: Cribl REST API, powershell.exe for Azure RBAC checks.
- Portability: Cribl half ports to platform fetch directly; Azure half becomes ARM permissions API calls (GET .../providers/Microsoft.Authorization/permissions) via proxy.

### ENG-39. End-to-end onboarding orchestrator

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/e2e-orchestrator.ts` | Maturity: dev | Category: pack-management | Verdict: **needs-redesign**
- Coordinates the full multi-source onboarding flow with idempotent steps and live progress broadcasts: validate Cribl+Azure auth, then per source - vendor research, custom table creation, DCR deployment (spawns the PS automation), pack build, Cribl destination creation via API, .crbl upload. e2e:status/start/available-sources/reset IPC with e2e:progress push events.
- In/Out: In: selected sources (vendor, tables, sourceType) + Cribl auth + worker group. Out: per-source step progress (pending/running/done/skipped/error) and built artifacts.
- Depends on: vendor-research, azure-deploy (PowerShell), pack-builder, auth Cribl client, child_process.
- Portability: The state machine and idempotency logic port directly; each step swaps to its ported implementation (ARM REST, in-browser pack build, platform fetch). Progress becomes reactive app state; long steps are polled.

### ENG-40. SIEM migration analyzer (Splunk/QRadar)

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/siem-migration.ts` | Maturity: dev | Category: reporting | Verdict: **direct**
- Parses Splunk savedsearches JSON exports (macro resolution, filter-macro detection) and QRadar rule CSV exports into normalized rules; identifies data sources from queries, fuzzy-maps them to Sentinel solutions, enriches with each solution's analytics rules, builds MITRE ATT&CK tactic/technique coverage, produces a MigrationPlan, exports a styled HTML migration report, and can directly build Cribl packs for mapped solutions (siem:build-pack) using the tiered sample resolver.
- In/Out: In: Splunk/QRadar export content. Out: MigrationPlan (data sources, solution mappings, rule enrichment, MITRE coverage), HTML report file, built packs.
- Depends on: Pure TS parsing/analysis; sentinel-repo for solution mapping; pack-builder + sample-resolver for build; fs for report write.
- Portability: Parsing/analysis/report generation are pure TS; report export becomes a browser download; solution mapping needs the ported registry; pack build uses the ported builder.

### ENG-41. Synthetic sample data generation

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/default-samples.ts` | Maturity: production | Category: pipeline-generation | Verdict: **direct**
- Heuristic realistic event generator: field-name/type-driven values (IPs by src/dst/public heuristics, ports, MACs, hostnames, users, URLs, file paths, processes, protocols, actions, severities, GUIDs, hashes, vendors) used by samples:generate-defaults per vendor-registry log type and by pack-builder's generateSampleFile fallback when no real samples exist; also sample-resolver synthesizeSamples() serializes synthetic fields into vendor formats (json/kv/cef).
- In/Out: In: vendor name or field schema + count. Out: synthetic events (objects + raw strings) per log type.
- Depends on: Pure TS + crypto.randomBytes (swap to Web Crypto).
- Portability: Directly portable (crypto.randomBytes -> crypto.getRandomValues).

### ENG-42. Sentinel repo sample discovery

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/default-samples.ts` | Maturity: production | Category: discovery | Verdict: **needs-redesign**
- findSentinelRepoSamples() locates vendor sample data for a solution: searches per-solution 'Sample Data' dirs and repo-root Sample Data, keyword matching with a large vendor-abbreviation dictionary (paloalto/panos/cdlevent, fortigate, checkpoint, etc.), constrains to the solution's declared CustomTables, parses files with the sample parser, splits by discriminator log types, and flags pre-ingested (already Sentinel-schema) data.
- In/Out: In: solution name. Out: parsed samples per log type with fields/format/preIngested flag, filesSearched count.
- Depends on: Local Sentinel repo mirror, sample-parser.
- Portability: Matching/parsing logic ports directly; sample files must be fetched on demand from GitHub via proxy (directory listing + raw fetch) instead of scanning a local mirror.

### ENG-43. Configuration parameter forms

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/param-forms.ts` | Maturity: production | Category: infra-tooling | Verdict: **direct**
- Schema-driven form definitions for azure-parameters.json (subscription/RG/workspace/region picklist/tenant/client/DCR-DCE naming/owner tag), operation-parameters.json (createDCE, skip-existing, templateOnly, custom table retention, Private Link, etc.), and cribl-parameters; params:list/get/save read and write dot-notation values into the app-data config files so users never hand-edit JSON.
- In/Out: In: form id + values. Out: form field metadata + persisted config JSON.
- Depends on: fs config files in app data.
- Portability: Form definitions are pure data (fully portable); persistence moves to the KV store.

### ENG-44. App data paths, repo linking, and template bundling

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/app-paths.ts` | Maturity: production | Category: infra-tooling | Verdict: **platform-provided**
- Centralized %APPDATA%/.cribl-microsoft layout (config/packs/dcr-templates/sentinel-repo/vendor-cache/registry-cache/change-detection/auth), optional Cribl-Microsoft repo link (saved or auto-detected by walking up from the executable) exposing the DCR PowerShell scripts, bundleDcrTemplates() copying DCR template schemas + custom table schemas into app data on first link, and one-time config migration from repo to app data. app:paths/link-repo/unlink-repo IPC.
- In/Out: In: optional repo path. Out: resolved paths, bundled template count, linked-repo state.
- Depends on: fs, Electron app.isPackaged.
- Portability: Replaced wholesale by the KV store and app-bundled assets; repo linking is meaningless in the browser (DCR templates ship as app data; the PS scripts are replaced by ARM REST).

### ENG-45. Host dependency checker and installer

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/deps.ts` | Maturity: production | Category: infra-tooling | Verdict: **not-portable**
- deps:check probes local prerequisites (Node version, PowerShell 5.1/7+, Az module presence+version, Azure login state, linked repo) with per-mode required flags (air-gapped/cribl-only skip Azure deps); deps:install runs an install command via PowerShell with streamed output.
- In/Out: In: none / install command. Out: DepStatus[] with install hints; install output stream.
- Depends on: child_process probing of local executables.
- Portability: Fundamentally host-machine inspection; unnecessary in a browser app (there are no local prerequisites). Drop; replace with a connectivity/permissions preflight.

### ENG-46. Generic PowerShell script runner

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/powershell.ts` | Maturity: production | Category: infra-tooling | Verdict: **not-portable**
- ps:execute spawns any repo-relative PowerShell script with args, streaming stdout/stderr to the renderer via ps:output/ps:exit events with cancel support (ps:cancel) and process-table cleanup; used by the UI to run the repo's discovery/lab scripts directly.
- In/Out: In: script path + args. Out: streamed output events, exit code, process id.
- Depends on: child_process spawn of powershell.exe against the linked repo.
- Portability: Launching local processes is impossible in the sandbox. Each PS-script consumer must be individually re-implemented as REST calls (covered by the Azure feature redesigns); no generic equivalent should be ported.

### ENG-47. Config file read/write IPC

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/config.ts` | Maturity: production | Category: infra-tooling | Verdict: **platform-provided**
- config:read/config:write JSON files under the app-data config dir with path-traversal guards; config:repo-root returns the app data root.
- In/Out: In: relative file path (+ data). Out: parsed/persisted JSON.
- Depends on: fs.
- Portability: KV store get/set replaces this entirely.

### ENG-48. File logger

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/logger.ts` | Maturity: production | Category: infra-tooling | Verdict: **platform-provided**
- Module-tagged warn/error logger persisting to app data for diagnostics; used pervasively across all backend modules.
- In/Out: In: module + message + error. Out: log file entries + console.
- Depends on: fs.
- Portability: Use console/browser devtools or a KV-backed ring buffer if in-app log viewing is desired.

### ENG-49. Web-mode Express server (IPC-as-REST bridge)

- Source: `Cribl-Microsoft_IntegrationSolution/src/server/index.ts` | Maturity: production | Category: infra-tooling | Verdict: **platform-provided**
- Alternative browser runtime: a fake IpcMain captures every registered handler and exposes it as POST /api/{channel} (api-router.ts); an EventBus + SSE /api/events replaces WebContents.send push; multer handles sample file uploads; /api/pack/download serves .crbl files; electron-stub.ts shims app/safeStorage/dialog/BrowserWindow so all main-process modules run under plain Node; serves the built React SPA.
- In/Out: In: HTTP requests mirroring IPC channels. Out: JSON responses, SSE events, file downloads.
- Depends on: express, cors, multer, Node module-resolution interception.
- Portability: The App Platform hosting model replaces this bridge entirely - handlers become in-browser functions called directly, push events become reactive state. Its main architectural lesson (handlers already run without Electron) proves the business logic is decoupled and portable.

### ENG-50. Dev diagnostic server

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/dev-server.ts` | Maturity: dev | Category: infra-tooling | Verdict: **out-of-scope**
- Dev-only localhost:9999 HTTP server: captures console logs into a ring buffer, exposes them for automated testing, and proxies authenticated GETs for probing Cribl API paths. Loaded dynamically only when app is not packaged.
- In/Out: In: local HTTP requests. Out: captured logs, proxied API responses.
- Depends on: Node http/https, Electron BrowserWindow.
- Portability: Development tooling only; not a product feature. Do not port.

### ENG-51. Electron shell and preload IPC bridge

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/main.ts` | Maturity: production | Category: infra-tooling | Verdict: **platform-provided**
- Electron bootstrap (1400x900 window, contextIsolation) and preload.ts contextBridge exposing the entire typed window.api surface (~120 channels across deps, powershell, config, github, sentinelRepo, packBuilder, vendorResearch, paramForms, azureDeploy, registrySync, changeDetection, auth, sampleParser, e2e, permissions, defaultSamples, fieldMatcher, siemMigration, sampleResolver, elasticRepo) with event subscription helpers.
- In/Out: In: renderer invocations. Out: typed IPC bridge; the preload types document the full backend API contract.
- Depends on: Electron.
- Portability: The iframe SPA runtime replaces the shell; preload.ts is nonetheless valuable as the authoritative typed API inventory when re-architecting modules into browser services.

### ENG-52. Startup background refresh orchestration

- Source: `Cribl-Microsoft_IntegrationSolution/src/main/ipc/index.ts` | Maturity: production | Category: infra-tooling | Verdict: **needs-redesign**
- Registers all IPC modules, then 3s after launch runs the background chain with startup-log broadcasts: Sentinel repo auto-update (>12h stale), Elastic samples prefetch (>12h stale), registry full sync, and change detection - keeping vendor/solution data fresh without user action.
- In/Out: In: app launch. Out: refreshed caches + startup:log events.
- Depends on: sentinel-repo, sample-resolver, registry-sync, change-detection.
- Portability: Bulk background refresh conflicts with the 100 req/min proxy limit; redesign as lazy, per-solution on-demand refresh with KV-cached staleness timestamps and an explicit refresh action.


## Integration Solution - GUI Workflows (GUI)

React/TypeScript renderer of the Electron "Cribl SOC Optimization Toolkit for Microsoft Sentinel" GUI (also runnable as a browser SPA against an Express backend via api-client.ts). Its centerpiece is the 7-step SentinelIntegration workflow (solution select -> sample load -> DCR gap analysis/field-mapping approval -> Azure targeting -> Cribl config -> one-click deploy -> source wiring -> live data-flow validation), surrounded by 11 more pages: setup wizard, repo/PAT setup, deps check, pack manager, legacy pack builder with change detection, SIEM migration analysis, data-flow dashboard, settings, plus thin PowerShell-wrapper pages for DCR automation, discovery, and labs. The renderer is almost pure UI + orchestration: every Cribl/Azure/GitHub/parse operation goes through window.api IPC into the Electron main process, so most features port as workflow logic whose backing calls must be re-pointed at the Cribl product API, proxied Azure ARM/Log Analytics/GitHub APIs, and an in-browser reimplementation of the main-process engines.

Reader-noted gaps: All business logic the renderer drives lives outside this subsystem in src/main/ipc (pack-builder, field-matcher, sample-parser, sample-resolver, azure-deploy, auth, vendor-research, sentinel-repo/elastic-repo fetchers, change-detection, siem-migration, permissions, deps) and src/server (Express web mode) -- those need their own catalog since every needs-redesign verdict here hinges on porting or replacing them. Several preload channels the renderer calls are typed as any and were not verified against the main process (sampleResolver.listAvailable/loadSelected, elasticRepo.*, sentinelRepo.blocklist/blocklistRetry/onFetchProgress, auth.azureCreateWorkspace/azureEnableSentinel, onStartupLog). The api-client exposes namespaces no page currently invokes (e2e.*, fieldMatcher.*, paramForms.*, registrySync beyond a sidebar dot, defaultSamples.availableVendors/generate, auth.criblSearch/criblCreateSecret/criblCreateDestination/criblDeployMulti, changeDetection.gitLog/fileDiffs/snapshots) -- either dormant capabilities or driven from main; they may hide additional features. SentinelIntegration.tsx lines ~1693-2235 (sample-section rendering detail) and ~2360-2580 (field-mapping editor rows) were only partially read; the mapping-edit UI mechanics (per-row action/dest edits feeding mappingEdits) are inferred from state usage. LabAutomation's PowerShell path has an acknowledged TODO (wizard values are never written to azure-parameters.json before launching the script). Renderer test coverage exists only for the three pure modules; no page-level tests. SECURITY_DISCLAIMER.md and knowledge.md at the solution root were not reviewed.

### GUI-01. Acceptable Use Agreement gate

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/App.tsx` | Maturity: production | Category: infra-tooling | Verdict: **direct**
- First-launch scroll-to-bottom legal agreement describing what the app can do per mode (Azure resource creation, Cribl config changes, GitHub reads, air-gapped option); acceptance persisted to accepted-terms.json and skipped on later launches.
- In/Out: In: user scroll + accept click. Out: accepted-terms.json config record with timestamp; unlocks the app.
- Depends on: window.api.config.read/write (JSON config store).
- Portability: Pure UI; persist acceptance in the app-scoped KV store instead of a config file. Text must be rewritten for the platform context (no PowerShell/local execution claims).

### GUI-02. Dependency preflight check and installer

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/DepsCheck.tsx` | Maturity: production | Category: infra-tooling | Verdict: **not-portable**
- Startup screen listing required/optional local dependencies (Node, PowerShell, Az modules, etc.) with Found/Missing status, per-dep install hint, one-click install execution with streamed output, re-check, and a skip path.
- In/Out: In: none (scans host). Out: DepStatus list (name, version, installed, installHint), install command output.
- Depends on: window.api.deps.check / deps.install (spawns local shell commands in main process).
- Portability: Fundamentally checks and installs host software via child processes. In a sandboxed Cribl app there are no local dependencies to check; drop it (an equivalent could verify proxy/KV-credential readiness instead).

### GUI-03. First-run setup wizard (Cribl connect, Azure detect, mode select)

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/SetupWizard.tsx` | Maturity: production | Category: identity-auth | Verdict: **needs-redesign**
- 3-step wizard: (1) Cribl connection for Cloud (org ID + OAuth client ID/secret, derived https://main-{org}.cribl.cloud URL) or self-managed leader (protocol/host/port + admin user/pass), with saved-profile reload per deployment type and one-click reconnect using the OS-keychain-stored secret; (2) Azure PowerShell session detection (Connect-AzAccount) or login showing account/subscription/tenant; (3) integration mode selection (Full / Azure Only / Cribl Only / Air-Gapped) auto-suggested from which connections succeeded, plus Sentinel/Elastic repo status and clone buttons. Steps are individually skippable.
- In/Out: In: Cribl credentials, org/leader address, mode choice. Out: validated Cribl session, detected Azure session, integration-mode.json, saved encrypted credential profiles.
- Depends on: window.api.auth.criblConnect/criblReconnect/criblSaved, auth.azureStatus/azureLogin, sentinelRepo.sync/status, elasticRepo.clone/status, config.write; DPAPI/keychain credential storage in main.
- Portability: Cribl auth becomes platform-provided (the app runs authenticated inside the leader UI) so step 1 largely disappears except for cross-org scenarios. Azure step must be redesigned from PowerShell-session detection to an OAuth flow against login.microsoftonline.com via proxies.yml with tokens/secrets in the encrypted KV store. Mode-selection logic (full/azure-only/cribl-only/air-gapped) ports directly and still makes sense (air-gapped = generate-and-download only).

### GUI-04. Content repositories setup (GitHub PAT, Sentinel/Elastic fetch, EDR blocklist)

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/RepoSetup.tsx` | Maturity: production | Category: infra-tooling | Verdict: **needs-redesign**
- Wizard step and standalone page that (1) saves/validates/clears a GitHub PAT (with in-app fine-grained-token creation walkthrough), (2) fetches the Azure-Sentinel repo content (~2500 files, solutions/rules/parsers/connectors) via the GitHub REST API with phase text and structured progress bars, (3) fetches Elastic Integrations test-pipeline sample data (~20+ vendors), and (4) manages an EDR blocklist of Sentinel solutions (built-in / auto-detected / user entries with reasons) with per-solution retry to unblock.
- In/Out: In: GitHub PAT, fetch/refresh/retry clicks. Out: local mirrored Sentinel solution content + Elastic samples, solution/package counts, blocklist state.
- Depends on: window.api.auth.githubSave/githubClear/githubSaved, sentinelRepo.sync/status/blocklist/blocklistRetry/onProgress/onFetchProgress, elasticRepo.clone/status; main-process fetch pipeline writing to %APPDATA% cache.
- Portability: GitHub API calls port via proxies.yml (api.github.com) with the PAT injected from KV. The local-disk repo mirror must become on-demand fetch plus KV/in-memory caching, and bulk prefetch of 2500 files will collide with the 100 req/min rate limit -- redesign toward lazy per-solution fetch. The EDR blocklist (protecting a local clone from AV kills) becomes mostly moot; keep as an optional skip-list.

### GUI-05. Sentinel solution browser/selector

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/SentinelIntegration.tsx` | Maturity: production | Category: pipeline-generation | Verdict: **needs-proxy**
- Section 1 of the integration workflow (and the standalone PackBuilder/SentinelBrowser.tsx card grid): searchable list of Microsoft Sentinel Content Hub solutions loaded from the fetched Azure-Sentinel repo (with GitHub-API fallback), repo state banner with retry-sync, deprecation flags, and selection that seeds the rest of the workflow; also accepts a pre-selected solution via URL hash from the SIEM Migration page.
- In/Out: In: search text, solution click (or ?solution= deep link). Out: selectedSolution driving vendor research, samples, pack name.
- Depends on: window.api.github.fetchSentinelSolutions, sentinelRepo.status/sync/onStatus/onProgress.
- Portability: Solution listing is a GitHub API directory read -- ports with api.github.com in proxies.yml. UI and search are direct.

### GUI-06. Sample data loading suite

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/SentinelIntegration.tsx` | Maturity: production | Category: pipeline-generation | Verdict: **needs-redesign**
- Section 2: load vendor sample events by (a) auto-load from the Sentinel repo with pre-ingested (post-ingestion schema) samples detected and skipped with explanatory warnings, (b) browse modal over the multi-tier sample resolver (sentinel-repo + elastic tiers, previews, multi-select, tier summary), (c) multi-file upload with log-type auto-detection from filename keywords or sourcetype field, (d) paste raw events with a manual log type. Samples are tagged per solution/log type, original formats (CEF/LEEF/KV) preserved across re-parse to NDJSON, log types renamable inline (drives pipeline/route naming), samples expandable to view fields.
- In/Out: In: solution name, files/pasted text/browse selections. Out: TaggedSample[] (vendor, logType, format, events, fields with types and sample values, timestamp field) feeding analysis and pack build.
- Depends on: window.api.defaultSamples.sentinelRepoSamples, sampleResolver.listAvailable/loadSelected, sampleParser.parseFiles/tagSample/getTagged; multi-format parser (CEF/CSV/JSON/KV/LEEF/syslog/Cribl captures) in main process.
- Portability: File selection/paste work natively in the browser (File API). The sample-parser and sample-resolver engines are main-process TS that must be ported to run client-side (pure text parsing, feasible); repo-sourced samples come via proxied GitHub fetches; tagged-sample persistence moves from disk to KV. A natural platform upgrade: pull live samples via the Cribl capture/samples REST API.

### GUI-07. Headerless CSV header resolution dialog

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/SentinelIntegration.tsx` | Maturity: production | Category: pipeline-generation | Verdict: **direct**
- When an uploaded CSV parses to positional _0/_1 columns, a dialog pauses ingestion and lets the user supply column names by uploading a header file (comma- or newline-separated, sanitized to identifiers) or pasting a vendor feed config that is parsed to extract field names (vendor/feed type reported); the CSV is then re-parsed with named headers and tagged.
- In/Out: In: headerless CSV content, header file or feed-config text. Out: re-parsed sample with named fields.
- Depends on: window.api.sampleParser.parseCsvWithHeaders/parseFeedConfig/tagSample; isHeaderlessCsv heuristic in the renderer.
- Portability: Detection heuristic already lives in the renderer; the re-parse and feed-config extraction are pure string logic to port into browser TS. No external calls.

### GUI-08. DCR gap analysis with field-mapping review and approval

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/SentinelIntegration.tsx` | Maturity: production | Category: pipeline-generation | Verdict: **needs-redesign**
- Analyze button runs a 5-phase pipeline with progress: vendor research -> destination-table resolution (research destTables, else Sentinel-repo CustomTables _CL connectors, else CommonSecurityLog default, with source provenance shown) -> per-sample table matching -> DCR gap analysis producing per-logType stats (source fields, dest columns, passthrough, DCR-handled renames/coercions, Cribl-handled, overflow) with expandable detail and a full field-mapping table -> rule coverage -> Azure resource preview. Users edit individual mappings (mappingEdits overrides) and must approve each table's mappings (or Auto-Approve All) before Deploy unlocks; edits mark analysis stale on sample/solution change.
- In/Out: In: tagged samples + selected solution. Out: SampleAnalysis[] (stats, dcr/cribl renames+coercions, route condition, fieldMappings, destSchema), tableResolution, approval state, mapping overrides fed into pack scaffold.
- Depends on: window.api.vendorResearch.research, sentinelRepo.connectors, packBuilder.analyzeSamples; pure helpers in hooks/analyze-workflow.ts; 6-phase field-matcher + DCR schema knowledge in main process.
- Portability: The orchestration, approval gating, and table-resolution/matching helpers (hooks/analyze-workflow.ts) are pure and port directly. The heavy engines (field matcher, DCR schema library, vendor research) are main-process modules that must be ported to browser TS; schema/vendor lookups become proxied GitHub/Azure fetches. Long analyses must stay chunked/async to fit the browser.

### GUI-09. Analytics rule coverage analysis with custom rule upload

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/SentinelIntegration.tsx` | Maturity: production | Category: reporting | Verdict: **needs-proxy**
- Evaluates which fields referenced by the solution's Sentinel analytics (detection) rules are produced by the approved mappings: per-rule coverage list (severity, tactics, covered/missing fields, KQL query), summary bar (fully/partially/none covered, missing fields across rules). Users upload custom analytics-rule YAML files (parsed via parseRuleYaml, merged and de-duped) and clear them, re-running coverage each time.
- In/Out: In: mapped destination fields from analyses, solution name, optional custom rule YAML files. Out: ruleCoverage report (rules[], summary).
- Depends on: window.api.packBuilder.ruleCoverage/parseRuleYaml; solution Analytic Rules YAML from the Sentinel repo mirror.
- Portability: YAML rule parsing and coverage computation are pure logic (port to browser with a YAML lib); repo rules arrive via proxied GitHub fetches. File upload already uses the browser File API pattern.

### GUI-10. Azure resource targeting configuration

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/SentinelIntegration.tsx` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- Section 3: live pickers for subscription -> Log Analytics workspace -> DCR resource group (with fallback derivation of RGs from workspace metadata when the RG API call fails), create-new-resource-group input with location, and offline-mode manual entry of workspace/RG/location/subscription for ARM template embedding. Toggles: create DCE (private link/AMPLS), enable DCR metrics, assign Monitoring Metrics Publisher role to a Cribl service principal (with Enterprise Application Object ID input and guidance).
- In/Out: In: subscription/workspace/RG selections or manual values, DCE/metrics/role toggles, SP object ID. Out: deployment target state consumed by preview, permission check, and deploy.
- Depends on: window.api.auth.azureSubscriptions/azureWorkspaces/azureResourceGroups/azureCreateResourceGroup; hooks/azure-resources.ts deriveResourceGroupsFromWorkspaces.
- Portability: All enumeration/creation maps 1:1 to ARM REST (subscriptions, workspaces, resourceGroups endpoints) through proxies.yml (management.azure.com) once Azure auth is KV-token based; today it rides an Azure PowerShell session in the main process. The pure RG-derivation helper and all UI port directly; offline manual-entry mode ports as-is.

### GUI-11. Azure RBAC permission preflight

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/SentinelIntegration.tsx` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- On workspace selection, automatically checks deploy readiness and renders per-capability dots (write resource group, read workspace, create DCRs, create tables, create DCEs) plus granted RBAC role names; on failure shows Contributor/Owner-required guidance with PIM hint, Retry Check, and Switch Account actions.
- In/Out: In: selected workspace/worker group. Out: azurePermissions report (booleans per capability, roles[], canDeploy gate, error).
- Depends on: window.api.permissions.check, auth.azureLogin/status.
- Portability: Permission evaluation maps to ARM permissions/roleAssignments API calls through the proxy; 'Switch Account' becomes re-running the redesigned OAuth flow. Depends on the Azure auth redesign; the report UI ports directly.

### GUI-12. Azure resource preview with ARM template inspection

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/SentinelIntegration.tsx` | Maturity: production | Category: dcr-deployment | Verdict: **needs-proxy**
- Preview of every Azure resource the deployment will touch (DCRs, custom tables), each tagged DCR/TBL with Exists vs Will Create status determined against the live subscription, expandable to view the exact ARM template JSON that would be deployed.
- In/Out: In: destination tables (from vendor research), subscription/RG/workspace/location. Out: resource list with existence flags and per-resource armTemplate JSON.
- Depends on: window.api.azureDeploy.previewResources, vendorResearch.research.
- Portability: ARM template generation is pure templating (port to browser TS); existence checks are ARM GET calls via the proxy. High-value feature for the platform app since it doubles as the downloadable-template source in offline mode.

### GUI-13. Cribl target configuration (worker groups and pack naming)

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/SentinelIntegration.tsx` | Maturity: production | Category: pack-management | Verdict: **direct**
- Section 4: multi-select checkbox list of Cribl worker groups (with worker counts) loaded from the connected deployment, and pack-name input auto-generated from the solution name by a succinct-naming rule (strip noise words like connector/for/microsoft/sentinel, take first 2 meaningful words, append -sentinel).
- In/Out: In: connected Cribl session, solution name. Out: workerGroups[] selection and packName used by deploy/wiring.
- Depends on: window.api.auth.criblWorkerGroups; pure name-generation logic in the renderer.
- Portability: Worker-group listing is a native Cribl product API call (GET /master/groups) available via authenticated fetch under policies.yml -- no proxy needed. Naming logic is pure and ports as-is.

### GUI-14. One-click integration deploy orchestration

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/SentinelIntegration.tsx` | Maturity: production | Category: dcr-deployment | Verdict: **needs-redesign**
- Section 5 Deploy All executes the full pipeline with a live step log and mode-aware skipping (full/azure-only/cribl-only/air-gapped): create new RG, select workspace, vendor research for destination tables, per-table existing-DCR check then DCR deployment choosing DirectNative/DirectCustom/DCENative/DCECustom by table type and DCE toggle, optional Monitoring Metrics Publisher role assignment to the Cribl SP on each deployed DCR, pack scaffold (per-logType pipelines with route discriminator auto-detection: unique event-field strategy, partial-match strategy, sourcetype-regex fallback; format re-detection from raw CEF/LEEF markers; auto version bump if pack exists; field-mapping overrides applied), Azure destination endpoint refresh + embed into the pack, .crbl packaging, CrowdStrike FDR event-breaker creation on worker groups when applicable, pack upload per worker group, and post-deploy validation via a Cribl pipeline preview on a sample event; readiness gates shown as step chips.
- In/Out: In: all prior workflow state (solution, samples, mappings, Azure target, worker groups, pack name). Out: deployed DCRs/role assignments in Azure, built+packaged pack uploaded to Cribl, deploy log, deployComplete flag; exported artifacts in offline modes.
- Depends on: window.api.auth.azureCreateResourceGroup/azureSelectWorkspace/criblCreateBreaker/criblUploadPack/criblPreview, azureDeploy.checkExisting/deployDcrs/getDcrIds/assignDcrRole/refreshDestinations/embedDestinations, vendorResearch.research, packBuilder.list/scaffold/package/exportArtifacts.
- Portability: The orchestration sequence, mode gating, route-discriminator detection, and logging are renderer logic that ports directly. Mechanisms change per step: DCR/role operations become ARM REST via proxy; pack scaffold/packaging must run in-browser (generate YAML/CSV, build .tgz .crbl client-side) or via Cribl pack APIs; upload/breaker/preview are native Cribl REST calls. Sequential Azure deployments may need polling of ARM async operations within the 30s-per-request proxy limit.

### GUI-15. Air-gapped artifact export

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/SentinelIntegration.tsx` | Maturity: production | Category: pack-management | Verdict: **needs-redesign**
- In offline/partial modes the deploy flow exports a manual-deployment bundle to ~/Downloads/{packName}-artifacts/: the .crbl pack archive, per-table ARM template JSONs, Cribl destination config JSONs filtered to the solution's tables, and a README-deployment.md with step-by-step instructions; exported file list echoed to the deploy log.
- In/Out: In: built pack dir, .crbl path, destination tables, solution/pack names. Out: artifact directory in Downloads with .crbl, arm-templates/, cribl-destinations/, README.
- Depends on: window.api.packBuilder.exportArtifacts (filesystem writes in main).
- Portability: Re-implement as in-browser artifact generation with a zip/download (all content -- ARM JSON, destination JSON, README markdown, .crbl tarball -- can be produced client-side). This is the primary path for the platform app's own air-gapped mode.

### GUI-16. Source wiring with Cribl Lake federation

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/SentinelIntegration.tsx` | Maturity: production | Category: pack-management | Verdict: **direct**
- Section 6 (after deploy): pick an enabled Cribl source in the worker group, then Wire Source & Commit creates a final route (__inputId filter -> pack -> Sentinel destination), optionally creates a Cribl Lake dataset (existing picker or create-new, Cloud deployments only) plus a non-final passthru full-fidelity route to cribl_lake:{dataset}, commits the config with a message, and deploys to every selected worker group, with a step log.
- In/Out: In: source ID, pack name, Lake toggle + dataset. Out: routes/dataset created, config committed and deployed; wiringComplete flag unlocking validation.
- Depends on: window.api.auth.criblSources/criblDatasets/criblCreateDataset/criblCreateRoute/criblCommit/criblDeployConfig.
- Portability: Every operation is a native Cribl product REST call (sources, routes, lake datasets, version commit, deploy) available to the app via authenticated fetch -- the IPC indirection just disappears. Lake dataset APIs need the corresponding paths declared in policies.yml.

### GUI-17. End-to-end data flow validation widget

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/components/DataFlowView.tsx` | Maturity: production | Category: reporting | Verdict: **needs-redesign**
- Two-stage visual pipeline (Source -> Sentinel) embedded as workflow section 7: capture live events from the wired Cribl source (live capture API), then query the Sentinel destination table via KQL to confirm ingestion, with per-stage event previews, animated flow arrows, new-event highlighting, capture buttons, and auto-refresh; designed around 4 stages (source, after route, after pipeline, destination) per its header comment.
- In/Out: In: worker group, source ID, pack pipeline name, destination table. Out: captured source events and matching Sentinel rows with error/status per stage.
- Depends on: window.api.auth.criblSources/criblListDestinations/criblCapture/azureQuery (Log Analytics KQL).
- Portability: Cribl capture is a native product API call (direct). The Sentinel-side KQL query needs api.loganalytics.io through the proxy with the redesigned Azure auth. Long captures (60s) must be chunked to respect request timeouts.

### GUI-18. Data flow monitoring dashboard

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/DataFlow.tsx` | Maturity: production | Category: reporting | Verdict: **needs-redesign**
- Full-width standalone page (no sidebar) listing every enabled source in a chosen worker group as a health-colored flow row; per-source or capture-all runs a Cribl live capture then correlates into Sentinel by extracting source/dest IPs from captured events and building a KQL query against CommonSecurityLog (with recent-events fallback and explanatory errors), expandable stage panels with event cards, status bar (sources/with-data/errors), 45s auto-refresh loop, and worker-group selector.
- In/Out: In: worker group choice, capture clicks/auto-refresh. Out: per-source Source and Sentinel stage events, health rollups, correlation errors.
- Depends on: window.api.auth.status/criblWorkerGroups/criblSources/criblCapture/azureQuery.
- Portability: Same split as the validation widget: Cribl captures direct via product API; KQL correlation via proxied Log Analytics with KV-based Azure auth. The IP-extraction correlation heuristic is pure renderer logic and ports as-is; auto-refresh cadence must respect the 100 req/min proxy budget.

### GUI-19. Pack inventory manager

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/Packs.tsx` | Maturity: production | Category: pack-management | Verdict: **needs-redesign**
- Lists all packs built by the toolkit with metadata (version, author, size, created, description, tables), per-pack deployment badges resolved by cross-checking installed packs in every Cribl worker group, download of the .crbl (via web endpoint), package/repackage of unpackaged packs, delete pack (with .crbl count confirm), per-version .crbl artifact list with remove, and a storage info bar (total size, orphaned .crbl and old-version counts) with one-click Clean Up reporting freed bytes.
- In/Out: In: refresh/download/package/delete/clean actions. Out: pack list with deployment status, downloaded .crbl files, cleaned storage stats.
- Depends on: window.api.packBuilder.list/storageInfo/package/delete/deleteCrbl/clean, auth.status/criblWorkerGroups/criblListPacks; /api/pack/download HTTP endpoint.
- Portability: Local pack-directory storage becomes KV-persisted pack definitions with client-side .crbl (re)generation and browser downloads; deployed-status checks are native Cribl API calls (direct). Storage cleanup semantics shift from disk files to KV entries.

### GUI-20. Manual pack builder (browse and scaffold)

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/PackBuilder/PackScaffold.tsx` | Maturity: dev | Category: pack-management | Verdict: **needs-redesign**
- Legacy tabbed alternative to the guided workflow (PackBuilder.tsx: My Packs / Sentinel Content Hub / New Pack): pick a solution card (SentinelBrowser.tsx), then configure a pack manually -- solution details and data-connector schemas fetched from GitHub, vendor samples loaded, per-table config rows (Sentinel table name, Cribl stream, source schema vs DCR schema fetched per table) with per-field mapping actions rendered in a source->dest grid with type tags, add/remove/rename tables, then scaffold the pack.
- In/Out: In: solution selection, table/field mapping edits. Out: scaffolded pack directory via packBuilder.scaffold.
- Depends on: window.api.github.fetchSolutionDetails/fetchSolutionSchemas/fetchVendorSamples, packBuilder.getAvailableTables/getDcrSchema/scaffold.
- Portability: Superseded by the SentinelIntegration guided flow; if kept, GitHub fetches go through the proxy and scaffold runs in-browser. Field-mapping grid UI ports directly. Consider folding into the main workflow rather than porting separately.

### GUI-21. Upstream solution change detection

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/PackBuilder/PackManager.tsx` | Maturity: dev | Category: pack-management | Verdict: **needs-redesign**
- Monitors built packs for upstream Sentinel-solution changes: alert map per pack with severity, Check Now trigger, expandable per-pack diff view (changed files since snapshot), dismiss action, live status broadcasts, and a count badge (critical-colored) on the Pack Builder sidebar nav item (components/Sidebar.tsx).
- In/Out: In: check/dismiss actions, background status events. Out: per-pack alerts with diffs, sidebar badge counts.
- Depends on: window.api.changeDetection.status/check/packDiff/dismiss/onStatus; snapshot + git-log diffing of the local Sentinel repo mirror in main.
- Portability: Re-implement on the GitHub compare/commits API through the proxy (snapshot commit SHA per pack stored in KV, diff via commits API) instead of local git; push-style background checks become poll-on-open or scheduled client polling.

### GUI-22. SIEM migration analysis and report export

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/SiemMigration.tsx` | Maturity: production | Category: reporting | Verdict: **needs-redesign**
- Upload a Splunk detection-rule JSON export or QRadar CSV (platform auto-detected by extension); the parsed MigrationPlan shows total/enabled rules and building blocks, data sources grouped by mapped Sentinel solution with confidence badges and per-group rule counts, unmapped sources, MITRE ATT&CK tactic coverage tiles, matched Sentinel analytics rules per solution with severity/tactics, a Configure button deep-linking each solution into the Sentinel Integration workflow, and a Download Migration Report action producing a Markdown report in Downloads.
- In/Out: In: Splunk JSON / QRadar CSV export file. Out: MigrationPlan (dataSources, mappings, MITRE coverage, Sentinel rule matches), Markdown report file, deep-link handoff.
- Depends on: window.api.siemMigration.parse/exportReport; solution-mapping knowledge referencing the Sentinel repo in main.
- Portability: Export parsing and mapping heuristics are pure text logic to port client-side; Sentinel rule matching needs proxied GitHub lookups; report export becomes an in-browser Markdown download. The deep link into the integration workflow ports directly (route param).

### GUI-23. DCR Automation script runner

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/DcrAutomation.tsx` | Maturity: dev | Category: dcr-deployment | Verdict: **not-portable**
- Thin GUI over the repo's Run-DCRAutomation.ps1: deployment-mode dropdown (DirectNative/DirectCustom/DirectBoth/DCENative/DCECustom/DCEBoth/TemplateOnly), action buttons (Status, Collect/Validate/Reset Cribl config), Run/Cancel with terminal streaming, plus inline JSON editors for azure-parameters.json and operation-parameters.json.
- In/Out: In: mode selection, config JSON edits. Out: PowerShell process execution with streamed output; edited config files on disk.
- Depends on: usePowerShell hook -> window.api.powershell.execute/cancel; ConfigEditor -> config.read/write against repo paths; the 4600-line PowerShell engine.
- Portability: Spawning PowerShell against repo files cannot run in a sandboxed iframe. The user value (DCR deployment with all modes) is already re-delivered by the in-app azureDeploy flow (feature: deploy orchestration), so this wrapper should be dropped rather than ported.

### GUI-24. Discovery tools runner (Event Hub and vNet flow logs)

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/Discovery.tsx` | Maturity: dev | Category: discovery | Verdict: **needs-redesign**
- Two-tab GUI launching the repo discovery scripts: Event Hub discovery with mode picker (DiscoverAll/ByNamespace/ByResourceGroup/ExportConfig/ValidateConfig/Status) and vNet Flow Log discovery (single run), each with a JSON config editor and terminal-streamed output/cancel.
- In/Out: In: discovery mode, azure-parameters.json edits. Out: PowerShell runs producing discovery results and Cribl source configs on disk.
- Depends on: usePowerShell -> powershell.execute/cancel; Discover-EventHubSources.ps1 and Run-vNetFlowLogDiscovery.ps1.
- Portability: The wrapper mechanism (PowerShell) is not portable, but the underlying value -- enumerate Event Hubs / NSG flow logs via Azure Resource Graph and generate Cribl source configs -- maps cleanly to proxied ARM/Resource Graph REST plus native Cribl source-creation APIs, so catalog as redesign.

### GUI-25. Azure lab environment wizards

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/LabAutomation.tsx` | Maturity: experimental | Category: labs-testing | Verdict: **out-of-scope**
- Card grid of 9 pre-configured Azure labs (Sentinel Quick Start, Sentinel, Complete, Flow Log, ADX Analytics, Event Hub, Blob & Queue, Blob Collector, Basic Infrastructure) each with components, time and cost estimates/warnings; selecting one opens a multi-step wizard (identity, location/mode, TTL auto-cleanup, monitoring, infrastructure, storage, analytics, review) over a 25+ parameter catalog with per-field history dropdowns persisted to config, computed resource names, and deploy: Quick Start runs RG+workspace+Sentinel enablement through REST-ish IPC with inline log; other labs launch Run-AzureUnifiedLab.ps1 -Mode X (parameter write-back still a TODO).
- In/Out: In: lab choice + wizard parameter values, Azure subscription. Out: deployed Azure lab resources, deploy log, lab-field-history.json.
- Depends on: window.api.auth.azureSubscriptions/azureStatus/azureCreateResourceGroup/azureCreateWorkspace/azureEnableSentinel, config.read/write, usePowerShell for Run-AzureUnifiedLab.ps1.
- Portability: Lab provisioning is test infrastructure, not a SOC product feature -- out of scope for the Cribl app. Note the Sentinel Quick Start sub-flow (create RG + Log Analytics workspace + enable Sentinel via three API calls) is pure REST and would port via the ARM proxy if onboarding-workspace creation is ever wanted.

### GUI-26. PowerShell terminal console

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/components/Terminal.tsx` | Maturity: production | Category: infra-tooling | Verdict: **not-portable**
- Collapsible bottom panel streaming stdout/stderr/system lines from running PowerShell processes and startup logs (repo sync etc.) via a global line buffer (5000-line cap), with running indicator, copy-all, and clear; fed by usePowerShell (hooks/usePowerShell.ts) which executes scripts, awaits exit events, and cancels processes.
- In/Out: In: powershell.onOutput/onExit/onStartupLog events. Out: scrollback console UI.
- Depends on: window.api.powershell.* IPC; Electron child processes.
- Portability: Exists solely to surface local process output; with no child processes on the platform it is dropped. Its UX role (live operation logs) is already covered by the in-page deploy/wiring logs, which port directly.

### GUI-27. Inline JSON configuration editor

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/components/ConfigEditor.tsx` | Maturity: production | Category: infra-tooling | Verdict: **needs-redesign**
- Reusable collapsible editor for repo JSON config files: loads via config.read, pretty-prints, tracks Modified state, validates JSON on save, revert, and saved/error feedback; used by DcrAutomation and Discovery pages (useConfig hook offers the same read/save as a hook).
- In/Out: In: config file path, edited JSON text. Out: written config file / error states.
- Depends on: window.api.config.read/write (filesystem in main).
- Portability: Component is pure UI and ports directly; the backing store must change from repo files on disk to the app-scoped KV store (or Cribl config objects via product API). Only needed if any config-editing surface survives the PS-wrapper removal.

### GUI-28. Connection status bar (AuthBar)

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/components/AuthBar.tsx` | Maturity: production | Category: identity-auth | Verdict: **needs-redesign**
- Persistent top bar with 30s-polled Cribl and Azure status pills honoring the integration mode (hidden/marked-skipped per mode): Cribl popup to connect (cloud org or self-managed URL, optional save-credentials) or disconnect, showing org parsed from the base URL; Azure popup to login, pick subscription (azureSetSubscription), pick workspace, and select the active workspace context.
- In/Out: In: credentials/selections in popups. Out: refreshed auth status, active subscription/workspace context shared app-wide.
- Depends on: window.api.auth.status/criblConnect/criblDisconnect/azureLogin/azureSubscriptions/azureSetSubscription/azureWorkspaces/azureSelectWorkspace, config.read.
- Portability: Cribl half becomes platform-provided (app already runs authenticated in the leader). Azure half survives as the workspace-context switcher backed by proxied ARM calls and KV-stored tokens. Polling cadence must respect proxy rate limits.

### GUI-29. Settings page

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/pages/Settings.tsx` | Maturity: production | Category: infra-tooling | Verdict: **direct**
- Read-only environment info (repo root, platform, PowerShell binary), a table of config-file locations for each embedded tool, Azure auth guidance (Connect-AzAccount instructions), current integration mode display, and a Reconfigure button that clears integration-mode.json and reloads to re-run the wizard, plus app version.
- In/Out: In: reconfigure click. Out: cleared mode config triggering wizard.
- Depends on: window.api.config.read/write/getRepoRoot.
- Portability: Trivial port with content rewritten for the platform (KV-backed mode, no repo paths or PowerShell guidance).

### GUI-30. App shell and mode-aware navigation

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/components/Sidebar.tsx` | Maturity: production | Category: infra-tooling | Verdict: **direct**
- Layout (components/Layout.tsx) composes sidebar + AuthBar + routed page + terminal panel; sidebar renders nav items filtered by integration mode, change-detection alert badge on Pack Builder (critical-red vs orange), registry-sync activity dot, version, and mode indicator chip; App.tsx defines the route table including the full-width /data-flow route; shared UI atoms InfoTip (hover tooltips used throughout the workflow) and StatusBadge (idle/running pill, unit-tested).
- In/Out: In: route changes, changeDetection/registrySync status events. Out: navigation, badges, layout.
- Depends on: react-router-dom, window.api.changeDetection.status/onStatus, registrySync.onProgress, config.read.
- Portability: Standard React SPA chrome -- ports directly inside the app iframe; drop the terminal panel and rewire badges to the redesigned change-detection source.

### GUI-31. Web-mode API client bridge

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/api-client.ts` | Maturity: production | Category: infra-tooling | Verdict: **platform-provided**
- Drop-in replacement for the Electron preload bridge when running as a browser SPA: maps every window.api namespace (deps, powershell, config, github, sentinelRepo, packBuilder, azureDeploy, vendorResearch, registrySync, changeDetection, auth with ~35 Cribl/Azure methods, sampleParser with browser file-input upload, e2e, permissions, defaultSamples, fieldMatcher, siemMigration) to POST /api/{channel} fetch calls plus a Server-Sent-Events subscription for push events -- effectively the complete catalog of backend operations the renderer drives.
- In/Out: In: method calls from pages. Out: HTTP calls to the Express backend + SSE event fan-out.
- Depends on: fetch/EventSource against src/server Express API.
- Portability: The platform app is already a SPA calling APIs with fetch, so this bridging layer is obsolete -- but it is the definitive map of which backend operations each renderer feature needs when re-pointing calls to Cribl product API, proxied external APIs, and ported client-side engines.

### GUI-32. Pure workflow logic helpers (tested)

- Source: `Cribl-Microsoft_IntegrationSolution/src/renderer/hooks/analyze-workflow.ts` | Maturity: production | Category: pipeline-generation | Verdict: **direct**
- Extracted, unit-tested pure functions shared across analyze/preview/deploy flows: resolveDestinationTables (vendor research -> Sentinel-repo CustomTables _CL fallback -> CommonSecurityLog default, with provenance string) and matchSampleToTable (normalized exact/substring matching of sample log types to destination tables); plus hooks/azure-resources.ts deriveResourceGroupsFromWorkspaces fallback. Tests: analyze-workflow.test.ts, azure-resources.test.ts, StatusBadge.test.tsx.
- In/Out: In: vendor log-type hints, connector lists, workspace metadata. Out: destination table list + source label, per-sample table assignment, derived RG list.
- Depends on: None (pure TS; connector loading injected).
- Portability: Copy verbatim into the new app along with their tests; these encode the precedence rules the whole workflow depends on.


## Event Hub Discovery (EVH)

Azure/dev/EventHubDiscovery is a menu-driven PowerShell toolkit that inventories Azure Event Hub namespaces/hubs and answers "what is sending data to my Event Hubs" via three phases: Resource Graph configuration discovery (diagnostic settings, Stream Analytics, Logic Apps/Functions), Azure Monitor metrics activity detection, and pure-logic correlation/inference that flags unknown SDK-based senders. Results export to eventhub-discovery-results/ as timestamped JSON (plus CSV in the legacy path) and are intended as manual input to Cribl source planning; no Cribl config generation exists in this subsystem. State is dev-tree working code with known drift: the default optimized path ignores namespace/resource-group filters, the -ExportToCsv flag, and the -IncludeMetrics gate, and the prod optimized variant uses a Resource Graph Event Hub query the dev variant documents as non-indexed.

Reader-noted gaps: 1) No Cribl config generation exists in this subsystem despite the subsystem hint - discovery JSON is consumed manually for Cribl source planning; the discovery-to-Cribl-config generator pattern lives in Azure/dev/vNetFlowLogDiscovery (outside this catalog's paths) and would need to be newly built for Event Hub sources (mapping hubs/consumer groups to Cribl azure_eventhub source configs is an obvious app enhancement). 2) Default-path fidelity bugs to avoid replicating: the orchestrator always calls the Optimized script, which ignores -NamespaceName, targetNamespaces/targetResourceGroups, -ExportToCsv, and -IncludeMetrics, so menu options 2/3 silently degrade to full-subscription discovery and CSV export only works via the manually-selected legacy script; core scripts' -ExportOnly re-serializes an empty in-memory object rather than reloading saved results. 3) dev/ and prod/ optimized scripts have drifted; prod still queries Event Hubs via a Resource Graph child-resource type that the dev script documents as non-indexed (prod likely returns zero hubs). 4) Committed live identifiers: dev/azure-parameters.json holds a real subscription+tenant GUID and test-resource-graph.ps1 hard-codes a subscription ID. 5) Not assessed here: single-subscription only (OPTIMIZATION_GUIDE describes cross-subscription Resource Graph queries as future option); Event Hub namespace-level diagnostic-log-based sender identification is documented as a recommendation but not implemented anywhere in the subsystem.

### EVH-01. Event Hub discovery orchestrator (interactive menu + non-interactive CLI)

- Source: `Azure/dev/EventHubDiscovery/Discover-EventHubSources.ps1` | Maturity: dev | Category: discovery | Verdict: **needs-redesign**
- Entry point with 6-option menu (Discover All, Discover by Namespace, Discover by Resource Group, View Status, Export Configuration, Validate Configuration) and -NonInteractive -Mode {DiscoverAll|DiscoverByNamespace|DiscoverByResourceGroup|Status|ExportConfig|ValidateConfig} with -NamespaceName/-IncludeMetrics/-ExportToJson/-ExportToCsv flags. Delegates to the environment-specific core script (Optimized hard-coded at line 32; legacy only via manual edit). Status mode prints current azure/operation parameter values.
- In/Out: In: menu keystrokes or CLI params, dev|prod azure-parameters.json and operation-parameters.json. Out: invocation of core discovery script with mapped parameters; console status display.
- Depends on: PowerShell 5.1+, child script invocation (& operator), local JSON config files, Read-Host/Clear-Host console UI.
- Portability: Menu/console loop becomes SPA navigation and buttons; mode dispatch and parameter mapping are trivial TS. Config files move to app KV store; child-process invocation becomes in-app function calls. Note DiscoverByNamespace/DiscoverByResourceGroup only actually filter in the legacy script, so the app should implement filtering properly rather than replicate the pass-through bug.

### EVH-02. Configuration validation with placeholder detection and fix-wait loop

- Source: `Azure/dev/EventHubDiscovery/Discover-EventHubSources.ps1` | Maturity: dev | Category: discovery | Verdict: **direct**
- Test-AzureParametersConfiguration (lines 35-103) checks azure-parameters.json exists, parses as JSON, and detects missing or still-placeholder subscriptionId/tenantId values (e.g. '<YOUR-SUBSCRIPTION-ID-HERE>'), listing exactly which fields need fixing; Wait-ForConfigurationUpdate (lines 106-139) blocks interactively until the user edits the file and revalidates. Runs before menu display and before non-interactive execution (exit 1 on failure).
- In/Out: In: azure-parameters.json. Out: boolean pass/fail plus per-field guidance text; blocks or exits until valid.
- Depends on: Local filesystem read, ConvertFrom-Json, Read-Host prompt loop.
- Portability: Placeholder/missing-field validation is pure logic that ports directly to TS form validation against KV-stored settings; the file-edit wait loop is replaced by a settings form with inline errors, which is strictly better in a SPA.

### EVH-03. Resource Graph Event Hub infrastructure inventory (namespaces + hubs, paginated)

- Source: `Azure/dev/EventHubDiscovery/dev/Get-EventHubDataSources-Optimized.ps1` | Maturity: dev | Category: discovery | Verdict: **needs-proxy**
- Step 1 queries all microsoft.eventhub/namespaces via one KQL Resource Graph query (name, RG, location, sku, tags); Step 2 enumerates Event Hubs per namespace via Get-AzEventHub because Resource Graph does not index hub child resources (dev-variant fix; the prod variant still uses a 'microsoft.eventhub/namespaces/eventhubs' Resource Graph query that returns nothing). SkipToken pagination handles >1000 results. Config supports targetNamespaces/targetResourceGroups scope filters, but only the legacy script honors them; the optimized path scans the whole subscription.
- In/Out: In: subscriptionId/tenantId, optional targetNamespaces/targetResourceGroups filters (azure-parameters.json). Out: namespace list with SKU/location and per-hub partitionCount, messageRetentionInDays, status, resourceId; TotalNamespaces/TotalEventHubs counts.
- Depends on: Az.ResourceGraph (Search-AzGraph), Az.EventHub (Get-AzEventHub), Azure Reader role. REST equivalents: POST management.azure.com/providers/Microsoft.ResourceGraph/resources and GET .../namespaces/{ns}/eventhubs (2 + N calls).
- Portability: KQL queries POST verbatim to the Resource Graph REST API through a management.azure.com proxies.yml entry; per-namespace hub listing is a plain ARM GET. Pagination via $skipToken maps 1:1. Per-namespace hub calls fit the 100 req/min budget for typical estates; add client-side batching/backoff for very large ones. Implement the scope filters as KQL where-clauses instead of the broken pass-through.

### EVH-04. One-query data source configuration discovery (diagnostic settings, Stream Analytics, Logic Apps/Functions)

- Source: `Azure/dev/EventHubDiscovery/dev/Get-EventHubDataSources-Optimized.ps1` | Maturity: dev | Category: discovery | Verdict: **needs-proxy**
- Get-AllDiagnosticSettingsOptimized (lines 219-258): single paginated KQL query returning every microsoft.insights/diagnosticsettings resource targeting an Event Hub, extracting eventHubName, namespace from the auth rule ID, source resourceId, and enabled logs/metrics. Get-StreamAnalyticsJobsOptimized (261-311): one KQL query for all streamingjobs, then per-job Get-AzStreamAnalyticsOutput to keep only Microsoft.ServiceBus/EventHub outputs. Get-LogicAppsAndFunctionsOptimized (314-346): one KQL query listing Logic App workflows and function-app kind web/sites (inventory only; not matched to specific hubs). Replaces the legacy N-resources x M-hubs scan (~5 calls vs thousands; 50-100x faster per OPTIMIZATION_GUIDE.md benchmarks).
- In/Out: In: subscriptionId. Out: arrays of configured senders (SourceType DiagnosticSetting with source resourceId/logs/metrics; Stream Analytics job+output pairs; Logic App/Function inventory) later attached per-hub as DataSources with counts.
- Depends on: Az.ResourceGraph, Az.StreamAnalytics (optional; job outputs), Azure Reader role. REST equivalents: Resource Graph POST plus per-job GET .../streamingjobs/{job}/outputs.
- Portability: The KQL is the crown jewel and ports verbatim through the ARM proxy. Per-job Stream Analytics output checks are bounded by job count and fit rate limits. The 30s proxy timeout is fine since each query is a single fast call; drive the multi-step flow as sequential awaited fetches with progress UI.

### EVH-05. Legacy per-resource data source discovery (incl. Application Insights continuous export)

- Source: `Azure/dev/EventHubDiscovery/dev/Get-EventHubDataSources.ps1` | Maturity: dev | Category: discovery | Verdict: **needs-redesign**
- Original slow path: for each Event Hub, iterates every resource in the subscription calling Get-AzDiagnosticSetting per resource, scans all Stream Analytics jobs/outputs, text-matches Logic App workflow definitions and Function App app settings for hub/namespace references, and checks Application Insights continuous export destinations (the only script that detects App Insights and does definition-level Logic App/Function matching). Honors DiscoveryMode Namespace/ResourceGroup grouping, targetNamespaces/targetResourceGroups filters, includeConsumerGroups/includeAuthorizationRules/lookbackDays/continueOnError toggles. Identical copy in prod/.
- In/Out: In: same config files plus DiscoveryMode/NamespaceName params. Out: per-hub DataSources with richer fields (EnabledLogs/EnabledMetrics categories, JobState, workflow State), DataSourcesSummary flat list, per-hub metrics, JSON+CSV exports.
- Depends on: Az.Accounts, Az.EventHub, Az.Monitor, Az.Resources; optional Az.StreamAnalytics, Az.LogicApp, Az.Websites. Call volume = resources x hubs (5,000+ calls; 30-60 min documented).
- Portability: The N x M call pattern is unworkable under the 100 req/min proxy limit; do not port the mechanism. Port only its unique detections on top of the Resource Graph approach: Logic App definition matching (GET workflow definition), Function App settings matching (POST list appsettings - needs write-scope ARM permission), and drop App Insights continuous export (retired by Azure). Its filter/grouping semantics should become the canonical scope-filter implementation.

### EVH-06. Consumer group and authorization rule enumeration per Event Hub

- Source: `Azure/dev/EventHubDiscovery/dev/Get-EventHubDataSources-Optimized.ps1` | Maturity: dev | Category: discovery | Verdict: **needs-proxy**
- Step 4 (lines 408-438): for every hub, lists consumer group names (Get-AzEventHubConsumerGroup) and authorization rules with joined Rights strings (Get-AzEventHubAuthorizationRule). Legacy script gates the same collection behind includeConsumerGroups/includeAuthorizationRules config toggles (optimized always collects). Feeds ConsumerGroups/ConsumerGroupCount/AuthorizationRules output fields and the inference engine.
- In/Out: In: namespace/hub inventory. Out: per-hub consumer group name arrays and auth rule {Name, Rights} lists; TotalConsumerGroups statistic.
- Depends on: Az.EventHub cmdlets; ARM REST: GET .../eventhubs/{hub}/consumergroups and .../authorizationRules (2 calls per hub).
- Portability: Plain ARM GETs through the proxy. Two calls per hub means ~50 hubs/min max at the rate limit; needs client-side throttling with progress feedback, or make it opt-in per the legacy toggles for large estates. Directly relevant to Cribl: consumer group names seed Azure Event Hub source config in Stream.

### EVH-07. Metrics-based activity detection (active/inactive Event Hubs)

- Source: `Azure/dev/EventHubDiscovery/dev/Get-EventHubDataSources-Optimized.ps1` | Maturity: dev | Category: discovery | Verdict: **needs-proxy**
- Step 5 (lines 441-489): pulls the IncomingMessages metric per hub for the last 7 days at 1-hour grain, sums totals, classifies each hub IsActive/inactive, and counts active vs inactive. Runs unconditionally in the optimized script (the -IncludeMetrics flag is ignored there). Legacy variant (Get-EventHubMetrics, lines 478-504) is gated by -IncludeMetrics and additionally collects OutgoingMessages, IncomingBytes, OutgoingBytes over a configurable lookbackDays.
- In/Out: In: hub resource IDs, lookback window (7d fixed in optimized; lookbackDays config in legacy). Out: per-hub IncomingMessages7d, IsActive flag, active/inactive counts in Statistics.
- Depends on: Az.Monitor Get-AzMetric; REST: GET {resourceId}/providers/microsoft.insights/metrics (1 call per hub); Monitoring Reader/Reader role.
- Portability: Azure Monitor metrics REST via the management proxy. One call per hub strains the rate limit at scale; prefer the metrics:getBatch endpoint (up to 50 resources per call) or namespace-level filtering. Treat the two variants as one feature with a configurable metric set and lookback.

### EVH-08. Unknown-sender correlation analysis and sender inference heuristics

- Source: `Azure/dev/EventHubDiscovery/dev/Get-EventHubDataSources-Optimized.ps1` | Maturity: dev | Category: discovery | Verdict: **direct**
- Step 6 (lines 491-615): pure in-memory correlation of configured sources vs activity per hub. Flags HasUnknownSenders when a hub is active with zero configured sources (likely SDK/connection-string senders), notes inactive-but-configured hubs, and flags high volume relative to source count (>100k messages per configured source). Infers candidate consumers from non-$Default consumer group names and candidate senders from non-RootManageSharedAccessKey auth rules with Send rights, each tagged Confidence: Hint. Produces AnalysisNotes, InferredSenders, and a Statistics rollup (ActiveEventHubs, InactiveEventHubs, EventHubsWithUnknownSenders) plus console recommendations. Methodology documented in ENHANCED_DISCOVERY_EXPLAINED.md.
- In/Out: In: hub inventory, configured data sources, consumer groups, auth rules, metrics from prior steps. Out: per-hub HasUnknownSenders/AnalysisNotes/InferredSenders and subscription-level Statistics; recommendation text.
- Depends on: None beyond in-memory data from earlier phases; pure logic.
- Portability: Ports as-is to browser TypeScript - no I/O. This is the highest-value differentiator for a Cribl app: it tells users which hubs are worth onboarding as Cribl sources and where visibility gaps exist. Render as a findings/recommendations panel.

### EVH-09. JSON results export (timestamped + latest snapshot)

- Source: `Azure/dev/EventHubDiscovery/dev/Get-EventHubDataSources-Optimized.ps1` | Maturity: dev | Category: reporting | Verdict: **needs-redesign**
- Lines 657-672 (same pattern in legacy script lines 736-752): serializes the full discovery result object (DiscoveryDate, subscription/tenant, mode, OptimizationMethod, totals, Statistics, Namespaces tree with all per-hub detail) to eventhub-discovery-results/eventhub-sources-<yyyyMMdd-HHmmss>.json plus an always-overwritten eventhub-sources.json 'latest' copy. Timestamping and output directory are config-driven (export.includeTimestamp, export.exportDirectory).
- In/Out: In: in-memory discovery results, export settings from operation-parameters.json. Out: two JSON files under the environment's eventhub-discovery-results/ directory.
- Depends on: ConvertTo-Json -Depth 10, local filesystem writes.
- Portability: Filesystem becomes app KV store (latest snapshot + history keys, mind KV value-size limits for large estates) plus a browser Blob download for the file artifact. The result schema itself is portable JSON and should become the app's canonical discovery document.

### EVH-10. CSV export (hub inventory + data-source mapping)

- Source: `Azure/dev/EventHubDiscovery/dev/Get-EventHubDataSources.ps1` | Maturity: dev | Category: reporting | Verdict: **needs-redesign**
- Lines 754-800 (legacy script only): flattens results to eventhub-sources.csv (Namespace, ResourceGroup, Location, SKU, EventHub, PartitionCount, MessageRetentionDays, Status, ConsumerGroupCount, semicolon-joined ConsumerGroups, DataSourceCount) and a second eventhub-data-sources.csv mapping each source (EventHubNamespace, EventHub, SourceType, SourceName, ResourceType, ResourceGroup), each with timestamped and latest copies. Known gap: the default optimized script accepts -ExportToCsv but never writes CSV, so CSV only works via the legacy path.
- In/Out: In: discovery results, exportToCsv/includeTimestamp settings. Out: up to four CSV files in eventhub-discovery-results/ for Excel analysis and data-lineage documentation.
- Depends on: Export-Csv, local filesystem.
- Portability: Trivial in-browser CSV string generation and Blob download; also fixes the existing bug where the default path silently drops the CSV request. Flattening logic ports directly.

### EVH-11. Results re-export and validation utilities (ExportOnly / ValidateConfig)

- Source: `Azure/dev/EventHubDiscovery/Discover-EventHubSources.ps1` | Maturity: dev | Category: reporting | Verdict: **needs-redesign**
- ExportConfig mode invokes the core script with -ExportOnly to re-write export files from prior results without re-running discovery; ValidateConfig mode (lines 213-234) loads eventhub-discovery-results/eventhub-sources.json and prints a summary (generation date, subscription, namespace/hub/consumer-group totals) or an actionable 'run discovery first' error. Note: -ExportOnly in the core scripts re-serializes the in-memory (empty) results object rather than reloading the saved file, so ExportConfig effectively overwrites results with an empty document - a latent bug.
- In/Out: In: previously exported eventhub-sources.json. Out: console summary of stored results; re-written export files.
- Depends on: Local filesystem reads of prior exports.
- Portability: In the app this becomes: load last snapshot from KV, show summary card, re-download artifact in any format on demand - which naturally fixes the empty-re-export bug. Pure presentation plus KV reads.

### EVH-12. Automatic Azure PowerShell module installation

- Source: `Azure/dev/EventHubDiscovery/dev/Get-EventHubDataSources-Optimized.ps1` | Maturity: dev | Category: infra-tooling | Verdict: **not-portable**
- Install-RequiredModules (lines 34-137; parallel version in legacy script lines 34-118): on every run checks for Az.Accounts, Az.EventHub, Az.Monitor, Az.ResourceGraph (optional; falls back to standard API mode and records OptimizationMethod), Az.StreamAnalytics/Az.LogicApp/Az.Websites (optional) against minimum versions, and Install-Module's any that are missing at CurrentUser scope, distinguishing required (throw) from optional (warn and continue) failures.
- In/Out: In: installed module inventory. Out: installed/imported modules; useResourceGraph capability flag.
- Depends on: PowerShell Gallery network access, Install-Module/Import-Module, local module store.
- Portability: Host package management has no browser equivalent and is unnecessary: the app calls Azure REST APIs directly via the proxy, so SDK bootstrapping disappears. The one portable idea is the graceful capability fallback (record which discovery phases ran and why).

### EVH-13. Azure authentication bootstrap with auto-login and MFA re-auth retry

- Source: `Azure/dev/EventHubDiscovery/dev/Get-EventHubDataSources-Optimized.ps1` | Maturity: dev | Category: identity-auth | Verdict: **needs-redesign**
- Lines 146-201 (expanded version with troubleshooting guidance in legacy script lines 127-226): checks Get-AzContext, runs interactive Connect-AzAccount (tenant-scoped when tenantId is configured), sets subscription context, and on token-expiry/MFA errors (string-matched) disconnects, re-launches browser auth, and retries context setup before failing with guidance.
- In/Out: In: subscriptionId/tenantId from azure-parameters.json, cached Az context. Out: authenticated Az session pinned to the target subscription, or exit 1 with troubleshooting steps.
- Depends on: Az.Accounts interactive/device auth, browser popup, local token cache.
- Portability: Interactive Connect-AzAccount does not exist in a sandboxed iframe. Redesign as Entra app registration client-credentials flow against login.microsoftonline.com/{tenant}/oauth2/v2.0/token via proxies.yml, secrets in the app KV store, with token caching/refresh in app code - the same pattern the repo's DCR-Automation already uses for service principals. Error-driven re-auth becomes 401-triggered token refresh.

### EVH-14. Dev/prod environment profile switching (.dev-mode flag)

- Source: `Azure/dev/EventHubDiscovery/.dev-mode` | Maturity: dev | Category: infra-tooling | Verdict: **needs-redesign**
- Presence of the hidden .dev-mode flag file makes Discover-EventHubSources.ps1 (lines 27-28) resolve all config, core scripts, and output directories from dev/ instead of prod/, giving two isolated parameter sets and result stores (repo-wide dev/core pattern). Note dev/ and prod/ script copies have drifted (prod optimized still uses the non-indexed Resource Graph hub query; KQL string styles differ).
- In/Out: In: existence of flag file. Out: selection of dev/ vs prod/ config, script variant, and output directory.
- Depends on: Local filesystem flag file and duplicated script/config trees.
- Portability: The user value (multiple named environment profiles: subscription/tenant/filters) ports as a KV-backed profile selector in the app; the flag-file-plus-duplicated-scripts mechanism should not be replicated - one code path, many stored profiles.

### EVH-15. Resource Graph query test harness

- Source: `Azure/dev/EventHubDiscovery/test-resource-graph.ps1` | Maturity: experimental | Category: labs-testing | Verdict: **out-of-scope**
- Throwaway developer script that runs the microsoft.eventhub/namespaces/eventhubs Resource Graph query (take 5) against a hard-coded live subscription ID, prints sample results, and falls back to a raw-structure dump - evidently the experiment proving Resource Graph does not index Event Hub child resources (which led to the dev optimized script's Get-AzEventHub fix).
- In/Out: In: hard-coded subscriptionId. Out: console dump of query results or raw JSON structure.
- Depends on: Az.ResourceGraph, existing Az session.
- Portability: Dev-only diagnostic, not a product feature; do not port. Contains a real committed subscription ID that should be scrubbed. Its lesson (query hubs via ARM list, not Resource Graph) must carry into the app implementation.

### EVH-16. Documentation set with reusable KQL query library

- Source: `Azure/dev/EventHubDiscovery/OPTIMIZATION_GUIDE.md` | Maturity: docs-only | Category: documentation | Verdict: **direct**
- Five docs: README.md (architecture, config reference, modes, output schema), QUICK_START.md (3-step setup), DATA_SOURCE_DISCOVERY.md (what each source type detection means, explicit can/cannot-discover limits, result-interpretation playbook), ENHANCED_DISCOVERY_EXPLAINED.md (3-phase methodology, unknown-sender scenarios, when to enable diagnostics), OPTIMIZATION_GUIDE.md (performance benchmarks, ARM rate limits, pagination pattern, and standalone KQL queries incl. a corrected diagnostic-settings extract and a data-sources-per-hub summarize).
- In/Out: In: n/a. Out: user guidance; copy-pasteable KQL.
- Depends on: None.
- Portability: The KQL snippets and interpretation guidance transfer verbatim into the app (queries POST to the Resource Graph REST API; interpretation text becomes in-app help/tooltips and the recommendations panel copy). Rate-limit analysis directly informs how to stay under the platform's 100 req/min proxy budget.


## vNet Flow Log Discovery (VNF)

This subsystem automates onboarding Azure vNet Flow Logs into Cribl Stream: a PowerShell tool that scans an entire Azure tenant for storage accounts containing the insights-logs-flowlogflowevent container and generates per-account Cribl Azure Blob collector configs from a template, plus the companion "AzureFlowLogs" Cribl pack (event breaker, flow-tuple flattening pipeline, Redis dedup pipeline, scheduled collector job, samples, Search dashboard). Azure/vNetFlowLogs/vNetFlowLogDiscovery is the current, git-tracked canonical copy (publicly linked from the pack README); Azure/dev/vNetFlowLogDiscovery is a git-ignored byte-identical working mirror (live credentials in its params file, stale PackReadme backups), and Azure/dev/Azure_vNet_FlowLogs is the git-ignored pack source tree at v0.0.3 (marked Draft). The union of capabilities is small and highly portable: discovery is plain ARM enumeration (needs-proxy), config generation is pure templating that should become direct Cribl API creation, and the pack contents are static Cribl config artifacts.

Reader-noted gaps: 1) Despite the subsystem hint, there is NO discovery of flow-log-enabled NSGs/vNets via the Network Watcher flowLogs API anywhere in these paths - discovery is purely storage-account/container enumeration (checks for the insights-logs-flowlogflowevent container). If NSG/vNet-level discovery exists, it lives elsewhere or is aspirational. 2) The container-existence check uses the storage data plane via account-key context (Get-AzStorageContainer); an app port should switch to the ARM containers API, which changes required RBAC slightly - not validated here. 3) Azure/dev/vNetFlowLogDiscovery/azure-parameters.json contains real tenant/client GUIDs (git-ignored, but a hygiene risk if the dev tree is ever tracked). 4) The Redis dedup pipeline ships with a hardcoded lab Redis IP (10.198.32.64:6379) and password 'changeme'; and route.yml has the dedup route disabled:true while the README says the route assumes dedup by default - an inconsistency to resolve when porting. 5) The 490-line dashboard JSON and large base64 screenshots are embedded in the README rather than shipped as assets; I extracted capabilities from headings and samples but did not verify every query. 6) AzureFlowLogs.crbl (gzip) contents were not extracted; assumed to match the source tree at v0.0.3 ('Draft!'). 7) A related AzureFlowLogLab exists under Azure/dev/LabAutomation (outside this subsystem's assigned paths) and likely provides the test environment for this pack. 8) Empty Azure/dev/vNetFlowLogDiscovery/cribl-destinations/ output dir confirms generation runs locally; no committed examples of generated per-account configs exist to validate against.

### VNF-01. Tenant-wide vNet Flow Log storage account discovery

- Source: `Azure/vNetFlowLogs/vNetFlowLogDiscovery/Discover-vNetFlowLogs.ps1` | Maturity: production | Category: discovery | Verdict: **needs-proxy**
- Enumerates every subscription in the configured Azure tenant (Get-AzSubscription), lists all storage accounts per subscription (Get-AzStorageAccount), and checks each for the vNet flow log container 'insights-logs-flowlogflowevent' (Get-AzStorageContainer). Returns subscription ID/name, storage account name, resource group, location, and container name for each hit (function Find-vNetFlowLogStorageAccounts). Read-only; no Azure changes. Note: discovery is storage-container-based only; it does NOT query Network Watcher flowLogs resources or enumerate flow-log-enabled vNets/NSGs.
- In/Out: In: azure-parameters.json (tenantId, clientId) plus an authenticated Az session. Out: in-memory list of discovered storage accounts (subscription, RG, name, location, container) driving config generation and the summary report; console progress output.
- Depends on: PowerShell 5.1+, Az.Accounts, Az.Storage modules (Get-AzSubscription, Set-AzContext, Get-AzStorageAccount, Get-AzStorageContainer); Azure Reader role on subscriptions; local filesystem for config read.
- Portability: Pure API enumeration; port to fetch() against ARM (management.azure.com via proxies.yml): subscriptions list, storageAccounts list, and the ARM management-plane blobServices/default/containers API to replace the PowerShell data-plane container check. Large tenants could exceed the 100 req/min proxy limit with per-account container checks; a single Azure Resource Graph query (as the sibling EventHub discovery tool already does) would collapse this to one or two calls. Azure token acquisition goes through the login.microsoftonline.com proxy.

### VNF-02. Template-driven Cribl Azure Blob collector config generation (per storage account)

- Source: `Azure/vNetFlowLogs/vNetFlowLogDiscovery/CriblDestinationExample.json` | Maturity: production | Category: pipeline-generation | Verdict: **needs-redesign**
- For each discovered storage account, deep-clones the CriblDestinationExample.json template (a full Cribl scheduled collection job: azure_blob collector, clientSecret auth, hourly cron '15 * * * *', -75m/-15m lookback, time-token blob path 'flowLogResourceID=/${*}/${*}/${_time:y=%Y}/...', breaker ruleset and pre-processing pipeline references, Cribl textSecret references) and injects storageAccountName, containerName, tenantId, clientId while preserving secret names (function New-CriblDestination in Discover-vNetFlowLogs.ps1). Writes one ready-to-import JSON per account named Azure_vNet_FlowLogs_<StorageAccount>.json into cribl-destinations/. All customization (schedule, batch size, path, pipeline) is template-driven: edit the template once, every generated config inherits it.
- In/Out: In: CriblDestinationExample.json template + discovered storage account list + tenantId/clientId. Out: one Cribl collection-job JSON file per storage account (cribl-destinations/Azure_vNet_FlowLogs_<name>.json) for manual import into Cribl Stream.
- Depends on: Local filesystem (template read, output write); ConvertTo-Json/ConvertFrom-Json; downstream requires a Cribl secret (default 'Azure_vNet_Flowlogs_Secret') created manually in Stream and Storage Blob Data Reader RBAC on each account.
- Portability: The templating itself is trivial pure-TS (JSON clone + field injection = direct). The delivery mechanism must change: instead of writing files to disk for manual import, the app should POST the generated collection jobs straight to the Cribl REST API (jobs/sources endpoints, already covered by platform capability 1), with per-file download as a fallback. Template should live in the app KV store so users can still customize it.

### VNF-03. Discovery summary report export

- Source: `Azure/vNetFlowLogs/vNetFlowLogDiscovery/Discover-vNetFlowLogs.ps1` | Maturity: production | Category: reporting | Verdict: **needs-redesign**
- After generation, writes cribl-destinations/discovery-summary.json containing generation timestamp, tenant/client IDs used, discovered-account count, full storage account inventory (subscription, RG, location, container), and the list of generated Cribl destination IDs. Also prints a console summary of generated files and destinations.
- In/Out: In: discovery results + generated destination metadata. Out: discovery-summary.json (timestamp, tenant/client, accounts, destination IDs).
- Depends on: Local filesystem write; no external APIs.
- Portability: Pure data assembly (direct logic); persistence changes from a local JSON file to the app-scoped KV store (run history) plus an in-browser JSON/CSV download. Enables 're-run when new storage accounts appear' diffing, which the file-based version only supports by overwrite.

### VNF-04. Interactive menu and non-interactive runner

- Source: `Azure/vNetFlowLogs/vNetFlowLogDiscovery/Run-vNetFlowLogDiscovery.ps1` | Maturity: production | Category: infra-tooling | Verdict: **platform-provided**
- Console entry point wrapping the discovery engine: clears screen, shows current tenant/client config, single-option menu ([1] Discover and generate, [Q] Quit), pre-run confirmation prompt, 'press any key' pauses, and a -NonInteractive switch for CI/automation that validates config then executes directly.
- In/Out: In: keyboard menu choices or -NonInteractive flag. Out: invocation of Discover-vNetFlowLogs.ps1; console status.
- Depends on: PowerShell console (Read-Host, RawUI.ReadKey, Clear-Host); child script invocation.
- Portability: A React SPA replaces the console menu wholesale: a settings panel, a 'Run discovery' button with confirmation, and progress display. No logic worth porting beyond the flow itself (configure -> confirm -> run -> review).

### VNF-05. Configuration validation with placeholder detection

- Source: `Azure/vNetFlowLogs/vNetFlowLogDiscovery/Run-vNetFlowLogDiscovery.ps1` | Maturity: production | Category: infra-tooling | Verdict: **direct**
- Validates azure-parameters.json before any run (function Test-AzureParametersConfiguration): file existence, JSON parse, and per-field checks that tenantId/clientId are present and not known placeholder values ('<YOUR-TENANT-ID-HERE>', 'your-tenant-id', etc.). In interactive mode, loops with Wait-ForConfigurationUpdate until the user fixes the file; in non-interactive mode, exits 1 with actionable messages.
- In/Out: In: azure-parameters.json. Out: boolean pass/fail plus itemized missing/placeholder field messages.
- Depends on: Local filesystem read; ConvertFrom-Json.
- Portability: Ports directly as client-side form validation (required GUID fields, placeholder rejection) on a settings screen backed by the KV store. The blocking edit-file-and-retry loop disappears; inline validation replaces it.

### VNF-06. Azure session guard with guided re-authentication

- Source: `Azure/vNetFlowLogs/vNetFlowLogDiscovery/Discover-vNetFlowLogs.ps1` | Maturity: production | Category: identity-auth | Verdict: **needs-redesign**
- Before discovery, verifies the Az session (functions Ensure-AzureConnection / Request-AzureAuthentication): detects no active context, connection to the wrong tenant (compares context tenant to configured tenantId), and expired/invalid tokens (probe via Get-AzSubscription). Interactively offers to run Connect-AzAccount -TenantId <configured> (browser sign-in); in no-prompt mode emits the exact command to run manually.
- In/Out: In: required tenantId + current Az context. Out: verified session or authentication prompt/instructions; hard stop if declined.
- Depends on: Az.Accounts (Get-AzContext, Connect-AzAccount, Get-AzSubscription); interactive browser auth flow.
- Portability: The user value (right tenant, valid token, guided fix) ports, but the mechanism becomes OAuth2 client-credential or device-code token acquisition against login.microsoftonline.com via the platform proxy, with the secret in the app KV store and token-validity probes as lightweight ARM calls. Interactive browser Connect-AzAccount cannot run inside the sandboxed iframe.

### VNF-07. RBAC permission guidance and reminders

- Source: `Azure/vNetFlowLogs/vNetFlowLogDiscovery/Discover-vNetFlowLogs.ps1` | Maturity: production | Category: documentation | Verdict: **direct**
- After generation, prints a prominent checklist: assign 'Storage Blob Data Reader' to the App Registration on EACH discovered storage account, with step-by-step Azure Portal instructions (and the README adds az CLI / PowerShell equivalents), plus next steps (create the Cribl secret named in the template, import configs, test). Purely instructional; no role assignment is performed.
- In/Out: In: discovered account list + clientId + template secret name. Out: console guidance text keyed to actual discovered resources.
- Depends on: None beyond console output.
- Portability: Renders directly as a post-run checklist panel. Upgrade opportunity in-app: use ARM roleAssignments API (via proxy) to CHECK whether the role exists per account and flag gaps, or even create assignments if the operator's token permits - the PowerShell version only prints instructions.

### VNF-08. Azure vNet Flow Logs event breaker ruleset

- Source: `Azure/dev/Azure_vNet_FlowLogs/default/breakers.yml` | Maturity: dev | Category: pack-management | Verdict: **direct**
- Cribl event breaker ruleset 'Azure_vNet_FlowLogs': breaks the raw blob JSON as a json_array on the 'records' field (one event per record), jsonExtractAll, auto timestamping with wide earliest/latest tolerance (-420weeks/+1week), 512KB max event size. Ships in the AzureFlowLogs pack and is referenced by both the pack's collector job and the discovery tool's generated configs.
- In/Out: In: raw Azure flow log blob content (JSON with top-level 'records' array). Out: one Cribl event per flow log record.
- Depends on: Cribl Stream 4.14+ (pack minLogStreamVersion); no runtime dependency for the app beyond the Cribl API.
- Portability: Static Cribl config data. The app can install it via the Cribl REST API (breaker rulesets endpoint) or ship it inside a generated pack; no external calls needed.

### VNF-09. Flow log flattening pre-processing pipeline

- Source: `Azure/dev/Azure_vNet_FlowLogs/default/pipelines/Azure_vNet_FlowLogs_PreProcessing/conf.yml` | Maturity: dev | Category: pipeline-generation | Verdict: **direct**
- Pipeline 'Azure_vNet_FlowLogs_PreProcessing': triple unroll of the nested vNet flow log structure (flowRecords.flows -> flow.flowGroups -> flowGroup.flowTuples) producing one event per flow tuple; promotes aclID and rule to top level; serializes a curated field set (aclID, category, flowLogGUID, flowLogResourceID, flowLogVersion, flowTuple, host, macAddress, operationName, rule, targetResourceID, time) back into _raw JSON; final eval keeps only _raw to minimize event bloat.
- In/Out: In: broken flow log record events (nested flows/flowGroups/flowTuples). Out: one flattened, re-serialized JSON event per flow tuple in _raw.
- Depends on: Cribl Stream unroll/eval/serialize functions; upstream Azure_vNet_FlowLogs breaker.
- Portability: Static pipeline config executed by Stream workers, not the app. App installs it via Cribl API (pipelines endpoint) or bundles it in a pack. The YAML-to-API JSON translation is mechanical.

### VNF-10. Redis deduplication pipeline for overlapping collector schedules

- Source: `Azure/dev/Azure_vNet_FlowLogs/default/pipelines/Azure_vNet_FlowLogs_Dedup_Redis/conf.yml` | Maturity: dev | Category: pipeline-generation | Verdict: **direct**
- Pipeline 'Azure_vNet_FlowLogs_Dedup_Redis': computes sha256(_raw) as a Redis key (C.Mask.sha256), uses hsetnx to atomically test-and-set; first occurrence gets an expire TTL from a configurable Agg_Period_High (default 7200s, tuned to collector schedule), repeats are hincrby-counted and dropped before forwarding. Solves duplicate ingestion when collector schedules overlap (e.g. */15 cron with -20m lookback). Wired via the pack route 'AzureFlowLogs Dedup' in default/pipelines/route.yml (present but disabled:true by default, with a passthrough default route). Requires events already flattened by the PreProcessing pipeline.
- In/Out: In: flattened flow tuple events + a reachable Redis instance. Out: deduplicated event stream downstream; duplicate events dropped; Redis keys with counts and TTLs.
- Depends on: Cribl Redis function (standalone deployment), external Redis cache (on-prem or Azure Managed Redis), Cribl textSecret for Redis auth.
- Portability: Static pipeline + route config installable via Cribl API; dedup executes on Stream workers against the customer's Redis, so no app-side networking. Caveat: the shipped config hardcodes a lab Redis endpoint (redis://10.198.32.64:6379), password 'changeme', and a textSecret name - the app should parameterize Redis URL/auth and write the secret via the Cribl secrets API before install. Note the README/route.yml disagreement on whether dedup is on by default.

### VNF-11. Preconfigured scheduled Azure Blob collector job with time-token path optimization

- Source: `Azure/dev/Azure_vNet_FlowLogs/default/jobs.yml` | Maturity: dev | Category: pack-management | Verdict: **direct**
- Saved collection job 'Azure_vNet_FlowLogs_Hourly_v2' (shipped disabled): azure_blob collector with clientSecret auth against container insights-logs-flowlogflowevent, hourly cron '15 * * * *' with relative window -75m..-15m (matches Azure's up-to-15-min-late final hourly write), recurse+metadata on, and the key optimization of a time-tokenized path (flowLogResourceID=/${*}/${*}/${_time:y=%Y}/${_time:m=%m}/${_time:d=%d}/${_time:h=%H}) so Cribl reads only the current hour's blobs instead of the whole container. Wires in the Azure_vNet_FlowLogs breaker and PreProcessing pipeline. The discovery tool's CriblDestinationExample.json is this same design used as the generation template; count once. Pack README documents three tested schedule strategies (hourly no-dup, 15-min overlap with dups, 15-min overlap + Redis dedup).
- In/Out: In: storage account name, tenant/client IDs, Cribl secret name, optional schedule/lookback/path overrides. Out: a scheduled Cribl Azure Blob collection job feeding the pack's breaker and pipeline.
- Depends on: Cribl Stream azure_blob collector, Azure AD app registration with Storage Blob Data Reader on the storage account, Cribl textSecret.
- Portability: Static Cribl job config; app creates it via the Cribl API (collection jobs/sources) with user-supplied storageAccountName/tenantId/clientId and a secret written to Cribl secrets. The collector itself runs on Stream nodes, so blob access is not an app concern. Schedule/lookback/path should be exposed as app-side knobs (config-driven variations of this one capability).

### VNF-12. Sample vNet flow log datasets for pipeline testing

- Source: `Azure/dev/Azure_vNet_FlowLogs/data/samples` | Maturity: dev | Category: labs-testing | Verdict: **direct**
- Three captured sample files registered in default/samples.yml: Azure_vNet_Unbroken.log (raw 1.1MB blob content, 26 events), Azure_vNet_Broken_1.log (post-breaker single record), Azure_vNet_Pre-processed_1.log (post-pipeline flattened event). Enables testing the breaker and both pipelines in Cribl's preview UI without a live Azure connection.
- In/Out: In: none (static files). Out: sample events at each processing stage (raw, broken, pre-processed) for Cribl preview.
- Depends on: None; consumed by Cribl Stream sample/preview features.
- Portability: Static sample data; app can upload via the Cribl samples API (platform capability 1) or bundle in a generated pack. Useful in-app for a 'preview transformation' feature.

### VNF-13. Built AzureFlowLogs pack artifact and pack metadata

- Source: `Azure/dev/Azure_vNet_FlowLogs/AzureFlowLogs.crbl` | Maturity: dev | Category: pack-management | Verdict: **needs-redesign**
- Distributable Cribl pack (gzip .crbl, ~163KB) built from this source tree, plus package.json metadata: name AzureFlowLogs v0.0.3, displayName Azure_vNet_FlowLogs, minLogStreamVersion 4.14.0, author James Pederson, streamtags (Azure, FlowLogs, Redis, ThreatIntel) and useCase tags (routing, reduction, filtering, enrichment, aggregation). Release notes mark v0.0.3 (2025-09-08) as 'Draft!'.
- In/Out: In: pack source tree (default/, data/). Out: importable .crbl pack installing breaker, pipelines, route, job, and samples into a worker group.
- Depends on: Cribl pack format (gzip tarball with default/ layout); Cribl Stream 4.14+.
- Portability: The artifact itself is data, but the build/distribute flow changes: an app can assemble the pack contents in-browser (tar+gzip in TS) and install it via the Cribl packs API or offer a .crbl download - no local packaging scripts. Alternatively skip packaging entirely and create the knowledge objects directly via API.

### VNF-14. Cribl Search dashboard for duplicate/ingest monitoring

- Source: `Azure/dev/Azure_vNet_FlowLogs/README.md` | Maturity: dev | Category: reporting | Verdict: **direct**
- Complete Cribl Search dashboard JSON ('00_AzureFlowLogs') embedded in the pack README (lines ~140-624): time-range input, stat panels with color thresholds, and per-dataset charts comparing event counts and duplicate rates across the three collection strategies plus a direct Search-over-Azure-Blob dataset (Dataset 4). Queries use mv-expand over records and summarize by flowLogResourceID to visualize collector-schedule overlap and Redis dedup effectiveness.
- In/Out: In: Cribl Search datasets over collected flow logs (Lake or direct Azure Blob dataset). Out: dashboard visualizing event counts, duplicates, and dedup impact per collection strategy.
- Depends on: Cribl Search with datasets configured; dashboard JSON import.
- Portability: Pure config JSON; the app can create the dashboard via the Cribl Search API (covered by platform capability 1) after substituting the user's dataset names (currently hardcoded to lab datasets like 'AzureFlow_stjpederson'). Extraction from the README code fence into a standalone asset is needed.

### VNF-15. Pack documentation: setup guide, blob path optimization, Redis and dedup methodology

- Source: `Azure/dev/Azure_vNet_FlowLogs/README.md` | Maturity: docs-only | Category: documentation | Verdict: **direct**
- Extensive operator documentation (146KB, largely embedded screenshots): vNet-vs-NSG flow log scoping, prerequisites (Network Watcher export, auth choice, Redis), manual vs automated setup paths (links to the tracked discovery tool), detailed explanation of translating an Azure Portal blob path into a Cribl time-token collector path to cut read operations, Redis deployment options, quick-start steps, and the three-dataset schedule/dedup comparison methodology. The dev discovery folder's PackReadme.md is a staging copy of this file (plus .bak/_backup/_temp1 stale variants).
- In/Out: In: none. Out: operator guidance for configuring collection, path optimization, Redis dedup, and validation.
- Depends on: None.
- Portability: Content ports as in-app help panels and inline field hints (especially the path-token builder explanation, which is a strong candidate to become an interactive path-generator UI). Embedded base64 screenshots should be replaced with live app UI. No mechanism to port.


## Azure Log Collection (LOG)

Azure-LogCollection (v5.1.0) is a production-grade PowerShell automation suite (~13,200 lines across 1 orchestrator + 10 core scripts) that configures tenant-wide Azure log collection into Event Hubs for Cribl Stream ingestion: it deploys Event Hub namespaces (Centralized or Multi-Region), assigns Microsoft's built-in Audit diagnostic-settings initiative (69 resource types), imports and assigns a 44-policy Community initiative from GitHub, deploys Activity Log/Entra ID/Defender for Cloud export, and guides Defender XDR Streaming API setup with Graph-based license validation. Around the deployments it provides Resource Graph region inventory, policy-conflict and diagnostic-setting-collision detection, compliance gap analysis with JSON reports, bulk policy remediation, precise cleanup, and a Cribl Event Hub source-config generator with secret references. Nearly all functionality is ARM/Graph REST underneath and ports to the Cribl app via proxied fetch, but the file-based config/exports, interactive menu, and two full-tenant per-resource scans require redesign (KV store, wizard UI, Resource Graph queries, and direct Cribl API source/secret creation replacing JSON file handoff).

Reader-noted gaps: Referenced-but-missing files: README.md and CLAUDE.md both link ARCHITECTURE_SUMMARY.md, EVENT_HUB_BEHAVIOR.md, and docs/MCSB-AUDIT-LOGGING-ANALYSIS.md, none of which exist under Azure/Azure-LogCollection; resource-coverage.json declares "$schema": "./resource-coverage.schema.json" which also does not exist. Duplication risk: Deploy-SupplementalPolicies.ps1 and Deploy-CommunityPolicyInitiative.ps1 carry near-identical 44-entry community policy catalogs that can drift (Supplemental includes AKS/PostgreSQLFlexible, the initiative excludes them). Initiative-ID inconsistency worth verifying before port: Get-ConflictingPolicyAssignments uses AllLogs 85175a36-... while Analyze-ComplianceGaps.ps1 comments cite 0884adba-... (allLogs) and f5b29bc4-... (audit) for the same coverage lists. The gap-analysis coverage lists are hardcoded snapshots of Microsoft's auto-updating initiatives and will drift. Two operations (collision detection, Remove-DiagnosticSettings) do O(resources) per-resource REST scans that cannot survive the app proxy's 100 req/min limit without a Resource Graph redesign. Defender XDR streaming configuration itself has no API - any port keeps a manual Defender-portal step. I could not assess runtime-generated artifacts (core/logs/, core/reports/, core/region-inventory/ are empty or gitignored; core/cribl-configs/sources exists but content untracked). Adjacent overlapping subsystems live outside the assigned path and are not cataloged here: Azure/dev/EventHubDiscovery (Event Hub discovery), Azure/vNetFlowLogs + Azure/dev/vNetFlowLogDiscovery (the storage-only flow-log alternative this subsystem's notSupported section points to), and DCR-Automation (the VM guest log alternative).

### LOG-01. Interactive menu orchestrator with non-interactive CI modes

- Source: `Azure/Azure-LogCollection/Run-AzureLogCollection.ps1` | Maturity: production | Category: infra-tooling | Verdict: **needs-redesign**
- Main entry point (3,194 lines). Interactive menu ([1] Deploy All, [2] Configure Coverage, [I] Inventory, [G] Gap Analysis, [P] Remediate, [C] Generate Cribl Sources, [D] Defender XDR, [R] Remove Settings, [Q] Quit) plus -NonInteractive -Mode dispatch (DeployAll, Inventory, GapAnalysis, Remediate, RemoveDiagnosticSettings, DefenderXDR, DefenderXDRValidateOnly, GenerateCriblSources). Also bootstraps required PowerShell modules with auto-install (Initialize-RequiredModules), validates azure-parameters.json completeness, ensures Azure connection with tenant-match and token refresh (Ensure-AzureConnection), verifies management group exists, supports session-scoped namespace-name overrides (Select-NamespaceMode/Configure-NamespaceNames/Get-OverrideParameters), and .dev-mode dev/core environment switching.
- In/Out: In: core/azure-parameters.json, core/resource-coverage.json, user menu selections or -Mode flag. Out: orchestrated invocation of core/*.ps1 scripts, deployment log files under core/logs/.
- Depends on: Az.Accounts, Az.Resources, Az.EventHub, Az.ResourceGraph (optional), Microsoft.Graph.Authentication + Identity.DirectoryManagement (optional); local filesystem for config/logs; interactive console (Read-Host).
- Portability: The menu becomes SPA navigation/wizard; module installation and Connect-AzAccount are replaced by proxied Azure token auth (login.microsoftonline.com via proxies.yml, tokens in app KV). Mode dispatch maps naturally to app routes/actions. Session overrides become in-app form state. Confirmation prompts (Y/N, type DELETE) become UI dialogs.

### LOG-02. Deploy All Logging (coverage-driven one-click deployment)

- Source: `Azure/Azure-LogCollection/Run-AzureLogCollection.ps1` | Maturity: production | Category: infra-tooling | Verdict: **needs-redesign**
- Deploy-AllEnabledLogging (line 2686) reads resource-coverage.json and sequentially deploys every enabled component: Event Hub namespaces, built-in Audit initiative (69 resource types), Community Policy Initiative (44 types, selected tiers), Activity Log policy, Entra ID diagnostics (Standard/HighVolume profile), Defender for Cloud export, and Defender XDR setup, in Centralized or MultiRegion mode (MultiRegion requires prior inventory). resource-coverage.json is the single toggle file (enable/disable per source, deployment mode, community tiers, Entra profile, XDR export-tier metadata); Show-ResourceCoverageStatus renders the current enable/disable state; Open-ResourceCoverageConfig launches an editor.
- In/Out: In: core/resource-coverage.json (mode, per-source enabled flags, tiers, profiles), core/azure-parameters.json, inventory-latest.json for MultiRegion. Out: invokes all deploy scripts in order; Azure resources (namespaces, policy assignments, diagnostic settings, export automations); deployment log.
- Depends on: All core deploy scripts; Az modules; filesystem for config; Start-Process for editor launch (drop in app).
- Portability: Coverage config ports as an in-app settings page persisted in the app KV store (replacing the JSON file and the launch-VS-Code/Notepad editor step). The sequential deployment becomes a wizard with per-step progress and polling; each sub-step's ARM calls go through the Azure management proxy domain.

### LOG-03. Event Hub namespace deployment (Centralized/Multi-Region)

- Source: `Azure/Azure-LogCollection/core/Deploy-EventHubNamespaces.ps1` | Maturity: production | Category: infra-tooling | Verdict: **needs-redesign**
- Creates (or validates existing) Event Hub Namespaces to receive diagnostic logs. Centralized mode: one namespace {prefix}-{subId8}; MultiRegion: one per inventoried region {prefix}-{subId8}-{region}. Handles resource group creation, SKU/capacity from config, RootManageSharedAccessKey authorization rule (Manage permission required so Azure can auto-create per-category Event Hubs like insights-logs-auditevent), solution tagging, globally-unique naming via subscription-ID slug. Flags: -ValidateOnly, -ShowStatus, -RemoveNamespaces, -SpecificRegions, -UseExistingNamespaces plus namespace-name overrides.
- In/Out: In: azure-parameters.json (subscription, RG, prefix, SKU, capacity, centralizedRegion, useExistingNamespaces), region inventory for MultiRegion. Out: Event Hub namespaces + auth rules in Azure, deployment summary counts.
- Depends on: Az.EventHub, Az.Resources, Az.Accounts; azure-parameters.json on disk; Output-Helper.ps1.
- Portability: All operations are ARM CRUD (Microsoft.EventHub/namespaces, authorizationRules) portable to fetch() against management.azure.com via proxy. Naming logic and validation are pure TS. Namespace creation takes minutes, so needs async polling of the ARM operation. Status/remove/validate variants become UI actions on the same feature.

### LOG-04. Built-in diagnostic-settings policy initiative assignment

- Source: `Azure/Azure-LogCollection/core/Deploy-BuiltInPolicyInitiatives.ps1` | Maturity: production | Category: infra-tooling | Verdict: **needs-redesign**
- Assigns Microsoft's built-in Event Hub diagnostic-settings initiatives at management-group scope: Audit (1020d527-..., 69 resource types) or AllLogs (85175a36-..., 140 types). Centralized mode = one assignment for all regions; MultiRegion = per-region assignments with resourceSelectors (kind: resourceLocation). Creates a user-assigned managed identity per assignment and auto-assigns RBAC: Monitoring Contributor at MG scope and Azure Event Hubs Data Owner on the namespace (for listkeys during remediation). Flags: -LoggingMode, -DeploymentMode, -ValidateOnly, -ShowStatus, -RemoveAssignments, -Remediate, -SpecificRegions.
- In/Out: In: azure-parameters.json (managementGroupId, event hub settings, diagnosticSettingName), namespace deployment results/region inventory. Out: policy assignments named Cribl-DiagSettings-*, user-assigned managed identity, two role assignments; status display.
- Depends on: Az.Resources (New-AzPolicyAssignment, New-AzRoleAssignment), Az.ManagedServiceIdentity, Az.EventHub; requires Policy Contributor + User Access Administrator at MG.
- Portability: Ports to ARM REST: policyAssignments PUT with identity + resourceSelectors, Microsoft.ManagedIdentity userAssignedIdentities PUT, roleAssignments PUT. All via the Azure management proxy. Assignment naming (Cribl-DiagSettings-{mode}-{region}) and the initiative catalog are pure data. RBAC propagation delays need retry/polling in the app.

### LOG-05. Community Policy Initiative (44-policy custom initiative from GitHub)

- Source: `Azure/Azure-LogCollection/core/Deploy-CommunityPolicyInitiative.ps1` | Maturity: production | Category: infra-tooling | Verdict: **needs-redesign**
- Fetches 44 community policy definitions from raw.githubusercontent.com/Azure/Community-Policy (Monitoring/To Event Hub), imports them as custom policy definitions (Cribl-*-DiagSettings-EH), bundles them into a single policy set definition (Cribl-DiagSettings-EventHub), and assigns it at MG scope with user-assigned managed identity + RBAC. Covers Storage (Blob/File/Queue/Table/Accounts) plus Security, Data, Compute, Integration, Networking, AVD, Other tiers; AKS and PostgreSQLFlexible are deliberately excluded (incompatible resourceLocation Array type). Options: -PolicyTiers (8 tiers or All), -SpecificServices, -ValidateOnly, -ShowStatus, -Remediate, -RemoveInitiative (+ -RemovePolicyDefinitions), Centralized/MultiRegion.
- In/Out: In: GitHub raw policy JSON, azure-parameters.json, tier/service selection. Out: 44 custom policyDefinitions + 1 policySetDefinition + 1 assignment at MG scope, UAMI, role assignments.
- Depends on: Invoke-RestMethod to raw.githubusercontent.com; Az.Resources, Az.ManagedServiceIdentity, Az.EventHub; Output-Helper.ps1.
- Portability: Needs a second proxy domain (raw.githubusercontent.com) to fetch policy JSON, or vendor the 44 policy definitions into the app bundle (safer: pinned versions, no GitHub availability dependency). Policy definition import, initiative composition, and assignment are ARM REST PUTs. Tier/service catalogs (CommunityPolicyPaths/CommunityPolicyTiers) are pure data ideal for TS constants.

### LOG-06. Supplemental policies deployment (Activity Log + individual storage/community policies)

- Source: `Azure/Azure-LogCollection/core/Deploy-SupplementalPolicies.ps1` | Maturity: production | Category: infra-tooling | Verdict: **needs-redesign**
- Deploys individual policies that cannot live in resource-type initiatives, chiefly the built-in subscription-level Activity Log export policy (ARM operations, RBAC changes), plus legacy per-service community policy assignments (Storage Blob/File/Queue/Table, and the full tier catalog including AKS and PostgreSQLFlexible which the bundled initiative excludes). Flags: -ActivityLogOnly (the path DeployAll uses), -StorageOnly, -TableServicesOnly, -IncludeActivityLog, -PolicyTiers, -SpecificServices, -ValidateOnly, -ShowStatus, -RemoveAssignments, -Remediate. Creates UAMI + RBAC like the other policy scripts; embeds ARM deployment template schemas for policy parameters.
- In/Out: In: azure-parameters.json, policy tier/service selection, GitHub community policy definitions (api.github.com/raw). Out: policy assignments per subscription (Activity Log) and per service, UAMI, role assignments.
- Depends on: Az.Resources, Az.ManagedServiceIdentity; GitHub API/raw fetch; 2,536 lines with embedded policy metadata.
- Portability: Same ARM REST porting pattern as the other policy scripts. Note significant overlap with Deploy-CommunityPolicyInitiative.ps1 (duplicated CommunityPolicyPaths table); in the app, consolidate to one policy-catalog module and keep only Activity Log + the two excluded services as the supplemental path.

### LOG-07. Entra ID tenant diagnostic settings deployment

- Source: `Azure/Azure-LogCollection/core/Deploy-EntraIDDiagnostics.ps1` | Maturity: production | Category: identity-auth | Verdict: **needs-proxy**
- Configures the tenant-wide Entra ID (microsoft.aadiam) diagnostic setting to stream identity logs to the centralized Event Hub via ARM REST (PUT https://management.azure.com/providers/microsoft.aadiam/diagnosticSettings/{name}). Three category profiles: SecurityOnly (6 categories), Standard (9, default: AuditLogs, SignInLogs, ServicePrincipal/ManagedIdentity sign-ins, Provisioning, risk logs), HighVolume (15, adds NonInteractiveUserSignInLogs, ADFS, GSA traffic, EnrichedOffice365AuditLogs, MicrosoftGraphActivityLogs). Flags: -ValidateOnly, -RemoveSetting, -SecurityOnly, -IncludeHighVolume, custom -DiagnosticSettingName (default CriblEntraIDLogs).
- In/Out: In: azure-parameters.json (namespace/auth-rule resolution), profile selection. Out: one tenant-level diagnostic setting pointing at the Event Hub authorization rule; validate/remove operations.
- Depends on: management.azure.com (microsoft.aadiam provider, api-version 2017-04-01); Az.Accounts token; Event Hub namespace must exist.
- Portability: Already implemented as raw ARM REST calls (Invoke-AzRestMethod), so it ports nearly one-to-one to fetch() through the management.azure.com proxy with an injected bearer token. Category profile lists are pure TS data. Requires caller to hold Entra Security/Global Admin rights; surface that as a precondition check in the UI.

### LOG-08. Defender for Cloud continuous export deployment

- Source: `Azure/Azure-LogCollection/core/Deploy-DefenderExport.ps1` | Maturity: production | Category: infra-tooling | Verdict: **needs-proxy**
- Per subscription: detects which paid Defender plans are already enabled (Get-AzSecurityPricing across 12 plan types - Servers, App Service, SQL, Storage, Containers, Key Vault, ARM, DNS, APIs, etc.), then creates a Microsoft.Security/automations continuous-export resource (PUT via ARM REST, api-version 2019-01-01-preview) streaming Security Alerts to the Event Hub, optionally Recommendations, Secure Score, and Regulatory Compliance (-IncludeRecommendations/-IncludeSecureScore/-IncludeRegulatoryCompliance). Explicitly never enables paid plans. Flags: -ValidateOnly (plan status report), -RemoveExport, custom -ExportName (default CriblDefenderExport).
- In/Out: In: subscription list under MG, azure-parameters.json, export options. Out: Microsoft.Security/automations resource per subscription, enabled/disabled plan report.
- Depends on: Az.Security (Get-AzSecurityPricing) or Microsoft.Security/pricings REST; management.azure.com; Event Hub namespace + auth rule.
- Portability: Plan detection (Microsoft.Security/pricings GET) and automation creation (already raw Invoke-AzRestMethod PUT/GET/DELETE) map directly to proxied fetch(). Iterating many subscriptions is fine within rate limits (one or two calls per subscription). Good candidate for an early port.

### LOG-09. Defender XDR Streaming API guided setup with license validation

- Source: `Azure/Azure-LogCollection/core/Deploy-DefenderXDRStreaming.ps1` | Maturity: production | Category: infra-tooling | Verdict: **needs-redesign**
- Guided setup for XDR Streaming (MDE/MDI/MDO/MDCA/XDR alerts) since Microsoft exposes no configuration API. Steps: (1) validate tenant licenses per product via Microsoft Graph subscribedSkus against embedded SKU lists; (2) probe actual usage (MDE onboarded machines, MDI sensors via graph.microsoft.com/v1.0|beta/security/identities/sensors, recent incidents via security/incidents); (3) create a dedicated XDR Event Hub namespace (shared prefix in Centralized, cribl-xdr-{subId8} in MultiRegion); (4) print portal configuration walkthrough with the exact Resource ID and a tiered table-selection guide (T1 essential / T2 recommended / T3 high-volume with volume warnings per table); (5) export Cribl connection config to cribl-configs/xdr-streaming-config.json. Flags: -ValidateOnly, -SkipValidation, -CreateNamespaceOnly, -NamespaceNameOverride.
- In/Out: In: azure-parameters.json, resource-coverage.json (mode, exportTiers), Graph tenant data. Out: XDR Event Hub namespace, license/usage report per product, portal step-by-step text, cribl-configs/xdr-streaming-config.json (namespace, connection string, expected per-table Event Hubs, SASL source settings).
- Depends on: Microsoft.Graph SDK or Get-AzAccessToken fallback; graph.microsoft.com v1.0/beta; Az.EventHub; Defender licenses in tenant; manual Defender portal action to finish.
- Portability: Graph calls need a graph.microsoft.com proxy domain (Organization.Read.All, SecurityEvents.Read.All scopes). Namespace creation via ARM proxy. The portal walkthrough becomes a rich in-app checklist/wizard with copy buttons (the manual Defender-portal step is irreducible - no API exists). The Cribl config export should instead create the Event Hub source directly via the Cribl REST API. SKU catalogs, product/table metadata, and tier logic are pure TS data.

### LOG-10. Region inventory discovery (Resource Graph)

- Source: `Azure/Azure-LogCollection/Run-AzureLogCollection.ps1` | Maturity: production | Category: discovery | Verdict: **needs-proxy**
- Get-RegionInventory (line 1124) runs a Resource Graph KQL query (resources | where location != 'global' | summarize count() by location) scoped to the management group to discover which regions contain resources, with a slower Az.Resources recursive-subscription fallback when Az.ResourceGraph is absent. Results (regions + counts + conflict + collision data) are saved to core/region-inventory/inventory-{timestamp}.json and inventory-latest.json, which then drives Multi-Region namespace and policy deployments (inventory is a hard prerequisite for MultiRegion DeployAll).
- In/Out: In: managementGroupId. Out: region list with resource counts, TotalResources, saved inventory JSON consumed by MultiRegion deployments and the menu status display.
- Depends on: Az.ResourceGraph (Search-AzGraph) or Az.Resources fallback; Reader on MG; filesystem for inventory files.
- Portability: One POST to the Resource Graph REST API (providers/Microsoft.ResourceGraph/resources) through the management proxy replaces both paths - the slow per-subscription fallback can be dropped entirely. Persist inventory in the app KV store instead of timestamped files.

### LOG-11. Policy conflict detection

- Source: `Azure/Azure-LogCollection/Run-AzureLogCollection.ps1` | Maturity: production | Category: discovery | Verdict: **needs-proxy**
- Get-ConflictingPolicyAssignments (line 1371) scans policy assignments at MG scope for pre-existing assignments of the same built-in Event Hub initiatives this solution deploys (AllLogs 85175a36-2f12-419a-96b4-18d5b0096531, Audit 1020d527-2764-4230-92cc-7035e4fcf8a7), flagging overlapping-scope duplicates (first policy to create a diagnostic setting wins, so a second assignment silently does nothing). Distinguishes IsOurAssignment (Cribl-*) from foreign assignments; results embedded in the inventory file and surfaced as a red warning in the main menu.
- In/Out: In: managementGroupId. Out: conflict object (HasConflicts, TotalConflicts, per-initiative conflict lists with scope/owner) stored in inventory JSON and shown in menu.
- Depends on: Get-AzPolicyAssignment (ARM policyAssignments API); azure-parameters.json.
- Portability: GET policyAssignments at MG scope via ARM proxy plus pure comparison logic - direct TS port. Surface as pre-flight warnings in the deployment wizard.

### LOG-12. Diagnostic-setting collision detection

- Source: `Azure/Azure-LogCollection/Run-AzureLogCollection.ps1` | Maturity: production | Category: discovery | Verdict: **needs-redesign**
- Get-ExistingDiagnosticSettingsCollisions (line 1664) samples resources per subscription (default SampleSize 100, 0 = unlimited) checking each for an existing diagnostic setting with the solution's configured name (diagnosticSettingName, default setbycriblpolicy) and extracting the target Event Hub namespace. Identifies resources already configured by a prior deployment, resources the policy would skip, and third-party naming collisions. Summaries by resource type and namespace are stored in the inventory file.
- In/Out: In: managementGroupId, diagnosticSettingName, sample size. Out: collision list (resource, type, setting name, namespace) aggregated by type/namespace into inventory JSON.
- Depends on: Get-AzManagementGroup recursion, Set-AzContext per subscription, Get-AzResource, Get-AzDiagnosticSetting.
- Portability: The per-resource Get-AzDiagnosticSetting loop is O(resources) REST calls - incompatible with the 100 req/min proxy limit for real tenants. Redesign around a single Resource Graph query against the insightsresources table (diagnosticSettings) or accept sampled/paged scans with progress persistence in KV.

### LOG-13. Compliance gap analysis with JSON report export

- Source: `Azure/Azure-LogCollection/core/Analyze-ComplianceGaps.ps1` | Maturity: production | Category: reporting | Verdict: **needs-proxy**
- Inventories resource types under the MG and classifies each against embedded coverage lists: covered by allLogs/audit built-in initiatives (about 100 hardcoded resource types each), known gaps with supplemental policies available, potential gaps needing investigation, and infrastructure types with no diagnostic-settings support. Prints a summary with actionable recommendations and optionally exports a JSON report to core/reports/gap-analysis-{timestamp}.json (-ExportReport, custom -ReportPath, optional -ShowCompliance policy-state overlay).
- In/Out: In: managementGroupId (or from azure-parameters.json), resource type inventory. Out: console gap report (4 categories + recommendations) and JSON report file with Summary/CoveredByInitiatives/KnownGaps/PotentialGaps.
- Depends on: Az.ResourceGraph or Az.Resources; embedded resource-type coverage arrays; Output-Helper.ps1; core/reports/ directory.
- Portability: Classification lists and logic are pure data/TS. Resource inventory comes from one Resource Graph query via proxy. Report export becomes an in-browser JSON/CSV download or KV-persisted report history. Caveat: the embedded coverage lists will drift from Microsoft's auto-updating initiatives; consider fetching the live policySetDefinition to derive coverage instead.

### LOG-14. Policy remediation engine (bulk remediation tasks)

- Source: `Azure/Azure-LogCollection/Run-AzureLogCollection.ps1` | Maturity: production | Category: infra-tooling | Verdict: **needs-proxy**
- Start-AllPolicyRemediation (line 1892) discovers all Cribl-* policy assignments at MG scope, queries compliance via Get-AzPolicyStateSummary/Get-AzPolicyState (with Invoke-WithRetry for transient failures), expands initiatives into per-policy-definition non-compliance counts, then creates Start-AzPolicyRemediation tasks (ResourceDiscoveryMode ExistingNonCompliant, per policyDefinitionReferenceId for initiatives, auto-truncated 64-char names). Supports -PreviewOnly (show what would be remediated) and -Force (skip confirmation). Needed because DeployIfNotExists only fires automatically for NEW resources.
- In/Out: In: managementGroupId, discovered Cribl-* assignments. Out: N remediation tasks in Azure Policy, preview/summary of non-compliant resource counts per policy.
- Depends on: Az.PolicyInsights (Get-AzPolicyState*, Start-AzPolicyRemediation), Az.Resources; compliance data lags 15-30 min after assignment.
- Portability: PolicyInsights REST (policyStates summarize/query) and Microsoft.PolicyInsights/remediations PUT go through the ARM proxy; retry logic ports trivially. Remediation tasks are fire-and-forget in Azure, matching the app's polled long-operation model - add a remediation-status view polling the remediations API.

### LOG-15. Diagnostic settings cleanup (scan and remove)

- Source: `Azure/Azure-LogCollection/Run-AzureLogCollection.ps1` | Maturity: production | Category: infra-tooling | Verdict: **needs-redesign**
- Remove-DiagnosticSettings (line 2257) enumerates all subscriptions under the MG, scans every resource for diagnostic settings whose name equals the configured diagnosticSettingName (setbycriblpolicy), so only this solution's settings are matched (not setbypolicy etc.), shows a grouped preview by resource type and target namespace, requires typing DELETE to confirm (or -Force), then removes each setting. Notes that policy assignments remain and may recreate settings.
- In/Out: In: managementGroupId, diagnosticSettingName. Out: preview list, deletion of matching diagnostic settings across subscriptions, removed/failed summary.
- Depends on: Get-AzManagementGroup, Get-AzResource, Get-AzDiagnosticSetting, Remove-AzDiagnosticSetting; per-subscription context switching.
- Portability: Same O(resources) scan problem as collision detection - replace the discovery phase with a Resource Graph insightsresources query, then issue batched DELETE calls with progress persisted in KV and a resumable job UI. The type-DELETE confirmation becomes a destructive-action modal.

### LOG-16. Cribl Event Hub source configuration generator

- Source: `Azure/Azure-LogCollection/core/Generate-CriblEventHubSources.ps1` | Maturity: production | Category: pipeline-generation | Verdict: **needs-redesign**
- Discovers Event Hub namespaces matching the solution's configured prefixes (plus cribl-xdr in MultiRegion), enumerates the auto-created Event Hubs inside each (insights-logs-* etc.), and generates a complete Cribl Stream source config per Event Hub in native Kafka/eventhub format: brokers {ns}.servicebus.windows.net:9093, SASL PLAIN with username $ConnectionString, password via Cribl text-secret reference eh_{ns}_connectionString, TLS, consumer group, timeouts/backoff tuning. Exports individual per-source JSON, a combined all-event-hub-sources.json, and connection-strings.json with step-by-step instructions for creating the secrets in Cribl and where to find the Azure connection string. -NamespaceFilter wildcard supported.
- In/Out: In: azure-parameters.json (subscription/RG/prefix), deployed namespaces and their Event Hubs, optional filter. Out: core/cribl-configs/sources/individual/*.json, all-event-hub-sources.json, connection-strings.json (secret names, broker endpoints, connection-string format, manual instructions).
- Depends on: Az.EventHub (Get-AzEventHubNamespace/Get-AzEventHub); resource-coverage.json for mode; manual secret creation in Cribl Stream today.
- Portability: Highest-value port: in a Cribl app the JSON-file handoff disappears - discover Event Hubs via the ARM proxy, then create the sources and secrets directly through the Cribl product REST API (inputs + secrets endpoints in policies.yml), with optional JSON download as a fallback. The source-config template and ID sanitization are pure TS. Connection-string retrieval could even be automated via the ARM listKeys API into the app KV/Cribl secret.

### LOG-17. Shared output, logging, and retry helpers

- Source: `Azure/Azure-LogCollection/core/Output-Helper.ps1` | Maturity: production | Category: infra-tooling | Verdict: **platform-provided**
- Common utility library dot-sourced by every script: formatted console output (Write-Step/StepHeader/SubStep/Success/WarningMsg/ErrorMsg/Info), file logging (Initialize-PolicyLogging, Write-ToLog, Write-DebugLog, Get-LogFilePath, Complete-PolicyLogging), error collection and end-of-run summaries (Write-ErrorLog, Get-CollectedErrors, Write-ErrorSummary), and Invoke-WithRetry with configurable retries/backoff for transient Azure failures.
- In/Out: In: messages, script blocks. Out: colored console output, core/logs/*.log files, error summaries.
- Depends on: Local filesystem for logs; PowerShell console.
- Portability: Console formatting is replaced by app UI components; file logging by browser console/KV-persisted operation logs; Invoke-WithRetry is a 20-line TS utility. Nothing here needs a dedicated port beyond a small retry/error-aggregation helper module.

### LOG-18. Dev/core environment switching

- Source: `Azure/Azure-LogCollection/Run-AzureLogCollection.ps1` | Maturity: production | Category: infra-tooling | Verdict: **platform-provided**
- A hidden .dev-mode flag file (checked at line 35) switches all script and config resolution between core/ (production) and dev/ subdirectories, following the repo-wide dev/core pattern; core/dev-azure-parameters.json holds an alternate parameter set.
- In/Out: In: presence of .dev-mode file. Out: path resolution to dev/ vs core/ for scripts and JSON config.
- Depends on: Filesystem flag file; only core/ exists in the current tree (no dev/ directory).
- Portability: Maps to standard app environment/profile handling (e.g., named connection profiles in the KV store); no flag-file mechanism should be ported.

### LOG-19. Setup and operations documentation

- Source: `Azure/Azure-LogCollection/README.md` | Maturity: production | Category: documentation | Verdict: **direct**
- Substantial documentation set: README.md (749 lines - architecture of both deployment modes, coverage matrix, XDR table tiers with volume guidance, RBAC requirements, cost tables, troubleshooting, full version history v1-v5.1), QUICK_START.md (372 lines, scripted setup path), MANUAL_SETUP_GUIDE.md (755 lines, 9-phase pure-portal setup requiring no PowerShell at all - a standalone deliverable), and CLAUDE.md (developer guidance). Encodes domain knowledge like Event Hub auto-creation semantics, initiative IDs, and Entra ID volume profiles.
- In/Out: In: none. Out: user-facing setup/operations knowledge.
- Depends on: None; note README links to ARCHITECTURE_SUMMARY.md, EVENT_HUB_BEHAVIOR.md, and docs/MCSB-AUDIT-LOGGING-ANALYSIS.md which do not exist in the tree.
- Portability: Content ports directly as in-app help, wizard step copy, and tooltips. The tiered XDR table guidance, cost estimates, and RBAC prerequisite tables are especially valuable as embedded UI guidance. MANUAL_SETUP_GUIDE's portal walkthroughs back the guided steps for operations that have no API (XDR streaming).


## Cribl Pack Packaging (PKG)

A small, self-contained PowerShell utility (Azure/dev/Packs/Cribl_Pack_Packaging) that packages an existing Cribl pack directory into a .crbl archive: it tars the directory contents, gzips the tar with a .crbl extension, applies a {prefix}{packName}.crbl naming convention read from package.json, and optionally validates and cleans up. It offers an interactive menu plus a non-interactive CLI (Modes: Package, Validate, ViewConfig, SetSource, SetOutput), JSON-file configuration, and a dev/prod flag-file environment switch, but contains no manifest generation, no version bumping, no pack content generators, and no Cribl API upload (import into Stream is manual). Code is working and well documented but lives in the dev tree; dev and prod script copies are identical.

Reader-noted gaps: Despite the subsystem hints, several expected packaging capabilities do NOT exist here: (1) no manifest (package.json) generation or editing - a valid package.json must already exist; (2) no versioning automation - version is only displayed during validation, and 'automatic version incrementing' appears only under Future Enhancements in the README; (3) no pack content generators - pack contents (e.g., the Azure_Vnet_FlowLogs pack the prod config points at) are produced by other subsystems (vNetFlowLogDiscovery, DCR-Automation's Generate-CriblDestinations), not by this tool; (4) no Cribl API upload - .crbl import into Stream is a documented manual UI step ('Add Pack > Import from File'), also listed only as a future enhancement. Code-level notes: Package-CriblPack.ps1 contains an unused Compress-ToGzip function (dead code); the tar step ('tar -cf out *' via Invoke-Expression after cd into the source) will silently omit dotfiles at the pack root and, when outputDirectory equals sourceDirectory (as in the current prod config), writes the intermediate tar inside the directory being tarred; README wording is inconsistent with the code in places (describes 'double gzip'/'zip + gzip' while code does tar-then-gzip, and claims post-validation 'verifies extraction' when it only checks existence and non-zero size). Whether other pack-related tooling exists under different paths (e.g., pack content under Azure/dev/Azure_Vnet_FlowLogs or the SOC-OptimizationToolkit pack-builder) was outside the assigned path and not cataloged here.

### PKG-01. .crbl pack assembly (tar + gzip)

- Source: `Azure/dev/Packs/Cribl_Pack_Packaging/dev/Package-CriblPack.ps1` | Maturity: dev | Category: pack-management | Verdict: **needs-redesign**
- Assembles a Cribl pack directory into a Cribl-importable .crbl file in two steps: (1) tar the directory contents (Windows tar.exe, no extension), (2) gzip the tar via .NET GzipStream into {packPrefix}{packName}.crbl. Pack name is read from package.json 'name' field with fallback to the directory name. Config-driven variations: compression level (Optimal/Fastest/NoCompression), custom output directory (default: source parent, auto-created if missing), custom filename prefix, -KeepIntermediateFiles to retain the tar for debugging, -SkipValidation / validateAfterCompression toggle for the post-build check (file exists, non-zero size, size report). Identical copy at prod/Package-CriblPack.ps1.
- In/Out: In: local pack directory containing package.json; parameters (source/output dirs, packPrefix, compression settings) from CLI args or packaging-parameters.json. Out: a .crbl file (gzip-of-tar) written to disk, plus console progress/summary; intermediate extensionless tar file (removed unless retention requested).
- Depends on: PowerShell 5.1+, Windows-bundled tar.exe (Win10 1803+, invoked via Invoke-Expression with cwd change), .NET System.IO.Compression.GzipStream, local filesystem read/write. No Cribl or Azure APIs.
- Portability: Tar+gzip is pure byte manipulation and ports to browser TS with a JS tar writer + fflate/pako, operating on in-memory pack content; output becomes a browser download or a direct POST to the Cribl packs import REST endpoint (declared in policies.yml) instead of a disk file. Note substantial overlap with the platform: the Cribl leader already exports/imports .crbl packs via its REST API, so in-app this feature is mainly valuable for packaging content the app itself generates. Local-directory input must become file upload, KV-held generated content, or Cribl API pack config. Known source quirk to not replicate: 'tar -cf out *' skips dotfiles at the pack root.

### PKG-02. Pack directory validation

- Source: `Azure/dev/Packs/Cribl_Pack_Packaging/Run-PackageAutomation.ps1` | Maturity: dev | Category: pack-management | Verdict: **direct**
- Validates that a directory is a legitimate Cribl pack: directory exists, package.json is present, package.json parses as JSON, then reports the pack's name and version. Exposed as menu option [2], as -NonInteractive -Mode Validate, and run automatically as a pre-flight gate before packaging (function Test-CriblPack; Package-CriblPack.ps1 repeats the same existence/package.json checks).
- In/Out: In: path to a candidate pack directory. Out: boolean valid/invalid plus a message with pack name and version, or a specific failure reason (missing dir, missing package.json, malformed JSON).
- Depends on: Filesystem read of package.json; JSON parsing only. No external APIs.
- Portability: Pure manifest-validation logic; ports as-is to browser TS. Only the input source changes: validate an uploaded pack folder/archive, in-app generated pack model, or a pack manifest fetched from the Cribl packs REST API instead of a local path.

### PKG-03. Interactive menu and non-interactive CLI wrapper

- Source: `Azure/dev/Packs/Cribl_Pack_Packaging/Run-PackageAutomation.ps1` | Maturity: dev | Category: infra-tooling | Verdict: **platform-provided**
- Console UX front-end for the packager: interactive menu with options [1] Package, [2] Validate, [3] Set Source Directory, [4] Set Output Directory, [5] View Full Configuration, [Q] Quit, with current-config display and path truncation; plus a -NonInteractive switch with -Mode Package|Validate|ViewConfig|SetSource|SetOutput and -SourceDirectory/-OutputDirectory overrides for CI/CD use. Dispatches to the environment-specific Package-CriblPack.ps1.
- In/Out: In: keyboard menu selections or CLI parameters. Out: invocations of the packaging/validation functions, colored console output, updated config file.
- Depends on: PowerShell console (Read-Host, RawUI.ReadKey), local script invocation, packaging-parameters.json.
- Portability: The React SPA itself replaces this entire layer: forms, buttons, and status views supersede the console menu, and the non-interactive CI mode has no in-app equivalent (automation would use the Cribl API directly). Drop; carry over only the workflow steps it orchestrates.

### PKG-04. JSON configuration management (view and persist settings)

- Source: `Azure/dev/Packs/Cribl_Pack_Packaging/dev/packaging-parameters.json` | Maturity: dev | Category: infra-tooling | Verdict: **needs-redesign**
- Persists and manages packaging settings in packaging-parameters.json per environment: sourceDirectory, outputDirectory, packPrefix, preserveSourceDirectory (documented but never read by code), compressionLevel, validateAfterCompression, cleanupIntermediateFiles, plus inline _comments documentation. Run-PackageAutomation.ps1 provides Get-CurrentConfig / Update-Config (SetSource/SetOutput modes rewrite the file) and Show-Configuration (formatted display of all settings). Package-CriblPack.ps1 merges file settings with CLI parameter overrides (CLI wins).
- In/Out: In: user-entered paths/settings or CLI parameters. Out: updated packaging-parameters.json on disk; formatted configuration display.
- Depends on: Local filesystem read/write, ConvertFrom-Json/ConvertTo-Json.
- Portability: Trivially maps to the app-scoped KV store: settings object (prefix, compression, validation toggles) persisted per user/app instead of a JSON file; directory paths become irrelevant in-browser. The CLI-override-beats-file precedence logic ports directly as form-state-over-defaults.

### PKG-05. Dev/prod environment switching via .dev-mode flag file

- Source: `Azure/dev/Packs/Cribl_Pack_Packaging/Run-PackageAutomation.ps1` | Maturity: dev | Category: infra-tooling | Verdict: **out-of-scope**
- Selects between dev/ and prod/ subdirectories (each holding its own Package-CriblPack.ps1 and packaging-parameters.json) based on the presence of a .dev-mode flag file next to the launcher; absence means prod. Mirrors the repo-wide dev/core pattern. In practice the two script copies are byte-identical and only the parameter files differ (prod is hardcoded to a local Azure_Vnet_FlowLogs path); the .dev-mode file is not currently present despite the README saying it is.
- In/Out: In: existence of .dev-mode file. Out: choice of script path and config file used for all operations.
- Depends on: Local filesystem (Test-Path on flag file); duplicated script/config trees.
- Portability: Repo development-workflow infrastructure, not a product feature. If profile separation is ever wanted in-app, it is just multiple named settings profiles in the KV store; no flag-file mechanism should be ported.


## Windows Schema Sync (AI Drift Engine) (SYN)

Azure/dev/windows-schema-sync is a hybrid Python + PowerShell "autonomous schema drift engine" that (1) monitors Windows Security Event source schemas (Claude-extracted from Microsoft Learn docs and inferred from samples) and the Sentinel SecurityEvent destination schema (live KQL getschema), (2) detects both schema changes and data-level drift between SecurityEvent (AMA-populated) and SecurityEvent_CL (Cribl-populated) via KQL coverage/exact-value comparison, and (3) uses the Anthropic API to generate or patch a windows_to_sentinel Cribl pack, then commits the result via GitOps (git + gh PR) on a daily GitHub Actions cron, optionally deploying straight to Cribl via its REST API. A PowerShell menu layer (Run-SchemaSync.ps1 + 12 Core scripts) provisions the full supporting Azure estate: Sentinel/LAW, Key Vault, dual DCRs, the SecurityEvent_CL mirror table, AMA install scripts, and phased/autonomous EventID onboarding with validation gates. It is working dev-tree code (run logs from Dec 2025 exist) but the fully autonomous fix loop is broken by a missing-method bug, and several configured capabilities (notifications, WEF source, ASIM table) are unimplemented.

Reader-noted gaps: 1) Confirmed bug: src/autonomous_onboarding.py:288-289 calls CriblPackGenerator.get_source_schema()/get_destination_schema(), which are not defined anywhere, so the fully autonomous drift-fix path always fails silently (exception caught as fix failure) - the flagship 'autonomous' loop has likely never completed a real fix cycle. 2) Config-declared but unimplemented capabilities: Slack/email notifications, schema caching/TTL, per-task model selection, auto-merge, WEF server source, WindowsEvent/ASIM destination table, Splunk/Elasticsearch destinations (commented templates only). 3) sentinel_schema_monitor.fetch_from_azure_docs() is a stub returning None. 4) Cost tracker pricing table only covers Claude 3.x (Dec 2024) while the default model is claude-sonnet-4 - costs computed from fallback pricing. 5) The committed pack has lookups and destination configs but an empty default/pipelines dir; generated pipeline output was never committed, so end-to-end pack quality is unverifiable from the repo. 6) Committed artifacts leak a real subscription ID/resource group (generated/Install-AzureMonitorAgent.ps1, cribl/packs/.../destinations/*.json) - scrub before reuse. 7) Portability risk to flag for the app port: full-pack Claude generations (max_tokens 8192) may exceed the platform proxy's 30-second timeout, and the autonomous loop's 30-minute waits require a redesigned polling/state-machine model; per-event exact comparison issues one KQL query per sampled event (batchable). 8) Overlap to reconcile: Deploy-DCRs.ps1 here is a simplified two-table variant of the much larger Azure/CustomDeploymentTemplates/DCR-Automation engine (cataloged separately), and the Cribl pack conventions differ from the repo's pack-packaging tooling under Azure/dev/Packs. 9) I did not deep-read Menu-Framework.ps1 lines 260+, Output-Helper full body, or validation_logger lines 120-588; features there are cataloged from confirmed function signatures and call sites, not line-by-line review.

### SYN-01. Schema sync orchestrator CLI

- Source: `Azure/dev/windows-schema-sync/src/orchestrator.py` | Maturity: dev | Category: ai-automation | Verdict: **needs-redesign**
- Main workflow engine: --check runs source+destination monitors, decides full-regen vs incremental pack update (_needs_full_regen heuristics: new events, new dest fields, >2 modified events), invokes the generator, then optional git commit/PR; --drift-check runs drift detection with optional --auto-update pack correction and drift-fix PR; --force-regen forces regeneration; saves per-run audit JSON to runs/ and supports --output/--config.
- In/Out: In: config/sources.yaml, destinations.yaml, settings.yaml; env ANTHROPIC_API_KEY + Azure creds. Out: updated cribl/packs/windows_to_sentinel files, runs/run_<ts>.json audit records, git commits/PRs, results JSON.
- Depends on: Python asyncio, pyyaml, subprocess (git, gh CLI), the three monitors + CriblPackGenerator, local filesystem.
- Portability: The coordination/decision logic is pure and ports to TS directly; but it shells out to git/gh (subprocess) and persists run results to the filesystem. Re-implement as an in-app workflow: run history to KV store, GitOps step replaced by GitHub REST API via proxies.yml or by committing directly to Cribl config via the product API.

### SYN-02. AI schema extraction from Microsoft docs

- Source: `Azure/dev/windows-schema-sync/src/monitors/windows_schema_monitor.py` | Maturity: dev | Category: ai-automation | Verdict: **needs-proxy**
- fetch_microsoft_docs_schema() fetches learn.microsoft.com auditing pages per configured EventID (URL pattern event-{id}), truncates HTML to 30k chars, and _extract_schema_with_ai() prompts Claude (default claude-sonnet-4, ANTHROPIC_MODEL overridable) to emit structured JSON schema (name, category, event_data_fields with types/descriptions); falls back to the built-in baseline on failure; 0.5s rate limiting between events.
- In/Out: In: EventID list from sources.yaml, Microsoft Learn HTML. Out: per-EventID structured schema dicts merged into the current source schema.
- Depends on: httpx, anthropic SDK, ANTHROPIC_API_KEY.
- Portability: Pure fetch + LLM call: declare learn.microsoft.com and api.anthropic.com in proxies.yml, Anthropic key from KV store. Watch the 30s proxy timeout on Claude calls (max_tokens 4096 usually fine). JSON-cleanup/markdown-stripping logic ports as-is.

### SYN-03. AI schema inference from sample events

- Source: `Azure/dev/windows-schema-sync/src/monitors/windows_schema_monitor.py` | Maturity: dev | Category: ai-automation | Verdict: **needs-redesign**
- infer_schema_from_samples() reads up to 100 sample event JSON files from a configured directory, groups by EventID, and prompts Claude with 5 representative samples to infer field names, semantic types (hex_string, sid, guid, datetime, int), optionality, and sample values; merged into the doc-derived schema. Disabled by default in sources.yaml (event_samples enabled: false).
- In/Out: In: directory of sample Windows event JSON files. Out: inferred per-EventID schemas with sample_values and system_fields_observed.
- Depends on: anthropic SDK, local filesystem glob (to be replaced by Cribl captures/samples API).
- Portability: The inference prompt/logic ports, but the sample source is a local directory. In the app, source samples from Cribl sample files/captures via the product REST API instead - a natural improvement since the app can capture live Windows events from Stream.

### SYN-04. Windows source schema baseline and change detection

- Source: `Azure/dev/windows-schema-sync/src/monitors/windows_schema_monitor.py` | Maturity: dev | Category: ai-automation | Verdict: **direct**
- Hardcoded baseline catalog SECURITY_EVENT_SCHEMAS for 10 EventIDs (4624/4625/4648/4672/4688/4689/4720/4768/4769/4776, full field lists) plus 15 SYSTEM_FIELDS; check_for_changes() merges baseline+docs+samples, diffs against schemas/source/windows_security/current.json (added/removed events, added/removed fields per event), archives prior versions to history/, and export_baseline_schemas() writes baseline.json. _merge_schemas() tags newly discovered fields with source:discovered.
- In/Out: In: previous stored schema + freshly assembled schema. Out: changes dict (added_events/removed_events/modified_events), updated current schema, timestamped history archive.
- Depends on: None beyond persistence (filesystem today, KV store in app).
- Portability: Baseline catalog and diff/merge logic are pure data + logic, portable to TS as-is. Replace current.json/history file persistence with the app KV store (keyed snapshots with timestamps).

### SYN-05. Sentinel destination schema monitor

- Source: `Azure/dev/windows-schema-sync/src/monitors/sentinel_schema_monitor.py` | Maturity: dev | Category: ai-automation | Verdict: **needs-proxy**
- Tracks the Sentinel SecurityEvent table schema: 60+ field hardcoded baseline; live fetch via 'SecurityEvent | getschema' using azure-monitor-query (ARM resource endpoint preferred over legacy api.loganalytics.io workspace endpoint); fallback fetch of Azure/Azure-Sentinel GitHub repo Schema/Tables/SecurityEvent.json; LA-to-common type mapping (_map_la_type); change detection for added/removed fields and type changes; versioned history archive; fetch_from_azure_docs() is an unimplemented stub returning None.
- In/Out: In: workspace ID or subscription/RG/workspace-name (ARM), Azure SP creds. Out: current schema with source attribution (log_analytics_api/github/baseline), change dict (added_fields/removed_fields/type_changes), history archive.
- Depends on: azure-identity, azure-monitor-query (optional imports), httpx; Azure SP with Log Analytics Reader.
- Portability: Replace the Azure SDK with raw REST already proven elsewhere in this subsystem: token from login.microsoftonline.com, query via management.azure.com/{workspaceResourceId}/query. Declare management.azure.com, login.microsoftonline.com, raw.githubusercontent.com in proxies.yml. Diff logic and baseline are direct. Note docs-scrape source is a placeholder.

### SYN-06. Table-level drift detection (coverage and volume)

- Source: `Azure/dev/windows-schema-sync/src/monitors/drift_monitor.py` | Maturity: dev | Category: reporting | Verdict: **needs-proxy**
- compare_tables()/get_field_coverage() run KQL summarize countif() queries over ~12 key fields against SecurityEvent and SecurityEvent_CL within a configurable comparison window (default 60m), compute per-field non-null coverage percentages, flag missing fields, coverage gaps beyond null_threshold (default 10%), and >20% row-volume differences; emits a drift report JSON with recommendations to runs/drift/.
- In/Out: In: workspace identity, comparison_window/min_sample_size/null_threshold config. Out: drift report (drift_detected, missing_fields, coverage_differences, volume_difference, recommendations).
- Depends on: Azure Log Analytics query API (ARM or legacy), Azure SP credentials.
- Portability: KQL query building and comparison math are pure logic; execute queries via management.azure.com ARM query endpoint through the proxy. Reports to KV store and/or downloadable JSON. Window/thresholds already config-driven, map to app settings.

### SYN-07. Per-EventID drift check

- Source: `Azure/dev/windows-schema-sync/src/monitors/drift_monitor.py` | Maturity: dev | Category: reporting | Verdict: **needs-proxy**
- check_drift_for_event_id() builds dynamic per-field coverage KQL (countif(isnotnull..)*100/count() across 19 fields) filtered to a single EventID on both tables, enforces min_sample_size, detects completely-missing fields (custom<1% while native>10%) and significant coverage gaps, generates actionable field-mapping recommendations, and optionally chains exact-value comparison; results feed the validation logger.
- In/Out: In: EventID, comparison window, thresholds. Out: per-EventID report with native_stats/custom_stats, missing_fields, coverage_differences, recommendations, optional exact_comparison block.
- Depends on: Azure Log Analytics query API, validation logger (optional).
- Portability: Same as table-level drift: pure logic over two KQL results. Directly reusable as the drill-down view in an app UI (per-EventID scorecard).

### SYN-08. Exact event-level comparison and validation gate

- Source: `Azure/dev/windows-schema-sync/src/monitors/drift_monitor.py` | Maturity: dev | Category: reporting | Verdict: **needs-proxy**
- compare_exact_events() samples N recent native events for an EventID, matches each in SecurityEvent_CL via composite key (TimeGenerated to ms +/- 5s window, Computer, EventRecordId), compares ~32 fields value-by-value with null/empty normalization, aggregates mismatch frequency per field, and computes exact/partial/missing match rates; validate_event_exact_match() gates on a required match rate (default 95%) for onboarding sign-off.
- In/Out: In: EventID, sample_size, required_match_rate. Out: match statistics (exact/partial/missing rates), per-field mismatch table with sample native vs custom values, pass/fail validation verdict.
- Depends on: Azure Log Analytics query API; validation logger for audit.
- Portability: Highest-value differentiator of the subsystem; comparison logic is pure TS-portable. Issues one KQL query per sampled event (default 10-20) - fits the 100 req/min proxy limit but batch the custom-table lookups into a single joined KQL query for efficiency.

### SYN-09. ARM direct KQL query client

- Source: `Azure/dev/windows-schema-sync/src/monitors/drift_monitor.py` | Maturity: dev | Category: infra-tooling | Verdict: **needs-proxy**
- _execute_arm_query() implements Log Analytics querying without the Azure SDK: client-credentials token from login.microsoftonline.com/{tenant}/oauth2/v2.0/token (scope management.azure.com/.default), POST to management.azure.com{workspaceResourceId}/query?api-version=2017-10-01, plus ArmQueryResponse/ArmQueryTable wrapper classes normalizing the REST JSON to the SDK result shape. Chosen explicitly because it works in Private Link environments where api.loganalytics.io does not. A PowerShell twin exists in Core/Sync-SchemaFromAzure.ps1 (Get-AzureAccessToken/Invoke-ArmLogAnalyticsQuery).
- In/Out: In: tenant/client/secret, workspace ARM resource ID, KQL string, timespan. Out: tables/columns/rows result object.
- Depends on: httpx only; login.microsoftonline.com and management.azure.com endpoints.
- Portability: This is the ideal transport for the app: already pure REST with no SDK. Port to a shared TS KQL client; token acquisition via the proxy with the client secret injected from the app KV store.

### SYN-10. Validation audit logger

- Source: `Azure/dev/windows-schema-sync/src/monitors/validation_logger.py` | Maturity: dev | Category: reporting | Verdict: **needs-redesign**
- SchemaValidationLogger persists every drift query, comparison, and validation verdict: schema_validation.json (full history + overall_stats with accuracy rate, per-EventID pass/fail), schema_validation.csv summary, validation_summary.md, and event_samples/ raw query captures; exposes get_overall_accuracy(), get_failing_event_ids(), get_field_mismatch_summary(), and export_for_claude() which formats validation data as LLM context for fix generation.
- In/Out: In: query executions, comparison results, validation verdicts from DriftMonitor. Out: cumulative accuracy statistics, failing-EventID list, field mismatch aggregates, Claude-ready context strings, CSV/MD artifacts.
- Depends on: Filesystem (to be replaced by KV), csv/json stdlib, optional CostTracker.
- Portability: Value ports (accuracy tracking over time is the trust layer for autonomous fixes) but storage is filesystem JSON/CSV/MD. Re-home to KV store with a size cap; CSV/markdown become on-demand in-browser exports/downloads. export_for_claude() is pure string formatting - direct.

### SYN-11. Claude API cost tracker

- Source: `Azure/dev/windows-schema-sync/src/utils/cost_tracker.py` | Maturity: dev | Category: reporting | Verdict: **direct**
- CostTracker records every Anthropic call (record_from_response) with token counts, computes USD cost from an embedded per-model pricing table, aggregates by model/EventID/operation (pack_generation, drift_fix, pack_update)/iteration, writes runs/costs/api_costs.json + cost_summary.md, and estimates remaining cost for outstanding EventIDs (estimate_remaining_cost).
- In/Out: In: Anthropic API responses (usage.input_tokens/output_tokens), model id, operation context. Out: cumulative cost stats, per-EventID/operation breakdowns, cost projections, JSON/markdown logs.
- Depends on: None external; embedded pricing constants.
- Portability: Pure accounting logic, ports to TS directly with KV persistence. Pricing table is stale (only Claude 3.x entries dated Dec 2024 while the default model is claude-sonnet-4, so it silently falls back to default pricing) - refresh model/pricing data during port.

### SYN-12. AI Cribl pack generation (full and incremental)

- Source: `Azure/dev/windows-schema-sync/src/generators/cribl_generator.py` | Maturity: dev | Category: pipeline-generation | Verdict: **needs-proxy**
- generate_pack() prompts Claude with simplified source+destination schemas (and optional change highlights) to emit a JSON map of pack files: pipeline conf.yml with eval/lookup functions, groups.yml, logon_types.csv, event_categories.csv, README; writes them under cribl/packs/windows_to_sentinel and creates pack.json manifest with date-based version and SHA256 schema hashes. update_pack_for_changes() does incremental updates: feeds the existing pipeline YAML + change diff to Claude, backs up the old conf to backups/, bumps manifest version, and records changes_applied; falls back to full regeneration on API failure.
- In/Out: In: source schema, destination schema, optional changes dict, existing pipeline YAML. Out: pack file map (pipelines, lookups, README), pack.json manifest with schema hashes, backups.
- Depends on: anthropic SDK, pyyaml, CostTracker, filesystem (to be replaced).
- Portability: Prompts and response-parsing logic port directly; Anthropic via proxy (max_tokens 8192 full-pack generations risk exceeding the 30s proxy timeout - consider streaming or splitting per-file generations). Replace filesystem writes with in-memory file map pushed to Cribl via the packs REST API or bundled as a downloadable .crbl/tgz; backups become KV-stored prior versions.

### SYN-13. Drift-based pack correction with AMA enrichment intelligence

- Source: `Azure/dev/windows-schema-sync/src/generators/cribl_generator.py` | Maturity: dev | Category: ai-automation | Verdict: **needs-proxy**
- update_pack_for_drift() fixes detected drift: _categorize_missing_fields() classifies each missing field as raw EventData (direct extraction), AMA-enriched computed (Activity, AccountType, LogonTypeName, Account, IpAddressType...with recreation recipes), lookup-based, system, or unknown; builds a domain-rich prompt teaching Claude which Sentinel fields are proprietary AMA enrichments and how to recreate them; on AI failure _generate_drift_fixes_from_templates() deterministically injects lookup functions (activity/logon-type/failure-status) and eval mappings into the existing pipeline YAML, cleans temp fields, and _generate_enrichment_readme() documents recreated vs unreproducible enrichments; writes drift_corrections/correction_<ts>.json reports and updates the manifest with drift_correction metadata.
- In/Out: In: drift report (missing_fields, coverage_differences), source/destination schemas, existing pipeline YAML. Out: updated pipeline + lookup CSVs + README, correction report, manifest drift_correction record, pre-change backup.
- Depends on: anthropic SDK (AI path only), pyyaml, CostTracker.
- Portability: The AMA-enrichment knowledge base and categorization plus the deterministic template fixer are pure logic - the most valuable IP here and fully portable to TS with zero AI dependency for the fallback path. AI path via Anthropic proxy. Output to Cribl packs API instead of files.

### SYN-14. Deterministic template pack generator (AI fallback)

- Source: `Azure/dev/windows-schema-sync/src/generators/cribl_generator.py` | Maturity: dev | Category: pipeline-generation | Verdict: **direct**
- _generate_from_templates() builds a complete working pack without any AI call: pipeline conf with ~40 field mappings (TimeGenerated, system fields, EventData flattening, computed Account/SubjectAccount), LogonType lookup function, Activity eval, groups.yml, a 12-row logon_types.csv, a 25-row event_categories.csv, and a documented README - used whenever Claude output fails JSON parsing.
- In/Out: In: source/destination schemas (used lightly). Out: five-file pack map ready to write/upload.
- Depends on: pyyaml only.
- Portability: Pure string/object templating, ports to TS verbatim. Good candidate for the app's zero-API-key baseline mode.

### SYN-15. Cribl API deployment client

- Source: `Azure/dev/windows-schema-sync/src/autonomous_onboarding.py` | Maturity: dev | Category: pack-management | Verdict: **platform-provided**
- CriblAPIClient authenticates against /api/v1/auth/login (username/password style with client id/secret), then deploy_pack() upserts a pack into a worker group (GET pack, PATCH files or POST new), commits (/api/v1/m/{group}/version/commit) and deploys (/api/v1/m/{group}/version/deploy) - the closed-loop 'apply the AI fix to production' step; token cached with 1h expiry.
- In/Out: In: CRIBL_URL/CRIBL_CLIENT_ID/CRIBL_CLIENT_SECRET, worker group, pack directory files. Out: deployed pack with commit+deploy status.
- Depends on: httpx; Cribl Stream leader REST API (packs, version/commit, version/deploy).
- Portability: In a Cribl App Platform app, authenticated access to packs/commit/deploy endpoints is exactly what policies.yml-scoped fetch() provides - drop the custom auth/token handling entirely and keep only the thin upsert-commit-deploy sequence as app logic against the product API.

### SYN-16. Autonomous EventID onboarding loop

- Source: `Azure/dev/windows-schema-sync/src/autonomous_onboarding.py` | Maturity: experimental | Category: ai-automation | Verdict: **needs-redesign**
- AutonomousOnboarder iterates phased EventIDs (from operation-parameters.json eventIdPhases): per EventID it checks drift (optionally exact-value), on drift generates an AI pack fix, deploys via the Cribl API, sleeps waitBetweenRetriesMinutes (default 30) for data to flow, and re-validates up to maxRetriesPerEventId (3); persists resumable state (completed/failed/iteration_history) in Core/autonomous_state.json; CLI: --start, --status, --event-id N, --max-iterations, --reset.
- In/Out: In: eventIdPhases + validationCriteria + autonomous config (maxRetriesPerEventId, waitBetweenRetriesMinutes, useExactValueComparison, requiredExactMatchRate 95%). Out: per-EventID validated/failed verdicts, persistent onboarding state, iteration history, status report.
- Depends on: DriftMonitor, CriblPackGenerator (broken linkage), CriblAPIClient, asyncio sleeps, state file.
- Portability: Confirmed bug: fix_drift_for_event_id() calls self.pack_generator.get_source_schema()/get_destination_schema() which are defined nowhere, so the autonomous fix path always throws (swallowed as fix failure) - the loop never actually self-heals as written. The 30-minute sleeps make it a long-running daemon; in-app redesign as a resumable state machine in KV whose 'wait' phases are advanced by polling on UI revisit or interval timers, with fixed schema accessors (use the monitors' get_baseline_schema).

### SYN-17. GitOps commit and PR automation

- Source: `Azure/dev/windows-schema-sync/src/orchestrator.py` | Maturity: dev | Category: ai-automation | Verdict: **needs-redesign**
- _git_commit() stages cribl/ and schemas/ and commits with a structured change-summary message; _create_pr() and _create_drift_pr() create timestamped branches (schema-update-*/drift-fix-*), push, and open PRs via gh CLI with rich bodies: change JSON, missing-field/coverage tables, recommendations, and human review checklists - enforcing human-in-the-loop review of AI-generated pack changes. Gated by settings.yaml automation.auto_commit/auto_pr.
- In/Out: In: changes/drift report dicts, modified pack+schema files. Out: git commit, pushed branch, PR URL with review checklist.
- Depends on: git and gh CLI subprocesses, GitHub remote, repo write access.
- Portability: Requires a local working tree + git/gh binaries: not portable as implemented. The user value (reviewable audit trail before applying AI changes) redesigns two ways: GitHub REST API (api.github.com via proxy, contents+pulls endpoints) for repo-based review, or better, lean on Cribl's native config versioning - stage changes as an uncommitted Cribl commit for in-product review before deploy.

### SYN-18. Scheduled GitHub Actions automation workflow

- Source: `Azure/dev/windows-schema-sync/.github/workflows/schema_sync.yaml` | Maturity: dev | Category: infra-tooling | Verdict: **not-portable**
- Three-job daily (cron 0 2 * * *) + manual-dispatch pipeline: get-secrets pulls ANTHROPIC-API-KEY/AZURE-CLIENT-SECRET/SENTINEL-WORKSPACE-ID from Azure Key Vault (OIDC azure/login) with GitHub Secrets fallback; schema-sync runs orchestrator --check and opens a PR via peter-evans/create-pull-request; drift-check runs --drift-check --auto-update and opens drift-correction PRs; dispatch inputs select mode (full/schema-only/drift-only), force_regen, auto_update, key_vault_name; uploads run artifacts (30-day retention) and writes step summaries.
- In/Out: In: cron trigger or dispatch inputs, Key Vault/GitHub secrets. Out: schema-update and drift-correction PRs, workflow artifacts, step summaries.
- Depends on: GitHub Actions, azure/login OIDC, az CLI, Python 3.11, jq, peter-evans/create-pull-request.
- Portability: CI daemon infrastructure with cron scheduling - fundamentally outside a sandboxed SPA. The scheduling need must be met differently: user-triggered runs, polling on app open, or Cribl-side scheduled jobs; secrets move from Key Vault/GitHub Secrets to the app KV store. Catalog the mode/force/auto-update dispatch options as app run options.

### SYN-19. Interactive menu and non-interactive CLI entry point

- Source: `Azure/dev/windows-schema-sync/Run-SchemaSync.ps1` | Maturity: dev | Category: infra-tooling | Verdict: **needs-redesign**
- Main PowerShell entry with a 13-option interactive menu (Menu-Framework.ps1): [1] Quick Setup (KeyVault+Sentinel+AMA+Table+DCRs), [2] GitHub Workflow, [3] Sentinel, [4] AMA, [5] Custom Table, [6] DCRs, [7] Drift Check, [8] Schema Sync (invokes Python orchestrator), [9] Key Vault, [I] Incremental Onboarding, [S] Sync Schema from Azure, [C] Configure (edit JSON), [V] View Resource Names; config summary display, validation gates, deployment confirmations with component/time estimates, and -NonInteractive -Mode <X> for all modes; interactive Key Vault secret-update wait/verify loop.
- In/Out: In: Core/azure-parameters.json + operation-parameters.json, user selections. Out: dispatched deployment/check operations with per-component result summaries; logs/SchemaSync_<ts>.log.
- Depends on: PowerShell 5.1+, Core/Menu-Framework.ps1, Output-Helper.ps1, Naming-Engine.ps1, Az modules, Python for options 7/8.
- Portability: Console menu becomes the app's React navigation/wizard: same feature taxonomy maps 1:1 to app pages (setup wizard, drift dashboard, schema sync, onboarding). Config-file editing becomes settings UI backed by KV.

### SYN-20. Sentinel and Log Analytics deployment

- Source: `Azure/dev/windows-schema-sync/Core/Deploy-Sentinel.ps1` | Maturity: dev | Category: dcr-deployment | Verdict: **needs-redesign**
- Creates the resource group and Log Analytics workspace (SKU/retention from azure-parameters.json), enables Microsoft Sentinel via an inline ARM template (SecurityInsights onboarding states deployment), verifies Azure connection/subscription context, and returns workspace details for downstream phases; skip-if-exists behavior.
- In/Out: In: subscription/RG/location/workspace config. Out: LAW + Sentinel enabled, workspace resourceId/customerId for later phases.
- Depends on: Az.Accounts, Az.Resources, Az.OperationalInsights; Azure RBAC to create workspaces and enable Sentinel.
- Portability: Az PowerShell cmdlets + local ARM template file replaced by ARM REST calls (management.azure.com via proxy): PUT workspace, PUT Microsoft.SecurityInsights/onboardingStates deployment; poll async operations under the 30s request limit.

### SYN-21. AMA installation script generator

- Source: `Azure/dev/windows-schema-sync/Core/Deploy-AMA.ps1` | Maturity: dev | Category: dcr-deployment | Verdict: **needs-redesign**
- Generates a self-contained PowerShell installer (saved to generated/Install-AzureMonitorAgent.ps1) for on-prem Windows machines: downloads the AMA MSI, installs silently, embeds subscription/RG/DCR association details, supports -Force/-Uninstall; SecurityEvent collection level selection (Minimal/Common/All) via Get-SecurityEventXPath XPath sets; config-driven target machine list.
- In/Out: In: azure-parameters.json, ama config (selectedLevel, targetMachines), DCR resource ID. Out: downloadable Install-AzureMonitorAgent.ps1 artifact.
- Depends on: Naming-Engine for DCR names; no Azure calls for generation itself.
- Portability: Script generation is pure text templating - port directly and offer as an in-browser generated download (the artifact still runs on customer Windows hosts, which is expected and fine). Committed sample contains a real subscription ID/RG - scrub during port.

### SYN-22. SecurityEvent_CL custom table deployment

- Source: `Azure/dev/windows-schema-sync/Core/Deploy-CustomTable.ps1` | Maturity: dev | Category: dcr-deployment | Verdict: **needs-redesign**
- Creates the SecurityEvent_CL custom table in Log Analytics mirroring the native SecurityEvent schema, loading columns from schemas/custom-tables/SecurityEvent_CL.json (committed, full field list with descriptions), mapping types via ConvertTo-LAColumnType, handling already-exists (skip/update) via the Tables API - the mirror-table design is what makes apples-to-apples drift comparison possible.
- In/Out: In: SecurityEvent_CL.json schema, workspace identity. Out: SecurityEvent_CL custom table provisioned in LAW.
- Depends on: Az modules / Log Analytics Tables API; schemas/custom-tables/SecurityEvent_CL.json.
- Portability: Straightforward ARM REST port: PUT .../workspaces/{ws}/tables/SecurityEvent_CL?api-version=... with the schema JSON. Schema file moves to bundled app asset or is regenerated live via the schema-sync-from-Azure feature.

### SYN-23. Dual DCR deployment with Cribl destination export

- Source: `Azure/dev/windows-schema-sync/Core/Deploy-DCRs.ps1` | Maturity: dev | Category: dcr-deployment | Verdict: **needs-redesign**
- Deploys two Direct (kind: Direct) DCRs - one for SecurityEvent (AMA path) and one for SecurityEvent_CL (Cribl path) - then Export-CriblDestinationConfig generates ready-to-import Cribl Sentinel destination JSONs per DCR (dcrID/immutable id, streamName, dceEndpoint, ingestion URL with api-version, loginUrl for the tenant, client_id, secret placeholder, concurrency/flush/compression tuning) plus a combined cribl-dcr-config.json under cribl/packs/windows_to_sentinel/.
- In/Out: In: azure-parameters.json (naming, auth), SecurityEvent_CL schema columns. Out: two DCRs with immutable IDs, per-destination Cribl config JSONs + combined config.
- Depends on: Az modules/ARM (Microsoft.Insights/dataCollectionRules), Naming-Engine (Get-DCRName, Get-CriblDestinationId).
- Portability: DCR creation via ARM REST through the proxy; the Cribl destination export becomes far stronger in-app: create the sentinel destination directly via the Cribl product REST API (secret from KV) instead of emitting JSON files with '<replace me>' placeholders. Note overlap with the larger DCR-Automation subsystem elsewhere in the repo - this is a simplified two-table reimplementation.

### SYN-24. Key Vault deployment with placeholder secret lifecycle

- Source: `Azure/dev/windows-schema-sync/Core/Deploy-KeyVault.ps1` | Maturity: dev | Category: identity-auth | Verdict: **platform-provided**
- Creates an Azure Key Vault (kv-schemasync-<location> naming), grants access to the current principal and service principal, seeds tagged placeholder secrets (ANTHROPIC-API-KEY, AZURE-CLIENT-SECRET, SENTINEL-WORKSPACE-ID, AZURE-TENANT-ID, AZURE-CLIENT-ID with Required flags and descriptions), and Run-SchemaSync's wrapper interactively waits/verifies until required placeholders are replaced - the secrets backbone for the GitHub Actions workflow.
- In/Out: In: azure-parameters.json (naming, tenant, SP). Out: Key Vault with tagged placeholder secrets, access policies, secret status list.
- Depends on: Az.KeyVault; Azure RBAC for vault creation and access-policy grants.
- Portability: The app-scoped encrypted KV store replaces this entirely for the app's own secrets (Anthropic key, Azure SP secret, workspace ID). Only retain if the app must also provision Key Vault for an external CI flow - which is dropped along with the GitHub Actions feature.

### SYN-25. GitHub workflow deployment helper

- Source: `Azure/dev/windows-schema-sync/Core/Deploy-GitHubWorkflow.ps1` | Maturity: dev | Category: infra-tooling | Verdict: **not-portable**
- Guided setup for the CI automation: validates gh CLI presence/auth and git repo/remote, checks the workflow file exists, walks through secret creation (Set-GitHubSecret via gh secret set for ANTHROPIC_API_KEY, Azure creds, KEY_VAULT_NAME), prints auth/secret setup guides, and enables the workflow via gh.
- In/Out: In: local git repo with GitHub remote, gh auth, secret values. Out: configured repo secrets, enabled schema_sync workflow.
- Depends on: gh CLI, git, GitHub repo admin rights.
- Portability: Exists solely to provision the GitHub Actions scheduler from a local machine (gh CLI, local repo). Dropped when scheduling moves in-app; any residual need (setting repo secrets) could use the GitHub REST API via proxy but is out of the app's core value.

### SYN-26. Incremental phased EventID onboarding (PowerShell)

- Source: `Azure/dev/windows-schema-sync/Core/Deploy-IncrementalOnboarding.ps1` | Maturity: dev | Category: dcr-deployment | Verdict: **needs-redesign**
- Manages staged rollout of Windows events to SecurityEvent_CL across 8 configured phases (Authentication, Account Mgmt, Privilege Use, Process, Kerberos, Group Membership, Object Access, Policy Changes in operation-parameters.json): actions Status/Deploy/Validate/Advance/Reset; Deploy redeploys the custom-table DCR with a transformKql EventID whitelist ('source | where EventID in (...)') covering all phases up to current; Validate applies validationCriteria (minEventsReceived, maxNullPercentage, requiredFields, exact-match rate) before Advance unlocks the next phase.
- In/Out: In: eventIdPhases config, current phase, validation criteria. Out: filtered DCR deployment, per-phase validation verdicts, phase advancement, onboarding status report.
- Depends on: Az modules (DCR update), schemas/custom-tables/SecurityEvent_CL.json, drift validation (Python).
- Portability: Phase model + KQL filter generation are pure logic (direct); DCR redeploys become ARM REST; phase state moves to KV. Merges naturally with the Python autonomous loop into one app onboarding wizard with progress UI. Phase definitions are config data worth shipping as defaults.

### SYN-27. Drift check PowerShell wrapper

- Source: `Azure/dev/windows-schema-sync/Core/Compare-TableData.ps1` | Maturity: dev | Category: infra-tooling | Verdict: **not-portable**
- Bridges menu option 7 to the Python drift engine: verifies Python availability, installs pip dependencies, maps azure-parameters.json to env vars (ARM endpoint params preferred), invokes the drift monitor, pretty-prints the drift report (Format-DriftReport) in the console, and writes runs/drift/latest_drift_check.json.
- In/Out: In: azure-parameters.json, driftDetection settings. Out: console drift report, latest_drift_check.json.
- Depends on: Python runtime + pip, src.monitors.drift_monitor, env var contract.
- Portability: A process-launching shim (python subprocess, env-var plumbing) with no independent value once the drift engine is native TS - superseded entirely by the ported DriftMonitor plus an app results view. The console report formatting maps to a React drift dashboard.

### SYN-28. Live schema sync from Azure (schema mirroring)

- Source: `Azure/dev/windows-schema-sync/Core/Sync-SchemaFromAzure.ps1` | Maturity: dev | Category: discovery | Verdict: **needs-redesign**
- Menu option [S]: queries the live SecurityEvent schema via its own PowerShell ARM REST implementation (Get-AzureAccessToken client-credentials + Invoke-ArmLogAnalyticsQuery 'SecurityEvent | getschema'), maps LA types (ConvertTo-SchemaType), enriches columns with human descriptions (Add-FieldDescriptions), and regenerates schemas/custom-tables/SecurityEvent_CL.json so the custom mirror table definition always tracks the native table.
- In/Out: In: tenant/SP creds, workspace resource identity. Out: refreshed SecurityEvent_CL.json schema (name/type/description columns).
- Depends on: login.microsoftonline.com token endpoint, management.azure.com query API.
- Portability: PowerShell-to-TS rewrite, but it is already pure REST (same ARM pattern as the Python drift client) - consolidate both into one TS KQL/schema client. Output schema goes to KV and feeds the custom-table deployment feature.

### SYN-29. Resource naming engine

- Source: `Azure/dev/windows-schema-sync/Core/Naming-Engine.ps1` | Maturity: dev | Category: infra-tooling | Verdict: **direct**
- Centralized naming conventions: location suffix normalization, builders for each resource type (Get-LogAnalyticsWorkspaceName, Get-DCRName, Get-DCEName, Get-CustomTableName, Get-KeyVaultName pattern, Get-CriblDestinationId), Update-NamingSuffixes to rewrite parameter defaults per location, and Get-AllResourceNames powering the menu's 'View Resource Names' preview.
- In/Out: In: baseObjectName, location, resource type. Out: deterministic Azure/Cribl resource names.
- Depends on: None.
- Portability: Pure string logic; port to a TS naming module and reuse for both ARM deployments and Cribl destination IDs. Keep consistent with the repo's DCR-Automation abbreviation conventions if the app unifies subsystems.

### SYN-30. Logging and output helper

- Source: `Azure/dev/windows-schema-sync/Core/Output-Helper.ps1` | Maturity: dev | Category: infra-tooling | Verdict: **platform-provided**
- Console+file logging framework: Initialize-SchemaSyncLogging (timestamped logs/SchemaSync_<ts>.log), leveled writers (Write-SSSuccess/Error/Warning/Info/Progress/Debug/Section), debug and quiet modes - shared by every Core script.
- In/Out: In: log messages with level/context. Out: colored console output, rotating-ish log files under logs/.
- Depends on: PowerShell host, filesystem.
- Portability: Browser console, app-level notification/toast patterns, and an optional KV-backed activity log replace this; no port needed beyond deciding what run history to persist (covered by the run-results and validation-logger features).

### SYN-31. AMA enrichment lookup seed data

- Source: `Azure/dev/windows-schema-sync/cribl/packs/windows_to_sentinel/lookups` | Maturity: dev | Category: enrichment | Verdict: **direct**
- Committed CSV lookup assets that recreate AMA enrichments in Cribl: account_types.csv (SID pattern to AccountType), logon_types.csv (LogonType to name), logon_failure_status.csv (Status/SubStatus to FailureReason), security_event_activity.csv (EventID to Activity description) - referenced by both the AI prompts and the deterministic drift-fix templates. Note the pack's default/pipelines dir is empty (.gitkeep); generated pipelines are not committed.
- In/Out: In: n/a (static). Out: lookup files consumed by generated pipelines' lookup functions.
- Depends on: None.
- Portability: Static reference data: bundle in the app and upload as Cribl lookups via the product API when building packs. Expandable (privilege LUIDs, token elevation names) per the generator's field-category lists.

### SYN-32. Configuration schema for multi-source/destination extensibility

- Source: `Azure/dev/windows-schema-sync/config/sources.yaml` | Maturity: dev | Category: infra-tooling | Verdict: **direct**
- Declarative config surface: sources.yaml defines ~30 tracked EventIDs by category, multi-strategy schema_sources (microsoft_docs, event_samples, wef_server stub) and doc URL pattern; destinations.yaml defines Sentinel with three schema sources plus SecurityEvent/WindowsEvent(ASIM) targets and commented Splunk/Elasticsearch destination templates; settings.yaml(.example) covers per-task model selection, Cribl deployment, git/PR policy, notifications (Slack/email), caching, scheduling, retries, and validation flags.
- In/Out: In: user edits. Out: runtime behavior of monitors, generator, automation policy.
- Depends on: pyyaml parsing; env var interpolation convention (${VAR}).
- Portability: Ports as the app's settings model (KV-persisted, settings UI). Significant declared-but-unimplemented surface: WEF server source, WindowsEvent/ASIM table, Splunk/Elastic destinations, Slack/email notifications, schema caching, and per-task model overrides have no backing code - treat as roadmap, not features.


## AWS Source Integration (AWS)

Dev/AWS contains exactly one component: AWSIntegrationLab, a Terraform + Python lab environment that provisions AWS as a Cribl Stream data source/destination sandbox (S3 buckets with SQS event notifications, Kinesis Streams/Firehose, CloudWatch Log Groups, EC2 test-log generators, VPC networking) and auto-generates Cribl source/destination JSON configs plus dual-mode IAM authentication (AssumeRole or access keys) from Terraform outputs. It is dev-tree code that self-declares 100% complete in STATUS.md, but shows signs of never having been run end-to-end: the Cribl config generation path has a broken Python import, the documented --non-interactive flag does not exist, and numerous declared config options (Security Lake, EC2 auto-shutdown, cost optimization, TTL, YAML output) are unwired. The product-relevant kernels for a Cribl app are the Cribl AWS source/destination config mapping logic, the dual-authentication IAM bootstrap pattern, and the S3-via-SQS collection wiring; everything else is disposable lab infrastructure. Nothing here touches Azure/Sentinel directly - the AWS-to-Sentinel leg is implied to be composed with the Azure subsystems.

Reader-noted gaps: 1) Cribl config generation path is broken end-to-end: Run-AWSIntegrationLab.py line 238 does 'from Generate_CriblConfigs import CriblConfigGenerator' but the file is Core/Generate-CriblConfigs.py (hyphen), so menu option 3 and the tail of full deployment raise ModuleNotFoundError - strong evidence the lab was never run through config generation despite STATUS.md declaring 100% complete. 2) Generated Cribl configs use simplified/unverified type names (cloudwatch_logs, kinesis_streams) and minimal fields; they were not validated against real Cribl source/destination schemas, so the app should treat the mapping as a starting point, not a spec. 3) Security Lake appears only as a false-default flag in operation-parameters.json and a STATUS.md claim; no Terraform or Python code implements it (grep confirms zero hits in Core/). 4) Many declared options are unwired (TTL cleanup, labMode private VPC endpoints, costOptimization, S3 terraform backend, YAML config format, per-source include toggles, EC2 auto-shutdown, the entire naming conventions block / NamingEngine dead code). 5) CloudTrail bucket and bucket policy exist but no aws_cloudtrail trail resource, so no CloudTrail data is ever delivered. 6) No SQS-source or Firehose-source Cribl config generation despite operation-parameters flags for them; monitoring module's vpc_flow_log output is an empty stub. 7) Despite the subsystem hint 'AWS feeding Cribl -> Sentinel', nothing in Dev/AWS references Azure or Sentinel - the Sentinel leg lives entirely in the Azure/ and SOC-OptimizationToolkit subsystems, so cross-cloud routing would be net-new app work. 8) Could not assess whether any Terraform state or generated configs exist from real runs (Cribl-Configs/ contains only .gitkeep files). 9) Minor: Python console output and markdown docs use unicode check/cross symbols, conflicting with the repo's strict no-emoji rule.

### AWS-01. Interactive lab deployment orchestrator

- Source: `Dev/AWS/Labs/AWSIntegrationLab/Run-AWSIntegrationLab.py` | Maturity: dev | Category: labs-testing | Verdict: **out-of-scope**
- Menu-driven Python CLI (questionary/colorama/tabulate) with 7 operations: full deployment (infra + Cribl configs), infrastructure-only deploy, Cribl config generation only, deployment status display (tabulated terraform output -json), terraform plan, double-confirmed destroy, and configuration validation. Wraps terraform init/plan/apply/destroy as subprocesses.
- In/Out: In: aws-parameters.json, operation-parameters.json, user menu selections. Out: terraform.tfvars, deployed AWS infrastructure, Cribl config JSON files, console status tables.
- Depends on: Python 3.8+, questionary, colorama, tabulate; terraform and aws CLI binaries via subprocess; local filesystem for JSON config and tfvars.
- Portability: Lab/test tooling, not a product feature. Mechanism is also not portable as-is (spawns terraform and aws CLI child processes). The guided deploy/status/destroy UX pattern could inform an app wizard, but Terraform execution cannot run in a browser. README documents a --non-interactive CI/CD flag that is not implemented (no argparse).

### AWS-02. Cribl AWS source/destination config generator

- Source: `Dev/AWS/Labs/AWSIntegrationLab/Core/Generate-CriblConfigs.py` | Maturity: experimental | Category: pipeline-generation | Verdict: **needs-redesign**
- CriblConfigGenerator class maps a Terraform output inventory to Cribl Stream config JSON: S3 sources wired to SQS notification queues, Kinesis Streams sources, CloudWatch Logs destinations, Kinesis Streams destinations, and an S3 destination - all stamped with region and assumeRole auth (IAM role ARN). Writes one JSON file per source/destination into Cribl-Configs/sources and /destinations.
- In/Out: In: Cribl-Configs/terraform-output.json (region, account, IAM role ARN, S3 bucket/SQS queue/Kinesis stream/CloudWatch log group inventories). Out: per-resource Cribl source and destination JSON files.
- Depends on: Python stdlib only (json, pathlib); local filesystem read/write; upstream Terraform output file.
- Portability: Most product-relevant piece of the subsystem. The mapping logic (AWS resource -> Cribl source/destination config with assumeRole auth) is pure data transformation and ports to TS directly, but inputs/outputs must change: inventory should come from AWS API discovery (via proxies.yml) or user input instead of terraform-output.json, and configs should be POSTed to the Cribl REST API instead of written to disk. Caution: currently broken (orchestrator imports Generate_CriblConfigs but file is Generate-CriblConfigs.py, so the menu path raises ModuleNotFoundError) and emitted schemas are simplified approximations (e.g. type cloudwatch_logs, kinesis_streams) not validated against real Cribl input/output schemas.

### AWS-03. Dual-authentication IAM provisioning for Cribl Stream

- Source: `Dev/AWS/Labs/AWSIntegrationLab/Core/terraform/modules/iam/main.tf` | Maturity: dev | Category: identity-auth | Verdict: **needs-redesign**
- Terraform IAM module supporting three auth methods selected by config: AssumeRole (IAM role with trust policy, optional sts:ExternalId condition and trustedPrincipals list for cross-account), accessKey (IAM user + generated access key pair for workers outside AWS / Cribl Cloud), or both. Attaches seven least-privilege inline policies covering S3/SQS/Kinesis source access and S3/SQS/Kinesis/CloudWatch destination access, scoped to project-prefixed ARNs. Also creates an EC2 instance role/profile with SSM and CloudWatch agent policies.
- In/Out: In: authentication_method (assumeRole/accessKey/both), external_id, trusted_principals, project/environment names, deploy flags. Out: IAM role ARN, IAM user + access key id/secret (sensitive), EC2 instance profile, attached policies.
- Depends on: Terraform >= 1.0, hashicorp/aws provider ~> 5.0, AWS IAM/STS APIs, AWS credentials.
- Portability: Real product value: bootstrapping AWS-side auth so Cribl can read/write AWS services. In the app, re-implement as guided AWS IAM API calls (CreateRole/PutRolePolicy/CreateUser/CreateAccessKey via an aws proxy domain with SigV4 handling) or as a downloadable CloudFormation/policy-JSON artifact the user applies themselves. The policy documents and trust-policy templates (external ID, trusted principals) are pure data and port directly. Access-key secrets would go to the app KV store or Cribl secrets, not Terraform state.

### AWS-04. Cribl authentication config snippets and security guidance outputs

- Source: `Dev/AWS/Labs/AWSIntegrationLab/Core/terraform/modules/iam/outputs.tf` | Maturity: dev | Category: identity-auth | Verdict: **direct**
- Terraform outputs that render ready-to-paste Cribl authentication config fragments: an assumeRole snippet (type role, roleArn, optional externalId, region) and an accessKey snippet referencing Cribl secrets (C.SECRET.aws_access_key_id / aws_secret_access_key), plus a per-method authentication_config guidance object (deployment type, instructions) and security_notes (key rotation, state-file warnings, retrieval command).
- In/Out: In: chosen auth method, role ARN / user name / external ID from IAM provisioning. Out: Cribl auth config JSON snippets, human-readable configuration instructions and security warnings.
- Depends on: None beyond the IAM module outputs; pure interpolation.
- Portability: Pure templating/data - ports to browser TS as-is as a snippet/guidance generator fed by whatever auth method the user chose in the app. The Cribl-secrets-reference pattern (C.SECRET.*) is exactly what an app pushing sources/destinations via the Cribl API should emit instead of raw keys.

### AWS-05. S3 + SQS event-notification provisioning (Cribl S3 collection pattern)

- Source: `Dev/AWS/Labs/AWSIntegrationLab/Core/terraform/modules/storage/main.tf` | Maturity: dev | Category: labs-testing | Verdict: **out-of-scope**
- Provisions 4 S3 buckets (app-logs, cloudtrail, flow-logs, firehose-dest) with versioning and SSE, a CloudTrail service bucket policy, and for three of them the full Cribl S3-source wiring: SQS queue (600s visibility, 14-day retention), queue policy allowing s3.amazonaws.com SendMessage, and s3:ObjectCreated:* bucket notifications into the queue.
- In/Out: In: project name, random suffix, versioning/encryption flags. Out: bucket names/ARNs/regions and SQS queue names/URLs/ARNs exposed via outputs.tf for Cribl config generation.
- Depends on: Terraform, AWS S3/SQS APIs, random suffix from root module for global bucket-name uniqueness.
- Portability: Lab infrastructure. However, the S3-bucket -> SQS-queue -> Cribl-S3-source wiring pattern (queue policy, notification config, visibility timeout choices) is the exact onboarding recipe a product app would automate via AWS S3/SQS APIs when a user wants Cribl to collect from an existing bucket - worth extracting as a needs-redesign recipe rather than reusing Terraform. Note: CloudTrail bucket policy exists but no aws_cloudtrail trail resource is created, so no CloudTrail data actually flows.

### AWS-06. Kinesis Data Streams and Firehose provisioning

- Source: `Dev/AWS/Labs/AWSIntegrationLab/Core/terraform/modules/analytics/main.tf` | Maturity: dev | Category: labs-testing | Verdict: **out-of-scope**
- Provisions two Kinesis Data Streams (logs, metrics) with configurable shard count/retention and shard-level metrics, plus an optional Kinesis Firehose delivery stream to S3 with timestamp-partitioned prefixes, GZIP compression, 5MB/300s buffering, error output prefix, its own IAM service role, and CloudWatch error logging.
- In/Out: In: shard count, retention hours, enable_firehose flag, firehose destination bucket ARN. Out: stream names/ARNs and firehose info exposed via module outputs for Cribl config generation.
- Depends on: Terraform, AWS Kinesis/Firehose/IAM/CloudWatch Logs APIs, storage module (firehose bucket).
- Portability: Lab infrastructure for exercising Cribl Kinesis sources/destinations. A product app would not provision Kinesis; it would discover existing streams via the Kinesis API (needs-proxy) and generate Cribl configs for them - that discovery+config half already lives in the config generator feature.

### AWS-07. CloudWatch Log Group provisioning for Cribl destinations

- Source: `Dev/AWS/Labs/AWSIntegrationLab/Core/terraform/modules/monitoring/main.tf` | Maturity: dev | Category: labs-testing | Verdict: **out-of-scope**
- Creates 4 CloudWatch Log Groups under /cribl/destinations/ (app-logs, security-logs, metrics, observability) with configurable retention days and tagging, as landing zones for Cribl CloudWatch Logs destinations. Exposes names/ARNs via outputs; vpc_flow_log output is an empty stub.
- In/Out: In: log retention days, project name, VPC id (unused by resources). Out: log group names/ARNs consumed by the Cribl config generator for cloudwatch_logs destinations.
- Depends on: Terraform, AWS CloudWatch Logs API.
- Portability: Lab target infrastructure. In a product app, CloudWatch log-group creation for a Cribl destination is a single CreateLogGroup call (needs-proxy) folded into destination onboarding; standalone provisioning is not a feature. The vpc_flow_log output referenced by the root cribl_config_data output is an empty placeholder.

### AWS-08. VPC networking provisioning with Flow Logs

- Source: `Dev/AWS/Labs/AWSIntegrationLab/Core/terraform/modules/infrastructure/main.tf` | Maturity: dev | Category: labs-testing | Verdict: **out-of-scope**
- Provisions the lab network: VPC with DNS support, 2 public + 6 private subnets (security/observability/management pairs across 2 AZs), Internet Gateway, NAT Gateways with single-vs-per-AZ HA option, route tables, and VPC Flow Logs delivered to a CloudWatch Log Group via a dedicated IAM role.
- In/Out: In: VPC CIDR, subnet config map, AZ list, NAT/flow-log flags, retention days. Out: VPC id/CIDR, subnet ids, flow log CloudWatch group.
- Depends on: Terraform, AWS EC2/VPC/CloudWatch Logs/IAM APIs.
- Portability: Pure lab plumbing to host test EC2 instances and generate VPC Flow Log data. No product analogue in a Cribl app beyond serving as a data-generation harness; do not port.

### AWS-09. EC2 test-log generator instances

- Source: `Dev/AWS/Labs/AWSIntegrationLab/Core/terraform/modules/compute/main.tf` | Maturity: dev | Category: labs-testing | Verdict: **out-of-scope**
- Provisions up to 3 t3.micro EC2 instances (security/observability/management subnets) with auto-selected latest Amazon Linux 2023 AMI, security group with configurable SSH CIDR, IMDSv2 enforcement, and a user-data script that installs the CloudWatch agent and a systemd log-generator service writing sample INFO/DEBUG lines to /var/log/sample-app/app.log every 10 seconds.
- In/Out: In: instance type, AMI override, subnet ids, SSH CIDR, EC2 instance profile from IAM module. Out: running instances emitting continuous sample logs; instance metadata via module outputs.
- Depends on: Terraform, AWS EC2 API, Amazon Linux 2023, CloudWatch agent, systemd.
- Portability: Test-data generation harness; fundamentally host/VM-based and not a product feature. In-app sample data needs are better served by Cribl's own sample/datagen facilities (platform-provided). Note: enable_auto_shutdown/auto_shutdown_time variables are accepted but no shutdown mechanism is implemented (acknowledged as future work in STATUS.md).

### AWS-10. Terraform root orchestration and Cribl config data export

- Source: `Dev/AWS/Labs/AWSIntegrationLab/Core/terraform/outputs.tf` | Maturity: dev | Category: infra-tooling | Verdict: **out-of-scope**
- Root Terraform config (main.tf) conditionally composes the six modules via deploy_* count flags with a random suffix for global uniqueness and default tagging; outputs.tf aggregates everything into a cribl_config_data output and a local_file resource that writes Cribl-Configs/terraform-output.json (region, account, IAM role ARN, bucket/queue/stream/log-group inventories) as the handoff contract to the Python config generator. Also exposes sensitive IAM user credentials and auth snippets as terraform outputs.
- In/Out: In: terraform.tfvars (deploy flags, region, project, CIDR, AZs). Out: terraform state, terraform outputs (deployment_info, iam_*, s3_buckets, sqs_queues, kinesis_*, cloudwatch_log_groups, ec2_instances), Cribl-Configs/terraform-output.json.
- Depends on: Terraform >= 1.0, hashicorp/aws ~> 5.0, hashicorp/random ~> 3.5, local_file provider (local filesystem write).
- Portability: Terraform-specific glue. The interesting artifact is the intermediate schema of terraform-output.json - a clean inventory contract (resources + auth + region) that a browser app could reproduce from live AWS discovery calls and feed into the ported config-generation logic. The file-based handoff itself must be replaced by in-memory state/KV.

### AWS-11. Configuration and prerequisite validator

- Source: `Dev/AWS/Labs/AWSIntegrationLab/Core/helpers/validation.py` | Maturity: dev | Category: infra-tooling | Verdict: **needs-redesign**
- Validator class with error/warning accumulation: checks required aws-parameters fields (account id, region, base name, prefix), detects placeholder values, regex-validates VPC CIDR, warns when all deployment flags are disabled, verifies terraform/aws/python binaries exist, and validates AWS credentials via aws sts get-caller-identity (returning account/ARN identity).
- In/Out: In: parsed aws-parameters.json and operation-parameters.json dicts. Out: boolean validity, error/warning string lists, AWS caller identity dict.
- Depends on: Python stdlib (subprocess, json, re); terraform and aws CLI binaries; AWS STS.
- Portability: The JSON-parameter validation and CIDR/placeholder checks are pure logic (direct port to TS form validation). Binary prerequisite checks become irrelevant in a browser app. The credential check maps to an STS GetCallerIdentity call through an AWS proxy domain (needs SigV4 signing on outbound requests, which the platform proxy would have to support or the app must compute client-side).

### AWS-12. Resource naming engine

- Source: `Dev/AWS/Labs/AWSIntegrationLab/Core/helpers/naming_engine.py` | Maturity: placeholder | Category: infra-tooling | Verdict: **direct**
- NamingEngine class generating AWS resource names from the naming conventions block of aws-parameters.json (per-type prefix/suffix for VPC, S3 buckets with lowercase + random suffix for global uniqueness, Kinesis streams, CloudWatch log group paths, IAM roles, EC2 instances).
- In/Out: In: naming config dict, base object name, resource type, random suffix. Out: formatted resource name strings.
- Depends on: None (pure Python stdlib).
- Portability: Pure string logic, trivially portable to TS. Currently dead code: imported by Run-AWSIntegrationLab.py but never instantiated, and the Terraform modules do their own name interpolation, so the naming block in aws-parameters.json is unwired. Conceptually parallels the Azure DCR name-abbreviation feature; could merge into one cross-cloud naming utility in the app.

### AWS-13. Declarative lab configuration schema (aws-parameters + operation-parameters)

- Source: `Dev/AWS/Labs/AWSIntegrationLab/operation-parameters.json` | Maturity: dev | Category: infra-tooling | Verdict: **out-of-scope**
- Two JSON config files driving the whole lab: aws-parameters.json (account/region, naming, VPC/subnet layout, S3 bucket set, Kinesis/Firehose settings, CloudWatch log groups, EC2 instances, Cribl IAM role, tags, TTL) and operation-parameters.json (per-component deploy flags, authentication method with documented scenarios including cross-account and Cribl Cloud, script behavior, validation toggles, criblIntegration source/destination include flags and json/yaml format, terraform backend, cleanup, cost optimization). Underscore-prefixed keys carry inline documentation and cost estimates.
- In/Out: In: user edits. Out: consumed by Run-AWSIntegrationLab.py (partially) and validation.py.
- Depends on: None; static JSON. Also see Dev/AWS/Labs/AWSIntegrationLab/aws-parameters.json.
- Portability: Lab configuration, but the schema is a useful blueprint for an app's AWS-onboarding settings model (auth scenarios, per-service enable flags, cost warnings). Caution: many options are declared but never consumed by the orchestrator or Terraform - timeToLive, labMode private endpoints, costOptimization.*, terraform S3 backend, configFormat yaml, criblIntegration include* toggles, deploySecurityLake, scriptBehavior.terraformAutoApprove/dryRun - only region, project, VPC CIDR, AZs, and 5 deploy flags reach terraform.tfvars via generate_tfvars.

### AWS-14. AWS authentication strategy documentation set

- Source: `Dev/AWS/Labs/AWSIntegrationLab/docs/AUTHENTICATION_STRATEGIES.md` | Maturity: docs-only | Category: documentation | Verdict: **direct**
- Three markdown guides (AUTHENTICATION_STRATEGIES.md 556 lines, CONFIGURATION_GUIDE.md 453 lines, AUTHENTICATION_IMPLEMENTATION.md 353 lines) covering the AssumeRole-vs-access-key decision tree by worker location (AWS, on-prem, other clouds, Cribl Cloud), trust policy examples, external ID cross-account setup, per-scenario operation-parameters examples, and Cribl-side configuration including secrets management.
- In/Out: In: none. Out: human guidance; pairs with docs/CONFIGURATION_GUIDE.md and docs/AUTHENTICATION_IMPLEMENTATION.md in the same directory.
- Depends on: None.
- Portability: Content ports directly as in-app help text or wizard copy for an AWS-source onboarding flow (choose where your workers run -> app recommends role vs keys and generates the matching artifacts). No mechanism to port.

### AWS-15. Lab README and quick-start documentation

- Source: `Dev/AWS/Labs/AWSIntegrationLab/README.md` | Maturity: docs-only | Category: documentation | Verdict: **out-of-scope**
- README with architecture overview, deployed-resource inventory, cost estimates ($60-70/month minimal) and optimization flags, deployment mode table, troubleshooting, CI/CD GitHub Actions example, and comparison to the Azure Unified Lab; QUICKSTART.md gives a 5-minute deploy walkthrough including expected generated config filenames and Cribl import steps; STATUS.md tracks module completion; Core/terraform/modules/README.md is the module implementation guide.
- In/Out: In: none. Out: human guidance; also Dev/AWS/Labs/AWSIntegrationLab/QUICKSTART.md, STATUS.md, Core/terraform/modules/README.md.
- Depends on: None.
- Portability: Lab documentation. Caution when trusting it: the CI/CD example invokes a --non-interactive flag the script does not implement, and STATUS.md claims Security Lake access policies that do not exist in the IAM module. The cost-estimate content could seed an app-side cost hints panel if AWS provisioning guidance is ever surfaced.


## Enrichment Lookups (LKP)

The Lookups subsystem provides enrichment lookup tables for Cribl Stream and currently contains exactly one working tool: a Python CLI (DynamicLookups/ActiveDirectory/main.py, ~425 lines) that queries Active Directory users over LDAP, exports five identity attributes to CSV, and pushes the file to a Cribl.Cloud worker group via REST (upload, create-or-update lookup object, commit, deploy). StaticLookups is an empty placeholder, and the v1.0.0 release notes describe a much larger lookup framework (caching, YAML config, static lookup engine) that has no implementing code. The Cribl-side REST logic ports directly to the app platform; the LDAP leg must be redesigned onto Microsoft Graph since the browser sandbox cannot speak LDAP.

Reader-noted gaps: 1) Refresh mechanism: despite the release notes' 'configurable refresh intervals' and 'background refresh' claims, the only real refresh is externally re-running main.py (cron/Task Scheduler per README); the app will need its own re-sync trigger (manual button or user-initiated polling loop) since the sandbox has no scheduler. 2) StaticLookups is completely empty; actual static lookup datasets may live elsewhere in the repo (e.g. inside pack archives like packs/cloudflare-sentinel_0-5-8.crbl or the SOC-OptimizationToolkit trees), which were outside this subsystem's paths and not cataloged here. 3) The script hard-codes Cribl.Cloud gateway URLs (app.cribl.cloud, workspace 'main'), so on-prem/hybrid leaders and non-main workspaces are unsupported as written; inside the app this constraint disappears. 4) No sample config.ini is committed (gitignored), and the AD attribute list / search filter are hard-coded, so 'configurable field mappings' from the release notes could not be assessed against code. 5) Could not verify the Cribl API endpoint shapes against a live system; the create (POST) vs update (PATCH) and commit-file-list conventions should be revalidated against the current Cribl OpenAPI spec during reimplementation.

### LKP-01. AD-to-Cribl lookup sync pipeline (end-to-end orchestrator)

- Source: `Lookups/DynamicLookups/ActiveDirectory/main.py` | Maturity: production | Category: enrichment | Verdict: **needs-redesign**
- Single-run CLI tool (main()) that queries Active Directory users over LDAP, exports them to a CSV lookup file, then pushes that file into a Cribl.Cloud worker group: obtain OAuth token, upload CSV, create-or-update the lookup object, commit, and deploy. No built-in scheduler: refresh is achieved by re-running the script (README suggests cron / Windows Task Scheduler). Output format is a fixed 5-column CSV (sAMAccountName, DisplayName, EmailAddress, Department, Title).
- In/Out: In: config.ini and/or CLI args (AD server/user/password/domain/search-domain, Cribl client_id/client_secret/organization_id, lookup filename, target worker group). Out: local CSV file on disk; a created/updated and deployed lookup table in the target Cribl worker group; console progress messages.
- Depends on: Python 3.7+, requests, ldap3, stdlib (csv, gzip, configparser, argparse, pathlib); local filesystem for config.ini and CSV; network access to on-prem LDAP (389/636) and to https://login.cribl.cloud and https://app.cribl.cloud.
- Portability: The pipeline shape ports well to the app: fetch identities -> build CSV in memory -> PUT/POST to Cribl lookup API -> commit -> deploy, all as a wizard or scheduled-by-user action. The LDAP leg must be replaced with Microsoft Graph via proxies.yml (see LDAP feature). CSV is built in-browser instead of on disk. Long directory pulls need pagination and progress polling under the 30s/request and 100 req/min limits.

### LKP-02. LDAP Active Directory user query with CSV export

- Source: `Lookups/DynamicLookups/ActiveDirectory/main.py` | Maturity: production | Category: enrichment | Verdict: **needs-redesign**
- query_ad_users(): binds to an AD server via ldap3 (ldap:// or ldaps://), searches search_filter '(objectClass=user)' for a hard-coded attribute set (sAMAccountName, DisplayName, EmailAddress, Department, Title), and writes results to CSV with a header row. Includes utilities: parse_ad_user() accepts UPN (joe@x.com), NetBIOS (DOM\joe or DOM/joe), or plain username formats and normalizes to UPN; search base is auto-derived from the domain (mycompany.com -> dc=mycompany,dc=com), with optional separate ad_search_domain for child-domain search bases. Attribute list is extendable only by editing code (per README Extensibility).
- In/Out: In: AD server URI, credentials in any of 3 username formats, auth domain, optional search domain, output filename. Out: CSV file with 5 identity columns, one row per AD user object; blank strings for missing attributes.
- Depends on: ldap3 Python library; raw LDAP/LDAPS socket access to a domain controller; local filesystem write for the CSV.
- Portability: Raw LDAP to an on-prem DC is impossible from a sandboxed browser app (platform proxy is HTTPS-only). The user value (identity-attribute enrichment table) ports by querying Microsoft Graph (graph.microsoft.com /users?$select=onPremisesSamAccountName,displayName,mail,department,jobTitle) via proxies.yml with an Entra app token from login.microsoftonline.com; requires Entra Connect-synced identities. Pure on-prem AD with no Entra sync remains unreachable. UPN/NetBIOS parsing logic itself is trivially portable TS but becomes largely unnecessary.

### LKP-03. Cribl.Cloud OAuth2 client-credentials authentication

- Source: `Lookups/DynamicLookups/ActiveDirectory/main.py` | Maturity: production | Category: identity-auth | Verdict: **platform-provided**
- get_bearer_token(): POSTs client_credentials grant to https://login.cribl.cloud/oauth/token with audience https://api.cribl.cloud and returns the access token used for all subsequent Cribl API calls.
- In/Out: In: Cribl client_id and client_secret. Out: bearer token string (or None on failure).
- Depends on: requests; HTTPS to login.cribl.cloud.
- Portability: An app running inside the Cribl Stream leader UI gets authenticated fetch() to the product REST API for free (policies.yml), so this entire auth leg is dropped. Only needed again if the app must target a foreign Cribl organization, in which case login.cribl.cloud would go through proxies.yml with the secret in the app KV store.

### LKP-04. Lookup file upload with create-or-update semantics

- Source: `Lookups/DynamicLookups/ActiveDirectory/main.py` | Maturity: production | Category: enrichment | Verdict: **direct**
- Three cooperating functions: upload_lookup_file() PUTs the file bytes to /m/{group}/system/lookups?filename=X (Content-Type text/csv, or application/gzip for .gz files, which it transparently decompresses via gzip.open) and captures the temp filename Cribl returns; check_lookup_exists() GETs /system/lookups/{id} and inspects items[] for a matching id; then create_lookup() POSTs or update_lookup() PATCHes the lookup object binding id -> fileInfo.filename (temp name). Handles both first-time creation and refresh of an existing lookup.
- In/Out: In: bearer token, organization_id, worker group, lookup filename, local CSV/.gz file. Out: uploaded lookup content plus a created/updated lookup object on the worker group; temp filename echoed back for the bind step.
- Depends on: requests; Cribl API paths .../m/{group}/system/lookups (GET/PUT/POST/PATCH); local file read (only for sourcing the bytes).
- Portability: Pure REST logic; ports as-is to authenticated fetch() with /api/v1/m/{group}/system/lookups declared in policies.yml (the org/workspace URL prefix disappears when running on the leader). File bytes come from an in-memory CSV string or a browser file picker instead of disk; gzip support via CompressionStream or simply uploading plain CSV. The exists-check/create-vs-update branching is directly reusable TS.

### LKP-05. Commit and deploy of lookup changes to a worker group

- Source: `Lookups/DynamicLookups/ActiveDirectory/main.py` | Maturity: production | Category: enrichment | Verdict: **direct**
- commit_changes(): POSTs /m/{group}/version/commit with message 'Automated lookup file update' and an explicit file list (groups/{group}/data/lookups/{name} plus the sibling .yml metadata file), extracting the commit id from items[0].commit. deploy_changes(): PATCHes /master/groups/{group}/deploy with {version: commitId}. Together they make the uploaded lookup live on workers without manual UI steps.
- In/Out: In: bearer token, organization_id, worker group, lookup filename (for the commit file list) / commit id (for deploy). Out: git commit on the leader config store and a deployed config version on the worker group.
- Depends on: requests; Cribl API paths /m/{group}/version/commit and /master/groups/{group}/deploy.
- Portability: Directly portable REST calls via authenticated fetch(); both paths must be declared in policies.yml. The knowledge that a lookup commit must include both the data file and its .yml registry entry (data/lookups/{name}.yml) is load-bearing domain logic worth preserving verbatim.

### LKP-06. Layered configuration: config.ini defaults overridden by CLI arguments

- Source: `Lookups/DynamicLookups/ActiveDirectory/main.py` | Maturity: production | Category: infra-tooling | Verdict: **needs-redesign**
- parse_arguments() (argparse, 10 flags) plus load_config() (configparser with a [cribl] section and built-in defaults, e.g. target_worker_group=default). Every setting resolves as CLI arg > config.ini > default. .gitignore excludes config.ini, *.csv, *.gz to keep credentials and generated data out of git.
- In/Out: In: optional config.ini path (--config), CLI flags. Out: merged runtime settings dict driving the pipeline.
- Depends on: Python argparse/configparser; local filesystem for config.ini.
- Portability: File+CLI config becomes an app settings form persisted in the app-scoped KV store, with AD/Graph client secrets in the encrypted KV secret store injected as proxy auth headers. The precedence/merge logic is trivial; nothing else survives.

### LKP-07. StaticLookups component (placeholder)

- Source: `Lookups/StaticLookups/README.md` | Maturity: placeholder | Category: enrichment | Verdict: **platform-provided**
- Empty placeholder directory: the README.md contains zero content and there are no lookup datasets, generators, or scripts. Intended (per root README and release notes) to hold file-based static lookup tables for Cribl enrichment, but nothing was ever added.
- In/Out: None: no inputs, no outputs, no code or data present.
- Depends on: None.
- Portability: Nothing to port. Cribl Stream already natively manages static CSV lookup files (upload, edit, version) and the app can reach those APIs; if curated Microsoft-specific static datasets are ever wanted, they would ship as in-app data pushed through the same lookup-upload flow cataloged above.

### LKP-08. Lookups v1.0.0 release notes describing an unimplemented lookup framework

- Source: `Lookups/DynamicLookups/ActiveDirectory/RELEASE_NOTES/v1.0.0.md` | Maturity: docs-only | Category: documentation | Verdict: **out-of-scope**
- Marketing-style release document (2024-09-19) claiming features with no corresponding code anywhere under Lookups/: static lookup engine with CSV/JSON support and refresh intervals, dynamic lookup framework with caching/TTL/retry/circuit breakers, YAML lookup configuration system, configurable field mappings, connection pooling, and a roadmap (GeoIP, threat intel, Azure AD cloud directory integration, ML). Only the AD sync script exists; treat every claim beyond it as aspirational.
- In/Out: In: none (prose). Out: feature claims and a YAML config example that matches no shipped code.
- Depends on: None.
- Portability: Not a feature to port, but a useful requirements wishlist for the app's enrichment module (e.g. cloud directory / Entra ID integration and configurable attribute mappings are natural browser-side additions via Graph). Do not treat its caching/performance claims as existing behavior.


## Pack Library, Knowledge Articles, Root Docs (DOC)

This subsystem is the repo's distributable content and reference-documentation layer: one shippable Cribl pack artifact (cloudflare-sentinel_0-5-8.crbl with three route/pipeline pairs targeting a Sentinel DCR), four knowledge-article sets (Azure Monitor-to-Sentinel migration, O365 app registration with a working REST-based permission validation tool, a Private Link configuration suite, and a Power BI-to-Cribl-Search connector), plus the root README and QUICK_START that document the Electron desktop app. The docs are mature and detailed but written around PowerShell/portal/desktop mechanics, making them prime candidates for conversion into in-app guided flows; the O365 validation tool and Power BI script are real REST-based utilities whose logic ports cleanly to browser TypeScript. Two hygiene issues found: apparently real credentials committed in the O365 dev config, and tenant-specific IDs baked into the pack's outputs.yml.

Reader-noted gaps: 1) Committed secrets: KnowledgeArticles/O365AppRegistrationForCribl/dev/azure-parameters.json contains what appear to be real credentials (tenant ID, client ID, and a live-format client secret) checked into git; the pack's default/outputs.yml likewise embeds a tenant-specific login URL, client_id, DCE endpoint, and DCR IDs. Both need scrubbing/parameterization before reuse. 2) packs/ holds only the single Cloudflare artifact; the tooling that builds .crbl packs lives in Cribl-Microsoft_IntegrationSolution (pack builder) and Azure/dev/Packs/Cribl_Pack_Packaging -- assumed cataloged under other subsystems. 3) Root README/QUICK_START document the Electron desktop app whose actual features live in Cribl-Microsoft_IntegrationSolution; only the docs themselves are cataloged here to avoid double-counting. 4) Root-level SECURITY.md, SECURITY_DISCLAIMER.md, CONTRIBUTORS.md, LICENSE, and Start-App-Windows.bat / Start-App-macOS.sh launchers were outside the assigned paths and are not cataloged. 5) The pack README references a dcr-templates/Cloudflare/ directory for the companion DCR template, which is not in packs/ -- it presumably lives in the Azure DCR-Templates tree (another subsystem). 6) The two .crbl pack version metadata sources disagree slightly (embedded README version history stops at 0.2.0 while package.json says 0.5.8), suggesting the in-archive README is stale.

### DOC-01. Cloudflare-to-Sentinel prebuilt Cribl pack (.crbl)

- Source: `packs/cloudflare-sentinel_0-5-8.crbl` | Maturity: production | Category: pack-management | Verdict: **direct**
- Shippable Cribl Stream pack v0.5.8 that transforms Cloudflare Logpush events into the CloudflareV2_CL Sentinel table via a Direct DCR. Contains three pipelines (Cloudflare_HTTP, Cloudflare_WAF, Cloudflare_DNS) with per-type timestamp extraction, Type-field classification, and field enrichment; route.yml with sourcetype-based filters (cloudflare:json / cloudflare:waf / cloudflare:dns:zones); a bundled Sentinel destination (outputs.yml) targeting the Logs Ingestion API; sample data files per log type; and an embedded README. minLogStreamVersion 4.12.0, allowGlobalAccess true.
- In/Out: In: none at rest (import target is a Cribl Stream worker group; runtime input is Cloudflare Logpush events already in Stream). Out: installed pack with 3 pipelines, 3 routes, sample files, and a Sentinel destination posting to a DCR logs-ingestion endpoint (Custom-CloudflareV2 stream -> CloudflareV2_CL).
- Depends on: Cribl Stream >= 4.12; a deployed Cloudflare DCR and Entra app registration (client-credential auth to login.microsoftonline.com); Azure Logs Ingestion API endpoint (monitor.azure.com scope).
- Portability: The .crbl is a static gzip archive of pure config data: bundle it as an app asset (or rebuild the tgz in-browser) and install it via the Cribl packs REST API (capability 1). Caveat requiring handling: default/outputs.yml hardcodes one tenant's DCE endpoint, DCR immutable ID, client_id, and login URL (secret is 'changeme') -- the app should rewrite/parameterize outputs.yml from the user's actual DCR deployment before install instead of shipping the baked-in destination.

### DOC-02. O365 app permission validation tool

- Source: `KnowledgeArticles/O365AppRegistrationForCribl/dev/Run-O365PermissionValidation.ps1` | Maturity: dev | Category: identity-auth | Verdict: **needs-proxy**
- Menu-driven PowerShell tool (Run-O365PermissionValidation.ps1 orchestrating Test-O365AppPermissions.ps1, 660 lines) that validates an Entra app registration has the exact permissions Cribl O365 sources need, using pure REST calls (no PS modules) to mirror how Cribl Stream itself calls the APIs. Modes: All, ActivityAPI, GraphAPI, MessageTrace, Status, UpdateConfig; also supports -NonInteractive for automation. Acquires client-credentials tokens per resource, probes the Office 365 Management Activity API (ActivityFeed.Read/ReadDlp, ServiceHealth.Read), Microsoft Graph (7 application permissions incl. AuditLog.Read.All, Directory.Read.All, Reports.Read.All), and the Exchange Reporting Web Service MessageTrace endpoint; validates config JSON for missing/placeholder values; prints detailed troubleshooting guidance; exports timestamped JSON results. Behavior toggled via operation-parameters.json (which tests, verbose, JSON export, dry-run).
- In/Out: In: tenantId/clientId/clientSecret (azure-parameters.json or CLI params), test toggles (operation-parameters.json). Out: console pass/fail report per permission with remediation guidance, plus a timestamped JSON results file.
- Depends on: OAuth2 client-credentials token endpoints (login.microsoftonline.com); manage.office.com (Management Activity API); graph.microsoft.com; reports.office365.com / outlook.office365.com (Reporting Web Service); local filesystem only for config/results JSON.
- Portability: The REST probe logic is fully portable to browser TypeScript. Needs proxies.yml entries for login.microsoftonline.com, manage.office.com, graph.microsoft.com, and reports.office365.com; credentials move from JSON files to the app KV store; JSON result export becomes KV persistence or a browser download. Individual probe calls fit well within the 30s timeout and rate limits. Note: the committed dev/azure-parameters.json contains apparently real credentials that must be scrubbed.

### DOC-03. Azure Monitor to Sentinel migration guide

- Source: `KnowledgeArticles/AzureMonitorMigration/Cribl_Azure_Monitor_to_Sentinel_Migration.md` | Maturity: docs-only | Category: documentation | Verdict: **needs-redesign**
- Migration playbook for the HTTP Data Collector API retirement (Sept 14, 2026) affecting classic _CL custom tables using Cribl's Azure Monitor destination. Covers: inventorying classic vs modern custom tables, creating an app registration, configuring and running DCR Automation (which auto-detects table types, migrates Classic tables to DCR-based, creates DCRs, and exports ready-to-import Cribl Sentinel destination configs), assigning DCR RBAC, updating Cribl pipelines to match DCR schemas, a KQL validation query, a 4-week phased cutover schedule, and a troubleshooting matrix.
- In/Out: In: reader's Azure environment (workspace with classic custom tables) and Cribl deployment. Out: procedural knowledge; the referenced tooling produces DCRs and cribl-dcr-configs/destinations/*.json.
- Depends on: References the DCR Automation PowerShell tool (Azure/CustomDeploymentTemplates/DCR-Automation), Az PowerShell modules, Azure Portal, Cribl Packs Dispensary.
- Portability: Prime candidate for an in-app guided migration wizard rather than static docs: enumerate workspace tables via ARM REST (proxied) and flag Classic ones, drive table migration + DCR creation via ARM, create Cribl Sentinel destinations via the Cribl REST API, and run the validation KQL via the proxied Log Analytics query API. The git-clone/PowerShell instructions are replaced entirely by the app; retain the cutover-plan and troubleshooting content as in-app help.

### DOC-04. O365 App Registration guide for Cribl sources

- Source: `KnowledgeArticles/O365AppRegistrationForCribl/O365-AppRegistration_for_Cribl.md` | Maturity: docs-only | Category: documentation | Verdict: **needs-redesign**
- Screenshot-driven walkthrough (34 images) for creating and configuring an Entra ID app registration to power Cribl O365 sources. Documents per-source permission matrices: O365 Activity (Office 365 Management API: ActivityFeed.Read, ActivityFeed.ReadDlp, ServiceHealth.Read), O365 Services (Microsoft Graph application permissions), and O365 Message Trace (Office 365 Exchange Online ReportingWebService.Read.All). Covers admin consent, client secret creation, Exchange Admin Center role-group creation (Message Tracking + View-Only Recipients), and EXO PowerShell New-ServicePrincipal / Add-RoleGroupMember role assignment, plus secret-rotation best practices.
- In/Out: In: reader with Azure Portal / Entra admin and Exchange admin access. Out: a configured app registration (client ID, tenant ID, secret) ready to paste into Cribl O365 source config.
- Depends on: Azure Portal / Entra ID, Exchange Admin Center, ExchangeOnlineManagement PowerShell module (Message Trace path only).
- Portability: Redesign into an in-app guided setup flow: app registration, permission grants, secret creation, and admin consent can be automated via Microsoft Graph /applications and /servicePrincipals through the proxy (requires a privileged Graph token from the admin), with the resulting client ID/secret stored in KV and injected into Cribl source configs via the Cribl API. The Exchange role-group and New-ServicePrincipal steps have no clean REST equivalent and should remain rendered manual guidance (or a generated PowerShell snippet for download). Screenshots need re-authoring as in-app step UI.

### DOC-05. Private Link configuration guide for on-prem Cribl workers

- Source: `KnowledgeArticles/PrivateLinkConfiguration/Private-Link-Configuration-for-Cribl.md` | Maturity: docs-only | Category: documentation | Verdict: **needs-redesign**
- 1,157-line step-by-step guide (with 173-line README index and 1,247-line Network-Architecture-Diagrams.md companion) for sending logs from on-prem Cribl workers to Log Analytics/Sentinel over Azure Private Link. Steps: create Azure Monitor Private Link Scope (AMPLS), add workspace, create DCE with private-only network access, add DCE to AMPLS, create Private Endpoint, configure DNS (Option 1: AD conditional forwarders; Option 2: Azure Private DNS Resolver), run DCR Automation's 'Configure Private Link for DCE' menu option, configure the Cribl Sentinel destination against the private DCE, test data flow (nslookup/traceroute/openssl), and troubleshoot. Every Azure step includes both Portal and PowerShell instructions; includes timelines, prerequisites checklist, and use-case guidance.
- In/Out: In: reader's Azure subscription, VNet/subnet, ExpressRoute/VPN, DNS infrastructure, on-prem Cribl 4.14+. Out: procedural knowledge producing an AMPLS + private DCE + private endpoint + DNS config and a Cribl destination using the private path.
- Depends on: Az PowerShell modules (Az.Monitor, Az.Network), Azure Portal, on-prem Windows/Linux DNS servers, DCR Automation tool integration.
- Portability: Split verdict inside one guide: the Azure-side resource creation (AMPLS, DCE, private endpoint, Azure private DNS zones) can be re-implemented as guided ARM REST deployments through the management.azure.com proxy with progress polling. The on-prem parts -- configuring AD DNS servers, editing resolv.conf, running nslookup/traceroute validation -- cannot execute from a sandboxed iframe and must remain rendered guidance plus downloadable, pre-filled scripts. Architecture diagrams (currently ASCII) should be re-rendered as app UI.

### DOC-06. Private Link DNS A-records reference and generator script

- Source: `KnowledgeArticles/PrivateLinkConfiguration/DNS-A-Records-Reference.md` | Maturity: docs-only | Category: documentation | Verdict: **needs-redesign**
- Reference of the exact forward lookup zones and A records required on on-prem DNS for Azure Monitor Private Link (zones: opinsights.azure.com, azure-automation.net, monitor.azure.com, core.windows.net), a minimal Cribl-only record subset, an embedded PowerShell script that bulk-creates the zones and A records on an AD DNS server from a defined record table, nslookup verification commands with expected private-IP results, and troubleshooting for public-IP fallthrough.
- In/Out: In: user's DCE FQDNs and private endpoint IPs. Out: DNS zone/record specifications and a runnable PowerShell script for the AD DNS server.
- Depends on: Windows DNS Server role with admin rights (script execution); knowledge of private endpoint NIC IPs.
- Portability: The record-set derivation (compute required FQDNs and private IPs from the user's actual DCE and private endpoint, queryable via ARM REST) is pure logic and ports directly; the app can render the personalized record table and generate a customized PowerShell script as a browser download. Actually applying records to an on-prem DNS server is not executable from the browser -- delivery stays as download-and-run guidance.

### DOC-07. Power BI to Cribl Search connector script

- Source: `KnowledgeArticles/PowerBI_CriblSearch/PowerBI_CriblSearch.py` | Maturity: dev | Category: reporting | Verdict: **needs-redesign**
- 120-line Python script run inside Power BI Desktop's Python data source, with a 204-line QUICK_START.md. Flow: OAuth client-credentials token from login.cribl.cloud (audience api.cribl.cloud), POST a Cribl Search job (query/earliest/latest/sampleRate) to the Cloud workspace API, poll job status up to 60x2s, GET NDJSON results, strip metadata columns (isFinished, offset, etc.), and emit a named pandas DataFrame that Power BI imports. Guide covers credential creation in Cribl Cloud, Power BI Python configuration, example Cribl queries (filter/stats/timechart), parameterized credentials, and scheduled-refresh gateway requirements.
- In/Out: In: Cribl Cloud client ID/secret, org ID, workspace, dataset, Cribl Search query, time range. Out: tabular search results as a Power BI dataset (DataFrame).
- Depends on: Python 3.8+ with requests/pandas inside Power BI Desktop (Windows); login.cribl.cloud OAuth; Cribl Cloud Search jobs API (/api/v1/m/{workspace}/search/jobs).
- Portability: The submit/poll/fetch/parse logic ports directly to browser TS -- in a platform app the Search API is first-party (capability 1) so on a Cribl-hosted leader no proxy is needed; a Cloud-gateway variant needs a login.cribl.cloud proxy entry for token exchange. The Power BI-hosted execution itself is not portable; redesign the user value as in-app search execution with CSV/JSON download for Power BI import, and/or generate the pre-filled Python script as a downloadable artifact from the user's stored workspace values.

### DOC-08. Root product README (repository overview)

- Source: `README.md` | Maturity: docs-only | Category: documentation | Verdict: **needs-redesign**
- Top-level doc positioning the repo as the 'Cribl SOC Optimization Toolkit for Microsoft Sentinel' Electron desktop app: launcher quick start, the 4-part workflow (SIEM migration analysis, Sentinel integration with sample browsing / DCR gap analysis / pack build / deploy / source wiring, lab environments, PowerShell DCR automation), app feature list (Elastic sample browser for 434+ vendors, multi-format support, DCR schema resolution, pack builder, EDR-resilience blocklist, four operating modes incl. Air-Gapped), prerequisites, repo structure map, legacy PowerShell tool pointers, knowledge article index, and security posture summary (DPAPI/safeStorage credential handling).
- In/Out: In: reader. Out: orientation and setup knowledge; index into all other repo components.
- Depends on: None (markdown); describes Node.js/Electron/PowerShell prerequisites of the desktop app.
- Portability: Content becomes the platform app's About/overview and onboarding copy. Everything tied to the Electron mechanism -- launchers, Node/PowerShell prerequisites, EDR false-positive rationale, %APPDATA% storage, OS-keychain credential notes -- is obsolete in a sandboxed iframe app and must be rewritten around Cribl-API + proxy + KV equivalents. The described app features themselves are cataloged under the Cribl-Microsoft_IntegrationSolution subsystem, not here.

### DOC-09. Root Quick Start guide (guided setup walkthrough)

- Source: `QUICK_START.md` | Maturity: docs-only | Category: documentation | Verdict: **needs-redesign**
- Step-by-step usage doc for the desktop app: prerequisites (Windows 11, Node 18+, Az module, GitHub PAT, Cribl 4.14+); setup wizard steps (save PAT and fetch Azure-Sentinel + Elastic repos, Cribl Cloud/self-managed connection, Azure session detection via Connect-AzAccount, mode selection); the 6-section Sentinel Integration workflow (solution search, sample loading incl. headerless-CSV header mapping, Azure resource selection, worker group selection, deploy with real-time log, source wiring with optional Lake federation); SIEM Migration page usage; Lab Environments page; troubleshooting matrix; and %APPDATA% directory map.
- In/Out: In: reader following along in the desktop app. Out: a completed setup (repos fetched, Cribl + Azure connected, mode chosen) and knowledge of the main workflows.
- Depends on: None (markdown); references PowerShell Az session detection, GitHub PAT, Electron app pages.
- Portability: Redesign as an in-app first-run wizard and contextual help rather than external docs. Key mechanism changes: Cribl connection setup is platform-provided (the app already runs authenticated in the leader UI -- drop Step 2); Azure auth via Connect-AzAccount session detection becomes a browser OAuth/device-code flow through the login.microsoftonline.com proxy; GitHub repo fetches go through a proxied api.github.com with the PAT in the KV store (30-50MB bulk fetch needs chunking under the 30s/100-rpm limits); %APPDATA% caches become KV/IndexedDB storage.


## Labs and Test Environments (LAB)

The labs subsystem is PowerShell-based Azure test-environment automation: UnifiedLab (a production-ready, 10-phase modular deployer that consolidates six earlier labs into one framework with an 8-preset interactive menu, public/private modes, and TTL self-cleanup) and the older standalone AzureFlowLogLab (v1.0.0, VNet + VPN + flow logs, superseded by UnifiedLab); Dev/HomeLab is an empty placeholder. Nearly everything is lab/test infrastructure (out-of-scope for the Cribl app), but three embedded capabilities are explicitly product-worthy: the Cribl source/destination config generators that turn deployed Azure resources into ready-to-import Cribl configs (both labs), the Event Grid blob-notification wiring that sets up queue-based blob discovery on the Azure side, and the captured vNet flow-log sample data / collector template usable for in-app breaker testing and config seeding.

Reader-noted gaps: 1) Dev/HomeLab is entirely empty - could not assess intent; confirm with the owner whether anything was meant to live there. 2) A sibling lab exists outside my assigned paths: Dev/AWS/Labs/AWSIntegrationLab (Python entry point Run-AWSIntegrationLab.py, Terraform modules, and its own Core/Generate-CriblConfigs.py) - it mirrors the UnifiedLab pattern for AWS and must be cataloged under another subsystem or it will be missed. 3) Generated configs reference a Cribl breaker ruleset 'Azure_vNet_FlowLogs' and pipeline 'Azure_vNet_FlowLogs_PreProcessing' that are NOT defined anywhere in the labs - they presumably live in a Cribl pack elsewhere in the repo (pack-management subsystem); the config generators are incomplete without them. 4) The Electron desktop app (Cribl-Microsoft_IntegrationSolution) already re-implements these labs as a GUI wizard per the root README - that TypeScript port is directly relevant prior art for the Cribl App Platform effort and should be cross-referenced by whoever catalogs that subsystem. 5) The old constituent labs (ADXLab, BlobCollectorLab, BlobAzureQueueLab, EventHubLab, SentinelLab) no longer exist as directories; UnifiedLab CLAUDE.md still cites the stale Azure/dev/LabAutomation path. 6) Working-tree parameter files (azure-parameters.json, onprem-connection-parameters.json) are locally modified per git status and logs/ plus the sample flow-log file contain what appear to be real subscription GUIDs/resource names - scrub before reusing any of this as bundled app content. 7) TTL Phase 2 (subscription-wide cleanup Function App with warning emails) is documented in docs/TTL-Implementation.md but not implemented.

### LAB-01. UnifiedLab orchestrator (phased Azure lab deployment)

- Source: `Azure/Labs/UnifiedLab/Run-AzureUnifiedLab.ps1` | Maturity: production | Category: labs-testing | Verdict: **out-of-scope**
- Main entry point orchestrating a 10-phase Azure lab deployment (Foundation/TTL, Networking, Storage, Monitoring, Analytics, Flow Logs, Compute, DCRs, Cribl configs, VPN Gateway). Interactive menu offers 8 lab presets (Complete, Sentinel, ADX, vNet Flow Log, Event Hub, Blob Queue, Blob Collector, Basic Infrastructure) and public vs private (Private Link) lab modes; non-interactive modes Full/Infrastructure/Monitoring/Analytics/Storage/Custom/Status/Validate plus single-phase execution (-Phase 1..10). Sanitized parameter-file variants (sanatized_azure-parameters.json, san_*) ship as shareable templates.
- In/Out: In: azure-parameters.json, operation-parameters.json, optional onprem-connection-parameters.json; menu selections or -Mode/-Phase flags. Out: deployed Azure resources, timestamped run logs in logs/, generated Cribl configs in Cribl-Configs/.
- Depends on: PowerShell 5.1+, Az modules (Az.Accounts, Az.Resources, Az.Network, Az.OperationalInsights, Az.EventHub, Az.Kusto, Az.EventGrid), Connect-AzAccount session, local filesystem, console UI.
- Portability: Lab provisioning, not a product feature. Note the Electron desktop app already re-implemented these labs as a GUI wizard (per root README), so prior porting art exists. If lab provisioning ever ships in the Cribl app it would need full redesign: ARM REST via proxies.yml with async deployment polling (VPN gateway takes 30-45 min, far beyond the 30 s proxy timeout), KV-store config instead of JSON files.

### LAB-02. Resource group foundation with TTL self-destruct Logic App

- Source: `Azure/Labs/UnifiedLab/Core/Phase1-Foundation/Deploy-TTL.ps1` | Maturity: production | Category: labs-testing | Verdict: **out-of-scope**
- Creates/tags the lab resource group (Deploy-ResourceGroup.ps1) with TTL metadata (TTL_Enabled, TTL_ExpirationTime, warning hours, user email) and deploys a consumption Logic App with hourly recurrence and managed identity that reads its own resource group tags via the ARM REST API and deletes the entire resource group once the TTL expires - automatic lab cost control.
- In/Out: In: timeToLive settings (enabled, hours, userEmail, warningHours) from azure-parameters.json. Out: tagged resource group plus la-ttl-cleanup-<name> Logic App with RG-delete permission via managed identity.
- Depends on: Az.Resources, Microsoft.Logic/workflows ARM API, managed identity role assignment.
- Portability: Lab lifecycle management. The Logic App workflow definition is a JSON document built inline; it could be deployed via ARM REST through the platform proxy if ephemeral-lab provisioning ever becomes an app feature. Phase 2 of the TTL design (subscription-wide cleanup Function App with warning emails) is documented in docs/TTL-Implementation.md as PENDING and not implemented.

### LAB-03. Networking deployment (VNet + NSGs)

- Source: `Azure/Labs/UnifiedLab/Core/Phase2-Networking/Deploy-VNet.ps1` | Maturity: production | Category: labs-testing | Verdict: **out-of-scope**
- Deploys a shared VNet (10.0.0.0/16) with Gateway, PrivateLink, Security, and O11y subnets, and per-subnet NSGs (Deploy-NSGs.ps1) with allow rules for on-premises gateway IP, on-premises network, and intra-VNet traffic. Idempotent: skips or updates existing resources (adds missing subnets).
- In/Out: In: infrastructure.vnetAddressPrefix and subnets config. Out: VNet, subnets, NSGs in the lab RG.
- Depends on: Az.Network cmdlets.
- Portability: Pure Azure network infrastructure for the test environment; no product value inside a Cribl app beyond generic ARM deployment, which other subsystems already cover.

### LAB-04. Storage deployment (account, containers, queues)

- Source: `Azure/Labs/UnifiedLab/Core/Phase3-Storage/Deploy-StorageAccount.ps1` | Maturity: production | Category: labs-testing | Verdict: **out-of-scope**
- Deploys a StorageV2 account (name collision handling), blob containers keyed to Cribl ingestion patterns (criblqueuesource for Event Grid pattern, criblblobcollector for polling pattern, flowlogs for flow-log landing) via Deploy-BlobContainers.ps1, and storage queues (blobNotifications) via Deploy-StorageQueues.ps1.
- In/Out: In: storage.containers and storage.queues.definitions config. Out: storage account, 3+ containers, blob-notification queue.
- Depends on: Az.Storage cmdlets.
- Portability: Lab-side data-landing infrastructure. The container/queue layout encodes the three Cribl blob-ingestion patterns (queue-discovery, scheduled polling, flow logs) - that domain knowledge is captured in the Phase 9 config generator, which is the portable asset.

### LAB-05. Event Grid blob-notification wiring (queue-based blob discovery setup)

- Source: `Azure/Labs/UnifiedLab/Core/Phase3-Storage/Deploy-EventGrid.ps1` | Maturity: production | Category: discovery | Verdict: **needs-redesign**
- Creates an Event Grid system topic on the storage account and event subscriptions that route BlobCreated events into a storage queue - the exact Azure-side prerequisite for Cribl Stream's azure_blob source in queue-based discovery mode (no polling). Idempotent, uses PowerShell Az.EventGrid cmdlets.
- In/Out: In: storage account + queue names, eventGrid subscription definitions from azure-parameters.json. Out: Event Grid system topic + storage-queue event subscriptions delivering BlobCreated notifications.
- Depends on: Az.EventGrid, Az.Storage; ARM management.azure.com API if reimplemented.
- Portability: FLAGGED PRODUCT-WORTHY: an app onboarding wizard for Azure Blob sources could automate this exact wiring in the customer tenant (Event Grid system topic + queue subscription via ARM REST through proxies.yml) and then create the matching Cribl azure_blob source via the product API. Mechanism changes from Az cmdlets to ARM REST calls; the resource graph logic is simple and portable.

### LAB-06. Monitoring deployment (Log Analytics, Sentinel, Private Link/AMPLS)

- Source: `Azure/Labs/UnifiedLab/Core/Phase4-Monitoring/Deploy-LogAnalytics.ps1` | Maturity: production | Category: labs-testing | Verdict: **out-of-scope**
- Deploys a shared Log Analytics workspace (PerGB2018, 90-day retention), enables Microsoft Sentinel on it (Deploy-Sentinel.ps1), and in private lab mode deploys Azure Monitor Private Link Scope, private endpoints, and the full set of Azure Private DNS zones with VNet links (Deploy-PrivateLink.ps1). README additionally documents on-prem AD DNS conditional-forwarder setup (168.63.129.16) for private mode.
- In/Out: In: monitoring config flags, labMode. Out: workspace, Sentinel solution, optional AMPLS + private endpoints + private DNS zones.
- Depends on: Az.OperationalInsights, Az.SecurityInsights/ARM, Az.PrivateDns, Az.Network.
- Portability: Test-environment provisioning. The private-endpoint/AMPLS DNS knowledge in the README overlaps the KnowledgeArticles Private Link doc; useful as reference content for an app help page, but the deployment itself is lab scaffolding.

### LAB-07. Analytics deployment (Event Hub namespace + ADX cluster)

- Source: `Azure/Labs/UnifiedLab/Core/Phase5-Analytics/Deploy-EventHub.ps1` | Maturity: production | Category: labs-testing | Verdict: **out-of-scope**
- Deploys an Event Hub namespace with hubs (logs, metrics, events) including consumer groups (cribl/adx/sentinel), SAS policies, and capture-to-blob; Deploy-ADX.ps1 deploys an optional Kusto cluster (Dev SKU, auto-stop), CriblLogs database with hot-cache/soft-delete policies, creates tables via KQL .create table commands from configured schemas, enables streaming ingestion, and wires Event Hub/blob data connections.
- In/Out: In: analytics.eventHub.hubs and analytics.adx config. Out: EH namespace/hubs/consumer groups/SAS keys, optional ADX cluster + database + tables + data connections.
- Depends on: Az.EventHub, Az.Kusto, Kusto management endpoint for KQL commands.
- Portability: Lab data-plane infrastructure to exercise Cribl Event Hub sources and ADX destinations. The ADX .create-table-from-schema step is a small product-adjacent nugget (an app could pre-create ADX tables for a Cribl ADX destination via the Kusto management REST API), but as written it is lab-scoped.

### LAB-08. vNet Flow Logs deployment (Network Watcher)

- Source: `Azure/Labs/UnifiedLab/Core/Phase6-NetworkMonitoring/Deploy-FlowLogs.ps1` | Maturity: production | Category: labs-testing | Verdict: **out-of-scope**
- Enables vNet-level flow logs through the regional Network Watcher targeting the lab storage account, with optional Traffic Analytics integration into the Log Analytics workspace. Depends on Storage (phase 3) and VNet (phase 2); phase ordering in the orchestrator was rearranged specifically for this dependency.
- In/Out: In: VNet, storage account, flow-log retention config. Out: Microsoft.Network flowLogs resource writing to insights-logs-flowlogflowevent container.
- Depends on: Az.Network Network Watcher cmdlets.
- Portability: Generates the flow-log data the lab's Cribl collectors consume. Enabling flow logs in a customer tenant could be a product onboarding step, but that capability already exists more fully in the vNetFlowLogDiscovery tool cataloged under the discovery subsystem.

### LAB-09. Test VM deployment with auto-shutdown (traffic/sample-data generator)

- Source: `Azure/Labs/UnifiedLab/Core/Phase7-Compute/Deploy-VMs.ps1` | Maturity: production | Category: labs-testing | Verdict: **not-portable**
- Deploys Ubuntu test VMs into lab subnets (no public IPs) whose network traffic is the lab's organic sample-data generator for flow logs, and configures DevTestLab ComputeVmShutdownTask schedules (configurable time/timezone) for new and existing VMs to cap cost. Collects admin passwords pre-deployment to avoid blocking.
- In/Out: In: virtualMachines configuration (size, image, autoShutdown settings), subnet map. Out: VMs with NICs, auto-shutdown schedules.
- Depends on: Az.Compute, Az.Network, microsoft.devtestlab/schedules ARM resource.
- Portability: Requires provisioning compute in Azure purely to generate test traffic - fundamentally a lab mechanism with no browser-app equivalent. In-app sample data needs are better served by the captured flow-log sample file (see Sample vNet flow log event data) or synthetic generators.

### LAB-10. DCR deployment integration wrapper

- Source: `Azure/Labs/UnifiedLab/Core/Phase8-DataCollection/Deploy-DCRs.ps1` | Maturity: production | Category: dcr-deployment | Verdict: **out-of-scope**
- Glue that locates the repo's DCR-Automation toolkit by walking the directory tree, backs up its azure-parameters.json/operation-parameters.json, overrides them with lab values (RG, workspace, location, subscription, tenant/client IDs), then invokes Run-DCRAutomation.ps1 -NonInteractive -Mode DirectNative (public lab) or DCENative (private lab) -ExportCriblConfig, restoring backups afterward. Waits 60 s for Sentinel native tables (CommonSecurityLog, SecurityEvent, WindowsEvent, Syslog) to provision first.
- In/Out: In: lab RG/workspace/location/credentials, labMode. Out: DCRs (Direct or DCE-based) in the lab workspace plus exported Cribl destination configs, via the external DCR-Automation scripts.
- Depends on: Azure/CustomDeploymentTemplates/DCR-Automation/Run-DCRAutomation.ps1, local filesystem, child PowerShell invocation.
- Portability: Pure cross-script plumbing (filesystem discovery, config file swap, child-process invocation) - meaningless in the app. The underlying DCR creation capability is cataloged under the dcr-deployment subsystem; in the app the equivalent is a direct function call, so this wrapper disappears.

### LAB-11. Cribl source/destination config generator from deployed Azure resources

- Source: `Azure/Labs/UnifiedLab/Core/Phase9-Integration/Generate-CriblConfigs.ps1` | Maturity: production | Category: pipeline-generation | Verdict: **needs-redesign**
- Discovers actually-deployed resources (storage account, ADX cluster, Event Hub namespace, with fuzzy name matching) and emits ready-to-import Cribl Stream JSON configs: azure_data_explorer destination (clientCredentials auth, CriblMapping ingestion mapping, batching/compression tuned), Kafka-compatible eventhub sources per hub (SASL $ConnectionString + textSecret, TLS, consumer-group/backoff settings), azure_blob source in queue-based discovery mode (Event Grid pattern), a scheduled Flow Logs collection job (cron 15 * * * *, relative -75m..-15m window, flowLogResourceID time-partitioned path, Azure_vNet_FlowLogs breaker ruleset + Azure_vNet_FlowLogs_PreProcessing pipeline), a plain polling azure_blob collector, and a README summarizing configs plus the required Cribl workspace secrets table.
- In/Out: In: resource names + azure-parameters.json (tenantId, clientId, hub/container/queue definitions), operation flags controlling which patterns to emit. Out: JSON config files under Cribl-Configs/destinations/{adx,sentinel} and Cribl-Configs/sources/, README.md with secret requirements; example artifact checked in at Azure/Labs/UnifiedLab/Cribl-Configs/sources/blob-insights-logs-flowlogflowevent.json.
- Depends on: Az.Storage, Az.Kusto, Az.EventHub for discovery; references Cribl secrets (Azure_Client_Secret, EventHub_*_ConnectionString, Azure_Blob_Queue_Secret, Azure_Blob_Collector_Secret, Azure_vNet_Flowlogs_Secret) and a breaker ruleset/pipeline defined outside this lab.
- Portability: FLAGGED PRODUCT-WORTHY - the highest-value asset in this subsystem. The config templates are pure data/logic (direct-portable to TS). Redesign: resource discovery moves from Az cmdlets to ARM REST via proxies.yml; instead of writing JSON files, POST configs straight to the Cribl product API (sources/destinations/collectors) and create secrets in Cribl; README becomes in-app UI. Fits an end-to-end 'connect my Azure tenant to Cribl' wizard.

### LAB-12. VPN Gateway and site-to-site connection deployment

- Source: `Azure/Labs/UnifiedLab/Core/Phase10-Gateway/Deploy-VPNGateway.ps1` | Maturity: production | Category: labs-testing | Verdict: **out-of-scope**
- Deploys zone-redundant public IP + VPN gateway (run last, 30-45 min) and Deploy-VPNConnection.ps1 creates the local network gateway and IPsec site-to-site connection from onprem-connection-parameters.json (shared key, optional BGP, policy-based traffic selectors, custom IPsec policies) to link an on-prem network (e.g. pfSense) to the lab VNet.
- In/Out: In: onprem-connection-parameters.json (gateway IP, address space, shared key, IPsec policies). Out: public IP, VPN gateway, local network gateway, IPsec connection.
- Depends on: Az.Network.
- Portability: Hybrid-connectivity scaffolding for testing private-mode Cribl ingestion; not a product feature. Long deployment time makes it a poster child for why lab provisioning does not fit the 30 s proxy timeout without async ARM polling.

### LAB-13. Resource naming engine (location-aware Azure name generation)

- Source: `Azure/Labs/UnifiedLab/Core/Naming-Engine.ps1` | Maturity: production | Category: infra-tooling | Verdict: **out-of-scope**
- Pure-logic module: auto-applies location-based suffixes per resource type (Update-NamingSuffixes with a known-region regex), composes prefix+baseName+suffix names (Get-ResourceName), enforces Azure naming constraints - storage accounts 3-24 lowercase alphanumeric (Get-StorageAccountName), ADX clusters 4-22 chars with a subscription-ID hash for global uniqueness (Get-ADXClusterName) - and builds/prints the full planned-name map (Get-AllResourceNames/Show-ResourceNames). Documented in docs/Location-Based-Naming.md.
- In/Out: In: naming config (per-resource prefix/suffix), baseObjectName, location, subscriptionId. Out: validated resource-name map.
- Depends on: None beyond PowerShell string ops - no Azure calls.
- Portability: Serves only lab provisioning, but it is pure string logic that would port to browser TS as-is (effectively 'direct') if the app ever names Azure resources it creates (e.g. Event Grid topics, DCRs). Flag as a reusable utility rather than a standalone feature.

### LAB-14. Lab configuration validation module

- Source: `Azure/Labs/UnifiedLab/Core/Validation-Module.ps1` | Maturity: production | Category: infra-tooling | Verdict: **out-of-scope**
- Validators for lab config: required-field presence, CIDR notation, subnet range overlap detection (IP-range math), storage account name rules, Event Hub partition count, ADX SKU whitelist, whole azure-parameters.json validation (Test-AzureParametersConfiguration), and a live Azure permission check (Test-AzurePermissions). Surfaced via the orchestrator's Validate mode.
- In/Out: In: parsed azure-parameters.json, live Az context for permission checks. Out: pass/fail results with actionable messages.
- Depends on: Az.Resources only for Test-AzurePermissions; rest is pure logic.
- Portability: Lab-scoped, but the pure validators (CIDR/overlap/name/partition/SKU) are dependency-free logic that ports directly to TS; the permission check would become ARM RBAC REST calls via proxy. Worth harvesting if the app grows any Azure-resource-creation wizard.

### LAB-15. Interactive menu framework and logging helper

- Source: `Azure/Labs/UnifiedLab/Core/Menu-Framework.ps1` | Maturity: production | Category: infra-tooling | Verdict: **platform-provided**
- Console UI toolkit: lab-preset deployment menu (8 presets), public/private lab-mode prompt, per-lab deployment-config builder, confirmation/progress/summary screens (Menu-Framework.ps1); plus Output-Helper.ps1 providing timestamped file logging (Initialize-LabLogging, Write-ToLog) and debug instrumentation (parameter/Azure-call/exception/operation-stopwatch logging) used by every phase script.
- In/Out: In: user keystrokes, config objects. Out: console menus, logs/UnifiedLab_<timestamp>.log files with optional debug detail.
- Depends on: Console host, local filesystem for logs.
- Portability: A React SPA and the app runtime replace console menus and file logging entirely - drop. The preset definitions (which component flags each of the 8 lab types toggles) are small data worth carrying over only if lab presets are ever surfaced in-app.

### LAB-16. UnifiedLab documentation set

- Source: `Azure/Labs/UnifiedLab/README.md` | Maturity: docs-only | Category: documentation | Verdict: **out-of-scope**
- Extensive docs: README (architecture, resource-sharing strategy, cost estimates, idempotency, private-mode AD DNS conditional-forwarder setup with PowerShell snippets, Azure DNS Private Resolver alternative, troubleshooting), QUICKSTART.md, CLAUDE.md (UnifiedLab vs DCR-Automation separation of concerns), docs/Location-Based-Naming.md, docs/TTL-Implementation.md.
- In/Out: In: n/a. Out: operator guidance.
- Depends on: None.
- Portability: Lab operation docs. The private-endpoint DNS guidance and the UnifiedLab-vs-DCR-Automation architecture explanation are candidate source material for in-app help content. CLAUDE.md still references the old Azure/dev/LabAutomation path (stale).

### LAB-17. AzureFlowLogLab orchestrator (interactive menu)

- Source: `Azure/Labs/AzureFlowLogLab/Run-AzureFlowLogLab.ps1` | Maturity: dev | Category: labs-testing | Verdict: **out-of-scope**
- Standalone predecessor lab entry point with interactive menu and non-interactive modes Full, VNetOnly, VPNOnly, FlowLogsOnly, CriblCollectorsOnly, TemplateOnly, Status, Validate; SkipConfirmation switch. Wraps prod/Deploy-AzureFlowLogLab.ps1.
- In/Out: In: prod/{azure,operation,onprem-connection,vm}-parameters.json, menu selections. Out: invokes the deployment engine; status/validation reports.
- Depends on: prod/Deploy-AzureFlowLogLab.ps1, Az modules.
- Portability: Complete and released (v1.0.0 in RELEASE_NOTES) but functionally superseded by UnifiedLab preset 4 (vNet Flow Log Lab); not referenced in the root README. Catalog only.

### LAB-18. AzureFlowLogLab deployment engine (VNet + VPN + dual-level flow logs + VMs)

- Source: `Azure/Labs/AzureFlowLogLab/prod/Deploy-AzureFlowLogLab.ps1` | Maturity: dev | Category: labs-testing | Verdict: **out-of-scope**
- 2,000-line engine deploying: /24 VNet with Gateway/Bastion/Security/O11y /27 subnets; per-subnet NSGs with on-prem allow rules; storage account with 00-99 collision-suffix retry; Log Analytics workspace; regional Network Watcher reuse; dual-level flow logs (vNet-level 7-day retention plus subnet-level overrides: Security 30-day, O11y 90-day - exploiting Azure's NIC>Subnet>vNet precedence); zone-redundant public IP + Basic VPN gateway + local network gateway + IPsec site-to-site connection with printed pfSense phase-1/phase-2 configuration instructions; optional Bastion; Ubuntu Standard_B1s test VMs (no public IPs) with 7 PM Eastern auto-shutdown; TemplateOnly dry-run mode and pre-deployment validation (Test-ExistingResources).
- In/Out: In: prod/*.json parameter files. Out: full flow-log lab environment; console pfSense config instructions; deployment summary.
- Depends on: Az.Network, Az.Storage, Az.Compute, Az.OperationalInsights; Connect-AzAccount session.
- Portability: Lab infrastructure; superseded by UnifiedLab phases 2/3/6/7/10. The dual-level flow-log retention pattern and pfSense guidance are documentation-grade knowledge, not app features.

### LAB-19. Flow-log Cribl collector generator with blob path auto-discovery

- Source: `Azure/Labs/AzureFlowLogLab/prod/Deploy-AzureFlowLogLab.ps1` | Maturity: dev | Category: pipeline-generation | Verdict: **needs-redesign**
- Generate-CriblCollectors function (line 1427): retrieves storage account keys and builds a connection string, interactively waits (60 s poll with keypress-timeout prompts) for the insights-logs-flowlogflowevent container to appear, scans up to 20 blobs to auto-discover per-flow-log flowLogResourceID=/... path prefixes via regex, then emits scheduled Cribl azure_blob collection-job JSONs (e.g. hourly job at :15 collecting the -75m..-15m window, time-partitioned path expressions, AzureFlowLogs breaker ruleset) into prod/cribl-collectors/, one per discovered flow log. Re-runnable via CriblCollectorsOnly mode.
- In/Out: In: deployed storage account + Network Watcher, flow-log naming convention (FlowLog-<vnet>[-<subnet>]). Out: prod/cribl-collectors/*.json scheduled collection configs with embedded connection string or secret references.
- Depends on: Az.Storage (Get-AzStorageAccountKey, Get-AzStorageBlob), console for interactive wait; storage account keys (secret handling required).
- Portability: FLAGGED PRODUCT-WORTHY: blob-path auto-discovery plus collector generation is exactly what an app-side 'onboard Azure flow logs' flow needs. Redesign: storage-key retrieval and blob listing via Azure Storage/ARM REST through proxy (note: interactive multi-minute wait loop becomes user-driven polling/refresh in UI), config output goes to Cribl collector API instead of local files. Overlaps the standalone vNetFlowLogDiscovery tool (discovery subsystem) - dedupe when planning.

### LAB-20. Sample vNet flow log event data (unbroken)

- Source: `Azure/Labs/AzureFlowLogLab/Azure_vNet_Flow_Event_Unbroken.json` | Maturity: dev | Category: labs-testing | Verdict: **direct**
- Real captured Azure vNet FlowLogFlowEvent payload: a records[] array of flow-log version 4 events with macAddress, flowLogResourceID/targetResourceID, and flowRecords.flows[].flowGroups[].flowTuples (comma-separated tuple strings) - in the raw 'unbroken' multi-record form exactly as Cribl receives it from blob storage, ideal for developing/testing event breakers and the flow-log preprocessing pipeline.
- In/Out: In: n/a (static file). Out: sample events for breaker/pipeline validation.
- Depends on: None.
- Portability: FLAGGED PRODUCT-WORTHY: static JSON usable as-is in browser TS - ship as a bundled sample for in-app breaker/pipeline testing (push to Cribl samples API or use in a preview pane). Should be scrubbed/verified: contains a real-looking subscription GUID and resource names.

### LAB-21. Azure blob collection-job template reference

- Source: `Azure/Labs/AzureFlowLogLab/prod/CollectorExample.json` | Maturity: dev | Category: pipeline-generation | Verdict: **direct**
- Canonical Cribl scheduled collection-job config for azure_blob flow-log ingestion with placeholder credentials (<replace me> clientId/tenantId/storageAccountName), textSecret reference (Azure_vNet_Flowlogs_Secret), the flowLogResourceID time-partitioned path expression, and full schedule/run tuning (cron, relative -75m..-15m window, task sizing) - the template the generators are derived from.
- In/Out: In: placeholder substitution values. Out: valid Cribl collection-job config.
- Depends on: Cribl Stream collection-job schema; references an Azure_vNet_FlowLogs-style breaker ruleset defined elsewhere.
- Portability: FLAGGED PRODUCT-WORTHY as seed data: a pure JSON template directly embeddable in the app's config-generation code (parameterize and POST to the Cribl API). No mechanism change needed for the template itself.

### LAB-22. AzureFlowLogLab documentation

- Source: `Azure/Labs/AzureFlowLogLab/QUICK_START.md` | Maturity: docs-only | Category: documentation | Verdict: **out-of-scope**
- Quick-start guide, README (architecture, dual-level flow-log design, cost table, NSG rules, pfSense config, troubleshooting matrix), and RELEASE_NOTES/v1.0.0.md version history for the standalone flow-log lab.
- In/Out: In: n/a. Out: operator guidance.
- Depends on: None.
- Portability: Lab docs; flow-log path-structure and timing knowledge (5-10 min container-creation latency, hourly blob layout) is useful background for the app's flow-log onboarding UX copy.

### LAB-23. HomeLab placeholder

- Source: `Dev/HomeLab` | Maturity: placeholder | Category: labs-testing | Verdict: **out-of-scope**
- Completely empty directory - no files, scripts, or documentation of any kind exist under Dev/HomeLab.
- In/Out: n/a
- Depends on: n/a
- Portability: Nothing to port or assess; presumably reserved for future on-premises home-lab automation. Cataloged so it is not silently dropped.


## v1 Monorepo Prior Analysis (cross-check) (V1)

SOC-OptimizationToolkit_v1 is the abandoned first attempt at a greenfield TypeScript hexagonal monorepo consolidating every capability in the Cribl-Microsoft repo; it stalled at Phase 0/1 (scaffold plus a walking-skeleton OnboardSource usecase and a seed DCR-name module, all other packages are one-line stubs). Its lasting value is documentary: CONTEXT.md contains a prior exhaustive feature census with a verified port-from map (original file paths and line numbers for every capability in the repo), docs/roadmap.md sequences the whole product into 11 phases, and 10 ADRs record the architecture decisions. The catalog below re-lists every census entry (path = the doc that records it, original source path in "what") plus the small amount of implemented v1 TypeScript worth carrying forward.

Reader-noted gaps: 1) Apps and adapters in v1 are confirmed stubs: all eight packages/adapters-* and packages/shared-config export a single constant, apps/service is a health-check HTTP shell, apps/desktop is a bare Electron shell, and apps/cli only drives the in-memory fakes — no additional hidden features there beyond what is cataloged. 2) The census cites specific line numbers in the legacy trees (Create-TableDCRs.ps1:396/1475/1633/2599, field-matcher.ts 862 lines, pack-builder.ts 3307 lines, sample-resolver.ts 1873 lines) recorded on 2026-06-22; the legacy trees have kept changing since (git status shows active edits to auth.ts, azure-deploy.ts, SetupWizard.tsx), so those anchors need re-verification by the readers covering Cribl-Microsoft_IntegrationSolution/ and Azure/. 3) The census references source trees I did not read (Dev/AWS, Lookups/, KnowledgeArticles/, Azure/dev/windows-schema-sync, Azure/Azure-LogCollection, packs/); my entries for those reflect the census description only and must be cross-checked against the readers assigned to those paths. 4) A successor SOC-OptimizationToolkit/ (v2) directory exists at the repo root (its files are being deleted/reworked per git status on branch feat/soc-optimization-toolkit); whichever reader covers it should reconcile against this v1 census, since v2 appears to have restarted from the same docs. 5) packages/core/assets contains real copies of the ARM templates and two .crbl packs (via scripts/import-assets.mjs), so the asset counts here are verified; the census's '~100 templates' corresponds to ~50 tables x 2 variants (DCE/NoDCE) observed on disk. 6) The .turbo/, .husky/, CI workflow and lint/build tooling in v1 are Phase 0 repo infrastructure with no user-facing feature value and were deliberately not cataloged as features.

### V1-01. Census: field-matcher 6-phase cascade

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: pipeline-generation | Verdict: **direct**
- Census entry for the field matcher: a 6-phase matching cascade with ALIAS_TABLE (300+ field aliases), COALESCE_PRIORITY, EVENT_TYPE_BOOSTS, and scoring, mapping vendor source fields to Sentinel table columns. Original source: Cribl-Microsoft_IntegrationSolution/src/main/ipc/field-matcher.ts (862 lines). Census destination: core/domain/field-matching. Listed in section 6 as a preserve-verbatim asset (the ALIAS_TABLE and scoring constants).
- In/Out: In: parsed sample fields + target table schema. Out: scored field-to-column mapping with coalesce/overflow decisions.
- Depends on: Pure TypeScript, no IO. Constants tables must be ported byte-exact.
- Portability: Already TypeScript and pure; runs in the browser as-is. Highest-value pure IP in the repo per the census; port with characterization tests against the legacy constants.

### V1-02. Census: sample parser (format detection)

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: pipeline-generation | Verdict: **direct**
- Census entry for the sample parser: format detection (CEF/CSV/JSON/KV/syslog), inner-_raw re-parse, PAN-OS positional field maps. Original source: Cribl-Microsoft_IntegrationSolution/src/main/ipc/sample-parser.ts. Census destination: core/domain/sample-parsing.
- In/Out: In: raw event samples (strings/Cribl capture JSON). Out: detected format + parsed field set per event.
- Depends on: Pure TypeScript; testing-strategy.md notes it currently imports fs/path and needs extract-then-move of the pure parts.
- Portability: Pure parsing logic ports directly to browser TS once the fs-coupled loading is separated (samples arrive via Cribl capture API or user upload instead of disk).

### V1-03. Census: KQL parser and DCR gap analysis

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: dcr-deployment | Verdict: **direct**
- Census entry for the KQL parser: parseTransformKql, analyzeDcrGap (compare a DCR transformKql against actual fields), generateRouteCondition. Original source: Cribl-Microsoft_IntegrationSolution/src/main/ipc/kql-parser.ts. Census destination: core/domain/kql.
- In/Out: In: DCR transformKql strings + field sets. Out: parsed transform AST, gap report, Cribl route condition expressions.
- Depends on: Pure TypeScript string/AST logic; needs extract-then-move from IO-mixed file per testing-strategy.md.
- Portability: Pure logic, direct port. DCR definitions to analyze come from Azure ARM API via proxy in the new app.

### V1-04. Census: reduction-rules knowledge base

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: pipeline-generation | Verdict: **direct**
- Census entry for the event-reduction rules knowledge base (per-format/per-vendor data reduction guidance applied when generating pipelines). Original source: Cribl-Microsoft_IntegrationSolution/src/main/ipc/reduction-rules.ts. Census destination: core/domain/reduction.
- In/Out: In: source type/format. Out: applicable reduction rules for pipeline functions.
- Depends on: Pure data + lookup logic in TypeScript.
- Portability: Static knowledge base; ships inside the SPA bundle unchanged.

### V1-05. Census: SIEM migration maps (Splunk/QRadar)

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: pipeline-generation | Verdict: **direct**
- Census entry for SIEM migration mappings: SPLUNK_* and QRADAR_* maps translating legacy SIEM configurations toward Cribl/Sentinel equivalents, surfaced via the SiemMigration GUI page. Original source: Cribl-Microsoft_IntegrationSolution/src/main/ipc/siem-migration.ts. Census destination: core/domain/siem-migration.
- In/Out: In: Splunk/QRadar config artifacts or source descriptors. Out: mapped Cribl/Sentinel migration recommendations.
- Depends on: Pure data tables + mapping logic in TypeScript.
- Portability: Pure maps; direct browser port. Any file ingestion of legacy SIEM configs becomes user upload in the SPA.

### V1-06. Census: change-detection fingerprint + diff taxonomy

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: pack-management | Verdict: **direct**
- Census entry for change detection: content fingerprinting plus a diff taxonomy used to detect when schemas/samples/configs changed. Original source: Cribl-Microsoft_IntegrationSolution/src/main/ipc/change-detection.ts. Census destination: core/domain/change-detection with the IO split to adapters-fs.
- In/Out: In: two versions of an artifact (schema/sample/config). Out: fingerprint hashes + classified diff set.
- Depends on: Pure hashing/diff logic (currently imports crypto/fs per testing-strategy.md, needing extraction). Snapshot persistence needed.
- Portability: Fingerprint/diff logic is pure and ports directly (Web Crypto for hashing); snapshot storage moves from local files to the app KV store.

### V1-07. Census: DCR naming + schema-mapping pure logic

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: dcr-deployment | Verdict: **direct**
- Census entries for the PowerShell-resident pure DCR logic, all from Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1: the DCR name abbreviation map (line ~2599, CommonSecurityLog->CSL etc., 30-char Direct / 64-char DCE limits), ConvertTo-DCRColumnType (line ~396, 25+ type aliases to 8 DCR types, guid->string), and Get-TableColumns disambiguation (line ~1475: standardColumns vs columns, MMA table detection, TenantId-only heuristic, reserved-column blocklist, _CL normalization, per-table ARM column injection). Census destinations: core/domain/dcr-naming and core/domain/dcr-schema. All listed as preserve-verbatim assets in section 6.
- In/Out: In: table names, Log Analytics schema JSON. Out: compliant DCR/DCE names, DCR-typed column lists, sanitized ARM template column blocks.
- Depends on: Pure logic once re-implemented in TS; schema inputs come from Azure ARM/Log Analytics API. Line numbers are census-time references and must be re-verified.
- Portability: Re-implement PowerShell logic as browser TS (the v1 dcr-name.ts already seeds this). Census mandates byte-exact characterization tests captured from the legacy script first.

### V1-08. Census: Cribl destination config shaping from DCR

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: dcr-deployment | Verdict: **direct**
- Census entry for Cribl destination export shaping: Fix-HandlerControlEndpoint regex (Create-TableDCRs.ps1 line ~1633) and Get-CriblConfigFromDCR (Generate-CriblDestinations.ps1 line ~41), which read back the DCR logsIngestion endpoint and emit Cribl sentinel destination JSON (DCR ID, ingestion endpoint, stream name, quoted client ID). Census destination: core/domain/cribl-destination.
- In/Out: In: deployed DCR resource JSON (immutableId, logsIngestion endpoint) + Azure app credentials. Out: Cribl Sentinel destination config objects.
- Depends on: Pure shaping logic; DCR read-back requires Azure ARM API (proxy) and destination creation uses the Cribl product REST API.
- Portability: Shaping is pure TS, direct. In the new app the output goes straight to the Cribl outputs API instead of JSON files on disk — a strict upgrade over the legacy export-then-import flow.

### V1-09. ARM template + prebuilt pack asset library (v1 copy)

- Source: `SOC-OptimizationToolkit_v1/packages/core/assets/README.md` | Maturity: production | Category: dcr-deployment | Verdict: **direct**
- Pure-data assets actually imported into v1 by scripts/import-assets.mjs: ~100 Sentinel native-table ARM templates in both DataCollectionRules(DCE) and DataCollectionRules(NoDCE) variants (copied from Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables/), plus prebuilt Cribl packs cloudflare-sentinel_0-5-8.crbl and AzureFlowLogs.crbl (from packs/ and Azure/dev/Azure_vNet_FlowLogs/). Census says the DCR engine submits templates unchanged and the Cribl client installs the packs.
- In/Out: In: none (static data). Out: ARM deployment payloads per table; .crbl packs installable into a worker group.
- Depends on: None at rest. Deployment uses Azure ARM API via proxy; pack install uses the Cribl product /packs API.
- Portability: Bundle the JSON templates in the SPA (or app assets) and submit via ARM REST through proxies.yml; ship .crbl binaries as app assets and install via the Cribl packs API. Treat as immutable data refreshed from the source-of-truth trees.

### V1-10. Census: end-to-end onboarding orchestrator

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: pipeline-generation | Verdict: **needs-proxy**
- Census entry for the e2e onboarding state machine: research -> custom tables -> deploy DCRs -> build/locate pack -> embed destinations -> create Cribl destinations -> upload .crbl, with idempotent skip semantics and streamed progress. Original source: Cribl-Microsoft_IntegrationSolution/src/main/ipc/e2e-orchestrator.ts. Census destination: core/usecases/OnboardSource with an injected ProgressSink (roadmap Phase 5).
- In/Out: In: vendor/source descriptor, target workspace, samples. Out: created tables, deployed DCRs, built pack, installed Cribl destinations; progress event stream.
- Depends on: Azure ARM API (proxy), Cribl product API (native fetch), sample/pack assets, state persistence for idempotency.
- Portability: The orchestration is port-based TS and ports well; Azure calls go through proxies.yml and Cribl calls through the product API. Long steps must respect the 30s request timeout and 100 req/min limit — implement as resumable steps with state checkpointed in the KV store and ARM async operations polled.

### V1-11. Census: DCR/DCE/AMPLS deployment engine

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: dcr-deployment | Verdict: **needs-redesign**
- Census entry for the full DCR deploy engine: Direct DCR creation (30-char), DCE-based DCR + DCE + AMPLS/Private Link wiring (64-char, order-sensitive create-then-link), custom _CL table creation, MMA->DCR migration, seven deployment modes (DirectNative/DirectCustom/DirectBoth/DCENative/DCECustom/DCEBoth/TemplateOnly), and Cribl destination export with logsIngestion read-back. Original source: Azure/CustomDeploymentTemplates/DCR-Automation/core/Create-TableDCRs.ps1 (~3356-4600 lines) plus Run-DCRAutomation.ps1. Roadmap Phase 4 flags this as the hardest port (AMPLS ordering, logsIngestion not surfaced by cmdlets, reserved-column 400s).
- In/Out: In: azure-parameters.json/operation-parameters.json equivalents, table lists, custom-table schemas. Out: deployed DCRs/DCEs/AMPLS links, created _CL tables, generated ARM templates, Cribl destination configs.
- Depends on: Azure ARM REST (management.azure.com via proxy) replacing Az PowerShell modules; the ARM template assets; Azure AD token acquisition.
- Portability: PowerShell + local JSON config + interactive menu -> browser TS calling ARM REST via proxy, config in KV, TemplateOnly mode becomes in-browser template generation with download. ARM deployments are async: poll operation status within the timeout budget. The under-documented behaviors (AMPLS ordering, reserved columns, MMA migration) are the re-encode risk the roadmap warns about.

### V1-12. Census: Cribl client with load-bearing overrides

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: infra-tooling | Verdict: **needs-redesign**
- Census entry (also ADR 0005/0007) for the hand-won Cribl client behavior in Cribl-Microsoft_IntegrationSolution/src/main/ipc/auth.ts (~2000 lines, Cribl paths): cloud OAuth + self-managed login with token cache, cloud-vs-self-managed audience/base selection, destination create/list, the /packs PUT-then-install conflict-delete-retry, and multi-path version-drift probing. Census destination: adapters-cribl + Keystore port. Section 6 preserve-verbatim.
- In/Out: In: Cribl credentials (cloud client id/secret or self-managed user/pass), pack tarballs, destination configs. Out: authenticated Cribl API session, installed packs, created destinations.
- Depends on: Cribl REST API. In the target platform, leader auth is provided by the app runtime; only remote/cross-instance auth would need the KV store + token endpoints via proxy.
- Portability: Auth to the hosting leader is platform-provided (drop the OAuth/self-managed login machinery for the local instance). The PUT-then-install conflict-delete-retry and version-probing logic remain load-bearing and port as TS over the product /packs and outputs endpoints declared in policies.yml. Keystore -> app KV store.

### V1-13. Census: Azure auth/session and schema retrieval path

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: identity-auth | Verdict: **needs-redesign**
- Census entry for the Azure side of auth.ts plus azure-deploy.ts (which currently shells PowerShell and scrapes stdout, zero @azure imports): Azure connection/token lifecycle, list subscriptions/workspaces/resource-groups, set context, create RG + Log Analytics workspace, enable Sentinel, table schema retrieval, KQL queries, permission/can-deploy preflight. Census destination: adapters-azure on @azure/identity + @azure/arm-* (roadmap Phase 3).
- In/Out: In: tenant/client credentials or interactive login. Out: ARM tokens, subscription/workspace inventory, table schemas, KQL results.
- Depends on: login.microsoftonline.com token endpoint + management.azure.com + api.loganalytics.io, all via proxies.yml; secrets in the KV store.
- Portability: The Connect-AzAccount window and stdout token scrape are exactly what the roadmap wanted to kill; in the SPA use client-credential (or device-code) flows against the token endpoint via proxy, tokens cached in KV. All ARM/Log Analytics operations are plain HTTPS JSON — well suited to the proxy model.

### V1-14. Census: pack builder (.crbl emitter)

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: pack-management | Verdict: **needs-redesign**
- Census entry for the pack builder: builds .crbl custom tarballs with deep Cribl pipeline-conf YAML generation and CrowdStrike breaker special-casing; the census also folds in the standalone Cribl pack packaging automation (Azure/dev/Packs/Cribl_Pack_Packaging/Run-PackageAutomation.ps1). Original source: Cribl-Microsoft_IntegrationSolution/src/main/ipc/pack-builder.ts (3307 lines). Census destination: adapters-fs + core with pure sub-parts extracted; roadmap Phase 6 calls it the heaviest, most format-coupled port with byte-pinned golden-file tests.
- In/Out: In: field mappings, pipelines, samples, lookups, pack metadata. Out: a .crbl (tar.gz) pack installable in Cribl Stream.
- Depends on: Currently Node fs + tar; needs an in-browser tar/gzip implementation (pure JS libraries exist). Upload via the Cribl /packs API.
- Portability: YAML/pipeline generation logic is pure and ports directly; the packaging mechanism changes from filesystem tar to in-memory tar.gz built in the browser, then pushed to the Cribl packs API or offered as a download. Golden-file byte-pinning against legacy output is the stated port gate.

### V1-15. Census: sample resolver (tiered acquisition)

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: pipeline-generation | Verdict: **needs-redesign**
- Census entry for the sample resolver: tiered acquisition of representative event samples (local files, defaults, repo fetch, live capture). Original source: Cribl-Microsoft_IntegrationSolution/src/main/ipc/sample-resolver.ts (1873 lines). Census destination: adapters-fs (roadmap Phase 6). Related census entry: default-samples in the frontend support modules.
- In/Out: In: source/vendor identity + optional user-provided samples. Out: a resolved sample set with provenance tier.
- Depends on: Cribl capture/samples APIs (product REST), GitHub raw fetch via proxy, KV store for cached samples; loses local-filesystem tiers.
- Portability: Redesign the tier list for the platform: Cribl live capture and stored samples via product API become the primary tiers (an improvement), GitHub/vendor sample fetch goes through the proxy, user file upload replaces local-disk scanning.

### V1-16. Census: vendor research (schema fetch + normalization)

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: discovery | Verdict: **needs-proxy**
- Census entry for vendor research: fetching vendor documentation/schema sources and normalizing field definitions to seed field matching. Original source: Cribl-Microsoft_IntegrationSolution/src/main/ipc/vendor-research.ts. Census destination: adapters-fs (roadmap Phase 6).
- In/Out: In: vendor/product name or doc URL. Out: normalized vendor field schema.
- Depends on: Outbound HTTPS to vendor doc sites (each domain must be declared in proxies.yml, which constrains arbitrary-domain fetching); normalization logic is pure TS.
- Portability: Normalization ports directly. The fetch side is proxy-constrained: arbitrary vendor domains cannot all be pre-declared, so either enumerate the supported doc sources in proxies.yml or route research through an AI/API intermediary (e.g. Anthropic API) that is declared.

### V1-17. Census: Sentinel content repo + two-layer EDR blocklist + registry sync

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: pack-management | Verdict: **needs-redesign**
- Census entry for ContentRepo: selective fetch of the Azure-Sentinel GitHub content repo, a two-layer EDR blocklist (CrowdStrike content suppression with crash-detection logic, preserve-verbatim per section 6), and registry sync. Original sources: Cribl-Microsoft_IntegrationSolution/src/main/ipc/sentinel-repo.ts and .../registry-sync.ts. Census destination: adapters-fs (ContentRepo port), roadmap Phase 6; also carries GitOps commit/PR duties for Phase 9.
- In/Out: In: content selectors (tables/parsers/solutions). Out: fetched Sentinel content, blocklist-filtered file set, synced registry state.
- Depends on: github.com / raw.githubusercontent.com + GitHub API via proxy; KV store replaces the local repo cache; blocklist data ships as pure app data.
- Portability: The blocklist tables and filtering logic are pure and port directly (the crash-detection layer, which watches local EDR kills of the Electron process, is moot in a browser — keep only the static suppression layer). Selective fetch becomes GitHub API calls via proxy with KV caching instead of a local clone.

### V1-18. Census: source discovery (Event Hub + vNet Flow Logs)

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: discovery | Verdict: **needs-proxy**
- Census entry for discovery: Event Hub discovery optimized via Azure Resource Graph, and vNet Flow Log discovery, each generating Cribl source configs and feeding onboarding. Original sources: Azure/dev/EventHubDiscovery/, Azure/vNetFlowLogs/vNetFlowLogDiscovery/Run-vNetFlowLogDiscovery.ps1, Azure/dev/vNetFlowLogDiscovery/, and the GUI Discovery.tsx page. Census destination: core/usecases/DiscoverSources + adapters-azure on @azure/arm-resourcegraph (roadmap Phase 5).
- In/Out: In: Azure subscription scope + credentials. Out: inventory of Event Hubs / NSG-vNet flow log configurations + generated Cribl source configs.
- Depends on: Azure Resource Graph and ARM REST APIs via proxy; storage account access (SAS/RBAC) for flow log validation; Cribl source creation via product API.
- Portability: Resource Graph queries are single POST calls that fit the proxy model well; config generation is pure TS. Creating the resulting Cribl sources through the product API closes the loop the PowerShell version left manual.

### V1-19. Census: Azure lab automation

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: labs-testing | Verdict: **out-of-scope**
- Census entry for lab automation: self-contained Azure test environments (VNet/NSG/Storage/VMs/monitoring) with sample-data seeding. Original sources: Azure/Labs/UnifiedLab/Run-AzureUnifiedLab.ps1 (863-line orchestrator + phase scripts), Azure/Labs/AzureFlowLogLab/Run-AzureFlowLogLab.ps1, Azure/dev/LabAutomation/, and the LabAutomation.tsx GUI page. Census destination: core/usecases/ProvisionLab + adapters-infra (Bicep/Terraform), roadmap Phase 7.
- In/Out: In: lab profile + Azure credentials. Out: provisioned/torn-down test environment with flowing sample data.
- Depends on: Bicep/Terraform runners (local processes), VM provisioning, long-running deployments — plus ARM REST for the pure-ARM subset.
- Portability: Test/dev infrastructure, not a product feature for the Cribl app; additionally the Terraform/Bicep runner and VM seeding need local processes and exceed the 30s/100-rpm proxy budget. If ever wanted, the pure-ARM subset could be redesigned as ARM REST deployments, but catalog it as out-of-scope.

### V1-20. Census: Azure-LogCollection policy automation

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: dcr-deployment | Verdict: **needs-redesign**
- Census entry for policy-driven log-collection automation: Azure Policy plus Event Hub architecture that configures diagnostic-settings log routing at scale. Original source: Azure/Azure-LogCollection/Run-AzureLogCollection.ps1 (has its own CLAUDE.md). Census destination: core/usecases/ConfigureLogCollection + adapters-azure PolicyClient on @azure/arm-policyinsights (roadmap Phase 7).
- In/Out: In: policy scope (subscription/RG), Event Hub target, resource-type selections. Out: assigned Azure Policies routing resource logs to Event Hub for Cribl collection.
- Depends on: Azure Policy + PolicyInsights + ARM REST via proxy; replaces Az PowerShell modules.
- Portability: Policy definition/assignment/remediation are ARM REST operations that fit the proxy; the PowerShell orchestration and local parameter files become TS + KV. Remediation tasks are async and need polling.

### V1-21. Census: AWS source connector + AWS lab

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: pipeline-generation | Verdict: **needs-redesign**
- Census entry (and ADR 0008/roadmap Phase 8) for AWS as a data source: Terraform deploys VPC/S3+SQS/Kinesis/CloudWatch/EC2/IAM lab infrastructure, and Python generates the Cribl source configs (S3+SQS event notifications, Kinesis, CloudWatch, IAM roles for Cribl auth) so Cribl collects AWS data and forwards it to Sentinel. Original source: Dev/AWS/Labs/AWSIntegrationLab/ (Run-AWSIntegrationLab.py, Core/terraform/, Generate-CriblConfigs.py, helpers/naming_engine.py). Section 6 preserve-verbatim: the config-generation rules and naming_engine.py.
- In/Out: In: AWS account/resource identifiers + credentials. Out: Cribl source configs (S3/Kinesis/CloudWatch) + IAM roles/policies; lab: provisioned AWS test environment.
- Depends on: Cribl source config generation is pure logic (port Python->TS); IAM/S3/SQS setup needs AWS APIs via proxy with SigV4 signing (keys in KV); Terraform lab part needs local processes.
- Portability: Split it: the naming engine + Cribl source-config shaping rules port directly to TS with characterization tests; IAM/SQS wiring is doable via AWS REST APIs through proxies.yml (SigV4 in browser TS); the Terraform lab provisioning is out-of-scope/not-portable and should stay a standalone tool.

### V1-22. Census: autonomous AI schema-drift engine

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: ai-automation | Verdict: **needs-redesign**
- Census entry (and ADR 0009/roadmap Phase 9) for windows-schema-sync: monitors Windows Security Event schemas from Microsoft docs and the Sentinel SecurityEvent table, Claude extracts/infers schemas, detects drift deterministically, AI-generates/updates Cribl packs, commits via GitOps (GitHub Actions, daily), tracks token cost (~$0.70/run); plus deterministic deploy helpers (Deploy-AMA/KeyVault/Sentinel/DCR/GitHubWorkflow/IncrementalOnboarding.ps1, Sync-SchemaFromAzure.ps1, Compare-TableData.ps1). Original source: Azure/dev/windows-schema-sync/. Section 6 preserve-verbatim: the embedded AI prompts as versioned assets.
- In/Out: In: MS doc pages, Sentinel table schemas, existing packs, Anthropic API key. Out: drift reports, AI-generated pack updates, GitOps PRs, cost ledger.
- Depends on: Anthropic API + learn.microsoft.com + GitHub API + Azure ARM, all proxy-declared; KV for schema snapshots and cost tracking; no scheduler in the platform.
- Portability: The Claude calls, doc fetches, drift diffing, and pack generation all fit fetch-via-proxy; prompts port as versioned string assets with golden-output tests. The autonomous daily-cron loop must be redesigned: user-triggered or externally scheduled runs, with state and last-known-good in KV, and generated packs gated behind a human review before install (the census requires PR-not-autodeploy anyway).

### V1-23. Census: enrichment lookups (AD/LDAP + static)

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: enrichment | Verdict: **needs-redesign**
- Census entry for enrichment: Active Directory via LDAP -> CSV -> Cribl Cloud lookup -> commit/deploy (Lookups/DynamicLookups/ActiveDirectory/main.py) and static lookups (Lookups/StaticLookups/). Census destination: core/usecases/SyncLookup + adapters-fs LookupSource + adapters-cribl lookup upload (roadmap Phase 10). Section 6 preserve-verbatim: the AD attribute set and UPN/NetBIOS/plain credential handling.
- In/Out: In: AD/LDAP directory (attributes per the preserved set) or static CSV data. Out: CSV lookup files uploaded and committed/deployed to Cribl.
- Depends on: LDAP is not HTTPS and cannot traverse the platform proxy; Cribl lookup upload/commit/deploy uses the product REST API; static lookups are pure data.
- Portability: Static lookups and the CSV shaping/upload flow port directly onto the Cribl lookups API. On-prem LDAP collection is not reachable from a sandboxed browser: redesign to Microsoft Graph (Entra ID) via proxy for cloud directories, and keep the preserved AD attribute set as the field contract; pure on-prem AD sync remains an external feeder.

### V1-24. Census: O365/Entra app-registration validation

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: identity-auth | Verdict: **needs-proxy**
- Census entry for identity preflight: validating the O365/Entra app registration and the exact Graph permission set Cribl needs for O365 collection. Original sources: KnowledgeArticles/O365AppRegistrationForCribl/dev/Run-O365PermissionValidation.ps1 and Test-O365AppPermissions.ps1. Census destination: core/usecases/ValidateAppRegistration + adapters-identity (Microsoft Graph), roadmap Phase 10. Section 6 preserve-verbatim: the required Graph permission set.
- In/Out: In: tenant id, app (client) id, client secret. Out: pass/fail per required Graph permission with remediation guidance.
- Depends on: login.microsoftonline.com + graph.microsoft.com via proxies.yml; client secret in KV.
- Portability: Pure API validation flow — acquire a token, enumerate granted roles/consents, diff against the preserved permission set. Fits the proxy model cleanly; the PowerShell wrapper is trivially replaced by TS.

### V1-25. Census: PowerBI + Cribl Search reporting

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: reporting | Verdict: **needs-proxy**
- Census entry for reporting: exporting Cribl Search results into PowerBI. Original source: KnowledgeArticles/PowerBI_CriblSearch/PowerBI_CriblSearch.py. Census destination: core/usecases/ExportToReporting + adapters-reporting (roadmap Phase 10).
- In/Out: In: Cribl Search query + PowerBI target. Out: search results pushed to PowerBI datasets (or downloadable CSV).
- Depends on: Cribl Search via the product REST API (platform capability 1); PowerBI REST API (api.powerbi.com) via proxy with AAD auth.
- Portability: Cribl Search access is actually easier in-platform than in the Python original. PowerBI push goes through the proxy; alternatively generate CSV in-browser for download when PowerBI wiring is not configured.

### V1-26. Census: desktop GUI page set (12 pages)

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: infra-tooling | Verdict: **needs-redesign**
- Census entry for the frontend: all 12 React pages of the Electron app — core-pipeline pages SentinelIntegration (~3500 lines per ADR 0003), DcrAutomation, PackBuilder, Packs (browser), SiemMigration, RepoSetup, Discovery, LabAutomation; support pages SetupWizard (first-run config), Settings (global config), DataFlow (lineage/flow visualization), DepsCheck (dependency + permission validation). Original source: Cribl-Microsoft_IntegrationSolution/src/renderer/pages/*.tsx. Census destination: apps/desktop as presentation-only shells (roadmap Phases 1-6).
- In/Out: In: user interaction. Out: rendered workflows over the underlying usecases.
- Depends on: React/TypeScript (already); the window.api Electron IPC layer must be replaced by direct fetch to Cribl/proxied APIs.
- Portability: These are React SPA pages already, so they are the natural UI skeleton for the Cribl app; the redesign is the data layer (IPC -> fetch/KV) and dropping Electron-specific pages (DepsCheck local-dependency checks, parts of Settings). ADR 0003 warns SentinelIntegration.tsx mixes ~3500 lines of logic into the view — extract logic before porting.

### V1-27. Census: dependency + permission preflight (CheckReadiness)

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: infra-tooling | Verdict: **needs-redesign**
- Census entry for the preflight capability behind the DepsCheck page: local dependency validation plus Azure permission/can-deploy checks. Original sources: Cribl-Microsoft_IntegrationSolution/src/main/ipc/deps.ts and permission-check.ts. Census destination: core/usecases/CheckReadiness + adapters-fs/azure (roadmap Phase 6).
- In/Out: In: configured credentials/scope. Out: readiness report (dependencies present, RBAC roles sufficient, endpoints reachable).
- Depends on: Azure ARM permissions API (Microsoft.Authorization) via proxy; Cribl API health via product API; local dependency checks (PowerShell, Az modules, Node) become moot.
- Portability: Drop the host-dependency half (platform-provided runtime); keep and port the valuable half — Azure RBAC/permission preflight (checkAccess/permissions ARM calls) and Cribl connectivity checks — as fetch-based validations.

### V1-28. Census: frontend support modules + multi-frontend seam

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: infra-tooling | Verdict: **needs-redesign**
- Census entries for the supporting plumbing: declarative param-forms schema with integration-mode gating (pure, lands in packages/shared-config), default samples, config/app-paths/logger/github modules (Cribl-Microsoft_IntegrationSolution/src/main/ipc/{param-forms,default-samples,config,app-paths,logger,github}.ts); and the channel<->route convention where each capability is one stable name across desktop IPC and HTTP (auth:status <-> GET /api/auth/status) via src/server/electron-stub.ts + api-router.ts + event-bus.ts (SSE), plus the Run-DCRAutomation.ps1 -NonInteractive automation entry point that the census maps to an oclif CLI.
- In/Out: In: capability invocations + config values. Out: rendered parameter forms, persisted config, progress event streams, automation entry points.
- Depends on: param-forms is pure data + validation (direct); config/app-paths/logger use local fs (KV instead); github.ts uses GitHub API (proxy); the IPC/SSE seam and CLI are transport layers.
- Portability: param-forms ports directly and is a good fit for driving SPA forms. The three-frontend seam largely dissolves in a single-SPA platform: ProgressSink becomes in-app state/polling, SSE/IPC and the CLI entry are platform-superseded. Config persistence moves to the app KV store.

### V1-29. Census: future extension placeholders + reference docs

- Source: `SOC-OptimizationToolkit_v1/CONTEXT.md` | Maturity: docs-only | Category: documentation | Verdict: **out-of-scope**
- Census catalog of everything else so nothing is silently dropped: Microsoft Fabric RTI as a possible future alternative destination (Azure/dev/FabricRTI/, empty), Sentinel pack library (Azure/SentinelPacks/, empty), Home lab (Dev/HomeLab/, empty), the Azure Monitor->Sentinel migration guide (KnowledgeArticles/AzureMonitorMigration/), the Private Link/AMPLS configuration guide (KnowledgeArticles/PrivateLinkConfiguration/), architecture diagrams (Azure/Diagrams/), and the from-source app launchers (Start-App-Windows.bat / Start-App-macOS.sh, kept from-source to avoid EDR false positives).
- In/Out: In/out: none (empty placeholders and reference documents).
- Depends on: None.
- Portability: Placeholders carry no code; the migration/AMPLS guides are reference material whose logic is covered by the DCR engine feature; launchers are host-specific and platform-superseded. Catalog only.

### V1-30. v1 implemented: DCR name abbreviation in TypeScript

- Source: `SOC-OptimizationToolkit_v1/packages/core/src/domain/dcr-name.ts` | Maturity: experimental | Category: dcr-deployment | Verdict: **direct**
- Working, unit-tested TS port seed of the Direct DCR naming logic from Create-TableDCRs.ps1 (~2599): DIRECT_DCR_MAX = 30, abbreviateTableName with a 4-entry seed map (CommonSecurityLog->CSL, SecurityEvent->SecEvt, WindowsEvent->WinEvt, DeviceEvents->DevEvt), and toDirectDcrName (prefix-abbrev-location join, 30-char truncation, trailing-hyphen trim). Tests in dcr-name.test.ts cover abbreviation, passthrough, limit, and truncation.
- In/Out: In: table name, prefix, location. Out: compliant Direct DCR name <= 30 chars.
- Depends on: None — pure TypeScript, zero imports.
- Portability: Drops into the Cribl app unchanged. It is only a seed: the full abbreviation map (and the 64-char DCE variant) still has to be extracted verbatim from Create-TableDCRs.ps1 per the census's characterization-test rule.

### V1-31. v1 implemented: OnboardSource usecase + ports + fakes

- Source: `SOC-OptimizationToolkit_v1/packages/core/src/usecases/onboard-source.ts` | Maturity: experimental | Category: pipeline-generation | Verdict: **direct**
- The Phase 1 walking-skeleton orchestration in working, tested TS: OnboardSource wires SourceConnector -> DcrDeployer (Direct DCR via toDirectDcrName) -> CriblClient.createSentinelDestination, streaming source/dcr/cribl/done events through a ProgressSink. Companion files: src/ports/index.ts (port interfaces: ProgressSink, SentinelClient, DcrDeployer, SourceConnector, CriblClient, OnboardInput/Result) and src/testing/index.ts (FakeSourceConnector, FakeDcrDeployer, FakeCriblClient, RecordingProgressSink), with an end-to-end unit test asserting the full sequence. apps/cli/src/index.ts drives it against the fakes as an in-memory demo.
- In/Out: In: { sourceTable, location, dcrPrefix? }. Out: { sourceType, dcrName, dcrId, criblDestinationId } plus a progress event stream.
- Depends on: Pure TypeScript against its own port interfaces; real adapters were never built (all adapters-* packages are one-line stubs).
- Portability: The usecase, port interfaces, and in-memory fakes port to the browser as-is and are a sound seam design for the Cribl app: implement DcrDeployer as ARM-via-proxy fetch, CriblClient as product-API fetch, ProgressSink as UI state. The hexagonal port pattern maps naturally onto the platform's fetch/proxy split.

### V1-32. v1 documentation set: census, roadmap, ADRs, architecture/testing/CI docs

- Source: `SOC-OptimizationToolkit_v1/docs/roadmap.md` | Maturity: docs-only | Category: documentation | Verdict: **out-of-scope**
- The prior-analysis corpus itself: CONTEXT.md (full-repository capability census, ubiquitous language table for DCR/DCE/AMPLS/_CL/transformKql/overflow-column/coalesce-priority, port-from map with verified paths and line numbers, and the section-6 preserve-verbatim asset list); docs/roadmap.md (11 phases 0-10 with per-phase capabilities, deliverables, exit criteria, kill criteria); docs/architecture.md (hexagonal ports/adapters design with a full port table); docs/testing-strategy.md (characterization-from-legacy-FIRST rule, test pyramid, extract-then-move); docs/ci-cd.md (pipeline design); docs/adr/0001-0010 (record ADRs, TypeScript-over-Python, hexagonal, greenfield dir, pin-and-vendor Cribl client, strangler-fig fallback, official Cribl TS SDK + override shim, Sentinel-destination/pluggable-sources, AI-assisted pack generation, vertical slices/walking skeleton).
- In/Out: In: none. Out: the feature inventory, sequencing plan, and decision log for consolidating this repo.
- Depends on: None.
- Portability: Not a runtime feature, but the single best planning input for the Cribl app: the census enumerates every capability with source paths, the preserve-verbatim list names the load-bearing constants (ALIAS_TABLE, abbreviation map, reserved-column blocklist, EDR blocklist, Cribl client overrides, AI prompts, AD attribute set, O365 permission set), and ADRs 0005/0007/0008/0009 record hard-won constraints (Cribl API version drift, Sentinel-is-the-only-destination, AI quarantine) that still apply. Reuse it to seed the new app's backlog and test plan.


## Coverage notes (manual audit)

The automated completeness audit did not run (agent quota); the following was verified manually instead:

- `.github/workflows/soc-optimization-toolkit-ci.yml` is CI for the renamed v1 monorepo; its path filters no longer match anything and it is now vestigial. Not a product feature; should be removed or rewritten for the new app.
- Root `Start-App-Windows.bat` / `Start-App-macOS.sh` launch the Integration Solution Electron app from source (deliberately unpackaged to avoid EDR false positives). Superseded entirely by the Cribl App Platform distribution model.
- `Cribl-Microsoft_IntegrationSolution/tests/` (unit/DOM test suites) was not cataloged as a feature; its test patterns are relevant to the new app's testing strategy.
- Generated-output directories (generated-templates, cribl-dcr-configs, eventhub-discovery-results, cribl-destinations, dist) were intentionally excluded.
- The v1 section (V1-*) intentionally overlaps other sections; it is a cross-check from the abandoned monorepo's own census, not additional scope.
