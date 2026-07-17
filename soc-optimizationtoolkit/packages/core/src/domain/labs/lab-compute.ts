/**
 * Lab compute request builders - roadmap Phase 5 (LAB-09: test VMs with
 * auto-shutdown - the lab's organic traffic generator for flow logs).
 *
 * Ported from the legacy UnifiedLab Phase7-Compute/Deploy-VMs.ps1:
 * - The two shipped VMs (vm-security in SecuritySubnet, vm-o11y in
 *   O11ySubnet), Ubuntu 22.04 LTS Gen2 Standard_B1s, Standard_LRS OS disk,
 *   NO public IPs, boot diagnostics disabled, password authentication with
 *   the localadmin user (the password is TRANSIENT deploy input - prompted
 *   in the legacy console, typed in the app screen; never stored).
 * - VM names: the legacy composed them through Get-ResourceName with a "vm"
 *   naming entry that DOES NOT EXIST in the shipped config, so prefix and
 *   suffix resolve empty and the effective name is
 *   "{baseObjectName}-{vmName}" (e.g. cribllab-vm-security). That quirk is
 *   carried VERBATIM as {@link labVmName}.
 * - The DevTest Labs auto-shutdown schedule
 *   (microsoft.devtestlab/schedules/shutdown-computevm-{vm}), verbatim
 *   properties: ComputeVmShutdownTask, daily 1900 Eastern Standard Time,
 *   notifications disabled.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto (the password is injected).
 */

import type { AzureManagementRequest } from "../../ports/azure-management";

/** ARM api-version for Microsoft.Compute virtual machines. */
export const LAB_COMPUTE_API_VERSION = "2023-09-01";

/** ARM api-version for microsoft.devtestlab/schedules (auto-shutdown). */
export const LAB_DEVTESTLAB_API_VERSION = "2018-09-15";

/** VM image + size settings (legacy virtualMachines.configuration). */
export interface LabVmSettings {
  vmSize: string;
  publisher: string;
  offer: string;
  sku: string;
  version: string;
  osDiskType: string;
  adminUsername: string;
  autoShutdownEnabled: boolean;
  /** HHmm 24-hour, legacy "1900". */
  autoShutdownTime: string;
  autoShutdownTimeZone: string;
}

/** The legacy VM defaults, verbatim (Ubuntu 22.04 B1s, 7 PM Eastern shutdown). */
export const DEFAULT_LAB_VM_SETTINGS: LabVmSettings = {
  vmSize: "Standard_B1s",
  publisher: "Canonical",
  offer: "0001-com-ubuntu-server-jammy",
  sku: "22_04-lts-gen2",
  version: "latest",
  osDiskType: "Standard_LRS",
  adminUsername: "localadmin",
  autoShutdownEnabled: true,
  autoShutdownTime: "1900",
  autoShutdownTimeZone: "Eastern Standard Time",
};

/** One VM to deploy (legacy virtualMachines.deployment entries). */
export interface LabVmDef {
  /** The subnet KEY the VM lands in (matches LabSubnet.key). */
  subnetKey: string;
  /** The legacy base VM name (vm-security / vm-o11y). */
  vmName: string;
}

/** The two shipped VMs, verbatim. */
export const DEFAULT_LAB_VMS: readonly LabVmDef[] = [
  { subnetKey: "security", vmName: "vm-security" },
  { subnetKey: "o11y", vmName: "vm-o11y" },
] as const;

/**
 * The effective VM name: "{baseObjectName}-{vmName}" - the VERBATIM outcome
 * of the legacy Get-ResourceName call whose "vm" naming entry never existed
 * (empty prefix and suffix), e.g. "cribllab-vm-security".
 */
export function labVmName(baseObjectName: string, vmName: string): string {
  return `${baseObjectName}-${vmName}`;
}

/** The VM's NIC name (legacy "{vmName}-nic"). */
export function labVmNicName(fullVmName: string): string {
  return `${fullVmName}-nic`;
}

