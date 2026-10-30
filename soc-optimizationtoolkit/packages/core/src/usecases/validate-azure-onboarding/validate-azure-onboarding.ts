/**
 * Validate the Azure side of an onboarding plan - READ-ONLY BY CONSTRUCTION.
 *
 * AZR-32 (ADR 0007, D16). An operator who followed the How-to steps, or let
 * the app automate them, asks "is Azure set up the way the plan says?". This
 * usecase answers with one verdict per (source, step, check) and one arrival
 * reading per expected hub, and changes nothing:
 *
 * - every request comes from `requestsFor` / `arrivalRequestFor`
 *   (domain/onboarding-validation), which build GETs only; a request that is
 *   not a GET is REFUSED HERE before it is sent (unknown `failed`), so a
 *   future builder slip cannot become a write;
 * - it never calls listKeys (ADR 0005: a key is not evidence of
 *   configuration);
 * - lists are read with `readAllPages` and single resources with
 *   `readSingle` - the logging map's verdict pager (usecases/read-logging-map/
 *   arm-pager.ts). No third pager is written here: a refused or truncated read
 *   reaches the classifier as a refusal, never as zero rows;
 * - reads are DEDUPED across sources: three Event Hub sources on one
 *   namespace read that namespace once.
 *
 * PACING IS THE CALLER'S. The screen passes an Azure port already wrapped
 * with `paceAzureManagement` (40 requests a minute, per run). Core reads no
 * clock; nothing here sleeps.
 *
 * HONESTY (claude-kit standards/inventory-honesty.md):
 * - `measuredHubs` holds hub names ONLY from a COMPLETE hub listing; a denied,
 *   truncated or nameless-row listing leaves it null, and D9 then refuses to
 *   create a Cribl input from guesses. An empty array is a complete listing
 *   of a namespace with no hubs (AZR-50);
 * - a run cancelled through `signal` leaves every check it had not finished
 *   unknown `failed` with detail "cancelled" - never absent;
 * - arrival is an ArrivalReading (a measured 0 is "no messages in the
 *   window"), never a verdict. It is `no-hub` only when the run's COMPLETE
 *   hub listing lacks the hub (AZR-47: Azure Monitor reports a zero series
 *   for a hub that does not exist); with a refused or truncated listing the
 *   metric reading stands.
 *
 * Usecase layer: may import usecases (the pager); performs IO only through
 * the AzureManagement port.
 */

import type {
  AzureManagement,
  AzureManagementRequest,
} from "../../ports/azure-management";
import type { ListRead } from "../../domain/logging-map/list-read";
import type {
  ArrivalReading,
  CheckKind,
  StepVerdict,
} from "../../domain/onboarding-howto/check-kinds";
import type { PlanValueKey, PlanValues } from "../../domain/onboarding-howto/plan-values";
import {
  onboardingSource,
  type OnboardingSourceId,
} from "../../domain/onboarding-howto/sources";
import { stepsFor } from "../../domain/onboarding-howto-steps/steps";
import {
  arrivalRequestFor,
  checkExpectationsFor,
  requestsFor,
  type CheckExpectations,
  type CheckReadShape,
} from "../../domain/onboarding-validation/requests";
import {
  classifyCheck,
  classifyHubArrival,
  measuredHubNames,
} from "../../domain/onboarding-validation/classify";
import { readAllPages, readSingle, describeRequest } from "../read-logging-map";
import { MAX_LIST_PAGES } from "../azure-discovery";

/** One source to validate, with its sub-selection (e.g. the Entra profile). */
export interface ValidationSource {
  readonly id: OnboardingSourceId;
  readonly subSelection?: readonly string[];
}

/** One GET Validate will send, after de-duplication across checks. */
export interface PlannedRead {
  /** Dedupe key: shape, method and the request as a greppable string. */
  readonly key: string;
  readonly request: AzureManagementRequest;
  readonly shape: CheckReadShape;
  readonly context: string;
}

