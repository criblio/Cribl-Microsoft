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

## Capture checklist - one folder per legacy sidebar page

The `docs/ui-reference/` folders mirror the legacy app's sidebar in nav order, so you can walk the old app top to bottom and drop each page's screenshots into its folder. For each page capture the meaningful STATES (empty, filled, mid-operation, results, error) - states are where the legacy polish lived. The folder skeleton is committed (`.gitkeep`); only the image files are gitignored.

| Folder | Legacy page | Priority | Feeds new-app unit(s) |
|---|---|---|---|
| `00-setup-wizard/` | SetupWizard (first-run, before the sidebar) | high (built) | 6.5, 22 |
| `01-sentinel-integration/` | SentinelIntegration (the flagship) | HIGHEST (partly built) | 2,5,6,7 built; 11-20 to come |
| `02-data-flow/` | DataFlow | later | 21 |
| `03-dcr-automation/` | DcrAutomation | high (built as Batch/Onboard) | 5,6 |
| `04-discovery/` | Discovery | later | 24 |
| `05-labs/` | LabAutomation | later | labs area |
| `06-siem-migration/` | SiemMigration | later | 26 |
| `07-pack-builder/` | PackBuilder (+ `browser/`, `scaffold/`, `manager/` subfolders) | later | 17,19 |
| `08-packs/` | Packs | later | 19 |
| `09-repositories/` | RepoSetup | later | 14 |
| `10-settings/` | Settings | high (built) | 6.5 |

START with the "high"/"HIGHEST" rows - those new screens already exist so refinement can begin immediately. `01-sentinel-integration/` is the biggest win: one 3477-line page that seeds most of the Integrate arc, so capture it generously (initial/empty, content selected, sample loaded, analysis/gap review, Azure targeting, Cribl targeting, deploy in progress, deploy summary, any review/approve modal). The other pages can be captured as their unit approaches. Naming tip: number-prefix within a folder for flow order, e.g. `01-empty.png`, `02-content-selected.png`.

Note: rule + workbook coverage (Unit 23) - the rule analysis lives inside SentinelIntegration (capture it there); WORKBOOK analysis is net-new with no legacy reference, designed fresh beside the rule panel.

## Per-area refinement pass (what I do with the references)

For each area, once its screenshots are in place: (1) I catalog the legacy layout, hierarchy, state handling, and review moments worth keeping; (2) name what to improve (the anti-patterns and any dated visuals); (3) refine the new screen's components/styles in `@soc/ui` against the reference, extending the shared component vocabulary; (4) verify both shells, light and dark, and the keep-list holds; (5) commit as a scoped "UI refine: <area>" change. Areas already built get refined now; areas not built yet are refined as their unit lands, with the reference already captured.
