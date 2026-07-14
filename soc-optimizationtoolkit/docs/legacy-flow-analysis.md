# Legacy Flow Analysis: Setup Wizard + Sentinel Integration

From the reference screenshots (docs/ui-reference/00-setup-wizard, 01-sentinel-integration). Two purposes: (1) the visual/UX bar to match, (2) where the legacy WORKFLOW must be refactored because the new app lives in Cribl (a sandboxed browser iframe), not Electron on the operator's machine.

## The structural insight: the Integrate arc is ONE numbered-section page

The legacy Sentinel Integration flagship is a SINGLE scrolling page with numbered step sections that gate forward and a deploy readiness that accumulates:

1. Sentinel Solution (search + select; 452 active / 97 deprecated)
2. Sample Data (paste / upload / browse; per log-type name; "Select a solution first" gate)
3. Azure Resources (subscription / workspace / RG / location; live permission check; DCE / metrics / role-assignment checkboxes)
4. Cribl Configuration (worker-group multi-select; pack name)
   - DCR Gap Analysis (per log-type stat cards; APPROVAL REQUIRED before build; Auto-Approve All)
   - Analytics Rule Coverage (fully/partial/total; per-rule severity + coverage %; missing-fields-by-frequency; upload custom YAML)
5. Deploy (readiness pills: Solution / Samples / Mappings / Workspace / Worker Groups / Pack Name; per-log-type summary; Deploy All, each step re-runnable)

This is what the user meant by "I liked that flow better." The new app's Unit 6.5 put these as SEPARATE sidebar routes (Targeting, Onboard, Review, Batch). The flagship's power is that everything is on one page, the numbered sections show progress in place, and deploy readiness is always visible. DECISION NEEDED (see end): make the Integrate arc a single numbered-section page composing the existing screens as sections, rather than separate routes. The journey rail (Unit 6.5) still frames first-run and the arc's position; the Integrate arc itself becomes one page.

## Visual / interaction patterns to adopt (the bar)

- Numbered circle step badges (blue = current, green check = complete) with an info-tip per step.
- Progressive gating with an explicit reason ("Select a solution first" in amber) - matches our always-visible-disabled rule.
- The gap-analysis stat vocabulary is domain gold, keep it verbatim: Source Fields / Dest Columns / Passthrough / DCR Handles / Cribl Handles / Overflow, plus "Cribl handles: N rename(s), M coercion(s)".
- Review-before-apply: "Field Mappings (X mapped, Y unmapped) - Approval Required" with expand-to-review and Auto-Approve All. This is the consent moment; our Unit 7 acknowledge gate and Unit 18 mapping review must feel like this.
- Rule coverage: three-way count header, per-rule severity chip + coverage %, "N missing" callout, missing-fields-by-frequency chips, custom-YAML upload.
- Deploy readiness pills (one per satisfied prerequisite) + honest per-log-type count summary + a single Deploy All, each sub-step independently re-runnable.
- Setup wizard: 3-segment progress bar, radio CARDS with a Recommended badge, a Connections + Repositories status footer, Back / Get Started.
- Colored status dots (green ready), amber warnings, red for blocking/missing - a consistent state palette.

## Cribl-app REFACTORS (legacy assumed Electron + local machine)

Each legacy mechanism that depends on the operator's machine must change for the Cribl-hosted iframe. Most are already solved in shipped units; noting the mapping so the redesign wires the RIGHT workflow, not a screenshot clone.

