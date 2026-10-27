/**
 * How-to state - the PURE decisions behind the "How to set it up yourself"
 * part of Azure Native Source Onboarding (AZR-31), kept out of the components
 * so each is unit-testable without a DOM. The How-to panel (howto-panel.tsx)
 * and the screen are thin composers over these:
 *
 *   - {@link progressLoadStateFrom} / {@link canWriteProgress}: what the KV
 *     read of the PROGRESS document (`azure-onboarding-progress`, ADR 0007 D1)
 *     means, and when a tick, a mode change or a choice may be written. It
 *     mirrors the AZR-18 selection gate (azure-onboarding-state.ts
 *     loadStateFrom/canSave): only an `absent` load or a readable document of
 *     ours may be overwritten, so a FAILED read is never treated as a first run
 *     (claude-kit standards/cribl-kv-store.md). Every transition below returns
 *     null while writes are blocked, so the panel cannot write by mistake.
 *   - {@link progressBanners}: what the load has to say out loud.
 *   - {@link chooserRows}: one row per onboarding source with its mode. WHAT
 *     "CHOSEN" MEANS DEPENDS ON THE MODE (D2): an Automated source is chosen
 *     when the AZR-18 selection has it enabled; a How-to source is chosen when
 *     the progress document says so. Only a source where core's isAutomatable
 *     is true may be Automated - the toggle is LOCKED otherwise, with the reason
 *     as visible text. isAutomatable is asked every time, never copied.
 *   - {@link stepRows} / {@link progressSummary}: the guided steps the chosen
 *     How-to sources need (core stepsForSelection: shared steps once), each
 *     with its done state. A tick taken against values that have since changed
 *     is STALE (D5): it names the changed values and does NOT count as done.
 *   - {@link stepDialogView}: one step rendered against the plan values, unset
 *     values shown as `<key>` stand-ins (core renderStep), never as gaps.
 *   - {@link toggleTick} / {@link setMode} / {@link setChosen} /
 *     {@link applyPlanValues}: the transitions, over core's pure with* helpers.
 *
 * VISIBLE COPY. Every string returned here reaches the screen, so none carries
 * a card id, a date or a phase number; the test runs findHistoryInCopy over
 * all of them.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto.
 */

import {
  ONBOARDING_SOURCES,
  PLAN_VALUE_LABELS,
  aggregateVerdict,
  canWriteProgressDocument,
  howToStep,
  isAutomatable,
  progressFrom,
  readProgressDocument,
  renderStep,
  stepsForSelection,
  tickState,
  verdictsForStep,
  withPlanValues,
  withSourceChosen,
  withSourceMode,
  withTick,
  withoutTick,
} from "@soc/core";
import type {
  CoverageSelection,
  CriblInputType,
  HowToStep,
  KvDocumentLoad,
  OnboardingProgress,
  OnboardingSourceId,
  OnboardingTransport,
  PlanValueKey,
  PlanValues,
  ProgressDocument,
  RenderedStep,
  SourceMode,
  StepProvenance,
  AggregateVerdict,
  StepVerdict,
  TickState,
  ValidationResult,
} from "@soc/core";
import { withItem } from "../azure-onboarding-state";

// ---------------------------------------------------------------------------
// Load gate
// ---------------------------------------------------------------------------

/**
 * What the progress document's KV read means. Six states, never collapsed:
 *
 *   loading         the read has not answered yet (the port's answer is null)
 *   absent          nothing of ours is stored; empty progress, writes allowed
 *   ready           a readable document of ours; writes allowed
 *   read-unknown    the read FAILED; the document may exist, writes blocked
 *   doc-foreign     the key holds something whose `kind` is not ours
 *   doc-unreadable  ours, but a `version` this release cannot read
 */
export type ProgressLoadState =
  | { readonly status: "loading" }
  | { readonly status: "absent"; readonly progress: OnboardingProgress }
  | {
      readonly status: "ready";
      readonly progress: OnboardingProgress;
      readonly dropped: readonly string[];
    }
  | { readonly status: "read-unknown"; readonly reason: string }
  | { readonly status: "doc-foreign"; readonly kind: unknown }
  | { readonly status: "doc-unreadable"; readonly version: unknown };

