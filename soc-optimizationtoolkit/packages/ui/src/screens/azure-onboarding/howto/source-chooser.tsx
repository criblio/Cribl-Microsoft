/**
 * SourceChooser - "choose what to onboard" for the How-to part of Azure
 * Native Source Onboarding (AZR-31). One row per onboarding source
 * (howto-state chooserRows), each with:
 *
 *   - a choose checkbox. WHERE the choice lands depends on the mode (ADR 0007
 *     D2): an Automated source is the AZR-18 selection's tick (staged behind
 *     that section's explicit Save), a How-to source is the progress document
 *     (saved at once, D3). The component only reports the click; the screen
 *     routes it through howto-state setChosen.
 *   - an Automate | How-to toggle. A source the app cannot deploy has the
 *     Automate option DISABLED and the reason shown as visible text beside it,
 *     not only in a tip (claude-kit standards/info-affordances.md: a disabled
 *     control says why).
 *   - an (i) explaining how the logs travel and that the Cribl source is
 *     created by the app after a confirm.
 *
 * Presentational: no IO, no state of its own.
 */

import type { OnboardingSourceId, SourceMode } from "@soc/core";
import { InfoTip } from "../../../components/info-tip";
import type { ChooserRow } from "./howto-state";

export interface SourceChooserProps {
  readonly rows: readonly ChooserRow[];
  /** True when progress cannot be written: every control is disabled. */
  readonly disabled: boolean;
  /**
   * True when the AZR-18 selection is not loaded or its read failed. An
   * Automated row's choice lives in that selection, so it is UNKNOWN, not
   * "not chosen": its box is disabled, indeterminate and says why
   * (claude-kit standards/inventory-honesty.md).
   */
  readonly selectionUnknown?: boolean;
  readonly onSetChosen: (id: OnboardingSourceId, chosen: boolean) => void;
  readonly onSetMode: (id: OnboardingSourceId, mode: SourceMode) => void;
}

/** The hint under an Automated row: its choice is part of the selection above. */
export const AUTOMATE_CHOICE_HINT =
  "Automated: the choice is part of the selection above and is kept when you save it.";

/** Shown on an Automated row while the AZR-18 selection could not be read. */
export const SELECTION_UNKNOWN_NOTE =
  "The saved selection could not be read, so this choice is unknown.";

export function SourceChooser({
  rows,
  disabled,
  selectionUnknown = false,
  onSetChosen,
  onSetMode,
}: SourceChooserProps) {
  return (
    <ul className="azo-howto-chooser">
      {rows.map((row) => {
        const unknown = selectionUnknown && row.chosenBy === "selection";
        return (
        <li
          key={row.id}
          className="azo-howto-row"
          data-source={row.id}
          data-mode={row.mode}
          data-chosen={unknown ? "unknown" : String(row.chosen)}
        >
          <label className="integrate-check">
            <input
              type="checkbox"
              aria-label={`Onboard ${row.title}`}
              aria-checked={unknown ? "mixed" : undefined}
              ref={(el) => {
                if (el !== null) el.indeterminate = unknown;
              }}
              checked={unknown ? false : row.chosen}
              disabled={disabled || unknown}
              onChange={(e) => {
                if (!unknown) onSetChosen(row.id, e.target.checked);
              }}
            />
            <span className="integrate-check-text">{row.title}</span>
          </label>
          <InfoTip text={row.info} />
          <span className="field-hint">{`${row.transportLabel}, read by a Cribl ${row.criblInputType} source`}</span>
          <div className="azo-mode-toggle" role="radiogroup" aria-label={`${row.title} setup`}>
            <label>
              <input
                type="radio"
                name={`azo-mode-${row.id}`}
                aria-label={`Automate ${row.title}`}
                checked={row.mode === "automate"}
                disabled={disabled || row.modeLocked}
                onChange={() => onSetMode(row.id, "automate")}
              />
              <span>Automate</span>
            </label>
            <label>
              <input
                type="radio"
                name={`azo-mode-${row.id}`}
                aria-label={`How-to ${row.title}`}
                checked={row.mode === "manual"}
                disabled={disabled}
                onChange={() => onSetMode(row.id, "manual")}
              />
              <span>How-to</span>
            </label>
          </div>
          {row.modeLockedReason !== null && (
            <span className="field-hint" data-testid={`azo-locked-${row.id}`}>
              {row.modeLockedReason}
            </span>
          )}
          {unknown && (
            <span className="field-hint" data-testid={`azo-choice-unknown-${row.id}`}>
              {SELECTION_UNKNOWN_NOTE}
            </span>
          )}
          {row.chosenBy === "selection" && !unknown && (
            <span className="field-hint">{AUTOMATE_CHOICE_HINT}</span>
          )}
        </li>
        );
      })}
    </ul>
  );
}
