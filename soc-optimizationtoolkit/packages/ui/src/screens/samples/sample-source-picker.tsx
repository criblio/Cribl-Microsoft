/**
 * SampleSourcePicker - "where can I get my own samples from?" (plan Phase 3).
 *
 * TWO DROPDOWNS, and the order is the point (user direction 2026-08-19). The
 * first lists worker groups, which costs one request and lands immediately. The
 * second appears only once a group is chosen, and lists what is actually in it.
 * Nothing about sources is fetched - or claimed - until the operator has said
 * which group they mean.
 *
 * It DISCOVERS; it does not acquire. Phase 4 owns the three acquisition paths;
 * selecting here only says where to go next.
 *
 * ADVISORY, like the recommendation panel above it: no gate, no blocking. Every
 * dead end still ends with "uploading a file works", because manual upload is
 * the one path needing no Cribl access - an operator whose Search read 403s must
 * not be left thinking they are stuck.
 *
 * All decisions are the pure sample-source-picker-state; this renders and wires.
 */

import { SearchableSelect } from "../../components/searchable-select";
import type {
  SampleSourceGroups,
  SampleSourceInventory,
  SampleSourceRef,
} from "@soc/core";
import {
  derivePickerView,
  findEntry,
  groupOptions,
} from "./sample-source-picker-state";

export interface SampleSourcePickerProps {
  /** Stage one: the worker group listing, or null before it lands. */
  groups: SampleSourceGroups | null;
  /** Stage two: the selected group's inventory, or null before a selection. */
  inventory: SampleSourceInventory | null;
  /** The chosen worker group, or "". */
  selectedGroupId: string;
  /** Notes about discovery itself. */
  notes: readonly string[];
  loadingGroups: boolean;
  loadingSources: boolean;
  /** False when there is no Cribl connection to discover against. */
  enabled: boolean;
  /** The selected source option value, or "" for none. */
  value: string;
  /** A worker group was chosen; triggers the second-stage load. */
  onSelectGroup: (groupId: string) => void;
  /** A source was chosen; the resolved entry is passed for convenience. */
  onChange: (value: string, entry: SampleSourceRef | null) => void;
  /** Re-run discovery. Offered whenever something degraded. */
  onReload: () => void;
}

export function SampleSourcePicker({
  groups,
  inventory,
  selectedGroupId,
  notes,
  loadingGroups,
  loadingSources,
  enabled,
  value,
  onSelectGroup,
  onChange,
  onReload,
}: SampleSourcePickerProps) {
  const view = derivePickerView({
    groups,
    inventory,
    selectedGroupId,
    loadingGroups,
    loadingSources,
    enabled,
  });
  const selected = findEntry(inventory, value);
  const groupChoices = groupOptions(groups);
  const showRetry =
    enabled &&
    !loadingGroups &&
    !loadingSources &&
    (view.status === "degraded" || view.status === "empty");

  return (
    <div className="sample-source-picker" data-status={view.status}>
      <span className="field-label">Where your samples can come from</span>
      <p className="panel-desc">{view.headline}</p>

      {/* STAGE ONE. Rendered as soon as the group listing lands, and it is the
          only thing fetched on load. */}
      {groupChoices.length > 0 && (
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

      {/* STAGE TWO. Only once a group is chosen and its listing is in. */}
      {view.options.length > 0 && (
        <label className="field">
          <span className="field-label">Dataset or source</span>
          <SearchableSelect
            options={view.options}
            value={value}
            onChange={(next) => onChange(next, findEntry(inventory, next))}
            placeholder="Select a dataset or source..."
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

      {/* Per-surface lines: only for surfaces that have something to explain. A
          surface that worked and has entries says nothing - the dropdown is the
          evidence it worked - and one nobody has asked for yet says nothing
          either. */}
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
          <button
            className="run-button"
            onClick={onReload}
            disabled={loadingGroups || loadingSources}
          >
            Retry discovery
          </button>
        </div>
      )}
    </div>
  );
}
