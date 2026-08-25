/**
 * CsvColumnMapper - the INTERACTIVE column-mapping tab of the CSV
 * header-resolution dialog (vendor-field-definition-plan "Gap 2").
 *
 * The dialog's other two tabs both assume the operator HAS an artifact: a header
 * row to paste, or a vendor output config for core parseFeedConfig to read. When
 * they have neither there was no path at all. This tab is that path - it shows
 * every column POSITION and lets them name it directly.
 *
 * WHAT MAKES IT USABLE RATHER THAN CLERICAL is the column of real values beside
 * each input. Naming a box labelled `_7` is guesswork; naming the box that reads
 * `192.168.0.2` is not. So the values are not decoration here, they ARE the
 * affordance, and several rows' worth are shown rather than one because a single
 * value is often ambiguous: a lone `0` says nothing, while `0 0 1 0` next to
 * `443 80 443 22` names both columns at a glance. Those values are the input
 * affordance, NOT a preview of the result - the result is confirmed in the
 * dialog's SHARED live preview, which this tab feeds through the resolved header
 * array like every other input path (see csv-column-mapping.resolvedColumnNames).
 *
 * NEVER INVENT A NAME. Every input starts empty and stays empty until the
 * operator types. Nothing here reads a value's shape and offers a guess: a
 * confident wrong name survives into the destination schema unnoticed, while an
 * obviously blank `_17` does not. Unnamed positions stay positional and are
 * counted out loud, so a definition covering 6 of 38 columns LOOKS like it
 * covers 6 of 38.
 *
 * All naming, cleaning, counting and validation is the pure csv-column-mapping
 * module; this component only renders it and reports keystrokes upward. The
 * drafts live in the dialog so it can keep the shared preview in step on every
 * edit.
 */

import {
  buildColumnMappingRows,
  columnMappingProgressLabel,
  deriveColumnMappingSummary,
} from "./csv-column-mapping";
import type { ColumnDrafts, MappableItem } from "./csv-column-mapping";

export interface CsvColumnMapperProps {
  /** The sample being resolved - column count plus rows to draw values from. */
  item: MappableItem;
  /** The operator's names so far, keyed by 0-based position. */
  drafts: ColumnDrafts;
  /** Report a keystroke at one position; "" clears that position back to unmapped. */
  onDraftChange: (index: number, text: string) => void;
  /** Drop every name, returning the whole definition to positional. */
  onClearAll: () => void;
  /** True while the section persists an apply/skip - inputs disable. */
  busy?: boolean;
}

export function CsvColumnMapper({
  item,
  drafts,
  onDraftChange,
  onClearAll,
  busy = false,
}: CsvColumnMapperProps) {
  const rows = buildColumnMappingRows(item, drafts);
  const summary = deriveColumnMappingSummary(rows);

  return (
    <div className="csv-dialog-tabbody">
      <span className="field-hint">
        Name the columns you recognize from their values. Anything you leave
        blank keeps its positional name and stays unmapped - a partial definition
        is fine, and naming a column wrongly is worse than leaving it blank.
      </span>

      <div className="csv-map-grid" role="group" aria-label="Column names">
        <div className="csv-map-head">
          <span className="csv-map-position">Column</span>
          <span className="csv-map-examples">
            Example values (first {item.firstRows.length} rows)
          </span>
          <span className="csv-map-name">Name</span>
        </div>
        {rows.map((row) => (
          <div
            className={
              row.duplicate || row.invalid
                ? "csv-map-row csv-map-row-warn"
                : "csv-map-row"
            }
            key={row.index}
          >
            <span
              className={
                row.mapped
                  ? "csv-map-position csv-map-position-mapped"
                  : "csv-map-position"
              }
            >
              {row.positionalName}
            </span>
            <span className="csv-map-examples">
              {row.examples.length === 0 ? (
                <span className="csv-map-empty">(no rows)</span>
              ) : (
                row.examples.map((value, i) => (
                  <span
                    className={
                      value === "" ? "csv-map-value csv-map-empty" : "csv-map-value"
                    }
                    key={`${row.index}-${i}`}
                  >
                    {value === "" ? "(empty)" : value}
                  </span>
                ))
              )}
            </span>
            <span className="csv-map-name">
              <input
                type="text"
                className="csv-map-input"
                value={row.draft}
                onChange={(e) => onDraftChange(row.index, e.target.value)}
                placeholder={`unmapped (${row.positionalName})`}
                aria-label={`Name for column ${row.positionalName}`}
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
              />
              {row.duplicate && (
                <span className="csv-map-note">
                  duplicate of another column - only the last one survives
                </span>
              )}
              {row.invalid && (
                <span className="csv-map-note">
                  not a usable name - stays unmapped
                </span>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="csv-dialog-actions">
        <span className="field-hint">
          {columnMappingProgressLabel(summary)}
          {summary.duplicateNames.length > 0
            ? ` Duplicate name${summary.duplicateNames.length === 1 ? "" : "s"}: ${summary.duplicateNames.join(", ")} - each keeps only the last column that uses it.`
            : ""}
        </span>
        <div className="panel-controls">
          <button
            type="button"
            className="run-button"
            onClick={onClearAll}
            disabled={busy || summary.namedCount === 0}
          >
            Clear all names
          </button>
        </div>
      </div>
    </div>
  );
}
