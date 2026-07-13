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
import { listDcrInventory, updateDcrInPlace } from "@soc/core";
import type { DcrInventoryEntry } from "@soc/core";
import { usePorts } from "../../ports-context";

export function DcrInventoryPanel() {
  const { ports, config } = usePorts();
  const [entries, setEntries] = useState<DcrInventoryEntry[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const scopeReady =
    config.subscriptionId !== "" && config.resourceGroup !== "";

  // Per-row in-place update (user request 2026-07-13): rebuild the DCR body
  // from the table's CURRENT schema and PUT it over the existing name (ARM
  // upsert - the immutableId and connected clients keep working).
  const update = useCallback(
    async (entry: DcrInventoryEntry, table: string) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const result = await updateDcrInPlace(ports.azure, {
          subscriptionId: config.subscriptionId,
          resourceGroup: config.resourceGroup,
          workspaceName: config.workspaceName,
          dcrName: entry.name,
          table,
          location: entry.location,
        });
        setNotice(
          `Updated '${result.dcrName}' in place from the current ` +
            `${result.table} schema (${result.columnCount} columns, ` +
            `${result.provisioningState}).`,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [ports.azure, config.subscriptionId, config.resourceGroup, config.workspaceName],
  );

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
                              : `Rebuild from the current ${table} schema and overwrite this DCR.`
                          }
                          onClick={() => void update(e, table)}
                        >
                          {e.tables.length > 1 ? `Update (${table})` : "Update in place"}
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
        </>
      )}
    </div>
  );
}
