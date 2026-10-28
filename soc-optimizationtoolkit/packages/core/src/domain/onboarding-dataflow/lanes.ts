/**
 * Onboarding dataflow lanes - WHAT THE DIAGRAM DRAWS, per source and perspective.
 *
 * AZR-30 (the diagram), AZR-32 (Validate verdicts on its cards), AZR-33 (the
 * measured live flow on its Azure -> Cribl hop). ADR 0007, D2 / D9 / D14 / D15.
 *
 * ONE LANE PER CHOSEN SOURCE (D2). A source in Automated mode is chosen when
 * the AZR-18 selection enables it AND the app can deploy it (isAutomatable); a
 * How-to source is chosen when the progress document says so. Lanes follow
 * ONBOARDING_SOURCES order.
 *
 * A LANE IS A CHAIN OF CARDS:
 *   emitter -> transport (Event Hub namespace / storage account) -> Cribl source
 *   -> route -> destination, plus the How-to step cards (Azure side only), each
 *   hung off the card it configures.
 *
 * PERSPECTIVES (D14):
 *   azure        emitter, transport and step cards; Cribl folded into one card
 *   cribl        Azure folded into one card carrying the aggregate verdict;
 *                source, route and destination expanded
 *   end-to-end   every card except the step cards
 *
 * SHARED OBJECTS. Every Event Hub lane uses the plan's one namespace and every
 * blob lane the plan's one storage account. Each shared object's status is
 * computed ONCE, from the verdicts of every lane that uses it, and each lane's
 * transport card references it by `sharedId` (and carries the same status
 * object), so two lanes can never show the same namespace in two states.
 *
 * ONLY THE TRANSPORT -> CRIBL SOURCE EDGE CARRIES A FLOW STATE (D15). It is the
 * one hop Cribl's intake metrics measure. Every other edge is not measured
 * ("no counter"), and only a `flowing` hop is animated (claude-kit standards/
 * cribl-metrics.md, cribl-dataflow-diagram.md).
 *
 * HONESTY (claude-kit standards/inventory-honesty.md). No verdicts means "not
 * checked yet", never "not found"; an unknown verdict says "cannot check" with
 * its reason; a hub arrival of a measured 0 reads "no messages in the window",
 * distinct from "arrival could not be read", and a hub a complete listing
 * lacks reads "does not exist yet", never as a quiet hub (AZR-47).
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import type { CoverageSelection } from "../coverage-model/coverage-selection";
import {
  aggregateVerdict,
  otherNameAlsoFound,
  type AggregateVerdict,
  type ArrivalReading,
  type CheckKind,
  type StepVerdict,
  type UnknownReason,
} from "../onboarding-howto/check-kinds";
import type { PlanValues } from "../onboarding-howto/plan-values";
import {
  tickState,
  type CriblSourceRecord,
  type OnboardingProgress,
  type SourceMode,
  type TickState,
} from "../onboarding-howto/progress-document";
import {
  ONBOARDING_SOURCES,
  isAutomatable,
  type CriblInputType,
  type OnboardingSource,
  type OnboardingSourceId,
  type OnboardingTransport,
} from "../onboarding-howto/sources";
import type { HowToStep } from "../onboarding-howto-steps/steps";
import { onboardingInputId } from "../cribl-onboarding-source/input-bodies";
import { LEGACY_INPUT_MATCH_SUFFIX } from "../capture-filter/input-id";
import {
  classifyLaneFlow,
  describeLaneFlow,
  shouldAnimate,
  type LaneFlowState,
} from "../onboarding-flow/flow-state";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type DataflowPerspective = "azure" | "cribl" | "end-to-end";

export const DATAFLOW_PERSPECTIVES: readonly DataflowPerspective[] = ["azure", "cribl", "end-to-end"];

/**
 * The key of one Validate verdict: `${sourceId}/${stepId}/${kind}`. The same
 * format as usecases/validate-azure-onboarding checkKey (pinned equal), kept
 * here so the domain does not import a usecase.
 */
