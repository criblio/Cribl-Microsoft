import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeJobStore } from "../../testing/fake-job-store";
import {
  PROVISION_LAB_JOB_KIND,
  manualLabRoleCommand,
  provisionLab,
  provisionLabStepsFor,
  type ProvisionLabInput,
} from "./provision-lab";
import {
  DEFAULT_LAB_EVENT_HUBS,
  DEFAULT_LAB_NAMING,
  DEFAULT_LAB_SUBNETS,
  allLabResourceNames,
  applyLabLocationSuffixes,
  collisionStorageAccountName,
  labDeploymentConfig,
  type LabComponentFlags,
} from "../../domain/labs";

const SUB = "11111111-2222-3333-4444-555555555555";
const RG = "rg-lab-SentinelLab";
const NOW = "2026-07-16T12:00:00.000Z";

const NAMES = allLabResourceNames({
  naming: applyLabLocationSuffixes(DEFAULT_LAB_NAMING, "eastus"),
  baseObjectName: "cribllab",
  subscriptionId: SUB,
  subnets: DEFAULT_LAB_SUBNETS,
  eventHubs: DEFAULT_LAB_EVENT_HUBS,
});

/**
 * A flags literal that deploys NOTHING beyond the foundation - the baseline
 * for foundation-behavior tests (every real profile now runs more phases).
 */
const FOUNDATION_ONLY_FLAGS: LabComponentFlags = {
  resourceGroupSuffix: "Test",
  infrastructure: { deployVNet: false, deployNSGs: false, deployVPN: false },
  storage: {
    deploy: false,
    deployContainers: false,
    deployQueues: false,
    deployEventGrid: false,
    deployPrivateEndpoints: false,
  },
  monitoring: {
    deployLogAnalytics: false,
    deploySentinel: false,
    deployFlowLogs: false,
    deployPrivateLink: false,
    deployDCRs: false,
  },
  analytics: { deployEventHub: false, deployADX: false, deployPrivateEndpoints: false },
  virtualMachines: { deployVMs: false },
};

/** Storage + networking only - the cross-phase isolation baseline. */
const STORAGE_AND_NETWORK_FLAGS: LabComponentFlags = {
  ...FOUNDATION_ONLY_FLAGS,
  infrastructure: { deployVNet: true, deployNSGs: true, deployVPN: false },
  storage: {
    deploy: true,
    deployContainers: false,
    deployQueues: false,
    deployEventGrid: false,
    deployPrivateEndpoints: false,
  },
};

function input(overrides?: Partial<ProvisionLabInput>): ProvisionLabInput {
  return {
    subscriptionId: SUB,
    resourceGroupName: RG,
    location: "eastus",
    baseObjectName: "cribllab",
    rgMode: "create-new",
    ttl: { hours: 72, warningHours: 24, userEmail: "user@example.com" },
    flags: FOUNDATION_ONLY_FLAGS,
    names: NAMES,
    nowIso: NOW,
    mintAssignmentName: () => "guid-1",
    retry: { maxAttempts: 3, delayMs: 1 },
    longPollAttempts: 3,
    ...overrides,
  };
}

const LOGIC_APP_OK = {
  status: 200,
  body: { identity: { principalId: "principal-1" } },
};

/** Foundation quick path: existing RG, existing watchdog, fresh role grant. */
const FOUNDATION_OK = [
  { status: 200, body: { tags: {} } }, // GET RG
  { status: 200, body: {} }, // PATCH tags
  LOGIC_APP_OK, // GET Logic App
  { status: 201, body: {} }, // PUT role assignment
];

/** A minimal native table schema response for the DCR phase. */
const TABLE_SCHEMA_OK = {
  status: 200,
  body: {
    properties: {
      schema: {
        standardColumns: [
          { name: "TimeGenerated", type: "datetime" },
          { name: "Computer", type: "string" },
        ],
      },
    },
  },
};

/** A deployed Direct DCR body (PUT response or reuse GET). */
const DCR_DEPLOYED = {
  status: 200,
  body: {
    properties: {
      provisioningState: "Succeeded",
      immutableId: "dcr-imm-1",
      endpoints: { logsIngestion: "https://x.ingest.monitor.azure.com" },
    },
  },
};

