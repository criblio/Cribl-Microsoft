/**
 * Validate panel state - PURE (AZR-32, ADR 0007 D16).
 *
 * What the "Check the Azure configuration" panel says before, during and after
 * a READ-ONLY Validate run. The run itself is core's validateAzureOnboarding;
 * this module only turns its plan and result into words, and holds the run
 * reducer the panel drives.
 *
 * HONESTY (claude-kit standards/inventory-honesty.md): a verdict that could not
 * be reached is "could not be read" (or "not checked" when a plan value is
 * missing), never "not found" or "absent" - only core's `absent` verdict, a
 * GET-by-name 404 or a complete listing without the item, may say "not found".
 * An arrival reading of a measured zero is "no messages in the window", a real
 * answer, and is kept apart from an arrival that could not be read.
 *
 * No React, no IO, no clock: the panel passes the "as of" time in.
 */

import { onboardingSource } from "@soc/core";
import type {
  ArrivalReading,
  CheckKind,
  CheckResult,
  OnboardingSourceId,
  StepVerdict,
  UnknownReason,
  ValidationPlan,
  ValidationResult,
  VerdictDiff,
} from "@soc/core";

/** The Validate pace the screen wraps the Azure port with (D16). */
export const VALIDATE_REQUESTS_PER_MINUTE = 40;

// ---------------------------------------------------------------------------
// Intro and gating
// ---------------------------------------------------------------------------

type IntroPlan = Pick<ValidationPlan, "firstPageReads" | "listReads" | "maxReads" | "missing">;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The sentence above the Validate button, stated BEFORE the run: how many
 * reads, at what pace, and that nothing changes. A paged listing can read more
 * than its first page, so the bound is stated as well whenever one exists.
 */
export function validateIntro(plan: IntroPlan): string {
  const reads = plural(plan.firstPageReads, "Azure resource", "Azure resources");
  const paged =
    plan.listReads > 0 && plan.maxReads > plan.firstPageReads
      ? ` (more if a list is paged, never more than ${plan.maxReads} requests)`
      : "";
  const base = `Validate reads ${reads}${paged} at most ${VALIDATE_REQUESTS_PER_MINUTE} a minute. Nothing is changed.`;
  if (plan.missing.length === 0) return base;
  return `${base} ${plural(plan.missing.length, "plan value is", "plan values are")} not filled in, so the checks that need ${plan.missing.length === 1 ? "it" : "them"} are skipped: ${plan.missing.join(", ")}.`;
}

