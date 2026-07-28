/**
 * Phase 4 - Monitoring (LAB-06, when the profile deploys Log Analytics or
 * Sentinel): the workspace via the EXISTING createWorkspace usecase (legacy
 * PerGB2018/90-day defaults, attempt-bounded provisioning poll) and Sentinel
 * via the EXISTING enableSentinel usecase (idempotent SecurityInsights
 * solution at the workspace's ACTUAL location).
 *
 * Phase 4b - Private Link (lab-privatelink): AMPLS + scoped workspace +
 * private endpoint + monitor DNS zone/link, private mode only.
 *
 * Sets ctx.workspaceReady - the DCR phase gates on it.
 */

import {
  WORKSPACE_API_VERSION,
  createWorkspace,
  enableSentinel,
} from "../azure-discovery";
import {
  LAB_MONITOR_PRIVATE_DNS_ZONE,
  buildAmplsGetRequest,
  buildAmplsPutRequest,
  buildAmplsScopedResourceGetRequest,
  buildAmplsScopedResourcePutRequest,
  buildDnsVnetLinkGetRequest,
  buildDnsVnetLinkPutRequest,
  buildPrivateDnsZoneGetRequest,
  buildPrivateDnsZonePutRequest,
  buildPrivateEndpointGetRequest,
  buildPrivateEndpointPutRequest,
  labAmplsName,
  labPrivateEndpointName,
} from "../../domain/labs/lab-privatelink";
import { DEFAULT_LAB_SUBNETS } from "../../domain/labs/lab-naming";
import { httpErrorText, is2xx } from "../arm-http";
import { ensureResource, type ArmExchange } from "./arm-resource";
import type { LabPhaseContext } from "./lab-phase-context";
import {
  NOT_REQUESTED,
  PREREQUISITE_FAILED,
  type LabMonitoringOutcome,
  type LabPrivateLinkOutcome,
} from "./provision-lab-types";