/** One (source, step, check kind) Validate reaches a verdict on. */
export interface PlannedCheck {
  /** {@link checkKey} of source, step and kind. */
  readonly key: string;
  readonly sourceId: OnboardingSourceId;
  readonly stepId: string;
  readonly kind: CheckKind;
  readonly expectations: CheckExpectations;
  /** The reads it is classified from, in request order. Empty when missing or nothing to read. */
  readonly readKeys: readonly string[];
  /** Plan values the check needs and does not have; nothing is sent for it. */
  readonly missing: readonly PlanValueKey[];
}

/** One hub's IncomingMessages read. */
export interface PlannedArrival {
  readonly hub: string;
  readonly read: PlannedRead;
  readonly window: string;
}

/** Everything a Validate run will do, computed before it sends anything. */
export interface ValidationPlan {
  readonly values: PlanValues;
  /** De-duplicated configuration reads, in first-use order. */
  readonly requests: readonly PlannedRead[];
  readonly checks: readonly PlannedCheck[];
  /** `${sourceId}/${stepId}` -> the check keys of that step for that source. */
  readonly perStep: Readonly<Record<string, readonly string[]>>;
  /** The hubs whose arrival is read: the named or known auto-created ones. */
  readonly arrivalHubs: readonly string[];
  readonly arrival: readonly PlannedArrival[];
  /** Every plan value some check is missing, in PLAN_VALUE_KEYS order of first sight. */
  readonly missing: readonly PlanValueKey[];
  /**
   * The planned reads: one request per entry of `requests` plus one per
   * `arrival`. This is the FIRST PAGE of each listing only - it is the exact
   * count when no listing is paged, and the floor otherwise. `onProgress`
   * counts against it.
   */
  readonly firstPageReads: number;
  /** How many of `requests` are listings, each of which may read further pages. */
  readonly listReads: number;
  /**
   * The honest upper bound on requests the run can send: every first page,
   * plus up to MAX_LIST_PAGES - 1 further pages per listing (readAllPages
   * reads at most MAX_LIST_PAGES pages in total per listing). The intro states
   * this bound, and "more if a list is paged" whenever `listReads` > 0.
   */
  readonly maxReads: number;
}

/** Options for {@link planValidation}. */
export interface PlanValidationOptions {
  /**
   * "{startISO}/{endISO}" for the arrival reads, minted by a caller that has
   * a clock. Without it Azure's default window applies (DEFAULT_ARRIVAL_WINDOW).
   */
  readonly arrivalTimespan?: string;
}

/** The key of one check: source, step and kind. */
export function checkKey(sourceId: OnboardingSourceId, stepId: string, kind: CheckKind): string {
  return `${sourceId}/${stepId}/${kind}`;
}

/** The key of one step of one source in {@link ValidationPlan.perStep}. */
export function stepKey(sourceId: OnboardingSourceId, stepId: string): string {
  return `${sourceId}/${stepId}`;
}

function readKeyOf(request: AzureManagementRequest, shape: CheckReadShape): string {
  return `${shape} ${request.method} ${describeRequest(request)}`;
}

function normalizeSources(
  sources: readonly (OnboardingSourceId | ValidationSource)[],
): ValidationSource[] {
  const seen = new Set<string>();
  const out: ValidationSource[] = [];
  for (const s of sources) {
    const source: ValidationSource = typeof s === "string" ? { id: s } : s;
    if (seen.has(source.id) || onboardingSource(source.id) === undefined) continue;
    seen.add(source.id);
    out.push(source);
  }
  return out;
}

/**
 * Plan a Validate run: which checks, which GETs (deduped), which arrival
 * reads, which plan values are missing, and how many requests it sends:
 * exactly per first page, and at most `maxReads` once listings page. Pure.
 */
