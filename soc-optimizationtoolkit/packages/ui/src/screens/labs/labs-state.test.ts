import { describe, expect, it } from "vitest";
import {
  canDeployFoundation,
  criblBundleArtifact,
  defaultLabFormState,
  flowLogPackResultLines,
  formatLabInventoryRow,
  formatLabPhaseLine,
  initialLabSteps,
  labPlanArtifact,
  labPlanFromForm,
  labResourceNameRows,
  labRunResultLines,
  onPremFromForm,
  permissionCheckLines,
  ttlExpiryPreview,
  vmPasswordMissing,
} from "./labs-state";
import { labDeploymentConfig } from "@soc/core";
import type { ProvisionLabResult } from "@soc/core";

const SUB = "11111111-2222-3333-4444-555555555555";
const NOW = "2026-07-16T12:00:00.000Z";

function validForm() {
  return {
    ...defaultLabFormState(),
    baseObjectName: "cribllab",
    ttlEmail: "user@example.com",
  };
}

describe("defaultLabFormState", () => {
  it("defaults to SentinelLab, public, create-new, legacy TTL values", () => {
    const form = defaultLabFormState();
    expect(form.labType).toBe("SentinelLab");
    expect(form.labMode).toBe("public");
    expect(form.rgMode).toBe("create-new");
    expect(form.ttlHours).toBe("72");
    expect(form.ttlWarningHours).toBe("24");
  });
});

describe("labPlanFromForm", () => {
  it("produces a valid plan from a complete form", () => {
    const plan = labPlanFromForm(validForm(), SUB);
    expect(plan.errors).toEqual([]);
    expect(plan.resourceGroupName).toBe("rg-lab-SentinelLab");
  });

  it("rejects junk TTL input through the core validators (never coerces to 0)", () => {
    const plan = labPlanFromForm({ ...validForm(), ttlHours: "abc" }, SUB);
    expect(plan.errors.some((e) => e.includes("TTL hours"))).toBe(true);
  });

  it("flags a missing subscription (no Azure target committed)", () => {
    const plan = labPlanFromForm(validForm(), "");
    expect(plan.errors.some((e) => e.includes("subscriptionId"))).toBe(true);
  });
});

describe("canDeployFoundation", () => {
  it("gates on validation errors, then on the shell minter, then the VM password", () => {
    const good = labPlanFromForm(validForm(), SUB);
    expect(canDeployFoundation(good, true).ok).toBe(true);
    expect(canDeployFoundation(good, false).ok).toBe(false);
    expect(canDeployFoundation(good, false).reason).toContain("mintAssignmentName");
    expect(canDeployFoundation(good, true, true).ok).toBe(false);
    expect(canDeployFoundation(good, true, true).reason).toContain("password");

    const bad = labPlanFromForm({ ...validForm(), baseObjectName: "" }, SUB);
    expect(canDeployFoundation(bad, true).ok).toBe(false);
  });
});

describe("vmPasswordMissing", () => {
  it("requires the password only for profiles that deploy VMs", () => {
    const sentinel = labPlanFromForm(validForm(), SUB);
    expect(vmPasswordMissing(sentinel, validForm())).toBe(false);

    const flowlog = { ...validForm(), labType: "FlowLogLab" as const };
    const plan = labPlanFromForm(flowlog, SUB);
    expect(vmPasswordMissing(plan, flowlog)).toBe(true);
    expect(vmPasswordMissing(plan, { ...flowlog, vmPassword: "pw-1!" })).toBe(false);
  });
});

describe("onPremFromForm", () => {
  it("returns undefined for an all-blank form, else the parsed connection", () => {
    expect(onPremFromForm(validForm())).toBeUndefined();
    const filled = onPremFromForm({
      ...validForm(),
      onPremGatewayIp: "203.0.113.10",
      onPremAddressSpace: "10.0.0.0/24, 10.1.0.0/24",
      onPremSharedKey: "psk",
    });
    expect(filled).toEqual({
      gatewayIpAddress: "203.0.113.10",
      addressSpaces: ["10.0.0.0/24", "10.1.0.0/24"],
      sharedKey: "psk",
    });
  });
});

