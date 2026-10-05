# Moving the app to its own repository

Status: Proposed - the inventory for moving soc-optimizationtoolkit/ out of criblio/Cribl-Microsoft. Nothing here has been done yet.
Last-confirmed: 2026-10-05

Written for [[DBT-129]] from a read-only sweep of the repository. It lists
everything that ties the app to THIS repository, so the move can be planned
rather than discovered. Re-read it before acting: it describes the tree as of
2026-10-05.

## The short version

The shipped app is self-contained: no code, UI text, generated pack,
`proxies.yml` or `package.json` names this repository, and the vendor and DCR
schema assets the app needs are committed copies. What does NOT travel is the
build and its checks: two core tests and the schema-asset extractor read files
outside `soc-optimizationtoolkit/`, the docs gate walks the folder above it,
and CI, the hooks and three git-history checks assume the
`soc-optimizationtoolkit/` prefix.

A history-preserving extraction is viable. The app's history starts at
66892cd (2026-07-01); `git filter-repo --path soc-optimizationtoolkit/` plus an
inverted glob dropping `apps/cribl-app/release/*.tgz` keeps every commit that
touched the app and removes 51 old tarballs (about 24.5 MiB of a 34.4 MiB pack).
The files it needs from outside follow in one commit rather than with their
history. Every commit SHA changes: keep this repository archived and publish
filter-repo's commit-map so SHA citations in the docs can still be followed.

## Decided 2026-10-05

The operator answered the four decisions that shape the rest:

- **Layout - keep the subdirectory.** The new repository holds
  `soc-optimizationtoolkit/` as a folder, so CI path filters, the hooks,
  board-freshness and the release-drift check keep their paths. Only
  check-docs' repoRoot needs repointing (rows 10 and the path items below).
- **Owner - the criblio organization** (rows 6 and 9). The repository name,
  branch protection and the gh account are still to be set when it is created.
- **Content - the app and what it strictly needs, nothing else.** The goal is
  the smallest repository from which the app can be published to the Cribl
  Marketplace, so the DCR ARM templates and the deprecated tree do NOT move
  (rows 1, 2, 3, 8). Read as: the committed
  `packages/core/src/assets/dcr-template-schemas.json` ships as a frozen asset,
  and the extractor script and `check-schema-asset` stay behind or are retired;
  the two core tests that read legacy files under `deprecated/` lose their
  source, so their provenance pins are retired rather than vendored. This
  reading is the operator's goal applied to rows 1-3; confirm it before the
  pins are deleted.
- **Releases - a version change triggers the release** (row 7). In the new
  repository a version bump starts a CI pipeline with an approval gate that
  builds the tarball and publishes the new app version to the Cribl
  Marketplace. The committed-tarball model in `apps/cribl-app/release/` is
  replaced by that pipeline; how the Marketplace accepts a version (its
  publish API or upload path) is not yet known and must be found out before
  the pipeline can be written.

Still open: rows 4 (issues and bug triage), 5 (shared hooks), what the old
repository keeps of the tarball, and branch protection.

## Decisions needed first

