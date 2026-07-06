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
import { assemblePack } from "@soc/core";
import type { CriblGroupSummary } from "@soc/core";
import { usePorts } from "../../ports-context";
import type { DeployedGroupPacks, StoredPack } from "../../ports-context";
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
          const gs = await ports.cribl.listGroups();
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
      try {
        const bytes = packBytes(pack);
        await ports.artifacts.save(
          pack.record.crblFileName,
          "application/octet-stream",
          bytes,
        );
        setNotice(`Download dispatched (${pack.record.crblFileName}).`);
      } catch (err) {
        setError(`Download failed: ${String(err)}`);
      }
    },
    [findPack, ports.artifacts],
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
      try {
        await packStore.delete(id);
        setNotice(`Deleted build ${id}.`);
        await load();
      } catch (err) {
        setError(`Delete failed: ${String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [packStore, packs, load],
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
      try {
        const installed = await packInstall.install(
          selectedGroup,
          pack.record.crblFileName,
          packBytes(pack),
        );
        setNotice(
          `Installed ${installed.displayName || installed.id} on ${selectedGroup}.`,
        );
        await load();
      } catch (err) {
        setError(`Install failed: ${String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [packInstall, selectedGroup, findPack, load],
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
            <select
              className="mapping-select"
              value={selectedGroup}
              onChange={(e) => setSelectedGroup(e.target.value)}
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.id}
                </option>
              ))}
            </select>
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
                className="gap-reset-button"
                onClick={() => void remove(row.id)}
                disabled={busy}
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
