/**
 * SampleSourcePicker - "where do my samples come from?" (plan Phase 3).
 *
 * TWO CHOICES, made explicitly before anything is fetched (user direction
 * 2026-08-19): query an existing Cribl Lake dataset, or capture from a live
 * source. The mode decides what is read and what is shown:
 *
 *   lake-query    one leader request, NO worker group involved
 *   live-capture  a worker group first, then that group's sources
 *
 * Search is not a third choice. Lake datasets already appear in Cribl Search's
 * own dataset list, so offering both listed the same dataset twice and asked the
 * operator to choose between a place and the mechanism for reading it.
 *
 * It DISCOVERS; it does not acquire. Phase 4 runs the query or the capture.
 *
 * ADVISORY: no gate, no blocking. Every dead end ends with "uploading a file
 * works", because manual upload needs no Cribl access - which is also why it is
 * not a mode here, but a permanent option in the intake section below.
 *
 * All decisions are the pure sample-source-picker-state; this renders and wires.
 */

import { SearchableSelect } from "../../components/searchable-select";
import type {
  AcquisitionMode,
  SampleSourceGroups,
  SampleSourceInventory,
  SampleSourceRef,
} from "@soc/core";
import {
  MODE_CHOICES,
  derivePickerView,
  findEntry,
  groupOptions,
} from "./sample-source-picker-state";

export interface SampleSourcePickerProps {
  /** Stage one: the worker group listing, or null before it lands. */
  groups: SampleSourceGroups | null;
  /** Stage two: the chosen mode's inventory, or null before it is read. */
  inventory: SampleSourceInventory | null;
  /** The chosen mode, or null before the operator picks. */
  mode: AcquisitionMode | null;
  /** The chosen worker group (capture mode), or "". */
  selectedGroupId: string;
  /** Notes about discovery itself. */
  notes: readonly string[];
  loadingGroups: boolean;
  loadingSources: boolean;
  /** False when there is no Cribl connection to discover against. */
  enabled: boolean;
  /** The selected source option value, or "" for none. */
  value: string;
  onSelectMode: (mode: AcquisitionMode) => void;
  onSelectGroup: (groupId: string) => void;
  onChange: (value: string, entry: SampleSourceRef | null) => void;
  onReload: () => void;
}

export function SampleSourcePicker({
  groups,
  inventory,
  mode,
  selectedGroupId,
  notes,
  loadingGroups,
  loadingSources,
  enabled,
  value,
  onSelectMode,
  onSelectGroup,
  onChange,
  onReload,
}: SampleSourcePickerProps) {
  const view = derivePickerView({
    groups,
    inventory,
    mode,
    selectedGroupId,
    loadingGroups,
    loadingSources,
    enabled,
  });
  const selected = findEntry(inventory, value);
  const groupChoices = groupOptions(groups);
  const busy = loadingGroups || loadingSources;
  const showRetry =
    enabled && !busy && (view.status === "degraded" || view.status === "empty");

  return (
    <div className="sample-source-picker" data-status={view.status}>
      <span className="field-label">Where your samples come from</span>
      <p className="panel-desc">{view.headline}</p>

      {/* THE CHOICE. Rendered as soon as the workspace is reachable, and before
          anything about either surface is fetched - the modes are two different
          questions, and asking which one they mean is cheaper and clearer than
          answering both. */}
      {enabled && groups !== null && groups.ok && (
        <div className="acquisition-modes" role="radiogroup" aria-label="Sample source mode">
          {MODE_CHOICES.map((choice) => (
            <button
              key={choice.mode}
              type="button"
              role="radio"
              aria-checked={mode === choice.mode}
              className={
                mode === choice.mode
                  ? "acquisition-mode acquisition-mode-active"
                  : "acquisition-mode"
              }
              onClick={() => onSelectMode(choice.mode)}
              disabled={busy}
            >
              <span className="acquisition-mode-label">{choice.label}</span>
              <span className="field-hint">{choice.detail}</span>
            </button>
          ))}
        </div>
      )}

      {/* Stated up front rather than discovered in Phase 4. */}
      {view.modeWarning !== null && (
        <p className="field-hint sample-source-warning">{view.modeWarning}</p>
      )}

      {/* Capture only: which worker group. Lake datasets are a leader route and
          need no group at all, which is why this is conditional. */}
      {view.showGroupPicker && groupChoices.length > 0 && (
        <label className="field">
          <span className="field-label">Worker group</span>
          <SearchableSelect
            options={groupChoices}
            value={selectedGroupId}
            onChange={onSelectGroup}
            placeholder="Select a worker group..."
            ariaLabel="Worker group"
            disabled={loadingSources}
          />
        </label>
      )}

      {view.options.length > 0 && (
        <label className="field">
          <span className="field-label">
            {mode === "lake-query" ? "Lake dataset" : "Source"}
          </span>
          <SearchableSelect
            options={view.options}
            value={value}
            onChange={(next) => onChange(next, findEntry(inventory, next))}
            placeholder={
              mode === "lake-query" ? "Select a dataset..." : "Select a source..."
            }
            ariaLabel="Sample source"
          />
        </label>
      )}

      {selected?.disabled === true && (
        <p className="field-hint">
          This source is disabled, so a capture from it will return no events
          until it is enabled.
        </p>
      )}

      {notes.map((note) => (
        <p className="field-hint" key={note}>
          {note}
        </p>
      ))}

      {showRetry && (
        <div className="panel-controls">
          <button className="run-button" onClick={onReload} disabled={busy}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
