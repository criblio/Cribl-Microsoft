/**
 * HowToPanel - "How to set it up yourself" on Azure Native Source Onboarding
 * (AZR-31). It composes the chooser (what to onboard, Automate | How-to per
 * source), the plan values form, the step list with its done ticks, and the
 * step dialog, over the pure decisions in howto-state.ts.
 *
 * WHAT IT OWNS: which step dialog is open. Nothing else. The progress document
 * and the AZR-18 selection are the screen's; every click is reported as an
 * intent (tick, mode, choose, apply) and the screen runs the howto-state
 * transition and the KV write (ADR 0007 D3: one write per click, serialized).
 *
 * WRITES BLOCKED. A progress load that did not answer cleanly (loading, read
 * failed, foreign or unreadable document) blocks every write: the load's
 * banner is shown and the controls are disabled. A FAILED load shows no
 * chooser or steps at all, because the empty progress it would have to draw
 * would claim "nothing chosen, nothing done" about a document that may exist
 * (claude-kit standards/inventory-honesty.md). The screen may also block
 * writes for its own reason (`writesBlockedReason`, e.g. a save in flight);
 * that disables the controls with the reason shown.
 *
 * Presentational over props; no IO.
 */

import { useState } from "react";
import type {
  CoverageSelection,
  OnboardingSourceId,
  PlanValues,
  SourceMode,
  ValidationResult,
} from "@soc/core";
import { PickerLine } from "../eventhub-prerequisite-section";
import { PlanValuesForm } from "./plan-values-form";
import { SourceChooser } from "./source-chooser";
import { StepDialog } from "./step-dialog";
import { StepList } from "./step-list";
import {
  canWriteProgress,
  chooserRows,
  loadedProgress,
  progressBanners,
  progressBlockedReason,
  progressSummary,
  stepDialogView,
  stepRows,
} from "./howto-state";
import type { ProgressLoadState } from "./howto-state";

export interface HowToPanelProps {
  /** The progress document's load state (howto-state progressLoadStateFrom). */
  readonly load: ProgressLoadState;
  /** The AZR-18 selection, or null when it is not loaded or its read failed. */
  readonly selection: CoverageSelection | null;
  /** The last Validate result, for the verdict words; null before one ran. */
  readonly result?: ValidationResult | null;
  /** The AZR-18 Event Hub picker's names, for "Use the Event Hub picked above". */
  readonly pickedValues?: Partial<PlanValues> | null;
  /** A reason of the screen's own to block writes (shown); null or absent otherwise. */
  readonly writesBlockedReason?: string | null;
  readonly onToggleTick: (stepId: string, checked: boolean) => void;
  readonly onSetMode: (id: OnboardingSourceId, mode: SourceMode) => void;
  readonly onSetChosen: (id: OnboardingSourceId, chosen: boolean) => void;
  readonly onApplyPlanValues: (values: PlanValues) => void;
}

/** Shown while the progress document has not answered yet. */
export const PROGRESS_LOADING_TEXT = "Loading your saved How-to progress.";

export function HowToPanel({
  load,
  selection,
  result = null,
  pickedValues = null,
  writesBlockedReason = null,
  onToggleTick,
  onSetMode,
  onSetChosen,
  onApplyPlanValues,
}: HowToPanelProps) {
  const [openStep, setOpenStep] = useState<string | null>(null);
  const progress = loadedProgress(load);
  const canWrite = canWriteProgress(load) && writesBlockedReason === null;
  const blockedReason = writesBlockedReason ?? progressBlockedReason(load);
  const banners = progressBanners(load);

  if (progress === null) {
    return (
      <div className="azo-howto">
        {load.status === "loading" && <p className="field-hint">{PROGRESS_LOADING_TEXT}</p>}
        {banners.map((b) => (
          <PickerLine key={b.text} message={b} />
        ))}
      </div>
    );
  }

  const opts = { canWrite, blockedReason };
  const chooser = chooserRows(progress, selection);
  const steps = stepRows(progress, selection, { ...opts, result });
  const summary = progressSummary(steps);
  const dialog = openStep === null ? null : stepDialogView(openStep, progress, selection, opts);

  return (
    <div className="azo-howto">
      {banners.map((b) => (
        <PickerLine key={b.text} message={b} />
      ))}
      {writesBlockedReason !== null && (
        <PickerLine message={{ tone: "info", text: writesBlockedReason }} />
      )}
      <h4>Choose what to onboard</h4>
      <SourceChooser
        rows={chooser}
        disabled={!canWrite}
        selectionUnknown={selection === null}
        onSetChosen={onSetChosen}
        onSetMode={onSetMode}
      />
      <h4>Your names and ids</h4>
      <PlanValuesForm
        values={progress.planValues}
        disabled={!canWrite}
        onApply={onApplyPlanValues}
        pickedValues={pickedValues}
      />
      <h4>Steps</h4>
      <p className="field-hint" role="status">
        {summary.text}
      </p>
      {steps.length > 0 && (
        <StepList rows={steps} onToggleTick={onToggleTick} onOpen={setOpenStep} />
      )}
      {dialog !== null && (
        <StepDialog view={dialog} onClose={() => setOpenStep(null)} onToggleTick={onToggleTick} />
      )}
    </div>
  );
}
