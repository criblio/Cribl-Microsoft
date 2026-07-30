/**
 * Phase 7 - Compute (lab-compute): the two test VMs (NIC + VM + DevTest
 * auto-shutdown), password as TRANSIENT input; schedule failures degrade to
 * warnings (legacy behavior).
 */

import {
  DEFAULT_LAB_VMS,
  DEFAULT_LAB_VM_SETTINGS,
  buildNicGetRequest,
  buildNicPutRequest,
  buildShutdownScheduleGetRequest,
  buildShutdownSchedulePutRequest,
  buildVmGetRequest,
  buildVmPutRequest,
  labVmName,
  labVmNicName,
  parseVmProvisioningState,
} from "../../domain/labs/lab-compute";
import { DEFAULT_LAB_SUBNETS } from "../../domain/labs/lab-naming";
import { httpErrorText, is2xx } from "../arm-http";
import { ensureResource, pollProvisioningState } from "./arm-resource";
import type { LabPhaseContext } from "./lab-phase-context";
import type { LabComputeOutcome } from "./provision-lab-types";

/** Run the compute phase (the sequencer guards on hasStep). */
export async function runComputePhase(ctx: LabPhaseContext): Promise<void> {
  const { azure, input, result, errors, sub, rg, logger } = ctx;
  await ctx.setStep("virtual-machines", "running");
  const settings = input.vmSettings ?? DEFAULT_LAB_VM_SETTINGS;
  const compute: LabComputeOutcome = {
    vms: [],
    autoShutdownConfigured: settings.autoShutdownEnabled,
  };
  result.compute = compute;
  const password = input.vmAdminPassword ?? "";
  let vmError = "";

  if (password === "") {
    vmError =
      "VM admin password is required (transient deploy input) - supply it and re-run; " +
      "existing VMs are picked up without it on a re-run";
  } else {
    const vnetId =
      `/subscriptions/${sub}/resourceGroups/${rg}` +
      `/providers/Microsoft.Network/virtualNetworks/${input.names.vnet}`;
    const subnets = input.subnets ?? DEFAULT_LAB_SUBNETS;
    for (const vm of input.vms ?? DEFAULT_LAB_VMS) {
      const subnet = subnets.find((s) => s.key === vm.subnetKey);
      if (subnet === undefined) {
        vmError = `VM '${vm.vmName}' targets unknown subnet key '${vm.subnetKey}'`;
        break;
      }
      const fullName = labVmName(input.baseObjectName, vm.vmName);
      const nicName = labVmNicName(fullName);

      const getVm = await azure.request(buildVmGetRequest(sub, rg, fullName));
      if (is2xx(getVm.status)) {
        compute.vms.push({ name: fullName, created: false });
      } else if (getVm.status === 404) {
        const ensuredNic = await ensureResource({
          get: () => azure.request(buildNicGetRequest(sub, rg, nicName)),
          put: () =>
            azure.request(
              buildNicPutRequest(
                sub,
                rg,
                nicName,
                input.location,
                `${vnetId}/subnets/${subnet.name}`,
              ),
            ),
          context: `NIC '${nicName}'`,
        });
        if (ensuredNic.status === "failed") {
          vmError = ensuredNic.error ?? "";
          break;
        }
        const nicId =
          `/subscriptions/${sub}/resourceGroups/${rg}` +
          `/providers/Microsoft.Network/networkInterfaces/${nicName}`;
        const putVm = await azure.request(
          buildVmPutRequest({
            subscriptionId: sub,
            resourceGroup: rg,
            vmName: fullName,
            location: input.location,
            settings,
            nicResourceId: nicId,
            adminPassword: password,
          }),
        );
        if (!is2xx(putVm.status)) {
          vmError = httpErrorText(
            `create VM '${fullName}'`,
            putVm.status,
            putVm.body,
          );
          break;
        }
        const state = await pollProvisioningState({
          read: () => azure.request(buildVmGetRequest(sub, rg, fullName)),
          parse: parseVmProvisioningState,
          seed: parseVmProvisioningState(putVm.body),
          attempts: ctx.longPollAttempts,
          sleep: ctx.sleep,
          delayMs: ctx.delayMs,
        });
        if (state !== "Succeeded") {
          vmError =
            `VM '${fullName}' did not reach Succeeded within ` +
            `${ctx.longPollAttempts} poll attempt(s)`;
          break;
        }
        compute.vms.push({ name: fullName, created: true });
      } else {
        vmError = httpErrorText(`read VM '${fullName}'`, getVm.status, getVm.body);
        break;
      }

      if (settings.autoShutdownEnabled) {
        const getSchedule = await azure.request(
          buildShutdownScheduleGetRequest(sub, rg, fullName),
        );
        if (getSchedule.status === 404) {
          const putSchedule = await azure.request(
            buildShutdownSchedulePutRequest(sub, rg, fullName, input.location, settings),
          );
          if (!is2xx(putSchedule.status)) {
            // Legacy treated schedule failures as warnings, not VM failures.
            logger?.warn(
              "provision-lab: auto-shutdown schedule failed",
              { vm: fullName, status: putSchedule.status },
              ctx.jobId,
            );
          }
        }
      }
    }
  }

  if (vmError !== "") {
    errors.push(vmError);
    await ctx.setStep("virtual-machines", "failed", vmError);
  } else {
    await ctx.setStep(
      "virtual-machines",
      "succeeded",
      compute.vms.map((v) => v.name).join(", "),
    );
  }
}
