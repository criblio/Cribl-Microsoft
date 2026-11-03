/**
 * WorkspaceInventoryPanel (MIG-3) - what an EXISTING Sentinel workspace
 * already ingests: discover the workspaces the identity can see across the
 * tenant, pick one, and inventory its tables, the sources feeding each, and the
 * daily average volume over the last 30 complete days.
 *
 * Its own component rather than more of SiemMigrationScreen: it shares no
 * state with the export analysis above it, and the screen was 554 lines.
 *
 * Every read here is on-demand behind a button - discovery is one ARM list per
 * subscription plus a solutions list, and an inventory is one query per ten
 * tables, against a proxy budget of 100 requests a minute.
 *
 * MIG-16: after an inventory, "Compare against the whole tenant" inventories
 * every other Sentinel-enabled workspace one at a time (that same budget) and
 * shows the allowances summed across all of them.
 */

import { useMemo, useState } from "react";
import {
  compareTenant,
  discoverWorkspaces,
  inventoryWorkspace,
  listingCount,
  listingRows,
  readDataAllowances,
} from "@soc/core";
import type { DataAllowances, WorkspaceDiscovery, WorkspaceInventory } from "@soc/core";
import { usePorts } from "../../ports-context";
import { InfoTip } from "../../components/info-tip";
import { SearchableSelect } from "../../components/searchable-select";
import { AllowanceCards, AllowanceQueries, AllowanceTagCell } from "./allowance-cards";
import {
  ALLOWANCE_TIPS,
  afterAllowancesText,
  overCell,
  sentinelWorkspaceCount,
  sentinelWorkspaceIds,
  tenantDiscoveryNote,
} from "./allowance-state";
import {
  discoveryHeadline,
  formatMB,
  inventoryCsv,
  inventoryEmptyText,
  sourceCount,
  sourceGaps,
  sourceLabel,
  staleInventoryNote,
  workspaceNameOf,
  workspaceSelectOption,
} from "./workspace-inventory-state";

const USAGE_TIP =
  "From the workspace's Usage table: Microsoft's billing aggregate of ingested MB per " +
  "table (DataType), summed over the last 30 complete UTC days (today excluded) and " +
  "divided by 30. Billable excludes free tables such as Heartbeat. This is the number " +
  "the Azure portal's Usage and estimated costs blade is built from.";

const SOURCES_TIP =
  "From the rows themselves: sum(_BilledSize) per table over the same 30 days, " +
  "grouped by the first of _ResourceId, Computer, or DeviceVendor DeviceProduct the " +
  "row carries. The 25 largest sources per table are listed and the rest summed into " +
  "one row. _BilledSize and Usage are separate measurements and can differ by a few " +
  "percent, so a table's sources need not add up exactly to its Usage total.";

