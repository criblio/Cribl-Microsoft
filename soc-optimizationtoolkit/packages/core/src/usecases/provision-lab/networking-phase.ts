/**
 * Phase 3 - Networking (LAB-03, when the profile deploys a VNet): one NSG
 * per non-Gateway subnet with the verbatim legacy rule set, then ONE VNet
 * PUT carrying the full desired subnet set with inline NSG associations
 * (the legacy add/remove/associate synchronization, in one request - a
 * recorded redesign). The legacy execution order (Storage before
 * Networking) is preserved by the sequencer.
 */

import {
  DEFAULT_LAB_NETWORK_SECURITY,
  buildNsgGetRequest,
  buildNsgPutRequest,
  buildVnetGetRequest,
  buildVnetPutRequest,
  labNsgSecurityRules,
  parseVnetProvisioningState,
} from "../../domain/labs/lab-networking";
import {
  DEFAULT_LAB_SUBNETS,
  DEFAULT_LAB_VNET_CIDR,
} from "../../domain/labs/lab-naming";
import { httpErrorText, is2xx } from "../arm-http";
import { ensureResource, pollProvisioningState } from "./arm-resource";
import type { LabPhaseContext } from "./lab-phase-context";
import { NOT_REQUESTED, type LabNetworkingOutcome } from "./provision-lab-types";

/** Run the networking phase (the sequencer guards on hasStep). */
export async function runNetworkingPhase(ctx: LabPhaseContext): Promise<void> {
  const { azure, input, result, errors, sub, rg } = ctx;
  const networking: LabNetworkingOutcome = {
    vnetName: input.names.vnet,
    nsgs: [],
  };
  result.networking = networking;
  const subnets = input.subnets ?? DEFAULT_LAB_SUBNETS;
  const ensuredNsgByKey: Record<string, string> = {};

  // --- network-security-groups --------------------------------------------
  if (!input.flags.infrastructure.deployNSGs) {
    await ctx.skipSteps(["network-security-groups"], NOT_REQUESTED);
  } else {
    await ctx.setStep("network-security-groups", "running");
    const rules = labNsgSecurityRules(
      input.networkSecurity ?? DEFAULT_LAB_NETWORK_SECURITY,
    );
    const failures: string[] = [];
    for (const [subnetKey, nsgName] of Object.entries(input.names.nsgBySubnet)) {
      const ensured = await ensureResource({
        get: () => azure.request(buildNsgGetRequest(sub, rg, nsgName)),
        put: () =>
          azure.request(buildNsgPutRequest(sub, rg, nsgName, input.location, rules)),
        context: `NSG '${nsgName}'`,
        missOn: "any-non-2xx",
      });
      if (ensured.status === "failed") {
        failures.push(ensured.error ?? "");
      } else {
        networking.nsgs.push({ name: nsgName, created: ensured.status === "created" });
        ensuredNsgByKey[subnetKey] = nsgName;
      }
    }
    if (failures.length > 0) {
      errors.push(...failures);
      await ctx.setStep("network-security-groups", "failed", failures.join("; "));
    } else {
      await ctx.setStep(
        "network-security-groups",
        "succeeded",
        networking.nsgs.map((n) => n.name).join(", "),
      );
    }
  }

  // --- virtual-network ------------------------------------------------------
  // The desired-state PUT: full subnet set with inline associations for the
  // NSGs that actually exist (a failed NSG never gets referenced).
  await ctx.setStep("virtual-network", "running");
  const putVnet = await azure.request(
    buildVnetPutRequest({
      subscriptionId: sub,
      resourceGroup: rg,
      vnetName: networking.vnetName,
      location: input.location,
      vnetCidr: input.vnetCidr ?? DEFAULT_LAB_VNET_CIDR,
      subnets,
      nsgNameBySubnetKey: ensuredNsgByKey,
    }),
  );
  if (!is2xx(putVnet.status)) {
    const error = httpErrorText(
      `deploy VNet '${networking.vnetName}'`,
      putVnet.status,
      putVnet.body,
    );
    errors.push(error);
    await ctx.setStep("virtual-network", "failed", error);
    return;
  }
  const state = await pollProvisioningState({
    read: () => azure.request(buildVnetGetRequest(sub, rg, networking.vnetName)),
    parse: parseVnetProvisioningState,
    seed: parseVnetProvisioningState(putVnet.body),
    attempts: ctx.maxAttempts,
    sleep: ctx.sleep,
    delayMs: ctx.delayMs,
  });
  if (state === "Succeeded") {
    await ctx.setStep(
      "virtual-network",
      "succeeded",
      `${networking.vnetName} with ${subnets.length} subnet(s)`,
    );
  } else {
    const error =
      `VNet '${networking.vnetName}' did not reach provisioningState ` +
      `Succeeded within ${ctx.maxAttempts} attempt(s)`;
    errors.push(error);
    await ctx.setStep("virtual-network", "failed", error);
  }
}