export function planValidation(
  sources: readonly (OnboardingSourceId | ValidationSource)[],
  values: PlanValues,
  options: PlanValidationOptions = {},
): ValidationPlan {
  const requests: PlannedRead[] = [];
  const byKey = new Map<string, PlannedRead>();
  const checks: PlannedCheck[] = [];
  const perStep: Record<string, string[]> = {};
  const missing: PlanValueKey[] = [];
  const arrivalHubs: string[] = [];

  const addRead = (request: AzureManagementRequest, shape: CheckReadShape, context: string): string => {
    const key = readKeyOf(request, shape);
    if (!byKey.has(key)) {
      const read: PlannedRead = { key, request, shape, context };
      byKey.set(key, read);
      requests.push(read);
    }
    return key;
  };

  for (const source of normalizeSources(sources)) {
    const subSelection = source.subSelection ?? [];
    const expectations = checkExpectationsFor(source.id, values, subSelection);
    for (const step of stepsFor(source.id, subSelection)) {
      const keys: string[] = [];
      for (const kind of step.checkKinds) {
        const planned = requestsFor(kind, values, expectations);
        const key = checkKey(source.id, step.id, kind);
        keys.push(key);
        if (planned.kind === "missing") {
          for (const m of planned.missing) if (!missing.includes(m)) missing.push(m);
          checks.push({
            key,
            sourceId: source.id,
            stepId: step.id,
            kind,
            expectations,
            readKeys: [],
            missing: planned.missing,
          });
          continue;
        }
        checks.push({
          key,
          sourceId: source.id,
          stepId: step.id,
          kind,
          expectations,
          readKeys: planned.requests.map((r) => addRead(r.request, r.shape, r.context)),
          missing: [],
        });
      }
      perStep[stepKey(source.id, step.id)] = keys;
    }
    const descriptor = onboardingSource(source.id);
    if (descriptor?.transport === "eventhub") {
      for (const hub of descriptor.expectedHubNames(values, subSelection)) {
        if (!arrivalHubs.includes(hub)) arrivalHubs.push(hub);
      }
    }
  }

  const arrival: PlannedArrival[] = [];
  for (const hub of arrivalHubs) {
    const built = arrivalRequestFor(values, hub, options.arrivalTimespan);
    if (built.kind === "missing") {
      for (const m of built.missing) if (!missing.includes(m)) missing.push(m);
      continue;
    }
    const read: PlannedRead = {
      key: readKeyOf(built.request, "single"),
      request: built.request,
      shape: "single",
      context: `messages arriving at ${hub}`,
    };
    arrival.push({ hub, read, window: built.window });
  }

  const firstPageReads = requests.length + arrival.length;
  const listReads = requests.filter((r) => r.shape === "list").length;

  return {
    values,
    requests,
    checks,
    perStep,
    arrivalHubs,
    arrival,
    missing,
    firstPageReads,
    listReads,
    maxReads: firstPageReads + listReads * (MAX_LIST_PAGES - 1),
  };
}

/** Anything with an `aborted` flag; an AbortSignal satisfies it. */
export interface ValidationSignal {
  readonly aborted: boolean;
}

/** Options for {@link validateAzureOnboarding}. */
export interface ValidateOptions {
  readonly signal?: ValidationSignal;
  /** Called after each planned read with how many of `plan.firstPageReads` are done (further pages of a listing are not counted separately). */
  readonly onProgress?: (done: number, total: number) => void;
}

/** One check's result. */
export interface CheckResult {
  readonly key: string;
  readonly sourceId: OnboardingSourceId;
  readonly stepId: string;
  readonly kind: CheckKind;
  readonly verdict: StepVerdict;
}

/** What a Validate run found. */
export interface ValidationResult {
  /** Check key ({@link checkKey}) -> verdict. */
  readonly verdicts: Readonly<Record<string, StepVerdict>>;
  /** The same verdicts, in plan order, with their source, step and kind. */
  readonly checks: readonly CheckResult[];
  /**
   * Hub names from a COMPLETE hub listing only (measuredHubNames). Null when
   * the listing was denied, truncated, failed, cancelled, never asked for, or
   * held a row whose name could not be read; an empty array is a complete
   * listing of a namespace with no hubs.
   */
  readonly measuredHubs: readonly string[] | null;
  /** Hub -> arrival reading. A planned hub that was not read is unknown. */
  readonly arrival: Readonly<Record<string, ArrivalReading>>;
  /** True when the run stopped early because the signal aborted. */
  readonly cancelled: boolean;
}

/** The detail every check left unfinished by a cancelled run carries. */
export const CANCELLED_DETAIL = "cancelled";

const CANCELLED: StepVerdict = { kind: "unknown", reason: "failed", detail: CANCELLED_DETAIL };
const CANCELLED_ARRIVAL: ArrivalReading = {
  kind: "unknown",
  reason: "failed",
  detail: CANCELLED_DETAIL,
};