describe("provisionLabStepsFor", () => {
  it("includes only the phases the profile requires (legacy order)", () => {
    expect(provisionLabStepsFor(FOUNDATION_ONLY_FLAGS)).toEqual([
      "resource-group",
      "ttl-logic-app",
      "ttl-role-assignment",
    ]);
    expect(provisionLabStepsFor(labDeploymentConfig("SentinelLab", "public"))).toEqual([
      "resource-group",
      "ttl-logic-app",
      "ttl-role-assignment",
      "log-analytics",
      "microsoft-sentinel",
      "data-collection-rules",
      "cribl-configs",
    ]);
    expect(provisionLabStepsFor(labDeploymentConfig("EventHubLab", "public"))).toEqual([
      "resource-group",
      "ttl-logic-app",
      "ttl-role-assignment",
      "event-hub",
      "adx",
      "cribl-configs",
    ]);
    expect(
      provisionLabStepsFor(labDeploymentConfig("BasicInfrastructure", "public")),
    ).toEqual([
      "resource-group",
      "ttl-logic-app",
      "ttl-role-assignment",
      "network-security-groups",
      "virtual-network",
      "vpn-gateway",
      "vpn-connection",
    ]);
    expect(provisionLabStepsFor(labDeploymentConfig("FlowLogLab", "public"))).toEqual([
      "resource-group",
      "ttl-logic-app",
      "ttl-role-assignment",
      "storage-account",
      "blob-containers",
      "storage-queues",
      "event-grid",
      "network-security-groups",
      "virtual-network",
      "flow-logs",
      "virtual-machines",
      "cribl-configs",
    ]);
  });

  it("CompleteLab (private) runs every step including private-link", () => {
    const steps = provisionLabStepsFor(labDeploymentConfig("CompleteLab", "private"));
    expect(steps).toContain("private-link");
    expect(steps).toContain("vpn-gateway");
    expect(steps).toContain("data-collection-rules");
    expect(steps.indexOf("storage-account")).toBeLessThan(steps.indexOf("virtual-network"));
    expect(steps.indexOf("virtual-network")).toBeLessThan(steps.indexOf("log-analytics"));
    expect(steps.indexOf("cribl-configs")).toBeLessThan(steps.indexOf("vpn-gateway"));
  });
});

describe("provisionLab - foundation", () => {
  it("creates the RG with TTL tags, the watchdog, and the role grant", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: { identity: { principalId: "principal-1" } } },
      { status: 201, body: {} },
    );
    const jobs = new FakeJobStore();

    const result = await provisionLab({ azure, jobs }, input());

    expect(result.ok).toBe(true);
    expect(result.resourceGroupCreated).toBe(true);
    expect(result.ttlExpiresAt).toBe("2026-07-19T12:00:00Z");
    const tags = (azure.calls[1].body as { tags: Record<string, string> }).tags;
    expect(tags["TTL_Enabled"]).toBe("true");

    const records = await jobs.list(PROVISION_LAB_JOB_KIND);
    expect(records[0].status).toBe("succeeded");
    expect(records[0].steps.map((s) => s.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });

  it("merges existing tags on an existing group (TTL extended)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { tags: { Owner: "team-x", TTL_Hours: "24" } } },
      { status: 200, body: {} },
      LOGIC_APP_OK,
      { status: 201, body: {} },
    );
    const result = await provisionLab({ azure }, input());
    expect(result.ok).toBe(true);
    const tags = (azure.calls[1].body as { tags: Record<string, string> }).tags;
    expect(tags["Owner"]).toBe("team-x");
    expect(tags["TTL_Hours"]).toBe("72");
  });

  it("bring-your-own fails cleanly when the group does not exist", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 404, body: {} });
    const jobs = new FakeJobStore();
    const result = await provisionLab(
      { azure, jobs },
      input({ rgMode: "bring-your-own" }),
    );
    expect(result.ok).toBe(false);
    expect(azure.calls).toHaveLength(1);
    const record = (await jobs.list())[0];
    expect(record.steps[1].status).toBe("skipped");
    expect(record.steps[2].status).toBe("skipped");
  });

  it("surfaces the manual az command when the role grant is denied", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { tags: {} } },
      { status: 200, body: {} },
      LOGIC_APP_OK,
      { status: 403, body: { error: { code: "AuthorizationFailed" } } },
    );
    const result = await provisionLab({ azure }, input({ rgMode: "bring-your-own" }));
    expect(result.ok).toBe(false);
    expect(result.manualRoleAssignmentCommand).toBe(
      manualLabRoleCommand(SUB, RG, "principal-1"),
    );
  });

  it("treats 409 RoleAssignmentExists as success and retries PrincipalNotFound", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { tags: {} } },
      { status: 200, body: {} },
      LOGIC_APP_OK,
      { status: 400, body: { error: { code: "PrincipalNotFound" } } },
      { status: 409, body: { error: { code: "RoleAssignmentExists" } } },
    );
    const result = await provisionLab({ azure }, input());
    expect(result.ok).toBe(true);
    expect(result.roleAlreadyAssigned).toBe(true);
  });

  it("re-GETs the Logic App until the identity appears, failing honestly otherwise", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} }, // PUT - identity not populated
      { status: 200, body: {} }, // re-GET 1
      LOGIC_APP_OK, // re-GET 2
      { status: 201, body: {} },
    );
    const result = await provisionLab({ azure }, input());
    expect(result.ok).toBe(true);
    expect(result.principalId).toBe("principal-1");
  });

  it("a TTL grant failure skips every later phase (mandatory self-destruct)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { tags: {} } },
      { status: 200, body: {} },
      LOGIC_APP_OK,
      { status: 403, body: { error: { code: "AuthorizationFailed" } } },
    );
    const jobs = new FakeJobStore();
    const result = await provisionLab(
      { azure, jobs },
      input({ flags: labDeploymentConfig("BlobCollectorLab", "public") }),
    );
    expect(result.ok).toBe(false);
    expect(result.storage).toBeUndefined();
    const record = (await jobs.list())[0];
    const byName = new Map(record.steps.map((s) => [s.name, s]));
    expect(byName.get("storage-account")?.status).toBe("skipped");
    expect(byName.get("storage-account")?.detail).toContain("TTL self-destruct");
    expect(byName.get("cribl-configs")?.status).toBe("skipped");
  });
});

