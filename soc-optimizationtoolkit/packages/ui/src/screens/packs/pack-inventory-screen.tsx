/**
 * PackInventoryScreen - the ONE merged pack inventory screen (porting-plan Unit
 * 19; GUI-19 and GUI-20 folded into a single inventory, replacing the legacy's
 * two competing implementations). It lists pack BUILD RECORDS with DEPLOYED
 * badges per worker group (truth from the live packs API, never local storage),
 * a storage/retention summary, DOWNLOAD of the .crbl via the ArtifactSink port
 * (regenerated deterministically from the stored definition, or served from the
 * local cache), install-to-group, and DELETE guarded by scoped record-id
 * validation (no path semantics).
 *
 * ADDITIVE: this is the pack surface only. It does NOT touch canDeploy /
 * canDeployContentPath and never flips another section's status. All decisions
 * live in the pure pack-inventory-state module; this component is React over
 * the ports.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyMaintenanceEdits,
  assemblePack,
  installedPackVersions,
  isStreamWorkerGroup,
  maintenanceRows,
  makeBuildRecord,
  nextPackVersion,
} from "@soc/core";
import type {
  CriblGroupSummary,
  MaintenanceEdit,
  PipelineFieldMapping,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import type { DeployedGroupPacks, StoredPack } from "../../ports-context";
import { SearchableSelect } from "../../components/searchable-select";
import {
  PACK_INVENTORY_EMPTY_REASON,
  PACK_INVENTORY_UNAVAILABLE_REASON,
  PACK_RETENTION_NOTE,
  deriveDeployedBadge,
  deriveInventoryRows,
  deriveStorageSummary,
  formatCrblSize,
  resolveBytesSource,
  tablesSummary,
  validateDeleteId,
} from "./pack-inventory-state";

/** Keep the newest builds per pack name in the retention preview. */
const KEEP_PER_PACK = 5;

/** Decode base64 cached bytes to a fresh Uint8Array (browser atob). */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** The .crbl bytes for a stored pack: cached when present, else regenerated. */
function packBytes(pack: StoredPack): Uint8Array {
  const source = resolveBytesSource(pack);
  if (source.kind === "cached") {
    return decodeBase64(source.base64);
  }
  // Deterministic regeneration from the stored definition (byte-stable: the
  // builtAtMs input keeps the archive mtime fixed).
  return assemblePack(pack.definition).crbl;
}

export interface PackInventoryScreenProps {
  /** Bump to force a reload (e.g. after a build completes elsewhere). */
  refreshToken?: number;
}

