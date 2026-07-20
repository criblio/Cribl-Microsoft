import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAB_VMS,
  DEFAULT_LAB_VM_SETTINGS,
  buildNicPutRequest,
  buildShutdownSchedulePutRequest,
  buildVmPutRequest,
  labShutdownScheduleName,
  labVmName,
  labVmNicName,
} from "./lab-compute";

const SUB = "11111111-2222-3333-4444-555555555555";
const RG = "rg-lab-FlowLogLab";

describe("lab-compute", () => {
  it("names VMs {base}-{vmName} - the verbatim legacy empty-naming-entry quirk", () => {
    expect(labVmName("cribllab", "vm-security")).toBe("cribllab-vm-security");
    expect(labVmNicName("cribllab-vm-security")).toBe("cribllab-vm-security-nic");
    expect(labShutdownScheduleName("cribllab-vm-security")).toBe(
      "shutdown-computevm-cribllab-vm-security",
    );
  });

  it("ships the two legacy VMs and Ubuntu B1s defaults verbatim", () => {
    expect(DEFAULT_LAB_VMS.map((vm) => vm.vmName)).toEqual(["vm-security", "vm-o11y"]);
    expect(DEFAULT_LAB_VM_SETTINGS.vmSize).toBe("Standard_B1s");
    expect(DEFAULT_LAB_VM_SETTINGS.offer).toBe("0001-com-ubuntu-server-jammy");
    expect(DEFAULT_LAB_VM_SETTINGS.adminUsername).toBe("localadmin");
    expect(DEFAULT_LAB_VM_SETTINGS.autoShutdownTime).toBe("1900");
  });

  it("PUTs a NIC with a dynamic private IP and NO public IP (legacy)", () => {
    const request = buildNicPutRequest(SUB, RG, "vm1-nic", "eastus", "/subnet-id");
    const ipConfig = (request.body as any).properties.ipConfigurations[0];
    expect(ipConfig.properties.subnet.id).toBe("/subnet-id");
    expect(ipConfig.properties.privateIPAllocationMethod).toBe("Dynamic");
    expect(ipConfig.properties.publicIPAddress).toBeUndefined();
  });

  it("PUTs the VM with the legacy composition (image, FromImage disk, password auth, no boot diag)", () => {
    const request = buildVmPutRequest({
      subscriptionId: SUB,
      resourceGroup: RG,
      vmName: "cribllab-vm-security",
      location: "eastus",
      settings: DEFAULT_LAB_VM_SETTINGS,
      nicResourceId: "/nic-id",
      adminPassword: "transient-password-1!",
    });
    const properties = (request.body as any).properties;
    expect(properties.hardwareProfile.vmSize).toBe("Standard_B1s");
    expect(properties.storageProfile.imageReference.sku).toBe("22_04-lts-gen2");
    expect(properties.storageProfile.osDisk.createOption).toBe("FromImage");
    expect(properties.osProfile.adminUsername).toBe("localadmin");
    expect(properties.osProfile.adminPassword).toBe("transient-password-1!");
    expect(properties.osProfile.linuxConfiguration.disablePasswordAuthentication).toBe(false);
    expect(properties.networkProfile.networkInterfaces[0].id).toBe("/nic-id");
    expect(properties.diagnosticsProfile.bootDiagnostics.enabled).toBe(false);
  });

  it("PUTs the auto-shutdown schedule with the verbatim legacy properties", () => {
    const request = buildShutdownSchedulePutRequest(
      SUB,
      RG,
      "cribllab-vm-security",
      "eastus",
      DEFAULT_LAB_VM_SETTINGS,
    );
    expect(request.path).toContain(
      "/providers/microsoft.devtestlab/schedules/shutdown-computevm-cribllab-vm-security",
    );
    const properties = (request.body as any).properties;
    expect(properties.taskType).toBe("ComputeVmShutdownTask");
    expect(properties.dailyRecurrence).toEqual({ time: "1900" });
    expect(properties.timeZoneId).toBe("Eastern Standard Time");
    expect(properties.notificationSettings.status).toBe("Disabled");
    expect(properties.targetResourceId).toContain(
      "/providers/Microsoft.Compute/virtualMachines/cribllab-vm-security",
    );
  });
});