describe("provisionLab - storage phase", () => {
  it("BlobCollectorLab: creates the account, polls, deploys the collector container, and bundles the collector config", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 404, body: {} }, // GET storage account
      { status: 200, body: {} }, // PUT storage account
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
      { status: 404, body: {} }, // GET criblblobcollector
      { status: 201, body: {} }, // PUT container
    );
    const jobs = new FakeJobStore();
    const result = await provisionLab(
      { azure, jobs },
      input({ flags: labDeploymentConfig("BlobCollectorLab", "public") }),
    );
    expect(result.ok).toBe(true);
    expect(result.storage?.accountCreated).toBe(true);
    expect(result.storage?.containers).toEqual([
      { name: "criblblobcollector", created: true },
    ]);
    // Phase 9 runs pure: the polling collector config lands in the bundle.
    expect(result.criblConfigs?.blobSources).toHaveLength(1);
    expect(((result.criblConfigs?.blobSources ?? [])[0] as any).id).toBe(
      "azure_blob_collector_criblblobcollector",
    );

    const record = (await jobs.list())[0];
    const byName = new Map(record.steps.map((s) => [s.name, s]));
    expect(byName.get("storage-queues")?.status).toBe("skipped");
    expect(byName.get("event-grid")?.status).toBe("skipped");
    expect(byName.get("cribl-configs")?.status).toBe("succeeded");
    expect(byName.has("virtual-network")).toBe(false);
  });

  it("retries a globally-taken name with the shell-minted suffix", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 404, body: {} },
      { status: 409, body: { error: { code: "StorageAccountAlreadyTaken" } } },
      { status: 200, body: {} },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
      { status: 404, body: {} },
      { status: 201, body: {} },
    );
    const suffixed = collisionStorageAccountName("sacribllabcribl", "zz99");
    const result = await provisionLab(
      { azure },
      input({
        flags: labDeploymentConfig("BlobCollectorLab", "public"),
        mintStorageSuffix: () => "zz99",
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.storage?.accountName).toBe(suffixed);
    // The bundle uses the FINAL (suffixed) account name.
    expect(((result.criblConfigs?.blobSources ?? [])[0] as any).storageAccountName).toBe(suffixed);
  });

  it("BlobQueueLab: wires containers, queue, Event Grid, and the queue-source config", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 200, body: {} }, // GET storage account - exists
      { status: 404, body: {} }, // GET criblqueuesource
      { status: 201, body: {} }, // PUT container
      { status: 404, body: {} }, // GET queue
      { status: 201, body: {} }, // PUT queue
      { status: 200, body: { registrationState: "Registered" } }, // provider
      { status: 404, body: {} }, // GET topic
      { status: 201, body: {} }, // PUT topic
      { status: 404, body: {} }, // GET subscription
      { status: 201, body: {} }, // PUT subscription
    );
    const result = await provisionLab(
      { azure },
      input({ flags: labDeploymentConfig("BlobQueueLab", "public") }),
    );
    expect(result.ok).toBe(true);
    expect(result.storage?.eventGridTopic).toBe("sacribllabcribl-events");
    expect(((result.criblConfigs?.blobSources ?? [])[0] as any).id).toBe(
      "azure_blob_queue_criblqueuesource",
    );
  });

  it("a storage-account failure skips its sub-steps but networking still runs", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 500, body: { error: { code: "InternalServerError" } } }, // GET storage
      { status: 404, body: {} }, // NSG security
      { status: 201, body: {} },
      { status: 404, body: {} }, // NSG o11y
      { status: 201, body: {} },
      { status: 404, body: {} }, // NSG privatelink
      { status: 201, body: {} },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // VNet
    );
    const jobs = new FakeJobStore();
    const result = await provisionLab(
      { azure, jobs },
      input({ flags: STORAGE_AND_NETWORK_FLAGS }),
    );
    expect(result.ok).toBe(false);
    const record = (await jobs.list())[0];
    const byName = new Map(record.steps.map((s) => [s.name, s]));
    expect(byName.get("storage-account")?.status).toBe("failed");
    expect(byName.get("blob-containers")?.status).toBe("skipped");
    expect(byName.get("virtual-network")?.status).toBe("succeeded");
  });
});