function nicPath(
  subscriptionId: string,
  resourceGroup: string,
  nicName: string,
): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Network/networkInterfaces/${nicName}`
  );
}

/** GET one NIC. */
export function buildNicGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  nicName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: nicPath(subscriptionId, resourceGroup, nicName),
    apiVersion: LAB_COMPUTE_API_VERSION,
  };
}

/** PUT one NIC in the VM's subnet (dynamic private IP, no public IP - legacy). */
export function buildNicPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  nicName: string,
  location: string,
  subnetResourceId: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: nicPath(subscriptionId, resourceGroup, nicName),
    apiVersion: LAB_COMPUTE_API_VERSION,
    body: {
      location,
      properties: {
        ipConfigurations: [
          {
            name: "ipconfig1",
            properties: {
              subnet: { id: subnetResourceId },
              privateIPAllocationMethod: "Dynamic",
            },
          },
        ],
      },
    },
  };
}

function vmPath(
  subscriptionId: string,
  resourceGroup: string,
  vmName: string,
): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Compute/virtualMachines/${vmName}`
  );
}

/** GET one VM. */
export function buildVmGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  vmName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: vmPath(subscriptionId, resourceGroup, vmName),
    apiVersion: LAB_COMPUTE_API_VERSION,
  };
}

/** Inputs for {@link buildVmPutRequest}. */
export interface VmPutInput {
  subscriptionId: string;
  resourceGroup: string;
  vmName: string;
  location: string;
  settings: LabVmSettings;
  nicResourceId: string;
  /** TRANSIENT admin password - deploy input only, never stored. */
  adminPassword: string;
}

/**
 * PUT one Linux test VM (legacy composition: image reference, FromImage
 * managed OS disk, password auth, single NIC, boot diagnostics disabled).
 */
export function buildVmPutRequest(input: VmPutInput): AzureManagementRequest {
  const { settings } = input;
  return {
    method: "PUT",
    path: vmPath(input.subscriptionId, input.resourceGroup, input.vmName),
    apiVersion: LAB_COMPUTE_API_VERSION,
    body: {
      location: input.location,
      properties: {
        hardwareProfile: { vmSize: settings.vmSize },
        storageProfile: {
          imageReference: {
            publisher: settings.publisher,
            offer: settings.offer,
            sku: settings.sku,
            version: settings.version,
          },
          osDisk: {
            createOption: "FromImage",
            managedDisk: { storageAccountType: settings.osDiskType },
          },
        },
        osProfile: {
          computerName: input.vmName,
          adminUsername: settings.adminUsername,
          adminPassword: input.adminPassword,
          linuxConfiguration: { disablePasswordAuthentication: false },
        },
        networkProfile: {
          networkInterfaces: [{ id: input.nicResourceId }],
        },
        diagnosticsProfile: { bootDiagnostics: { enabled: false } },
      },
    },
  };
}

/** The VM's provisioningState from a GET/PUT body ("" if absent). */
export function parseVmProvisioningState(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return "";
  }
  const properties = (body as Record<string, unknown>)["properties"];
  if (typeof properties !== "object" || properties === null) {
    return "";
  }
  const state = (properties as Record<string, unknown>)["provisioningState"];
  return typeof state === "string" ? state : "";
}

/** The auto-shutdown schedule's resource name (legacy, verbatim). */
export function labShutdownScheduleName(fullVmName: string): string {
  return `shutdown-computevm-${fullVmName}`;
}

function schedulePath(
  subscriptionId: string,
  resourceGroup: string,
  fullVmName: string,
): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/microsoft.devtestlab/schedules/${labShutdownScheduleName(fullVmName)}`
  );
}

/** GET the VM's auto-shutdown schedule. */
export function buildShutdownScheduleGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  fullVmName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: schedulePath(subscriptionId, resourceGroup, fullVmName),
    apiVersion: LAB_DEVTESTLAB_API_VERSION,
  };
}

/** PUT the VM's auto-shutdown schedule (legacy properties, verbatim). */
export function buildShutdownSchedulePutRequest(
  subscriptionId: string,
  resourceGroup: string,
  fullVmName: string,
  location: string,
  settings: LabVmSettings,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: schedulePath(subscriptionId, resourceGroup, fullVmName),
    apiVersion: LAB_DEVTESTLAB_API_VERSION,
    body: {
      location,
      properties: {
        status: "Enabled",
        taskType: "ComputeVmShutdownTask",
        dailyRecurrence: { time: settings.autoShutdownTime },
        timeZoneId: settings.autoShutdownTimeZone,
        notificationSettings: { status: "Disabled" },
        targetResourceId: vmPath(subscriptionId, resourceGroup, fullVmName),
      },
    },
  };
}
