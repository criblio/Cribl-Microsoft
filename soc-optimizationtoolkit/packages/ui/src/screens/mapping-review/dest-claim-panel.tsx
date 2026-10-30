/**
 * The Dest Field claim panel (DBT-208): pointing a row's Dest Field at a
 * column another row already fills opens this row under it instead of
 * applying. Two Renames onto one name lose the first value - it reaches
 * neither the column nor overflow - so the reviewer chooses: move the column
 * (the other row falls back to the catch-all as overflow) or keep it.
 *
 * Rendered as a table row spanning the grid's seven columns, in the same
 * panel the unmapped-column suggestions use. Presentational only: the claim
 * arrives render-ready from destClaim (mapping-review-state.ts), including
 * the DBT-202 move warning.
 *
 * Keyboard: the panel takes focus when it opens; Escape or Keep closes it, and
 * focus returns to the Dest Field select.
 */

import type { DestClaim } from "./mapping-review-state";
import { usePanelFocus } from "./use-panel-focus";

export function DestClaimPanel({
  id,
  source,
  claim,
  onMove,
  onKeep,
}: {
  id: string;
  /** The row being re-pointed. */
  source: string;
  claim: DestClaim;
  onMove: () => void;
  onKeep: () => void;
}) {
  const { panelRef, close: keep } = usePanelFocus(onKeep);
  const headingId = `${id}-heading`;
  return (
    <tr className="mapping-suggest-row mapping-claim-row">
      <td colSpan={7}>
        <div
          id={id}
          ref={panelRef}
          className="close-match-panel"
          role="region"
          aria-labelledby={headingId}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              keep();
            }
          }}
        >
          <div className="close-match-head">
            <span className="field-label" id={headingId}>
              {claim.column} is already filled by {claim.claimedBy}
            </span>
          </div>
          <p className="field-hint mapping-suggest-empty mapping-claim-text">
            {claim.fallback !== null
              ? `Using ${source} there moves ${claim.claimedBy} out of ${claim.column} into ${claim.fallback} (overflow), so its value is kept.`
              : `This table has no catch-all column to move ${claim.claimedBy} into. Point ${claim.claimedBy} at another column first.`}
          </p>
          {claim.moveWarning !== null && (
            <span className="mapping-suggest-warn" role="note">
              {claim.moveWarning}
            </span>
          )}
          <div className="close-match-row">
            <button type="button" className="gap-reset-button" onClick={keep}>
              Keep {claim.claimedBy}
            </button>
            {claim.fallback !== null && (
              <button
                type="button"
                className="run-button mapping-suggest-apply"
                aria-label={`${claim.actionLabel} to ${source}`}
                onClick={onMove}
              >
                {claim.actionLabel}
              </button>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}