describe("permissionCheckLines", () => {
  it("renders per-action rows and the ABAC verdict with remediation", () => {
    const lines = permissionCheckLines({
      scope: `/subscriptions/${SUB}`,
      checks: [
        {
          action: "Microsoft.Logic/workflows/write",
          label: "Deploy the TTL self-destruct watchdog",
          granted: true,
        },
        {
          action: "Microsoft.Authorization/roleAssignments/write",
          label: "Grant the TTL identity its delete role",
          granted: false,
        },
      ],
      roleAssignmentGrant: {
        kind: "conditional-blocks-contributor",
        conditions: ["(...GuidEquals {3913510d-...})"],
      },
      roleConditionRemediation: "Ask an admin to edit the condition.",
      notes: ["a note"],
    });
    expect(lines[0]).toContain("evaluated at /subscriptions/");
    expect(lines[1]).toContain("[OK] Deploy the TTL self-destruct watchdog");
    expect(lines[2]).toContain("[MISSING] Grant the TTL identity its delete role");
    expect(lines.some((l) => l.includes("WILL fail at ttl-role-assignment"))).toBe(true);
    expect(lines.some((l) => l === "Ask an admin to edit the condition.")).toBe(true);
    expect(lines.some((l) => l === "Note: a note")).toBe(true);
  });

  it("reports the clean unconditional case", () => {
    const lines = permissionCheckLines({
      scope: `/subscriptions/${SUB}`,
      checks: [],
      roleAssignmentGrant: { kind: "unconditional", conditions: [] },
      notes: [],
    });
    expect(lines.some((l) => l.includes("without a condition"))).toBe(true);
  });
});

describe("formatLabInventoryRow", () => {
  const base = {
    name: "rg-lab-FlowLogLab",
    location: "eastus",
    managedBy: "SOC-OptimizationToolkit",
    ttlEnabled: true,
    expiresAt: "2026-07-19T12:00:00Z",
    userEmail: "user@example.com",
    remainingHours: 48,
    expired: false,
  };

  it("shows relative expiry and the warning recipient", () => {
    expect(formatLabInventoryRow(base)).toBe(
      "rg-lab-FlowLogLab (eastus) - expires in 48h (2026-07-19T12:00:00Z) - warns user@example.com",
    );
  });

  it("flags expired labs loudly", () => {
    expect(
      formatLabInventoryRow({ ...base, remainingHours: -2.4, expired: true }),
    ).toContain("EXPIRED 2h ago");
  });

  it("is honest about missing TTLs", () => {
    expect(
      formatLabInventoryRow({
        ...base,
        ttlEnabled: false,
        remainingHours: null,
        expiresAt: "",
        userEmail: "",
      }),
    ).toContain("NO TTL");
  });
});

describe("flowLogPackResultLines", () => {
  it("summarizes install, secret, and deploy honestly", () => {
    const lines = flowLogPackResultLines("AzureFlowLogs_0.0.3.crbl", "default", {
      secret: "created",
      commitVersion: "abc123",
      deployed: true,
    });
    expect(lines[0]).toContain("AzureFlowLogs_0.0.3.crbl");
    expect(lines[0]).toContain("'default'");
    expect(lines.some((l) => l.includes("secret Azure_vNet_Flowlogs_Secret created"))).toBe(true);
    expect(lines.some((l) => l.includes("deployed (abc123)"))).toBe(true);
  });

  it("carries the nonfatal commit error and the skipped-secret warning", () => {
    const lines = flowLogPackResultLines("AzureFlowLogs_0.0.3.crbl", "default", {
      secret: "skipped",
      commitVersion: null,
      deployed: false,
      commitError: "commit: HTTP 400",
    });
    expect(lines.some((l) => l.includes("ensure the Azure_vNet_Flowlogs_Secret"))).toBe(true);
    expect(lines.some((l) => l.includes("commit: HTTP 400"))).toBe(true);
  });
});

