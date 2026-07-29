/**
 * LabInventoryPanel - the running-labs inventory: list the lab-tagged
 * resource groups in the selected subscription (soonest self-destruct
 * first), extend a lab's TTL, or two-step destroy it now. Owns ONLY the
 * inventory state cluster; the subscription selection is the screen's.
 */

import { useCallback, useState } from "react";
import {
  destroyLab,
  extendLabTtl,
  listLabs,
  type LabInventoryEntry,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { formatLabInventoryRow, parseExtendHours } from "./labs-state";

export interface LabInventoryPanelProps {
  /** The screen-owned subscription every inventory action targets. */
  subscriptionId: string;
}

export function LabInventoryPanel({ subscriptionId }: LabInventoryPanelProps) {
  const { ports } = usePorts();
  const [labs, setLabs] = useState<LabInventoryEntry[] | null>(null);
  const [loadingLabs, setLoadingLabs] = useState(false);
  const [labsError, setLabsError] = useState("");
  const [extendHours, setExtendHours] = useState("72");
  const [confirmDestroy, setConfirmDestroy] = useState("");
  const [inventoryNotice, setInventoryNotice] = useState("");

  const refreshLabs = useCallback(async () => {
    if (loadingLabs || subscriptionId === "") {
      return;
    }
    setLoadingLabs(true);
    setLabsError("");
    setInventoryNotice("");
    setConfirmDestroy("");
    try {
      setLabs(
        await listLabs(
          ports.azure,
          { subscriptionId, nowIso: new Date().toISOString() },
          ports.logger,
        ),
      );
    } catch (err) {
      setLabs(null);
      setLabsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingLabs(false);
    }
  }, [loadingLabs, subscriptionId, ports.azure, ports.logger]);

  const extendLab = useCallback(
    async (name: string) => {
      setInventoryNotice("");
      const parsed = parseExtendHours(extendHours);
      if (!parsed.ok) {
        setInventoryNotice(parsed.reason);
        return;
      }
      try {
        const outcome = await extendLabTtl(
          ports.azure,
          {
            subscriptionId,
            resourceGroupName: name,
            ttl: { hours: parsed.hours, warningHours: 24, userEmail: "" },
            nowIso: new Date().toISOString(),
          },
          ports.logger,
        );
        setInventoryNotice(`${name}: TTL extended to ${outcome.expiresAt}.`);
        await refreshLabs();
      } catch (err) {
        setInventoryNotice(
          `${name}: extend failed - ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [extendHours, subscriptionId, ports.azure, ports.logger, refreshLabs],
  );

  const destroyLabNow = useCallback(
    async (name: string) => {
      setInventoryNotice("");
      try {
        await destroyLab(
          ports.azure,
          { subscriptionId, resourceGroupName: name },
          ports.logger,
        );
        setInventoryNotice(
          `${name}: deletion ACCEPTED - Azure deletes the group and everything ` +
            "in it asynchronously (it lingers in the list until done).",
        );
        setConfirmDestroy("");
        await refreshLabs();
      } catch (err) {
        setInventoryNotice(
          `${name}: destroy failed - ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [subscriptionId, ports.azure, ports.logger, refreshLabs],
  );

  return (
    <>
      <div className="panel-controls">
        <button
          className="run-button"
          onClick={() => void refreshLabs()}
          disabled={loadingLabs || subscriptionId === ""}
        >
          {loadingLabs
            ? "Loading labs..."
            : labs === null
              ? "List running labs"
              : "Refresh labs"}
        </button>
        <label className="field">
          <span className="field-label">Extend by (hours)</span>
          <input
            type="text"
            value={extendHours}
            onChange={(e) => setExtendHours(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>
      {labsError !== "" && <pre className="result">{labsError}</pre>}
      {labs !== null && labs.length === 0 && (
        <p className="field-hint">No running labs found in this subscription.</p>
      )}
      {labs !== null &&
        labs.map((lab) => (
          <div className="discovery-result" key={lab.name}>
            <span className={lab.expired ? "field-hint eh-warning" : "field-hint"}>
              {formatLabInventoryRow(lab)}
            </span>
            <div className="panel-controls">
              <button className="run-button" onClick={() => void extendLab(lab.name)}>
                Extend TTL
              </button>
              {confirmDestroy === lab.name ? (
                <>
                  <button
                    className="run-button"
                    onClick={() => void destroyLabNow(lab.name)}
                  >
                    CONFIRM destroy {lab.name}
                  </button>
                  <button
                    className="run-button"
                    onClick={() => setConfirmDestroy("")}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  className="run-button"
                  onClick={() => setConfirmDestroy(lab.name)}
                >
                  Destroy...
                </button>
              )}
            </div>
          </div>
        ))}
      {inventoryNotice !== "" && <p className="field-hint">{inventoryNotice}</p>}
    </>
  );
}
