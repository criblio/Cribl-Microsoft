/**
 * ChoosePanel - "Choose what to onboard", its own numbered section on Azure
 * Native Source Onboarding, straight after the Event Hub. It is the ONE place
 * a source is chosen (ADR 0007 section 2, amended 2026-11-17): every source
 * row with its Automate | How-to toggle, info tip and transport
 * (SourceChooser). The method sections below only say what was chosen here.
 *
 * WHERE A CHOICE LANDS (D2) is the screen's business: an Automated source is
 * the saved selection's entry, a How-to source is the progress document, and
 * both are written at once. This panel only reports the click.
 *
 * WRITES BLOCKED. The mode lives in the progress document, so a progress load
 * that did not answer cleanly blocks every choice: the load's banner is shown
 * here, and a FAILED load shows no rows at all, because the empty progress it
 * would have to draw would claim "nothing chosen" about a document that may
 * exist (claude-kit standards/inventory-honesty.md). The screen may also block
 * writes for its own reason (`writesBlockedReason`); that disables the
 * controls with the reason shown.
 *
 * Presentational over props; no IO.
 */

import type { CoverageSelection, OnboardingSourceId, SourceMode } from "@soc/core";
import { PickerLine } from "../eventhub-prerequisite-section";
import { SourceChooser } from "./source-chooser";
import { canWriteProgress, chooserRows, loadedProgress, progressBanners } from "./howto-state";
import type { ProgressLoadState } from "./howto-state";

export interface ChoosePanelProps {
  /** The progress document's load state (howto-state progressLoadStateFrom). */
  readonly load: ProgressLoadState;
  /** The saved selection, or null when it is not loaded or its read failed. */
  readonly selection: CoverageSelection | null;
  /** A reason of the screen's own to block writes (shown); null or absent otherwise. */
  readonly writesBlockedReason?: string | null;
  readonly onSetMode: (id: OnboardingSourceId, mode: SourceMode) => void;
  readonly onSetChosen: (id: OnboardingSourceId, chosen: boolean) => void;
}

/** Shown while the progress document has not answered yet. */
export const CHOICES_LOADING_TEXT = "Loading your saved choices.";

export function ChoosePanel({
  load,
  selection,
  writesBlockedReason = null,
  onSetMode,
  onSetChosen,
}: ChoosePanelProps) {
  const progress = loadedProgress(load);
  const canWrite = canWriteProgress(load) && writesBlockedReason === null;
  const banners = progressBanners(load);

  return (
    <div className="azo-howto">
      {load.status === "loading" && <p className="field-hint">{CHOICES_LOADING_TEXT}</p>}
      {banners.map((b) => (
        <PickerLine key={b.text} message={b} />
      ))}
      {writesBlockedReason !== null && <PickerLine message={{ tone: "info", text: writesBlockedReason }} />}
      {progress !== null && (
        <SourceChooser
          rows={chooserRows(progress, selection)}
          disabled={!canWrite}
          selectionUnknown={selection === null}
          onSetChosen={onSetChosen}
          onSetMode={onSetMode}
        />
      )}
    </div>
  );
}