/** Why the Validate button is disabled, or null when it can run. */
export function validateDisabledReason(args: {
  readonly hasPacing: boolean;
  readonly running: boolean;
  readonly plan: IntroPlan | null;
}): string | null {
  if (!args.hasPacing) {
    return "Validate is unavailable: pacing unavailable, and it never runs unpaced.";
  }
  if (args.running) return "Validate is already running.";
  if (args.plan === null) return "Choose at least one source to validate.";
  if (args.plan.firstPageReads === 0) {
    return "There is nothing to read yet: fill in the plan values the steps need.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type VerdictTone = "ok" | "warning" | "error" | "unknown";

export interface VerdictView {
  /** The state word, always shown beside the colour. */
  readonly word: string;
  readonly tone: VerdictTone;
  /** A sentence of detail, '' when the word says it all. */
  readonly detail: string;
  /** The field-by-field differences, empty unless the object differs. */
  readonly diffs: readonly VerdictDiff[];
}

const UNKNOWN_WORD: Readonly<Record<UnknownReason, string>> = {
  denied: "could not be read",
  failed: "could not be read",
  truncated: "could not be read",
  unregistered: "could not be read",
  unmeasurable: "cannot be checked from Azure",
  "missing-value": "not checked",
};

const UNKNOWN_DETAIL: Readonly<Record<UnknownReason, string>> = {
  denied: "Azure refused the read: the app's identity lacks permission to see it.",
  failed: "The read did not complete.",
  truncated: "The list was not read to the end, so the item may be on a later page.",
  unregistered: "The resource provider is not registered on the subscription.",
  unmeasurable: "Azure exposes nothing this app can read for this; confirm it in the portal.",
  "missing-value": "A plan value this check needs is not filled in, so nothing was sent.",
};

/**
 * What an other-name object IS, per check kind - only what that kind's
 * classifier matched it on, so each is true (DBT-178: one sentence for all
 * said "targets the plan's hub", false for the policy checks). A Defender
 * export or Entra setting matches on the namespace (an export may target
 * another hub in it); an assignment on the initiative OR the legacy name
 * family; a remediation only on the family, with a name instructed.
 */
const OTHER_NAME_DETAIL: Partial<Record<CheckKind, (name: string) => string>> = {
  "defender-export": (n) => `Found as ${n}, a continuous export that sends to the plan's Event Hub namespace.`,
  "entra-setting": (n) => `Found as ${n}, a diagnostic setting that sends to the plan's Event Hub namespace.`,
  "policy-assignment": (n) =>
    `Found as ${n}, a policy assignment that uses the plan's initiative or is named like its assignments.`,
  "policy-remediation": (n) =>
    `Found remediations of ${n}, an assignment named like the plan's but not the one the steps name.`,
};

function otherNameDetail(kind: CheckKind | undefined, name: string, alsoFound: number): string {
  const worded = kind === undefined ? undefined : OTHER_NAME_DETAIL[kind];
  // Without a kind's own words, claim nothing beyond the name.
  const what = worded?.(name) ?? `Found as ${name}, a name the plan does not use.`;
  if (alsoFound <= 0) return what;
  return `${what} ${plural(alsoFound, "other like it was", "others like it were")} also found.`;
}

/** One verdict, in words. `kind` is the check's, which words an other-name verdict. */
export function verdictView(verdict: StepVerdict, kind?: CheckKind): VerdictView {
  switch (verdict.kind) {
    case "as-expected":
      return { word: "as expected", tone: "ok", detail: "", diffs: [] };
    case "present-differs":
      return {
        word: "present but different",
        tone: "warning",
        detail: `${plural(verdict.diffs.length, "setting differs", "settings differ")} from the plan.`,
        diffs: verdict.diffs,
      };
    case "present-other-name":
      return {
        word: "present under another name",
        tone: "warning",
        detail: otherNameDetail(kind, verdict.name, verdict.alsoFound ?? 0),
        diffs: verdict.diffs,
      };
    case "absent":
      return { word: "not found", tone: "error", detail: "", diffs: [] };
    case "unknown": {
      const extra = verdict.detail.trim() === "" ? "" : ` ${verdict.detail.trim()}`;
      return {
        word: UNKNOWN_WORD[verdict.reason],
        tone: "unknown",
        detail: `${UNKNOWN_DETAIL[verdict.reason]}${extra}`,
        diffs: [],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Arrival
// ---------------------------------------------------------------------------

export interface ArrivalView {
  readonly text: string;
  readonly tone: VerdictTone;
  /** True only when Azure answered (a measured zero included). */
  readonly measured: boolean;
}

const ARRIVAL_REASON: Readonly<Record<UnknownReason, string>> = {
  denied: "no permission",
  failed: "the read did not complete",
  truncated: "the answer was incomplete",
  unregistered: "the metrics provider is not registered",
  unmeasurable: "Azure exposes no metric for it",
  "missing-value": "a plan value is missing",
};

/** One hub's IncomingMessages reading. A measured 0 is a real answer. */
export function arrivalView(hub: string, reading: ArrivalReading): ArrivalView {
  if (reading.kind === "measured") {
    if (reading.messages === 0) {
      return { text: `${hub}: no messages in the window`, tone: "warning", measured: true };
    }
    return {
      text: `${hub}: ${plural(reading.messages, "message", "messages")} in the window`,
      tone: "ok",
      measured: true,
    };
  }
  const extra = reading.detail.trim() === "" ? "" : ` (${reading.detail.trim()})`;
  return {
    text: `${hub}: arrival could not be read: ${ARRIVAL_REASON[reading.reason]}${extra}`,
    tone: "unknown",
    measured: false,
  };
}

// ---------------------------------------------------------------------------
// Results grouped by source
// ---------------------------------------------------------------------------

export interface VerdictRow {
  readonly key: string;
  readonly stepId: string;
  readonly kind: CheckResult["kind"];
  readonly view: VerdictView;
}

export interface SourceVerdictGroup {
  readonly sourceId: OnboardingSourceId;
  readonly title: string;
  readonly rows: readonly VerdictRow[];
}

/** The result's checks grouped by source, in the order the plan ran them. */
export function verdictGroups(result: Pick<ValidationResult, "checks">): SourceVerdictGroup[] {
  const groups = new Map<OnboardingSourceId, VerdictRow[]>();
  for (const c of result.checks) {
    const rows = groups.get(c.sourceId) ?? [];
    rows.push({ key: c.key, stepId: c.stepId, kind: c.kind, view: verdictView(c.verdict, c.kind) });
    groups.set(c.sourceId, rows);
  }
  return [...groups].map(([sourceId, rows]) => ({
    sourceId,
    title: onboardingSource(sourceId)?.title ?? sourceId,
    rows,
  }));
}

// ---------------------------------------------------------------------------
// Run reducer
// ---------------------------------------------------------------------------

export type ValidateRunState =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly runId: number; readonly done: number; readonly total: number }
  | { readonly kind: "done"; readonly result: ValidationResult; readonly asOf: string }
  | { readonly kind: "failed"; readonly message: string };

export type ValidateRunAction =
  | { readonly type: "start"; readonly runId: number; readonly total: number }
  | { readonly type: "progress"; readonly runId: number; readonly done: number; readonly total: number }
  | { readonly type: "finish"; readonly runId: number; readonly result: ValidationResult; readonly asOf: string }
  | { readonly type: "fail"; readonly runId: number; readonly message: string }
  | { readonly type: "reset" };

export const VALIDATE_IDLE: ValidateRunState = { kind: "idle" };

/**
 * The run's state. Every run carries the runId its 'start' gave it, and
 * progress, finish and fail apply only to the running run with that SAME id:
 * a late callback from a cancelled run, or from a run that was reset and
 * replaced by a newer one, cannot overwrite the newer state. The caller bumps
 * the id per start. A cancelled run still finishes (core marks the rest
 * unknown).
 */
export function validateRunReducer(state: ValidateRunState, action: ValidateRunAction): ValidateRunState {
  switch (action.type) {
    case "start":
      return { kind: "running", runId: action.runId, done: 0, total: action.total };
    case "progress":
      if (state.kind !== "running" || state.runId !== action.runId) return state;
      return { kind: "running", runId: state.runId, done: action.done, total: action.total };
    case "finish":
      if (state.kind !== "running" || state.runId !== action.runId) return state;
      return { kind: "done", result: action.result, asOf: action.asOf };
    case "fail":
      if (state.kind !== "running" || state.runId !== action.runId) return state;
      return { kind: "failed", message: action.message };
    case "reset":
      return VALIDATE_IDLE;
  }
}

/** The line under the button while and after a run. */
export function runStatusText(state: ValidateRunState): string {
  switch (state.kind) {
    case "idle":
      return "Not checked yet.";
    case "running":
      return `Reading ${state.done} of ${state.total}...`;
    case "done":
      return state.result.cancelled
        ? `Cancelled as of ${state.asOf}: the checks not reached could not be read.`
        : `Checked as of ${state.asOf}.`;
    case "failed":
      return `Validate stopped: ${state.message}`;
  }
}