export function laneCheckKey(sourceId: OnboardingSourceId, stepId: string, kind: CheckKind): string {
  return `${sourceId}/${stepId}/${kind}`;
}

/** Whether Cribl still has an input, as the Cribl-side read found it. */
export type CriblInputReading =
  | { readonly kind: "present" }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly detail: string };

/** Whether a route sends the input's events somewhere, as the Cribl-side read found it. */
export type CriblRouteReading =
  | {
      readonly kind: "consumes";
      readonly route: string;
      readonly destination: string | null;
      /**
       * The consuming route names the input only by its bare id, which a
       * capture found matching nothing (DBT-162): shown, never as confirmed.
       */
      readonly legacyBareMatch?: true;
    }
  | { readonly kind: "not-routed" }
  | { readonly kind: "cannot-evaluate"; readonly route: string; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string };

/**
 * What a "Read Cribl side" run found, keyed by Cribl input id. A missing key
 * means the read did not cover that input, which is shown as "not read",
 * never as absent.
 */
export interface CriblSideReading {
  readonly inputs: Readonly<Record<string, CriblInputReading>>;
  readonly routes: Readonly<Record<string, CriblRouteReading>>;
}

export interface BuildOnboardingLanesInput {
  readonly selection: CoverageSelection;
  readonly progress: OnboardingProgress;
  readonly stepsFor: (id: OnboardingSourceId, subSelection: readonly string[]) => readonly HowToStep[];
  /** Validate's verdicts keyed by {@link laneCheckKey}; null before any run. */
  readonly verdicts: Readonly<Record<string, StepVerdict>> | null;
  /** Hub -> arrival reading from the last Validate; null before any run. */
  readonly arrival: Readonly<Record<string, ArrivalReading>> | null;
  /** The last Cribl-side read; null before any. */
  readonly criblSide: CriblSideReading | null;
  /** The live-flow states keyed by source; null while not watching. */
  readonly flow: Readonly<Partial<Record<OnboardingSourceId, LaneFlowState>>> | null;
  readonly perspective: DataflowPerspective;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type LaneCardKind =
  | "emitter"
  | "transport"
  | "step"
  | "cribl-source"
  | "route"
  | "destination"
  | "cribl-folded"
  | "azure-folded";

/** The state word vocabulary. The UI maps `kind` to a token colour; `label` is always shown. */
export type CardStatusKind =
  | "not-checked"
  | "no-check"
  | "as-expected"
  | "partly-checked"
  | "differs"
  | "other-name"
  | "absent"
  | "unknown"
  | "not-created"
  | "created"
  | "present"
  | "missing"
  | "not-read"
  | "named-by-route"
  | "consumes"
  | "not-routed"
  | "cannot-evaluate";

export interface CardStatus {
  readonly kind: CardStatusKind;
  readonly label: string;
}

export interface LaneCard {
  /** Unique across the whole diagram: `${sourceId}:${kind}` or `${sourceId}:step:${stepId}`. */
  readonly id: string;
  readonly kind: LaneCardKind;
  readonly title: string;
  readonly status: CardStatus;
  /** Short lines under the title: names, ids, arrival readings. */
  readonly facts: readonly string[];
  /** The (i) text. */
  readonly info: string;
  /** Set on a transport card: the {@link SharedObject} it draws. */
  readonly sharedId?: string;
  /** Set on a step card. */
  readonly stepId?: string;
  /** Set on a step card of a How-to lane; null on an Automated lane. */
  readonly tick?: TickState | null;
  /** Set on a step card of a How-to lane: 'done', 'not done' or 'done against older values ...'. */
  readonly tickLabel?: string;
}

/** What an edge says about traffic. Only the transport -> Cribl source edge is measured. */
export type EdgeFlow =
  | { readonly kind: "measured"; readonly state: LaneFlowState; readonly label: string }
  | { readonly kind: "not-measured"; readonly reason: "no-counter"; readonly label: string };

export interface LaneEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** `data` carries logs; `configures` hangs a step card off what it sets up. */
  readonly kind: "data" | "configures";
  readonly flow: EdgeFlow;
  /** True only for a measured `flowing` hop. */
  readonly animated: boolean;
}

