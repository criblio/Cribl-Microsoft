# UI Refinement: Reference-Driven, Per Functional Area

Approach (user decision, 2026-07-04): refine the new app's visual experience one FUNCTIONAL AREA at a time, using screenshots of the legacy app as the reference for each area. This replaces a single big design pass with area-scoped passes tied to the porting units, so each area is refined against a concrete "this is the bar" reference rather than invented design.

## How this works

1. You run the legacy app and capture screenshots for an area (checklist below). The legacy app is the Electron app at `Cribl-Microsoft_IntegrationSolution/`; launch it from source with `Start-App-Windows.bat` (repo root) or `npm run dev` in that directory.
2. Save the images to `soc-optimizationtoolkit/docs/ui-reference/<area>/` (this folder is gitignored - screenshots show real tenant/Cribl data and must not be committed). Name them by screen + state, e.g. `sentinel-integration/03-sample-loading-results.png`. Pasting key ones directly into chat also works.
3. I read the references and refine that area's screens in `@soc/ui` to match the legacy app's strengths (layout, hierarchy, states, review moments) while keeping the new app's own wins (dark mode, honest step lists, secret hygiene, always-visible-disabled affordances) and the guided-journey structure.
4. Capture what to keep AND what to improve - the goal is "as good or better," not a pixel clone. The UX analysis already flagged legacy anti-patterns (forced wizard gauntlet, triple pollers, browse-mutates-state) that we do NOT reproduce.

## Foundations (done incrementally alongside area passes)

The dark-mode work already tokenized all colors into CSS custom properties, every screen renders through shared `@soc/ui` components, and logic lives in pure modules behind the presentation - so an area's visual pass restyles tokens/components, never logic, and both shells update at once. As areas are refined, a shared component vocabulary (buttons, cards, field rows, status pills, loading/empty/success states, spacing/type scale) accretes in `@soc/ui`; a final holistic visual + accessibility QA pass closes the effort.

## Functional-area map (legacy page -> new screens -> unit)

| Functional area | Legacy page(s) | New app screen(s) | Porting unit | Built yet? |
|---|---|---|---|---|
| First-run setup | `SetupWizard.tsx` (676) | AuaGate, ModeSelect, Home | Unit 6.5, 22 | partial (gate/mode/Home done) |
| Sentinel Integration (flagship) | `SentinelIntegration.tsx` (3477) | Home + Integrate arc: Targeting, Onboard, Review, Batch, (content/pipeline/deploy to come) | Units 2,5,6,7 built; 11-20 to come | partial |
| Azure targeting | SentinelIntegration Azure sections | AzureTargetingScreen | Unit 2 | yes |
| Deployment review | SentinelIntegration preview | ReviewScreen | Unit 7 | yes |
| Batch / DCR deploy | SentinelIntegration deploy, `DcrAutomation.tsx` | BatchDeployScreen | Unit 6 | yes |
| Options / naming | (settings-embedded) | OptionsScreen | Unit 4 | yes |
| Data Flow / monitoring | `DataFlow.tsx` (615) | validate/monitor stages | Unit 21 | no |
| Pack Builder | `PackBuilder/*` (Browser/Scaffold/Manager) | pack + pipeline screens | Units 17,19 | no |
| Packs inventory | `Packs.tsx` (408) | pack inventory | Unit 19 | no |
| Repositories / content | `RepoSetup.tsx` (527) | content + PAT + solution browser | Unit 14 | no |
| SIEM Migration | `SiemMigration.tsx` (359) | migration analyzer | Unit 26 | no |
| Discovery | `Discovery.tsx` (164) | discovery tools | Unit 24 | no |
| Labs | `LabAutomation.tsx` (585) | labs | Units 25-27 area | no |
| Rule + workbook coverage | SentinelIntegration analysis sections | coverage panel (+ NEW workbook) | Unit 23 | no |
| Settings | `Settings.tsx` (164) | SettingsScreen | Unit 6.5 | yes |
| Diagnostics/deps | `DepsCheck.tsx` (273) | (platform-provided; harness = diagnostics) | dropped/harness | n/a |

## Capture checklist - START HERE (areas already built in the new app)

Refine these first since the new screens exist and you can compare side by side. For each, capture the legacy screen in the listed STATES (empty, filled, mid-operation, results, error) - states are where the legacy polish lived.

### Batch A: the built areas (highest priority)

- [ ] `sentinel-integration/` - the flagship page top to bottom: initial/empty, content-selected, sample-loaded, analysis/gap-review, Azure-targeting section, Cribl-targeting section, deploy-in-progress, deploy-summary, and any review/approve modal. This one page seeds most of the Integrate arc; capture generously.
- [ ] `azure-targeting/` - subscription/workspace/RG selection: empty, loaded dropdowns, a create-new-RG state, an enable-Sentinel action.
- [ ] `deployment-review/` - the resource preview: exists-vs-will-create rows, expanded request detail, any acknowledge/confirm moment.
- [ ] `batch-deploy/` (`DcrAutomation.tsx` + SentinelIntegration deploy) - table selection, per-table progress, combined summary.
- [ ] `settings/` - the settings page layout and any config editor.
- [ ] `setup-wizard/` - each wizard step (the step rail, per-step content, skip/next affordances).

### Batch B: the coming areas (capture as their units approach)

- [ ] `repositories/` (`RepoSetup.tsx`) - PAT entry, solution browser, fetch states - for Unit 14.
- [ ] `pack-builder/` (Browser/Scaffold/Manager) - each sub-screen and its states - for Units 17/19.
- [ ] `packs/` (`Packs.tsx`) - inventory list, per-pack detail - for Unit 19.
- [ ] `data-flow/` (`DataFlow.tsx`) - the monitoring/validation view - for Unit 21.
- [ ] `siem-migration/` (`SiemMigration.tsx`) - input, analysis, report - for Unit 26.
- [ ] `discovery/` (`Discovery.tsx`) - for Unit 24.
- [ ] `labs/` (`LabAutomation.tsx`) - for the labs area.
- [ ] rule/workbook analysis sections of SentinelIntegration - for Unit 23 (note: workbooks are NEW - no legacy reference; design fresh beside the rule panel).

## Per-area refinement pass (what I do with the references)

For each area, once its screenshots are in place: (1) I catalog the legacy layout, hierarchy, state handling, and review moments worth keeping; (2) name what to improve (the anti-patterns and any dated visuals); (3) refine the new screen's components/styles in `@soc/ui` against the reference, extending the shared component vocabulary; (4) verify both shells, light and dark, and the keep-list holds; (5) commit as a scoped "UI refine: <area>" change. Areas already built get refined now; areas not built yet are refined as their unit lands, with the reference already captured.
