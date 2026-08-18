/**
 * TablePickerSection - choose an EXISTING workspace table to run the DCR gap
 * analysis against (backlog item 2, requested 2026-08-06).
 *
 * Until now the gap analysis could only aim at a schema derived from the
 * solution/sample path. This points it at a table that actually exists, with
 * ARM as the authority for its columns.
 *
 * THE CAPABILITY RULES THIS IS THE FIRST FEATURE TO EXERCISE (the nav aside).
 * All three live in table-picker-state and are consumed here rather than
 * re-decided:
 *
 *   1. A denied `table.read` ANNOTATES; it never hides or disables. Load stays
 *      pressable whatever the audit says, because a stale or wrong audit must
 *      not cost the operator the attempt, and Azure's own 403 is the real gate.
 *   2. Reads have NO fallback artifact. There is no "download the thing someone
 *      else runs" for a listing, so the note IS the whole answer - this panel
 *      deliberately offers nothing beside it.
 *   3. An empty result is only a ZERO once the read was verified
 *      (docs/inventory-standard.md, BINDING). Before a load the count line says
 *      nothing has been loaded; after one, emptyTableListMessage decides
 *      whether "no tables" is a fact about the workspace or about our sight.
 *
 * IT LOADS; IT DOES NOT SELECT (user, 2026-08-18). Selection is PER LOG TYPE,
 * on each mapping-review card, because a solution's log types can land in
 * different tables - CrowdStrike spreads across several, and each table is its
 * own DCR and its own Sentinel destination in the built pack. A single
 * whole-analysis picker could not express that, so this panel's job is to make
 * the real tables available and say honestly whether it could see them; the
 * choice belongs beside the log type it applies to.
 *
 * Selecting a table REPLACES the derived destination schema for that table and
 * re-runs the analysis (user decision 2026-08-10). The previous results are
 * marked stale rather than cleared - see ANALYSIS_STALE_NOTICE.
 */

import { useCallback, useMemo, useState } from "react";
import { listWorkspaceTables } from "@soc/core";
import type {
  CapabilityContext,
  CapabilitySet,
  WorkspaceTable,
  WorkspaceTablesTarget,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { InfoTip } from "../../components/info-tip";
import {
  deriveTablePickerAccess,
  emptyTableListMessage,
  filterTables,
  tableCountLabel,
} from "./table-picker-state";

export interface TablePickerSectionProps {
  /** The committed workspace this picker lists. */
  target: WorkspaceTablesTarget;
  /** Measured capabilities; the audit already covers `table.read`. */
  capabilities: CapabilitySet;
  capabilityContext: CapabilityContext;
  /**
   * The loaded tables, handed up so the per-log-type selectors can offer them.
   * Called with [] when a listing completed and found none.
   */
  onTablesLoaded: (tables: readonly WorkspaceTable[]) => void;
}

export function TablePickerSection({
  target,
  capabilities,
  capabilityContext,
  onTablesLoaded,
}: TablePickerSectionProps) {
  const { ports } = usePorts();
  const [tables, setTables] = useState<WorkspaceTable[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether a listing has COMPLETED. Distinct from `tables.length === 0`,
  // which cannot tell "not loaded" from "loaded and empty" - and those two
  // owe the operator different sentences (rule 3).
  const [loaded, setLoaded] = useState(false);

  const access = useMemo(
    () => deriveTablePickerAccess(capabilities, capabilityContext),
    [capabilities, capabilityContext],
  );
  const shown = useMemo(() => filterTables(tables, query), [tables, query]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const found = await listWorkspaceTables(ports.azure, target, ports.logger);
      setTables(found);
      setLoaded(true);
      onTablesLoaded(found);
    } catch (err) {
      // Surfaced verbatim rather than folded into the empty state: a 403 here
      // is the meaningful answer, and showing it as "no tables" would be the
      // exact confident-wrong-answer this feature exists to avoid.
      setError(err instanceof Error ? err.message : String(err));
      setTables([]);
      setLoaded(false);
      onTablesLoaded([]);
    } finally {
      setLoading(false);
    }
  }, [ports.azure, ports.logger, target, onTablesLoaded]);

  const empty = loaded && tables.length === 0 ? emptyTableListMessage(capabilities, capabilityContext) : null;

  return (
    <div className="table-picker">
      <p className="panel-desc">
        Load the tables that already exist in <code>{target.workspaceName}</code>,
        then point each log type at one from its own Destination table selector
        below.
        <InfoTip text="Each log type chooses its own destination table, because a solution's log types can land in different tables - and each table becomes its own DCR and its own Sentinel destination in the built pack, with the route sending that log type to the matching pipeline and destination. Choosing a table that exists replaces the derived schema with the live columns from Azure and re-runs the analysis for that log type; blending the two would produce a schema matching neither." />
      </p>

      {/* Rule 1: annotate, never hide or disable. Rule 2: nothing is offered
          beside the note, because a listing has no offline substitute. */}
      {access.note !== null && (
        <div className="table-picker-note">{access.note}</div>
      )}

      <div className="table-picker-controls">
        <button
          type="button"
          className="run-button"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? "Loading..." : loaded ? "Reload tables" : "Load tables"}
        </button>
        <input
          className="table-picker-filter"
          type="text"
          value={query}
          aria-label="Filter tables"
          placeholder="Filter by name..."
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error !== null && <div className="table-picker-error">{error}</div>}

      {empty !== null ? (
        <p className="panel-desc">{empty.text}</p>
      ) : (
        <>
          <ul className="table-picker-list">
            {shown.map((table) => (
              <li key={table.name} className="table-picker-row">
                <code className="table-picker-pick">{table.name}</code>
                <span className="table-picker-kind">{table.kind}</span>
                {table.plan !== "" && (
                  <span className="table-picker-plan">{table.plan}</span>
                )}
              </li>
            ))}
          </ul>
          <span className="field-hint">
            {tableCountLabel(tables.length, shown.length)}
          </span>
        </>
      )}
    </div>
  );
}
