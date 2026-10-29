/**
 * AzureOnboardingScreen - Azure Native Source Onboarding (AZR-18, extended by
 * AZR-30..34). Every Azure-native source the coverage catalog knows, grouped by
 * how it is collected, with the one that can be deployed today - the Defender
 * for Cloud alert export - working end to end, and every other row visible
 * with its control disabled and the reason beside it. Below them: the
 * dataflow diagram per chosen source, the How-to path (guided steps with done
 * ticks), the read-only Validate, and the Cribl Stream source the app creates.
 *
 * A THIN COMPOSER. Every decision lives in azure-onboarding-state.ts and the
 * howto/, validate/, cribl-source/ and dataflow/ state modules (pure,
 * unit-tested) and in @soc/core; this file wires them to the ports:
 *
 *   - MOUNT makes exactly TWO kvDocuments loads - the saved selection and the
 *     How-to progress document (ADR 0007 D1), each guarded by a cancelled
 *     flag - and ZERO Azure or Cribl calls. Nothing is read from Azure or
 *     Cribl until the operator asks (Find namespaces, Read Defender state,
 *     Load resource groups, Validate, Load worker groups, Read the namespace's
 *     rules, Read Cribl side, Watch for data), because each read spends the
 *     shared proxy budget. Worker groups come from useStreamWorkerGroups with
 *     auto:false.
 *   - SAVE IS EXPLICIT for the selection. Only after an `absent` load or a
 *     readable document of ours, and only when the operator changed something
 *     (canSave). A read that FAILED, a foreign document and one this release
 *     cannot read all block it. A toggle made while a save is in flight keeps
 *     the screen dirty.
 *   - PROGRESS SAVES PER CLICK (D3): a tick, a mode change, choosing a source,
 *     Apply on the plan values, the worker group and a created Cribl source
 *     each write the progress document once, serialized through one promise
 *     chain and a latest-state ref. Only after an `absent` or readable load
 *     (canWriteProgress); a failed progress load blocks those writes and
 *     leaves the selection's Save working.
 *   - VALIDATE never runs unpaced: without a `pacing` prop it is disabled with
 *     its reason; with one, the Azure port is wrapped in paceAzureManagement at
 *     the Validate rate. The budget is per run.
 *   - THE CRIBL SOURCE is planned read-only, confirmed, then created by core's
 *     applyCriblSource. A pasted credential never reaches React state or the
 *     progress document: the panel holds it and hands the apply a closure.
 *
 * Logging goes through ports.logger with the `azure-onboarding:` prefix and
 * never carries a secret.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  COVERAGE_SELECTION_KEY,
  DEFENDER_EXPORT_ITEM_ID,
  ONBOARDING_PROGRESS_KEY,
  applyCriblSource,
  buildNamespaceAuthRulesListRequest,
  emptyProgress,
  encodeProgress,
  encodeSelection,
  laneTopics,
  listingRows,
  onboardingSource,
  paceAzureManagement,
  parseNamespaceAuthRules,
  planCriblSource,
  planValidation,
  readAllPages,
  readOnboardingCriblSide,
  stepsFor,
  validateAzureOnboarding,
  withCriblSource,
  withWorkerGroup,
} from "@soc/core";
import type {
  ApplyCredential,
  ApplyCriblSourceOutcome,
  BatchPacing,
  BuildOnboardingLanesInput,
  CoverageSelection,
  DefenderState,
  KvDocumentLoad,
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
  PlanValues,
  ReadyCriblSource,
  SectionStatus,
  SourceMode,
  ValidationPlan,
  ValidationResult,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { NumberedSection } from "../../components/numbered-section";
import { useStreamWorkerGroups } from "../../components/worker-group-listing";
import {
  buildSections,
  canSave,
  criblSideReadingOf,
  loadBanners,
  loadStateFrom,
  loadedSelection,
  measuredHubsOf,
  withItem,
} from "./azure-onboarding-state";
import type {
  OnboardingLoadState,
  OnboardingRowView,
  OnboardingSectionView,
  PickerMessage,
} from "./azure-onboarding-state";
import { EventHubPrerequisiteSection, PickerLine } from "./eventhub-prerequisite-section";
import type { EventHubTarget } from "./eventhub-prerequisite-section";
import { DefenderExportSection } from "./defender-export-section";
import { HowToPanel } from "./howto/howto-panel";
import {
  applyPlanValues,
  canWriteProgress,
  chosenSourceIds,
  effectiveMode,
  loadedProgress,
  progressLoadStateFrom,
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
  validateRunReducer,
} from "./validate/validate-state";
import { CriblSourcePanel } from "./cribl-source/cribl-source-panel";
import { sourceRows } from "./cribl-source/cribl-source-state";
import { OnboardingDataflow } from "./dataflow/onboarding-dataflow";
import { liveFlowLanes, useLiveFlow } from "./dataflow/use-live-flow";

/** Shown when the shell wires no document store: a wiring gap, not a first run. */
export const SHELL_GAP_MESSAGE =
  "This build of the app has no storage for the onboarding selection, so it cannot be loaded or saved. Saving is turned off.";

