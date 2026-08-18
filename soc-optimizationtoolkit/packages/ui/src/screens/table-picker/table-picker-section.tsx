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
 * Selecting a table REPLACES the derived destination schema and re-runs the
 * analysis (user decision 2026-08-10). The previous results are marked stale
 * rather than cleared, which the caller renders - see ANALYSIS_STALE_NOTICE.
 */

import { useCallback, useMemo, useState } from "react";
import {
  fetchWorkspaceTableSchema,
  listWorkspaceTables,
} from "@soc/core";
import type {
  CapabilityContext,
  CapabilitySet,
  DestField,
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
  /** The table currently driving the gap analysis, if any. */
  selectedTable: string | null;
  /**
   * A table was chosen and its LIVE schema fetched. The caller replaces the
   * derived destination schema with these fields and re-runs the analysis;
   * null means the table exists but exposes no usable columns yet, which is a
   * real state for a provisioned-but-unmaterialized table.
   */
  onTableSelected: (table: string, schema: DestField[] | null) => void;
}

export function TablePickerSection({
  target,
  capabilities,
  capabilityContext,
  selectedTable,
  onTableSelected,
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
  const [selecting, setSelecting] = useState<string | null>(null);

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
    } catch (err) {
      // Surfaced verbatim rather than folded into the empty state: a 403 here
      // is the meaningful answer, and showing it as "no tables" would be the
      // exact confident-wrong-answer this feature exists to avoid.
      setError(err instanceof Error ? err.message : String(err));
      setTables([]);
      setLoaded(false);
    } finally {
      setLoading(false);
    }
  }, [ports.azure, ports.logger, target]);

  const select = useCallback(
    async (table: string) => {
      setSelecting(table);
      setError(null);
      try {
        const schema = await fetchWorkspaceTableSchema(
          ports.azure,
          target,
          table,
          ports.logger,
        );
        onTableSelected(table, schema);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSelecting(null);
      }
    },
    [ports.azure, ports.logger, target, onTableSelected],
  );

  const empty = loaded && tables.length === 0 ? emptyTableListMessage(capabilities, capabilityContext) : null;

  return (
    <div className="table-picker">
      <p className="panel-desc">
        Run the gap analysis against a table that already exists in{" "}
        <code>{target.workspaceName}</code>, using its live schema from Azure
        instead of one derived from the solution.
        <InfoTip text="Selecting a table replaces the destination schema the analysis was using and re-runs it. Azure is the better authority once a real table is named, so the live columns REPLACE the derived ones rather than being merged - blending the two would produce a schema matching neither. The derived path still covers tables that do not exist until a connector is enabled." />
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
                <button
                  type="button"
                  className={
                    table.name === selectedTable
                      ? "table-picker-pick table-picker-pick-selected"
                      : "table-picker-pick"
                  }
                  onClick={() => void select(table.name)}
                  disabled={selecting !== null}
                >
                  {table.name}
                </button>
                <span className="table-picker-kind">{table.kind}</span>
                {table.plan !== "" && (
                  <span className="table-picker-plan">{table.plan}</span>
                )}
                {selecting === table.name && (
                  <span className="field-hint">reading schema...</span>
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