/** Turn the port's answer (null while it has not answered) into the load state. */
export function progressLoadStateFrom(load: KvDocumentLoad | null): ProgressLoadState {
  if (load === null) return { status: "loading" };
  const doc = readProgressDocument(load);
  switch (doc.status) {
    case "absent":
      return { status: "absent", progress: doc.progress };
    case "ok":
      return { status: "ready", progress: doc.decoded.progress, dropped: doc.decoded.dropped };
    case "foreign":
      return { status: "doc-foreign", kind: doc.kind };
    case "unreadable":
      return { status: "doc-unreadable", version: doc.version };
    case "read-unknown":
      return { status: "read-unknown", reason: doc.reason };
  }
}

/**
 * The core document this load state stands for, or null while `loading` (the
 * one state core has no word for). The gate below asks core rather than
 * restating which statuses may be written, so the rule lives in one place
 * (progress-document.ts canWriteProgressDocument / progressFrom).
 */
function progressDocumentOf(state: ProgressLoadState): ProgressDocument | null {
  switch (state.status) {
    case "loading":
      return null;
    case "absent":
      return { status: "absent", progress: state.progress };
    case "ready":
      return { status: "ok", decoded: { progress: state.progress, dropped: state.dropped } };
    case "doc-foreign":
      return { status: "foreign", kind: state.kind };
    case "doc-unreadable":
      return { status: "unreadable", version: state.version };
    case "read-unknown":
      return { status: "read-unknown", reason: state.reason };
  }
}

/** Whether a progress write is allowed: only after an `absent` or readable load. */
export function canWriteProgress(state: ProgressLoadState): boolean {
  const doc = progressDocumentOf(state);
  return doc !== null && canWriteProgressDocument(doc);
}

/** The progress to show and edit, or null when none was loaded. */
export function loadedProgress(state: ProgressLoadState): OnboardingProgress | null {
  const doc = progressDocumentOf(state);
  return doc === null ? null : progressFrom(doc);
}

/** A line the How-to panel renders above its steps. */
export interface HowToBanner {
  readonly tone: "info" | "warning" | "error";
  readonly text: string;
}

