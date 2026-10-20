/**
 * Worker-group listing state for {@link WorkerGroupField} (DBT-134): the hook
 * that lists the groups, the preselection rule, and the sentence for a
 * listing with no Stream worker group. Kept apart from the component so the
 * component module exports only components (fast refresh), and so the
 * wording is testable without mounting anything. See worker-group-field.tsx
 * for why these states exist.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listingRows, streamWorkerGroups } from "@soc/core";
import type {
  CriblClient,
  CriblGroupSummary,
  Logger,
  StreamWorkerGroupListing,
} from "@soc/core";

/** Where a worker-group listing stands. */
export type WorkerGroupsState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "loaded"; readonly groups: StreamWorkerGroupListing };

const IDLE: WorkerGroupsState = { kind: "idle" };
const LOADING: WorkerGroupsState = { kind: "loading" };

export interface UseStreamWorkerGroupsOptions {
  /**
   * List on mount (and again when the client changes). Default true. False
   * for panels that list only when the operator asks; `reload` still works.
   */
  auto?: boolean;
  /** Where to note an empty or all-excluded listing, for a tester's report. */
  logger?: Logger;
}

/**
 * List the worker groups through the port and hold the outcome.
 *
 * Only the LATEST call may write state: StrictMode's double effect and a
 * Retry pressed while a slow call is still out would otherwise let whichever
 * settles last win, which can put a stale error beside a fresh list.
 */
export function useStreamWorkerGroups(
  cribl: CriblClient,
  options: UseStreamWorkerGroupsOptions = {},
): { state: WorkerGroupsState; reload: () => void } {
  const { auto = true, logger } = options;
  const [state, setState] = useState<WorkerGroupsState>(auto ? LOADING : IDLE);
  const sequence = useRef(0);

  const reload = useCallback(() => {
    sequence.current += 1;
    const mine = sequence.current;
    setState(LOADING);
    void (async () => {
      try {
        const groups = streamWorkerGroups(await cribl.listGroups());
        if (mine !== sequence.current) return;
        if (groups.stream.kind !== "rows") {
          // The ids and products are what tell "the role sees nothing" from
          // "the role sees only Edge fleets" when a tester sends their log.
          logger?.info("worker-groups: no Stream worker group listed", {
            streamListing: groups.stream.kind,
            excluded: groups.excluded
              .map((g) => `${g.id}:${g.product ?? "unreported"}`)
              .join(","),
          });
        }
        setState({ kind: "loaded", groups });
      } catch (err) {
        if (mine !== sequence.current) return;
        setState({ kind: "failed", error: String(err) });
      }
    })();
  }, [cribl, logger]);

  useEffect(() => {
    if (auto) reload();
    // A call still out when the screen unmounts or the client changes must
    // not land afterwards.
    return () => {
      sequence.current += 1;
    };
  }, [auto, reload]);

  return { state, reload };
}

/**
 * The listed Stream worker groups, or an empty array. For pickers and id
 * lists only - NEVER for a count or a claim about how many exist; the empty
 * cases are {@link WorkerGroupField}'s to word.
 */
export function streamGroupRows(state: WorkerGroupsState): readonly CriblGroupSummary[] {
  return state.kind === "loaded" ? listingRows(state.groups.stream) : [];
}

/**
 * Preselect a group once the listing lands: the saved default when it is in
 * the live list, else the first listed group - and never over a choice the
 * operator (or an earlier load) already made.
 */
export function useInitialWorkerGroup(
  state: WorkerGroupsState,
  preferred: string,
  setGroupId: (update: (current: string) => string) => void,
): void {
  useEffect(() => {
    const rows = streamGroupRows(state);
    if (rows.length === 0) return;
    const pick = rows.some((g) => g.id === preferred) ? preferred : rows[0]!.id;
    setGroupId((current) => (current !== "" ? current : pick));
  }, [state, preferred, setGroupId]);
}

/**
 * The sentence for a listing with no Stream worker group, or null when there
 * are some. Pure, so the wording is pinned without mounting anything.
 */
export function noStreamGroupsText(groups: StreamWorkerGroupListing): string | null {
  if (groups.stream.kind === "rows") return null;
  if (groups.stream.kind === "none") {
    // EARNED: rows were read and every one is excluded, so the number and the
    // names are measured facts.
    const n = groups.excluded.length;
    const found = groups.excluded
      .map((g) => `${g.id} (${g.product ?? "unreported"})`)
      .join(", ");
    return (
      `Cribl returned ${String(n)} group${n === 1 ? "" : "s"}, but none is a ` +
      `Stream worker group: ${found}. This app deploys to Stream worker groups only.`
    );
  }
  // NOT EARNED: an empty answer is what a role - or an app grant - that covers
  // no group receives, so it must not read as "this workspace has none".
  return (
    "Cribl returned no worker groups this account can see. That does not mean " +
    "none exist: your Cribl role may not grant access to any worker group, or " +
    "an Org admin may need to re-approve this app's policies after an upgrade."
  );
}