describe("provisionLab - networking + gateway (BasicInfrastructure)", () => {
  it("creates NSGs, the VNet with associations, and the VPN gateway; the connection skips unconfigured", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 404, body: {} }, // NSG security
      { status: 201, body: {} },
      { status: 404, body: {} }, // NSG o11y
      { status: 201, body: {} },
      { status: 404, body: {} }, // NSG privatelink
      { status: 201, body: {} },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // VNet PUT
      { status: 404, body: {} }, // GET VPN gateway
      { status: 404, body: {} }, // GET public IP
      { status: 201, body: {} }, // PUT public IP
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // GW PUT
    );
    const jobs = new FakeJobStore();
    const result = await provisionLab(
      { azure, jobs },
      input({ flags: labDeploymentConfig("BasicInfrastructure", "public") }),
    );
    expect(result.ok).toBe(true);
    expect(result.networking?.nsgs).toHaveLength(3);
    expect(result.gateway?.gatewayReady).toBe(true);

    const vnetPut = azure.calls.find(
      (c) => c.method === "PUT" && c.path.includes("/virtualNetworks/"),
    );
    const subnets = ((vnetPut?.body ?? {}) as any).properties.subnets;
    expect(subnets[0].properties.networkSecurityGroup).toBeUndefined();
    expect(subnets[1].properties.networkSecurityGroup.id).toContain(
      "nsg-cribllab-SecuritySubnet-eastus",
    );
    // The PrivateLinkSubnet carries the endpoint-policy disable up front.
    expect(subnets[3].properties.privateEndpointNetworkPolicies).toBe("Disabled");

    const record = (await jobs.list())[0];
    const byName = new Map(record.steps.map((s) => [s.name, s]));
    expect(byName.get("vpn-connection")?.status).toBe("skipped");
    expect(byName.get("vpn-connection")?.detail).toContain("not configured");
  });

  it("deploys the site-to-site connection when the on-prem details are supplied", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // VNet
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // GET GW - exists
      { status: 404, body: {} }, // GET LNG
      { status: 201, body: {} }, // PUT LNG
      { status: 404, body: {} }, // GET connection
      { status: 201, body: {} }, // PUT connection
    );
    const result = await provisionLab(
      { azure },
      input({
        flags: labDeploymentConfig("BasicInfrastructure", "public"),
        onPrem: {
          gatewayIpAddress: "203.0.113.10",
          addressSpaces: ["10.198.32.0/24"],
          sharedKey: "psk-1",
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.gateway?.connectionName).toBe("conn-azure-to-onprem");
  });

  it("fails honestly when the gateway is still provisioning after the long-poll bound", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // VNet
      { status: 404, body: {} }, // GET GW
      { status: 200, body: {} }, // GET PIP - exists
      { status: 200, body: { properties: { provisioningState: "Updating" } } }, // GW PUT
      { status: 200, body: { properties: { provisioningState: "Updating" } } }, // poll 1
      { status: 200, body: { properties: { provisioningState: "Updating" } } }, // poll 2
    );
    const jobs = new FakeJobStore();
    const result = await provisionLab(
      { azure, jobs },
      input({
        flags: labDeploymentConfig("BasicInfrastructure", "public"),
        longPollAttempts: 2,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.gateway?.gatewayReady).toBe(false);
    const record = (await jobs.list())[0];
    const byName = new Map(record.steps.map((s) => [s.name, s]));
    expect(byName.get("vpn-gateway")?.detail).toContain("re-run the deploy later");
    expect(byName.get("vpn-connection")?.status).toBe("skipped");
  });
});

