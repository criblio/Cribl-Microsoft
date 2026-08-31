/**
 * The hand-authored schema editor (TBL-1): one row per field, a name and a
 * type, with the per-row verdict rendered under the input that caused it.
 *
 * CONTROLLED AND STATELESS. The host owns the row array and applies the pure
 * operations from `manual-schema-state`; this component reports events and
 * renders what it is handed. That is the house pattern for a row editor here
 * (`screens/samples/csv-column-mapper.tsx` takes `drafts` / `onDraftChange`
 * and holds nothing), and it is what lets every rule stay unit-pinned.
 *
 * IT BORROWS THE `.csv-map-*` VOCABULARY rather than inventing one, because
 * that block is the only layout in this app that stacks a per-row message
 * under its own input - `.csv-map-name` is a flex column, so a note hung
 * beneath the input lands in the right place automatically. The one thing it
 * cannot borrow is the grid template: `.csv-map-row` is three columns sized
 * for the CSV mapper, so `.manual-schema-row` overrides
 * `grid-template-columns` for name / type / remove.
 *
 * RESERVED NAMES ARE SHOWN ON THE ROW, not only in the preview block below
 * it. The creation payload strips 13 Azure-managed names, and TBL-1 is
 * explicit that a stripped row must SAY it was stripped - a field the
 * operator typed vanishing silently is the same class of quiet loss as HON-4.
 * The strip itself is decided by the real strip function upstream; this
 * component only renders the names it is handed.
 */

import { CUSTOM_COLUMN_TYPES } from "@soc/core";
import type { ManualColumnDraft, ManualRowStatus } from "./manual-schema-state";

export interface ManualSchemaEditorProps {
  /** The rows being edited; the host owns the array. */
  rows: readonly ManualColumnDraft[];
  /** Per-row verdicts from `manualRowStatuses`, in row order. */
  statuses: readonly ManualRowStatus[];
  /**
   * Names the creation payload will STRIP, from the preview's reserved rows.
   * Empty when nothing is stripped.
   */
  reservedNames?: readonly string[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  onEdit: (
    id: string,
    patch: Partial<Pick<ManualColumnDraft, "name" | "type">>,
  ) => void;
  busy?: boolean;
}

export function ManualSchemaEditor(props: ManualSchemaEditorProps) {
  const { rows, statuses, onAdd, onRemove, onEdit } = props;
  const reservedNames = props.reservedNames ?? [];
  const busy = props.busy ?? false;

  const isReserved = (name: string): boolean =>
    reservedNames.some((n) => n.toLowerCase() === name.trim().toLowerCase());

  return (
    <div className="manual-schema-editor">
      <div
        className="csv-map-grid manual-schema-grid"
        role="group"
        aria-label="Table fields"
      >
        <div className="csv-map-head manual-schema-row">
          <span>Field name</span>
          <span>Type</span>
          <span />
        </div>
        {rows.map((row, index) => {
          const status = statuses[index];
          const reserved = row.name.trim() !== "" && isReserved(row.name);
          // The row tints for a BLOCKING problem only. A blank trailing row
          // and a reserved name are both notes, not errors - one is the
          // editor's resting state and the other is a thing Azure does.
          const className =
            status?.blocking === true
              ? "csv-map-row manual-schema-row csv-map-row-warn"
              : "csv-map-row manual-schema-row";
          return (
            <div className={className} key={row.id}>
              <span className="csv-map-name">
                <input
                  className="csv-map-input"
                  type="text"
                  aria-label={`Field ${index + 1} name`}
                  placeholder="Field name"
                  value={row.name}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(ev) => onEdit(row.id, { name: ev.target.value })}
                />
                {status?.message != null && (
                  <span className="csv-map-note">{status.message}</span>
                )}
                {reserved && (
                  <span className="csv-map-note manual-schema-reserved">
                    Azure manages this column - it is removed from the creation
                    payload, so this field is not created.
                  </span>
                )}
              </span>
              <select
                className="manual-schema-select"
                aria-label={`Field ${index + 1} type`}
                value={row.type}
                disabled={busy}
                onChange={(ev) => onEdit(row.id, { type: ev.target.value })}
              >
                {CUSTOM_COLUMN_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <button
                className="gap-reset-button"
                onClick={() => onRemove(row.id)}
                disabled={busy}
                title={`Remove field ${index + 1}`}
              >
                Remove
              </button>
            </div>
          );
        })}
      </div>
      <div className="panel-controls manual-schema-add">
        <button className="run-button" onClick={onAdd} disabled={busy}>
          Add field
        </button>
      </div>
    </div>
  );
}