| # | Where | Decision |
|---|---|---|
| 1 | `soc-optimizationtoolkit/packages/core/src/domain/coverage-model/coverage-model.test.ts:38-50` | Vendor the legacy resource-coverage.json as a frozen fixture, or retire the AZR-0 provenance pins and the matching claim? |
| 2 | `soc-optimizationtoolkit/packages/core/src/domain/entra-diagnostics/entra-diagnostics.test.ts:37-41` | Same choice as coverage-model: vendor the fixture or retire the provenance pins. |
| 3 | `soc-optimizationtoolkit/packages/core/scripts/extract-dcr-template-schemas.mjs:51-69` | Vendor a copy of the DCR templates and custom schemas (two copies to keep in sync with the public DCR-Templates), fetch them from the old repo at a pinned SHA, or freeze the asset? |
| 4 | `.github/workflows/bug-triage.yml:1-45; .github/bug-triage/triage.mjs:1-30,81,196` | Transfer open app issues (#23, #47 and the tracker) to the new repo, or leave them in the old repo? Does bug triage run in both repos or only the new one? |
| 5 | `.claude/settings.local.json (hooks block); .gitignore:84-86` | Commit a shared .claude/settings.json so the audit, board and docs hooks fire for every contributor, or keep hooks personal? |
| 6 | `LICENSE; NOTICE:1-4; soc-optimizationtoolkit/package.json:5` | New repo name and owning org (criblio vs personal): this sets the NOTICE title, the repository field and every redirect link. |
| 7 | `soc-optimizationtoolkit/apps/cribl-app/release/soc-optimizationtoolkit-1.12.8.tgz; README.md:79-87; QUICK_START.md:17-18; soc-optimizationtoolkit/apps/cribl-app/README.md:6-21` | In the old repo: delete the tarball with a pointer, or leave 1.12.8 frozen? In the new repo: keep the committed-tgz model, or switch to GitHub Releases? |
| 8 | `Azure/CustomDeploymentTemplates/DCR-Templates/ (README.md:112; extract-dcr-template-schemas.mjs:31-33); Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables/README.md:163` | Confirm DCR-Templates stays in criblio/Cribl-Microsoft as the public API, and choose how the app stays in sync with template fixes (manual re-vendor, pinned-SHA fetch, or a scheduled check). |
| 9 | `CLAUDE.md:'Git Workflow' (main is protected); memory reference_gh_dual_accounts.md` | Which org and which gh account own the new repo, and what branch protection does it get? |
| 10 | `Repository layout: soc-optimizationtoolkit/ subdirectory vs new repo root` | Keep the soc-optimizationtoolkit/ subdirectory in the new repo (fewest edits) or flatten to the repo root (cleaner, needs every retarget above)? |

## Full inventory

### Code and tests that read outside the app

| Where | Depends on | Breaks how | Action |
|---|---|---|---|
| `soc-optimizationtoolkit/packages/core/src/domain/coverage-model/coverage-model.test.ts:38-50` | deprecated/Azure/Azure-LogCollection/core/resource-coverage.json, read at test time through six '..' segments (back to the repo root) | legacy() throws 'The ported-from source is missing' by design (lines 60-70), so `npm test` and the CI Test step fail | Copy resource-coverage.json into the new repo as a test fixture (e.g. packages/core/src/domain/coverage-model/__fixtures__/) and point LEGACY_PATH at it. Or, as the test's own message offers, delete these provenance pins AND the 'ported not invented' claim in coverage-catalog.ts together (decision above) |
| `soc-optimizationtoolkit/packages/core/src/domain/entra-diagnostics/entra-diagnostics.test.ts:37-41` | deprecated/Azure/Azure-LogCollection/core/Deploy-EntraIDDiagnostics.ps1, read at test time | script() throws when the file is missing, so `npm test` fails | Copy Deploy-EntraIDDiagnostics.ps1, or only its $*LogCategories blocks, in as a fixture and retarget SCRIPT_PATH. Or retire the AZR-2/LOG-07 verbatim pins and the claim in entra-categories.ts together (decision above) |
| `soc-optimizationtoolkit/packages/core/scripts/extract-dcr-template-schemas.mjs:51-69` | Two inputs: <repo>/Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables/DataCollectionRules(NoDCE)/ (50 files) and <repo>/deprecated/Azure/CustomDeploymentTemplates/DCR-Automation/core/custom-table-schemas/*.json (13 JSON files plus a README) | ENOENT, the same failure as DBT-67. The committed asset src/assets/dcr-template-schemas.json can no longer be regenerated | Options: vendor both inputs into the new repo (e.g. packages/core/vendor/dcr-templates/ and vendor/custom-table-schemas/) and retarget lines 51-69; or fetch them from the old repo at a pinned commit SHA; or freeze the asset and drop the generator. Vendor from the ROOT Azure/ copy, not deprecated/Azure/.../DCR-Templates, which has diverged (ADAssessmentRecommendation, AWSCloudTrail and README differ). Update the header comment at lines 9-17 and 31-43 (decision above) |

### Scripts that read outside the app

| Where | Depends on | Breaks how | Action |
|---|---|---|---|
| `soc-optimizationtoolkit/apps/cribl-app/scripts/check-schema-asset.mjs:48-50,151` | Runs the extractor above, which reads outside the toolkit | Prints GENERATOR_FAILED_MESSAGE and exits non-zero, so the CI 'Check schema asset' step fails | No change if the extractor is retargeted to vendored inputs. If the asset is frozen instead, remove the CI step and this script together |
| `soc-optimizationtoolkit/apps/cribl-app/scripts/check-docs-drift.mjs:49,126,346,374-376` | repoRoot = toolkitDir/.. (the Cribl-Microsoft root). It lists every repo path from there; the regex accepts roots deprecated\|Azure\|KnowledgeArticles; line 346 also tries a soc-optimizationtoolkit/ prefix | After flattening, repoRoot is the folder ABOVE the clone. It walks sibling repos (slow), and document paths get the clone folder's name as a prefix, so path lookups match only by accident. The RETIRED rule for Cribl-Microsoft_IntegrationSolution (lines 94-100) points readers to a deprecated/ that no longer exists | Set repoRoot = toolkitDir when flattening. Drop deprecated\|Azure\|KnowledgeArticles from PATH_IN_BACKTICKS, or keep them and expect Living docs to stop naming them. Drop or keep the soc-optimizationtoolkit/ fallback at 346. Update the RETIRED fix text to point at the old repo | <!--drift-ok-->

### Doc links

| Where | Depends on | Breaks how | Action |
|---|---|---|---|
| `soc-optimizationtoolkit/docs/backlog.md:456,554,561,770,1471` | Living doc naming deprecated/ paths in backticks: Azure-LogCollection, Deploy-DefenderXDRStreaming.ps1, Cribl-Microsoft_IntegrationSolution, and the deprecated DCR-Templates copy. None carries <!--drift-ok--> | Once deprecated/ is absent, check-docs reports each as a broken path and fails CI. Line 456 is ALREADY misleading: it cites the stale deprecated/ DCR-Templates copy as 'what a DCR will ACCEPT', but the corrected templates are the root Azure/ copy (they have diverged) | Requalify each as an old-repo reference, e.g. 'criblio/Cribl-Microsoft@<sha>:deprecated/...' outside backticks, or mark the line <!--drift-ok-->. Fix line 456 to name Azure/CustomDeploymentTemplates/DCR-Templates/... (or the vendored copy) |
| `soc-optimizationtoolkit/docs/documenting-work.md:336-337` | States '`.claude/` is gitignored and travels with nobody' | Already stale (Living doc): .claude/hooks, two skills and the marker are tracked. What does not travel is the hook WIRING in settings.local.json | Correct the sentence when the new repo's .claude/ layout is settled (and say whether settings.json is shared) |
| `CLAUDE.md:1-60 (deprecation note, board rules, Project Overview); CLAUDE.md:3-7` | Root CLAUDE.md carries the app's operating rules (board is source of truth, the four rules, the npm run board/groom commands, the app layout), mixed with PowerShell, SDK and Terraform material about the deprecated tooling | A new repo without it loses the rules documenting-work.md:245 points to ('the board section in CLAUDE.md'). The deprecation note also names apps/local-app, which ADR 0002 retired (stale today) | Split: move the board section, Project Overview (toolkit part), the shared-standards pointer and the NO EMOJIS rule into the new repo's CLAUDE.md (paths relative to the new root). Leave the PowerShell, DCR, SDK and Terraform sections in the old repo with a pointer to the new one. Drop apps/local-app from the note | <!--drift-ok-->
| `README.md:5-35,79-104,110-114` | Root README describes the toolkit's features, the install-from-release path (lines 79-87) and dev commands 'from soc-optimizationtoolkit/' (97-104) | Old-repo README would advertise an app and a release path that moved; new repo has no top-level README with the product description | Move the toolkit sections into the new repo README (merged with soc-optimizationtoolkit/README.md). Rewrite the old README's toolkit section as a short pointer to the new repo, keeping the DCR templates 'manual path' content, which stays |
| `QUICK_START.md:3-4,17-18,83-86; soc-optimizationtoolkit/README.md:11-17; soc-optimizationtoolkit/apps/cribl-app/README.md:44-45` | QUICK_START is entirely an app install guide at the repo root. The toolkit README links ../QUICK_START.md. The cribl-app README says 'See the repository root CLAUDE.md' | ../QUICK_START.md resolves outside the new repo, a dead link | Move QUICK_START.md into the new repo (root or docs/), retarget the toolkit README link and the cribl-app README reference. Leave a stub in the old repo pointing to the new location |
| `packages/core/src/assets/vendor-schemas/index.ts:5; domain/custom-table/custom-table.ts:16-19; dcr-naming/dcr-naming.ts:5; dcr-request/dcr-request.ts:6,10; schema-mapping/schema-mapping.ts:5,44; sentinel-destination/sentinel-destination.ts:11; entra-diagnostics/entra-categories.ts:5; entra-diagnostic-setting.ts:7; coverage-model/coverage-catalog.ts:6; labs/flowlog-pack-assets.ts:1; labs/lab-flowlog-pack.ts:6; siem-migration/models.ts:4; assets/sample-corpus/manifest.ts:5; pack-assembly/tar.ts:22; usecases/azure-discovery/azure-resources.ts:2` | Provenance comments naming deprecated/... and Cribl-Microsoft_IntegrationSolution/... paths as the source of ported logic | Comments only, nothing fails, but every 'ported verbatim from <path>' becomes a path that is not in the repo | Add one PROVENANCE note (e.g. in packages/core/CONTEXT.md) saying that deprecated/ and Cribl-Microsoft_IntegrationSolution/ paths refer to criblio/Cribl-Microsoft at a named pre-split commit, rather than rewriting each comment | <!--drift-ok-->
| `deprecated/README.md:10-18` | Points readers of the deprecated tools to `soc-optimizationtoolkit/` in this repo, and to `npm run dev` in `apps/local-app` (stale since ADR 0002) | After the move, the successor pointers name a folder that is gone | In the old repo, retarget the 'Superseded by' column to the new repo URL and drop the apps/local-app launcher text | <!--drift-ok-->

### Checks that read git history

| Where | Depends on | Breaks how | Action |
|---|---|---|---|
| `soc-optimizationtoolkit/apps/cribl-app/scripts/check-release-drift.mjs:75-81,275-290` | Repo-root pathspecs prefixed soc-optimizationtoolkit/, the release pathspec 'soc-optimizationtoolkit/apps/cribl-app/release', and enough history to count commits since the tarball last changed | Flattened: git log on the release pathspec returns nothing, the count is null, and the check only warns 'NOT measured' on every run. Fresh repo without history: the count starts at the import commit. Filter-repo split with history: counts are preserved as long as the paths match. SOURCE_PATHS also names apps/cribl-app/default, which does not exist today (dead pathspec) | If flattened, drop the prefix from SOURCE_PATHS and the release pathspec, and remove the dead 'apps/cribl-app/default' entry. Keep fetch-depth: 0 in CI. Re-run `npm run check-release` after the move and confirm it reports a measured number |
| `soc-optimizationtoolkit/apps/cribl-app/scripts/board-freshness.mjs:17-27,71-80; board-freshness.test.mjs:15-67` | WATCHED and BOARD are repo-root paths prefixed soc-optimizationtoolkit/; diffs against origin/<base> | Flattened: `git diff --name-only` returns unprefixed paths, nothing matches WATCHED, and every PR reads 'nothing under the watched paths changed'. That is a silent false pass. The tests still pass because they pin the prefixed constants | Drop the prefix from WATCHED and BOARD and from the test pins in the same commit. Mutation-check that a packages/ change now triggers the warning |
| `docs/backlog.md:1202,1809,1868; docs/roadmap.md:43; docs/sample-acquisition-plan.md:485; packages/core/src/domain/capabilities/capabilities.ts:192; journey-state/journey-state.ts:22; apps/cribl-app/scripts/check-classnames.mjs:27; docs/adr/0003-remove-sample-browser.md:4 (PR #119); docs/adr/0004-cast-guid-columns.md:33 (PR #26); docs/release-notes.md:450` | Short commit SHAs and PR numbers from this repo | filter-repo or subtree split rewrites every SHA, so cited SHAs resolve to nothing. PR numbers would point at unrelated PRs in the new repo | Keep the old repo archived (not deleted). Publish filter-repo's commit-map in the new repo (e.g. docs/history-map.txt) and add one dated note to documenting-work.md that pre-move SHAs and #N refer to criblio/Cribl-Microsoft. Do not rewrite the Record docs (ADRs, roadmap, release-notes, sample-acquisition-plan); annotate them |
| `git history: 954 commits total, 753 touching soc-optimizationtoolkit/, first 66892cd (2026-07-01), 28 merges` | History-preserving extraction | Viable. No files were renamed into the path; the 172 renames in 66892cd moved SOC-OptimizationToolkit -> SOC-OptimizationToolkit_v1, outside the filter (case-sensitive match). The outside inputs crossed the 2026-07-13 move under deprecated/, so pulling their history would mean listing both the old and new paths | Run git filter-repo on a fresh mirror clone (Linux/WSL preferred, given Windows case-insensitivity): --path soc-optimizationtoolkit/ (plus --path-rename if flattening), and invert-filter release/*.tgz. Then add ONE follow-up commit that copies the outside files: NoDCE DCR templates, custom-table-schemas, the two Azure-LogCollection fixtures, .gitattributes, LICENSE/NOTICE, .gitignore rules, CLAUDE.md, QUICK_START.md, CI workflow, .claude/ hooks, skills and marker. Keep the commit-map. git subtree split also works but cannot drop the tarball blobs |

### CI

| Where | Depends on | Breaks how | Action |
|---|---|---|---|
| `.github/workflows/soc-toolkit-ci.yml:3-11,17-19,33,23` | Path filters 'soc-optimizationtoolkit/**', defaults.run.working-directory soc-optimizationtoolkit, cache-dependency-path soc-optimizationtoolkit/package-lock.json, fetch-depth: 0 | The workflow does not exist in the new repo unless copied. If copied unchanged into a flattened repo, the path filters never match, so CI never runs | Copy to the new repo's .github/workflows/. If flattened: drop the path filters (or use '**'), remove working-directory, set cache-dependency-path to package-lock.json. Keep fetch-depth: 0 and every step. Then re-point branch protection's required status checks at the new repo |
| `.github/workflows/bug-triage.yml:1-45; .github/bug-triage/triage.mjs:1-30,81,196` | This repo's GitHub ISSUES: every open issue, the tracker issue labelled triage/tracker (#84 per board.md:926), triage/approved and triage/rejected labels, reports #23 and #47. Rationale relies on main being protected | Issues and labels are not in git. In the new repo the sweep starts empty and creates a new tracker; app bugs already filed stay in the old repo | Copy the workflow and triage.mjs (generic on GITHUB_REPOSITORY), create the three labels, and either transfer the open app issues with GitHub's issue transfer or leave them and link from the new tracker (decision above) |

### Claude hooks

| Where | Depends on | Breaks how | Action |
|---|---|---|---|
| `.claude/hooks/architecture-audit-check.sh:13,26-31,46-58; .claude/.last-architecture-audit` | WATCHED prefixed soc-optimizationtoolkit/; marker holds commit 8b93a6eab20f8169c3730309fb9e39e6d2bad4cd from THIS repo | Flattened: the count is always 0, so the audit never fires. Any history rewrite (filter-repo/subtree) makes the marker SHA unknown; the hook then silently re-seeds at HEAD and loses the backlog of unaudited commits | Copy to the new repo, drop the WATCHED prefix if flattened, and write the marker from filter-repo's commit-map (old 8b93a6e -> new SHA) rather than letting it re-seed |
| `.claude/hooks/board-freshness-check.sh:19,23-30,42` | BOARD='soc-optimizationtoolkit/docs/board.md' and prefixed WATCHED | Flattened: `[ -f $root/$BOARD ] \|\| exit 0` exits silently forever | Copy, and drop the prefix from BOARD and WATCHED |
| `.claude/hooks/docs-drift-check.sh:20-29,4-6` | case patterns *soc-optimizationtoolkit/docs/*.md* and app=$root/soc-optimizationtoolkit/apps/cribl-app | Flattened: no edit ever matches and the check script is not found, so the hook never runs. The header comment (lines 4-6), '.claude/ is gitignored... nothing here travels with a clone', is ALREADY false: .gitignore:83 re-includes .claude/ and the hooks are tracked | Copy, retarget the patterns to */docs/*.md and */CONTEXT.md and app to $root/apps/cribl-app, and correct the header comment |

### Repo tooling

| Where | Depends on | Breaks how | Action |
|---|---|---|---|
| `.claude/settings.local.json (hooks block); .gitignore:84-86` | The Stop and PostToolUse hook wiring lives ONLY in settings.local.json, which is gitignored and personal | Already broken for every clone: the hook scripts are tracked but not wired, so they fire only on this machine. A new repo would carry the same gap | In the new repo, commit the hooks block in a shared .claude/settings.json (Claude Code's own convention: shared settings.json, personal settings.local.json), keeping permissions in local (decision above) |
| `.claude/skills/architecture-audit/SKILL.md:8,17-18,33,75-76,93,138; .claude/skills/backlog-grooming/SKILL.md:20; .claude/skills/README.md` | `cd soc-optimizationtoolkit`, `../.claude/.last-architecture-audit`, `git diff marker..HEAD -- soc-optimizationtoolkit/`; README describes 'a clone of this repo' | Flattened: the cd fails and the diff is scoped to a path that no longer exists, so the audit reads an empty change set | Copy both tracked skills and the README with the matching .gitignore negations (.gitignore:99-101). Drop `cd soc-optimizationtoolkit` and the ../ marker prefix if flattened |
| `CLAUDE.md:'Git Workflow' (main is protected); memory reference_gh_dual_accounts.md` | Branch protection on main, the required check name (job 'ci'), and which gh account can push (memory: Cribl-Microsoft 403s for one account) | Protection and required checks are repo settings; a new repo starts unprotected, and gh may authenticate as the wrong account | Create the new repo, enable main protection with the 'ci' check required, and record which gh account owns it in project memory (decision above) |

### Other

| Where | Depends on | Breaks how | Action |
|---|---|---|---|
| `.gitattributes:1-40; .gitignore:86,99-101,189,241` | Root-only files the toolkit relies on: eol=lf normalisation (DBT-71, guarding DBT-66/DBT-70), *.tgz binary, __pycache__/ (keeps scripts/zscaler-lab/__pycache__ untracked), *.LOCAL.* (keeps soc-optimizationtoolkit/.claude/settings.local.json untracked), the .claude/ rules | Without .gitattributes, a Windows clone with autocrlf regresses the check-listings shebang import (DBT-66) and the schema-asset byte compare (DBT-70), and CI on Linux cannot see it. Without the ignore rules, __pycache__ and a personal settings file become trackable | Copy .gitattributes verbatim. Merge __pycache__/, *.LOCAL.*/.claude/settings.local.json and the .claude/skills/* negations into the new root .gitignore alongside the toolkit's own .gitignore |
| `LICENSE; NOTICE:1-4; soc-optimizationtoolkit/package.json:5` | The toolkit declares Apache-2.0 but has no LICENSE or NOTICE of its own; NOTICE is titled 'Cribl-Microsoft Integration' | New repo has no license file | Copy LICENSE and NOTICE, and retitle NOTICE for the new repo. Also consider adding repository/homepage/bugs fields to apps/cribl-app/package.json, which has none today (decision above) |
| `soc-optimizationtoolkit/apps/cribl-app/release/soc-optimizationtoolkit-1.12.8.tgz; README.md:79-87; QUICK_START.md:17-18; soc-optimizationtoolkit/apps/cribl-app/README.md:6-21` | Users are told to download the committed .tgz from THIS repo's release/ path; 51 earlier tarball versions sit in history (24.5 MiB on disk of a 34.4 MiB pack) | Existing bookmarks and shared links to the old release/ path go stale or keep serving 1.12.8 forever; a history-preserving split also copies 24.5 MiB of old tarballs | Re-add the current tgz in the new repo, and strip release/*.tgz from history during the split (filter-repo --path-glob with --invert-paths, then re-commit the latest). In the old repo either delete release/ and leave a README pointer, or freeze 1.12.8 with a 'moved' notice. Consider GitHub Releases in the new repo instead of a committed tarball (decision above) |
| `Repository layout: soc-optimizationtoolkit/ subdirectory vs new repo root` | Prefix 'soc-optimizationtoolkit/' is hard-coded in check-release-drift.mjs, board-freshness.mjs and its tests, the three hooks, the architecture-audit and backlog-grooming skills, soc-toolkit-ci.yml, check-docs-drift.mjs:346, and many doc instructions ('from soc-optimizationtoolkit/') | Flattening without retargeting every one of these turns three checks into silent no-ops (board freshness, audit cadence, docs hook) and one into permanent 'unmeasured' (release drift) | Either keep soc-optimizationtoolkit/ as a subdirectory in the new repo (prefixes keep working; still vendor the outside inputs and repoint check-docs-drift's repoRoot) or flatten with filter-repo --path-rename and retarget all listed paths in the same commit, then mutation-check each check (decision above) |

### Inbound links

| Where | Depends on | Breaks how | Action |
|---|---|---|---|
| `Azure/CustomDeploymentTemplates/DCR-Templates/ (README.md:112; extract-dcr-template-schemas.mjs:31-33); Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables/README.md:163` | The DCR-Templates root path is a public API that Cribl's docs link to file by file. The app consumes it only at dev time through the extractor; at runtime it uses the committed packages/core/src/assets/dcr-template-schemas.json. The templates README links out to soc-optimizationtoolkit/docs/adr/ (ADR 0004) | Moving DCR-Templates would break published Cribl doc links. Leaving it means the app and templates no longer share a commit, so a template fix no longer reaches the schema asset automatically. The templates README:163 link into the app's ADR goes dead | KEEP DCR-Templates in the old repo; do not move it. Vendor or pin a copy for the extractor (see that item). Retarget README:163 to the new repo's ADR 0004 URL. Optionally add a check in either repo that flags drift between the public templates and the vendored copy (decision above) |

### Repo URLs

| Where | Depends on | Breaks how | Action |
|---|---|---|---|
| `soc-optimizationtoolkit/apps/cribl-app/src/platform/adapters.ts:965-969; apps/cribl-app/config/proxies.yml:102-114; apps/cribl-app/src/App.tsx:564` | Nothing in this repo. The app's GitHub calls target Azure/Azure-Sentinel only; 'soc-optimizationtoolkit' in App.tsx is the app id, not a repo name | Does not break. Grep across code, UI, generated packs, package.json and proxies.yml found no criblio/Cribl-Microsoft, raw.githubusercontent link to this repo, issue link or release URL | No action. Keep the app id and package name unchanged so in-place upgrades on existing leaders keep working |

### Paths outside the repo

| Where | Depends on | Breaks how | Action |
|---|---|---|---|
| `~/.claude/projects/C--Users-James-Pederson-Desktop-git-Remote-Cribl-Microsoft/memory/; soc-optimizationtoolkit/.claude/settings.local.json:9` | Claude auto-memory is keyed by the clone's folder path; a personal permission rule hard-codes Set-Location to the old clone and the soc-optimizationtoolkit/ release path | A new clone path starts with empty project memory, losing the release process, verify-in-live-preview, single-tenant, guid and pack-structure notes. The permission rule no longer matches | Copy the app-relevant memory files to the new project's memory key and drop the PowerShell-only ones. Re-create local permission rules |
