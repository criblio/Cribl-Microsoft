/**
 * Phase 10 - Gateway (lab-gateway): public IP + VPN gateway (30-45 min LONG
 * poll; exhaustion fails honestly and a re-run resumes GET-first) and the
 * optional site-to-site connection when the on-prem details are configured.
 */

import {
  DEFAULT_LAB_VPN_GATEWAY,
  buildGatewayPublicIpGetRequest,
  buildGatewayPublicIpPutRequest,
  buildLocalNetworkGatewayGetRequest,
  buildLocalNetworkGatewayPutRequest,
  buildVpnConnectionGetRequest,
  buildVpnConnectionPutRequest,
  buildVpnGatewayGetRequest,
  buildVpnGatewayPutRequest,
  isOnPremConnectionConfigured,
  LAB_LOCAL_NETWORK_GATEWAY_NAME,
  LAB_VPN_CONNECTION_NAME,
} from "../../domain/labs/lab-gateway";
import { httpErrorText, is2xx } from "../arm-http";
import {
  armProvisioningState,
  ensureResource,
  pollProvisioningState,
} from "./arm-resource";
import type { LabPhaseContext } from "./lab-phase-context";
import { PREREQUISITE_FAILED, type LabGatewayOutcome } from "./provision-lab-types";

/** Run the gateway (+ optional connection) phase (sequencer guards hasStep). */
export async function runGatewayPhase(ctx: LabPhaseContext): Promise<void> {
  const { azure, input, result, errors, sub, rg } = ctx;
  await ctx.setStep("vpn-gateway", "running");
  const gateway: LabGatewayOutcome = {
    publicIpName: input.names.vpnPublicIp,
    gatewayName: input.names.vpnGateway,
    gatewayReady: false,
    provisioningState: "",
  };
  result.gateway = gateway;
  let gwError = "";

  const getGw = await azure.request(
    buildVpnGatewayGetRequest(sub, rg, gateway.gatewayName),
  );
  if (is2xx(getGw.status)) {
    gateway.provisioningState = armProvisioningState(getGw.body);
    gateway.gatewayReady = gateway.provisioningState === "Succeeded";
  } else if (getGw.status === 404) {
    const ensuredPip = await ensureResource({
      get: () =>
        azure.request(buildGatewayPublicIpGetRequest(sub, rg, gateway.publicIpName)),
      put: () =>
        azure.request(
          buildGatewayPublicIpPutRequest(sub, rg, gateway.publicIpName, input.location),
        ),
      context: `public IP '${gateway.publicIpName}'`,
    });
    if (ensuredPip.status === "failed") {
      gwError = ensuredPip.error ?? "";
    }
    if (gwError === "") {
      const vnetId =
        `/subscriptions/${sub}/resourceGroups/${rg}` +
        `/providers/Microsoft.Network/virtualNetworks/${input.names.vnet}`;
      const putGw = await azure.request(
        buildVpnGatewayPutRequest({
          subscriptionId: sub,
          resourceGroup: rg,
          gatewayName: gateway.gatewayName,
          location: input.location,
          gatewaySubnetResourceId: `${vnetId}/subnets/GatewaySubnet`,
          publicIpResourceId:
            `/subscriptions/${sub}/resourceGroups/${rg}` +
            `/providers/Microsoft.Network/publicIPAddresses/${gateway.publicIpName}`,
          settings: input.vpnGatewaySettings ?? DEFAULT_LAB_VPN_GATEWAY,
        }),
      );
      if (!is2xx(putGw.status)) {
        gwError = httpErrorText(
          `create VPN gateway '${gateway.gatewayName}'`,
          putGw.status,
          putGw.body,
        );
      } else {
        // The 30-45 minute operation: the LONG poll bound; exhaustion is an
        // honest still-provisioning failure and a re-run resumes GET-first.
        const state = await pollProvisioningState({
          read: () =>
            azure.request(buildVpnGatewayGetRequest(sub, rg, gateway.gatewayName)),
          parse: armProvisioningState,
          seed: armProvisioningState(putGw.body),
          attempts: ctx.longPollAttempts,
          sleep: ctx.sleep,
          delayMs: ctx.delayMs,
        });
        gateway.provisioningState = state;
        gateway.gatewayReady = state === "Succeeded";
        if (!gateway.gatewayReady) {
          gwError =
            `VPN gateway '${gateway.gatewayName}' is still provisioning after ` +
            `${ctx.longPollAttempts} poll attempt(s) (30-45 minutes is normal) - ` +
            "Azure continues server-side; re-run the deploy later to resume";
        }
      }
    }
  } else {
    gwError = httpErrorText(
      `read VPN gateway '${gateway.gatewayName}'`,
      getGw.status,
      getGw.body,
    );
  }

  if (gwError !== "") {
    errors.push(gwError);
    await ctx.setStep("vpn-gateway", "failed", gwError);
  } else {
    await ctx.setStep(
      "vpn-gateway",
      "succeeded",
      `${gateway.gatewayName} (${gateway.provisioningState})`,
    );
  }

  // --- vpn-connection (optional on-premises site-to-site) -----------------
  if (!ctx.hasStep("vpn-connection")) {
    return;
  }
  const onPrem = input.onPrem;
  if (!isOnPremConnectionConfigured(onPrem)) {
    await ctx.skipSteps(
      ["vpn-connection"],
      "on-premises connection not configured (device IP, address spaces, shared key)",
    );
    return;
  }
  if (!gateway.gatewayReady) {
    await ctx.skipSteps(["vpn-connection"], PREREQUISITE_FAILED);
    return;
  }
  await ctx.setStep("vpn-connection", "running");
  let connError = "";
  const ensuredLng = await ensureResource({
    get: () => azure.request(buildLocalNetworkGatewayGetRequest(sub, rg)),
    put: () =>
      azure.request(
        buildLocalNetworkGatewayPutRequest(sub, rg, input.location, onPrem),
      ),
    context: `local network gateway '${LAB_LOCAL_NETWORK_GATEWAY_NAME}'`,
  });
  if (ensuredLng.status === "failed") {
    connError = ensuredLng.error ?? "";
  }
  if (connError === "") {
    const ensuredConn = await ensureResource({
      get: () => azure.request(buildVpnConnectionGetRequest(sub, rg)),
      put: () =>
        azure.request(
          buildVpnConnectionPutRequest(
            sub,
            rg,
            input.location,
            `/subscriptions/${sub}/resourceGroups/${rg}` +
              `/providers/Microsoft.Network/virtualNetworkGateways/${gateway.gatewayName}`,
            `/subscriptions/${sub}/resourceGroups/${rg}` +
              `/providers/Microsoft.Network/localNetworkGateways/${LAB_LOCAL_NETWORK_GATEWAY_NAME}`,
            onPrem.sharedKey,
          ),
        ),
      context: `VPN connection '${LAB_VPN_CONNECTION_NAME}'`,
    });
    if (ensuredConn.status === "failed") {
      connError = ensuredConn.error ?? "";
    }
  }
  if (connError !== "") {
    errors.push(connError);
    await ctx.setStep("vpn-connection", "failed", connError);
  } else {
    gateway.connectionName = LAB_VPN_CONNECTION_NAME;
    await ctx.setStep(
      "vpn-connection",
      "succeeded",
      `${LAB_VPN_CONNECTION_NAME} via ${LAB_LOCAL_NETWORK_GATEWAY_NAME}`,
    );
  }
}