describe("criblBundleArtifact", () => {
  it("names the bundle after the profile and serializes it", () => {
    const artifact = criblBundleArtifact(
      {
        adxDestinations: [],
        eventHubSources: [],
        blobSources: [],
        sentinelDcrs: [],
        requiredSecrets: [],
      },
      "FlowLogLab",
      "public",
    );
    expect(artifact.filename).toBe("lab-cribl-configs-FlowLogLab-public.json");
    expect(JSON.parse(artifact.json).requiredSecrets).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats a phase line with its steps", () => {
    const plan = labPlanFromForm(validForm(), SUB);
    expect(formatLabPhaseLine(plan.phases[0])).toBe(
      "Phase 1 - Foundation: Resource group, TTL self-destruct",
    );
  });

  it("previews the TTL expiry from an injected instant", () => {
    expect(ttlExpiryPreview(validForm(), NOW)).toBe(
      "self-destructs 2026-07-19T12:00:00Z (warning 2026-07-18T12:00:00Z)",
    );
    expect(ttlExpiryPreview({ ...validForm(), ttlHours: "junk" }, NOW)).toBe("");
  });
});

describe("labResourceNameRows", () => {
  it("lists only what the profile deploys", () => {
    const sentinel = labPlanFromForm(validForm(), SUB);
    const sentinelRows = labResourceNameRows(sentinel.names, sentinel.flags);
    expect(sentinelRows.map((r) => r.label)).toEqual(["Log Analytics workspace"]);

    const complete = labPlanFromForm({ ...validForm(), labType: "CompleteLab" }, SUB);
    const completeRows = labResourceNameRows(complete.names, complete.flags);
    const labels = completeRows.map((r) => r.label);
    expect(labels).toContain("Virtual network");
    expect(labels).toContain("VPN gateway");
    expect(labels).toContain("Storage account");
    expect(labels).toContain("ADX cluster");
    expect(labels.filter((l) => l === "Event Hub")).toHaveLength(3);
  });
});

describe("labPlanArtifact", () => {
  it("is deterministic and named after the profile + mode", () => {
    const plan = labPlanFromForm(validForm(), SUB);
    const first = labPlanArtifact(plan);
    const second = labPlanArtifact(plan);
    expect(first.filename).toBe("lab-plan-SentinelLab-public.json");
    expect(first.json).toBe(second.json);
    expect(JSON.parse(first.json).resourceGroupName).toBe("rg-lab-SentinelLab");
  });
});

describe("initialLabSteps", () => {
  it("pre-seeds pending steps for exactly the profile's phases", () => {
    const sentinel = initialLabSteps(labDeploymentConfig("SentinelLab", "public"));
    expect(sentinel.map((s) => s.name)).toEqual([
      "resource-group",
      "ttl-logic-app",
      "ttl-role-assignment",
      "log-analytics",
      "microsoft-sentinel",
      "data-collection-rules",
      "cribl-configs",
    ]);
    expect(sentinel.every((s) => s.status === "pending")).toBe(true);

    const flowlog = initialLabSteps(labDeploymentConfig("FlowLogLab", "public"));
    expect(flowlog.map((s) => s.name)).toContain("storage-account");
    expect(flowlog.map((s) => s.name)).toContain("virtual-network");
  });
});