export function PackInventoryScreen({ refreshToken = 0 }: PackInventoryScreenProps) {
  const { ports } = usePorts();
  // Every button narrates to the Logs page (user request 2026-07-13).
  const logger = ports.logger;
  const logInfo = useCallback(
    (line: string) => logger?.info(`pack-maintenance: ${line}`),
    [logger],
  );
  const logError = useCallback(
    (line: string) => logger?.error(`pack-maintenance: ${line}`),
    [logger],
  );
  const packStore = ports.packs;
  const packInstall = ports.packInstall;

  const [packs, setPacks] = useState<StoredPack[] | null>(null);
  const [snapshot, setSnapshot] = useState<DeployedGroupPacks[]>([]);
  const [groups, setGroups] = useState<CriblGroupSummary[]>([]);
  const [selectedGroup, setSelectedGroup] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (packStore === undefined) {
      return;
    }
    setError("");
    try {
      const stored = await packStore.list();
      setPacks(stored);
      // Deployed-status truth: list each worker group's live packs. Group
      // discovery and the per-group list are best-effort - a Cribl-side error
      // must not blank the build records the operator can still download.
      if (packInstall !== undefined) {
        try {
          // Edge fleets cannot host installed packs: Stream worker groups only.
          const gs = (await ports.cribl.listGroups()).filter(isStreamWorkerGroup);
          setGroups(gs);
          if (selectedGroup === "" && gs.length > 0) {
            setSelectedGroup(gs[0].id);
          }
          setSnapshot(await packInstall.listDeployed(gs.map((g) => g.id)));
        } catch (err) {
          setSnapshot([]);
          setNotice(`Deployed status unavailable: ${String(err)}`);
        }
      }
    } catch (err) {
      setError(String(err));
    }
  }, [packStore, packInstall, ports.cribl, selectedGroup]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const rows = useMemo(
    () => (packs === null ? [] : deriveInventoryRows(packs, snapshot)),
    [packs, snapshot],
  );
  const storage = useMemo(
    () => (packs === null ? null : deriveStorageSummary(packs, KEEP_PER_PACK)),
    [packs],
  );

  const findPack = useCallback(
    (id: string): StoredPack | undefined =>
      (packs ?? []).find((p) => p.record.id === id),
    [packs],
  );

  const download = useCallback(
    async (id: string) => {
      const pack = findPack(id);
      if (pack === undefined) {
        setError(`No stored pack with id '${id}' to download.`);
        return;
      }
      setError("");
      setNotice("");
      logInfo(`downloading ${pack.record.crblFileName}`);
      try {
        const bytes = packBytes(pack);
        await ports.artifacts.save(
          pack.record.crblFileName,
          "application/octet-stream",
          bytes,
        );
        logInfo(`download dispatched (${pack.record.crblFileName}, ${bytes.length} bytes)`);
        setNotice(`Download dispatched (${pack.record.crblFileName}).`);
      } catch (err) {
        logError(`download of ${pack.record.crblFileName} failed: ${String(err)}`);
        setError(`Download failed: ${String(err)}`);
      }
    },
    [findPack, ports.artifacts, logInfo, logError],
  );

  const remove = useCallback(
    async (id: string) => {
      if (packStore === undefined) {
        return;
      }
      // Scoped record-id guard: a delete addresses a KNOWN build record, never
      // a path (the pure validator forbids traversal syntax).
      const check = validateDeleteId(id, packs ?? []);
      if (!check.ok) {
        setError(check.error);
        return;
      }
      setBusy(true);
      setError("");
      setNotice("");
      logInfo(`deleting build record ${id}`);
      try {
        await packStore.delete(id);
        logInfo(`deleted build record ${id}`);
        setNotice(`Deleted build ${id}.`);
        await load();
      } catch (err) {
        logError(`delete of build record ${id} failed: ${String(err)}`);
        setError(`Delete failed: ${String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [packStore, packs, load, logInfo, logError],
  );

  // ---- Pack maintenance (user request 2026-07-13): reconstruct the pack's
  // mapping table from its stored definition, edit dispositions/targets, and
  // rebuild + install the NEXT version in place (the install ladder upgrades
  // the existing pack id).
  const [maintainId, setMaintainId] = useState<string | null>(null);
  const [maintEdits, setMaintEdits] = useState<Map<string, MaintenanceEdit>>(
    new Map(),
  );

  const editKey = (logType: string, source: string) => `${logType} ${source}`;
  const setEdit = useCallback(
    (logType: string, source: string, patch: Partial<MaintenanceEdit>) => {
      setMaintEdits((prev) => {
        const nextMap = new Map(prev);
        const key = editKey(logType, source);
        nextMap.set(key, { logType, source, ...prev.get(key), ...patch });
        return nextMap;
      });
    },
    [],
  );

  const rebuildInPlace = useCallback(
    async (id: string) => {
      const pack = findPack(id);
      if (pack === undefined || packStore === undefined) {
        return;
      }
      setBusy(true);
      setError("");
      setNotice("");
      logInfo(
        `rebuilding '${pack.record.packName}' with ${maintEdits.size} mapping edit(s)`,
      );
      try {
        // Next version: above the highest INSTALLED copy and this record.
        const version = nextPackVersion([
          ...installedPackVersions(snapshot, pack.record.packName),
          pack.record.version,
        ]);
        const nextDef = applyMaintenanceEdits(
          pack.definition,
          [...maintEdits.values()],
          { version, builtAtMs: Date.now() },
        );
        const assembled = assemblePack(nextDef);
        await packStore.put({
          record: makeBuildRecord(nextDef.plan, {
            builtAtMs: nextDef.builtAtMs,
            crblSizeBytes: assembled.crbl.length,
            displayName: pack.record.displayName,
          }),
          definition: nextDef,
        });
        logInfo(
          `assembled ${assembled.crblFileName} (${assembled.crbl.length} bytes), record saved`,
        );
        if (packInstall !== undefined && selectedGroup !== "") {
          const installed = await packInstall.install(
            selectedGroup,
            assembled.crblFileName,
            assembled.crbl,
          );
          logInfo(`rebuilt v${version} and installed '${installed.id}' on ${selectedGroup}`);
          setNotice(
            `Rebuilt v${version} and installed '${installed.id}' on ${selectedGroup}.`,
          );
        } else {
          logInfo(`rebuilt v${version} - record saved, no group selected`);
          setNotice(
            `Rebuilt v${version} - record saved. Select a worker group to install.`,
          );
        }
        setMaintainId(null);
        setMaintEdits(new Map());
        await load();
      } catch (err) {
        logError(`rebuild of '${pack.record.packName}' failed: ${String(err)}`);
        setError(`Rebuild failed: ${String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [findPack, packStore, snapshot, maintEdits, packInstall, selectedGroup, load, logInfo, logError],
  );

  const install = useCallback(
    async (id: string) => {
      if (packInstall === undefined || selectedGroup === "") {
        return;
      }
      const pack = findPack(id);
      if (pack === undefined) {
        setError(`No stored pack with id '${id}' to install.`);
        return;
      }
      setBusy(true);
      setError("");
      setNotice("");
      logInfo(`installing ${pack.record.crblFileName} to ${selectedGroup}`);
      try {
        const installed = await packInstall.install(
          selectedGroup,
          pack.record.crblFileName,
          packBytes(pack),
        );
        logInfo(`installed '${installed.id}' on ${selectedGroup}`);
        setNotice(`Installed '${installed.id}' on ${selectedGroup}.`);
        await load();
      } catch (err) {
        logError(`install of ${pack.record.crblFileName} to ${selectedGroup} failed: ${String(err)}`);
        setError(`Install failed: ${String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [packInstall, selectedGroup, findPack, load, logInfo, logError],
  );

  if (packStore === undefined) {
    return (
      <div className="discovery-result">
        <p className="panel-desc">{PACK_INVENTORY_UNAVAILABLE_REASON}</p>
      </div>
    );
  }

  return (
    <div className="pack-inventory discovery-result">
      <div className="panel-controls">
        <button className="run-button" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
        {groups.length > 0 && packInstall !== undefined && (
          <label className="field">
            <span className="field-label">Deploy target</span>
            <SearchableSelect
              options={groups.map((g) => ({ value: g.id, label: g.id }))}
              value={selectedGroup}
              onChange={setSelectedGroup}
              placeholder="Select a worker group..."
              ariaLabel="Filter worker groups"
            />
          </label>
        )}
      </div>

      {error !== "" && <pre className="result">{error}</pre>}
      {notice !== "" && <p className="panel-desc">{notice}</p>}

      {storage !== null && storage.totalPacks > 0 && (
        <div className="pack-storage">
          <p className="panel-desc">
            {storage.totalPacks} build{storage.totalPacks === 1 ? "" : "s"} across{" "}
            {storage.distinctNames} pack{storage.distinctNames === 1 ? "" : "s"},{" "}
            {formatCrblSize(storage.totalBytes)} stored.
            {storage.evictableIds.length > 0 &&
              ` ${storage.evictableIds.length} older build${
                storage.evictableIds.length === 1 ? "" : "s"
              } beyond the keep-${KEEP_PER_PACK}-per-pack policy can be deleted.`}
          </p>
          <p className="field-hint">{PACK_RETENTION_NOTE}</p>
        </div>
      )}

      {packs !== null && rows.length === 0 && (
        <p className="panel-desc">{PACK_INVENTORY_EMPTY_REASON}</p>
      )}

      {rows.map((row) => {
        const badge = deriveDeployedBadge(row);
        return (
          <div className="pack-card mapping-review-card" key={row.id}>
            <div className="pack-card-head mapping-review-card-head">
              <span className="pack-name field-label">
                {row.displayName} v{row.version}
              </span>
              <span className={`pack-badge gap-badge gap-badge-${badge.tone}`}>
                {badge.label}
              </span>
            </div>
            <p className="field-hint">{tablesSummary(row.tables)}</p>
            <p className="field-hint">
              {row.crblFileName} ({formatCrblSize(row.crblSizeBytes)}) -{" "}
              {row.bytesSource === "cached"
                ? "cached bytes"
                : "regenerated on download"}
            </p>
            <div className="panel-controls">
              <button
                className="run-button"
                onClick={() => void download(row.id)}
                disabled={busy}
              >
                Download .crbl
              </button>
              {packInstall !== undefined && (
                <button
                  className="run-button"
                  onClick={() => void install(row.id)}
                  disabled={busy || selectedGroup === ""}
                >
                  Install to {selectedGroup || "group"}
                </button>
              )}
              <button
                className="run-button"
                onClick={() => {
                  setMaintEdits(new Map());
                  setMaintainId(maintainId === row.id ? null : row.id);
                }}
                disabled={busy}
              >
                {maintainId === row.id ? "Close maintenance" : "Maintain"}
              </button>
              <button
                className="gap-reset-button"
                onClick={() => void remove(row.id)}
                disabled={busy}
              >
                Delete
              </button>
            </div>
            {maintainId === row.id &&
              (() => {
                const pack = findPack(row.id);
                if (pack === undefined) return null;
                const mrows = maintenanceRows(pack.definition);
                return (
                  <div className="pack-maintenance">
                    <p className="field-hint">
                      Reconstructed from the stored build definition. Edit a
                      row's action or destination, then rebuild - the next
                      version installs over the existing pack in place.
                    </p>
                    <table className="match-field-table mapping-review-grid">
                      <thead>
                        <tr>
                          <th>Log type</th>
                          <th>Source field</th>
                          <th>Action</th>
                          <th>Destination</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mrows.map((m) => {
                          const key = editKey(m.logType, m.source);
                          const edit = maintEdits.get(key);
                          const action = edit?.action ?? m.action;
                          return (
                            <tr key={key}>
                              <td>{m.logType}</td>
                              <td>{m.source}</td>
                              <td>
                                <select
                                  aria-label={`Action for ${m.source}`}
                                  value={action}
                                  onChange={(e) =>
                                    setEdit(m.logType, m.source, {
                                      action: e.target
                                        .value as PipelineFieldMapping["action"],
                                    })
                                  }
                                >
                                  <option value="rename">rename</option>
                                  <option value="keep">keep</option>
                                  <option value="coerce">coerce</option>
                                  <option value="decode">decode</option>
                                  <option value="overflow">overflow</option>
                                  <option value="drop">drop</option>
                                </select>
                              </td>
                              <td>
                                <input
                                  aria-label={`Destination for ${m.source}`}
                                  value={edit?.target ?? m.target}
                                  disabled={action === "drop" || action === "overflow"}
                                  onChange={(e) =>
                                    setEdit(m.logType, m.source, {
                                      target: e.target.value,
                                    })
                                  }
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <div className="panel-controls">
                      <button
                        className="run-button"
                        onClick={() => void rebuildInPlace(row.id)}
                        disabled={busy}
                      >
                        Rebuild next version
                        {selectedGroup !== "" ? ` and install to ${selectedGroup}` : ""}
                      </button>
                      {maintEdits.size > 0 && (
                        <span className="field-hint">
                          {maintEdits.size} row(s) edited
                        </span>
                      )}
                    </div>
                  </div>
                );
              })()}
          </div>
        );
      })}
    </div>
  );
}
