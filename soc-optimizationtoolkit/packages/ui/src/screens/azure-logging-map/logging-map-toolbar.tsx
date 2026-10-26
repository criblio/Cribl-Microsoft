/**
 * LoggingMapToolbar and LoggingMapLegend - the controls and the key of the
 * Azure Logging Map (AZR-19, phase 1, READ-ONLY).
 *
 * Toolbar: the Diagram / Outline view switch, the Trace picker, the
 * Inherited and All policy toggles, Search, and the counts - scopes, reads
 * that could not be read, unclassified assignments, roles unread - each with
 * an InfoTip. A count backed by an unread list renders the UNKNOWN token,
 * never 0 (formatCount).
 */

import { InfoTip } from "../../components/info-tip";
import { formatCount, type LoggingMapUiState, type ToolbarCounts, type UiMapAssignment } from "./logging-map-state";
import { LEGEND, TIPS } from "./logging-map-copy";

export type LoggingMapView = "diagram" | "outline";

export interface LoggingMapToolbarProps {
  readonly view: LoggingMapView;
  readonly onView: (view: LoggingMapView) => void;
  readonly state: LoggingMapUiState;
  readonly counts: ToolbarCounts;
  /** The assignments the trace picker offers (the current view's shown ones). */
  readonly traceOptions: readonly UiMapAssignment[];
  readonly onTrace: (assignmentKey: string | null) => void;
  readonly onShowInherited: (value: boolean) => void;
  readonly onShowAll: (value: boolean) => void;
  readonly onSearch: (query: string) => void;
}

function optionLabel(entry: UiMapAssignment): string {
  const name = entry.assignment.displayName !== "" ? entry.assignment.displayName : entry.assignment.name;
  return entry.ownership?.owner === "ours" ? `${name} (ours)` : name;
}

function Count({ id, label, value, tip }: { id: string; label: string; value: number | null; tip: string }) {
  return (
    <span className="lm-count" data-lm-count={id}>
      <span className="lm-count-label">{label}</span>
      <b className="lm-count-value">{formatCount(value)}</b>
      <InfoTip text={tip} />
    </span>
  );
}

export function LoggingMapToolbar({
  view,
  onView,
  state,
  counts,
  traceOptions,
  onTrace,
  onShowInherited,
  onShowAll,
  onSearch,
}: LoggingMapToolbarProps) {
  return (
    <div className="lm-toolbar">
      <div className="lm-seg" role="group" aria-label="View">
        <button type="button" aria-pressed={view === "diagram"} onClick={() => onView("diagram")}>
          Diagram
        </button>
        <button type="button" aria-pressed={view === "outline"} onClick={() => onView("outline")}>
          Outline
        </button>
      </div>
      <span className="lm-ctl">
        <label className="lm-ctl-label">
        Trace an assignment
        <select
          value={state.tracedAssignment ?? ""}
          onChange={(e) => onTrace(e.target.value === "" ? null : e.target.value)}
        >
          <option value="">None</option>
          {traceOptions.map((a) => (
            <option key={a.assignmentKey} value={a.assignmentKey}>
              {optionLabel(a)}
            </option>
          ))}
        </select>
        </label>
        <InfoTip text={TIPS.trace} />
      </span>
      <span className="lm-ctl">
        <label className="lm-ctl-label">
        <input type="checkbox" checked={state.showInherited} onChange={(e) => onShowInherited(e.target.checked)} />
        Inherited
        </label>
        <InfoTip text={TIPS.inherited} />
      </span>
      <span className="lm-ctl">
        <label className="lm-ctl-label">
        <input type="checkbox" checked={state.showAll} onChange={(e) => onShowAll(e.target.checked)} />
        All policy
        </label>
        <InfoTip text={TIPS.allPolicy} />
      </span>
      <span className="lm-ctl">
        <label className="lm-ctl-label">
        Search
        <input
          type="search"
          className="lm-search"
          value={state.search}
          placeholder="Subscription or assignment"
          onChange={(e) => onSearch(e.target.value)}
        />
        </label>
        <InfoTip text={TIPS.search} />
      </span>
      <span className="lm-counts">
        <Count id="scopes" label="Scopes" value={counts.scopes} tip={TIPS.scopes} />
        <Count id="could-not-read" label="Could not be read" value={counts.couldNotRead} tip={TIPS.couldNotRead} />
        <Count id="unclassified" label="Unclassified" value={counts.unclassified} tip={TIPS.unclassified} />
        <Count id="roles-unread" label="Roles unread" value={counts.rolesUnread} tip={TIPS.rolesUnread} />
      </span>
    </div>
  );
}

export function LoggingMapLegend() {
  return (
    <div className="lm-legend">
      {LEGEND.map((row) => (
        <span key={row.key} className="lm-legend-item">
          <i className={`lm-swatch lm-swatch-${row.key}`} aria-hidden="true" />
          {row.label}
        </span>
      ))}
      <InfoTip text={TIPS.legend} />
    </div>
  );
}