export interface OnboardingLane {
  readonly sourceId: OnboardingSourceId;
  readonly title: string;
  readonly mode: SourceMode;
  readonly transport: OnboardingTransport;
  readonly criblInputType: CriblInputType;
  /** The Cribl input id: the created one, else the one the app would create, else null. */
  readonly inputId: string | null;
  readonly flow: LaneFlowState;
  readonly cards: readonly LaneCard[];
  readonly edges: readonly LaneEdge[];
}

export interface SharedObject {
  /** `eventhub-namespace:<name>` or `storage-account:<name>`. */
  readonly id: string;
  readonly kind: "eventhub-namespace" | "storage-account";
  readonly name: string;
  /** Computed once, from every using lane's verdicts. */
  readonly status: CardStatus;
  readonly sourceIds: readonly OnboardingSourceId[];
}

export interface OnboardingLanes {
  readonly lanes: readonly OnboardingLane[];
  readonly shared: readonly SharedObject[];
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const UNKNOWN_REASON_LABEL: Readonly<Record<UnknownReason, string>> = {
  denied: "no permission",
  failed: "the read failed",
  truncated: "the list was cut short",
  unregistered: "the resource provider is not registered",
  unmeasurable: "not readable from Azure",
  "missing-value": "a plan value is not set",
};

const NOT_CHECKED: CardStatus = { kind: "not-checked", label: "not checked yet" };
const NO_CHECK: CardStatus = { kind: "no-check", label: "not checked by Validate" };

/** One verdict with the kind of check that reached it, which words an other-name verdict. */
export interface CheckedVerdict {
  readonly check: CheckKind;
  readonly verdict: StepVerdict;
}

/**
 * The status one verdict shows. `check` is the check's kind: an other-name
 * label counts the other matches in that kind's unit (core otherNameAlsoFound,
 * the same words Validate and the How-to step use - DBT-189).
 */
export function verdictStatus(v: StepVerdict, check?: CheckKind): CardStatus {
  switch (v.kind) {
    case "as-expected":
      return { kind: "as-expected", label: "configured as expected" };
    case "present-differs":
      return {
        kind: "differs",
        label: `present but different (${v.diffs.map((d) => d.field).join(", ") || "details in Validate"})`,
      };
    case "present-other-name": {
      const also = otherNameAlsoFound(v.alsoFound, check);
      return { kind: "other-name", label: `exists (named ${v.name}${also === "" ? "" : `; ${also}`})` };
    }
    case "absent":
      return { kind: "absent", label: "not found" };
    case "unknown":
      return { kind: "unknown", label: `cannot check: ${UNKNOWN_REASON_LABEL[v.reason]}` };
  }
}

/** The aggregate class each verdict kind belongs to (check-kinds' aggregateVerdict). */
const AGGREGATE_CLASS: Readonly<Record<StepVerdict["kind"], AggregateVerdict>> = {
  "as-expected": "as-expected",
  "present-differs": "differs",
  "present-other-name": "differs",
  absent: "absent",
  unknown: "unknown",
};

/**
 * The status of a group of verdicts. aggregateVerdict decides the worst class;
 * the first verdict of that class is shown, so its reason or differing fields
 * are kept. An empty group is "not checked yet"; the caller decides when
 * emptiness means "no check exists" instead.
 *
 * `expected` is how many checks the group has. When fewer verdicts were found
 * than expected (the last Validate did not cover a check: a source chosen
 * after the run, a cancelled run, a changed sub-selection) the group can never
 * read "configured as expected": a check that was not read is not good
 * (claude-kit standards/inventory-honesty.md). A worse verdict that WAS read
 * still wins, since it is the more useful thing to show.
 */
export function groupStatus(checked: readonly CheckedVerdict[], expected: number = checked.length): CardStatus {
  if (checked.length === 0) return NOT_CHECKED;
  const verdicts = checked.map((c) => c.verdict);
  const worst = aggregateVerdict(verdicts);
  if (worst === "as-expected" && verdicts.length < expected) {
    return {
      kind: "partly-checked",
      label: `partly checked (${verdicts.length} of ${expected}): the rest were not checked in the last run`,
    };
  }
  const pick = checked.find((c) => AGGREGATE_CLASS[c.verdict.kind] === worst) as CheckedVerdict;
  return verdictStatus(pick.verdict, pick.check);
}

/**
 * The arrival line on a transport card. A measured 0 is a real answer; a hub
 * the complete listing lacks is not quiet, it was never created.
 */
export function arrivalText(hub: string, reading: ArrivalReading): string {
  if (reading.kind === "no-hub") return `${hub}: ${NO_HUB_ARRIVAL}`;
  if (reading.kind === "measured") {
    return reading.messages === 0
      ? `${hub}: no messages in the window`
      : `${hub}: ${reading.messages} messages in the window`;
  }
  return `${hub}: arrival could not be read: ${UNKNOWN_REASON_LABEL[reading.reason]}`;
}

/**
 * The words for a `no-hub` arrival reading, shared by the transport card and
 * the Validate panel so the two cannot drift apart.
 */
export const NO_HUB_ARRIVAL =
  "the hub does not exist yet, so nothing has been sent to it";

/** The tick line on a How-to step card. */
export function tickText(tick: TickState): string {
  switch (tick.status) {
    case "not-done":
      return "not done";
    case "done":
      return "done";
    case "stale":
      return `done against older values (changed: ${tick.changedKeys.join(", ")})`;
  }
}

const EVENTHUB_TRANSPORT_KINDS: ReadonlySet<CheckKind> = new Set<CheckKind>([
  "eh-namespace",
  "eh-hub",
  "eh-rule-send",
  "eh-rule-listen",
  "eh-rule-manage",
  "eh-consumer-group",
]);

const BLOB_TRANSPORT_KINDS: ReadonlySet<CheckKind> = new Set<CheckKind>([
  "storage-account",
  "storage-container",
  "storage-queue",
  "eventgrid-topic",
  "eventgrid-subscription",
  "storage-rbac",
]);

function isTransportKind(transport: OnboardingTransport, kind: CheckKind): boolean {
  return transport === "eventhub" ? EVENTHUB_TRANSPORT_KINDS.has(kind) : BLOB_TRANSPORT_KINDS.has(kind);
}

/** Which card a step configures: the transport when all its checks are transport checks. */
function stepTarget(transport: OnboardingTransport, step: HowToStep): "transport" | "emitter" {
  if (step.checkKinds.length > 0 && step.checkKinds.every((k) => isTransportKind(transport, k))) {
    return "transport";
  }
  // A check-less step is placed by its id family: the shared Event Hub and
  // storage steps configure the transport, everything else the emitter.
  if (step.checkKinds.length === 0 && (step.id.startsWith("eh-") || step.id.startsWith("blob-storage"))) {
    return "transport";
  }
  return "emitter";
}

const EMITTER_INFO: Readonly<Record<OnboardingSource["emitterKind"], string>> = {
  "policy-initiative":
    "An Azure Policy initiative that deploys a diagnostic setting on each resource in scope, sending its logs to the Event Hub namespace.",
  "activity-log-setting":
    "The subscription's Activity Log diagnostic setting, which sends control-plane events to the Event Hub namespace.",
  "tenant-diagnostic-setting":
    "The Entra ID tenant diagnostic setting, which sends sign-in and audit logs to the Event Hub namespace. Azure creates one hub per category.",
  "defender-export":
    "A Defender for Cloud continuous export, which writes alerts and recommendations to the named hub.",
  "xdr-streaming-api":
    "The Defender XDR Streaming API, configured in the Defender portal. Azure exposes nothing this app can read about it, so Validate cannot confirm it.",
  "vnet-flow-log":
    "A VNet flow log, which Network Watcher writes as blobs to the storage account.",
  "nsg-flow-log":
    "An NSG flow log, which Network Watcher writes as blobs to the storage account.",
};

// ---------------------------------------------------------------------------
// Chosen sources (D2)
// ---------------------------------------------------------------------------

/**
 * A source's mode: what the progress document says, else Automated for a
 * source the app can deploy (the AZR-18 behaviour) and How-to for any other.
 * `automate` on a source the app cannot deploy is read as `manual`.
 */
export function laneMode(progress: OnboardingProgress, id: OnboardingSourceId): SourceMode {
  const stored = progress.sources[id]?.mode;
  const automatable = isAutomatable(id);
  if (stored === undefined) return automatable ? "automate" : "manual";
  return stored === "automate" && automatable ? "automate" : "manual";
}

/** Whether a source gets a lane (D2). */
export function isLaneChosen(
  selection: CoverageSelection,
  progress: OnboardingProgress,
  id: OnboardingSourceId,
): boolean {
  if (laneMode(progress, id) === "automate") {
    return isAutomatable(id) && selection.enabled.includes(id);
  }
  return progress.sources[id]?.chosen === true;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function verdictsOf(
  verdicts: Readonly<Record<string, StepVerdict>> | null,
  sourceId: OnboardingSourceId,
  step: HowToStep,
  include: (kind: CheckKind) => boolean,
): CheckedVerdict[] {
  if (verdicts === null) return [];
  const out: CheckedVerdict[] = [];
  for (const kind of step.checkKinds) {
    if (!include(kind)) continue;
    const v = verdicts[laneCheckKey(sourceId, step.id, kind)];
    if (v !== undefined) out.push({ check: kind, verdict: v });
  }
  return out;
}

function sharedIdFor(source: OnboardingSource, values: PlanValues): string {
  return source.transport === "eventhub"
    ? `eventhub-namespace:${values.namespace.trim()}`
    : `storage-account:${values.storageAccount.trim()}`;
}

function unset(value: string): string {
  return value.trim() === "" ? "<not set>" : value.trim();
}

function criblSourceStatus(
  record: CriblSourceRecord | undefined,
  inputId: string | null,
  criblSide: CriblSideReading | null,
): CardStatus {
  if (record === undefined) {
    if (inputId !== null && criblSide !== null) {
      const r = criblSide.inputs[inputId];
      if (r?.kind === "present") return { kind: "present", label: "exists in Cribl (not created by this screen)" };
    }
    return { kind: "not-created", label: "not created yet" };
  }
  if (criblSide === null) return { kind: "created", label: "created (Cribl side not read yet)" };
  const r = criblSide.inputs[record.inputId];
  if (r === undefined) return { kind: "not-read", label: "not read" };
  if (r.kind === "present") return { kind: "present", label: "present in Cribl" };
  if (r.kind === "absent") return { kind: "missing", label: "created, but no longer in Cribl" };
  return { kind: "unknown", label: "cannot check: the Cribl read failed" };
}

function routeStatus(inputId: string | null, criblSide: CriblSideReading | null): {
  status: CardStatus;
  destination: string | null;
  route: string | null;
} {
  if (inputId === null || criblSide === null) {
    return { status: { kind: "not-read", label: "not read" }, destination: null, route: null };
  }
  const r = criblSide.routes[inputId];
  if (r === undefined) return { status: { kind: "not-read", label: "not read" }, destination: null, route: null };
  switch (r.kind) {
    case "consumes":
      return {
        status: {
          kind: "consumes",
          label:
            `routed by ${r.route}` + (r.legacyBareMatch === true ? LEGACY_INPUT_MATCH_SUFFIX : ""),
        },
        destination: r.destination,
        route: r.route,
      };
    case "not-routed":
      return { status: { kind: "not-routed", label: "no route sends it on yet" }, destination: null, route: null };
    case "cannot-evaluate":
      return {
        status: { kind: "cannot-evaluate", label: `cannot check: route ${r.route} has a filter the app cannot evaluate` },
        destination: null,
        route: r.route,
      };
    case "unknown":
      return { status: { kind: "unknown", label: "cannot check: the routes read failed" }, destination: null, route: null };
  }
}

const NO_COUNTER: EdgeFlow = {
  kind: "not-measured",
  reason: "no-counter",
  label: "not measured: no counter",
};

function dataEdge(from: string, to: string): LaneEdge {
  return { id: `${from}->${to}`, from, to, kind: "data", flow: NO_COUNTER, animated: false };
}

function measuredEdge(from: string, to: string, state: LaneFlowState): LaneEdge {
  return {
    id: `${from}->${to}`,
    from,
    to,
    kind: "data",
    flow: { kind: "measured", state, label: describeLaneFlow(state) },
    animated: shouldAnimate(state),
  };
}

function laneFlowState(
  flow: BuildOnboardingLanesInput["flow"],
  sourceId: OnboardingSourceId,
  record: CriblSourceRecord | undefined,
): LaneFlowState {
  if (record === undefined) {
    return classifyLaneFlow({ input: null, windowAnswer: null, lookbackAnswer: null, lookbackStatus: "pending" });
  }
  const state = flow?.[sourceId];
  if (state !== undefined) return state;
  return { kind: "not-measured", reason: "waiting", detail: "Watch for data is off" };
}

interface LaneDraft {
  readonly source: OnboardingSource;
  readonly mode: SourceMode;
  readonly subSelection: readonly string[];
  readonly steps: readonly HowToStep[];
  readonly sharedId: string;
}

/**
 * Build the lanes and the shared objects for one perspective.
 */
export function buildOnboardingLanes(input: BuildOnboardingLanesInput): OnboardingLanes {
  const { selection, progress, verdicts, arrival, criblSide, flow, perspective } = input;
  const values = progress.planValues;

  const drafts: LaneDraft[] = [];
  for (const source of ONBOARDING_SOURCES) {
    if (!isLaneChosen(selection, progress, source.id)) continue;
    const subSelection = selection.subSelections[source.id] ?? [];
    drafts.push({
      source,
      mode: laneMode(progress, source.id),
      subSelection,
      steps: input.stepsFor(source.id, subSelection),
      sharedId: sharedIdFor(source, values),
    });
  }

  // Shared objects: one status each, from every using lane's transport verdicts.
  const sharedVerdicts = new Map<string, CheckedVerdict[]>();
  const sharedChecks = new Map<string, number>();
  const sharedSources = new Map<string, OnboardingSourceId[]>();
  for (const d of drafts) {
    const list = sharedVerdicts.get(d.sharedId) ?? [];
    // `checks` counts every expected transport check, found or not, so a
    // partly covered namespace cannot read as expected (groupStatus).
    let checks = sharedChecks.get(d.sharedId) ?? 0;
    for (const step of d.steps) {
      const include = (k: CheckKind): boolean => isTransportKind(d.source.transport, k);
      checks += step.checkKinds.filter(include).length;
      list.push(...verdictsOf(verdicts, d.source.id, step, include));
    }
    sharedVerdicts.set(d.sharedId, list);
    sharedChecks.set(d.sharedId, checks);
    sharedSources.set(d.sharedId, [...(sharedSources.get(d.sharedId) ?? []), d.source.id]);
  }
  const shared: SharedObject[] = [];
  const sharedById = new Map<string, SharedObject>();
  for (const [id, sourceIds] of sharedSources) {
    const isEh = id.startsWith("eventhub-namespace:");
    const obj: SharedObject = {
      id,
      kind: isEh ? "eventhub-namespace" : "storage-account",
      name: unset(isEh ? values.namespace : values.storageAccount),
      status:
        sharedChecks.get(id) === 0
          ? NO_CHECK
          : groupStatus(sharedVerdicts.get(id) ?? [], sharedChecks.get(id) ?? 0),
      sourceIds,
    };
    shared.push(obj);
    sharedById.set(id, obj);
  }

  const lanes = drafts.map((d) => buildLane(d, sharedById.get(d.sharedId) as SharedObject));

  function buildLane(d: LaneDraft, sharedObj: SharedObject): OnboardingLane {
    const { source, mode, steps } = d;
    const sid = source.id;
    const record = progress.criblSources[sid];
    const inputId = record?.inputId ?? onboardingInputId(source, values);
    const flowState = laneFlowState(flow, sid, record);

    const ids = {
      emitter: `${sid}:emitter`,
      transport: `${sid}:transport`,
      source: `${sid}:cribl-source`,
      route: `${sid}:route`,
      destination: `${sid}:destination`,
      criblFolded: `${sid}:cribl-folded`,
      azureFolded: `${sid}:azure-folded`,
    };

    // Emitter: every non-transport check of the lane.
    const emitterChecks: CheckedVerdict[] = [];
    let emitterCheckCount = 0;
    const allVerdicts: CheckedVerdict[] = [];
    let allCheckCount = 0;
    for (const step of steps) {
      const notTransport = (k: CheckKind): boolean => !isTransportKind(source.transport, k);
      emitterCheckCount += step.checkKinds.filter(notTransport).length;
      allCheckCount += step.checkKinds.length;
      emitterChecks.push(...verdictsOf(verdicts, sid, step, notTransport));
      allVerdicts.push(...verdictsOf(verdicts, sid, step, () => true));
    }
    const emitter: LaneCard = {
      id: ids.emitter,
      kind: "emitter",
      title: source.title,
      status: emitterCheckCount === 0 ? NO_CHECK : groupStatus(emitterChecks, emitterCheckCount),
      facts: [mode === "automate" ? "set up by the app" : "set up by you (How-to)"],
      info: EMITTER_INFO[source.emitterKind],
    };

    const transportFacts: string[] = [];
    if (source.transport === "eventhub") {
      transportFacts.push(`namespace ${unset(values.namespace)}`);
      const hubs = source.expectedHubNames(values, d.subSelection);
      if (hubs.length > 0) transportFacts.push(`hubs ${hubs.join(", ")}`);
      else if (source.autoCreatedHubPrefix !== null) transportFacts.push(`hubs ${source.autoCreatedHubPrefix}* (created by Azure)`);
      transportFacts.push(`consumer group ${unset(values.consumerGroup)}`);
      if (arrival !== null) {
        for (const hub of hubs) {
          const reading = arrival[hub];
          if (reading !== undefined) transportFacts.push(arrivalText(hub, reading));
        }
      }
    } else {
      transportFacts.push(`storage account ${unset(values.storageAccount)}`);
      transportFacts.push(`container ${unset(values.container)}`);
      transportFacts.push(`queue ${unset(values.queueName)}`);
    }
    const transport: LaneCard = {
      id: ids.transport,
      kind: "transport",
      title: source.transport === "eventhub" ? "Event Hub namespace" : "Storage account (Blob)",
      status: sharedObj.status,
      facts: transportFacts,
      info:
        source.transport === "eventhub"
          ? "The Event Hub namespace the logs are written to. Cribl reads them over the Kafka endpoint with a Listen-capable rule. Hub arrival comes from Azure Monitor IncomingMessages and is informational."
          : "The storage account the flow logs are written to as blobs. Event Grid puts a message on the queue for each new blob, and Cribl reads the queue to find them.",
      sharedId: sharedObj.id,
    };

    const route = routeStatus(inputId, criblSide);
    const criblSource: LaneCard = {
      id: ids.source,
      kind: "cribl-source",
      title: `Cribl source (${source.criblInputType})`,
      status: criblSourceStatus(record, inputId, criblSide),
      facts: [
        inputId === null ? "input id: <needs plan values>" : `input ${inputId}`,
        ...(record !== undefined ? [`worker group ${record.groupId}`] : []),
      ],
      info: `The Cribl ${source.criblInputType} source the app creates for this lane, behind a confirm. Its credential is kept in a Cribl secret, never in the source itself.`,
    };
    const routeCard: LaneCard = {
      id: ids.route,
      kind: "route",
      title: "Route",
      status: route.status,
      facts: route.route === null ? [] : [`route ${route.route}`],
      info: "The Cribl route that sends this source's events on. This screen reads routes; it does not write them.",
    };
    // Only inputs and routes are read (D17), never outputs, so a destination
    // the route names is "named by route", not "present": it may not exist.
    const destination: LaneCard = {
      id: ids.destination,
      kind: "destination",
      title: "Destination",
      status:
        route.destination !== null
          ? { kind: "named-by-route", label: `named by route ${route.route ?? "<unnamed>"}: ${route.destination}` }
          : route.status.kind === "consumes"
            ? { kind: "unknown", label: "cannot check: the route names no destination" }
            : { kind: "not-read", label: "not read" },
      facts: route.destination !== null ? [`destination ${route.destination}`] : [],
      info: "Where the route sends the events, such as the Microsoft Sentinel destination. This screen reads the route that names it, not the destination itself, so it does not confirm the destination exists.",
    };

    const cards: LaneCard[] = [];
    const edges: LaneEdge[] = [];

    if (perspective === "azure") {
      const criblFolded: LaneCard = {
        id: ids.criblFolded,
        kind: "cribl-folded",
        title: "Cribl Stream",
        status: criblSource.status,
        facts: criblSource.facts,
        info: "Cribl Stream, folded. Switch to the Cribl side to see the source, route and destination.",
      };
      cards.push(emitter, transport);
      for (const step of steps) {
        const stepVerdicts = verdictsOf(verdicts, sid, step, () => true);
        const tick = mode === "manual" ? tickState(progress, step.id, step.dependsOnValues) : null;
        const card: LaneCard = {
          id: `${sid}:step:${step.id}`,
          kind: "step",
          title: step.title,
          status: step.checkKinds.length === 0 ? NO_CHECK : groupStatus(stepVerdicts, step.checkKinds.length),
          facts: tick === null ? [] : [tickText(tick)],
          info: step.why,
          stepId: step.id,
          tick,
          ...(tick === null ? {} : { tickLabel: tickText(tick) }),
        };
        cards.push(card);
        const target = stepTarget(source.transport, step) === "transport" ? ids.transport : ids.emitter;
        edges.push({
          id: `${card.id}->${target}`,
          from: card.id,
          to: target,
          kind: "configures",
          flow: NO_COUNTER,
          animated: false,
        });
      }
      cards.push(criblFolded);
      edges.push(dataEdge(ids.emitter, ids.transport), measuredEdge(ids.transport, ids.criblFolded, flowState));
    } else if (perspective === "cribl") {
      const azureFolded: LaneCard = {
        id: ids.azureFolded,
        kind: "azure-folded",
        title: "Azure",
        status: allCheckCount === 0 ? NO_CHECK : groupStatus(allVerdicts, allCheckCount),
        facts: [source.title, transportFacts[0]],
        info: "The Azure side, folded, with the worst Validate verdict across its checks. Switch to the Azure side to see each object.",
      };
      cards.push(azureFolded, criblSource, routeCard, destination);
      edges.push(
        measuredEdge(ids.azureFolded, ids.source, flowState),
        dataEdge(ids.source, ids.route),
        dataEdge(ids.route, ids.destination),
      );
    } else {
      cards.push(emitter, transport, criblSource, routeCard, destination);
      edges.push(
        dataEdge(ids.emitter, ids.transport),
        measuredEdge(ids.transport, ids.source, flowState),
        dataEdge(ids.source, ids.route),
        dataEdge(ids.route, ids.destination),
      );
    }

    return {
      sourceId: sid,
      title: source.title,
      mode,
      transport: source.transport,
      criblInputType: source.criblInputType,
      inputId,
      flow: flowState,
      cards,
      edges,
    };
  }

  return { lanes, shared };
}