function describeValue(value: unknown): string {
  if (value === undefined) return "none";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const WRITES_OFF = "Ticking steps and choosing sources are turned off so progress that may exist is not overwritten.";

/** What the load has to say. Empty while loading and for a clean document. */
export function progressBanners(state: ProgressLoadState): HowToBanner[] {
  switch (state.status) {
    case "loading":
    case "absent":
      return [];
    case "read-unknown":
      return [
        {
          tone: "error",
          text: `Your saved How-to progress could not be read - ${state.reason}. ${WRITES_OFF} Reload to try again.`,
        },
      ];
    case "doc-foreign":
      return [
        {
          tone: "error",
          text: `The stored value under the progress key is not How-to progress (kind ${describeValue(state.kind)}). ${WRITES_OFF}`,
        },
      ];
    case "doc-unreadable":
      return [
        {
          tone: "error",
          text: `Your saved How-to progress was written in a format this version of the app cannot read (version ${describeValue(state.version)}). ${WRITES_OFF}`,
        },
      ];
    case "ready":
      return state.dropped.length === 0
        ? []
        : [
            {
              tone: "warning",
              text:
                "Some saved progress is no longer offered and was left out: " +
                `${state.dropped.join(", ")}. The next change saves progress without it.`,
            },
          ];
  }
}

// ---------------------------------------------------------------------------
// Chooser
// ---------------------------------------------------------------------------

/** The reason an Automated toggle is locked, as visible text. */
export const AUTOMATE_LOCKED_REASON =
  "The app cannot set this source up in Azure yet. Follow the How-to steps instead.";

/** Visible transport words. */
export const TRANSPORT_LABEL: Readonly<Record<OnboardingTransport, string>> = {
  eventhub: "Event Hub",
  blob: "Blob storage",
};

/**
 * A source's mode. A stored mode wins; with none stored, a source the app can
 * deploy starts Automated (the AZR-18 behaviour the screen already had) and
 * every other source starts How-to. Core's decode already coerces a stored
 * `automate` on a non-automatable source to `manual`; this re-checks anyway,
 * because isAutomatable is the authority, not the document.
 */
export function effectiveMode(progress: OnboardingProgress, id: OnboardingSourceId): SourceMode {
  const automatable = isAutomatable(id);
  const stored = progress.sources[id]?.mode;
  if (stored === undefined) return automatable ? "automate" : "manual";
  return stored === "automate" && automatable ? "automate" : "manual";
}

/**
 * Whether a source is chosen (D2): Automated sources by the AZR-18 selection,
 * How-to sources by the progress document. A null selection (not loaded, or
 * its read was refused) chooses no Automated source.
 */
export function isChosen(
  progress: OnboardingProgress,
  selection: CoverageSelection | null,
  id: OnboardingSourceId,
): boolean {
  if (effectiveMode(progress, id) === "automate") return selection?.enabled.includes(id) ?? false;
  return progress.sources[id]?.chosen === true;
}

/** Every chosen source, both modes combined, in ONBOARDING_SOURCES order. */
export function chosenSourceIds(
  progress: OnboardingProgress,
  selection: CoverageSelection | null,
): OnboardingSourceId[] {
  return ONBOARDING_SOURCES.map((s) => s.id).filter((id) => isChosen(progress, selection, id));
}

/** The chosen How-to sources only: the ones whose steps the panel lists. */
export function chosenManualIds(
  progress: OnboardingProgress,
  selection: CoverageSelection | null,
): OnboardingSourceId[] {
  return chosenSourceIds(progress, selection).filter(
    (id) => effectiveMode(progress, id) === "manual",
  );
}

/** One chooser row. */
export interface ChooserRow {
  readonly id: OnboardingSourceId;
  readonly title: string;
  readonly transport: OnboardingTransport;
  readonly transportLabel: string;
  readonly criblInputType: CriblInputType;
  readonly mode: SourceMode;
  readonly chosen: boolean;
  /** Where `chosen` is read from and written to (D2). */
  readonly chosenBy: "selection" | "progress";
  /** True when the Automate option cannot be picked. */
  readonly modeLocked: boolean;
  /** Visible text beside a locked toggle; null when unlocked. */
  readonly modeLockedReason: string | null;
  /** The (i) text. */
  readonly info: string;
}

function rowInfo(transport: OnboardingTransport, input: CriblInputType): string {
  return transport === "eventhub"
    ? `Azure writes these logs to an Event Hub; Cribl reads them with an ${input} source, which the app creates for you after you confirm.`
    : `Azure writes these logs as files to a storage account and posts a queue message for each one; Cribl reads them with an ${input} source, which the app creates for you after you confirm.`;
}

/** One row per onboarding source, in catalog order. */
export function chooserRows(
  progress: OnboardingProgress,
  selection: CoverageSelection | null,
): ChooserRow[] {
  return ONBOARDING_SOURCES.map((s): ChooserRow => {
    const mode = effectiveMode(progress, s.id);
    const locked = !isAutomatable(s.id);
    return {
      id: s.id,
      title: s.title,
      transport: s.transport,
      transportLabel: TRANSPORT_LABEL[s.transport],
      criblInputType: s.criblInputType,
      mode,
      chosen: isChosen(progress, selection, s.id),
      chosenBy: mode === "automate" ? "selection" : "progress",
      modeLocked: locked,
      modeLockedReason: locked ? AUTOMATE_LOCKED_REASON : null,
      info: rowInfo(s.transport, s.criblInputType),
    };
  });
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** The plan value labels, joined for a sentence. */
function labelsOf(keys: readonly PlanValueKey[]): string {
  return keys.map((k) => PLAN_VALUE_LABELS[k].label).join(", ");
}

/** The note a stale tick shows, naming the changed values; null otherwise. */
export function staleNote(tick: TickState): string | null {
  if (tick.status !== "stale") return null;
  return (
    `Done against older values - changed since: ${labelsOf(tick.changedKeys)}. ` +
    "Redo the step with the current values and tick it again."
  );
}

/** The tag an unconfirmed step carries. */
export const UNVERIFIED_TAG = "Not yet confirmed against live Azure";

/** What Validate last said about a step, as a word. */
export function stepVerdictWord(step: HowToStep, result: ValidationResult | null): string {
  if (step.checkKinds.length === 0) return "confirm by hand";
  if (result === null) return "not checked yet";
  const verdicts: readonly StepVerdict[] = verdictsForStep(result, step.id);
  if (verdicts.length === 0) return "not checked yet";
  const missingOnly = verdicts.every(
    (v) => v.kind === "unknown" && v.reason === "missing-value",
  );
  if (missingOnly) return "not checked: values missing";
  const aggregate = aggregateVerdict(verdicts);
  if (aggregate === "differs") {
    // present-other-name rolls up to `differs` with present-differs, but it
    // says something different - the object exists under a name the plan did
    // not use - so it keeps its own word and names the object.
    const other = verdicts.find((v) => v.kind === "present-other-name");
    if (other !== undefined && other.kind === "present-other-name") {
      return `${OTHER_NAME_WORD}: ${other.name}`;
    }
  }
  return AGGREGATE_VERDICT_WORD[aggregate];
}

/** The word for each rolled-up verdict. Pairwise distinct (pinned). */
export const AGGREGATE_VERDICT_WORD: Readonly<Record<AggregateVerdict, string>> = {
  "as-expected": "as expected",
  differs: "present but different",
  absent: "not found",
  unknown: "could not be read",
};

/** The word for a step whose object exists under another name (followed by the name). */
export const OTHER_NAME_WORD = "exists under another name";

/** One step row. */
export interface StepRow {
  readonly id: string;
  /** Rendered against the current plan values. */
  readonly title: string;
  /** The chosen sources that need this step. */
  readonly sourceTitles: readonly string[];
  readonly provenance: StepProvenance;
  /** Visible tag text for an inferred step; null otherwise. */
  readonly tag: string | null;
  readonly tick: TickState;
  /** Only a tick against the CURRENT values counts. */
  readonly done: boolean;
  readonly staleNote: string | null;
  readonly verdictWord: string;
  readonly missing: readonly PlanValueKey[];
  /** Whether the done checkbox is disabled, and why (visible text). */
  readonly tickDisabled: boolean;
  readonly tickDisabledReason: string | null;
  /** The (i) text. */
  readonly info: string;
}

/**
 * Why progress writes are off, by load state. A load that has not answered
 * yet is PENDING, not failed (claude-kit standards/inventory-honesty.md), so
 * it has its own words; only a read that answered badly says "could not".
 */
export const PROGRESS_LOADING_REASON = "Saved progress is still loading.";
export const PROGRESS_FAILED_REASON = "Saved progress could not be loaded, so ticks cannot be saved.";
/** Used when a caller blocks writes without passing the load's own reason. */
export const PROGRESS_BLOCKED_REASON = "Ticks cannot be saved right now.";

/** The visible reason writes are blocked for this load, or null when writes are allowed. */
export function progressBlockedReason(state: ProgressLoadState): string | null {
  switch (state.status) {
    case "absent":
    case "ready":
      return null;
    case "loading":
      return PROGRESS_LOADING_REASON;
    case "read-unknown":
    case "doc-foreign":
    case "doc-unreadable":
      return PROGRESS_FAILED_REASON;
  }
}

/** Options shared by the step views: whether ticks may be written, and why not. */
export interface StepViewOptions {
  readonly canWrite: boolean;
  /** Pass progressBlockedReason(load); without it a neutral reason is shown. */
  readonly blockedReason?: string | null;
}

function blockedText(opts: StepViewOptions): string | null {
  return opts.canWrite ? null : (opts.blockedReason ?? PROGRESS_BLOCKED_REASON);
}

function subSelectionFor(
  selection: CoverageSelection | null,
  ids: readonly OnboardingSourceId[],
): readonly string[] {
  for (const id of ids) {
    const sub = selection?.subSelections[id];
    if (sub !== undefined) return sub;
  }
  return [];
}

function titleOf(id: OnboardingSourceId): string {
  return ONBOARDING_SOURCES.find((s) => s.id === id)?.title ?? id;
}

/**
 * The step rows for every chosen How-to source: shared steps once, superseded
 * steps dropped (core stepsForSelection). Empty when no How-to source is
 * chosen. Ticks are read from `progress`; `canWrite` gates the checkbox.
 */
export function stepRows(
  progress: OnboardingProgress,
  selection: CoverageSelection | null,
  opts: StepViewOptions & { readonly result?: ValidationResult | null },
): StepRow[] {
  const manual = chosenManualIds(progress, selection);
  return stepsForSelection(manual).map((step): StepRow => {
    const forSources = manual.filter((id) => step.sourceIds.includes(id));
    const rendered = renderStep(step, progress.planValues, subSelectionFor(selection, forSources));
    const tick = tickState(progress, step.id, step.dependsOnValues);
    return {
      id: step.id,
      title: rendered.title,
      sourceTitles: forSources.map(titleOf),
      provenance: step.provenance,
      tag: rendered.unverified ? UNVERIFIED_TAG : null,
      tick,
      done: tick.status === "done",
      staleNote: staleNote(tick),
      verdictWord: stepVerdictWord(step, opts.result ?? null),
      missing: rendered.missing,
      tickDisabled: !opts.canWrite,
      tickDisabledReason: blockedText(opts),
      info: rendered.why,
    };
  });
}

/** The panel's one-line summary. */
export interface ProgressSummary {
  readonly total: number;
  readonly done: number;
  readonly stale: number;
  readonly text: string;
}

export function progressSummary(rows: readonly StepRow[]): ProgressSummary {
  const done = rows.filter((r) => r.done).length;
  const stale = rows.filter((r) => r.tick.status === "stale").length;
  const base =
    rows.length === 0
      ? "Choose a source to follow its steps."
      : `${done} of ${rows.length} steps done.`;
  const text =
    stale === 0
      ? base
      : `${base} ${stale} ${stale === 1 ? "step was" : "steps were"} done against older values and ${stale === 1 ? "does" : "do"} not count.`;
  return { total: rows.length, done, stale, text };
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

/** What the step dialog shows. */
export interface StepDialogView {
  readonly rendered: RenderedStep;
  readonly sourceTitles: readonly string[];
  readonly tick: TickState;
  readonly checked: boolean;
  readonly doneLabel: string;
  readonly staleNote: string | null;
  readonly tag: string | null;
  /** Visible note listing unset values; null when every value is set. */
  readonly missingNote: string | null;
  readonly tickDisabled: boolean;
  readonly tickDisabledReason: string | null;
}

/** The dialog for one step, or null for an id core does not know. */
export function stepDialogView(
  stepId: string,
  progress: OnboardingProgress,
  selection: CoverageSelection | null,
  opts: StepViewOptions,
): StepDialogView | null {
  const step = howToStep(stepId);
  if (step === undefined) return null;
  const forSources = chosenManualIds(progress, selection).filter((id) =>
    step.sourceIds.includes(id),
  );
  const rendered = renderStep(step, progress.planValues, subSelectionFor(selection, forSources));
  const tick = tickState(progress, step.id, step.dependsOnValues);
  return {
    rendered,
    sourceTitles: forSources.map(titleOf),
    tick,
    checked: tick.status === "done",
    doneLabel: "Mark as done",
    staleNote: staleNote(tick),
    tag: rendered.unverified ? UNVERIFIED_TAG : null,
    missingNote:
      rendered.missing.length === 0
        ? null
        : `Some values are not set yet and show as placeholders: ${labelsOf(rendered.missing)}. Fill them in the plan values and choose Apply.`,
    tickDisabled: !opts.canWrite,
    tickDisabledReason: blockedText(opts),
  };
}

// ---------------------------------------------------------------------------
// Transitions - each returns null while writes are blocked
// ---------------------------------------------------------------------------

/** Tick or untick a step against the current plan values. Null when blocked or unknown. */
export function toggleTick(
  state: ProgressLoadState,
  stepId: string,
  checked: boolean,
): OnboardingProgress | null {
  const progress = loadedProgress(state);
  if (progress === null || !canWriteProgress(state)) return null;
  const step = howToStep(stepId);
  if (step === undefined) return null;
  return checked ? withTick(progress, stepId, step.dependsOnValues) : withoutTick(progress, stepId);
}

/**
 * What a mode change produces. `progress` is written at once (D3).
 * `selection`, when not null, is the AZR-18 selection with the source's
 * choice carried over, for the screen to STAGE behind its explicit Save
 * (ADR 0005) - the same way setChosen hands back a selection. `notice` is
 * visible text when the choice could not be carried over.
 */
export interface ModeChange {
  readonly progress: OnboardingProgress;
  readonly selection: CoverageSelection | null;
  readonly notice: string | null;
}

/** Shown when a source moves to Automated but the saved selection was not loaded. */
export const MODE_CHOICE_NOT_CARRIED =
  "The saved selection could not be loaded, so this source's choice was not carried over. It now follows the saved selection.";

/**
 * Change a source's mode. Null when writes are blocked, or when `automate` is
 * asked of a source the app cannot deploy (refused, not silently coerced).
 * The row's chosen state is carried across in BOTH directions: to How-to it
 * goes into the progress document; to Automated it comes back as a staged
 * selection (withItem), so a chosen How-to source does not silently drop out.
 */
export function setMode(
  state: ProgressLoadState,
  selection: CoverageSelection | null,
  id: OnboardingSourceId,
  mode: SourceMode,
): ModeChange | null {
  const progress = loadedProgress(state);
  if (progress === null || !canWriteProgress(state)) return null;
  if (mode === "automate" && !isAutomatable(id)) return null;
  const wasChosen = isChosen(progress, selection, id);
  const moded = withSourceMode(progress, id, mode);
  if (mode === "manual") {
    return { progress: withSourceChosen(moded, id, wasChosen), selection: null, notice: null };
  }
  if (selection === null) {
    return { progress: moded, selection: null, notice: wasChosen ? MODE_CHOICE_NOT_CARRIED : null };
  }
  return { progress: moded, selection: withItem(selection, id, wasChosen), notice: null };
}

/** Where a choose click lands (D2). */
export type ChooseResult =
  | { readonly kind: "progress"; readonly progress: OnboardingProgress }
  | { readonly kind: "selection"; readonly selection: CoverageSelection }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Choose or unchoose a source. A How-to source is written to the progress
 * document; an Automated source is the AZR-18 selection's tick, returned for
 * the screen's explicit Save and never written to progress.
 */
export function setChosen(
  state: ProgressLoadState,
  selection: CoverageSelection | null,
  id: OnboardingSourceId,
  chosen: boolean,
): ChooseResult {
  const progress = loadedProgress(state);
  if (progress === null || !canWriteProgress(state)) {
    return { kind: "blocked", reason: progressBlockedReason(state) ?? PROGRESS_BLOCKED_REASON };
  }
  if (effectiveMode(progress, id) === "manual") {
    return { kind: "progress", progress: withSourceChosen(progress, id, chosen) };
  }
  if (selection === null) {
    return { kind: "blocked", reason: "The saved selection could not be loaded, so it cannot be changed." };
  }
  return { kind: "selection", selection: withItem(selection, id, chosen) };
}

/** The form's Apply: replace the plan values. Null when blocked. */
export function applyPlanValues(
  state: ProgressLoadState,
  values: PlanValues,
): OnboardingProgress | null {
  const progress = loadedProgress(state);
  if (progress === null || !canWriteProgress(state)) return null;
  return withPlanValues(progress, values);
}

/** The state after a successful write, so the next transition starts from it. */
export function withSavedProgress(
  state: ProgressLoadState,
  progress: OnboardingProgress,
): ProgressLoadState {
  if (state.status === "ready") return { ...state, progress };
  if (state.status === "absent") return { status: "ready", progress, dropped: [] };
  return state;
}
