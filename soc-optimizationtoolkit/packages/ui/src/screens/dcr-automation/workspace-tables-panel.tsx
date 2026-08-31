/**
 * WorkspaceTablesPanel - the Tables tab of the DCR Automation screen (TBL-3,
 * placement settled by TBL-5). Lists the workspace's Log Analytics tables with
 * the fact that matters operationally here: whether a DCR already targets each
 * one.
 *
 * NOT A REVIVAL OF `TablePickerSection`, which was deleted 2026-08-18. That
 * panel was a PICKER whose job - choose one table for the whole analysis -
 * moved onto the per-log-type mapping-review cards, leaving it listing ~842
 * rows nobody selected from; its own header read "IT LOADS; IT DOES NOT
 * SELECT". This one is an operational inventory with an action per row,
 * standing to tables exactly as DcrInventoryPanel stands to DCRs. Three of
 * that deletion's rules are honoured deliberately:
 *
 *   - IT DOES NOT AUTO-LOAD. The listing runs on a button press, because one
 *     403 against an ~842-row listing would otherwise become a request storm
 *     on every mount. This is also why `useWorkspaceTables` is NOT reused: it
 *     loads on an effect and its `listedFor` guard means a second load for the
 *     same workspace never happens, so it cannot serve a Refresh at all.
 *   - NO FILTER BOX. `filterTables` went with the panel. A filter is
 *     defensible once rows are actionable, but it must be written fresh with
 *     its own pins rather than resurrected under the old name.
 *   - NO PRE-LOAD "this may fail" ANNOTATION. `deriveTablePickerAccess`
 *     predicted what the load would do; the real answer arrives in the same
 *     second, and a prediction that disagreed with the outcome would be two
 *     answers to one question.
 *
 * THE LOAD BUTTON IS NEVER DISABLED BY A CAPABILITY VERDICT. Rule 1 of the
 * capability model - a denied verdict annotates, it never removes the attempt -
 * used to hold here by construction, because there was no button. Adding one
 * puts the rule back in play, so `disabled` may reference only in-flight state
 * and a blank scope. Azure's own 403 is the gate, and it is reported verbatim.
 */

