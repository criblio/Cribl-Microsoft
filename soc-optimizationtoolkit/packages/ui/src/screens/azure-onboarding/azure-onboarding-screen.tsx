/**
 * AzureOnboardingScreen - Azure Native Source Onboarding (AZR-18, extended by
 * AZR-30..34). Every Azure-native source the coverage catalog knows, grouped by
 * how it is collected, with the ones that can be deployed today - the Defender
 * for Cloud alert export and the subscription Activity Log setting (AZR-98) -
 * working end to end, and every other row visible with the reason it cannot
 * be deployed beside it. Below them: the dataflow diagram per chosen source,
 * the How-to path (guided steps with done ticks), the read-only Validate, and
 * the Cribl Stream source the app creates.
 *
 * ONE VISIBLE CHOICE PER SOURCE (ADR 0007 section 2).
 * Section 2, "Choose what to onboard", is the only place a source is chosen,
 * with its Automate | How-to toggle. The method sections after it are status
 * only: each row says whether its source is chosen and how (howto-state
 * rowChoices over isChosen/effectiveMode, never the selection directly), its
 * deployment state and why it cannot be deployed yet.
 *
 * A THIN COMPOSER. Every decision lives in azure-onboarding-state.ts and the
 * howto/, validate/, cribl-source/ and dataflow/ state modules (pure,
 * unit-tested) and in @soc/core; this file wires them to the ports:
 *
 *   - MOUNT makes exactly THREE kvDocuments loads - the saved selection and
 *     the How-to progress document (ADR 0007 D1), each guarded by a cancelled
 *     flag, and the app-wide tenant to Cribl mapping (AZR-64) - plus, only
 *     when the tenant's own progress document exists, the read-only check of
 *     the legacy progress key and its claim for stranded Cribl source records
 *     (AZR-96) - and ZERO
 *     Azure or Cribl calls. Nothing is read from Azure or
 *     Cribl until the operator asks (Find namespaces, Read Defender state,
 *     Load resource groups, Validate, Load worker groups, Read the namespace's
 *     rules, Read Cribl side, Watch for data), because each read spends the
 *     shared proxy budget. Worker groups come from useStreamWorkerGroups with
 *     auto:false.
 *   - THE SELECTION SAVES PER CLICK too. Choosing or unchoosing an Automated
 *     source, or a mode change that carries a choice into the selection,
 *     writes the selection document once, at once, serialized through its own
 *     promise chain - exactly like progress below, including the failure
 *     handling: the screen keeps showing the change, says it was NOT saved,
 *     and the next change retries with everything shown. Only after an
 *     `absent` load or a readable document of ours (canWriteSelection); a read
 *     that FAILED, a foreign document, one this release cannot read and a
 *     shell with no store all block it. Entries for How-to sources are
 *     carried as they are and rewritten only by that source's own choice or
 *     mode change.
 *   - PROGRESS SAVES PER CLICK (D3): a tick, a mode change, choosing a source,
 *     Apply on the plan values, a complete Event Hub pick in section 1 while
 *     the plan's Event Hub names follow it (AZR-102), the switch between
 *     following section 1 and the operator's own names, the worker group and
 *     a created Cribl source each write the progress document once, serialized through one promise
 *     chain and a latest-state ref. Only after an `absent` or readable load
 *     (canWriteProgress); a failed progress load blocks those writes, and
 *     with them every choice, because the mode lives in progress.
 *   - VALIDATE never runs unpaced: without a `pacing` prop it is disabled with
 *     its reason; with one, the Azure port is wrapped in paceAzureManagement at
 *     the Validate rate. The budget is per run.
 *   - THE WORKER GROUP the Cribl source is created in, and the live flow and
 *     Cribl side are read from, is the TENANT'S mapped group (ADR 0009
 *     decision 5). Only when the mapping names none for this tenant does the
 *     screen's own picker decide, and the screen says so; an unreadable
 *     mapping blocks all three rather than falling back (group-choice.ts).
 *   - THE CRIBL SOURCE is planned read-only, confirmed, then created by core's
 *     applyCriblSource. A pasted credential never reaches React state or the
 *     progress document: the panel holds it and hands the apply a closure.
 *
 * PERMISSIONS TO AUTOMATE (AZR-60). The Defender section reads the CACHED
 * capability audit from the ports context and renders a banner over it; that
 * adds no load and no Azure call on mount. Its How-to button focuses the
 * source's How-to radio in Choose what to onboard (the row is in Automate mode
 * while the section renders, and steps appear only once it is switched), and
 * its Re-check permissions is the shell's (the `onRecheckPermissions` prop) -
 * this screen never re-audits. The shell also passes its audit key, so a set
 * measured for another connection never blocks Deploy, and its clock, so a
 * blocking denial says how old it is.
 *
 * THE TENANT GAPS ABOVE IT (AZR-147). The shell renders this screen inside
 * tenants/azure-onboarding-page.tsx, under All tenants (the tenant gap grid)
 * and Focus here. Two props come down from there and add no read: `gapSources`
 * badges each source the active tenant's latest gap read measured red, and
 * `jumpTo` focuses a source's row in Choose what to onboard once the saved
 * choices have answered. The page's own mount read (the saved gap reads) is
 * its own; this screen's mount loads are unchanged.
 *
 * Logging goes through ports.logger with the `azure-onboarding:` prefix and
 * never carries a secret.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  COVERAGE_SELECTION_KEY,
  ACTIVITY_LOG_ITEM_ID,
  ACTIVITY_LOG_SETTING_NAME,
  DEFENDER_EXPORT_ITEM_ID,
  ONBOARDING_PROGRESS_KEY,
  applyCriblSource,
  applyOnboardingDeploy,
  applyLakeRoute,
  buildNamespaceAuthRulesListRequest,
  emptyProgress,
  encodeProgress,
  encodeSelection,
  eventHubLocation,
  laneTopics,
  loadTenantDocument,
  listingRows,
  onboardingSource,
  paceAzureManagement,
  readTenantInventory,
  cancellableAzure,
  parseNamespaceAuthRules,
  planCriblSource,
  planLakeRoute,
  planValidation,
  readAllPages,
  readOnboardingCriblSide,
  readStrandedLegacyDocument,
  readTenantCriblMapping,
  stepsFor,
  TENANT_CRIBL_MAPPING_KEY,
  tenantDocumentKey,
  validateAzureOnboarding,
  withCriblSource,
  withLakeRoute,
  withWorkerGroup,
  activityLogSettingRecord,
  applyInputPause,
  applySourceTeardown,
  expectedActivityLogSetting,
  planInputPause,
  planSourceTeardown,
  withActivityLogSetting,
  withLakeRouteAfterTeardown,
  withoutActivityLogSetting,
  withoutCriblSource,
  ENTRA_ITEM_ID,
  ENTRA_SETTING_NAME,
  entraDeployTarget,
  entraProfileFrom,
  entraSettingRecord,
  readEntraSettingState,
  readActivityLogState,
  expectedEntraSetting,
  withEntraSetting,
  withoutEntraSetting,
  withReceiverGrant,
  withoutReceiverGrant,
  listenRuleName,
  withEventHubAccess,
  withoutEventHubAccess,
} from "@soc/core";
import type {
  TenantInventory,
  ReceiverGrantRecord,
  ReceiverGrantRemoveOutcome,
  ActivityLogRemoveOutcome,
  ApplyPauseOutcome,
  ApplyTeardownOutcome,
  PlanPauseResult,
  PlanTeardownResult,
  ReadyPause,
  ReadyTeardown,
  ApplyCredential,
  ApplyCriblSourceOutcome,
  ApplyLakeRouteOutcome,
  BatchPacing,
  BuildOnboardingLanesInput,
  CoverageSelection,
  ActivityLogDeployForValidation,
  ActivityLogState,
  EntraDeployForValidation,
  EntraRemoveOutcome,
  EntraSettingInput,
  EntraSettingState,
  DefenderDeployForValidation,
  DefenderState,
  EventHubSource,
  OnboardingDeployForValidation,
  KvDocumentLoad,
  LakeRouteSourceId,
  LaneTopics,
  ListRead,
  NamespaceAuthRule,
  OnboardingCriblSide,
  OnboardingItemId,
  OnboardingProgress,
  OnboardingSourceId,
  OtherLane,
  PlanCredential,
  PlanCriblSourceResult,
  PlanLakeRouteResult,
  PlanValues,
  ReadyCriblSource,
  ReadyLakeRoute,
  RoutePosition,
  SectionStatus,
  SourceMode,
  StrandedLegacyRead,
  TenantCriblMappingRead,
  ValidationPlan,
  ValidationResult,
  EventHubAccessRecord,
  ListenAccessApplyResult,
  ListenAccessRemoveOutcome,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { NumberedSection } from "../../components/numbered-section";
import { useStreamWorkerGroups } from "../../components/worker-group-listing";
import {
  buildSections,
  canWriteSelection,
  criblSideReadingOf,
  deployBlockView,
  deployedFrom,
  loadBanners,
  loadStateFrom,
  loadedSelection,
  measuredHubsOf,
  selectionUnknownCause,
  manageRuleSourcesOf,
} from "./azure-onboarding-state";
import type {
  OnboardingLoadState,
  OnboardingRowView,
  OnboardingSectionView,
  PickerMessage,
  RowChoice,
} from "./azure-onboarding-state";
import { EventHubPrerequisiteSection, PickerLine } from "./eventhub-prerequisite-section";
import type { EventHubTarget } from "./eventhub-prerequisite-section";
import { DefenderExportSection } from "./defender-export-section";
import { ActivityLogSection } from "./activity-log-section";
import { EntraSettingSection } from "./entra-setting-section";
import { ReceiverGrantSection } from "./receiver-grant-section";
import { EntraRemovePanel } from "./entra-remove-panel";
import { ActivityLogRemovePanel } from "./activity-log-remove-panel";
import { ReceiverGrantRemovePanel } from "./receiver-grant-remove-panel";
import { entraDeployedItems, entraReadDisprovesRecord } from "./entra-setting-state";
import { TenantInventoryHeatmap } from "./inventory/tenant-inventory-heatmap";
import { HowToPanel } from "./howto/howto-panel";
import { ChoosePanel } from "./howto/choose-panel";
import {
  applyPlanValues,
  canWriteProgress,
  chooseEventHubSource,
  chosenSourceIds,
  effectiveMode,
  followPickedEventHub,
  pickedEventHub,
  howtoModeRadioId,
  howtoRowAnchorId,
  loadedProgress,
  progressLoadStateFrom,
  rowChoices,
  setChosen,
  setMode,
  toggleTick,
  withSavedProgress,
} from "./howto/howto-state";
import type { ProgressLoadState } from "./howto/howto-state";
import { ValidatePanel } from "./validate/validate-panel";
import {
  VALIDATE_IDLE,
  VALIDATE_REQUESTS_PER_MINUTE,
  changedPlanKeys,
  activityLogAmendNote,
  defenderAmendNote,
  entraAmendNote,
  validateRunReducer,
} from "./validate/validate-state";
import { CriblSourcePanel } from "./cribl-source/cribl-source-panel";
import { TeardownPanel } from "./cribl-source/teardown-panel";
import { sourceRows } from "./cribl-source/cribl-source-state";
import { onboardingGroupChoice, onboardingGroupResolution } from "./cribl-source/group-choice";
import { StrandedSourcesNotice } from "./cribl-source/stranded-sources-notice";
import { ListenAccessPanel } from "./cribl-source/listen-access-panel";
import { ListenAccessRemovePanel } from "./cribl-source/listen-access-remove-panel";
import { eventHubSourcesInUse } from "./cribl-source/listen-access-state";
import { strandedNoticeOf } from "./cribl-source/stranded-sources-state";
import { OnboardingDataflow } from "./dataflow/onboarding-dataflow";
import { liveFlowLanes, useLiveFlow } from "./dataflow/use-live-flow";

/** What a teardown leaves recorded for one source (AZR-105). */
type TeardownRecords = ApplyTeardownOutcome["records"];