describe("provisionLab - monitoring + DCRs (SentinelLab)", () => {
  it("workspace + Sentinel + a Direct DCR + the bundle's DCR reference, end-to-end", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 404, body: {} }, // GET workspace
      {
        status: 200,
        body: { location: "eastus", properties: { provisioningState: "Succeeded" } },
      }, // createWorkspace PUT
      { status: 200, body: { location: "eastus", id: "/ws-id" } }, // enableSentinel GET ws
      { status: 404, body: {} }, // solution pre-check
      { status: 200, body: {} }, // solution PUT
      TABLE_SCHEMA_OK, // GET tables/SecurityEvent
      { status: 404, body: {} }, // GET DCR
      DCR_DEPLOYED, // PUT DCR
    );
    const jobs = new FakeJobStore();
    const result = await provisionLab(
      { azure, jobs },
      input({
        flags: labDeploymentConfig("SentinelLab", "public"),
        dcrTables: ["SecurityEvent"],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.monitoring?.workspaceCreated).toBe(true);
    expect(result.monitoring?.sentinelEnabled).toBe(true);
    expect(result.dcrs).toHaveLength(1);
    expect(result.dcrs?.[0]).toMatchObject({
      table: "SecurityEvent",
      dcrName: "dcr-SecurityEvent-eastus",
      immutableId: "dcr-imm-1",
      logsIngestionEndpoint: "https://x.ingest.monitor.azure.com",
      reused: false,
    });
    expect(result.criblConfigs?.sentinelDcrs).toHaveLength(1);

    const record = (await jobs.list())[0];
    expect(record.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
      "resource-group:succeeded",
      "ttl-logic-app:succeeded",
      "ttl-role-assignment:succeeded",
      "log-analytics:succeeded",
      "microsoft-sentinel:succeeded",
      "data-collection-rules:succeeded",
      "cribl-configs:succeeded",
    ]);
  });

  it("reuses an existing DCR that already targets the table (no PUT)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 200, body: { location: "eastus" } }, // GET workspace - exists
      { status: 200, body: { location: "eastus", id: "/ws-id" } }, // enableSentinel GET
      { status: 200, body: {} }, // pre-check - already enabled
      TABLE_SCHEMA_OK,
      DCR_DEPLOYED, // GET DCR - exists (reuse)
    );
    const result = await provisionLab(
      { azure },
      input({
        flags: labDeploymentConfig("SentinelLab", "public"),
        dcrTables: ["SecurityEvent"],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.dcrs?.[0].reused).toBe(true);
    expect(result.dcrs?.[0].immutableId).toBe("dcr-imm-1");
  });

  it("a workspace failure skips Sentinel, private-link, and the DCR phase", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      // SentinelLab PRIVATE deploys networking before monitoring.
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
      { status: 500, body: { error: { code: "InternalServerError" } } }, // GET workspace
      // Private mode also runs phase 10: the gateway already exists.
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
    );
    const jobs = new FakeJobStore();
    const result = await provisionLab(
      { azure, jobs },
      input({ flags: labDeploymentConfig("SentinelLab", "private") }),
    );
    expect(result.ok).toBe(false);
    const record = (await jobs.list())[0];
    const byName = new Map(record.steps.map((s) => [s.name, s]));
    expect(byName.get("log-analytics")?.status).toBe("failed");
    expect(byName.get("microsoft-sentinel")?.status).toBe("skipped");
    expect(byName.get("private-link")?.status).toBe("skipped");
    expect(byName.get("data-collection-rules")?.status).toBe("skipped");
    expect(byName.get("data-collection-rules")?.detail).toBe("prerequisite-failed");
  });

  it("deploys the full AMPLS chain in private mode", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 404, body: {} }, // NSG security
      { status: 201, body: {} },
      { status: 404, body: {} }, // NSG o11y
      { status: 201, body: {} },
      { status: 404, body: {} }, // NSG privatelink
      { status: 201, body: {} },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // VNet
      { status: 200, body: { location: "eastus" } }, // GET workspace - exists
      { status: 200, body: { location: "eastus", id: "/ws-id" } }, // enableSentinel GET
      { status: 200, body: {} }, // pre-check - enabled
      { status: 404, body: {} }, // GET AMPLS
      { status: 201, body: {} }, // PUT AMPLS
      { status: 404, body: {} }, // GET scoped resource
      { status: 201, body: {} }, // PUT scoped resource
      { status: 404, body: {} }, // GET private endpoint
      { status: 201, body: {} }, // PUT private endpoint
      { status: 404, body: {} }, // GET DNS zone
      { status: 201, body: {} }, // PUT DNS zone
      { status: 404, body: {} }, // GET VNet link
      { status: 201, body: {} }, // PUT VNet link
      TABLE_SCHEMA_OK,
      DCR_DEPLOYED, // GET DCR - reuse
      // Private mode also runs phase 10: the gateway already exists.
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
    );
    const result = await provisionLab(
      { azure },
      input({
        flags: labDeploymentConfig("SentinelLab", "private"),
        dcrTables: ["SecurityEvent"],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.privateLink).toEqual({
      amplsName: "ampls-cribllab-eastus",
      privateEndpointName: "pe-ampls-cribllab",
      dnsZoneLinked: true,
    });
  });
});

