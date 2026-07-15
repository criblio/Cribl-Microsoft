/**
 * IntegrateScreen - THE MVP CENTERPIECE: the single-page Integrate arc
 * (legacy-flow-analysis.md, structural decision ADOPTED 2026-07-04). The
 * legacy Sentinel Integration flagship was ONE scrolling page of numbered
 * sections that gate forward with an always-visible deploy readiness; this
 * screen is its successor, composing the ALREADY-SHIPPED screens as sections
 * rather than scattering them across sidebar routes.
 *
 * The EIGHT sections render in page order from @soc/core INTEGRATE_SECTIONS,
 * all BUILT and operable:
 *
 *   1. Select Sentinel Solution - the SolutionBrowser: lazy GitHub solution
 *      index, per-solution on-demand fetch with commit-keyed caching, the
 *      preserved `#/?solution=` deep link (consumed once so Clear works), and
 *      the dedicated selected-solution card. Additive and non-gating.
 *   2. Add Sample Data      - the SampleIntakeSection: multi-file upload,
 *      paste-and-tag, Browse Samples (Sentinel repo + Elastic tiers,
 *      stream-scoped split names), per-sample chips, and the log-type rename
 *      that re-keys the tagged-sample store (Unit 11).
 *   3. Select Azure Resources - the AzureTargetingScreen cascade, capability
 *      checkboxes, Sentinel-enabled auto-check, and the operable
 *      RoleAssignmentSection (Unit 8). Additive + non-gating.
 *   4. Configure Cribl      - Stream-only worker-group select, pack name,
 *      multi-group fan-out, and the pack overwrite check.
 *   5. Run DCR Gap Analysis - the MappingReviewSection: per-log-type gap
 *      analysis over Phase-0 vendor packs + learned mappings, the editable
 *      mapping table (with field search), vendor-identity forced inputs,
 *      enrichment editors, and the approval state machine. Gates the content
 *      path only (Unit 18); the native deploy stays independent.
 *   6. Review Analytics Rule Coverage - RuleCoverageSection (rules instance):
 *      three-way coverage with clickable missing-field close-match review and
 *      multi-format custom-rule upload. Informational; lights RULE badges.
 *   7. Review Workbook Coverage - RuleCoverageSection (workbooks instance):
 *      the solution's shipped workbooks plus solution-related deployed ones.
 *      Informational.
 *   8. Deploy               - the operable onboard (native + custom _CL
 *      tables, multi-DCR fan-out) plus "Build and install pack" closing the
 *      content path with real DCR values in outputs.yml, gated by the
 *      vendor-identity check and the overwrite acknowledgment.
 *
 * The user validated the native-table onboard live end to end; it stays fully
 * operable THROUGH this page. The standalone Onboard / Azure Targeting /
 * Batch / Review routes remain registered (parked in the Development nav
 * section; they stay reachable).
 *
 * Read-ahead contract: every section is visible; gating lives only at the
 * commit actions inside the composed screens (Use this target, Run deploy).
 * All decision logic is the pure @soc/core integrate-arc plus this package's
 * integrate-screen-state; this component only renders and orchestrates IO
 * through the ports in PortsContext (ZERO direct fetch/storage here).
 *
 * SECRET HANDLING mirrors OnboardTableScreen: the optional ingestion client
 * secret is TRANSIENT (write-only storage means it can never be read back);
 * left blank, the destination ships the placeholder to fill in Cribl.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_OPERATION_OPTIONS,
  SENTINEL_SECRET_PLACEHOLDER,
  assemblePack,
  canWireSource,
  deployedGroups,
  deriveSectionStatuses,
  destinationIdFromOptions,
  identityGateMessage,
  installedPackVersions,
  isStreamWorkerGroup,
  missingIdentityFields,
  nextPackVersion,
  onboardTable,
  onboardTableStepsFor,
  readinessPillsForMode,
  mergeContentRequirements,
} from "@soc/core";
import type {
  CriblGroupSummary,
  CriblOptions,
  DcrRoleTarget,
  DeployMode,
  GapFieldMapping,
  GapReport,
  IntegrateSectionId,
  JobStep,
  OnboardTableOutcome,
  OperationOptions,
  PackScaffoldInput,
  PackVendorSample,
  SolutionRef,
  TableAssemblyInput,
  TaggedSample,
  TargetScope,
  ContentRequirements,
} from "@soc/core";
import type { ReactNode } from "react";
import { usePorts } from "../../ports-context";
import { NumberedSection } from "../../components/numbered-section";
import { InfoTip } from "../../components/info-tip";
import { ReadinessFooter } from "../../components/readiness-footer";
import { AzureTargetingScreen } from "../azure-targeting/azure-targeting-screen";
import type { CommitScopeOutcome } from "../azure-targeting/azure-targeting-screen";
import { formatStepLine } from "../../onboarding/step-line";
import { summaryText } from "../../onboarding/summary";
import { RecentRuns } from "../../onboarding/recent-runs";
import { SampleIntakeSection } from "../samples/sample-intake-section";
import { MappingReviewSection } from "../mapping-review/mapping-review-section";
import type { MappingReviewRenameEvent } from "../mapping-review/mapping-review-section";
import { PipelinePreviewSection } from "../pipeline-preview/pipeline-preview-section";
import { derivePipelinePreview } from "../pipeline-preview/pipeline-preview-state";
import type { EnrichmentField } from "../pipeline-preview/pipeline-preview-state";
import { SolutionBrowser } from "../solution-browser/solution-browser";
import { RuleCoverageSection } from "../rule-coverage/rule-coverage-section";
import { ContentInstallSection } from "../content-install/content-install-section";
import {
  SearchableMultiSelect,
  SearchableSelect,
} from "../../components/searchable-select";
import { RoleAssignmentSection } from "../role-assignment/role-assignment-section";
import {
  dcrResourceIdFor,
  upsertRoleTarget,
} from "../role-assignment/role-assignment-state";
import {
  INTEGRATE_DEFAULT_TABLE,
  defaultPackName,
  deployDisabledReason,
  deriveSectionInputs,
} from "./integrate-screen-state";
import { WiringSection } from "./wiring-section";

/** Plain-KV key persisting the selected solution name across reloads. */
const SELECTED_SOLUTION_KEY = "integrate-selected-solution~v1";