export function WorkspaceInventoryPanel() {
  const { ports } = usePorts();
  const [discovery, setDiscovery] = useState<WorkspaceDiscovery | null>(null);
  const [discoveryError, setDiscoveryError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [inventory, setInventory] = useState<WorkspaceInventory | null>(null);
  const [inventoryError, setInventoryError] = useState("");
  const [busy, setBusy] = useState<"discover" | "inventory" | "allowances" | "tenant" | null>(null);
  // MIG-15: the allowances belong to the shown inventory - cleared when a new
  // inventory replaces it, read after it, and never shown beside another one.
  const [allowances, setAllowances] = useState<{ result: DataAllowances; readAt: string } | null>(null);
  const [allowanceError, setAllowanceError] = useState("");
  // MIG-16: the tenant comparison replaces the cards while it is shown, and is
  // dropped with the inventory it was started from.
  const [tenant, setTenant] = useState<{ result: DataAllowances; readAt: string } | null>(null);
  const [tenantError, setTenantError] = useState("");
  const [progress, setProgress] = useState("");
  const [saveNote, setSaveNote] = useState("");

  const discover = async () => {
    setBusy("discover");
    setDiscoveryError("");
    setProgress("Listing subscriptions");
    try {
      const found = await discoverWorkspaces(ports.azure, {
        logger: ports.logger,
        onProgress: setProgress,
      });
      setDiscovery(found);
      const first = listingRows(found.workspaces)[0];
      setSelectedId((current) =>
        listingRows(found.workspaces).some((w) => w.id === current) ? current : (first?.id ?? ""),
      );
    } catch (err) {
      setDiscoveryError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setProgress("");
    }
  };

  // MIG-7: the previous inventory stays on screen while the next one is read,
  // and is replaced only by an answer - clearing it first made the page shrink
  // and scroll under the pointer. A failed read does clear it, so a refusal
  // for one workspace never sits beside another workspace's numbers.
  const runInventory = async () => {
    if (selectedId === "") return;
    const target = selectedId;
    setBusy("inventory");
    setInventoryError("");
    setSaveNote("");
    let read: WorkspaceInventory;
    try {
      read = await inventoryWorkspace(ports.azure, target, {
        logger: ports.logger,
        onProgress: setProgress,
      });
    } catch (err) {
      setInventory(null);
      setAllowances(null);
      setAllowanceError("");
      setTenant(null);
      setTenantError("");
      setInventoryError(
        `${workspaceNameOf(target)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      setBusy(null);
      setProgress("");
      return;
    }
    setInventory(read);
    setAllowances(null);
    setAllowanceError("");
    setTenant(null);
    setTenantError("");
    // The inventory is on screen from here on; the allowance read only adds to it.
    setBusy("allowances");
    setProgress("Reading data allowances");
    const readAt = new Date().toISOString();
    try {
      const result = await readDataAllowances(ports.azure, ports.graph, target, read, {
        logger: ports.logger,
        onProgress: setProgress,
        readAt,
        sentinelWorkspaces: sentinelWorkspaceCount(discovery),
      });
      setAllowances({ result, readAt });
    } catch (err) {
      setAllowanceError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setProgress("");
    }
  };

  // MIG-16: inventory every OTHER Sentinel-enabled workspace one at a time -
  // the shown inventory is reused - then sum the allowances across all of them.
  // A workspace whose Usage read fails is left out of the map, so compareTenant
  // lists it as not read; its own error replaces compareTenant's generic one.
  const compareAcrossTenant = async () => {
    if (inventory === null) return;
    const ids = sentinelWorkspaceIds(discovery);
    setBusy("tenant");
    setTenantError("");
    const inventories = new Map<string, WorkspaceInventory>();
    if (ids.includes(inventory.workspaceId)) inventories.set(inventory.workspaceId, inventory);
    const others = ids.filter((id) => id !== inventory.workspaceId);
    const failed = new Map<string, string>();
    for (const [index, id] of others.entries()) {
      const step = `${workspaceNameOf(id)} (${index + 1} of ${others.length})`;
      setProgress(`Reading ${step}`);
      try {
        inventories.set(
          id,
          await inventoryWorkspace(ports.azure, id, {
            logger: ports.logger,
            onProgress: (message) => setProgress(`Reading ${step}: ${message}`),
          }),
        );
      } catch (err) {
        failed.set(id, err instanceof Error ? err.message : String(err));
      }
    }
    setProgress("Comparing data allowances across the tenant");
    const readAt = new Date().toISOString();
    try {
      const result = await compareTenant(ports.azure, ports.graph, ids, inventories, {
        logger: ports.logger,
        onProgress: setProgress,
        readAt,
        discoveryIncomplete: discovery !== null && tenantDiscoveryNote(discovery) !== null,
      });
      const notRead =
        result.scope.kind === "tenant"
          ? result.scope.notRead.map((w) => {
              const error = failed.get(w.id);
              return error === undefined ? w : { id: w.id, error: `Usage not read - ${error}` };
            })
          : [];
      setTenant({
        result: result.scope.kind === "tenant" ? { ...result, scope: { ...result.scope, notRead } } : result,
        readAt,
      });
    } catch (err) {
      setTenantError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setProgress("");
    }
  };

  const exportCsv = async () => {
    if (inventory === null) return;
    const file = `${workspaceNameOf(inventory.workspaceId)}-inventory.csv`;
    try {
      await ports.artifacts.save(file, "text/csv", inventoryCsv(inventory, allowances?.result ?? null));
      setSaveNote(`Saved ${file}.`);
    } catch (err) {
      setSaveNote(`Could not save ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const workspaces = discovery === null ? [] : listingRows(discovery.workspaces);
  const workspaceOptions = useMemo(() => workspaces.map(workspaceSelectOption), [workspaces]);
  const gaps = inventory === null ? null : sourceGaps(inventory);
  const emptyText = inventory === null ? null : inventoryEmptyText(inventory);
  const staleNote = inventory === null ? null : staleInventoryNote(inventory.workspaceId, selectedId);
  // Narrowed on kind, never counted: an unverified empty Usage answer has no
  // table count to show (docs/inventory-standard.md).
  const tableRows = inventory !== null && inventory.tables.kind === "rows" ? inventory.tables.rows : null;

  return (
    <section className="panel">
      <h2 className="panel-title">
        Existing Sentinel workspace inventory{" "}
        <InfoTip
          text={
            "What a workspace already ingests, for sizing a migration or a Cribl reduction: " +
            "every table with data in the last 30 complete days, the sources feeding it, and " +
            "the daily average volume. Reads only - discovery lists workspaces through ARM, " +
            "and the inventory runs two kinds of KQL query through the workspace's ARM query " +
            "endpoint, which needs Log Analytics Reader (workspaces/query/read) on it."
          }
        />
      </h2>
      <p className="panel-desc">
        Find the Log Analytics workspaces this identity can see across the tenant, then
        inventory one.
      </p>
      <div className="panel-controls">
        <button
          className="run-button"
          disabled={busy !== null}
          onClick={() => void discover()}
        >
          {discovery === null ? "Discover workspaces" : "Discover again"}
        </button>
        {busy === "discover" && <span className="field-hint">{progress}</span>}
      </div>
      {discoveryError !== "" && (
        <p className="match-warning">Could not list subscriptions: {discoveryError}</p>
      )}

      {discovery !== null && (
        <>
          <p className="panel-desc">{discoveryHeadline(discovery)}</p>
          {discovery.failures.length > 0 && (
            <details className="gap-handles">
              <summary>{discovery.failures.length} subscription(s) not listed</summary>
              <div className="gap-handles-body">
                {discovery.failures.map((f) => (
                  <div key={f.subscriptionId}>
                    {f.subscriptionName || f.subscriptionId}: {f.error}
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}

      {workspaces.length > 0 && (
        <div className="panel-controls">
          <span className="field-hint">Workspace</span>
          {/* MIG-8: 80 workspaces in one tenant - a filter box, not a bare
              dropdown. Matches name, subscription, resource group, Sentinel. */}
          <div className="siem-inventory-picker">
            <SearchableSelect
              options={workspaceOptions}
              value={selectedId}
              disabled={busy !== null}
              // MIG-7: the shown inventory stays; staleNote says it is not this one.
              onChange={setSelectedId}
              placeholder="Select a workspace..."
              ariaLabel="Filter workspaces"
            />
          </div>
          <button
            className="run-button"
            disabled={busy !== null || selectedId === ""}
            onClick={() => void runInventory()}
          >
            Inventory this workspace
          </button>
          {busy === "inventory" && <span className="field-hint">{progress}</span>}
        </div>
      )}

      {inventoryError !== "" && (
        <p className="match-warning">
          Could not read the Usage table, so there is no inventory to show - {inventoryError}
        </p>
      )}

      {inventory !== null && (
        <>
          <p className="panel-desc">
            Inventory of <code className="code-chip">{workspaceNameOf(inventory.workspaceId)}</code>,
            last {inventory.windowDays} complete UTC days.
          </p>
          {staleNote !== null && <p className="match-warning">{staleNote}</p>}
          <div className="match-stat-grid">
            <div className="match-stat match-stat-info">
              <span className="match-stat-value">
                {formatMB(inventory.totals.dailyAverageMB)}
              </span>
              <span className="match-stat-label">
                daily average, all tables <InfoTip text={USAGE_TIP} />
              </span>
            </div>
            <div className="match-stat match-stat-info">
              <span className="match-stat-value">
                {formatMB(inventory.totals.billableDailyAverageMB)}
              </span>
              <span className="match-stat-label">daily average, billable</span>
            </div>
            <div className="match-stat match-stat-info">
              <span className="match-stat-value">
                {allowances !== null
                  ? afterAllowancesText(allowances.result)
                  : busy === "allowances"
                    ? "reading"
                    : "not read"}
              </span>
              <span className="match-stat-label">
                daily billable after allowances <InfoTip text={ALLOWANCE_TIPS.afterAllowances} />
              </span>
            </div>
            <div className="match-stat match-stat-info">
              <span className="match-stat-value">{formatMB(inventory.totals.totalMB)}</span>
              <span className="match-stat-label">
                total over {inventory.windowDays} days
              </span>
            </div>
            <div className="match-stat match-stat-info">
              <span className="match-stat-value">
                {listingCount(inventory.tables, -1) < 0 ? "unknown" : listingCount(inventory.tables, -1)}
              </span>
              <span className="match-stat-label">tables with data</span>
            </div>
          </div>

          {inventory.usageWarning !== null && (
            <p className="match-warning">
              The Usage answer was incomplete, so these totals are a floor:{" "}
              {inventory.usageWarning}
            </p>
          )}
          {emptyText !== null && <p className="panel-desc">{emptyText}</p>}

          {busy === "allowances" && <p className="field-hint">{progress}</p>}
          {allowanceError !== "" && (
            <p className="match-warning">
              Could not read the data allowance benefit, so no allowance is shown - {allowanceError}
            </p>
          )}
          {tenantError !== "" && (
            <p className="match-warning">
              Could not compare the data allowances across the tenant - {tenantError}
            </p>
          )}
          {tenant !== null ? (
            <>
              {discovery !== null && tenantDiscoveryNote(discovery) !== null && (
                <p className="match-warning">{tenantDiscoveryNote(discovery)}</p>
              )}
              <AllowanceCards
                allowances={tenant.result}
                readAt={tenant.readAt}
                actions={
                  <button className="run-button" disabled={busy !== null} onClick={() => setTenant(null)}>
                    Back to this workspace
                  </button>
                }
              />
            </>
          ) : (
            allowances !== null && (
              <AllowanceCards
                allowances={allowances.result}
                readAt={allowances.readAt}
                actions={
                  sentinelWorkspaceIds(discovery).length > 1 ? (
                    <>
                      <button
                        className="run-button"
                        disabled={busy !== null}
                        onClick={() => void compareAcrossTenant()}
                      >
                        Compare against the whole tenant
                      </button>
                      {busy === "tenant" && <span className="field-hint">{progress}</span>}
                    </>
                  ) : undefined
                }
              />
            )
          )}
          {gaps !== null && gaps.failed + gaps.partial > 0 && (
            <p className="match-warning">
              {gaps.failed > 0 &&
                `${gaps.failed} table(s) have no source breakdown - the volume is still shown. `}
              {gaps.partial > 0 &&
                `${gaps.partial} table(s) have a partial source breakdown.`}
            </p>
          )}

          {tableRows !== null && (
            <div className="siem-inventory-table-wrap">
              <table className="siem-inventory-table">
                <thead>
                  <tr>
                    <th>Table</th>
                    <th>Daily avg</th>
                    <th>Billable (30d)</th>
                    <th>Days with data</th>
                    <th>
                      Allowance <InfoTip text={ALLOWANCE_TIPS.allowanceColumn} />
                    </th>
                    <th>
                      Over allowance / day <InfoTip text={ALLOWANCE_TIPS.overColumn} />
                    </th>
                    <th className="siem-inventory-sources">
                      Sources <InfoTip text={SOURCES_TIP} />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows?.map((t) => (
                    <tr key={t.table}>
                      <td>
                        <code className="code-chip">{t.table}</code>
                        {t.solutions.length > 0 && (
                          <div className="field-hint">{t.solutions.join(", ")}</div>
                        )}
                      </td>
                      <td>{formatMB(t.dailyAverageMB)}</td>
                      <td>{formatMB(t.billableMB)}</td>
                      <td>
                        {t.daysWithData} of {inventory.windowDays}
                      </td>
                      <td>
                        <AllowanceTagCell table={t.table} a={allowances?.result ?? null} />
                      </td>
                      <td>
                        {overCell(t, allowances?.result ?? null, inventory.windowDays) ||
                          (busy === "allowances" ? "reading" : "not read")}
                      </td>
                      <td>
                        {t.sources.kind === "failed" ? (
                          <span className="field-hint">
                            Breakdown failed: {t.sources.error}
                          </span>
                        ) : (
                          <details className="gap-handles">
                            <summary>
                              {sourceCount(t)} source(s)
                              {t.sources.kind === "partial" ? " (partial)" : ""}
                            </summary>
                            <div className="gap-handles-body">
                              {t.sources.kind === "partial" && (
                                <div className="field-hint">{t.sources.warning}</div>
                              )}
                              {t.sources.sources.map((s, i) => {
                                const label = sourceLabel(s);
                                return (
                                  <div key={`${s.source}-${s.attribution}-${i}`} title={label.title}>
                                    {label.text} ({label.kind}) - {formatMB(s.dailyAverageMB)}/day,{" "}
                                    {s.events.toLocaleString()} events
                                  </div>
                                );
                              })}
                            </div>
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <details className="gap-handles">
            <summary>Queries that produced these numbers</summary>
            <div className="gap-handles-body">
              <pre className="siem-inventory-query">{inventory.queries.usage}</pre>
              {inventory.queries.sourcesExample !== null && (
                <pre className="siem-inventory-query">{inventory.queries.sourcesExample}</pre>
              )}
              {allowances !== null && <AllowanceQueries a={allowances.result} />}
            </div>
          </details>

          {tableRows !== null && (
            <div className="panel-controls">
              <button className="run-button" onClick={() => void exportCsv()}>
                Download inventory CSV
              </button>
              {saveNote !== "" && <span className="field-hint">{saveNote}</span>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
