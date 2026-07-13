/**
 * DcrInventoryPanel - the Inventory tab of the DCR Automation screen (user
 * request 2026-07-13: inventory existing DCRs and update them). Lists the
 * committed resource group's Data Collection Rules with the details that
 * matter operationally (target tables, immutable id, ingestion endpoint,
 * provisioning state). Updating rides the Single tab: run the table with
 * "Update existing DCR in place" checked and the deploy PUTs the
 * freshly-built body over the existing DCR.
 */

import { useCallback, useState } from "react";
import {
  CUSTOM_COLUMN_TYPES,
  addTableColumn,
  listDcrInventory,
  previewDcrUpdate,
  updateDcrInPlace,
} from "@soc/core";
import type { DcrInventoryEntry, DcrUpdatePreview } from "@soc/core";
import { usePorts } from "../../ports-context";

/** Render a column list compactly: "Name:type, Name:type". */
function columnList(columns: ReadonlyArray<{ name: string; type: string }>): string {
  return columns.map((c) => `${c.name}:${c.type}`).join(", ");
}

export function DcrInventoryPanel() {
  const { ports, config } = usePorts();
  const [entries, setEntries] = useState<DcrInventoryEntry[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // The open preview (one at a time): before/after of updating that DCR
  // from its table's current schema (user request 2026-07-13).
  const [preview, setPreview] = useState<DcrUpdatePreview | null>(null);
  const [previewLocation, setPreviewLocation] = useState("");
  const [newColName, setNewColName] = useState("");
  const [newColType, setNewColType] = useState("string");

  const scopeReady =
    config.subscriptionId !== "" && config.resourceGroup !== "";

  const scope = useCallback(
    () => ({
      subscriptionId: config.subscriptionId,
      resourceGroup: config.resourceGroup,
      workspaceName: config.workspaceName,
    }),
    [config.subscriptionId, config.resourceGroup, config.workspaceName],
  );

  // Read-only before/after: the DCR's live declaration vs the declaration a
  // rebuild from the table's current schema would install.
  const openPreview = useCallback(
    async (entry: DcrInventoryEntry, table: string) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        setPreview(
          await previewDcrUpdate(ports.azure, {
            ...scope(),
            dcrName: entry.name,
            table,
            location: entry.location,
          }),
        );
        setPreviewLocation(entry.location);
        setNewColName("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPreview(null);
      } finally {
        setBusy(false);
      }
    },
    [ports.azure, scope],
  );

  // Apply = the PUT-over-existing-name upsert, then re-preview so the panel
  // shows the post-update state (before == after when in sync).
  const applyUpdate = useCallback(async () => {
    if (preview === null) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await updateDcrInPlace(ports.azure, {
        ...scope(),
        dcrName: preview.dcrName,
        table: preview.table,
        location: previewLocation,
      });
      setNotice(
        `Updated '${result.dcrName}' in place (${result.columnCount} columns, ` +
          `${result.provisioningState}).`,
      );
      setPreview(
        await previewDcrUpdate(ports.azure, {
          ...scope(),
          dcrName: preview.dcrName,
          table: preview.table,
          location: previewLocation,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [ports.azure, scope, preview, previewLocation]);

  // Add a custom column to the (custom) table, then re-preview - the diff
  // then shows the new column as an addition the DCR update would install.
  const addColumn = useCallback(async () => {
    if (preview === null || newColName.trim() === "") return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await addTableColumn(ports.azure, {
        ...scope(),
        table: preview.table,
        column: { name: newColName.trim(), type: newColType },
      });
      setNotice(
        `Added '${newColName.trim()}' (${newColType}) to ${result.table} - ` +
          "apply the update below to make the DCR accept it.",
      );
      setNewColName("");
      setPreview(
        await previewDcrUpdate(ports.azure, {
          ...scope(),
          dcrName: preview.dcrName,
          table: preview.table,
          location: previewLocation,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [ports.azure, scope, preview, previewLocation, newColName, newColType]);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setEntries(
        await listDcrInventory(ports.azure, {
          subscriptionId: config.subscriptionId,
          resourceGroup: config.resourceGroup,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEntries(null);
    } finally {
      setBusy(false);
    }
  }, [ports.azure, config.subscriptionId, config.resourceGroup]);

  if (!scopeReady) {
    return (
      <p className="panel-desc">
        Commit an Azure target (subscription and resource group) first - the
        inventory lists that resource group's Data Collection Rules.
      </p>
    );
  }

  return (
    <div className="discovery-result">
      <div className="panel-controls">
        <button className="run-button" onClick={() => void load()} disabled={busy}>
          {entries === null ? "Load DCR inventory" : "Refresh"}
        </button>
        <span className="field-hint">
          Resource group: {config.resourceGroup}
        </span>
      </div>
      {error !== "" && <pre className="result">{error}</pre>}
      {notice !== "" && <p className="panel-desc">{notice}</p>}
      {entries !== null && entries.length === 0 && (
        <p className="panel-desc">No Data Collection Rules in this resource group.</p>
      )}
      {entries !== null && entries.length > 0 && (
        <>
          <p className="field-hint">
            Update in place rebuilds the DCR from its table's CURRENT Log
            Analytics schema and overwrites it under the same name - the
            immutable ID and connected clients keep working. For mapping
            changes end to end (Cribl destination included), use the Single
            tab with "Update existing DCR in place" checked.
          </p>
          <table className="match-field-table mapping-review-grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Tables</th>
                <th>Kind</th>
                <th>Location</th>
                <th>State</th>
                <th>Immutable ID</th>
                <th>Ingestion endpoint</th>
                <th>Update</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.name}>
                  <td>{e.name}</td>
                  <td>{e.tables.join(", ") || "-"}</td>
                  <td>{e.kind || "-"}</td>
                  <td>{e.location}</td>
                  <td>{e.provisioningState || "-"}</td>
                  <td>{e.immutableId || "-"}</td>
                  <td>{e.ingestionEndpoint || "-"}</td>
                  <td>
                    {e.kind === "Direct" && e.tables.length > 0 ? (
                      e.tables.map((table) => (
                        <button
                          key={table}
                          className="run-button"
                          disabled={busy || config.workspaceName === ""}
                          title={
                            config.workspaceName === ""
                              ? "Commit a workspace in the Azure target first."
                              : `Show the before/after of rebuilding this DCR from the current ${table} schema.`
                          }
                          onClick={() => void openPreview(e, table)}
                        >
                          {e.tables.length > 1 ? `Preview (${table})` : "Preview update"}
                        </button>
                      ))
                    ) : (
                      <span
                        className="field-hint"
                        title="Only Kind:Direct DCRs with a resolvable target table can be rebuilt here."
                      >
                        not updatable
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview !== null && (
            <div className="pack-card mapping-review-card">
              <div className="pack-card-head mapping-review-card-head">
                <span className="field-label">
                  {preview.dcrName} - update preview ({preview.table})
                </span>
                <button
                  className="gap-reset-button"
                  onClick={() => setPreview(null)}
                  disabled={busy}
                >
                  Close
                </button>
              </div>
              <p className="field-hint">
                Table schema (current): {preview.tableColumns.length} columns.
              </p>
              <p className="field-hint">
                DCR declaration BEFORE: {preview.currentDcrColumns.length}{" "}
                columns - {columnList(preview.currentDcrColumns) || "none"}
              </p>
              <p className="field-hint">
                DCR declaration AFTER: {preview.rebuiltDcrColumns.length}{" "}
                columns - {columnList(preview.rebuiltDcrColumns) || "none"}
              </p>
              {preview.diff.added.length === 0 &&
              preview.diff.removed.length === 0 &&
              preview.diff.retyped.length === 0 ? (
                <p className="panel-desc">
                  In sync - the DCR already matches the table schema
                  ({preview.diff.unchanged} columns).
                </p>
              ) : (
                <>
                  {preview.diff.added.length > 0 && (
                    <p className="panel-desc">
                      Added by the update: {columnList(preview.diff.added)}
                    </p>
                  )}
                  {preview.diff.removed.length > 0 && (
                    <p className="panel-desc">
                      Removed by the update: {columnList(preview.diff.removed)}
                    </p>
                  )}
                  {preview.diff.retyped.length > 0 && (
                    <p className="panel-desc">
                      Retyped:{" "}
                      {preview.diff.retyped
                        .map((r) => `${r.name} (${r.from} to ${r.to})`)
                        .join(", ")}
                    </p>
                  )}
                </>
              )}
              {preview.table.endsWith("_CL") ? (
                <div className="panel-controls">
                  <input
                    aria-label="New column name"
                    placeholder="New column name"
                    value={newColName}
                    onChange={(ev) => setNewColName(ev.target.value)}
                  />
                  <select
                    aria-label="New column type"
                    value={newColType}
                    onChange={(ev) => setNewColType(ev.target.value)}
                  >
                    {CUSTOM_COLUMN_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <button
                    className="run-button"
                    onClick={() => void addColumn()}
                    disabled={busy || newColName.trim() === ""}
                  >
                    Add column to table
                  </button>
                </div>
              ) : (
                <p className="field-hint">
                  Native Azure table - its schema is fixed, so no custom
                  columns can be added here.
                </p>
              )}
              <div className="panel-controls">
                <button
                  className="run-button"
                  onClick={() => void applyUpdate()}
                  disabled={busy}
                >
                  Apply update to {preview.dcrName}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