/** Shown when the shell wires no document store: a wiring gap, not a first run. */
export const SHELL_GAP_MESSAGE =
  "This build of the app has no storage for the onboarding selection, so it cannot be loaded or saved. Choosing sources is turned off.";

/** The progress load's reason when the shell wires no document store. */
export const PROGRESS_SHELL_GAP_REASON = "this build of the app has no storage for it";

const SECTION_TIPS: Readonly<Record<OnboardingSectionView["key"], string>> = {
  "built-in-policy":
    "Azure Policy assigns diagnostic settings across many resource types at once. Deploying these initiatives from here is not available yet.",
  "custom-initiative":
    "A community-maintained policy initiative that covers resource types the built-in one does not. Deploying it from here is not available yet.",
  script:
    "Sources configured directly, without a policy. The Activity Log (one subscription diagnostic setting), Entra ID (one tenant diagnostic setting) and the Defender for Cloud alert export can be deployed from here once chosen in Automate mode.",
  "guided-portal":
    "The Defender XDR streaming export is finished in the Microsoft Defender portal. Guidance for it is not available here yet.",
  none: "Sources that cannot stream to an Event Hub at all, with what to use instead. Nothing here is deployed.",
};

/** Section 2: the one place a source is chosen. */
const CHOOSER_SECTION_NUMBER = 2;
const CHOOSER_SECTION_TITLE = "Choose what to onboard";
const CHOOSER_TIP =
  "Choose each source to send to Cribl Stream, and whether the app sets it up (Automate) or you follow the steps yourself (How-to). Each choice is saved as you make it. The sections below show what you chose.";

/** The four sections that follow the catalog sections. */
const HOWTO_SECTION_TITLES = {
  dataflow: "Dataflow",
  howto: "How to set it up yourself",
  validate: "Check the Azure configuration",
  cribl: "Cribl Stream source",
} as const;

const DATAFLOW_TIP =
  "One lane per chosen source, from the Azure log emitter through the Event Hub or storage account to the Cribl source, route and destination. Read it from the Azure side, the Cribl side or end to end. A hop animates only when Cribl's metrics measured events arriving. While you watch for data, each hop's (i) also says when this app last saw that source flowing, remembered from its earlier readings.";
const HOWTO_TIP =
  "For each source chosen in How-to mode: enter your names and ids, then follow each step's instructions and tick it when done. Ticks are saved as you make them.";
const VALIDATE_TIP =
  "Reads the Azure side of every chosen source and compares it with your plan. It only reads: nothing in Azure is changed, and no key is read.";
const CRIBL_TIP =
  "The Cribl Stream source that receives each chosen source is always created by the app, after you confirm. It never changes or deletes a source it did not create; Remove takes out only what it can prove it created.";

/** Shown instead of the diagram until both documents have loaded. */
export const DATAFLOW_WAITING_TEXT =
  "The dataflow appears once the saved selection and your How-to progress are loaded.";

/** No Event Hub chosen yet. The choice is React state only; it is not persisted. */
const EMPTY_EVENTHUB_TARGET: EventHubTarget = { namespace: null, hubName: "", rule: null };

const NOT_BUILT_NOTE = "These sources are shown so you can see the full picture. They cannot be deployed from here yet.";

const PAGE_TIP =
  "Choose which Azure-native sources should send to Cribl Stream, then either deploy the ones the app can set up or follow the How-to steps. Choices and How-to progress are saved as you go.";

const LOG = "azure-onboarding:";

/** Where a message line is shown: the chooser section or the How-to section. */
type MessageArea = "chooser" | "howto";