| Legacy mechanism (screenshot) | Why it breaks in Cribl | New-app workflow | Status |
|---|---|---|---|
| Wizard Step 2 Azure: "leverages your Azure PowerShell session (Connect-AzAccount), Detect Existing Session" | No PowerShell, no local token cache in the iframe | Service-principal client-credentials (app registration) + KV-encrypted secret + proxy token injection | BUILT (Panel 3 / harness; Unit 9 promotes it into the wizard) |
| Repositories: GitHub PAT "encrypted at rest using your OS keychain (Windows DPAPI / macOS Keychain)" | No OS keychain in the iframe | KV encrypted write-only entry (same as azureBasic) | Unit 14 |
| Repositories: "549 solutions ready / 332 samples ready" (bulk-downloaded to disk, ~30-50MB) | Can't bulk-mirror repos into local files; 100 req/min proxy budget forbids a 600-2500-call prefetch | LAZY on-demand GitHub fetch per selected solution + KV cache; wizard verifies REACHABILITY + PAT validity, not "downloaded" | Units 14/16 (NEW WORKFLOW - see below) |
| Sample Data: Upload Files / Browse Samples | Upload works (browser File API); Browse pulled from the local repo mirror | File input for upload (fine in iframe); Browse = on-demand fetch from the cached/lazy content port | Units 11/16 |
| Deploy: "build the Cribl pack and upload" (writes .crbl to disk) | No local filesystem | In-browser .crbl assembly + Cribl API upload; artifacts regenerate on demand from stored pack definitions (never bytes in KV) | Unit 19 |
| Air-Gapped mode: "Export .crbl packs, ARM templates, deployment instructions" | No disk to write to | ArtifactSink browser downloads (proven working) | Unit 20 |
| "Checking Azure permissions..." inline | Same intent, different engine | azure-permissions effective-action preflight (already built) surfaced inline in the section | BUILT (Unit 9 surfaces it here) |

## NEW WORKFLOW the Cribl app needs that the legacy did not

Lazy, budgeted content acquisition. The legacy bulk-mirrored the Sentinel + Elastic repos into local files up front (the "549 solutions ready" state = downloaded). The Cribl app CANNOT do that: the proxy caps at 100 req/min and there is no disk. So the content workflow inverts:

- Setup/Repositories step verifies GitHub is reachable and the PAT is valid, and shows COUNTS from a lightweight index call - it does not download everything.
- When a solution is selected (Integrate step 1), fetch THAT solution's content on demand, parse, and cache the parsed result in KV keyed by solution+commit.
- Sample browse fetches on demand similarly.
- All fetches are budget-paced (reuse the poll-scheduler budget model) and progress-reported honestly.

This makes "Repositories ready" mean reachable + authorized + indexed, not mirrored. Units 14/16 must be built lazy-first; the wizard copy changes accordingly (not "downloading 2500 files" but "GitHub connected, 549 solutions available").

## Structural decision - ADOPTED (user, 2026-07-04)

The Integrate arc becomes a single numbered-section page (Solution -> Sample Data -> Azure Resources -> Cribl Config -> Gap Analysis -> Rule Coverage -> Deploy) with a persistent deploy-readiness footer, matching the legacy flagship. The journey rail still frames first-run and the arc's position, but the arc itself is one page whose sections gate forward. Built screens (Targeting/Onboard/Review/Batch) refactor into sections of this page; coming units 11-20 add their sections. Batch (Unit 6) remains as the multi-log-type engine behind the page's per-log-type sections.

## MVP SCOPE (user, 2026-07-04): these two flows are the initial release

The Setup Wizard and the Sentinel Integration flow are the MVP. Everything else waits until these are built and validated. This focuses remaining build effort on completing the two flows and STOPS work on peripheral areas.

MVP-REQUIRED units (to complete the two flows): 8 (role assignment - the Azure section's MMP checkbox), 9 (Connect + preflight -> wizard Azure step), 11 (sample parser/intake), 12 (CSV + vendor feeds), 13 (field matcher - powers gap analysis), 14 (content: GitHub PAT + solution browser + LAZY fetch), 16 (sample browse/acquisition), 17 (pipeline generation), 18 (DCR gap analysis + mapping review - the approval moment), 19 (pack assembly + install), 20 (guided deploy = the page's Deploy section), 22 (wizard assembly), 23 (rule coverage - CORE; workbook analysis DEFERRED). Plus the single-page Integrate arc restructure. Already built and reused: 1, 2, 3, 4, 5, 6, 6.5, 7, auth manager.

DEFERRED to post-MVP validation: 10 (standalone KQL query tool), 15 (vendor research engine - gap analysis ships with a lighter destination-resolution path), workbook analysis (Unit 23 addition), 21 (Data Flow / monitoring), 24 (Discovery tools), 25-27 (Labs, SIEM Migration, change detection). These are peripheral to the two MVP flows; revisit after the MVP is validated in a real environment.

Borderline calls (defaulted DEFERRED - pull into MVP if wanted): vendor research (15) and workbook analysis. Gap analysis (18) can resolve destinations from the Sentinel content itself for MVP; the full vendor-research engine is an enhancement.
