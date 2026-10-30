/**
 * The unmapped-column suggestion panel (DBT-202): clicking an Unmapped
 * Destination Fields column name opens this row under it, listing the sample
 * fields that could fill the column, best first. Applying one goes back to the
 * section, which re-points the row through applyRemap.
 *
 * Rendered as a table row spanning the grid's seven columns, so it sits
 * directly under the column it explains. Presentational only: the candidates
 * arrive render-ready from columnSuggestions (mapping-review-state.ts).
 *
 * Keyboard: the panel takes focus when it opens, Escape or Dismiss closes it,
 * and focus returns to the control that opened it (usePanelFocus, shared with
 * the Dest Field claim panel, DBT-208).
 */

import type { ColumnSuggestion } from "./mapping-review-state";
import { usePanelFocus } from "./use-panel-focus";

export function UnmappedColumnPanel({
  id,
  column,
  suggestions,
  onApply,
  onAddConstant,
  onDismiss,
}: {
  /** The panel's element id (the opening button's aria-controls). */
  id: string;
  column: string;
  suggestions: readonly ColumnSuggestion[];
  onApply: (source: string) => void;
  /** Open the table's enrichment editor for this column. */
  onAddConstant: () => void;
  onDismiss: () => void;
}) {
  const { panelRef, close: dismiss } = usePanelFocus(onDismiss);

  const headingId = `${id}-heading`;
  return (
    <tr className="mapping-suggest-row">
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
              dismiss();
            }
          }}
        >
          <div className="close-match-head">
            <span className="field-label" id={headingId}>
              Sample fields that could fill {column}
            </span>
            <button
              type="button"
              className="gap-reset-button"
              aria-label={`Dismiss the suggestions for ${column}`}
              onClick={dismiss}
            >
              Dismiss
            </button>
          </div>
          {suggestions.length === 0 ? (
            <p className="field-hint mapping-suggest-empty">
              No sample field looks close to {column}. If the value is the
              same for every event (a vendor or product name, say), the
              pipeline can add it as a constant.{" "}
              <button
                type="button"
                className="link-button"
                onClick={onAddConstant}
              >
                Add a constant
              </button>
            </p>
          ) : (
            suggestions.map((s) => (
              <div
                className="close-match-row mapping-suggest-candidate"
                key={s.source}
                data-source={s.source}
              >
                <code className="code-chip">{s.source}</code>
                <span className="close-match-sample" title={s.example.title}>
                  e.g. {s.example.text}
                </span>
                <span className="close-match-disposition">
                  {s.disposition}
                </span>
                <span
                  className={
                    s.typeMismatch
                      ? "mapping-suggest-type mapping-suggest-warn"
                      : "mapping-suggest-type"
                  }
                >
                  {s.typeNote}
                </span>
                <span className="field-hint">{s.reason}</span>
                {s.lowConfidence && (
                  <span className="mapping-suggest-warn">
                    Name resemblance only - check the example value
                  </span>
                )}
                {s.moveWarning !== null && (
                  <span className="mapping-suggest-warn" role="note">
                    {s.moveWarning}
                  </span>
                )}
                <button
                  type="button"
                  className="run-button mapping-suggest-apply"
                  aria-label={`${s.actionLabel}: ${s.source} into ${column}`}
                  onClick={() => onApply(s.source)}
                >
                  {s.actionLabel}
                </button>
              </div>
            ))
          )}
        </div>
      </td>
    </tr>
  );
}