export interface IntegrateScreenProps {
  /**
   * Whether the active connection has a committed target scope (subscription
   * + resource group + workspace). The SHELL owns this fact (it derives it
   * the same way it composes JourneyFacts.scopeCommitted); the Azure
   * Resources section's own commit flips it after "Use this target".
   */
  scopeCommitted: boolean;
  /**
   * The offline (artifact) targeting branch for the embedded
   * AzureTargetingScreen. The SHELL derives it from the mode; this route
   * requires 'both', so in practice Azure is live and this is false.
   */
  offline: boolean;
  /**
   * Commit a browsed scope as the active target (the same handler the
   * standalone Azure Targeting route uses). The shell owns the profile store
   * / persistence and returns the consequence notice.
   */
  onCommitScope: (scope: TargetScope) => Promise<CommitScopeOutcome>;
  /**
   * Persisted Cribl naming/targeting defaults (Unit 4 options): the
   * worker-group default preselects when it exists in the live list, the
   * destination id composes from the prefix/suffix, and the pack name
   * prefills from the prefix.
   */
  criblDefaults?: CriblOptions;
  /**
   * Persisted deployment options (Unit 4): feeds the Azure Resources DCE
   * capability checkbox (createDCE). Absent, the contract defaults apply.
   */
  operationDefaults?: OperationOptions;
  /** Navigate to the Options screen (the frame owns navigation). */
  onOpenOptions?: () => void;
  /**
   * Persist an edited OperationOptions (e.g. toggling the DCE capability inline
   * on this page instead of navigating to Options). Absent = the capability
   * checkboxes are read-only and Options is the only way to change them.
   */
  onOperationChange?: (options: OperationOptions) => void;
  /**
   * Shell-provided pointer to where the operator grants the Monitoring
   * Metrics Publisher role (the same cross-link the shared Onboard footer
   * takes). Absent, a shell-neutral sentence renders.
   */
  roleGuidance?: string;
  /**
   * The active integration mode (Unit 20 mode gating). Drives the readiness
   * pills a mode shows (Workspace hidden when Azure is skipped, Worker Groups
   * when Cribl is skipped) and the post-deploy source-wiring unlock. Defaults
   * to "full" so the operable native path is unchanged (in "full" the pill set
   * equals the un-gated set); this route requires both connections, so in
   * practice the shell passes "full".
   */
  mode?: DeployMode;
}

type DeployStatus = "idle" | "running" | "ok" | "failed";