describe("provisionLab - analytics phase", () => {
  it("EventHubLab: namespace, hubs, consumer groups, and the bundle's sources", async () => {
    const azure = new FakeAzureManagement();
    const hubResponses = DEFAULT_LAB_EVENT_HUBS.flatMap(() => [
      { status: 404, body: {} }, // GET hub
      { status: 201, body: {} }, // PUT hub
      { status: 404, body: {} }, // GET consumer group
      { status: 201, body: {} }, // PUT consumer group
    ]);
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 404, body: {} }, // GET namespace
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // PUT ns
      ...hubResponses,
    );
    const jobs = new FakeJobStore();
    const result = await provisionLab(
      { azure, jobs },
      input({ flags: labDeploymentConfig("EventHubLab", "public") }),
    );
    expect(result.ok).toBe(true);
    expect(result.analytics?.namespaceCreated).toBe(true);
    expect(result.analytics?.hubs?.map((h) => h.name)).toEqual([
      "logs-hub",
      "metrics-hub",
      "events-hub",
    ]);
    expect(result.criblConfigs?.eventHubSources).toHaveLength(3);
    const record = (await jobs.list())[0];
    const byName = new Map(record.steps.map((s) => [s.name, s]));
    expect(byName.get("adx")?.status).toBe("skipped");
    expect(byName.get("adx")?.detail).toBe("not requested by profile");
  });

  it("ADXLab: cluster (long poll) + database + table script + the ADX destination", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 404, body: {} }, // GET cluster
      { status: 200, body: { properties: { provisioningState: "Creating" } } }, // PUT
      {
        status: 200,
        body: {
          properties: {
            provisioningState: "Succeeded",
            uri: "https://adx.eastus.kusto.windows.net",
          },
        },
      }, // poll GET
      { status: 404, body: {} }, // GET database
      { status: 201, body: {} }, // PUT database
      { status: 404, body: {} }, // GET script
      { status: 201, body: {} }, // PUT script
    );
    const result = await provisionLab(
      { azure },
      input({ flags: labDeploymentConfig("ADXLab", "public") }),
    );
    expect(result.ok).toBe(true);
    expect(result.analytics?.adxClusterCreated).toBe(true);
    expect(result.analytics?.adxClusterUri).toBe("https://adx.eastus.kusto.windows.net");
    expect(result.analytics?.adxDatabase).toBe("CriblLogs");
    expect(result.criblConfigs?.adxDestinations).toHaveLength(1);
    expect(((result.criblConfigs?.adxDestinations ?? [])[0] as any).conf.cluster).toBe(
      "https://adx.eastus.kusto.windows.net",
    );
  });
});

