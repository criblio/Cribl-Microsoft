/**
 * SourceChooser - "Choose what to onboard" on Azure Native Source Onboarding
 * (AZR-31), the ONE control per source that chooses it (ADR 0007 section
 * 2). One row per onboarding source (howto-state
 * chooserRows), each with:
 *
 *   - a choose checkbox. WHERE the choice lands depends on the mode (ADR 0007
 *     D2): an Automated source is the AZR-18 selection's entry, a How-to source
 *     is the progress document; both are saved at once. The component only
 *     reports the click; the screen routes it through howto-state setChosen.
 *   - an Automate | How-to toggle. A source the app cannot deploy has the
 *     Automate option DISABLED and the reason shown as visible text beside it,
 *     not only in a tip (claude-kit standards/info-affordances.md: a disabled
 *     control says why). So is the Automate option of a How-to row while the
 *     selection cannot be used (the row's How-to choice could not be carried
 *     into it, and a stale entry would decide instead), and the How-to option
 *     of an Automated row (its choice is in the selection, unknown, and must
 *     not be written to progress as "not chosen").
 *   - an (i) explaining how the logs travel and that the Cribl source is
 *     created by the app after a confirm.
 *
 * Presentational: no IO, no state of its own.
 */

import type { OnboardingSourceId, SourceMode } from "@soc/core";
import { InfoTip } from "../../../components/info-tip";
import { choiceLabel, unknownReason } from "../azure-onboarding-state";
import type { ChoiceUnknownCause } from "../azure-onboarding-state";
import type { ChooserRow } from "./howto-state";
import { howtoModeRadioId, howtoRowAnchorId } from "./howto-state";

export interface SourceChooserProps {
  readonly rows: readonly ChooserRow[];
  /** True when progress cannot be written: every control is disabled. */
  readonly disabled: boolean;
  /**
   * Why the AZR-18 selection cannot be used, or null/absent when it is
   * loaded. An Automated row's choice lives in that selection, so it is
   * UNKNOWN, not "not chosen": its box is disabled, indeterminate and says why
   * in the same words its method-section row uses (claude-kit
   * standards/inventory-honesty.md). A How-to row cannot switch to Automate.
   */
  readonly selectionUnknownCause?: ChoiceUnknownCause | null;
  readonly onSetChosen: (id: OnboardingSourceId, chosen: boolean) => void;
  readonly onSetMode: (id: OnboardingSourceId, mode: SourceMode) => void;
  /**
   * Sources the active tenant's latest gap read measured RED on either side
   * (AZR-147). Each gets a small "Gap" badge with its (i); a source not in the
   * set gets none, which says nothing about it either way.
   */
  readonly gapSources?: ReadonlySet<OnboardingSourceId>;
}

/** The (i) beside a row's gap badge (AZR-147). */
const GAP_BADGE_TIP =
  "The latest gap read of this tenant measured a gap for this source: Azure is not configured as its plan says, " +
  "or this app has no Cribl source for it that Cribl still has. Focus here, at the top of this page, gives the reason.";

/** The hint under an Automated row: the app deploys it from its own section. */
export const AUTOMATE_CHOICE_HINT = "Automate: the app sets this source up from its section below.";

/** Shown on an Automated row while the selection cannot be used: the method row's words. */
export function selectionUnknownNote(cause: ChoiceUnknownCause): string {
  return choiceLabel({ kind: "unknown", doc: "selection", cause });
}

/** Shown beside an Automated row's disabled How-to option while the selection cannot be used. */
export function howtoUnavailableNote(cause: ChoiceUnknownCause): string {
  return `How-to is not available while ${unknownReason("selection", cause)}.`;
}

/** Shown beside a How-to row's disabled Automate option while the selection cannot be used. */
export function automateUnavailableNote(cause: ChoiceUnknownCause): string {
  return `Automate is not available while ${unknownReason("selection", cause)}.`;
}

export function SourceChooser({
  rows,
  disabled,
  selectionUnknownCause = null,
  onSetChosen,
  onSetMode,
  gapSources,
}: SourceChooserProps) {
  return (
    <ul className="azo-howto-chooser">
      {rows.map((row) => {
        const unknown = selectionUnknownCause !== null && row.chosenBy === "selection";
        // A How-to row cannot move to Automate while the selection its choice
        // would be carried into cannot be used (setMode refuses it too).
        const automateBlocked = selectionUnknownCause !== null && row.chosenBy === "progress" && !row.modeLocked;
        return (
        <li
          key={row.id}
          id={howtoRowAnchorId(row.id)}
          tabIndex={-1}
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
          {gapSources?.has(row.id) === true && (
            <span className="azo-gap-badge" data-testid={`azo-gap-badge-${row.id}`}>
              Gap <InfoTip text={GAP_BADGE_TIP} label={`${row.title}: gap, why`} />
            </span>
          )}
          <span className="field-hint">{`${row.transportLabel}, read by a Cribl ${row.criblInputType} source`}</span>
          <div className="azo-mode-toggle" role="radiogroup" aria-label={`${row.title} setup`}>
            <label>
              <input
                type="radio"
                name={`azo-mode-${row.id}`}
                aria-label={`Automate ${row.title}`}
                checked={row.mode === "automate"}
                disabled={disabled || row.modeLocked || automateBlocked}
                onChange={() => onSetMode(row.id, "automate")}
              />
              <span>Automate</span>
            </label>
            <label>
              <input
                type="radio"
                id={howtoModeRadioId(row.id)}
                name={`azo-mode-${row.id}`}
                aria-label={`How-to ${row.title}`}
                checked={row.mode === "manual"}
                disabled={disabled || unknown}
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
          {unknown && selectionUnknownCause !== null && (
            <span className="field-hint" data-testid={`azo-choice-unknown-${row.id}`}>
              {selectionUnknownNote(selectionUnknownCause)}
            </span>
          )}
          {unknown && selectionUnknownCause !== null && (
            <span className="field-hint" data-testid={`azo-howto-unavailable-${row.id}`}>
              {howtoUnavailableNote(selectionUnknownCause)}
            </span>
          )}
          {automateBlocked && selectionUnknownCause !== null && (
            <span className="field-hint" data-testid={`azo-automate-unavailable-${row.id}`}>
              {automateUnavailableNote(selectionUnknownCause)}
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