describe("labRunResultLines", () => {
  const base: ProvisionLabResult = {
    resourceGroupId: `/subscriptions/${SUB}/resourceGroups/rg-lab-SentinelLab`,
    resourceGroupCreated: true,
    ttlExpiresAt: "2026-07-19T12:00:00Z",
    logicAppName: "la-ttl-cleanup-cribllab",
    logicAppCreated: true,
    principalId: "principal-1",
    roleAssigned: true,
    roleAlreadyAssigned: false,
    ok: true,
  };

  it("summarizes a clean create honestly", () => {
    const lines = labRunResultLines(base);
    expect(lines[0]).toContain("Resource group created");
    expect(lines.some((l) => l.includes("self-destruct expires"))).toBe(true);
    expect(lines.some((l) => l.includes("can now self-delete"))).toBe(true);
  });

  it("surfaces the manual grant command when the role step failed", () => {
    const lines = labRunResultLines({
      ...base,
      roleAssigned: false,
      manualRoleAssignmentCommand: "az role assignment create --assignee-object-id principal-1",
      ok: false,
    });
    expect(lines.some((l) => l.includes("will not self-destruct"))).toBe(true);
    expect(lines.some((l) => l.startsWith("az role assignment create"))).toBe(true);
  });

  it("says TTL extended for a reused group", () => {
    const lines = labRunResultLines({ ...base, resourceGroupCreated: false });
    expect(lines[0]).toContain("TTL extended");
  });

  it("summarizes storage and networking outcomes when those phases ran", () => {
    const lines = labRunResultLines({
      ...base,
      storage: {
        accountName: "sacribllabcribl",
        accountCreated: true,
        containers: [{ name: "criblqueuesource", created: true }],
        queues: [{ name: "blob-notifications", created: false }],
        eventGridTopic: "sacribllabcribl-events",
        eventGridSubscriptions: ["blobCreated"],
      },
      networking: {
        vnetName: "vnet-cribllab-eastus",
        nsgs: [{ name: "nsg-cribllab-SecuritySubnet-eastus", created: true }],
      },
    });
    expect(lines.some((l) => l === "Storage account created: sacribllabcribl")).toBe(true);
    expect(lines.some((l) => l === "Container created: criblqueuesource")).toBe(true);
    expect(lines.some((l) => l === "Queue already existed: blob-notifications")).toBe(true);
    expect(
      lines.some((l) => l.includes("sacribllabcribl-events") && l.includes("blobCreated")),
    ).toBe(true);
    expect(lines.some((l) => l === "Virtual network deployed: vnet-cribllab-eastus")).toBe(true);
  });

  it("summarizes the later-phase outcomes when they ran", () => {
    const lines = labRunResultLines({
      ...base,
      privateLink: {
        amplsName: "ampls-cribllab-eastus",
        privateEndpointName: "pe-ampls-cribllab",
        dnsZoneLinked: true,
      },
      analytics: {
        namespaceName: "evhns-cribllab-eastus",
        namespaceCreated: true,
        hubs: [{ name: "logs-hub", created: true }],
        adxClusterName: "adx1",
        adxClusterCreated: true,
        adxClusterUri: "https://adx",
        adxDatabase: "CriblLogs",
      },
      flowLogs: {
        networkWatcher: "NetworkWatcherRG/NetworkWatcher_eastus",
        flowLogs: [{ name: "FlowLog-vnet", created: true }],
      },
      compute: {
        vms: [{ name: "cribllab-vm-security", created: true }],
        autoShutdownConfigured: true,
      },
      dcrs: [
        {
          table: "SecurityEvent",
          dcrName: "dcr-SecurityEvent-eastus",
          immutableId: "imm-1",
          logsIngestionEndpoint: "https://e",
          stream: "Custom-SecurityEvent",
          reused: false,
        },
      ],
      gateway: {
        publicIpName: "pip-cribllab-vpn-eastus",
        gatewayName: "vpngw-cribllab-eastus",
        gatewayReady: true,
        provisioningState: "Succeeded",
        connectionName: "conn-azure-to-onprem",
      },
      criblConfigs: {
        adxDestinations: [{}],
        eventHubSources: [{}],
        blobSources: [],
        sentinelDcrs: [],
        requiredSecrets: [{ name: "Azure_Client_Secret", purpose: "x" }],
      },
    });
    expect(lines.some((l) => l.includes("ampls-cribllab-eastus"))).toBe(true);
    expect(lines.some((l) => l.includes("Event Hub namespace created"))).toBe(true);
    expect(lines.some((l) => l.includes("ADX cluster created"))).toBe(true);
    expect(lines.some((l) => l.includes("1 flow log(s)"))).toBe(true);
    expect(lines.some((l) => l.includes("Test VM created: cribllab-vm-security"))).toBe(true);
    expect(lines.some((l) => l.includes("DCR dcr-SecurityEvent-eastus"))).toBe(true);
    expect(lines.some((l) => l.includes("VPN gateway vpngw-cribllab-eastus: ready"))).toBe(true);
    expect(lines.some((l) => l.includes("Site-to-site connection deployed"))).toBe(true);
    expect(lines.some((l) => l.includes("Cribl configs generated"))).toBe(true);
  });

  it("summarizes the monitoring outcome when the phase ran", () => {
    const lines = labRunResultLines({
      ...base,
      monitoring: {
        workspaceName: "law-cribllab-eastus",
        workspaceCreated: true,
        sentinelEnabled: true,
        sentinelAlreadyEnabled: false,
      },
    });
    expect(
      lines.some((l) => l === "Log Analytics workspace created: law-cribllab-eastus"),
    ).toBe(true);
    expect(
      lines.some((l) => l === "Microsoft Sentinel enabled on the workspace."),
    ).toBe(true);
  });
});