describe("provisionLab - flow logs + VMs (FlowLogLab)", () => {
  it("resolves the watcher, deploys dual-level flow logs, and the VMs with schedules", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      // Storage phase (FlowLogLab: account only; containers not requested).
      { status: 200, body: {} }, // GET storage account - exists
      // Networking.
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // VNet
      // Flow logs: lab watcher missing, Azure default exists.
      { status: 404, body: {} }, // GET lab watcher
      { status: 200, body: {} }, // GET NetworkWatcherRG default
      { status: 404, body: {} }, // GET vnet-level flow log
      { status: 201, body: {} }, // PUT vnet-level
      { status: 404, body: {} }, // GET gateway subnet flow log
      { status: 201, body: {} }, // PUT
      { status: 404, body: {} }, // GET security
      { status: 201, body: {} }, // PUT
      { status: 404, body: {} }, // GET o11y
      { status: 201, body: {} }, // PUT
      { status: 404, body: {} }, // GET privatelink
      { status: 201, body: {} }, // PUT
      // VMs: security VM.
      { status: 404, body: {} }, // GET VM
      { status: 404, body: {} }, // GET NIC
      { status: 201, body: {} }, // PUT NIC
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // PUT VM
      { status: 404, body: {} }, // GET schedule
      { status: 200, body: {} }, // PUT schedule
      // o11y VM.
      { status: 404, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
      { status: 404, body: {} },
      { status: 200, body: {} },
    );
    const jobs = new FakeJobStore();
    const result = await provisionLab(
      { azure, jobs },
      input({
        flags: labDeploymentConfig("FlowLogLab", "public"),
        vmAdminPassword: "transient-1!",
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.flowLogs?.networkWatcher).toBe("NetworkWatcherRG/NetworkWatcher_eastus");
    expect(result.flowLogs?.flowLogs).toHaveLength(5); // vnet + 4 subnets
    expect(result.compute?.vms.map((v) => v.name)).toEqual([
      "cribllab-vm-security",
      "cribllab-vm-o11y",
    ]);
    // The flow-log collector config lands in the bundle.
    expect(((result.criblConfigs?.blobSources ?? [])[0] as any).id).toBe(
      "Azure_vNet_FlowLogs_sacribllabcribl",
    );
  });

  it("fails the VM step honestly when no password is supplied", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 200, body: {} }, // storage exists
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } },
      { status: 404, body: {} }, // lab watcher
      { status: 200, body: {} }, // default watcher
      { status: 200, body: {} }, // vnet-level flow log exists
      { status: 200, body: {} }, // gateway exists
      { status: 200, body: {} }, // security exists
      { status: 200, body: {} }, // o11y exists
      { status: 200, body: {} }, // privatelink exists
    );
    const jobs = new FakeJobStore();
    const result = await provisionLab(
      { azure, jobs },
      input({ flags: labDeploymentConfig("FlowLogLab", "public") }),
    );
    expect(result.ok).toBe(false);
    const record = (await jobs.list())[0];
    const byName = new Map(record.steps.map((s) => [s.name, s]));
    expect(byName.get("flow-logs")?.status).toBe("succeeded");
    expect(byName.get("virtual-machines")?.status).toBe("failed");
    expect(byName.get("virtual-machines")?.detail).toContain("password");
  });
});

describe("provisionLab - progress reporting", () => {
  it("fires onProgress for every step transition (foundation-only flags)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { tags: {} } },
      { status: 200, body: {} },
      LOGIC_APP_OK,
      { status: 201, body: {} },
    );
    const seen: string[] = [];
    await provisionLab(
      { azure },
      input({
        onProgress: (step) => {
          seen.push(`${step.name}:${step.status}`);
        },
      }),
    );
    expect(seen).toEqual([
      "resource-group:running",
      "resource-group:succeeded",
      "ttl-logic-app:running",
      "ttl-logic-app:succeeded",
      "ttl-role-assignment:running",
      "ttl-role-assignment:succeeded",
    ]);
  });
});