/** The progress load's reason when the shell wires no document store. */
export const PROGRESS_SHELL_GAP_REASON = "this build of the app has no storage for it";

const SECTION_TIPS: Readonly<Record<OnboardingSectionView["key"], string>> = {
  "built-in-policy":
    "Azure Policy assigns diagnostic settings across many resource types at once. Deploying these initiatives from here is not available yet.",
  "custom-initiative":
    "A community-maintained policy initiative that covers resource types the built-in one does not. Deploying it from here is not available yet.",
  script:
    "Sources configured directly, without a policy. The Defender for Cloud alert export can be deployed from here; the others are shown for completeness.",
  "guided-portal":
    "The Defender XDR streaming export is finished in the Microsoft Defender portal. Guidance for it is not available here yet.",
  none: "Sources that cannot stream to an Event Hub at all, with what to use instead. Nothing here is deployed.",
};

/** The four sections that follow the catalog sections. */
const HOWTO_SECTION_TITLES = {
  dataflow: "Dataflow",
  howto: "How to set it up yourself",
  validate: "Check the Azure configuration",
  cribl: "Cribl Stream source",
} as const;

const DATAFLOW_TIP =
  "One lane per chosen source, from the Azure log emitter through the Event Hub or storage account to the Cribl source, route and destination. Read it from the Azure side, the Cribl side or end to end. A hop animates only when Cribl's metrics measured events arriving.";
const HOWTO_TIP =
  "For each source you would rather set up in Azure yourself: choose it, enter your names and ids, then follow each step's instructions and tick it when done. Ticks are saved as you make them.";
const VALIDATE_TIP =
  "Reads the Azure side of every chosen source and compares it with your plan. It only reads: nothing in Azure is changed, and no key is read.";
const CRIBL_TIP =
  "The Cribl Stream source that receives each chosen source is always created by the app, after you confirm. It never changes or deletes a source that is already there.";

/** Shown instead of the diagram until both documents have loaded. */
export const DATAFLOW_WAITING_TEXT =
  "The dataflow appears once the saved selection and your How-to progress are loaded.";

/** Shown in place of the Defender deploy controls while the source is in How-to mode. */
export const DEFENDER_HOWTO_NOTE =
  "This source is set to How-to, so the app does not deploy it. Follow its steps under How to set it up yourself, or switch it back to Automate there.";

/** No Event Hub chosen yet. The choice is React state only; it is not persisted. */
const EMPTY_EVENTHUB_TARGET: EventHubTarget = { namespace: null, hubName: "", rule: null };

const NOT_BUILT_NOTE = "These sources are shown so you can see the full picture. They cannot be deployed from here yet.";

const PAGE_TIP =
  "Choose which Azure-native sources should send to Cribl Stream, then either deploy the ones the app can set up or follow the How-to steps. Your selection is saved only when you choose Save; How-to progress is saved as you go.";

const LOG = "azure-onboarding:";

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
}

