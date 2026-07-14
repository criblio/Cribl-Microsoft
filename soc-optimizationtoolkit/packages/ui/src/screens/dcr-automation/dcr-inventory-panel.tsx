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
  DCR_WRITE_ACTION,
  addDcrField,
  addTableColumn,
  checkDcrUpdatePermissions,
  listDcrInventory,
  listResourceGroups,
  previewDcrUpdate,
  removeTableColumn,
  updateDcrInPlace,
} from "@soc/core";
import type { DcrInventoryEntry, DcrUpdatePreview } from "@soc/core";
import { usePorts } from "../../ports-context";
import { SearchableSelect } from "../../components/searchable-select";
import { mergePreviewColumns, summarizePreview } from "./dcr-inventory-state";

export function DcrInventoryPanel() {
  const { ports, config } = usePorts();
  // Every button narrates to the Logs page (user request 2026-07-13).
  const logger = ports.logger;
  const logInfo = useCallback(
    (line: string) => logger?.info(`dcr-inventory: ${line}`),
    [logger],
  );
  const logError = useCallback(
    (line: string) => logger?.error(`dcr-inventory: ${line}`),
    [logger],
  );
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
  // Live phase line while a multi-step action runs (user request
  // 2026-07-13: show the progress of the update).
  const [progress, setProgress] = useState("");
  const [newColName, setNewColName] = useState("");
  const [newColType, setNewColType] = useState("string");
  const [removeColName, setRemoveColName] = useState("");
  // Pre-update permission check (user request 2026-07-13): the write
  // actions are verified when the preview opens; missing ones disable the
  // mutating buttons with the exact action and scope named. Fail-open when
  // the permissions API is unreadable.
  const [missingActions, setMissingActions] = useState<
    Array<{ action: string; scope: string }>
  >([]);
  // The check's verdict, rendered in the card AND stamped onto every
  // failure message (live feedback 2026-07-13: "it should still have told
  // me if the permissions were correct").
  const [permStatus, setPermStatus] = useState("");
  const [permVerdict, setPermVerdict] = useState<"unknown" | "ok" | "missing">(
    "unknown",
  );
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

  // Stamped onto every mutation failure so a 4xx/5xx can never read as a
  // permission mystery: the verdict from the pre-check travels with it.
  const permNote = useCallback(
    () =>
      permVerdict === "ok"
        ? " [RBAC write permissions were verified before this attempt - this failure is NOT a permissions problem]"
        : permVerdict === "missing"
          ? " [the app registration is missing write permissions - see the list above]"
          : " [RBAC permissions could not be verified beforehand]",
    [permVerdict],
  );

  // Read-only before/after: the DCR's live declaration vs the declaration a
  // rebuild from the table's current schema would install.
  const openPreview = useCallback(
    async (entry: DcrInventoryEntry, table: string) => {
      setBusy(true);
      setError("");
      setNotice("");
      logInfo(`previewing update of '${entry.name}' from table ${table}`);
      try {
        const next = await previewDcrUpdate(ports.azure, {
          ...scope(),
          dcrName: entry.name,
          table,
          location: entry.location,
          dceResourceId: entry.dataCollectionEndpointId || undefined,
        });
        setPreview(next);
        logInfo(`preview of '${entry.name}': ${summarizePreview(next)}`);
        setPreviewLocation(entry.location);
        setPreviewDce(entry.dataCollectionEndpointId);
        setNewColName("");
        // Verify the write permissions BEFORE any mutation is offered.
        const perms = await checkDcrUpdatePermissions(ports.azure, {
          subscriptionId: config.subscriptionId,
          dcrResourceGroup: inventoryRg,
          workspaceResourceGroup: config.resourceGroup,
          includeTableEdit: true,
        });
        setMissingActions(perms.missing);
        if (perms.missing.length > 0) {
          setPermVerdict("missing");
          setPermStatus("");
          logError(
            "permission check: missing " +
              perms.missing.map((m) => `${m.action} at ${m.scope}`).join("; "),
          );
        } else if (perms.indeterminate) {
          setPermVerdict("unknown");
          setPermStatus(
            "Permission check unavailable (the RBAC permissions API was unreadable) - write actions were NOT verified.",
          );
          logInfo(
            "permission check: RBAC permissions API unreadable - proceeding without the pre-check",
          );
        } else {
          setPermVerdict("ok");
          setPermStatus(
            "Write permissions verified: DCR update and table schema edits are granted.",
          );
          logInfo("permission check: all write actions granted");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`preview of '${entry.name}' failed: ${message}`);
        setError(message);
        setPreview(null);
      } finally {
        setBusy(false);
      }
    },
    [ports.azure, scope, config.subscriptionId, config.resourceGroup, inventoryRg, logInfo, logError],
  );

  // Apply = the PUT-over-existing-name upsert, then re-preview so the panel
  // shows the post-update state (before == after when in sync).
  const applyUpdate = useCallback(async () => {
    if (preview === null) return;
    setBusy(true);
    setError("");
    setNotice("");
    logInfo(`updating '${preview.dcrName}' in place from table ${preview.table}`);
    setProgress(`Updating DCR '${preview.dcrName}' from the current ${preview.table} schema...`);
    try {
      const result = await updateDcrInPlace(ports.azure, {
        ...scope(),
        dcrName: preview.dcrName,
        table: preview.table,
        location: previewLocation,
        dceResourceId: previewDce || undefined,
      });
      logInfo(
        `updated '${result.dcrName}' in place (${result.columnCount} columns, ${result.provisioningState})`,
      );
      setNotice(
        `Updated '${result.dcrName}' in place (${result.columnCount} columns, ` +
          `${result.provisioningState}).`,
      );
      setProgress("Refreshing the field list...");
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
      const message = err instanceof Error ? err.message : String(err);
      logError(`update of '${preview.dcrName}' failed: ${message}`);
      setError(message + permNote());
    } finally {
      setProgress("");
      setBusy(false);
    }
  }, [ports.azure, scope, preview, previewLocation, previewDce, logInfo, logError, permNote]);

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
    logInfo(
      `adding field '${columnName}' (${newColType}) to ${preview.table} and updating '${preview.dcrName}'`,
    );
    setProgress(`Adding '${columnName}' (${newColType}) to ${preview.table}...`);
    try {
      let tableAddError = "";
      if (!preview.table.endsWith("_CL")) {
        // Native table: TRY the table write first (the PATCH-then-
        // documented-PUT ladder - the portal-equivalent path, user report
        // 2026-07-13); only when Azure refuses both does the DCR graft
        // take over.
        try {
          const added = await addTableColumn(ports.azure, {
            ...scope(),
            table: preview.table,
            column: { name: columnName, type: newColType },
          });
          logInfo(`added '${added.columnName}' to ${preview.table} via the tables API`);
          setProgress(`Updating DCR '${preview.dcrName}' to accept '${added.columnName}'...`);
          await updateDcrInPlace(ports.azure, {
            ...scope(),
            dcrName: preview.dcrName,
            table: preview.table,
            location: previewLocation,
            dceResourceId: previewDce || undefined,
          });
          setNotice(
            `Added '${added.columnName}' (${newColType}) to ${preview.table} AND ` +
              `updated '${preview.dcrName}' - the field is ingestable end to end.`,
          );
          setNewColName("");
          setProgress("Refreshing the field list...");
          setPreview(
            await previewDcrUpdate(ports.azure, {
              ...scope(),
              dcrName: preview.dcrName,
              table: preview.table,
              location: previewLocation,
              dceResourceId: previewDce || undefined,
            }),
          );
          return;
        } catch (err) {
          tableAddError = err instanceof Error ? err.message : String(err);
          logInfo(
            `table write refused (${tableAddError.slice(0, 160)}) - falling back to the DCR graft`,
          );
        }
        // Fallback: a pure DCR change - the field joins the stream
        // declaration and the transform maps it into a free extension column.
        setProgress(
          `Adding '${columnName}' to the DCR and mapping it to an extension column...`,
        );
        const grafted = await addDcrField(ports.azure, {
          ...scope(),
          dcrName: preview.dcrName,
          table: preview.table,
          location: previewLocation,
          dceResourceId: previewDce || undefined,
          column: { name: columnName, type: newColType },
        });
        const labelPart =
          grafted.labelColumn !== ""
            ? ` with ${grafted.labelColumn} = '${grafted.inputField}'`
            : "";
        logInfo(
          `added DCR input field '${grafted.inputField}' mapped to ${grafted.mappedTo}${labelPart} on '${grafted.dcrName}'`,
        );
        setNotice(
          `Added '${grafted.inputField}' to the DCR input and mapped it to ` +
            `${grafted.mappedTo}${labelPart}. The table schema is unchanged ` +
            `(Azure restricts it). Query: ${preview.table} | where ` +
            `${grafted.labelColumn || grafted.mappedTo} == '${grafted.inputField}'`,
        );
        setNewColName("");
        setProgress("Refreshing the field list...");
        setPreview(
          await previewDcrUpdate(ports.azure, {
            ...scope(),
            dcrName: preview.dcrName,
            table: preview.table,
            location: previewLocation,
            dceResourceId: previewDce || undefined,
          }),
        );
        return;
      }
      const added = await addTableColumn(ports.azure, {
        ...scope(),
        table: preview.table,
        column: { name: columnName, type: newColType },
      });
      // Native tables suffix custom fields with _CF - report the FINAL name.
      const finalName = added.columnName;
      setProgress(`Updating DCR '${preview.dcrName}' to accept '${finalName}'...`);
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
        logError(
          `column '${columnName}' added to ${preview.table} but the DCR update failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        setError(
          `Column added to ${preview.table}, but the DCR update failed: ` +
            `${err instanceof Error ? err.message : String(err)} - ` +
            "use Apply update below to retry.",
        );
      }
      if (dcrUpdated) {
        logInfo(
          `added '${finalName}' (${newColType}) to ${preview.table} and updated '${preview.dcrName}'`,
        );
      }
      setNotice(
        dcrUpdated
          ? `Added '${finalName}' (${newColType}) to ${preview.table} AND ` +
            `updated '${preview.dcrName}' - the field is ingestable end to end.`
          : `Added '${finalName}' (${newColType}) to ${preview.table}.`,
      );
      setNewColName("");
      setProgress("Refreshing the field list...");
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
      const message = err instanceof Error ? err.message : String(err);
      logError(`add field '${columnName}' to ${preview.table} failed: ${message}`);
      setError(message + permNote());
    } finally {
      setProgress("");
      setBusy(false);
    }
  }, [ports.azure, scope, preview, previewLocation, previewDce, newColName, newColType, logInfo, logError, permNote]);

  // Remove a CUSTOM column from the table AND apply the DCR update in one
  // action (user request 2026-07-13) - the field disappears end to end.
  const removeColumn = useCallback(async () => {
    if (preview === null || removeColName === "") return;
    const columnName = removeColName;
    setBusy(true);
    setError("");
    setNotice("");
    logInfo(
      `removing field '${columnName}' from ${preview.table} and updating '${preview.dcrName}'`,
    );
    setProgress(`Removing '${columnName}' from ${preview.table}...`);
    try {
      const removed = await removeTableColumn(ports.azure, {
        ...scope(),
        table: preview.table,
        columnName,
      });
      setProgress(`Updating DCR '${preview.dcrName}' to drop '${removed.columnName}'...`);
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
        logError(
          `column '${removed.columnName}' removed from ${preview.table} but the DCR update failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        setError(
          `Column removed from ${preview.table}, but the DCR update failed: ` +
            `${err instanceof Error ? err.message : String(err)} - ` +
            "use Apply update below to retry.",
        );
      }
      if (dcrUpdated) {
        logInfo(
          `removed '${removed.columnName}' from ${preview.table} and updated '${preview.dcrName}'`,
        );
      }
      setNotice(
        dcrUpdated
          ? `Removed '${removed.columnName}' from ${preview.table} AND ` +
            `updated '${preview.dcrName}' - the field is gone end to end.`
          : `Removed '${removed.columnName}' from ${preview.table}.`,
      );
      setRemoveColName("");
      setProgress("Refreshing the field list...");
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
      const message = err instanceof Error ? err.message : String(err);
      logError(`remove field '${columnName}' from ${preview.table} failed: ${message}`);
      setError(message + permNote());
    } finally {
      setProgress("");
      setBusy(false);
    }
  }, [ports.azure, scope, preview, previewLocation, previewDce, removeColName, logInfo, logError, permNote]);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    setPreview(null);
    logInfo(`listing DCRs in resource group '${inventoryRg}'`);
    try {
      const listed = await listDcrInventory(ports.azure, {
        subscriptionId: config.subscriptionId,
        resourceGroup: inventoryRg,
      });
      setEntries(listed);
      logInfo(`found ${listed.length} DCR(s) in '${inventoryRg}'`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`listing DCRs in '${inventoryRg}' failed: ${message}`);
      setError(message);
      setEntries(null);
    } finally {
      setBusy(false);
    }
  }, [ports.azure, config.subscriptionId, inventoryRg, logInfo, logError]);

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
      {preview === null && error !== "" && <pre className="result">{error}</pre>}
      {preview === null && notice !== "" && <p className="panel-desc">{notice}</p>}
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
              {permStatus !== "" && (
                <p className="field-hint">{permStatus}</p>
              )}
              {missingActions.length > 0 && (
                <pre className="result">
                  {[
                    "Missing permissions - grant these to the app registration before updating:",
                    ...missingActions.map(
                      (m) => `  ${m.action}${"\n"}    at ${m.scope}`,
                    ),
                    "(Monitoring Contributor covers the DCR action; Log Analytics Contributor covers the table action.)",
                  ].join("\n")}
                </pre>
              )}
              {busy && progress !== "" && (
                <p className="panel-desc dcr-progress-line">{progress}</p>
              )}
              {error !== "" && <pre className="result">{error}</pre>}
              {notice !== "" && <p className="panel-desc">{notice}</p>}
              {(() => {
                // The add-field affordance is ALWAYS visible (live feedback
                // 2026-07-13). Native tables accept custom fields too -
                // Azure suffixes their names with _CF (appended
                // automatically when missing).
                const nativeTable = !preview.table.endsWith("_CL");
                return (
                  <>
                    <div className="panel-controls">
                      <input
                        aria-label="New column name"
                        placeholder="New field name"
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
                        disabled={
                          busy ||
                          newColName.trim() === "" ||
                          missingActions.length > 0
                        }
                        title={
                          missingActions.length > 0
                            ? "Blocked: the app registration is missing write permissions - see the list above."
                            : "Adds the field to the table AND applies the DCR update - ingestable end to end."
                        }
                      >
                        Add to table and DCR
                      </button>
                    </div>
                    {nativeTable && (
                      <p className="field-hint">
                        {preview.table} is a native table: the field is added
                        to the DCR input and mapped into a free extension
                        column (FlexString/DeviceCustom*) with its Label set
                        to the field name - the table schema itself is never
                        changed.
                      </p>
                    )}
                    {(() => {
                      // Removable = the table's CUSTOM columns only: _CF
                      // fields on native tables, everything except
                      // TimeGenerated on _CL tables.
                      const removable = preview.tableColumns
                        .filter((c) =>
                          nativeTable
                            ? c.name.endsWith("_CF")
                            : c.name.toLowerCase() !== "timegenerated",
                        )
                        .map((c) => c.name)
                        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                      if (removable.length === 0) return null;
                      return (
                        <div className="panel-controls">
                          <select
                            aria-label="Column to remove"
                            value={removeColName}
                            onChange={(ev) => setRemoveColName(ev.target.value)}
                          >
                            <option value="">Select a field to remove...</option>
                            {removable.map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </select>
                          <button
                            className="gap-reset-button"
                            onClick={() => void removeColumn()}
                            disabled={
                              busy ||
                              removeColName === "" ||
                              missingActions.length > 0
                            }
                            title={
                              missingActions.length > 0
                                ? "Blocked: the app registration is missing write permissions - see the list above."
                                : "Removes the custom field from the table AND applies the DCR update - gone end to end."
                            }
                          >
                            Remove from table and DCR
                          </button>
                        </div>
                      );
                    })()}
                  </>
                );
              })()}
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
              <div className="panel-controls">
                <button
                  className="run-button"
                  onClick={() => void applyUpdate()}
                  disabled={
                    busy ||
                    missingActions.some((m) => m.action === DCR_WRITE_ACTION)
                  }
                  title={
                    missingActions.some((m) => m.action === DCR_WRITE_ACTION)
                      ? `Blocked: ${DCR_WRITE_ACTION} is not granted at the DCR's resource group.`
                      : undefined
                  }
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