export function IntegrateScreen({
  scopeCommitted,
  offline,
  onCommitScope,
  criblDefaults,
  operationDefaults,
  onOpenOptions,
  onOperationChange,
  roleGuidance,
  mode = "full",
}: IntegrateScreenProps) {
  const { ports, config } = usePorts();

  // ---- Cribl Configuration section (worker group + pack name) -----------
  const [groups, setGroups] = useState<CriblGroupSummary[] | null>(null);
  const [groupsError, setGroupsError] = useState("");
  const [groupId, setGroupId] = useState("");
  const [packName, setPackName] = useState(() => defaultPackName(criblDefaults));
  // Multi-group deploy: opt-in fan-out beyond the primary worker group.
  const [multiGroup, setMultiGroup] = useState(false);
  const [extraGroups, setExtraGroups] = useState<string[]>([]);
  // Pack overwrite guard: null = not yet checked; [] = name is free everywhere.
  const [packConflicts, setPackConflicts] = useState<string[] | null>(null);
  const [conflictChecking, setConflictChecking] = useState(false);
  const [conflictError, setConflictError] = useState("");
  const [overwriteAcked, setOverwriteAcked] = useState(false);

  // ---- Deploy section (the operable native-table onboard) ---------------
  const [table, setTable] = useState(INTEGRATE_DEFAULT_TABLE);
  // Tracks whether the operator hand-edited the table so the detected-table
  // prefill never clobbers an explicit choice.
  const tableTouchedRef = useRef(false);
  const [ingestionClientId, setIngestionClientId] = useState(
    () => config.clientId,
  );
  const [ingestionClientSecret, setIngestionClientSecret] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [steps, setSteps] = useState<JobStep[]>([]);
  const [outcome, setOutcome] = useState<OnboardTableOutcome | null>(null);
  // Per-table outcomes from a multi-DCR run (one entry per deployed table).
  const [outcomes, setOutcomes] = useState<
    Array<{ table: string; outcome: OnboardTableOutcome }>
  >([]);
  const [runError, setRunError] = useState("");
  const [deployCompleted, setDeployCompleted] = useState(false);
  const [historyToken, setHistoryToken] = useState(0);
  // The DCRs this page's deploys created, accumulated for the Azure Resources
  // ingestion-role step (Unit 8, ENG-37 runtime half). The exact deployed name
  // + scope come straight from each outcome, so the role step never has to
  // predict a name (no location guesswork). Additive: never part of any gate.
  const [roleTargets, setRoleTargets] = useState<DcrRoleTarget[]>([]);

  // ---- Solution section (Unit 14) ---------------------------------------
  // The lazy GitHub solution browser is the Solution section's content. The
  // selection is ADDITIVE and NON-GATING (like samples): it completes the
  // now-built Solution section and lights the Solution readiness pill, but it
  // never gates the native-table deploy (the MVP-transition canDeploy rule).
  const [solution, setSolution] = useState<SolutionRef | null>(null);
  // Restore the persisted selection once on mount (deep links and clicks
  // both overwrite it via handleSolutionChange).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || solution !== null) return;
    restoredRef.current = true;
    void (async () => {
      try {
        const stored = await ports.contentCache?.get(SELECTED_SOLUTION_KEY);
        if (typeof stored === "string" && stored !== "") {
          prevSolutionRef.current = stored;
          setSolution({
            name: stored,
            path: `Solutions/${stored}`,
            deprecated: false,
          });
        }
      } catch {
        // No restore - the browser selection works as before.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const solutionSelected = solution !== null;
  // Bumped when the solution CHANGES to a different one: it re-keys the
  // solution-dependent sections (samples, gap analysis, rule coverage, pipeline
  // preview) so they remount fresh - the old solution's work must not carry
  // over. The initial pick and the on-refresh deep-link restore are NOT changes
  // (prevSolutionRef starts null), so persisted samples for the restored
  // solution survive a reload.
  const [contentResetKey, setContentResetKey] = useState(0);
  const prevSolutionRef = useRef<string | null>(null);

  // ---- Sample Data section (Unit 11) ------------------------------------
  // The section owns its own store IO and reports the tagged-sample count so
  // the arc can complete Sample Data and light the Samples pill. Samples never
  // gate the native-table deploy below (the MVP-transition rule in @soc/core
  // canDeploy), so this count is intentionally NOT part of the run gate.
  const [sampleCount, setSampleCount] = useState(0);
  // The tagged samples feed the pipeline preview's per-log-type format map and
  // the Unit 18 DCR Gap Analysis section below - which AUTO-RESOLVES each
  // sample's destination table from the selected solution's connectors (no
  // manual table entry; the destination can differ per sample).
  const [samples, setSamples] = useState<TaggedSample[]>([]);

  // ---- DCR Gap Analysis section (Unit 18) -------------------------------
  // The mapping-review approval gate reports the CONTENT-path readiness. It is
  // ADDITIVE and NON-GATING for the native deploy (like samples/solution): it
  // completes the now-built Gap Analysis section and lights the Mappings pill,
  // but never participates in canDeploy (the MVP-transition rule). A log-type
  // rename is forwarded to the section so its approvals + mapping edits re-key
  // by the same Unit 11 primitive sample intake uses.
  const [mappingsApproved, setMappingsApproved] = useState(false);
  const [renameEvent, setRenameEvent] = useState<MappingReviewRenameEvent>();
  const renameNonce = useRef(0);
  // The Gap Analysis reports feed the Rule Coverage section (Unit 23): its
  // availability set and destination tables derive from them.
  const [gapReports, setGapReports] = useState<GapReport[]>([]);
  // The distinct destination tables the Gap Analysis DETECTED from the
  // solution's samples (e.g. PaloAlto -> CommonSecurityLog), in first-seen
  // order. The deploy defaults to these instead of a hardcoded SecurityEvent.
  const detectedTables = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const report of gapReports) {
      const name = report.tableName.trim();
      if (name !== "" && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
    return out;
  }, [gapReports]);
  // Prefill the deploy's native table from the first detected destination table
  // unless the operator hand-edited it - the gap analysis is the source of truth
  // for which table a solution's samples map to.
  useEffect(() => {
    if (!tableTouchedRef.current && detectedTables.length > 0) {
      setTable(detectedTables[0]);
    }
  }, [detectedTables]);
  // The native tables the deploy will provision a DCR for: EVERY detected table
  // when the solution mapped to more than one (multi-DCR fan-out), otherwise the
  // single field value (the detected-or-typed table).
  const deployTargets = useMemo(() => {
    if (detectedTables.length > 1) return detectedTables;
    const trimmed = table.trim();
    return trimmed === "" ? [] : [trimmed];
  }, [detectedTables, table]);
  // The reviewer's effective (edited) mappings per logType feed the Unit 17
  // pipeline preview below, so it mirrors hand edits (not just the baseline).
  const [mappingOverrides, setMappingOverrides] = useState<
    Readonly<Record<string, GapFieldMapping[]>>
  >({});
  // User-added enrichment constants (merged global + per-table, keyed by
  // logType) from the mapping review: they flow into the pipeline preview,
  // the pack build, and the coverage availability set.
  const [enrichments, setEnrichments] = useState<
    Readonly<Record<string, EnrichmentField[]>>
  >({});
  const enrichmentFieldNames = useMemo(
    () => [...new Set(Object.values(enrichments).flat().map((e) => e.field))],
    [enrichments],
  );

  // ---- Analytics Rule Coverage section (Unit 23) ------------------------
  // The coverage analyzer reports the schema-resolvable referenced-field set
  // (the kept Unit 18 ruleReferencedFields contract) back UP so the Gap
  // Analysis mapping table lights its RULE badges. Informational only - it
  // never participates in the deploy gate.
  const [ruleFields, setRuleFields] = useState<ReadonlySet<string>>();

  // CONTENT-FIRST ORDER (2026-07-12): each coverage instance reports what
  // its content REQUIRES; merged here and fed to the mapping review's
  // unused-field drop policy.
  const [ruleRequirements, setRuleRequirements] =
    useState<ContentRequirements | null>(null);
  const [workbookRequirements, setWorkbookRequirements] =
    useState<ContentRequirements | null>(null);
  const contentRequirements = useMemo(() => {
    const parts = [ruleRequirements, workbookRequirements].filter(
      (part): part is ContentRequirements => part !== null,
    );
    return parts.length > 0 ? mergeContentRequirements(parts) : null;
  }, [ruleRequirements, workbookRequirements]);
  // The coverage sections' explicit "Drop unneeded fields" action: bumps a
  // nonce the mapping review consumes (it applies the drops as reviewable
  // edits). Disabled with a reason when there is no safe evidence to act on.
  const [dropNonce, setDropNonce] = useState(0);
  const requestDropUnneeded = useCallback(() => {
    setDropNonce((n) => n + 1);
  }, []);
  const dropDisabledReason =
    contentRequirements === null || contentRequirements.itemCount === 0
      ? "No analyzed content yet - analyze coverage first."
      : contentRequirements.opaqueCatchAll
        ? "The solution's content parses the catch-all column opaquely - dropping fields could break it, so the action is disabled."
        : undefined;
  const dropUnneededEvent = useMemo(() => ({ nonce: dropNonce }), [dropNonce]);

  // One place the Sample Data section reports its list: keep the count (arc
  // completion / Samples pill) and the samples (match preview) in sync.
  const handleSamplesChange = useCallback((list: TaggedSample[]) => {
    setSamples(list);
    setSampleCount(list.length);
  }, []);

  // The Solution browser reports its selection here. On a real CHANGE (not the
  // initial pick or the on-refresh deep-link restore), the samples/mappings/
  // coverage were for the OLD solution, so clear the tagged-sample store and
  // reset every dependent bit; the contentResetKey bump remounts the sections
  // empty once the store is cleared.
  const handleSolutionChange = useCallback(
    (next: SolutionRef | null) => {
      const prevName = prevSolutionRef.current;
      const nextName = next?.name ?? null;
      prevSolutionRef.current = nextName;
      setSolution(next);
      // Persist across reloads (live 2026-07-13: uploading a new app
      // version reloaded the page, samples survived via their store but
      // the selection silently reset - the next analysis ran solution-less
      // with no packs, no rules, and no identity).
      void ports.contentCache
        ?.set(SELECTED_SOLUTION_KEY, nextName ?? "")
        .catch(() => undefined);
      if (prevName === null || prevName === nextName) {
        return;
      }
      setSamples([]);
      setSampleCount(0);
      setGapReports([]);
      setMappingsApproved(false);
      setMappingOverrides({});
      setRuleFields(undefined);
      void (async () => {
        const existing = await ports.samples.list();
        await Promise.all(existing.map((s) => ports.samples.remove(s.logType)));
        setContentResetKey((k) => k + 1);
      })();
    },
    [ports.samples, ports.contentCache],
  );

  // The detected format per log type (drives the pipeline preview's serde /
  // timestamp selection). Derived from the tagged samples the section reports.
  const sampleFormats = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const sample of samples) {
      map[sample.logType] = sample.format;
    }
    return map;
  }, [samples]);

  // Rename contract (Unit 11 -> Unit 18): the Sample Data section re-keys the
  // tagged-sample STORE entry itself; this handler forwards the rename to the
  // DCR Gap Analysis section so its log-type-keyed approvals and mapping edits
  // re-key by the same Unit 11 primitive (never orphaning them - the legacy
  // bug). The nonce makes a repeated from/to still fire the section's effect.
  const handleRenameLogType = useCallback(
    (from: string, to: string) => {
      ports.logger?.info("sample log type renamed", { from, to });
      renameNonce.current += 1;
      setRenameEvent({ from, to, nonce: renameNonce.current });
    },
    [ports],
  );

  // Populate the worker-group dropdown from the CriblClient port (same
  // pattern as OnboardTableScreen: raw error + retry, no silent empty list).
  // The persisted worker-group default wins the initial selection when it
  // exists in the live list; otherwise the first discovered group is used.
  const preferredGroup = criblDefaults?.workerGroup ?? "";
  const loadGroups = useCallback(async () => {
    setGroups(null);
    setGroupsError("");
    try {
      // Edge fleets cannot run these pipelines: Stream worker groups only.
      const list = (await ports.cribl.listGroups()).filter(isStreamWorkerGroup);
      setGroups(list);
      const preferred = list.some((g) => g.id === preferredGroup)
        ? preferredGroup
        : (list[0]?.id ?? "");
      setGroupId((current) => (current !== "" ? current : preferred));
    } catch (err) {
      setGroupsError(String(err));
    }
  }, [ports.cribl, preferredGroup]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  // Distinct worker groups the pack would be deployed to: the primary group
  // plus any extra groups when the multi-group toggle is on.
  const packTargetGroups = useMemo(() => {
    const set = new Set<string>();
    if (groupId !== "") set.add(groupId);
    if (multiGroup) for (const g of extraGroups) if (g !== "") set.add(g);
    return [...set];
  }, [groupId, multiGroup, extraGroups]);
  const packTargetKey = packTargetGroups.join(",");

  // Any change to the pack name or target groups invalidates a prior
  // conflict check and its overwrite acknowledgment.
  useEffect(() => {
    setPackConflicts(null);
    setOverwriteAcked(false);
    setConflictError("");
  }, [packName, packTargetKey]);

  // Live pack-name-exists check across the target groups. deployedGroups()
  // matches by pack id (tolerating @version / .child suffixes), so a rebuild
  // of the same-named pack is flagged as an overwrite before it happens.
  const checkPackConflicts = useCallback(async () => {
    const packInstall = ports.packInstall;
    if (packInstall === undefined) {
      setConflictError("Pack inventory is not available in this host.");
      return;
    }
    if (packTargetGroups.length === 0) {
      setConflictError("Select at least one worker group first.");
      return;
    }
    if (packName.trim() === "") {
      setConflictError("Enter a pack name first.");
      return;
    }
    setConflictChecking(true);
    setConflictError("");
    try {
      const deployed = await packInstall.listDeployed(packTargetGroups);
      setPackConflicts(deployedGroups(packName.trim(), deployed));
    } catch (err) {
      setConflictError(err instanceof Error ? err.message : String(err));
      setPackConflicts(null);
    } finally {
      setConflictChecking(false);
    }
  }, [ports.packInstall, packTargetGroups, packName]);

  // The pack build/install is blocked only while an ACKNOWLEDGED conflict is
  // pending: a checked, non-empty conflict list that the user has not accepted.
  const packOverwriteBlocked =
    packConflicts !== null && packConflicts.length > 0 && !overwriteAcked;

  // ---- Build and install pack (the content-path closer) -----------------
  // Assembles the pack from the APPROVED mappings (the same plan derivation
  // the pipeline preview renders), persists the build record (the Packs
  // screen lists/downloads it), and installs the .crbl into every target
  // worker group - honoring the overwrite check above. Deployed tables get
  // their REAL DCR values baked into outputs.yml (from the multi-DCR deploy
  // outcomes); undeployed tables ship the fill-in-Cribl placeholders.
  const [packBuilding, setPackBuilding] = useState(false);
  const [packBuildLines, setPackBuildLines] = useState<string[]>([]);
  // Structured pack result for the Deploy summary (user report 2026-07-13:
  // the summary showed only the native outcome, never the pack).
  const [packOutcome, setPackOutcome] = useState<{
    name: string;
    installs: Array<{ group: string; ok: boolean; detail: string }>;
  } | null>(null);

  // Required vendor identity (DeviceVendor/DeviceProduct and the ASim Event
  // pair): a table whose content filters on them must have every one covered
  // by the sample or an enrichment constant before a pipeline ships. Same core
  // resolver the Gap Analysis cards render their forced-input rows from.
  const identityGateReason = useMemo(
    () =>
      identityGateMessage(
        gapReports.map((report) => ({
          tableName: report.tableName,
          missing: missingIdentityFields(
            report.tableName,
            mappingOverrides[report.logType] ?? report.fieldMappings,
            enrichments[report.logType] ?? [],
          ),
        })),
      ),
    [gapReports, mappingOverrides, enrichments],
  );

  // The single unlock condition for the build, in dependency order.
  const packBuildDisabledReason =
    ports.packs === undefined || ports.packInstall === undefined
      ? "Pack build is not available in this host."
      : !mappingsApproved
        ? "Approve the DCR Gap Analysis mappings (section 3) first - the pack is built from them."
        : identityGateReason !== null
          ? identityGateReason
          : packName.trim() === ""
            ? "Enter a pack name."
            : packTargetGroups.length === 0
              ? "Select at least one worker group."
              : packOverwriteBlocked
                ? "Acknowledge the pack overwrite above."
                : null;

  const buildAndInstallPack = useCallback(async () => {
    const packStore = ports.packs;
    const packInstall = ports.packInstall;
    const name = packName.trim();
    if (
      packBuilding ||
      packStore === undefined ||
      packInstall === undefined ||
      name === "" ||
      packTargetGroups.length === 0 ||
      !mappingsApproved ||
      identityGateReason !== null
    ) {
      // NEVER skip silently (live 2026-07-13: a green Deploy run shipped no
      // pack and nothing said why) - name the first unmet prerequisite.
      setPackBuildLines([
        `Pack build skipped: ${
          packStore === undefined || packInstall === undefined
            ? "pack build is not available in this host."
            : name === ""
              ? "no pack name."
              : packTargetGroups.length === 0
                ? "no worker group selected."
                : !mappingsApproved
                  ? "the DCR Gap Analysis mappings are not approved (section 3)."
                  : (identityGateReason ?? "a build is already running.")
        }`,
      ]);
      return;
    }
    setPackBuilding(true);
    const lines: string[] = [];
    const push = (line: string) => {
      lines.push(line);
      setPackBuildLines([...lines]);
      ports.logger?.info(`pack-build: ${line}`);
    };
    setPackBuildLines([]);
    setPackOutcome(null);
    const installs: Array<{ group: string; ok: boolean; detail: string }> = [];
    try {
      // 1. Overwrite guard: always re-check live, then honor the acknowledgment.
      push(
        `Checking for an existing pack named "${name}" in ${packTargetGroups.join(", ")}...`,
      );
      const deployed = await packInstall.listDeployed(packTargetGroups);
      const conflicts = deployedGroups(name, deployed);
      setPackConflicts(conflicts);
      if (conflicts.length > 0 && !overwriteAcked) {
        push(
          `A pack named "${name}" already exists in ${conflicts.join(", ")}. ` +
            "Acknowledge the overwrite above, then build again.",
        );
        return;
      }
      push(
        conflicts.length > 0
          ? `Overwrite acknowledged for ${conflicts.join(", ")}.`
          : "The name is free in every target group.",
      );

      // A rebuild ships an INCREMENTED version (live 2026-07-13: every
      // rebuild said 1.0.0, indistinguishable in Cribl) - the next patch
      // above the highest installed copy, from the same listing the
      // overwrite check fetched.
      const packVersion = nextPackVersion(installedPackVersions(deployed, name));

      // 2. Resolve the plan - the SAME derivation the pipeline preview renders,
      // including the Cribl YAML validation (an invalid plan never ships).
      const preview = derivePipelinePreview({
        solutionName: solution?.name ?? "",
        packName: name,
        reports: gapReports,
        mappingOverrides,
        sampleFormats,
        enrichments,
        approved: mappingsApproved,
        version: packVersion,
      });
      if (!preview.available || preview.plan === null) {
        push(`Cannot build: ${preview.emptyReason ?? "no pipeline plan available"}`);
        return;
      }
      if (!preview.valid) {
        push(
          `Cannot build: Cribl YAML validation found ${preview.totalYamlIssues} ` +
            "issue(s) - see the pipeline preview in section 3.",
        );
        return;
      }
      const plan = preview.plan;
      push(
        `Plan resolved: ${plan.tables.length} pipeline(s) for ` +
          `${plan.tables.map((t) => t.logType).join(", ")}.`,
      );

      // 3. Compose the assembly input: the reviewer's effective mappings feed
      // the lookup CSVs; deployed tables carry their real DCR destination.
      const ingestId =
        ingestionClientId.trim() === "" ? config.clientId : ingestionClientId.trim();
      const reportByLogType = new Map(gapReports.map((r) => [r.logType, r]));
      const tableInputs: TableAssemblyInput[] = plan.tables.map((table) => {
        const report = reportByLogType.get(table.logType);
        const effective =
          report !== undefined
            ? (mappingOverrides[report.logType] ?? report.fieldMappings)
            : [];
        const outcomeEntry = outcomes.find((o) => o.table === table.sentinelTable);
        return {
          ...(effective.length > 0
            ? {
                fieldOverrides: effective.map((m) => ({
                  source: m.source,
                  dest: m.dest,
                  sourceType: m.sourceType,
                  destType: m.destType,
                  confidence: m.confidence,
                  action: m.action,
                  needsCoercion: m.needsCoercion,
                  description: m.description,
                })),
              }
            : {}),
          ...(outcomeEntry !== undefined
            ? {
                destination: {
                  id: outcomeEntry.outcome.destinationId,
                  dcrImmutableId: outcomeEntry.outcome.dcrImmutableId,
                  ingestionEndpoint: outcomeEntry.outcome.logsIngestionEndpoint,
                  streamName: outcomeEntry.outcome.streamName,
                  tenantId: config.tenantId,
                  ingestionClientId: ingestId,
                },
              }
            : {}),
        };
      });
      const vendorSamples: PackVendorSample[] = samples
        .filter((s) => reportByLogType.has(s.logType))
        .map((s) => {
          const report = reportByLogType.get(s.logType);
          return {
            tableName: report !== undefined ? report.tableName : "",
            rawEvents: s.rawEvents,
            source: `${solution?.name ?? "solution"}:${s.logType}`,
            logType: s.logType,
            format: s.format,
          };
        })
        .filter((s) => s.tableName !== "");
      const definition: PackScaffoldInput = {
        plan,
        tableInputs,
        vendorSamples,
        builtAtMs: Date.now(),
        outputsDefaults: { tenantId: config.tenantId, ingestionClientId: ingestId },
      };

      // 4. Assemble deterministically and persist the build record.
      const assembled = assemblePack(definition);
      push(
        `Assembled ${assembled.crblFileName} (${assembled.crbl.length.toLocaleString()} bytes).`,
      );
      // The record is a CONVENIENCE (the Packs screen lists/downloads it);
      // the install below is the point. A store failure - live 2026-07-13:
      // the leader's kvstore answered HTTP 413 for a 103 KB record - must
      // never abort the install.
      try {
        await packStore.put({ record: assembled.record, definition });
        push("Build record saved - the pack is also downloadable from the Packs screen.");
      } catch (err) {
        push(
          `Build record NOT saved (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) - continuing with the install; rebuild from this page to reproduce the pack.`,
        );
      }

      // 5. Install into every target group; per-group failures are reported
      // and never abort the remaining groups.
      for (const group of packTargetGroups) {
        try {
          const installed = await packInstall.install(
            group,
            assembled.crblFileName,
            assembled.crbl,
          );
          // Report the pack ID, not the display name (live 2026-07-13: a
          // server-side rename hid behind the pretty displayName).
          push(`Installed '${installed.id}' on ${group}.`);
          installs.push({
            group,
            ok: true,
            detail: `installed as '${installed.id}'`,
          });
        } catch (err) {
          push(
            `Install FAILED on ${group}: ${err instanceof Error ? err.message : String(err)}`,
          );
          installs.push({
            group,
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
      setPackOutcome({ name, installs });
      push(
        "Done. Wire a source below (or commit and deploy in Cribl) to activate the pack.",
      );
    } catch (err) {
      push(`Build failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPackBuilding(false);
    }
  }, [
    ports.packs,
    ports.packInstall,
    ports.logger,
    packBuilding,
    packName,
    packTargetGroups,
    mappingsApproved,
    overwriteAcked,
    solution,
    gapReports,
    mappingOverrides,
    sampleFormats,
    enrichments,
    identityGateReason,
    outcomes,
    samples,
    config,
    ingestionClientId,
  ]);

  // ---- Derived section states, readiness pills, deploy gate -------------
  const sectionInputs = deriveSectionInputs({
    solutionSelected,
    scopeCommitted,
    workerGroup: groupId,
    packName,
    deployCompleted,
    sampleCount,
    mappingsApproved,
  });
  const resolved = deriveSectionStatuses(sectionInputs);
  // Mode-aware pills (Unit 20): the full pill set with the skipped side's
  // prerequisite hidden. In "full" this is identical to the un-gated set, so
  // the operable native path is unchanged.
  const pills = readinessPillsForMode(sectionInputs, mode);

  // The single unlock condition, in dependency order: the arc's built
  // prerequisites first (scope -> worker group -> pack name, from the pure
  // module), then the concrete native-run fields the arc model does not
  // track (a table name and an ingestion identity).
  const runDisabledReason =
    deployDisabledReason(sectionInputs) ??
    (deployTargets.length === 0
      ? "Enter a native table name in the Deploy section."
      : ingestionClientId.trim() === ""
        ? "Enter an ingestion client id in the Deploy section."
        : null);

  const runDeploy = useCallback(async (): Promise<boolean> => {
    const targets = deployTargets;
    const trimmedClientId = ingestionClientId.trim();
    if (
      deploying ||
      targets.length === 0 ||
      groupId === "" ||
      trimmedClientId === ""
    ) {
      return false;
    }
    let allOk = true;
    setDeploying(true);
    setOutcome(null);
    setOutcomes([]);
    setRunError("");
    // One DCR per detected table, deployed in sequence. Each table gets its own
    // honest step list (onProgress matches by unprefixed step name); outcomes
    // accumulate so the summary reports every deployed DCR. A failing table
    // stops the run and surfaces which table failed.
    const collected: Array<{ table: string; outcome: OnboardTableOutcome }> = [];
    try {
      for (const target of targets) {
        setSteps(
          onboardTableStepsFor(target).map((name) => ({
            name,
            status: "pending",
          })),
        );
        // Custom (_CL) targets ride the SAME job: the create-custom-table step
        // (idempotent - an existing table's schema wins) uses the destination
        // schema the Gap Analysis resolved for this table, so a solution
        // mapping to a not-yet-existing custom table deploys end to end here.
        const schemaReport = gapReports.find((r) => r.tableName === target);
        const record = await onboardTable(ports, {
          table: target,
          ...(schemaReport !== undefined && schemaReport.destSchema.length > 0
            ? { customSchema: schemaReport.destSchema }
            : {}),
          ...(operationDefaults?.customTableRetentionDays !== undefined
            ? {
                customTableRetentionDays:
                  operationDefaults.customTableRetentionDays,
              }
            : {}),
          ...(criblDefaults !== undefined
            ? { destinationId: destinationIdFromOptions(target, criblDefaults) }
            : {}),
          subscriptionId: config.subscriptionId,
          resourceGroup: config.resourceGroup,
          workspaceName: config.workspaceName,
          groupId,
          tenantId: config.tenantId,
          ingestionClientId: trimmedClientId,
          ingestionClientSecret:
            ingestionClientSecret === "" ? undefined : ingestionClientSecret,
          onProgress: (step) => {
            setSteps((prev) =>
              prev.map((s) => (s.name === step.name ? { ...step } : s)),
            );
          },
        });
        if (record.status === "succeeded") {
          const result = record.result as OnboardTableOutcome;
          collected.push({ table: target, outcome: result });
          setOutcome(result);
          setOutcomes([...collected]);
          setDeployCompleted(true);
          // Register the just-deployed DCR as an ingestion-role target. The
          // outcome carries the exact deployed name and its scope, so the role
          // step addresses it precisely without predicting a name.
          setRoleTargets((prev) =>
            upsertRoleTarget(prev, {
              dcrResourceId: dcrResourceIdFor({
                subscriptionId: result.subscriptionId,
                resourceGroup: result.resourceGroup,
                dcrName: result.dcrName,
              }),
              table: target,
            }),
          );
        } else {
          setRunError(
            `${target}: ${record.error ?? "onboarding failed but recorded no error text"}`,
          );
          allOk = false;
          break;
        }
      }
    } catch (err) {
      setRunError(String(err));
      allOk = false;
    } finally {
      // The secret is transient: never kept after the run it was typed for.
      setIngestionClientSecret("");
      setDeploying(false);
      setHistoryToken((n) => n + 1);
    }
    return allOk;
  }, [
    deployTargets,
    ingestionClientId,
    ingestionClientSecret,
    deploying,
    groupId,
    ports,
    criblDefaults,
    config,
    gapReports,
    operationDefaults,
  ]);

  const deployStatus: DeployStatus = deploying
    ? "running"
    : outcome !== null
      ? "ok"
      : runError !== ""
        ? "failed"
        : "idle";

  // ONE deploy action (user direction 2026-07-12): the button at the end
  // deploys EVERYTHING - the native path (tables, DCRs, destination), then
  // the content pack when the content path is engaged. With gap reports
  // present the pack gates join the unlock condition, so a partial deploy
  // can no longer surprise; without reports (pure quick-onboard) the native
  // path deploys alone.
  const packPortsAvailable =
    ports.packs !== undefined && ports.packInstall !== undefined;
  const contentEngaged = gapReports.length > 0 && packPortsAvailable;
  const deployEverythingDisabledReason =
    runDisabledReason ?? (contentEngaged ? packBuildDisabledReason : null);
  const runDeployEverything = useCallback(async () => {
    ports.logger?.info("deploy-everything: starting", {
      targets: deployTargets.join(","),
      contentPack: contentEngaged,
    });
    const nativeOk = await runDeploy();
    ports.logger?.info("deploy-everything: native path finished", {
      ok: nativeOk,
    });
    if (nativeOk && contentEngaged) {
      await buildAndInstallPack();
      ports.logger?.info("deploy-everything: pack build finished");
    }
  }, [runDeploy, buildAndInstallPack, contentEngaged, deployTargets, ports.logger]);

  const createDCE = (operationDefaults ?? DEFAULT_OPERATION_OPTIONS).createDCE;

  // ---- Section bodies (built sections only) -----------------------------

  const solutionBody = <SolutionBrowser onSelect={handleSolutionChange} />;

  const sampleDataBody = (
    <>
      <SampleIntakeSection
        key={contentResetKey}
        store={ports.samples}
        onSamplesChange={handleSamplesChange}
        onRenameLogType={handleRenameLogType}
        solutionName={solution?.name ?? ""}
        {...(ports.content !== undefined ? { content: ports.content } : {})}
        {...(ports.sampleSource !== undefined
          ? { sampleSource: ports.sampleSource }
          : {})}
        {...(ports.logger !== undefined ? { logger: ports.logger } : {})}
      />
    </>
  );

  const gapAnalysisBody = (
    <>
      <MappingReviewSection
        key={contentResetKey}
        solutionName={solution?.name ?? ""}
        samples={samples}
        content={ports.content}
        learnedCache={ports.contentCache}
        ruleFields={ruleFields}
        onGateChange={setMappingsApproved}
        onReportsChange={setGapReports}
        onEffectiveMappingsChange={setMappingOverrides}
        onEnrichmentsChange={setEnrichments}
        renameEvent={renameEvent}
        contentRequirements={contentRequirements}
        dropUnneededEvent={dropUnneededEvent}
        logger={ports.logger}
      />
      {/* COLLAPSED by default: the full per-pipeline detail is reference
          material, not a decision point - expand on demand. */}
      <details className="integrate-subsection pipeline-preview-details">
        <summary className="pipeline-preview-summary">
          Pipeline preview
          <span className="field-hint pipeline-preview-summary-hint">
            the exact pipelines, reduction rules, and routes a build would
            generate - expand to review
          </span>
        </summary>
        <PipelinePreviewSection
          key={contentResetKey}
          solutionName={solution?.name ?? ""}
          packName={packName}
          reports={gapReports}
          mappingOverrides={mappingOverrides}
          sampleFormats={sampleFormats}
          enrichments={enrichments}
          approved={mappingsApproved}
        />
      </details>
    </>
  );

  const ruleCoverageBody = (
    <RuleCoverageSection
      key={contentResetKey}
      solutionName={solution?.name ?? ""}
      reports={gapReports}
      content={ports.content}
      onRuleFieldsChange={setRuleFields}
      contentFilter="rules"
      extraAvailableFields={enrichmentFieldNames}
      onContentRequirementsChange={setRuleRequirements}
      onDropUnneededFields={requestDropUnneeded}
      {...(dropDisabledReason !== undefined ? { dropDisabledReason } : {})}
    />
  );

  const workbookCoverageBody = (
    <RuleCoverageSection
      key={contentResetKey}
      solutionName={solution?.name ?? ""}
      reports={gapReports}
      content={ports.content}
      contentFilter="workbooks"
      extraAvailableFields={enrichmentFieldNames}
      onContentRequirementsChange={setWorkbookRequirements}
      onDropUnneededFields={requestDropUnneeded}
      {...(dropDisabledReason !== undefined ? { dropDisabledReason } : {})}
    />
  );

  // Enable Sentinel Content (section 6): install the solution, its analytics
  // rules, and its workbooks - Sentinel-side, informational, never gates the
  // deploy. Keyed by solution so switching solutions resets its state.
  const enableContentBody = (
    <ContentInstallSection
      key={`content-${solution?.name ?? "none"}`}
      solutionName={solution?.name ?? ""}
      scopeCommitted={scopeCommitted}
    />
  );

  const azureResourcesBody = (
    <>
      <AzureTargetingScreen offline={offline} onCommitScope={onCommitScope} />
      <div className="discovery-result">
        <span className="field-label">
          Deployment capabilities
          <InfoTip text="What the deploy provisions and grants. Toggle the optional DCE here (saved with your deployment Options); the DCR and the ingestion-role grant are always part of the deploy." />
        </span>
        <label className="integrate-check">
          <input
            type="checkbox"
            checked={createDCE}
            disabled={onOperationChange === undefined}
            onChange={(e) =>
              onOperationChange?.({
                ...(operationDefaults ?? DEFAULT_OPERATION_OPTIONS),
                createDCE: e.target.checked,
              })
            }
          />
          <span className="integrate-check-text">
            Create a DCE ({createDCE ? "enabled" : "disabled"})
            <InfoTip text="A Data Collection Endpoint enables private-endpoint (AMPLS) connectivity. Toggled here and saved with your deployment Options; without it the DCR uses its direct ingestion endpoint." />
          </span>
        </label>
        <div className="integrate-fact">
          <span className="integrate-fact-badge">Always on</span>
          <span className="integrate-check-text">
            DCR provisioning
            <InfoTip text="The Data Collection Rule the Cribl destination sends events to is always provisioned by the deploy." />
          </span>
        </div>
        <div className="integrate-fact">
          <span className="integrate-fact-badge">Always on</span>
          <span className="integrate-check-text">
            Ingestion role grant
            <InfoTip text="Monitoring Metrics Publisher is assigned to the ingestion identity per deployed DCR (in the step below) - data cannot flow to a DCR without it." />
          </span>
        </div>
        {onOpenOptions !== undefined && (
          <div className="panel-controls">
            <button className="run-button" onClick={onOpenOptions}>
              Open Options
            </button>
          </div>
        )}
      </div>
      <RoleAssignmentSection
        targets={roleTargets}
        clientId={config.clientId}
        roleGuidance={roleGuidance}
      />
    </>
  );

  const criblConfigBody = (
    <div className="form-grid">
      <label className="field">
        <span className="field-label">Cribl worker group</span>
        {groups !== null ? (
          <SearchableSelect
            options={groups.map((g) => ({
              value: g.id,
              label: g.id,
              hint: g.product,
            }))}
            value={groupId}
            onChange={setGroupId}
            placeholder="Select a worker group..."
            ariaLabel="Filter worker groups"
          />
        ) : groupsError === "" ? (
          <span className="field-hint">Loading worker groups...</span>
        ) : (
          <span className="field-hint">
            Could not list worker groups: {groupsError}
          </span>
        )}
        {groupsError !== "" && (
          <button className="run-button" onClick={() => void loadGroups()}>
            Retry loading groups
          </button>
        )}
        <span className="field-hint">
          The worker group that will run the pipelines. Prefilled from your
          saved Options when that group exists in the live list.
        </span>
      </label>
      <label className="field">
        <span className="field-label">Pack name</span>
        <input
          type="text"
          value={packName}
          onChange={(e) => setPackName(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="field-hint">
          The pack that will be built and installed by Build and install pack
          below (from the approved Gap Analysis mappings). Prefilled from the
          destination prefix in Options; editable.
        </span>
      </label>
      <div className="discovery-result">
        <span className="field-label">Deploy targets and overwrite check</span>
        <p className="panel-desc">
          The pack deploys to the primary worker group above. Optionally fan it
          out to additional groups, then check whether the name is already in
          use before building - a matching pack is overwritten, so the check
          must be acknowledged first.
        </p>
        <label className="integrate-check">
          <input
            type="checkbox"
            checked={multiGroup}
            onChange={(e) => setMultiGroup(e.target.checked)}
          />
          <span className="integrate-check-text">
            Deploy the pack to multiple worker groups.
            {multiGroup ? " Select the additional groups below." : ""}
          </span>
        </label>
        {multiGroup &&
          (groups !== null ? (
            groups.filter((g) => g.id !== groupId).length > 0 ? (
              <label className="field">
                <span className="field-label">Additional worker groups</span>
                <SearchableMultiSelect
                  options={groups
                    .filter((g) => g.id !== groupId)
                    .map((g) => ({ value: g.id, label: g.id, hint: g.product }))}
                  values={extraGroups}
                  onChange={setExtraGroups}
                  placeholder="Select additional worker groups..."
                  ariaLabel="Filter worker groups"
                />
              </label>
            ) : (
              <span className="field-hint">
                No other worker groups are available to fan out to.
              </span>
            )
          ) : (
            <span className="field-hint">Loading worker groups...</span>
          ))}
        <div className="integrate-check">
          <button
            className="run-button"
            disabled={
              conflictChecking ||
              packTargetGroups.length === 0 ||
              packName.trim() === ""
            }
            onClick={() => void checkPackConflicts()}
          >
            {conflictChecking ? "Checking..." : "Check for existing packs"}
          </button>
          <span className="integrate-check-text">
            Looks for a pack named {packName.trim() === "" ? "(unset)" : `"${packName.trim()}"`} in{" "}
            {packTargetGroups.length === 0
              ? "(no target groups)"
              : packTargetGroups.join(", ")}
            .
          </span>
        </div>
        {conflictError !== "" && (
          <span className="field-hint" style={{ color: "var(--error, #f5738b)" }}>
            Could not check packs: {conflictError}
          </span>
        )}
        {conflictError === "" &&
          packConflicts !== null &&
          (packConflicts.length === 0 ? (
            <span className="field-hint" style={{ color: "var(--ok, #4ec9b0)" }}>
              No existing pack named &quot;{packName.trim()}&quot; in the target
              group{packTargetGroups.length > 1 ? "s" : ""} - safe to build.
            </span>
          ) : (
            <label className="integrate-check">
              <input
                type="checkbox"
                checked={overwriteAcked}
                onChange={(e) => setOverwriteAcked(e.target.checked)}
              />
              <span
                className="integrate-check-text"
                style={{ color: "var(--warn, #d7ba7d)" }}
              >
                A pack named &quot;{packName.trim()}&quot; already exists in{" "}
                {packConflicts.join(", ")}. Building will overwrite it there -
                check to acknowledge and allow the overwrite.
              </span>
            </label>
          ))}
        {packOverwriteBlocked && (
          <span className="field-hint" style={{ color: "var(--warn, #d7ba7d)" }}>
            Overwrite not yet acknowledged - the pack build will refuse to
            overwrite until the box above is checked.
          </span>
        )}
      </div>
      <div className="discovery-result">
        <span className="field-label">
          Pack rebuild
          <InfoTip text="The pack ships automatically with Deploy in the Deploy section. Use this only to rebuild and reinstall the pack alone after editing mappings - no Azure resources are touched. Builds from the APPROVED Gap Analysis mappings (the exact pipelines, reduction rules, routes, breakers, samples, and lookups previewed in section 3); deployed tables carry their real DCR values, others a fill-in-Cribl placeholder; the pack name and overwrite acknowledgment above are honored." />
        </span>
        <div className="panel-controls">
          <button
            className="gap-reset-button"
            onClick={() => void buildAndInstallPack()}
            disabled={packBuilding || packBuildDisabledReason !== null}
            title={packBuildDisabledReason ?? undefined}
          >
            {packBuilding
              ? "Building..."
              : `Rebuild pack only (${packTargetGroups.length} group${packTargetGroups.length === 1 ? "" : "s"})`}
          </button>
          {packBuildDisabledReason !== null && !packBuilding && (
            <span className="field-hint">{packBuildDisabledReason}</span>
          )}
        </div>
        {packBuildLines.length > 0 && (
          <pre className="result">{packBuildLines.join("\n")}</pre>
        )}
      </div>
    </div>
  );

  const deployBody = (
    <>
      <p className="panel-desc">
        Workspace:{" "}
        {config.workspaceName === "" ? "(not set)" : config.workspaceName};
        worker group: {groupId === "" ? "(none selected)" : groupId}.
        <InfoTip text="Deploys a Kind:Direct Data Collection Rule per detected table in the workspace and creates the matching Cribl Sentinel destination in the worker group. Custom (_CL) tables that do not exist yet are created first from the Gap Analysis schema (an existing table's schema always wins). Each step reports its real outcome." />
      </p>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Table name</span>
          <input
            type="text"
            value={table}
            onChange={(e) => {
              tableTouchedRef.current = true;
              setTable(e.target.value);
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field-hint">
            {detectedTables.length > 0 ? (
              <>
                Detected: {detectedTables.join(", ")}
                {detectedTables.length > 1
                  ? ` (${detectedTables.length} DCRs)`
                  : ""}
                <InfoTip text="Detected from the solution's Gap Analysis and prefilled (editable). With several tables, deploy provisions one DCR per table; the field shows the first." />
              </>
            ) : (
              <>
                No table detected yet.
                <InfoTip text="A Log Analytics table (e.g. SecurityEvent, Syslog, or a custom MyVendor_CL). Add samples and run the DCR Gap Analysis above to auto-detect the solution's table(s); a custom (_CL) table is created at deploy time from the analysis schema when it does not exist yet." />
              </>
            )}
          </span>
        </label>
        <label className="field">
          <span className="field-label">Ingestion client id</span>
          <input
            type="text"
            value={ingestionClientId}
            onChange={(e) => setIngestionClientId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field-hint">
            Defaults to the active connection.
            <InfoTip text="The app registration the Cribl destination authenticates with when sending events. Defaults to the active connection's client id." />
          </span>
        </label>
        <label className="field">
          <span className="field-label">
            Ingestion client secret (optional)
          </span>
          <input
            type="password"
            value={ingestionClientSecret}
            onChange={(e) => setIngestionClientSecret(e.target.value)}
            autoComplete="new-password"
          />
          <span className="field-hint">
            Optional; used for this run only.
            <InfoTip
              text={`Transient: this platform's encrypted storage is write-only, so the app cannot reuse a stored secret here. Provide it to bake it into the destination for this run only, or leave blank to create the destination with the ${SENTINEL_SECRET_PLACEHOLDER} placeholder and paste the real secret in Cribl's UI.`}
            />
          </span>
        </label>
      </div>
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void runDeployEverything()}
          disabled={deployEverythingDisabledReason !== null || deploying || packBuilding}
          title={deployEverythingDisabledReason ?? undefined}
        >
          {deploying
            ? "Deploying..."
            : packBuilding
              ? "Installing pack..."
              : contentEngaged
                ? "Deploy everything"
                : "Deploy"}
        </button>
        <span className={`status status-${deployStatus}`}>{deployStatus}</span>
        <InfoTip
          text={
            "One action, in order: per detected table - create the custom table if needed, deploy its Kind:Direct DCR, create the matching Cribl Sentinel destination; then, when the Gap Analysis mappings are approved, build the content pack from them and install it into every selected worker group. The button unlocks only when every prerequisite for the whole run is met (the tooltip names the first missing one)."
          }
        />
        {deployEverythingDisabledReason !== null && !deploying && (
          <span className="field-hint">{deployEverythingDisabledReason}</span>
        )}
      </div>
      {steps.length > 0 && (
        <pre className="result">{steps.map(formatStepLine).join("\n")}</pre>
      )}
      {packBuildLines.length > 0 && (
        <pre className="result">{packBuildLines.join("\n")}</pre>
      )}
      {runError !== "" && <pre className="result">{runError}</pre>}
      {outcomes.length > 0 && (
        <div className="discovery-result">
          <span className="field-label">
            Deploy summary
            {outcomes.length > 1 ? ` (${outcomes.length} DCRs)` : ""}
          </span>
          <pre className="result">
            {[
              ...outcomes.map(({ table: t, outcome: o }) =>
                outcomes.length > 1
                  ? `== ${t} ==\n${summaryText(o)}`
                  : summaryText(o),
              ),
              ...(packOutcome !== null
                ? [
                    `Pack:            ${packOutcome.name}\n` +
                      packOutcome.installs
                        .map(
                          (i) =>
                            `  ${i.group}:${" ".repeat(Math.max(1, 14 - i.group.length))}${i.ok ? i.detail : `FAILED - ${i.detail}`}`,
                        )
                        .join("\n"),
                  ]
                : []),
            ].join("\n\n")}
          </pre>
        </div>
      )}
      <p className="panel-desc">
        What a green run proves: the DCR provisioned and the Cribl destination
        exists. It does NOT validate data flow - that requires a source
        actually sending events through the destination. Before events ingest,
        the ingestion identity needs the Monitoring Metrics Publisher role on
        the deployed DCR (see the Azure Resources section above).
      </p>
      <RecentRuns refreshToken={historyToken} />
      {canWireSource(deployCompleted, mode) && (
        <div className="integrate-subsection">
          <span className="field-label">Source wiring</span>
          <p className="panel-desc">
            The destination is live - now connect a Cribl source to it. This
            creates the Sentinel route (and an optional non-final Cribl Lake
            route above it, cloud only), commits, and deploys to the worker
            group. Each action below is independently re-runnable.
          </p>
          <WiringSection
            deployCompleted={deployCompleted}
            mode={mode}
            deploymentType={ports.criblDeploymentType}
            workerGroup={groupId}
            packName={packName}
          />
        </div>
      )}
    </>
  );

  const sectionBody = (id: IntegrateSectionId): ReactNode => {
    switch (id) {
      case "solution":
        return solutionBody;
      case "sample-data":
        return sampleDataBody;
      case "azure-resources":
        return azureResourcesBody;
      case "cribl-config":
        return criblConfigBody;
      case "gap-analysis":
        return gapAnalysisBody;
      case "rule-coverage":
        return ruleCoverageBody;
      case "workbook-coverage":
        return workbookCoverageBody;
      case "enable-content":
        return enableContentBody;
      case "deploy":
        return deployBody;
      default:
        return null;
    }
  };

  return (
    <div className="integrate-page">
      <header className="integrate-header">
        <h1 className="integrate-title">Cribl Sentinel Integration</h1>
        <p className="integrate-subtitle">
          Configure and deploy a complete Cribl-to-Sentinel integration
          pipeline.
        </p>
      </header>
      {resolved.map(({ section, status, reason }) => (
        <NumberedSection
          key={section.id}
          number={section.number}
          title={section.title}
          status={status}
          infoTip={section.infoTip}
          reason={reason}
          shippedInUnit={section.shippedInUnit}
        >
          {sectionBody(section.id)}
        </NumberedSection>
      ))}
      <ReadinessFooter
        pills={pills}
        canDeploy={deployEverythingDisabledReason === null}
        onDeploy={() => void runDeployEverything()}
        deploying={deploying || packBuilding}
        disabledReason={deployEverythingDisabledReason}
      />
    </div>
  );
}