import { useCallback, useState } from "react";
import {
  createCustomTable,
  emptyCapabilitySet,
  listDcrInventory,
  listWorkspaceTables,
} from "@soc/core";
import type {
  CapabilityContext,
  CapabilitySet,
  DcrInventoryEntry,
  WorkspaceTable,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { emptyTableListMessage } from "../table-picker/table-picker-state";
import {
  buildWorkspaceTableRows,
  checkTableName,
  dcrCellLabel,
  dcrColumnNote,
} from "./workspace-tables-state";
import { ManualSchemaEditor } from "../../onboarding/manual-schema-editor";
import {
  addManualColumn,
  emptyManualColumns,
  manualColumnsToSchema,
  manualRowStatuses,
  manualSchemaErrors,
  removeManualColumn,
  updateManualColumn,
} from "../../onboarding/manual-schema-state";
import type { ManualColumnDraft } from "../../onboarding/manual-schema-state";

export interface WorkspaceTablesPanelProps {
  /** What the connected identity was measured to be able to do. */
  capabilities?: CapabilitySet;
  /** Connection facts for resolving unmeasured capabilities. */
  capabilityContext?: CapabilityContext;
  /**
   * Notified when the operator opens the create-table form. OPTIONAL and
   * informational only - the panel owns the form itself, so a host that
   * passes nothing still gets full creation.
   */
  onCreateTable?: () => void;
  /**
   * Start a DCR for one table. OPTIONAL for the same reason - a button that
   * went nowhere would be worse than no button.
   */
  onCreateDcr?: (table: string) => void;
}

export function WorkspaceTablesPanel(props: WorkspaceTablesPanelProps = {}) {
  const { capabilities, capabilityContext, onCreateTable, onCreateDcr } = props;
  const { ports, config } = usePorts();
  const logger = ports.logger;

  const [tables, setTables] = useState<WorkspaceTable[] | null>(null);
  // null = the DCR listing was not read. Never [] for that case: an empty
  // array is a measured zero and null is an absence of measurement.
  const [dcrs, setDcrs] = useState<DcrInventoryEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The create-table flow (TBL-1 + TBL-2). Azure-only: creating a table needs
  // no Cribl worker group and no ingestion client id, which is the whole
  // reason it lives here rather than behind the Single tab's Run.
  const [creating, setCreating] = useState(false);
  const [newTable, setNewTable] = useState("");
  const [newColumns, setNewColumns] = useState<ManualColumnDraft[]>(
    emptyManualColumns,
  );
  const [createBusy, setCreateBusy] = useState(false);
  const [createResult, setCreateResult] = useState("");

  const scopeReady =
    config.subscriptionId !== "" &&
    config.resourceGroup !== "" &&
    config.workspaceName !== "";

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    logger?.info(
      `workspace-tables: listing tables in '${config.workspaceName}'`,
    );
    try {
      const listed = await listWorkspaceTables(ports.azure, {
        subscriptionId: config.subscriptionId,
        resourceGroup: config.resourceGroup,
        workspaceName: config.workspaceName,
      });
      setTables(listed);
      logger?.info(`workspace-tables: ${listed.length} table(s)`);

      // The DCR side is a SEPARATE, non-fatal read: the tables listing is the
      // panel's job and a DCR listing failure must degrade the one column
      // rather than lose the whole page. Left as null on failure, which the
      // row builder renders as "not checked".
      try {
        const entries = await listDcrInventory(ports.azure, {
          subscriptionId: config.subscriptionId,
          resourceGroup: config.resourceGroup,
        });
        setDcrs(entries);
      } catch (err) {
        setDcrs(null);
        logger?.info(
          "workspace-tables: DCR listing unavailable, the DCR column reads " +
            `'not checked' - ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTables(null);
      setDcrs(null);
      setError(message);
      logger?.error(`workspace-tables: listing failed - ${message}`);
    } finally {
      setBusy(false);
    }
  }, [
    ports.azure,
    logger,
    config.subscriptionId,
    config.resourceGroup,
    config.workspaceName,
  ]);

  const nameCheck = checkTableName(newTable, tables);
  const schemaErrors = manualSchemaErrors(newColumns);
  const schemaColumns = manualColumnsToSchema(newColumns);
  // Every reason Create is not available, first one shown. Ordered from the
  // operator's own input outward, so the message names what they can fix.
  const createDisabledReason =
    newTable.trim() === ""
      ? "Name the table first."
      : !newTable.trim().endsWith("_CL")
        ? "A custom table name must end with _CL."
        : nameCheck.blocking
          ? nameCheck.message
          : schemaColumns.length === 0
            ? "Add at least one field."
            : schemaErrors.length > 0
              ? schemaErrors[0]
              : null;

  const create = useCallback(async () => {
    setCreateBusy(true);
    setCreateResult("");
    try {
      const result = await createCustomTable(ports.azure, {
        subscriptionId: config.subscriptionId,
        resourceGroup: config.resourceGroup,
        workspaceName: config.workspaceName,
        table: newTable.trim(),
        columns: manualColumnsToSchema(newColumns),
      });
      setCreateResult(
        result.created
          ? `Created ${result.tableName} with ${result.columnCount} columns ` +
              `(retention ${result.retentionInDays}/${result.totalRetentionInDays} days).`
          : `${result.tableName} already existed - nothing was written.`,
      );
      logger?.info(
        `workspace-tables: create ${result.tableName} - ` +
          (result.created ? "created" : "already existed"),
      );
      // Re-list so the new table appears and the name check sees it.
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCreateResult(message);
      logger?.error(`workspace-tables: create failed - ${message}`);
    } finally {
      setCreateBusy(false);
    }
    // `load` is intentionally in the deps: re-listing after a create is part
    // of this action, not a side effect someone else owns.
  }, [
    ports.azure,
    logger,
    config.subscriptionId,
    config.resourceGroup,
    config.workspaceName,
    newTable,
    newColumns,
    load,
  ]);

  const rows = tables === null ? [] : buildWorkspaceTableRows(tables, dcrs);
  const emptyMessage = emptyTableListMessage(
    capabilities ?? emptyCapabilitySet(),
    capabilityContext ?? { azureIdentityPresent: true, criblReachable: true },
  );

  return (
    <div className="panel">
      <p className="panel-desc">
        Every Log Analytics table in {config.workspaceName || "the workspace"},
        and whether a data collection rule already targets it. Listing is
        read-only.
      </p>
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void load()}
          disabled={busy || !scopeReady}
          title={
            scopeReady
              ? undefined
              : "Select a subscription, resource group and workspace first."
          }
        >
          {busy ? "Loading..." : tables === null ? "Load tables" : "Refresh"}
        </button>
        <button
          className="run-button"
          onClick={() => {
            setCreating(!creating);
            setCreateResult("");
            onCreateTable?.();
          }}
          disabled={busy || createBusy}
          title="Define a new custom table's fields and types"
        >
          {creating ? "Cancel" : "Create table"}
        </button>
      </div>
      {error !== "" && <pre className="result">{error}</pre>}
      {creating && (
        <div className="panel create-table-form">
          <p className="panel-desc">
            Creates the Log Analytics table only - no data collection rule and
            no Cribl destination. Azure-managed columns are removed from the
            payload and TimeGenerated is added when absent.
          </p>
          <label className="field">
            <span className="field-label">Table name</span>
            <input
              type="text"
              placeholder="MyApp_CL"
              value={newTable}
              autoComplete="off"
              spellCheck={false}
              disabled={createBusy}
              onChange={(ev) => setNewTable(ev.target.value)}
            />
            {/* The name check ANNOTATES on an unread listing and BLOCKS only
                on a measured collision - an unread listing cannot say a name
                is free. */}
            {nameCheck.message !== null && (
              <span
                className={
                  nameCheck.blocking
                    ? "field-hint enrich-issue"
                    : "field-hint"
                }
              >
                {nameCheck.message}
              </span>
            )}
          </label>
          <ManualSchemaEditor
            rows={newColumns}
            statuses={manualRowStatuses(newColumns)}
            onAdd={() => setNewColumns(addManualColumn(newColumns))}
            onRemove={(id) => setNewColumns(removeManualColumn(newColumns, id))}
            onEdit={(id, patch) =>
              setNewColumns(updateManualColumn(newColumns, id, patch))
            }
            busy={createBusy}
          />
          <div className="panel-controls">
            <button
              className="run-button"
              onClick={() => void create()}
              disabled={createBusy || createDisabledReason !== null}
              title={createDisabledReason ?? undefined}
            >
              {createBusy ? "Creating..." : "Create table"}
            </button>
            {createDisabledReason !== null && !createBusy && (
              <span className="field-hint">{createDisabledReason}</span>
            )}
          </div>
          {createResult !== "" && <pre className="result">{createResult}</pre>}
        </div>
      )}
      {tables !== null && tables.length === 0 && (
        <p className="field-hint">{emptyMessage.text}</p>
      )}
      {rows.length > 0 && (
        <>
          <p className="field-hint">{dcrColumnNote(config.resourceGroup)}</p>
          {/* `match-field-table mapping-review-grid` is the styled table pair
              this app actually uses (dcr-inventory-panel.tsx:588). There is no
              `.inventory-table` in the sheet - see DBT-39 for the four class
              names already shipping that render as bare markup. */}
          <table className="match-field-table mapping-review-grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Retention</th>
                <th>Plan</th>
                <th>Data collection rule</th>
                {onCreateDcr !== undefined && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td>{row.kind}</td>
                  <td>{row.retentionLabel}</td>
                  <td>{row.planLabel}</td>
                  <td>{dcrCellLabel(row, config.resourceGroup)}</td>
                  {onCreateDcr !== undefined && (
                    <td>
                      <button
                        className="gap-reset-button"
                        onClick={() => onCreateDcr(row.name)}
                        disabled={busy}
                        title={
                          row.dcr === "has"
                            ? `Already targeted by ${row.dcrNames.join(", ")} - creating another is usually not what you want`
                            : `Create a data collection rule for ${row.name}`
                        }
                      >
                        Create DCR
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
