/**
 * SampleSourcePicker - "where can I get my own samples from?" (plan Phase 3).
 *
 * Lists every surface the operator can actually reach - Search datasets, Lake
 * datasets, live Cribl sources - and lets them pick one. It does NOT acquire
 * anything; Phase 4 owns the three acquisition paths. Selecting here only says
 * where to go next.
 *
 * ADVISORY, like the recommendation panel above it: no gate, no blocking. Every
 * failure state still ends with "uploading a file works", because manual upload
 * is the one path that needs no Cribl access at all, and an operator whose
 * Search read 403s must not be left thinking they are stuck.
 *
 * All decisions are the pure sample-source-picker-state; this renders and wires.
 */

import { SearchableSelect } from "../../components/searchable-select";
import type { SampleSourceInventory, SampleSourceRef } from "@soc/core";
import { derivePickerView, findEntry } from "./sample-source-picker-state";

export interface SampleSourcePickerProps {
  /** The discovered inventory, or null before/failing the first load. */
  inventory: SampleSourceInventory | null;
  /** Notes about discovery itself (capped group reads, an unreachable leader). */
  notes: readonly string[];
  loading: boolean;
  /** False when there is no Cribl connection to discover against. */
  enabled: boolean;
  /** The selected option value, or "" for none. */
  value: string;
  /** Selection changed; the resolved entry is passed for convenience. */
  onChange: (value: string, entry: SampleSourceRef | null) => void;
  /** Re-run discovery. Offered whenever something degraded. */
  onReload: () => void;
}

export function SampleSourcePicker({
  inventory,
  notes,
  loading,
  enabled,
  value,
  onChange,
  onReload,
}: SampleSourcePickerProps) {
  const view = derivePickerView(inventory, loading, enabled);
  const selected = findEntry(inventory, value);
  const showRetry =
    enabled && !loading && (view.status === "degraded" || view.status === "empty");

  return (
    <div className="sample-source-picker" data-status={view.status}>
      <span className="field-label">Where your samples can come from</span>
      <p className="panel-desc">{view.headline}</p>

      {view.options.length > 0 && (
        <SearchableSelect
          options={view.options}
          value={value}
          onChange={(next) => onChange(next, findEntry(inventory, next))}
          placeholder="Select a dataset or source..."
          ariaLabel="Sample source"
        />
      )}

      {selected?.disabled === true && (
        <p className="field-hint">
          This source is disabled, so a capture from it will return no events
          until it is enabled.
        </p>
      )}

      {/* Per-surface lines: only for surfaces that have something to explain.
          A surface that worked and has entries says nothing - the dropdown is
          the evidence it worked. */}
      {view.sectionNotes.length > 0 && (
        <ul className="sample-source-picker-notes">
          {view.sectionNotes.map((note) => (
            <li key={note.kind} className="field-hint">
              {note.text}
            </li>
          ))}
        </ul>
      )}

      {notes.map((note) => (
        <p className="field-hint" key={note}>
          {note}
        </p>
      ))}

      {showRetry && (
        <div className="panel-controls">
          <button className="run-button" onClick={onReload} disabled={loading}>
            Retry discovery
          </button>
        </div>
      )}
    </div>
  );
}