export function AzureOnboardingScreen({ pacing }: AzureOnboardingScreenProps = {}) {
  const { ports, config } = usePorts();
  const store = ports.kvDocuments;
  const logger = ports.logger;

  const [load, setLoad] = useState<OnboardingLoadState>({ status: "loading" });
  const [selection, setSelection] = useState<CoverageSelection | null>(null);
  // The selection on screen right now, read by save() after its await: the
  // `selection` it captured at the start is stale if a row was toggled since.
  const latestSelection = useRef<CoverageSelection | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<PickerMessage | null>(null);
  const [target, setTarget] = useState<EventHubTarget>(EMPTY_EVENTHUB_TARGET);
  const [defenderState, setDefenderState] = useState<DefenderState | null>(null);

  // How-to progress (ADR 0007 D1, D3).
  const [progressLoad, setProgressLoad] = useState<ProgressLoadState>(
    store === undefined ? { status: "read-unknown", reason: PROGRESS_SHELL_GAP_REASON } : { status: "loading" },
  );
  const latestProgressLoad = useRef<ProgressLoadState>(progressLoad);
  const progressChain = useRef<Promise<void>>(Promise.resolve());
  const [progressMessage, setProgressMessage] = useState<PickerMessage | null>(null);
  // The save-failure message currently shown, so a later successful save
  // clears that message and nothing else.
  const progressSaveFailure = useRef<PickerMessage | null>(null);

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
  const [groupId, setGroupId] = useState("");
  const [rules, setRules] = useState<{ readonly ns: string; readonly read: ListRead<NamespaceAuthRule> } | null>(null);
  const [rulesMessage, setRulesMessage] = useState<PickerMessage | null>(null);
  const [readSeq, setReadSeq] = useState(0);
  const [criblSide, setCriblSide] = useState<OnboardingCriblSide | null>(null);
  const [criblSideBusy, setCriblSideBusy] = useState(false);
  const [watching, setWatching] = useState(false);

  useEffect(() => {
    if (store === undefined) return;
    let cancelled = false;
    void store
      .load(COVERAGE_SELECTION_KEY)
      .then(loadStateFrom, (error: unknown): OnboardingLoadState => ({
        // The port promises never to reject; if one does, it is a failed read,
        // and a failed read must block Save, never pass as a first run.
        status: "read-unknown",
        reason: errorText(error),
      }))
      .then((next) => {
        if (cancelled) return;
        setLoad(next);
        const loadedSel = loadedSelection(next);
        latestSelection.current = loadedSel;
        setSelection(loadedSel);
        setDirty(false);
        logger?.info(`${LOG} selection loaded`, { load: next.status });
      });
    return () => {
      cancelled = true;
    };
  }, [store, logger]);

  useEffect(() => {
    if (store === undefined) return;
    let cancelled = false;
    void store
      .load(ONBOARDING_PROGRESS_KEY)
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
      });
    return () => {
      cancelled = true;
    };
    // config is read once, at load, for the first-run defaults only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, logger]);

  useEffect(
    () => () => {
      runAbort.current?.abort();
    },
    [],
  );

  const unknown = useMemo(() => {
    const map = new Map<OnboardingItemId, string>();
    if (defenderState?.unknownReason !== undefined) {
      map.set(DEFENDER_EXPORT_ITEM_ID, defenderState.unknownReason);
    }
    return map;
  }, [defenderState]);
  const sections = useMemo(
    () => buildSections(selection, defenderState?.deployed ?? null, unknown),
    [selection, defenderState, unknown],
  );

  const saveAllowed = store !== undefined && selection !== null && canSave(load, { dirty, saving });

  const progress = loadedProgress(progressLoad);
  const values: PlanValues | null = progress?.planValues ?? null;
  // The last run's answers, only while they are about the current plan (AZR-42).
  const lastResult =
    lastRun !== null && values !== null && changedPlanKeys(lastRun.values, values).length === 0
      ? lastRun.result
      : null;
  const defenderHowTo =
    progress !== null && effectiveMode(progress, DEFENDER_EXPORT_ITEM_ID) === "manual";
  const chosen = useMemo(
    () => (progress === null ? [] : chosenSourceIds(progress, selection)),
    [progress, selection],
  );
  const subSelectionOf = useCallback(
    (id: OnboardingSourceId): readonly string[] => selection?.subSelections[id] ?? [],
    [selection],
  );

  // -------------------------------------------------------------------------
  // Selection (AZR-18)
  // -------------------------------------------------------------------------

  /** Stage a selection change behind the explicit Save. */
  function stageSelection(next: CoverageSelection): void {
    latestSelection.current = next;
    setSelection(next);
    setDirty(true);
    setSaveMessage(null);
  }

  function toggle(id: OnboardingItemId, ticked: boolean): void {
    if (selection === null) return;
    const next = withItem(selection, id, ticked);
    if (next === selection) return;
    stageSelection(next);
    // Unticking changes the selection only; nothing is removed from Azure.
    logger?.info(`${LOG} item toggled`, { item: id, ticked });
  }

  async function save(): Promise<void> {
    if (!saveAllowed || store === undefined || selection === null) return;
    const written = selection;
    setSaving(true);
    try {
      await store.save(COVERAGE_SELECTION_KEY, JSON.parse(encodeSelection(written)) as unknown);
      setLoad({ status: "ready", decoded: { selection: written, dropped: [], usedDefaults: false } });
      // A row toggled while the save was in flight is NOT in the stored
      // document, so the screen stays dirty and Save stays enabled for it.
      // withItem returns a new object on every change, so reference equality
      // is exactly "nothing was toggled since".
      const unchanged = latestSelection.current === written;
      if (unchanged) setDirty(false);
      setSaveMessage({
        tone: "info",
        text: unchanged
          ? "Selection saved."
          : "The earlier selection was saved; the changes made since are not saved yet.",
      });
      logger?.info(`${LOG} selection saved`, {
        enabled: written.enabled.length,
        changedSince: !unchanged,
      });
    } catch (error) {
      const message = errorText(error);
      setSaveMessage({ tone: "error", text: `The selection was not saved - ${message}` });
      logger?.warn(`${LOG} selection save failed`, { error: message });
    } finally {
      setSaving(false);
    }
  }

  // -------------------------------------------------------------------------
  // Progress (D3): one write per click, serialized
  // -------------------------------------------------------------------------

  /**
   * Show `next` at once and queue its write behind any write in flight. Every
   * write carries the whole document, so the last one queued is the latest.
   * Returns false (and writes nothing) while progress writes are blocked.
   */
  function commitProgress(next: OnboardingProgress, what: string): boolean {
    const state = latestProgressLoad.current;
    if (store === undefined || !canWriteProgress(state)) return false;
    const shown = withSavedProgress(state, next);
    latestProgressLoad.current = shown;
    setProgressLoad(shown);
    const body = JSON.parse(encodeProgress(next)) as unknown;
    progressChain.current = progressChain.current.then(async () => {
      try {
        await store.save(ONBOARDING_PROGRESS_KEY, body);
        // A save clears only its own earlier failure. Any other message - a
        // notice set by the click that queued this write, such as a choice not
        // carried over between modes - must outlive the write it explains.
        const failure = progressSaveFailure.current;
        progressSaveFailure.current = null;
        if (failure !== null) setProgressMessage((m) => (m === failure ? null : m));
        logger?.info(`${LOG} progress saved`, { change: what });
      } catch (error) {
        const message = errorText(error);
        const failure: PickerMessage = {
          tone: "error",
          text: `Your How-to progress was not saved - ${message}. The next change tries again with everything shown here.`,
        };
        progressSaveFailure.current = failure;
        setProgressMessage(failure);
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
    commitProgress(change.progress, "mode");
    if (change.selection !== null && change.selection !== latestSelection.current) stageSelection(change.selection);
    if (change.notice !== null) setProgressMessage({ tone: "info", text: change.notice });
  }

  function onSetChosen(id: OnboardingSourceId, isChosen: boolean): void {
    const result = setChosen(latestProgressLoad.current, latestSelection.current, id, isChosen);
    if (result.kind === "progress") commitProgress(result.progress, "choose");
    else if (result.kind === "selection") stageSelection(result.selection);
    else setProgressMessage({ tone: "error", text: result.reason });
  }

  function onApplyPlanValues(next: PlanValues): void {
    const p = applyPlanValues(latestProgressLoad.current, next);
    if (p !== null) commitProgress(p, "plan values");
  }

  // The AZR-18 picker's names, for "Use the Event Hub picked above". React
  // state only: the picker itself is not seeded from the plan.
  const pickedValues = useMemo((): Partial<PlanValues> | null => {
    const ns = target.namespace;
    if (ns === null) return null;
    return {
      subscriptionId: ns.subscriptionId,
      resourceGroup: ns.resourceGroup,
      namespace: ns.name,
      hubName: target.hubName,
      sendRule: target.rule?.name ?? "",
    };
  }, [target]);

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

  // -------------------------------------------------------------------------
  // Cribl source (D7-D10)
  // -------------------------------------------------------------------------

  const measuredHubs = measuredHubsOf(lastResult);
  const namespaceKey =
    values === null ? "" : `${values.subscriptionId.trim()}/${values.resourceGroup.trim()}/${values.namespace.trim()}`;
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
    const ns = {
      subscriptionId: values.subscriptionId.trim(),
      resourceGroup: values.resourceGroup.trim(),
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

  function onGroupChange(next: string): void {
    setGroupId(next);
    const p = loadedProgress(latestProgressLoad.current);
    if (p !== null && (p.workerGroup ?? "") !== next) {
      commitProgress(withWorkerGroup(p, next === "" ? null : next), "worker group");
    }
  }

  const criblPorts = { cribl: ports.cribl, azure: ports.azure, ...(logger === undefined ? {} : { logger }) };

  async function onPlan(sourceId: OnboardingSourceId, credential: PlanCredential): Promise<PlanCriblSourceResult> {
    const source = onboardingSource(sourceId);
    const p = loadedProgress(latestProgressLoad.current);
    if (source === undefined || p === null) {
      throw new Error("the source or the saved progress is not available");
    }
    const result = await planCriblSource(criblPorts, {
      groupId,
      lane: { source, subSelection: subSelectionOf(sourceId), otherLanes: otherLanesFor(sourceId) },
      values: p.planValues,
      measuredHubs,
      kvRecord: p.criblSources[sourceId] ?? null,
      credential,
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
        setProgressMessage({
          tone: "warning",
          text: `The Cribl source ${outcome.record.inputId} was created, but your saved progress could not be updated, so this page will not remember it after a reload.`,
        });
      }
    }
    return outcome;
  }

  async function onReadCriblSide(): Promise<void> {
    const g = groupId.trim();
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
  const live = useLiveFlow({ cribl: ports.cribl, groupId: groupId === "" ? null : groupId, lanes: liveLanes, watching });
  const watchBlockedReason =
    groupId === ""
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
    };
  }, [selection, progress, lastResult, criblSideReading]);

  const banners = store === undefined ? [] : loadBanners(load);
  const firstExtra = sections.length + 2;

  return (
    <div className="panel azure-onboarding">
      <h2 className="panel-title">Azure Native Source Onboarding</h2>
      <p className="panel-desc">
        Send Azure-native security sources to Cribl Stream through an Event Hub or Blob storage.
        Choose the Event Hub first, then tick and deploy the sources that are available, or follow
        the How-to steps further down to set a source up in Azure yourself. Sources that cannot be
        deployed from here yet are listed with their checkboxes turned off.
      </p>

      {store === undefined && <PickerLine message={{ tone: "error", text: SHELL_GAP_MESSAGE }} />}
      {store !== undefined && load.status === "loading" && (
        <p className="field-hint">Loading the saved selection...</p>
      )}
      {banners.map((b) => (
        <PickerLine key={b.text} message={b} />
      ))}

      <div className="panel-controls">
        <button
          type="button"
          className="next-action-button"
          disabled={!saveAllowed}
          onClick={() => void save()}
        >
          {saving ? "Saving..." : "Save selection"}
        </button>
        {dirty && !saving && <span className="field-hint">Unsaved changes.</span>}
      </div>
      {saveMessage !== null && <PickerLine message={saveMessage} />}
      <p className="field-hint">{PAGE_TIP}</p>

      <EventHubPrerequisiteSection number={1} value={target} onChange={setTarget} />

      {sections.map((view, index) => {
        const status = sectionStatus(view);
        const rows = <OnboardingRows rows={view.rows} onToggle={toggle} />;
        return (
          <NumberedSection
            key={view.key}
            number={index + 2}
            title={view.title}
            status={status}
            infoTip={SECTION_TIPS[view.key]}
            reason={status === "coming-soon" ? NOT_BUILT_NOTE : undefined}
            notBuiltBody={status === "coming-soon" ? rows : undefined}
          >
            {rows}
            {view.rows.some((r) => r.kind === "item" && r.id === DEFENDER_EXPORT_ITEM_ID) &&
              (defenderHowTo ? (
                <p className="field-hint">{DEFENDER_HOWTO_NOTE}</p>
              ) : (
                <DefenderExportSection
                  selection={selection}
                  target={target}
                  state={defenderState}
                  onState={setDefenderState}
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
        {progressMessage !== null && <PickerLine message={progressMessage} />}
        <HowToPanel
          load={progressLoad}
          selection={selection}
          result={lastResult}
          pickedValues={pickedValues}
          onToggleTick={onToggleTick}
          onSetMode={onSetMode}
          onSetChosen={onSetChosen}
          onApplyPlanValues={onApplyPlanValues}
        />
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
            groupId={groupId}
            onGroupChange={onGroupChange}
            rules={rulesForPlan}
            onReadRules={() => void onReadRules()}
            topicsFor={topicsFor}
            principal={principal}
            onPlan={onPlan}
            onApply={onApply}
            onReadCriblSide={() => void onReadCriblSide()}
            criblSide={criblSide}
            criblSideBusy={criblSideBusy}
          />
        )}
      </NumberedSection>
    </div>
  );
}

function OnboardingRows({
  rows,
  onToggle,
}: {
  rows: readonly OnboardingRowView[];
  onToggle: (id: OnboardingItemId, ticked: boolean) => void;
}) {
  return (
    <ul className="azure-onboarding-rows">
      {rows.map((row) => {
        if (row.kind === "unsupported") {
          return (
            <li key={row.id} className="azure-onboarding-row">
              <span className="field-label">{row.title}</span>
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
          <li key={row.id} className="azure-onboarding-row">
            <label className="integrate-check">
              <input
                type="checkbox"
                aria-label={row.title}
                checked={row.selected}
                disabled={!row.tickable}
                onChange={(e) => onToggle(row.id, e.target.checked)}
              />
              <span className="integrate-check-text">{row.title}</span>
            </label>
            <span className="field-hint">{row.description}</span>
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