/** Run the monitoring (+ private-link) phase (sequencer guards on hasStep). */
export async function runMonitoringPhase(ctx: LabPhaseContext): Promise<void> {
  const { azure, input, result, errors, sub, rg, logger } = ctx;
  const monitoring: LabMonitoringOutcome = {
    workspaceName: input.names.logAnalytics,
    workspaceCreated: false,
    sentinelEnabled: false,
    sentinelAlreadyEnabled: false,
  };
  result.monitoring = monitoring;

  // --- log-analytics --------------------------------------------------------
  if (
    !input.flags.monitoring.deployLogAnalytics &&
    !input.flags.monitoring.deploySentinel
  ) {
    await ctx.skipSteps(["log-analytics"], NOT_REQUESTED);
  } else {
    await ctx.setStep("log-analytics", "running");
    const getWorkspace = await azure.request({
      method: "GET",
      path:
        `/subscriptions/${sub}/resourceGroups/${rg}` +
        `/providers/Microsoft.OperationalInsights/workspaces/${monitoring.workspaceName}`,
      apiVersion: WORKSPACE_API_VERSION,
    });
    if (is2xx(getWorkspace.status)) {
      ctx.workspaceReady = true;
      await ctx.setStep("log-analytics", "succeeded", "already existed");
    } else if (getWorkspace.status === 404) {
      try {
        await createWorkspace(
          azure,
          {
            subscriptionId: sub,
            resourceGroup: rg,
            name: monitoring.workspaceName,
            location: input.location,
            maxPollAttempts: ctx.maxAttempts,
          },
          logger,
        );
        monitoring.workspaceCreated = true;
        ctx.workspaceReady = true;
        await ctx.setStep("log-analytics", "succeeded", "created (PerGB2018, 90-day retention)");
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        errors.push(error);
        await ctx.setStep("log-analytics", "failed", error);
      }
    } else {
      const error = httpErrorText(
        `read workspace '${monitoring.workspaceName}'`,
        getWorkspace.status,
        getWorkspace.body,
      );
      errors.push(error);
      await ctx.setStep("log-analytics", "failed", error);
    }
  }

  // --- microsoft-sentinel ---------------------------------------------------
  if (!input.flags.monitoring.deploySentinel) {
    await ctx.skipSteps(["microsoft-sentinel"], NOT_REQUESTED);
  } else if (!ctx.workspaceReady) {
    await ctx.skipSteps(["microsoft-sentinel"], PREREQUISITE_FAILED);
  } else {
    await ctx.setStep("microsoft-sentinel", "running");
    try {
      const enabled = await enableSentinel(
        azure,
        {
          subscriptionId: sub,
          resourceGroup: rg,
          workspaceName: monitoring.workspaceName,
        },
        logger,
      );
      monitoring.sentinelEnabled = true;
      monitoring.sentinelAlreadyEnabled = enabled.alreadyEnabled;
      await ctx.setStep(
        "microsoft-sentinel",
        "succeeded",
        enabled.alreadyEnabled ? "already enabled" : `enabled (${enabled.solutionName})`,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      errors.push(error);
      await ctx.setStep("microsoft-sentinel", "failed", error);
    }
  }

  // --- private-link (AMPLS + endpoint + DNS; legacy Deploy-PrivateLink) ---
  if (!ctx.hasStep("private-link")) {
    return;
  }
  if (!ctx.workspaceReady) {
    await ctx.skipSteps(["private-link"], PREREQUISITE_FAILED);
    return;
  }
  await ctx.setStep("private-link", "running");
  const amplsName = labAmplsName(input.baseObjectName, input.location);
  const peName = labPrivateEndpointName(input.baseObjectName);
  const privateLink: LabPrivateLinkOutcome = {
    amplsName,
    privateEndpointName: peName,
    dnsZoneLinked: false,
  };
  result.privateLink = privateLink;
  const amplsId =
    `/subscriptions/${sub}/resourceGroups/${rg}` +
    `/providers/microsoft.insights/privateLinkScopes/${amplsName}`;
  const workspaceId =
    `/subscriptions/${sub}/resourceGroups/${rg}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${input.names.logAnalytics}`;
  const plSubnet =
    (input.subnets ?? DEFAULT_LAB_SUBNETS).find((s) => s.key === "privatelink")?.name ??
    "PrivateLinkSubnet";
  const vnetId =
    `/subscriptions/${sub}/resourceGroups/${rg}` +
    `/providers/Microsoft.Network/virtualNetworks/${input.names.vnet}`;
  let plError = "";

  const ensure = async (
    get: () => Promise<ArmExchange>,
    put: () => Promise<ArmExchange>,
    context: string,
  ): Promise<boolean> => {
    if (plError !== "") {
      return false;
    }
    const ensured = await ensureResource({ get, put, context });
    if (ensured.status === "failed") {
      plError = ensured.error ?? "";
      return false;
    }
    return true;
  };

  await ensure(
    () => azure.request(buildAmplsGetRequest(sub, rg, amplsName)),
    () => azure.request(buildAmplsPutRequest(sub, rg, amplsName)),
    `AMPLS '${amplsName}'`,
  );
  await ensure(
    () => azure.request(buildAmplsScopedResourceGetRequest(sub, rg, amplsName)),
    () =>
      azure.request(buildAmplsScopedResourcePutRequest(sub, rg, amplsName, workspaceId)),
    "AMPLS workspace association",
  );
  await ensure(
    () => azure.request(buildPrivateEndpointGetRequest(sub, rg, peName)),
    () =>
      azure.request(
        buildPrivateEndpointPutRequest(
          sub,
          rg,
          peName,
          input.location,
          `${vnetId}/subnets/${plSubnet}`,
          amplsId,
        ),
      ),
    `private endpoint '${peName}'`,
  );
  const zoneReady = await ensure(
    () =>
      azure.request(buildPrivateDnsZoneGetRequest(sub, rg, LAB_MONITOR_PRIVATE_DNS_ZONE)),
    () =>
      azure.request(buildPrivateDnsZonePutRequest(sub, rg, LAB_MONITOR_PRIVATE_DNS_ZONE)),
    `private DNS zone '${LAB_MONITOR_PRIVATE_DNS_ZONE}'`,
  );
  if (zoneReady) {
    const linked = await ensure(
      () =>
        azure.request(
          buildDnsVnetLinkGetRequest(
            sub,
            rg,
            LAB_MONITOR_PRIVATE_DNS_ZONE,
            input.names.vnet,
          ),
        ),
      () =>
        azure.request(
          buildDnsVnetLinkPutRequest(
            sub,
            rg,
            LAB_MONITOR_PRIVATE_DNS_ZONE,
            input.names.vnet,
            vnetId,
          ),
        ),
      "DNS zone VNet link",
    );
    privateLink.dnsZoneLinked = linked;
  }

  if (plError !== "") {
    errors.push(plError);
    await ctx.setStep("private-link", "failed", plError);
  } else {
    await ctx.setStep(
      "private-link",
      "succeeded",
      `${amplsName}, ${peName}, DNS zone linked`,
    );
  }
}
