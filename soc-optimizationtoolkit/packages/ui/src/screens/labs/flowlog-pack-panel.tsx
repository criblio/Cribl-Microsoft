/**
 * FlowLogPackPanel - assemble the AzureFlowLogs pack in-app and install it
 * into a selected Cribl worker group, then commit and deploy (panel 5). The
 * storage-account default comes from the screen (deployed account first,
 * planned name otherwise); this component owns only the pack state cluster.
 */

import { useCallback, useState } from "react";
import {
  assembleFlowLogPack,
  finalizeFlowLogPack,
  type CriblGroupSummary,
} from "@soc/core";
import { usePorts } from "../../ports-context";
import { flowLogPackResultLines, packStorageAccountName } from "./labs-state";

export interface FlowLogPackPanelProps {
  /**
   * The storage account used when the field is left blank: the account the
   * deploy actually created, else the planned name (packStorageAccountName
   * applies the precedence with the typed value).
   */
  defaultStorageAccount: string;
}

export function FlowLogPackPanel({ defaultStorageAccount }: FlowLogPackPanelProps) {
  const { ports, config } = usePorts();
  const [groups, setGroups] = useState<CriblGroupSummary[] | null>(null);
  const [groupId, setGroupId] = useState("");
  const [groupsError, setGroupsError] = useState("");
  const [packStorageAccount, setPackStorageAccount] = useState("");
  const [packSecret, setPackSecret] = useState("");
  const [packScheduleEnabled, setPackScheduleEnabled] = useState(true);
  const [deployingPack, setDeployingPack] = useState(false);
  const [packLines, setPackLines] = useState<string[]>([]);
  const [packError, setPackError] = useState("");

  const loadGroups = useCallback(async () => {
    setGroupsError("");
    try {
      const found = await ports.cribl.listGroups();
      setGroups(found);
      if (found.length > 0 && groupId === "") {
        setGroupId(found[0].id);
      }
    } catch (err) {
      setGroups(null);
      setGroupsError(
        `Worker groups unavailable (is a Cribl connection active?): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }, [ports.cribl, groupId]);

  const deployFlowLogPack = useCallback(async () => {
    if (deployingPack || groupId === "" || ports.packInstall === undefined) {
      return;
    }
    setDeployingPack(true);
    setPackError("");
    setPackLines([]);
    try {
      const storageAccountName = packStorageAccountName(
        packStorageAccount,
        null,
        defaultStorageAccount,
      );
      const pack = assembleFlowLogPack(
        {
          storageAccountName,
          tenantId: config.tenantId,
          clientId: config.clientId,
          scheduleEnabled: packScheduleEnabled,
        },
        Date.now(),
      );
      await ports.packInstall.install(groupId, pack.crblFileName, pack.crbl);
      const outcome = await finalizeFlowLogPack(
        ports.cribl,
        { groupId, clientSecret: packSecret },
        ports.logger,
      );
      setPackLines(flowLogPackResultLines(pack.crblFileName, groupId, outcome));
      setPackSecret("");
    } catch (err) {
      setPackError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeployingPack(false);
    }
  }, [
    deployingPack,
    groupId,
    ports.packInstall,
    ports.cribl,
    ports.logger,
    packStorageAccount,
    packSecret,
    packScheduleEnabled,
    defaultStorageAccount,
    config.tenantId,
    config.clientId,
  ]);

  return (
    <div className="panel">
      <h2 className="panel-title">5. Deploy the vNet flow-log pack to Cribl</h2>
      <p className="panel-desc">
        Assembles the AzureFlowLogs pack in-app - the Azure_vNet_FlowLogs
        event breaker, the flow-tuple preprocessing pipeline, and the hourly
        blob collector job wired to your storage account - and installs it
        into the selected worker group, then commits and deploys. The
        collector authenticates with the Azure_vNet_Flowlogs_Secret text
        secret; provide the app registration's client secret below to create
        it, or leave blank if it already exists in the group.
      </p>
      <div className="panel-controls">
        <button className="run-button" onClick={() => void loadGroups()}>
          {groups === null ? "Load worker groups" : "Reload worker groups"}
        </button>
        {groupsError !== "" && (
          <span className="field-hint eh-warning">{groupsError}</span>
        )}
      </div>
      {groups !== null && groups.length > 0 && (
        <label className="field">
          <span className="field-label">Worker group (where to deploy)</span>
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.id}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span className="field-label">Storage account</span>
        <input
          type="text"
          value={packStorageAccount}
          onChange={(e) => setPackStorageAccount(e.target.value)}
          placeholder={defaultStorageAccount}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="field-hint">
          Defaults to the lab's deployed storage account when left blank.
        </span>
      </label>
      <label className="field">
        <span className="field-label">
          Azure client secret for Azure_vNet_Flowlogs_Secret (transient, optional)
        </span>
        <input
          type="password"
          value={packSecret}
          onChange={(e) => setPackSecret(e.target.value)}
          autoComplete="new-password"
        />
      </label>
      <label className="integrate-check">
        <input
          type="checkbox"
          checked={packScheduleEnabled}
          onChange={(e) => setPackScheduleEnabled(e.target.checked)}
        />
        <span className="integrate-check-text">
          Enable the hourly collector schedule immediately
        </span>
      </label>
      <div className="panel-controls">
        <button
          className="next-action-button"
          onClick={() => void deployFlowLogPack()}
          disabled={
            deployingPack || groupId === "" || ports.packInstall === undefined
          }
        >
          {deployingPack ? "Installing pack..." : "Install pack and deploy"}
        </button>
        {ports.packInstall === undefined && (
          <span className="field-hint">
            This shell did not provide a pack install client - a wiring gap,
            not a runtime state.
          </span>
        )}
      </div>
      {packError !== "" && <pre className="result">{packError}</pre>}
      {packLines.length > 0 && <pre className="result">{packLines.join("\n")}</pre>}
    </div>
  );
}
