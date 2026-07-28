/**
 * Phase 6 - Flow logs (lab-flowlogs): resolved Network Watcher (lab-named ->
 * Azure default -> create), vNet-level + per-subnet flow logs with the
 * legacy dual-level retention; the one-flow-log-per-target conflict is an
 * idempotent hit (isFlowLogAlreadyExistsError), which is why this phase
 * keeps its own ensure instead of the toolkit's.
 */

import {
  AZURE_NETWORK_WATCHER_RG,
  DEFAULT_LAB_FLOW_LOG_SETTINGS,
  azureDefaultNetworkWatcherName,
  buildFlowLogGetRequest,
  buildFlowLogPutRequest,
  buildNetworkWatcherGetRequest,
  buildNetworkWatcherPutRequest,
  isFlowLogAlreadyExistsError,
  labFlowLogName,
} from "../../domain/labs/lab-flowlogs";
import { DEFAULT_LAB_SUBNETS } from "../../domain/labs/lab-naming";
import { httpErrorText, is2xx } from "../arm-http";
import type { LabPhaseContext } from "./lab-phase-context";
import type { LabFlowLogsOutcome } from "./provision-lab-types";

/** Run the flow-logs phase (the sequencer guards on hasStep). */
export async function runFlowLogsPhase(ctx: LabPhaseContext): Promise<void> {
  const { azure, input, result, errors, sub, rg } = ctx;
  await ctx.setStep("flow-logs", "running");
  const settings = input.flowLogSettings ?? DEFAULT_LAB_FLOW_LOG_SETTINGS;
  const storageAccountName = result.storage?.accountName ?? input.names.storageAccount;
  const storageId =
    `/subscriptions/${sub}/resourceGroups/${rg}` +
    `/providers/Microsoft.Storage/storageAccounts/${storageAccountName}`;
  const vnetId =
    `/subscriptions/${sub}/resourceGroups/${rg}` +
    `/providers/Microsoft.Network/virtualNetworks/${input.names.vnet}`;
  let flError = "";

  // Watcher resolution, legacy order: lab-named -> Azure default -> create.
  let watcherRg = rg;
  let watcherName = input.names.networkWatcher;
  const labWatcher = await azure.request(
    buildNetworkWatcherGetRequest(sub, rg, watcherName),
  );
  if (!is2xx(labWatcher.status)) {
    const defaultWatcher = await azure.request(
      buildNetworkWatcherGetRequest(
        sub,
        AZURE_NETWORK_WATCHER_RG,
        azureDefaultNetworkWatcherName(input.location),
      ),
    );
    if (is2xx(defaultWatcher.status)) {
      watcherRg = AZURE_NETWORK_WATCHER_RG;
      watcherName = azureDefaultNetworkWatcherName(input.location);
    } else {
      const createWatcher = await azure.request(
        buildNetworkWatcherPutRequest(sub, rg, watcherName, input.location),
      );
      if (!is2xx(createWatcher.status)) {
        flError = httpErrorText(
          `create Network Watcher '${watcherName}'`,
          createWatcher.status,
          createWatcher.body,
        );
      }
    }
  }

  const flowLogs: LabFlowLogsOutcome = {
    networkWatcher: `${watcherRg}/${watcherName}`,
    flowLogs: [],
  };
  result.flowLogs = flowLogs;

  const ensureFlowLog = async (
    name: string,
    targetResourceId: string,
    retentionDays: number,
  ): Promise<void> => {
    if (flError !== "") {
      return;
    }
    const got = await azure.request(
      buildFlowLogGetRequest(sub, watcherRg, watcherName, name),
    );
    if (is2xx(got.status)) {
      flowLogs.flowLogs.push({ name, created: false });
      return;
    }
    const put = await azure.request(
      buildFlowLogPutRequest({
        subscriptionId: sub,
        networkWatcherResourceGroup: watcherRg,
        networkWatcherName: watcherName,
        flowLogName: name,
        location: input.location,
        targetResourceId,
        storageAccountResourceId: storageId,
        retentionDays,
      }),
    );
    if (is2xx(put.status)) {
      flowLogs.flowLogs.push({ name, created: true });
    } else if (isFlowLogAlreadyExistsError(put.body)) {
      // The target already carries a flow log under another name (legacy
      // treated this conflict as already-exists).
      flowLogs.flowLogs.push({ name, created: false });
    } else {
      flError = httpErrorText(`create flow log '${name}'`, put.status, put.body);
    }
  };

  if (settings.vnetLevel.enabled) {
    await ensureFlowLog(
      labFlowLogName(input.names.vnet),
      vnetId,
      settings.vnetLevel.retentionDays,
    );
  }
  for (const subnet of input.subnets ?? DEFAULT_LAB_SUBNETS) {
    const subnetSettings = settings.subnetLevel[subnet.key];
    if (subnetSettings === undefined || !subnetSettings.enabled) {
      continue;
    }
    await ensureFlowLog(
      labFlowLogName(input.names.vnet, subnet.name),
      `${vnetId}/subnets/${subnet.name}`,
      subnetSettings.retentionDays,
    );
  }

  if (flError !== "") {
    errors.push(flError);
    await ctx.setStep("flow-logs", "failed", flError);
  } else {
    await ctx.setStep(
      "flow-logs",
      "succeeded",
      `${flowLogs.flowLogs.length} flow log(s) via ${flowLogs.networkWatcher}`,
    );
  }
}