function sectionStatus(view: OnboardingSectionView): SectionStatus {
  if (view.availability === "available") return "available";
  if (view.availability === "reference") return "informational";
  return "coming-soon";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AzureOnboardingScreenProps {
  /**
   * The shell's clock and delay for pacing Azure reads. Without it Validate is
   * disabled: it never runs unpaced.
   */
  readonly pacing?: BatchPacing;
  /**
   * The shell's Re-check permissions (the connection bar's audit refresh).
   * Absent = the permission banner points at the connection bar instead.
   */
  readonly onRecheckPermissions?: () => void;
  /** True while that re-check is in flight. */
  readonly recheckingPermissions?: boolean;
  /**
   * The shell's CURRENT audit key. The audit hook keeps the previous
   * connection's set until a new audit lands; with the key, that set is read
   * as not checked rather than as this connection's verdict.
   */
  readonly permissionsAuditKey?: string;
  /** The shell's clock, so a blocking denial says how old the check is. */
  readonly permissionsNow?: () => string;
  /**
   * The sources the active tenant's latest gap read measured RED on either
   * side (AZR-147): each one's row in Choose what to onboard carries a gap
   * badge. Absent or empty: no badges - never a claim that nothing is missing.
   */
  readonly gapSources?: ReadonlySet<OnboardingSourceId>;
  /**
   * Show this source's row in Choose what to onboard (AZR-147, following a gap
   * from All tenants or Focus here). Each new `seq` jumps once, as soon as the
   * saved choices have answered, so a jump asked before a connection switch
   * lands after the screen has loaded for the new connection.
   */
  readonly jumpTo?: { readonly sourceId: OnboardingSourceId; readonly seq: number } | null;
}

/** The How-to section's wrapper. */
const HOWTO_ANCHOR_ID = "azo-howto-section";
/** The chooser section's wrapper, focused when the source's own row is not rendered. */
const CHOOSER_ANCHOR_ID = "azo-choose-section";

/**
 * Bring a source's How-to switch into view and focus it - the control the
 * banner tells the operator to use. Falls back to the row when the radio is
 * disabled (progress cannot be written), and to the chooser section itself
 * when the row is not rendered (the progress document has not loaded or could
 * not be read). DOM only - no state, no IO.
 */
/** The Entra Deploy's target as the row label judges against it: null until progress loads or while values are missing. */
function entraRowTargetInput(load: ProgressLoadState, selection: CoverageSelection | null): EntraSettingInput | null {
  const p = loadedProgress(load);
  return p === null ? null : entraDeployTarget(p.planValues, selection?.subSelections[ENTRA_ITEM_ID] ?? []).input;
}

/** Scroll to and focus the How-to section (the Data Receiver grant is a step of every Event Hub source there). */
function showHowtoSection(): void {
  const el = document.getElementById(HOWTO_ANCHOR_ID);
  if (el === null) return;
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start", behavior: "smooth" });
  el.focus({ preventScroll: true });
}

function showHowto(id: OnboardingSourceId): void {
  const radio = document.getElementById(howtoModeRadioId(id));
  const usableRadio = radio instanceof HTMLInputElement && !radio.disabled ? radio : null;
  const el =
    usableRadio ?? document.getElementById(howtoRowAnchorId(id)) ?? document.getElementById(CHOOSER_ANCHOR_ID);
  if (el === null) return;
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.focus({ preventScroll: true });
}

/**
 * Scroll to and focus a source's row in Choose what to onboard (AZR-147), or
 * the chooser itself when the row is not rendered. DOM only.
 */
function showSource(id: OnboardingSourceId): void {
  const el = document.getElementById(howtoRowAnchorId(id)) ?? document.getElementById(CHOOSER_ANCHOR_ID);
  if (el === null) return;
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.focus({ preventScroll: true });
}

export function AzureOnboardingScreen({
  pacing,
  onRecheckPermissions,
  recheckingPermissions,
  permissionsAuditKey,
  permissionsNow,
  gapSources,
  jumpTo = null,
}: AzureOnboardingScreenProps = {}) {
  const { ports, config } = usePorts();
  const store = ports.kvDocuments;
  const logger = ports.logger;
  // Every document this screen keeps is ONE TENANT'S (ADR 0009 decision 3):
  // the selection, and the How-to progress with its plan values and the
  // records of the Cribl sources this app created. They live under
  // `{key}.{tenantId}`; the legacy single-tenant document is moved under the
  // active tenant the first time it is read (loadTenantDocument), and is never
  // read as a document to use again. The one later read is a REPORT (AZR-96):
  // once the tenant's progress has loaded, readStrandedLegacyDocument looks at
  // the legacy progress key for Cribl source records an earlier app version
  // wrote there afterwards, and the Cribl source section names them as not
  // adopted - nothing is merged or written. Null when the connection has no
  // tenant id, which reads as an unknown load and blocks every save.
  const activeTenant = config.tenantId;
  const selectionKey = tenantDocumentKey(COVERAGE_SELECTION_KEY, activeTenant);
  const progressKey = tenantDocumentKey(ONBOARDING_PROGRESS_KEY, activeTenant);

  const [load, setLoad] = useState<OnboardingLoadState>({ status: "loading" });
  const latestLoad = useRef<OnboardingLoadState>(load);
  const [selection, setSelection] = useState<CoverageSelection | null>(null);
  // The selection on screen right now: each transition starts from it, so two
  // clicks in one render never build on the same stale value.
  const latestSelection = useRef<CoverageSelection | null>(null);
  const selectionChain = useRef<Promise<void>>(Promise.resolve());
  // A failed selection write has its OWN line in the chooser section: no other
  // message replaces it, and only a successful selection write clears it, so
  // an unsaved Automated choice is never shown without its "not saved" line.
  const [selectionFailure, setSelectionFailure] = useState<PickerMessage | null>(null);
  const [target, setTarget] = useState<EventHubTarget>(EMPTY_EVENTHUB_TARGET);
  const [defenderState, setDefenderState] = useState<DefenderState | null>(null);
  const [activityLogState, setActivityLogState] = useState<ActivityLogState | null>(null);
  // AZR-121 review: Deploy (the section) and Remove (the teardown panel) live
  // apart, so the screen holds both running flags and each turns the other off.
  const [activityLogDeploying, setActivityLogDeploying] = useState(false);
  const [activityLogRemoving, setActivityLogRemoving] = useState(false);
  // AZR-141: a Data Receiver grant and its Remove never run at once.
  const [receiverGranting, setReceiverGranting] = useState(false);
  const [receiverGrantRemoving, setReceiverGrantRemoving] = useState(false);
  const [entraState, setEntraState] = useState<EntraSettingState | null>(null);
  // AZR-99: the next Entra read follows the app's own write (see onEntraState).
  const entraReadAfterDeploy = useRef(false);

  // How-to progress (ADR 0007 D1, D3).
  const [progressLoad, setProgressLoad] = useState<ProgressLoadState>(
    store === undefined ? { status: "read-unknown", reason: PROGRESS_SHELL_GAP_REASON } : { status: "loading" },
  );
  const latestProgressLoad = useRef<ProgressLoadState>(progressLoad);
  const progressChain = useRef<Promise<void>>(Promise.resolve());
  // One message line per area: the chooser (choices, modes, and their saves)
  // and the How-to section (ticks, plan values, Cribl records).
  const [messages, setMessages] = useState<Readonly<Record<MessageArea, PickerMessage | null>>>({
    chooser: null,
    howto: null,
  });
  // AZR-96: the read-only report on the legacy progress key. Null until it is read.
  const [legacyRead, setLegacyRead] = useState<StrandedLegacyRead | null>(null);
  // Every progress save-failure message shown, and where. Each write carries
  // the whole document, so ANY successful progress write saves what every
  // earlier failure lost, and clears all of them (and nothing else).
  const progressSaveFailures = useRef<{ readonly at: MessageArea; readonly message: PickerMessage }[]>([]);

  // Validate (D16).
  const [run, dispatchRun] = useReducer(validateRunReducer, VALIDATE_IDLE);
  // The last finished run and the plan values it checked. Its answers feed the
  // steps, the dataflow and the Cribl source only while those values are still
  // the plan's (AZR-42): after a change they describe something else.
  const [lastRun, setLastRun] = useState<{ result: ValidationResult; values: PlanValues } | null>(null);
  const runSeq = useRef(0);
  const runAbort = useRef<AbortController | null>(null);

  // Cribl source (D7-D10) and the Cribl side (D17).
  const workerGroups = useStreamWorkerGroups(ports.cribl, { auto: false, logger });
  // The group chosen on THIS screen: used only when the tenant to Cribl
  // mapping names none for this tenant (groupChoice below).
  const [groupId, setGroupId] = useState("");
  const [mappingRead, setMappingRead] = useState<TenantCriblMappingRead | "loading">(
    store === undefined ? { kind: "unknown", reason: PROGRESS_SHELL_GAP_REASON } : "loading",
  );
  const [rules, setRules] = useState<{ readonly ns: string; readonly read: ListRead<NamespaceAuthRule> } | null>(null);
  const [rulesMessage, setRulesMessage] = useState<PickerMessage | null>(null);
  const [readSeq, setReadSeq] = useState(0);
  const [criblSide, setCriblSide] = useState<OnboardingCriblSide | null>(null);
  const [criblSideBusy, setCriblSideBusy] = useState(false);
  const [watching, setWatching] = useState(false);

  useEffect(() => {
    if (store === undefined) return;
    let cancelled = false;
    void loadTenantDocument(store, COVERAGE_SELECTION_KEY, activeTenant)
      .then(loadStateFrom, (error: unknown): OnboardingLoadState => ({
        // The port promises never to reject; if one does, it is a failed read,
        // and a failed read must block every write, never pass as a first run.
        status: "read-unknown",
        reason: errorText(error),
      }))
      .then((next) => {
        if (cancelled) return;
        latestLoad.current = next;
        setLoad(next);
        const loadedSel = loadedSelection(next);
        latestSelection.current = loadedSel;
        setSelection(loadedSel);
        logger?.info(`${LOG} selection loaded`, { load: next.status });
      });
    return () => {
      cancelled = true;
    };
  }, [store, logger, activeTenant]);

  useEffect(() => {
    if (store === undefined) return;
    let cancelled = false;
    setLegacyRead(null);
    void loadTenantDocument(store, ONBOARDING_PROGRESS_KEY, activeTenant)
      .then(
        (answer: KvDocumentLoad): ProgressLoadState => progressLoadStateFrom(answer),
        (error: unknown): ProgressLoadState => ({ status: "read-unknown", reason: errorText(error) }),
      )
      .then((next) => {
        if (cancelled) return;
        // A first run starts from the connection's subscription and resource group.
        const seeded: ProgressLoadState =
          next.status === "absent" ? { status: "absent", progress: emptyProgress(config) } : next;
        latestProgressLoad.current = seeded;
        setProgressLoad(seeded);
        const saved = loadedProgress(seeded)?.workerGroup ?? "";
        if (saved !== "") setGroupId((g) => (g === "" ? saved : g));
        logger?.info(`${LOG} progress loaded`, { load: seeded.status });
        // AZR-96: only once the tenant's OWN document has loaded. On a first
        // run (absent) loadTenantDocument has just read the legacy key and
        // either moved it here, found nothing, or found it claimed by another
        // tenant, so there is nothing stranded to report and no reason to
        // spend two more KV reads.
        if (next.status !== "ready") return;
        return readStrandedLegacyDocument(store, ONBOARDING_PROGRESS_KEY, activeTenant).then(
          (read) => read,
          (error: unknown): StrandedLegacyRead => ({ kind: "unknown", reason: errorText(error) }),
        );
      })
      .then((read) => {
        if (cancelled || read === undefined) return;
        setLegacyRead(read);
        logger?.info(`${LOG} legacy progress checked`, { result: read.kind });
      });
    return () => {
      cancelled = true;
    };
    // config is read once, at load, for the first-run defaults only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, logger, activeTenant]);

  // The tenant to Cribl mapping (AZR-64): one app-wide document. Not read
  // without a tenant id - there is no tenant to look up, and
  // onboardingGroupResolution says so instead of reporting a read in flight.
  const hasTenant = activeTenant.trim() !== "";
  useEffect(() => {
    if (store === undefined || !hasTenant) return;
    let cancelled = false;
    setMappingRead("loading");
    void store
      .load(TENANT_CRIBL_MAPPING_KEY)
      .then(readTenantCriblMapping, (error: unknown): TenantCriblMappingRead => ({
        kind: "unknown",
        reason: errorText(error),
      }))
      .then((next) => {
        if (cancelled) return;
        setMappingRead(next);
        logger?.info(`${LOG} tenant mapping loaded`, { load: next.kind });
      });
    return () => {
      cancelled = true;
    };
  }, [store, logger, hasTenant]);

  useEffect(
    () => () => {
      runAbort.current?.abort();
    },
    [],
  );

  // AZR-147: follow a gap to its source - once per request, and only once the
  // saved choices have answered, so the row (or the chooser) is there to focus.
  const jumpedSeq = useRef(0);
  const progressSettled = progressLoad.status !== "loading";
  useEffect(() => {
    if (jumpTo === null || jumpTo.seq === jumpedSeq.current || !progressSettled) return;
    jumpedSeq.current = jumpTo.seq;
    showSource(jumpTo.sourceId);
  }, [jumpTo, progressSettled]);

  // Tenant inventory heat map: the last read, kept in state only.
  const [inventory, setInventory] = useState<TenantInventory | null>(null);
  const [inventoryReading, setInventoryReading] = useState(false);
  const [inventoryProgress, setInventoryProgress] = useState<{ done: number; total: number } | null>(null);
  const inventoryBusy = useRef(false);
  const screenMounted = useRef(true);
  useEffect(() => {
    screenMounted.current = true;
    return () => {
      screenMounted.current = false;
    };
  }, []);

  const unknown = useMemo(() => {
    const map = new Map<OnboardingItemId, string>();
    if (defenderState?.unknownReason !== undefined) {
      map.set(DEFENDER_EXPORT_ITEM_ID, defenderState.unknownReason);
    }
    if (activityLogState?.unknownReason !== undefined) {
      map.set(ACTIVITY_LOG_ITEM_ID, activityLogState.unknownReason);
    }
    if (entraState?.unknownReason !== undefined) {
      map.set(ENTRA_ITEM_ID, entraState.unknownReason);
    }
    return map;
  }, [defenderState, activityLogState, entraState]);
  // What the reads found deployed. Null until one read happened; a source not
  // yet read is then labelled from what is known (deployedFrom).
  const deployed = useMemo(
    () =>
      deployedFrom([
        [DEFENDER_EXPORT_ITEM_ID, defenderState?.deployed ?? null],
        [ACTIVITY_LOG_ITEM_ID, activityLogState?.deployed ?? null],
        [ENTRA_ITEM_ID, entraDeployedItems(entraState, entraRowTargetInput(progressLoad, selection))],
      ]),
    [defenderState, activityLogState, entraState, progressLoad, selection],
  );
  const selectionCause = selectionUnknownCause(load, store !== undefined);
  // The chooser's answer per source: the ONLY input the method sections'
  // "chosen" status is read from (ADR 0007 section 2).
  const choices = useMemo(
    () => rowChoices(progressLoad, selection, selectionCause ?? "not-read", store !== undefined),
    [progressLoad, selection, selectionCause, store],
  );
  // A deploy section gates on its source's choice, never on the selection.
  const choiceOf = (id: OnboardingSourceId): RowChoice =>
    choices.get(id) ?? { kind: "unknown", doc: "progress", cause: "not-read" };
  const sections = useMemo(
    () => buildSections(choices, deployed, unknown),
    [choices, deployed, unknown],
  );

  const progress = loadedProgress(progressLoad);
  const strandedNotice = useMemo(() => strandedNoticeOf(legacyRead, progress), [legacyRead, progress]);
  const values: PlanValues | null = progress?.planValues ?? null;
  // The last run's answers, only while they are about the current plan (AZR-42).
  const lastResult =
    lastRun !== null && values !== null && changedPlanKeys(lastRun.values, values).length === 0
      ? lastRun.result
      : null;
  const defenderHowTo =
    progress !== null && effectiveMode(progress, DEFENDER_EXPORT_ITEM_ID) === "manual";
  const activityLogHowTo =
    progress !== null && effectiveMode(progress, ACTIVITY_LOG_ITEM_ID) === "manual";
  // AZR-109: a chosen How-to source shows a note naming it; an unchosen
  // How-to source shows neither the note nor deploy controls.
  const titleOf = (id: OnboardingSourceId): string => onboardingSource(id)?.title ?? id;
  const defenderBlock = deployBlockView(choiceOf(DEFENDER_EXPORT_ITEM_ID), defenderHowTo, titleOf(DEFENDER_EXPORT_ITEM_ID));
  const activityLogBlock = deployBlockView(choiceOf(ACTIVITY_LOG_ITEM_ID), activityLogHowTo, titleOf(ACTIVITY_LOG_ITEM_ID));
  const entraHowTo = progress !== null && effectiveMode(progress, ENTRA_ITEM_ID) === "manual";
  const entraBlock = deployBlockView(choiceOf(ENTRA_ITEM_ID), entraHowTo, titleOf(ENTRA_ITEM_ID));
  const chosen = useMemo(
    () => (progress === null ? [] : chosenSourceIds(progress, selection)),
    [progress, selection],
  );
  // AZR-117: the rule note and create-rule label follow the chosen sources,
  // read from the chooser's answer per source. Null while a Manage source's
  // choice is unknown (progress OR, for an Automate source, the selection not
  // loaded), which is NOT "nothing chosen": the section then recommends no rule.
  const manageSources = useMemo(() => manageRuleSourcesOf(choices), [choices]);
  const subSelectionOf = useCallback(
    (id: OnboardingSourceId): readonly string[] => selection?.subSelections[id] ?? [],
    [selection],
  );

  function showMessage(at: MessageArea, message: PickerMessage | null): void {
    setMessages((m) => ({ ...m, [at]: message }));
  }

  /** Clear `message` from `at` only if it is still the one shown there. */
  function clearMessage(at: MessageArea, message: PickerMessage): void {
    setMessages((m) => (m[at] === message ? { ...m, [at]: null } : m));
  }

  // -------------------------------------------------------------------------
  // Selection (AZR-18): one write per choice, serialized, like progress
  // -------------------------------------------------------------------------

  /**
   * Show `next` at once and queue its write behind any selection write in
   * flight. Every write carries the whole document, so the last one queued is
   * the latest. Returns false (and writes nothing) while selection writes are
   * blocked: no store, no tenant key, or a load that was not `absent` or ours.
   * A failed write is handled exactly as a failed progress write: the change
   * stays on screen, a visible error says it was NOT saved, and the next
   * change tries again with everything shown.
   */
  function commitSelection(next: CoverageSelection, what: string): boolean {
    if (store === undefined || selectionKey === null || !canWriteSelection(latestLoad.current)) return false;
    latestSelection.current = next;
    setSelection(next);
    const body = JSON.parse(encodeSelection(next)) as unknown;
    selectionChain.current = selectionChain.current.then(async () => {
      try {
        await store.save(selectionKey, body);
        // What is stored now: a first run's defaults banner no longer applies.
        const saved: OnboardingLoadState = {
          status: "ready",
          decoded: { selection: next, dropped: [], usedDefaults: false },
        };
        latestLoad.current = saved;
        setLoad(saved);
        setSelectionFailure(null);
        logger?.info(`${LOG} selection saved`, { change: what, enabled: next.enabled.length });
      } catch (error) {
        const message = errorText(error);
        const failure: PickerMessage = {
          tone: "error",
          text: `Your choice was not saved - ${message}. The next change tries again with everything shown here.`,
        };
        setSelectionFailure(failure);
        logger?.warn(`${LOG} selection save failed`, { change: what, error: message });
      }
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Progress (D3): one write per click, serialized
  // -------------------------------------------------------------------------

  /**
   * Show `next` at once and queue its write behind any write in flight. Every
   * write carries the whole document, so the last one queued is the latest.
   * Returns false (and writes nothing) while progress writes are blocked.
   */
  function commitProgress(next: OnboardingProgress, what: string, at: MessageArea = "howto"): boolean {
    const state = latestProgressLoad.current;
    if (store === undefined || progressKey === null || !canWriteProgress(state)) return false;
    const shown = withSavedProgress(state, next);
    latestProgressLoad.current = shown;
    setProgressLoad(shown);
    const body = JSON.parse(encodeProgress(next)) as unknown;
    progressChain.current = progressChain.current.then(async () => {
      try {
        await store.save(progressKey, body);
        // A save clears only its own earlier failure. Any other message - a
        // notice set by the click that queued this write, such as a choice not
        // carried over between modes - must outlive the write it explains.
        const failures = progressSaveFailures.current;
        progressSaveFailures.current = [];
        for (const f of failures) clearMessage(f.at, f.message);
        logger?.info(`${LOG} progress saved`, { change: what });
      } catch (error) {
        const message = errorText(error);
        const failure: PickerMessage = {
          tone: "error",
          text: `Your How-to progress was not saved - ${message}. The next change tries again with everything shown here.`,
        };
        progressSaveFailures.current = [...progressSaveFailures.current, { at, message: failure }];
        showMessage(at, failure);
        logger?.warn(`${LOG} progress save failed`, { change: what, error: message });
      }
    });
    return true;
  }

  function onToggleTick(stepId: string, checked: boolean): void {
    const next = toggleTick(latestProgressLoad.current, stepId, checked);
    if (next !== null) commitProgress(next, checked ? "tick" : "untick");
  }

  function onSetMode(id: OnboardingSourceId, mode: SourceMode): void {
    const change = setMode(latestProgressLoad.current, latestSelection.current, id, mode);
    if (change === null) return;
    commitProgress(change.progress, "mode", "chooser");
    // Only a selection the change actually altered is written: a move to
    // How-to returns none, so that source's saved entry is left as it is.
    if (change.selection !== null && change.selection !== latestSelection.current) {
      commitSelection(change.selection, "mode");
    }
  }

  function onSetChosen(id: OnboardingSourceId, isChosen: boolean): void {
    const result = setChosen(latestProgressLoad.current, latestSelection.current, id, isChosen);
    if (result.kind === "progress") commitProgress(result.progress, "choose", "chooser");
    else if (result.kind === "selection") {
      // Unchoosing changes the selection only; nothing is removed from Azure.
      if (result.selection !== latestSelection.current) commitSelection(result.selection, "choose");
    } else showMessage("chooser", { tone: "error", text: result.reason });
  }

  function onApplyPlanValues(next: PlanValues): void {
    const p = applyPlanValues(latestProgressLoad.current, next);
    if (p !== null) commitProgress(p, "plan values");
  }

  // ONE EVENT HUB (AZR-102). The section 1 picker is the source of the Event
  // Hub plan values: a complete pick (namespace and hub) writes them to the
  // progress document at once, unless the operator keeps their own names. The
  // deploy sections read the picker and the steps, Validate and the Cribl
  // source read the plan, so both now name the same hub. The picker itself is
  // still React state, not seeded from the plan (AZR-24).
  const pickedHub = useMemo(() => pickedEventHub(target), [target]);

  function onTargetChange(next: EventHubTarget): void {
    setTarget(next);
    const p = followPickedEventHub(latestProgressLoad.current, pickedEventHub(next));
    if (p !== null) commitProgress(p, "event hub from section 1");
  }

  // A pick made while progress was still loading (or could not be written)
  // was not written then. Once progress becomes writable, write it once:
  // followPickedEventHub returns null when the plan already names it, so this
  // cannot loop, and later picks go through onTargetChange.
  const progressWritable = canWriteProgress(progressLoad);
  useEffect(() => {
    if (!progressWritable) return;
    const p = followPickedEventHub(latestProgressLoad.current, pickedEventHub(target));
    if (p !== null) commitProgress(p, "event hub from section 1 after load");
    // Runs on the transition to writable only; target is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressWritable]);

  function onChooseEventHubSource(source: EventHubSource): void {
    const p = chooseEventHubSource(latestProgressLoad.current, source, pickedEventHub(target));
    if (p !== null) commitProgress(p, source === "own" ? "own event hub names" : "follow section 1");
  }

  // -------------------------------------------------------------------------
  // Validate (D16)
  // -------------------------------------------------------------------------

  const validationPlan: ValidationPlan | null = useMemo(() => {
    if (values === null || chosen.length === 0) return null;
    return planValidation(
      chosen.map((id) => ({ id, subSelection: subSelectionOf(id) })),
      values,
    );
  }, [chosen, values, subSelectionOf]);

  async function onValidate(): Promise<void> {
    const plan = validationPlan;
    if (plan === null || pacing === undefined || run.kind === "running") return;
    runSeq.current += 1;
    const runId = runSeq.current;
    runAbort.current?.abort();
    const controller = new AbortController();
    runAbort.current = controller;
    dispatchRun({ type: "start", runId, total: plan.firstPageReads });
    const azure = paceAzureManagement(ports.azure, { ...pacing, maxRequestsPerMinute: VALIDATE_REQUESTS_PER_MINUTE });
    logger?.info(`${LOG} validate started`, { reads: plan.firstPageReads, sources: chosen.length });
    try {
      const result = await validateAzureOnboarding(azure, plan, {
        signal: controller.signal,
        onProgress: (done, total) => dispatchRun({ type: "progress", runId, done, total }),
      });
      dispatchRun({ type: "finish", runId, result, asOf: new Date().toLocaleTimeString(), values: plan.values });
      if (runSeq.current === runId) {
        setLastRun({ result, values: plan.values });
        setReadSeq((s) => s + 1);
      }
      logger?.info(`${LOG} validate finished`, { checks: result.checks.length, cancelled: result.cancelled });
    } catch (error) {
      dispatchRun({ type: "fail", runId, message: errorText(error) });
      logger?.warn(`${LOG} validate failed`, { error: errorText(error) });
    } finally {
      if (runAbort.current === controller) runAbort.current = null;
    }
  }

  // Blocked only while the progress record is still loading. When it could not
  // be read (no KV store, unreadable, another tenant's), the read still runs:
  // only "archived through Cribl" needs that record, and without it those
  // archive states say "unknown" with the reason.
  const inventoryDisabledReason: string | null =
    ports.azure === undefined
      ? "No Azure connection is configured, so the tenant cannot be read."
      : progressLoad.status === "loading"
        ? "The onboarding progress is still loading, so the tenant cannot be read yet."
        : pacing === undefined
          ? "The shell gave no request pacing, so the tenant is not read."
          : null;

  async function onReadInventory(): Promise<void> {
    if (inventoryDisabledReason !== null || inventoryBusy.current) return;
    if (pacing === undefined) return;
    inventoryBusy.current = true;
    setInventoryReading(true);
    setInventoryProgress(null);
    // A flag, not an AbortSignal: the platform fetch bridge ignores signals.
    // Checked inside the pacer, so a request still waiting for its slot when
    // the screen unmounts is never sent.
    const cancelled = (): boolean => !screenMounted.current;
    const azure = paceAzureManagement(cancellableAzure(ports.azure, cancelled), {
      ...pacing,
      maxRequestsPerMinute: VALIDATE_REQUESTS_PER_MINUTE,
    });
    logger?.info(`${LOG} tenant inventory read started`, { progressRecord: progress !== null });
    try {
      const result = await readTenantInventory({
        azure,
        progress,
        now: () => new Date().toISOString(),
        cancelled,
        onProgress: (done, total) => {
          if (screenMounted.current) setInventoryProgress({ done, total });
        },
      });
      if (screenMounted.current) setInventory(result);
      logger?.info(`${LOG} tenant inventory read finished`, { requests: result.requests });
    } catch (error) {
      logger?.warn(`${LOG} tenant inventory read failed`, { error: errorText(error) });
    } finally {
      inventoryBusy.current = false;
      if (screenMounted.current) setInventoryReading(false);
    }
  }

  /**
   * A Defender deploy that wrote the export: its read-back replaces the
   * export verdict of a Validate run made BEFORE it, in the panel and in the
   * diagram, so the screen never says "not found" next to the export it just
   * created (AZR-93). A run in flight is left to read Azure itself.
   */
  function onDefenderDeployed(deploy: DefenderDeployForValidation): void {
    amendLastRun(deploy, defenderAmendNote(deploy.outcome, new Date().toLocaleTimeString()));
    logger?.info(`${LOG} Defender deploy applied to the last Validate result`, { outcome: deploy.outcome });
  }

  /** The same for the Activity Log setting (AZR-98): its read-back replaces that check's verdict. */
  function onActivityLogDeployed(deploy: ActivityLogDeployForValidation): void {
    amendLastRun(deploy, activityLogAmendNote(deploy.outcome, new Date().toLocaleTimeString()));
    logger?.info(`${LOG} Activity Log deploy applied to the last Validate result`, { outcome: deploy.outcome });
    // AZR-105: the app's record of writing the setting, so a Remove can prove it.
    const p = loadedProgress(latestProgressLoad.current);
    const recorded =
      p !== null &&
      commitProgress(
        withActivityLogSetting(p, {
          subscriptionId: deploy.input.subscriptionId,
          settingName: ACTIVITY_LOG_SETTING_NAME,
          ruleId: expectedActivityLogSetting(deploy.input).ruleId,
        }),
        "activity log setting",
      );
    if (!recorded) {
      showMessage("howto", {
        tone: "warning",
        text: `The Activity Log setting ${ACTIVITY_LOG_SETTING_NAME} was created, but your saved progress could not be updated, so this page cannot prove it created it and will not offer to remove it.`,
      });
    }
  }

  /**
   * AZR-99: an Entra ID deploy that wrote the setting amends the last Validate
   * run, and records the setting (by tenant) so Remove can prove it the app's.
   */
  function onEntraDeployed(deploy: EntraDeployForValidation): void {
    entraReadAfterDeploy.current = true;
    amendLastRun(deploy, entraAmendNote(deploy.outcome, new Date().toLocaleTimeString()));
    logger?.info(`${LOG} Entra ID deploy applied to the last Validate result`, { outcome: deploy.outcome });
    const p = loadedProgress(latestProgressLoad.current);
    const recorded =
      p !== null &&
      config.tenantId.trim() !== "" &&
      commitProgress(
        withEntraSetting(p, {
          tenantId: config.tenantId,
          settingName: ENTRA_SETTING_NAME,
          ruleId: expectedEntraSetting(deploy.input).ruleId,
        }),
        "entra setting",
      );
    if (!recorded) {
      showMessage("howto", {
        tone: "warning",
        text: `The Entra ID setting ${ENTRA_SETTING_NAME} was created, but your saved progress could not be updated, so this page cannot prove it created it and will not offer to remove it.`,
      });
    }
  }

  /**
   * AZR-103: record a Data Receiver assignment Azure accepted from the app's
   * own PUT, so a removal can prove it the app's. Returns whether the
   * progress document took it; the section says so when it did not.
   */
  function onReceiverGranted(record: ReceiverGrantRecord): boolean {
    const p = loadedProgress(latestProgressLoad.current);
    const recorded = p !== null && commitProgress(withReceiverGrant(p, record), "receiver grant");
    logger?.info(`${LOG} receiver grant recorded`, { recorded });
    return recorded;
  }

  /**
   * AZR-141: forget a Data Receiver grant's record after a removal that left
   * nothing behind (removed, or already gone). Every other outcome keeps it,
   * so Remove stays offered.
   */
  function onReceiverGrantRemoved(outcome: ReceiverGrantRemoveOutcome): void {
    if (outcome.kind !== "removed" && outcome.kind !== "already-gone") return;
    const p = loadedProgress(latestProgressLoad.current);
    const forgotten =
      p !== null && commitProgress(withoutReceiverGrant(p, outcome.record.scopeId, outcome.record.principalId), "receiver grant removed");
    logger?.info(`${LOG} receiver grant record dropped`, { forgotten });
  }

  /**
   * AZR-99: every Entra read lands here. A read that no longer lists the
   * setting forgets this tenant's record (entraReadDisprovesRecord), so a
   * stale record never proves ownership of a setting re-created by hand -
   * except the read right after the app's own write, which may simply lag.
   */
  function onEntraState(next: EntraSettingState): void {
    setEntraState(next);
    const afterOwnWrite = entraReadAfterDeploy.current;
    entraReadAfterDeploy.current = false;
    if (afterOwnWrite) return;
    const p = loadedProgress(latestProgressLoad.current);
    if (p === null || !entraReadDisprovesRecord(next, entraSettingRecord(p, config.tenantId))) return;
    if (commitProgress(withoutEntraSetting(p, config.tenantId), "entra setting found gone")) {
      logger?.info(`${LOG} Entra ID setting record dropped: the read no longer lists it`, {});
      showMessage("howto", {
        tone: "info",
        text: `${ENTRA_SETTING_NAME} is no longer in this tenant, so this page has forgotten creating it. A setting of that name made later is not removed from here.`,
      });
    }
  }

  /**
   * AZR-99: after a removal that left nothing behind, forget the record; after
   * any removal that reached Azure, re-read, so the row and Deploy stop
   * describing the setting as it was before.
   */
  function onEntraRemoved(outcome: EntraRemoveOutcome): void {
    if (outcome.kind === "removed" || outcome.kind === "already-gone") {
      const p = loadedProgress(latestProgressLoad.current);
      if (p !== null) commitProgress(withoutEntraSetting(p, config.tenantId), "entra setting removed");
    }
    if (outcome.kind === "removed" || outcome.kind === "removed-not-confirmed" || outcome.kind === "already-gone") {
      void readEntraSettingState(ports.azure, logger).then(onEntraState, (error: unknown) => {
        // The usecase never throws; a wiring fault must not leave the old state looking current.
        setEntraState(null);
        logger?.error(`${LOG} Entra ID re-read after remove threw`, { error: errorText(error) });
      });
    }
  }

  /**
   * AZR-105: after a removal that left nothing behind, forget the record.
   * AZR-121: the Remove now sits in the teardown panel, outside the Activity
   * Log section, so the section cannot re-read after it; the screen does,
   * after any removal that reached Azure, so the row and Deploy stop
   * describing the setting as it was before.
   */
  function onActivityLogRemoved(outcome: ActivityLogRemoveOutcome): void {
    if (outcome.kind === "removed" || outcome.kind === "already-gone") {
      const p = loadedProgress(latestProgressLoad.current);
      if (p !== null) commitProgress(withoutActivityLogSetting(p, config.subscriptionId), "activity log setting removed");
    }
    if (outcome.kind === "removed" || outcome.kind === "removed-not-confirmed" || outcome.kind === "already-gone") {
      void readActivityLogState(ports.azure, config.subscriptionId, logger).then(setActivityLogState, (error: unknown) => {
        // The usecase never throws; a wiring fault must not leave the old state looking current.
        setActivityLogState(null);
        logger?.error(`${LOG} Activity Log re-read after remove threw`, { error: errorText(error) });
      });
    }
  }

  function amendLastRun(deploy: OnboardingDeployForValidation, note: string): void {
    dispatchRun({ type: "amend", deploy, note });
    setLastRun((current) => {
      if (current === null) return current;
      const amended = applyOnboardingDeploy(current.result, current.values, deploy);
      return amended === null ? current : { result: amended, values: current.values };
    });
  }

  // -------------------------------------------------------------------------
  // Cribl source (D7-D10)
  // -------------------------------------------------------------------------

  const measuredHubs = measuredHubsOf(lastResult);
  // AZR-102: the namespace's own subscription and resource group, or the shared ones.
  const ehLoc = values === null ? null : eventHubLocation(values);
  const namespaceKey =
    values === null || ehLoc === null
      ? ""
      : `${ehLoc.subscriptionId.trim()}/${ehLoc.resourceGroup.trim()}/${values.namespace.trim()}`;
  // Rules read for another namespace than the plan's are not offered.
  const rulesForPlan = rules !== null && rules.ns === namespaceKey ? rules.read : null;

  const otherLanesFor = useCallback(
    (id: OnboardingSourceId): OtherLane[] => {
      const out: OtherLane[] = [];
      for (const other of chosen) {
        if (other === id) continue;
        const source = onboardingSource(other);
        if (source !== undefined) out.push({ source, subSelection: subSelectionOf(other) });
      }
      return out;
    },
    [chosen, subSelectionOf],
  );

  const topicsFor = useCallback(
    (id: OnboardingSourceId): LaneTopics | null => {
      const source = onboardingSource(id);
      if (source === undefined || values === null) return null;
      return laneTopics({ source, values, subSelection: subSelectionOf(id), measuredHubs, otherLanes: otherLanesFor(id) });
    },
    [values, subSelectionOf, measuredHubs, otherLanesFor],
  );

  async function onReadRules(): Promise<void> {
    if (values === null) return;
    const loc = eventHubLocation(values);
    const ns = {
      subscriptionId: loc.subscriptionId.trim(),
      resourceGroup: loc.resourceGroup.trim(),
      name: values.namespace.trim(),
    };
    if (ns.subscriptionId === "" || ns.resourceGroup === "" || ns.name === "") {
      setRulesMessage({
        tone: "error",
        text: "Enter the subscription, resource group and Event Hub namespace under How to set it up yourself, and choose Apply, first.",
      });
      return;
    }
    setRulesMessage(null);
    const key = `${ns.subscriptionId}/${ns.resourceGroup}/${ns.name}`;
    const read = await readAllPages(
      ports.azure,
      buildNamespaceAuthRulesListRequest(ns),
      `authorization rules in namespace ${ns.name}`,
    );
    const mapped: ListRead<NamespaceAuthRule> =
      read.state === "read"
        ? { state: "read", rows: listingRows(parseNamespaceAuthRules({ value: read.rows })) }
        : read;
    setRules({ ns: key, read: mapped });
    setReadSeq((s) => s + 1);
    logger?.info(`${LOG} namespace rules read`, { namespace: ns.name, state: mapped.state });
  }

  // AZR-36: the hubs every chosen AUTOMATED Event Hub lane reads, for the
  // consumer group. A How-to lane is the operator's to set up by hand: the app
  // offers no Azure write for it.
  const automatedEventHubLanes = useMemo(
    () =>
      progress === null
        ? []
        : chosen.filter((id) => onboardingSource(id)?.transport === "eventhub" && effectiveMode(progress, id) === "automate"),
    [chosen, progress],
  );
  const listenAccessHubs = useMemo(() => {
    const out: string[] = [];
    for (const id of automatedEventHubLanes) {
      const topics = topicsFor(id);
      if (topics === null || topics.kind !== "ok") continue;
      for (const hub of topics.topics) if (!out.includes(hub)) out.push(hub);
    }
    return out;
  }, [automatedEventHubLanes, topicsFor]);
  const hasEventHubLane = automatedEventHubLanes.length > 0;
  const listenAccessNamespace =
    values === null || ehLoc === null || values.namespace.trim() === "" || ehLoc.subscriptionId.trim() === "" || ehLoc.resourceGroup.trim() === ""
      ? null
      : { subscriptionId: ehLoc.subscriptionId.trim(), resourceGroup: ehLoc.resourceGroup.trim(), name: values.namespace.trim() };

  /** AZR-36: record what the app's PUTs created, so Remove can prove it; re-read the rules for the picker. */
  function onListenAccessCreated(result: ListenAccessApplyResult): void {
    if (result.records.length > 0) {
      const p = loadedProgress(latestProgressLoad.current);
      const recorded = p !== null && commitProgress(withEventHubAccess(p, result.records), "event hub access created");
      if (!recorded) {
        showMessage("howto", {
          tone: "warning",
          text: "The Listen rule or consumer group was created, but your saved progress could not be updated, so this page cannot prove it created them and will not offer to remove them.",
        });
      }
    }
    if (result.records.some((r) => r.kind === "listen-rule")) void onReadRules();
  }

  /** AZR-36: forget an object once it is removed or found gone. */
  function onListenAccessRemoved(record: EventHubAccessRecord, outcome: ListenAccessRemoveOutcome): void {
    if (outcome.kind !== "removed" && outcome.kind !== "already-gone") return;
    const p = loadedProgress(latestProgressLoad.current);
    if (p !== null) commitProgress(withoutEventHubAccess(p, record.resourceId), "event hub access removed");
    if (record.kind === "listen-rule") void onReadRules();
  }

  function onGroupChange(next: string): void {
    setGroupId(next);
    const p = loadedProgress(latestProgressLoad.current);
    if (p !== null && (p.workerGroup ?? "") !== next) {
      commitProgress(withWorkerGroup(p, next === "" ? null : next), "worker group");
    }
  }

  // The group every Cribl write and read on this screen uses (AZR-64).
  const groupChoice = onboardingGroupChoice(onboardingGroupResolution(mappingRead, activeTenant), groupId);
  const effectiveGroup = groupChoice.groupId;

  // ports.graph lets an Entra ID plan tie the client id to the object id whose
  // role it reads (AZR-59 review); without it the confirm says "not cross-checked".
  const criblPorts = {
    cribl: ports.cribl,
    azure: ports.azure,
    ...(logger === undefined ? {} : { logger }),
    ...(ports.graph === undefined ? {} : { graph: ports.graph }),
  };

  async function onPlan(sourceId: OnboardingSourceId, credential: PlanCredential): Promise<PlanCriblSourceResult> {
    const source = onboardingSource(sourceId);
    const p = loadedProgress(latestProgressLoad.current);
    if (source === undefined || p === null) {
      throw new Error("the source or the saved progress is not available");
    }
    if (effectiveGroup === "") {
      throw new Error(groupChoice.blockedReason ?? "no worker group is chosen");
    }
    const result = await planCriblSource(criblPorts, {
      groupId: effectiveGroup,
      lane: { source, subSelection: subSelectionOf(sourceId), otherLanes: otherLanesFor(sourceId) },
      values: p.planValues,
      measuredHubs,
      kvRecord: p.criblSources[sourceId] ?? null,
      credential,
      tenantId: config.tenantId,
      // ADR 0008 section 2: the app's own registration is never the Cribl principal.
      ...(clientId === "" ? {} : { appClientId: clientId }),
    });
    if (result.kind === "already-applied" && p.criblSources[sourceId] === undefined) {
      commitProgress(withCriblSource(p, sourceId, result.record), "cribl source found");
    }
    return result;
  }

  async function onApply(ready: ReadyCriblSource, credential: ApplyCredential): Promise<ApplyCriblSourceOutcome> {
    const outcome = await applyCriblSource(criblPorts, ready, credential);
    if ("record" in outcome) {
      const p = loadedProgress(latestProgressLoad.current);
      const recorded =
        p !== null &&
        commitProgress(withWorkerGroup(withCriblSource(p, ready.sourceId, outcome.record), ready.groupId), "cribl source created");
      if (!recorded) {
        showMessage("howto", {
          tone: "warning",
          text: `The Cribl source ${outcome.record.inputId} was created, but your saved progress could not be updated, so this page will not remember it after a reload.`,
        });
      }
    }
    return outcome;
  }

  // AZR-35: route the Defender for Cloud export or the Activity Log to Cribl
  // Lake. Read-only plan; the apply records what it created in the progress
  // document (ownership evidence for the shared pipeline, and the dataflow's
  // route hop).
  async function onPlanLakeRoute(sourceId: LakeRouteSourceId, position: RoutePosition): Promise<PlanLakeRouteResult> {
    const p = loadedProgress(latestProgressLoad.current);
    if (p === null) throw new Error("the saved progress is not available");
    return planLakeRoute(criblPorts, {
      sourceId,
      criblSource: p.criblSources[sourceId] ?? null,
      lakeRoutes: p.criblLakeRoutes ?? {},
      deploymentType: ports.criblDeploymentType,
      position,
    });
  }

  async function onApplyLakeRoute(ready: ReadyLakeRoute): Promise<ApplyLakeRouteOutcome> {
    const outcome = await applyLakeRoute(criblPorts, ready);
    if (outcome.record !== null) {
      const p = loadedProgress(latestProgressLoad.current);
      const recorded = p !== null && commitProgress(withLakeRoute(p, ready.sourceId, outcome.record, { datasetSeenAbsent: outcome.datasetSeenAbsent }), "lake route");
      if (!recorded) {
        showMessage("howto", {
          tone: "warning",
          text: `The route to Cribl Lake created objects in Cribl, but your saved progress could not be updated, so this page cannot prove it created them after a reload.`,
        });
      }
    }
    return outcome;
  }

  // AZR-105: Remove and Pause what the app created in Cribl for one source.
  // Read-only plans; each apply re-reads, and the records are updated to what
  // is still there (core recordsAfterTeardown).
  function saveTeardownRecords(sourceId: OnboardingSourceId, records: TeardownRecords): void {
    const p = loadedProgress(latestProgressLoad.current);
    const next =
      p === null
        ? null
        : withLakeRouteAfterTeardown(
            records.criblSource === null ? withoutCriblSource(p, sourceId) : withCriblSource(p, sourceId, records.criblSource),
            sourceId,
            records.lakeRoute,
          );
    const saved = next !== null && commitProgress(next, "teardown");
    if (!saved) {
      showMessage("howto", {
        tone: "warning",
        text: "Objects were removed in Cribl, but your saved progress could not be updated, so this page still lists them after a reload.",
      });
    }
  }

  async function onPlanRemove(sourceId: OnboardingSourceId, removeDataset: boolean): Promise<PlanTeardownResult> {
    const p = loadedProgress(latestProgressLoad.current);
    if (p === null) throw new Error("the saved progress is not available");
    const lakeRoutes = p.criblLakeRoutes ?? {};
    const result = await planSourceTeardown(criblPorts, {
      sourceId,
      criblSource: p.criblSources[sourceId] ?? null,
      lakeRoute: lakeRoutes[sourceId] ?? null,
      otherLakeRoutes: Object.entries(lakeRoutes)
        .filter(([id, r]) => id !== sourceId && r !== undefined)
        .map(([id, r]) => ({ sourceId: id as OnboardingSourceId, record: r! })),
      removeDataset,
    });
    // Everything already gone: nothing to confirm, and the records go now.
    if (result.kind === "nothing-to-remove") saveTeardownRecords(sourceId, result.records);
    return result;
  }

  async function onApplyRemove(ready: ReadyTeardown): Promise<ApplyTeardownOutcome> {
    const outcome = await applySourceTeardown(criblPorts, ready);
    if (outcome.kind !== "void") saveTeardownRecords(ready.input.sourceId, outcome.records);
    return outcome;
  }

  async function onPlanPause(sourceId: OnboardingSourceId, pause: boolean): Promise<PlanPauseResult> {
    const p = loadedProgress(latestProgressLoad.current);
    const record = p?.criblSources[sourceId];
    if (record === undefined) throw new Error("this app has no record of a Cribl source for it");
    return planInputPause(criblPorts, { record, pause });
  }

  async function onApplyPause(ready: ReadyPause): Promise<ApplyPauseOutcome> {
    return applyInputPause(criblPorts, ready);
  }

  async function onReadCriblSide(): Promise<void> {
    const g = effectiveGroup.trim();
    if (g === "" || progress === null) return;
    const inputs = Object.values(progress.criblSources)
      .filter((r): r is NonNullable<typeof r> => r !== undefined && r.groupId === g)
      .map((r) => ({ type: r.inputType, id: r.inputId }));
    setCriblSideBusy(true);
    try {
      const side = await readOnboardingCriblSide(ports.cribl, g, inputs);
      setCriblSide(side);
      setReadSeq((s) => s + 1);
    } finally {
      setCriblSideBusy(false);
    }
  }

  const tenantId = config.tenantId?.trim() ?? "";
  const clientId = config.clientId?.trim() ?? "";
  const principal = tenantId !== "" && clientId !== "" ? { tenantId, clientId } : null;

  const modes = useMemo(() => {
    const out: Partial<Record<OnboardingSourceId, SourceMode>> = {};
    if (progress !== null) for (const id of chosen) out[id] = effectiveMode(progress, id);
    return out;
  }, [progress, chosen]);

  // -------------------------------------------------------------------------
  // Dataflow (D14, D15)
  // -------------------------------------------------------------------------

  const liveLanes = useMemo(() => (progress === null ? [] : liveFlowLanes(progress)), [progress]);
  const live = useLiveFlow({
    cribl: ports.cribl,
    groupId: effectiveGroup === "" ? null : effectiveGroup,
    lanes: liveLanes,
    watching,
    ...(store !== undefined ? { store } : {}),
    ...(ports.logger !== undefined ? { logger: ports.logger } : {}),
  });
  const watchBlockedReason =
    groupChoice.blockedReason !== null
      ? groupChoice.blockedReason
      : effectiveGroup === ""
      ? "Choose a worker group under Cribl Stream source first."
      : liveLanes.length === 0
        ? "No Cribl source has been created yet, so there is nothing to watch."
        : null;

  const criblSideReading = useMemo(() => (criblSide === null ? null : criblSideReadingOf(criblSide)), [criblSide]);
  const laneInput = useMemo((): Omit<BuildOnboardingLanesInput, "perspective" | "flow"> | null => {
    if (selection === null || progress === null) return null;
    return {
      selection,
      progress,
      stepsFor,
      verdicts: lastResult?.verdicts ?? null,
      arrival: lastResult?.arrival ?? null,
      criblSide: criblSideReading,
      tenantId: config.tenantId,
    };
  }, [selection, progress, lastResult, criblSideReading, config.tenantId]);

  const banners = store === undefined ? [] : loadBanners(load);
  // Section 1 is the Event Hub, section 2 the chooser, then one per method.
  const firstExtra = sections.length + CHOOSER_SECTION_NUMBER + 1;

  return (
    <div className="panel azure-onboarding">
      <h2 className="panel-title">Azure Native Source Onboarding</h2>
      <p className="panel-desc">
        Send Azure-native security sources to Cribl Stream through an Event Hub or Blob storage.
        Choose the Event Hub first, then choose what to onboard and whether the app sets each
        source up or you follow the How-to steps. The sections after that show each source's
        status and deploy the ones the app can set up.
      </p>

      {store === undefined && <PickerLine message={{ tone: "error", text: SHELL_GAP_MESSAGE }} />}
      {store !== undefined && load.status === "loading" && (
        <p className="field-hint">Loading the saved selection...</p>
      )}
      {banners.map((b) => (
        <PickerLine key={b.text} message={b} />
      ))}

      <p className="field-hint">{PAGE_TIP}</p>

      <TenantInventoryHeatmap
        inventory={inventory}
        reading={inventoryReading}
        disabledReason={inventoryDisabledReason}
        progress={inventoryProgress}
        onRead={() => void onReadInventory()}
      />

      <EventHubPrerequisiteSection
        number={1}
        value={target}
        onChange={onTargetChange}
        manageSources={manageSources}
      />

      <NumberedSection
        number={CHOOSER_SECTION_NUMBER}
        title={CHOOSER_SECTION_TITLE}
        status="available"
        infoTip={CHOOSER_TIP}
      >
        {selectionFailure !== null && <PickerLine message={selectionFailure} />}
        {messages.chooser !== null && <PickerLine message={messages.chooser} />}
        <div id={CHOOSER_ANCHOR_ID} tabIndex={-1}>
          <ChoosePanel
            load={progressLoad}
            selection={selection}
            selectionCause={selectionCause}
            onSetMode={onSetMode}
            onSetChosen={onSetChosen}
            {...(gapSources !== undefined ? { gapSources } : {})}
          />
        </div>
      </NumberedSection>

      {sections.map((view, index) => {
        const status = sectionStatus(view);
        const rows = <OnboardingRows rows={view.rows} />;
        return (
          <NumberedSection
            key={view.key}
            number={index + CHOOSER_SECTION_NUMBER + 1}
            title={view.title}
            status={status}
            infoTip={SECTION_TIPS[view.key]}
            reason={status === "coming-soon" ? NOT_BUILT_NOTE : undefined}
            notBuiltBody={status === "coming-soon" ? rows : undefined}
          >
            {rows}
            {view.rows.some((r) => r.kind === "item" && r.id === ACTIVITY_LOG_ITEM_ID) &&
              (activityLogBlock.kind === "none" ? null : activityLogBlock.kind === "howto-note" ? (
                <p className="field-hint" data-testid={`azo-howto-note-${ACTIVITY_LOG_ITEM_ID}`}>
                  {activityLogBlock.text}
                </p>
              ) : (
                <ActivityLogSection
                  choice={choiceOf(ACTIVITY_LOG_ITEM_ID)}
                  target={target}
                  state={activityLogState}
                  onState={setActivityLogState}
                  onDeployed={onActivityLogDeployed}
                  howtoSection={CHOOSER_SECTION_NUMBER}
                  onShowHowto={() => showHowto(ACTIVITY_LOG_ITEM_ID)}
                  removing={activityLogRemoving}
                  onRunningChange={setActivityLogDeploying}
                  onRecheckPermissions={onRecheckPermissions}
                  recheckingPermissions={recheckingPermissions}
                  permissionsAuditKey={permissionsAuditKey}
                  permissionsNow={permissionsNow}
                />
              ))}
            {view.rows.some((r) => r.kind === "item" && r.id === ENTRA_ITEM_ID) &&
              (entraBlock.kind === "none" ? null : entraBlock.kind === "howto-note" ? (
                <p className="field-hint" data-testid={`azo-howto-note-${ENTRA_ITEM_ID}`}>
                  {entraBlock.text}
                </p>
              ) : (
                <EntraSettingSection
                  choice={choiceOf(ENTRA_ITEM_ID)}
                  entraTarget={values === null ? null : entraDeployTarget(values, subSelectionOf(ENTRA_ITEM_ID))}
                  profile={entraProfileFrom(subSelectionOf(ENTRA_ITEM_ID))}
                  picked={target}
                  record={progress === null ? null : entraSettingRecord(progress, config.tenantId)}
                  state={entraState}
                  onState={onEntraState}
                  onDeployed={onEntraDeployed}
                  howtoSection={CHOOSER_SECTION_NUMBER}
                  onShowHowto={() => showHowto(ENTRA_ITEM_ID)}
                />
              ))}
            {view.rows.some((r) => r.kind === "item" && r.id === DEFENDER_EXPORT_ITEM_ID) &&
              (defenderBlock.kind === "none" ? null : defenderBlock.kind === "howto-note" ? (
                <p className="field-hint" data-testid={`azo-howto-note-${DEFENDER_EXPORT_ITEM_ID}`}>
                  {defenderBlock.text}
                </p>
              ) : (
                <DefenderExportSection
                  choice={choiceOf(DEFENDER_EXPORT_ITEM_ID)}
                  target={target}
                  state={defenderState}
                  onState={setDefenderState}
                  onDeployed={onDefenderDeployed}
                  howtoSection={CHOOSER_SECTION_NUMBER}
                  onShowHowto={() => showHowto(DEFENDER_EXPORT_ITEM_ID)}
                  onRecheckPermissions={onRecheckPermissions}
                  recheckingPermissions={recheckingPermissions}
                  permissionsAuditKey={permissionsAuditKey}
                  permissionsNow={permissionsNow}
                />
              ))}
          </NumberedSection>
        );
      })}

      <NumberedSection number={firstExtra} title={HOWTO_SECTION_TITLES.dataflow} status="available" infoTip={DATAFLOW_TIP}>
        {laneInput === null ? (
          <p className="field-hint">{DATAFLOW_WAITING_TEXT}</p>
        ) : (
          <OnboardingDataflow
            laneInput={laneInput}
            live={live}
            watching={watching}
            onWatchingChange={setWatching}
            watchBlockedReason={watchBlockedReason}
          />
        )}
      </NumberedSection>

      <NumberedSection number={firstExtra + 1} title={HOWTO_SECTION_TITLES.howto} status="available" infoTip={HOWTO_TIP}>
        {messages.howto !== null && <PickerLine message={messages.howto} />}
        <div id={HOWTO_ANCHOR_ID} tabIndex={-1}>
          <HowToPanel
            load={progressLoad}
            selection={selection}
            result={lastResult}
            pickedEventHub={pickedHub}
            onChooseEventHubSource={onChooseEventHubSource}
            onToggleTick={onToggleTick}
            onApplyPlanValues={onApplyPlanValues}
          />
        </div>
      </NumberedSection>

      <NumberedSection number={firstExtra + 2} title={HOWTO_SECTION_TITLES.validate} status="available" infoTip={VALIDATE_TIP}>
        <ValidatePanel
          plan={validationPlan}
          hasPacing={pacing !== undefined}
          run={run}
          onValidate={() => void onValidate()}
          onCancel={() => runAbort.current?.abort()}
        />
      </NumberedSection>

      <NumberedSection number={firstExtra + 3} title={HOWTO_SECTION_TITLES.cribl} status="available" infoTip={CRIBL_TIP}>
        {rulesMessage !== null && <PickerLine message={rulesMessage} />}
        <StrandedSourcesNotice notice={strandedNotice} />
        {progress !== null && values !== null && (
          <ReceiverGrantSection
            values={values}
            readSeq={readSeq}
            records={progress.receiverGrants ?? []}
            onGranted={onReceiverGranted}
            howtoSection={CHOOSER_SECTION_NUMBER}
            onShowHowto={showHowtoSection}
            removing={receiverGrantRemoving}
            onRunningChange={setReceiverGranting}
          />
        )}
        {values !== null && hasEventHubLane && (
          <ListenAccessPanel
            namespace={listenAccessNamespace}
            hubs={listenAccessHubs}
            consumerGroup={values.consumerGroup}
            ruleName={listenRuleName(values.listenRule)}
            readSeq={readSeq}
            onCreated={onListenAccessCreated}
          />
        )}
        {progress === null || values === null ? (
          <p className="field-hint">The Cribl source can be created once your How-to progress is loaded.</p>
        ) : (
          <CriblSourcePanel
            rows={sourceRows(chosen, progress)}
            modes={modes}
            values={values}
            readSeq={readSeq}
            workerGroups={workerGroups.state}
            onLoadGroups={workerGroups.reload}
            groupId={effectiveGroup}
            onGroupChange={onGroupChange}
            groupChoice={groupChoice}
            rules={rulesForPlan}
            onReadRules={() => void onReadRules()}
            topicsFor={topicsFor}
            principal={principal}
            onPlan={onPlan}
            onApply={onApply}
            onReadCriblSide={() => void onReadCriblSide()}
            criblSide={criblSide}
            criblSideBusy={criblSideBusy}
            lakeRoute={{
              deploymentType: ports.criblDeploymentType,
              records: progress.criblLakeRoutes ?? {},
              onPlan: onPlanLakeRoute,
              onApply: onApplyLakeRoute,
            }}
          />
        )}
        {progress !== null && (
          <TeardownPanel
            hooks={{
              criblSources: progress.criblSources,
              lakeRoutes: progress.criblLakeRoutes ?? {},
              readSeq,
              onPlanRemove,
              onApplyRemove,
              onPlanPause,
              onApplyPause,
            }}
            azure={
              <>
                {/* AZR-121: from the record, whatever the Activity Log's choice or mode. */}
                <ActivityLogRemovePanel
                  record={activityLogSettingRecord(progress, config.subscriptionId)}
                  onRemoved={onActivityLogRemoved}
                  deploying={activityLogDeploying}
                  onRunningChange={setActivityLogRemoving}
                />
                <EntraRemovePanel record={entraSettingRecord(progress, config.tenantId)} onRemoved={onEntraRemoved} />
                <ListenAccessRemovePanel
                  records={progress.eventHubAccess ?? []}
                  inUseBy={eventHubSourcesInUse(progress)}
                  onRemoved={onListenAccessRemoved}
                />
                {/* AZR-141: from the records, whatever is chosen. */}
                <ReceiverGrantRemovePanel
                  records={progress.receiverGrants ?? []}
                  inUseBy={eventHubSourcesInUse(progress)}
                  granting={receiverGranting}
                  onRunningChange={setReceiverGrantRemoving}
                  onRemoved={onReceiverGrantRemoved}
                />
              </>
            }
          />
        )}
      </NumberedSection>
    </div>
  );
}

/**
 * A method section's rows: STATUS ONLY. No row has a control; a source is
 * chosen in Choose what to onboard, and its row says what was chosen.
 */
function OnboardingRows({ rows }: { rows: readonly OnboardingRowView[] }) {
  return (
    <ul className="azure-onboarding-rows">
      {rows.map((row) => {
        if (row.kind === "unsupported") {
          return (
            <li key={row.id} className="azure-onboarding-row" data-unsupported={row.id}>
              <span className="field-label">{row.title}</span>
              <span className="azure-onboarding-state azure-onboarding-state-unavailable">{row.label}</span>
              <span className="field-hint">{row.description}</span>
              <span className="field-hint">{`Instead: ${row.instead}`}</span>
            </li>
          );
        }
        if (row.kind === "xdr-tables") {
          return (
            <li key={row.id} className="azure-onboarding-row">
              <span className="field-label">{row.title}</span>
              <span className="field-hint">{row.tables.join(", ")}</span>
              <span className="field-hint">{row.reason}</span>
            </li>
          );
        }
        return (
          <li key={row.id} className="azure-onboarding-row" data-item={row.id}>
            <span className="field-label">{row.title}</span>
            <span className="field-hint">{row.description}</span>
            <span className="field-hint" data-testid={`azo-choice-${row.id}`} data-choice={row.choice.kind}>
              {row.choiceLabel}
            </span>
            <span className={`azure-onboarding-state azure-onboarding-state-${row.state}`}>
              {row.label}
            </span>
            {row.availability.status === "not-built" && (
              <span className="field-hint">{row.availability.reason}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
