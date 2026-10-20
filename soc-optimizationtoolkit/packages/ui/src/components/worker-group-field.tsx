/**
 * WorkerGroupField - the ONE way a screen lists Cribl Stream worker groups
 * and renders the outcome (DBT-134).
 *
 * WHY IT EXISTS. A tester saw a worker-group picker with nothing in it. Four
 * screens each carried a copy of the same load-and-render code, and in every
 * copy three different situations reached the screen as the same `[]`: the
 * leader returned no groups, the caller's Cribl role (or the app's
 * policies.yml grant) covered none, or every group was an Edge fleet, Outpost
 * or Search group. All three rendered as an ENABLED select whose only row read
 * "No matches" - the same words a typo in the filter box produces - with no
 * Retry and nothing about permissions. Pack Inventory hid its picker outright,
 * and Integrate's fan-out showed a failed listing as an endless "Loading".
 *
 * So the states are owned here, once (docs/inventory-standard.md):
 *   loading            - a call is in flight
 *   failed             - the call was refused or broke: the error, and Retry
 *   loaded, empty      - Cribl answered with no groups. UNVERIFIED: that is
 *                        also what a role covering no group receives, so the
 *                        copy hedges, names the likely causes, and offers Retry
 *   loaded, none       - groups came back and none is a Stream group: a
 *                        measured fact, stated plainly with the ids found
 *   loaded, rows       - the caller's picker, via `children`
 * plus `idle` for the on-demand panels that list only when asked.
 *
 * The caller still owns the picker itself (single or multi select, which
 * group is preselected), because those genuinely differ per screen.
 */

import type { ReactNode } from "react";
import type { CriblGroupSummary } from "@soc/core";
import { noStreamGroupsText } from "./worker-group-listing";
import type { WorkerGroupsState } from "./worker-group-listing";

export interface WorkerGroupFieldProps {
  state: WorkerGroupsState;
  onRetry: () => void;
  /** The picker, rendered only once at least one Stream worker group is listed. */
  children: (groups: readonly [CriblGroupSummary, ...CriblGroupSummary[]]) => ReactNode;
}

/** Every worker-group listing state, rendered; the picker itself is `children`. */
export function WorkerGroupField({ state, onRetry, children }: WorkerGroupFieldProps) {
  // Named explicitly: screens put this field inside a <label>, and a button
  // there would otherwise be announced by the label's whole text.
  const retry = (
    <button
      type="button"
      className="run-button"
      aria-label="Retry loading groups"
      onClick={onRetry}
    >
      Retry loading groups
    </button>
  );
  switch (state.kind) {
    case "idle":
      return null;
    case "loading":
      return <span className="field-hint">Loading worker groups...</span>;
    case "failed":
      return (
        <>
          <span className="field-hint">Could not list worker groups: {state.error}</span>
          {retry}
        </>
      );
    case "loaded": {
      if (state.groups.stream.kind === "rows") {
        return <>{children(state.groups.stream.rows)}</>;
      }
      return (
        <>
          <span className="field-hint">{noStreamGroupsText(state.groups)}</span>
          {retry}
        </>
      );
    }
  }
}
