/**
 * DcrInventoryPanel - the Inventory tab of the DCR Automation screen (user
 * request 2026-07-13: inventory existing DCRs and update them). Lists the
 * committed resource group's Data Collection Rules with the details that
 * matter operationally (target tables, immutable id, ingestion endpoint,
 * provisioning state). Updating rides the Single tab: run the table with
 * "Update existing DCR in place" checked and the deploy PUTs the
 * freshly-built body over the existing DCR.
 */

import { useCallback, useEffect, useState } from "react";
import {
  CUSTOM_COLUMN_TYPES,
  addTableColumn,
  listDcrInventory,
  listResourceGroups,
  previewDcrUpdate,
  updateDcrInPlace,
} from "@soc/core";
import type { DcrInventoryEntry, DcrUpdatePreview } from "@soc/core";
import { usePorts } from "../../ports-context";
import { SearchableSelect } from "../../components/searchable-select";
import { mergePreviewColumns, summarizePreview } from "./dcr-inventory-state";

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
  // The previewed DCR's DCE id ("" for Kind:Direct) - the rebuild must keep
  // the same variant and endpoint.
  const [previewDce, setPreviewDce] = useState("");
  const [newColName, setNewColName] = useState("");
  const [newColType, setNewColType] = useState("string");
  // Matching (green) columns show by default (user color semantics
  // 2026-07-13: matches ARE the highlight); the toggle hides them when the
  // 150+ chips get in the way of the changes.
  const [showUnchanged, setShowUnchanged] = useState(true);

  const scopeReady =
    config.subscriptionId !== "" && config.resourceGroup !== "";

  // The inventoried resource group is CHANGEABLE (user request 2026-07-13):
  // defaults to the committed target's group, selectable across the
  // subscription. Workspace/table operations stay on the COMMITTED group -
  // only the DCR side follows this selection.
  const [inventoryRg, setInventoryRg] = useState(config.resourceGroup);
  const [rgOptions, setRgOptions] = useState<string[]>(
    config.resourceGroup !== "" ? [config.resourceGroup] : [],
  );
  useEffect(() => {
    if (!scopeReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const groups = await listResourceGroups(ports.azure, config.subscriptionId);
        if (cancelled) return;
        const names = groups.map((g) => g.name);
        if (!names.includes(config.resourceGroup) && config.resourceGroup !== "") {
          names.unshift(config.resourceGroup);
        }
        setRgOptions(names);
      } catch {
        // The listing is a convenience; the committed group stays usable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scopeReady, ports.azure, config.subscriptionId, config.resourceGroup]);

  const scope = useCallback(
    () => ({
      subscriptionId: config.subscriptionId,
      resourceGroup: config.resourceGroup,
      workspaceName: config.workspaceName,
      dcrResourceGroup: inventoryRg,
    }),
    [config.subscriptionId, config.resourceGroup, config.workspaceName, inventoryRg],
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
            dceResourceId: entry.dataCollectionEndpointId || undefined,
          }),
        );
        setPreviewLocation(entry.location);
        setPreviewDce(entry.dataCollectionEndpointId);
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
        dceResourceId: previewDce || undefined,
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
          dceResourceId: previewDce || undefined,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [ports.azure, scope, preview, previewLocation, previewDce]);

  // Add a custom column to the (custom) table AND apply the DCR update in
  // one action (user request 2026-07-13: "add a new field to the DCR and
  // table") - the field lands end to end. If the DCR half fails, the
  // column is already on the table and the diff shows it amber-pending;
  // Apply update retries just that half.
  const addColumn = useCallback(async () => {
    if (preview === null || newColName.trim() === "") return;
    const columnName = newColName.trim();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await addTableColumn(ports.azure, {
        ...scope(),
        table: preview.table,
        column: { name: columnName, type: newColType },
      });
      let dcrUpdated = true;
      try {
        await updateDcrInPlace(ports.azure, {
          ...scope(),
          dcrName: preview.dcrName,
          table: preview.table,
          location: previewLocation,
          dceResourceId: previewDce || undefined,
        });
      } catch (err) {
        dcrUpdated = false;
        setError(
          `Column added to ${preview.table}, but the DCR update failed: ` +
            `${err instanceof Error ? err.message : String(err)} - ` +
            "use Apply update below to retry.",
        );
      }
      setNotice(
        dcrUpdated
          ? `Added '${columnName}' (${newColType}) to ${preview.table} AND ` +
            `updated '${preview.dcrName}' - the field is ingestable end to end.`
          : `Added '${columnName}' (${newColType}) to ${preview.table}.`,
      );
      setNewColName("");
      setPreview(
        await previewDcrUpdate(ports.azure, {
          ...scope(),
          dcrName: preview.dcrName,
          table: preview.table,
          location: previewLocation,
          dceResourceId: previewDce || undefined,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [ports.azure, scope, preview, previewLocation, previewDce, newColName, newColType]);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      setEntries(
        await listDcrInventory(ports.azure, {
          subscriptionId: config.subscriptionId,
          resourceGroup: inventoryRg,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEntries(null);
    } finally {
      setBusy(false);
    }
  }, [ports.azure, config.subscriptionId, inventoryRg]);

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
        <label className="field">
          <span className="field-label">Resource group</span>
          <SearchableSelect
            options={rgOptions.map((name) => ({ value: name, label: name }))}
            value={inventoryRg}
            onChange={(value) => {
              setInventoryRg(value);
              setEntries(null);
              setPreview(null);
            }}
            placeholder="Select a resource group..."
            ariaLabel="Filter resource groups"
          />
        </label>
        <button
          className="run-button"
          onClick={() => void load()}
          disabled={busy || inventoryRg === ""}
        >
          {entries === null ? "Load DCR inventory" : "Refresh"}
        </button>
        {inventoryRg !== config.resourceGroup && (
          <span className="field-hint">
            Browsing '{inventoryRg}' - table and schema operations stay on the
            committed workspace in '{config.resourceGroup}'.
          </span>
        )}
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
                    {(() => {
                      // Updatable: a Kind:Direct ingestion DCR, or a
                      // DCE-based one (no kind, but a DCE id + custom
                      // stream declarations). Agent/workspace-transform
                      // DCRs have neither shape and cannot be rebuilt from
                      // a table schema.
                      const dceBased =
                        e.dataCollectionEndpointId !== "" &&
                        e.streamDeclarationCount > 0;
                      const updatable =
                        e.tables.length > 0 && (e.kind === "Direct" || dceBased);
                      if (!updatable) {
                        const why =
                          e.tables.length === 0
                            ? "no destination table is resolvable from its dataFlows"
                            : `kind '${e.kind || "none"}' is not a Direct or DCE-based ingestion DCR (agent and workspace-transform DCRs are not schema-rebuildable)`;
                        return (
                          <span className="field-hint" title={why}>
                            not updatable - {e.tables.length === 0 ? "no table" : `kind '${e.kind || "none"}'`}
                          </span>
                        );
                      }
                      return e.tables.map((table) => (
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
                      ));
                    })()}
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
              <p className="panel-desc">{summarizePreview(preview)}</p>
              {(() => {
                const chips = mergePreviewColumns(preview);
                const changed = chips.filter((c) => c.status !== "unchanged");
                const unchanged = chips.filter((c) => c.status === "unchanged");
                return (
                  <>
                    <p className="field-hint dcr-chip-legend">
                      <span className="dcr-col-chip dcr-col-unchanged">matches table</span>
                      <span className="dcr-col-chip dcr-col-removed">DCR only - removed by update</span>
                      <span className="dcr-col-chip dcr-col-retyped">type differs - retyped by update</span>
                      <span className="dcr-col-chip dcr-col-added">table only - added by update</span>
                    </p>
                    <div className="dcr-chip-grid">
                      {changed.map((c) => (
                        <span
                          key={`${c.status}-${c.name}`}
                          className={`dcr-col-chip dcr-col-${c.status}`}
                          title={
                            c.status === "retyped"
                              ? `${c.name}: ${c.fromType} becomes ${c.type}`
                              : `${c.name} (${c.type}) - ${c.status} by this update`
                          }
                        >
                          {c.name}
                          <span className="dcr-col-type">
                            {c.status === "retyped"
                              ? `${c.fromType} to ${c.type}`
                              : c.type}
                          </span>
                        </span>
                      ))}
                      {showUnchanged &&
                        unchanged.map((c) => (
                          <span
                            key={`u-${c.name}`}
                            className="dcr-col-chip dcr-col-unchanged"
                            title={`${c.name} (${c.type}) - matches the table schema`}
                          >
                            {c.name}
                            <span className="dcr-col-type">{c.type}</span>
                          </span>
                        ))}
                    </div>
                    {unchanged.length > 0 && (
                      <button
                        className="gap-reset-button"
                        onClick={() => setShowUnchanged((v) => !v)}
                      >
                        {showUnchanged
                          ? `Hide ${unchanged.length} matching column${unchanged.length === 1 ? "" : "s"}`
                          : `Show ${unchanged.length} matching column${unchanged.length === 1 ? "" : "s"}`}
                      </button>
                    )}
                  </>
                );
              })()}
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
                    Add to table and DCR
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
