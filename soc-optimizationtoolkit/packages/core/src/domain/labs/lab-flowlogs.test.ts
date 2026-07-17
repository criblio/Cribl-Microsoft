import { describe, expect, it } from "vitest";
import {
  AZURE_NETWORK_WATCHER_RG,
  DEFAULT_LAB_FLOW_LOG_SETTINGS,
  azureDefaultNetworkWatcherName,
  buildFlowLogPutRequest,
  isFlowLogAlreadyExistsError,
  labFlowLogName,
} from "./lab-flowlogs";

const SUB = "11111111-2222-3333-4444-555555555555";

describe("lab-flowlogs", () => {
  it("names flow logs FlowLog-{vnet}[-{subnet}] (legacy, verbatim)", () => {
    expect(labFlowLogName("vnet-lab-eastus")).toBe("FlowLog-vnet-lab-eastus");
    expect(labFlowLogName("vnet-lab-eastus", "SecuritySubnet")).toBe(
      "FlowLog-vnet-lab-eastus-SecuritySubnet",
    );
  });

  it("resolves Azure's default watcher NetworkWatcherRG/NetworkWatcher_{location}", () => {
    expect(AZURE_NETWORK_WATCHER_RG).toBe("NetworkWatcherRG");
    expect(azureDefaultNetworkWatcherName("eastus")).toBe("NetworkWatcher_eastus");
  });

  it("ships the legacy dual-level retention defaults verbatim", () => {
    expect(DEFAULT_LAB_FLOW_LOG_SETTINGS.vnetLevel.retentionDays).toBe(7);
    expect(DEFAULT_LAB_FLOW_LOG_SETTINGS.subnetLevel["gateway"].retentionDays).toBe(1);
    expect(DEFAULT_LAB_FLOW_LOG_SETTINGS.subnetLevel["security"].retentionDays).toBe(7);
    expect(DEFAULT_LAB_FLOW_LOG_SETTINGS.subnetLevel["privatelink"].retentionDays).toBe(1);
  });

  it("PUTs the flow log against the RESOLVED watcher's resource group", () => {
    const request = buildFlowLogPutRequest({
      subscriptionId: SUB,
      networkWatcherResourceGroup: "NetworkWatcherRG",
      networkWatcherName: "NetworkWatcher_eastus",
      flowLogName: "FlowLog-vnet-lab-eastus",
      location: "eastus",
      targetResourceId: "/vnet-id",
      storageAccountResourceId: "/storage-id",
      retentionDays: 7,
    });
    expect(request.path).toBe(
      `/subscriptions/${SUB}/resourceGroups/NetworkWatcherRG` +
        "/providers/Microsoft.Network/networkWatchers/NetworkWatcher_eastus" +
        "/flowLogs/FlowLog-vnet-lab-eastus",
    );
    const properties = (request.body as any).properties;
    expect(properties.targetResourceId).toBe("/vnet-id");
    expect(properties.storageId).toBe("/storage-id");
    expect(properties.enabled).toBe(true);
    expect(properties.retentionPolicy).toEqual({ days: 7, enabled: true });
  });

  it("recognizes the one-flow-log-per-target conflict as already-exists (legacy)", () => {
    expect(
      isFlowLogAlreadyExistsError({
        error: { code: "CannotCreateMoreThanOneFlowLogPerTargetResource" },
      }),
    ).toBe(true);
    expect(isFlowLogAlreadyExistsError({ error: { code: "Conflict" } })).toBe(false);
    expect(isFlowLogAlreadyExistsError(null)).toBe(false);
  });
});
