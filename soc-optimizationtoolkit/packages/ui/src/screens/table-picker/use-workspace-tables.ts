/**
 * The workspace's table listing - ONE fetch, no surface of its own.
 *
 * WHY THIS IS A HOOK AND NOT A PANEL (user, 2026-08-18). It was a panel:
 * TablePickerSection, which listed every table in the workspace so the operator
 * could choose ONE for the whole analysis. When the choice became per log type
 * (1.11.13) that panel lost its job and kept its entire UI - a filter box, a
 * ~842-row list, a count line - none of which anyone could act on. Its own
 * header said so out loud: "IT LOADS; IT DOES NOT SELECT."
 *
 * The fetch still belongs above the cards, and this is the reason it is not per
 * log type: the workspace's table inventory is ONE FACT. 842 tables exist
 * regardless of how many log types are being analysed. What is per log type is
 * the CHOICE over that fact, which is why the dropdowns are on the cards and the
 * listing is one shared call rather than N identical ones.
 *
 * So: fetch here, choose there, and render nothing unless something went wrong.
 *
 * THE THREE CAPABILITY RULES STILL HOLD, two of them now structurally rather
 * than by annotation:
 *
 *   1. A denied `table.read` never removes the attempt. There is no longer a
 *      button to disable or a panel to hide - the listing is unconditional, so
 *      the rule cannot be violated by construction. The pre-emptive "this may
 *      fail" annotation went with the panel: auto-load means the real answer
 *      arrives in the same second, and guessing at it first was noise.
 *   2. Reads have NO fallback artifact. The note offers a retry and nothing
 *      else, because there is no offline substitute for a listing.
 *   3. An empty result is only a ZERO once the read was verified
 *      (docs/inventory-standard.md, BINDING) - {@link emptyTableListMessage}
 *      still decides that, and it is the only reason capabilities are passed in.
 *
 * A FAILURE IS NOT RETRIED AUTOMATICALLY. The load clears `loaded` on error, so
 * a guard keyed on that would re-fire on every render and turn one 403 into a
 * request storm. The note carries a deliberate retry instead.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listWorkspaceTables } from "@soc/core";
import type {
  CapabilityContext,
  CapabilitySet,
  WorkspaceTable,
  WorkspaceTablesTarget,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { emptyTableListMessage } from "./table-picker-state";

/** An honest note about a listing that degraded, with the way to re-attempt. */
export interface WorkspaceTablesNote {
  text: string;
  onRetry: () => void;
}

export interface WorkspaceTablesState {
  /** Table names, for the per-log-type destination selectors. */
  names: readonly string[];
  /** The full rows, so a caller can show what kind of table each one is. */
  tables: readonly WorkspaceTable[];
  /**
   * Null while the listing is in flight AND when it succeeded with results -
   * the two states with nothing to say. A silent success is the point: the
   * operator sees the tables in the dropdowns, which is the only evidence that
   * matters.
   */
  note: WorkspaceTablesNote | null;
  loading: boolean;
}

export interface UseWorkspaceTablesInput {
  target: WorkspaceTablesTarget;
  capabilities: CapabilitySet;
  capabilityContext: CapabilityContext;
  /**
   * Whether the workspace is committed enough to list against. False before the
   * scope is set, where the target's three fields are still blank and a listing
   * would be a request against nothing.
   *
   * A GATE ON THE WORKSPACE, NOT ON THE VERDICT - the distinction is rule 1. It
   * is fine to wait for an address; it is never fine to skip the attempt because
   * the audit expects it to fail.
   */
  enabled: boolean;
}

export function useWorkspaceTables({
  target,
  capabilities,
  capabilityContext,
  enabled,
}: UseWorkspaceTablesInput): WorkspaceTablesState {
  const { ports } = usePorts();
  const [tables, setTables] = useState<readonly WorkspaceTable[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether a listing has COMPLETED. Distinct from `tables.length === 0`, which
  // cannot tell "not loaded" from "loaded and empty" - and those two owe the
  // operator different sentences (rule 3).
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const found = await listWorkspaceTables(ports.azure, target, ports.logger);
      setTables(found);
      setLoaded(true);
    } catch (err) {
      // Surfaced verbatim rather than folded into the empty state: a 403 here is
      // the meaningful answer, and showing it as "no tables" would be the exact
      // confident wrong answer the inventory standard was written against.
      setError(err instanceof Error ? err.message : String(err));
      setTables([]);
      setLoaded(false);
    } finally {
      setLoading(false);
    }
  }, [ports.azure, ports.logger, target]);

  // ONCE PER WORKSPACE, never once per mount. The screen rebuilds `target`
  // inline from three config fields, so its identity changes on every render and
  // an effect keyed on the object itself would re-list on every keystroke
  // elsewhere on the page. The ref key is the workspace, not the object.
  const listedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const key = `${target.subscriptionId}/${target.resourceGroup}/${target.workspaceName}`;
    if (listedFor.current === key) return;
    listedFor.current = key;
    void load();
  }, [enabled, target, load]);

  let note: WorkspaceTablesNote | null = null;
  if (error !== null) {
    note = {
      text:
        `The workspace table listing failed, so the destination selectors below ` +
        `offer only this solution's tables and the common natives: ${error}`,
      onRetry: () => void load(),
    };
  } else if (loaded && tables.length === 0) {
    // Rule 3: whether this is a fact about the workspace or about our sight is
    // decided by the measured capability, not by the empty array.
    note = {
      text: emptyTableListMessage(capabilities, capabilityContext).text,
      onRetry: () => void load(),
    };
  }

  return {
    names: tables.map((table) => table.name),
    tables,
    note,
    loading,
  };
}