function notGet(read: PlannedRead): ListRead<unknown> {
  return {
    state: "refused",
    refusal: {
      request: describeRequest(read.request),
      status: null,
      code: "",
      text: `${read.context}: refused to send a ${read.request.method}; Validate sends GETs only`,
      reason: "transport",
    },
  };
}

async function perform(azure: AzureManagement, read: PlannedRead): Promise<ListRead<unknown>> {
  if (read.request.method !== "GET") return notGet(read);
  return read.shape === "list"
    ? readAllPages(azure, read.request, read.context)
    : readSingle(azure, read.request, read.context);
}

/**
 * The hub names of the run's COMPLETE hub listing (the eh-hub check's read of
 * the plan's one namespace), or null when no eh-hub check read one to the end:
 * denied, truncated, failed, cancelled, or not planned for want of a value.
 * measuredHubNames holds the completeness rule, including the nameless row.
 */
function completeHubListing(
  plan: ValidationPlan,
  reads: ReadonlyMap<string, ListRead<unknown>>,
): readonly string[] | null {
  for (const check of plan.checks) {
    if (check.kind !== "eh-hub") continue;
    for (const key of check.readKeys) {
      const read = reads.get(key);
      const names = read === undefined ? null : measuredHubNames(read);
      if (names !== null) return names;
    }
  }
  return null;
}

/**
 * Run a planned Validate. Sequential reads (the caller's paced port spaces
 * them), deduped, GET only. Never throws on an Azure failure: each one is a
 * refusal the classifier turns into unknown with its reason.
 */
export async function validateAzureOnboarding(
  azure: AzureManagement,
  plan: ValidationPlan,
  options: ValidateOptions = {},
): Promise<ValidationResult> {
  const { signal, onProgress } = options;
  const reads = new Map<string, ListRead<unknown>>();
  let done = 0;
  let cancelled = false;

  for (const read of plan.requests) {
    if (signal?.aborted === true) {
      cancelled = true;
      break;
    }
    reads.set(read.key, await perform(azure, read));
    done += 1;
    onProgress?.(done, plan.firstPageReads);
  }

  const listedHubs = completeHubListing(plan, reads);
  const arrival: Record<string, ArrivalReading> = {};
  for (const planned of plan.arrival) {
    if (cancelled || signal?.aborted === true) {
      cancelled = true;
      arrival[planned.hub] = CANCELLED_ARRIVAL;
      continue;
    }
    arrival[planned.hub] = classifyHubArrival(
      planned.hub,
      await perform(azure, planned.read),
      listedHubs,
      planned.window,
    );
    done += 1;
    onProgress?.(done, plan.firstPageReads);
  }

  const verdicts: Record<string, StepVerdict> = {};
  const checks: CheckResult[] = [];
  for (const check of plan.checks) {
    const checkReads = check.readKeys.map((k) => reads.get(k));
    let verdict: StepVerdict;
    if (check.missing.length > 0) {
      verdict = classifyCheck(check.kind, plan.values, [], check.expectations);
    } else if (checkReads.some((r) => r === undefined)) {
      verdict = CANCELLED;
    } else {
      const complete = checkReads as ListRead<unknown>[];
      verdict = classifyCheck(check.kind, plan.values, complete, check.expectations);
    }
    verdicts[check.key] = verdict;
    checks.push({
      key: check.key,
      sourceId: check.sourceId,
      stepId: check.stepId,
      kind: check.kind,
      verdict,
    });
  }

  return { verdicts, checks, measuredHubs: listedHubs, arrival, cancelled };
}

/**
 * The verdicts of one step: of one source when `sourceId` is given, otherwise
 * of every source that shares the step (a shared step shown once rolls up the
 * worst with aggregateVerdict).
 */
export function verdictsForStep(
  result: ValidationResult,
  stepId: string,
  sourceId?: OnboardingSourceId,
): readonly StepVerdict[] {
  return result.checks
    .filter((c) => c.stepId === stepId && (sourceId === undefined || c.sourceId === sourceId))
    .map((c) => c.verdict);
}
