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

function input(overrides?: Partial<ProvisionLabInput>): ProvisionLabInput {
  return {
    subscriptionId: SUB,
    resourceGroupName: RG,
    location: "eastus",
    baseObjectName: "cribllab",
    rgMode: "create-new",
    ttl: { hours: 72, warningHours: 24, userEmail: "user@example.com" },
    flags: labDeploymentConfig("SentinelLab", "public"),
    names: NAMES,
    nowIso: NOW,
    mintAssignmentName: () => "guid-1",
    retry: { maxAttempts: 3, delayMs: 1 },
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

describe("provisionLabStepsFor", () => {
  it("includes only the phases the profile requires", () => {
    expect(provisionLabStepsFor(labDeploymentConfig("SentinelLab", "public"))).toEqual([
      "resource-group",
      "ttl-logic-app",
      "ttl-role-assignment",
    ]);
    expect(
      provisionLabStepsFor(labDeploymentConfig("BlobQueueLab", "public")),
    ).toEqual([
      "resource-group",
      "ttl-logic-app",
      "ttl-role-assignment",
      "storage-account",
      "blob-containers",
      "storage-queues",
      "event-grid",
    ]);
    expect(
      provisionLabStepsFor(labDeploymentConfig("BasicInfrastructure", "public")),
    ).toEqual([
      "resource-group",
      "ttl-logic-app",
      "ttl-role-assignment",
      "network-security-groups",
      "virtual-network",
    ]);
  });
});

describe("provisionLab - foundation, create-new happy path", () => {
  it("creates the RG with TTL tags, the watchdog, and the role grant", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 404, body: {} }, // GET RG - missing
      { status: 201, body: {} }, // PUT RG
      { status: 404, body: {} }, // GET Logic App - missing
      { status: 201, body: { identity: { principalId: "principal-1" } } }, // PUT Logic App
      { status: 201, body: {} }, // PUT role assignment
    );
    const jobs = new FakeJobStore();

    const result = await provisionLab({ azure, jobs }, input());

    expect(result.ok).toBe(true);
    expect(result.resourceGroupCreated).toBe(true);
    expect(result.logicAppCreated).toBe(true);
    expect(result.principalId).toBe("principal-1");
    expect(result.roleAssigned).toBe(true);
    expect(result.ttlExpiresAt).toBe("2026-07-19T12:00:00Z");

    const rgPut = azure.calls[1];
    expect(rgPut.method).toBe("PUT");
    const tags = (rgPut.body as { tags: Record<string, string> }).tags;
    expect(tags["TTL_Enabled"]).toBe("true");
    expect(tags["TTL_ExpirationTime"]).toBe("2026-07-19T12:00:00Z");

    const records = await jobs.list(PROVISION_LAB_JOB_KIND);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("succeeded");
    expect(records[0].steps.map((s) => s.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });
});

describe("provisionLab - existing resource group", () => {
  it("merges existing tags with the TTL tags and PATCHes (TTL extended)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { tags: { Owner: "team-x", TTL_Hours: "24" } } },
      { status: 200, body: {} },
      LOGIC_APP_OK,
      { status: 201, body: {} },
    );

    const result = await provisionLab({ azure }, input());

    expect(result.ok).toBe(true);
    expect(result.resourceGroupCreated).toBe(false);
    const patch = azure.calls[1];
    expect(patch.method).toBe("PATCH");
    const tags = (patch.body as { tags: Record<string, string> }).tags;
    expect(tags["Owner"]).toBe("team-x");
    expect(tags["TTL_Hours"]).toBe("72");
  });
});

describe("provisionLab - bring-your-own resource group", () => {
  it("fails cleanly when the group does not exist (never silently creates)", async () => {
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
    expect(record.status).toBe("failed");
    expect(record.steps[0].status).toBe("failed");
    expect(record.steps[1].status).toBe("skipped");
    expect(record.steps[2].status).toBe("skipped");
  });

  it("surfaces the manual az command when the role grant is denied (403)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { tags: {} } },
      { status: 200, body: {} },
      LOGIC_APP_OK,
      {
        status: 403,
        body: { error: { code: "AuthorizationFailed", message: "denied" } },
      },
    );

    const result = await provisionLab(
      { azure },
      input({ rgMode: "bring-your-own" }),
    );

    expect(result.ok).toBe(false);
    expect(result.manualRoleAssignmentCommand).toBe(
      manualLabRoleCommand(SUB, RG, "principal-1"),
    );
  });
});

describe("provisionLab - role assignment semantics", () => {
  it("treats 409 RoleAssignmentExists as success (idempotent re-run)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { tags: {} } },
      { status: 200, body: {} },
      LOGIC_APP_OK,
      {
        status: 409,
        body: { error: { code: "RoleAssignmentExists", message: "exists" } },
      },
    );

    const result = await provisionLab({ azure }, input());
    expect(result.ok).toBe(true);
    expect(result.roleAlreadyAssigned).toBe(true);
  });

  it("retries PrincipalNotFound within the attempt budget", async () => {
    const azure = new FakeAzureManagement();
    const sleeps: number[] = [];
    azure.respondWith(
      { status: 200, body: { tags: {} } },
      { status: 200, body: {} },
      LOGIC_APP_OK,
      { status: 400, body: { error: { code: "PrincipalNotFound", message: "lag" } } },
      { status: 201, body: {} },
    );

    const result = await provisionLab(
      { azure },
      input({
        retry: {
          maxAttempts: 3,
          delayMs: 10,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([10]);
  });
});

describe("provisionLab - identity readback", () => {
  it("re-GETs the Logic App until the identity principal appears", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} }, // PUT Logic App - identity not yet populated
      { status: 200, body: {} }, // re-GET 1 - still empty
      LOGIC_APP_OK, // re-GET 2 - identity present
      { status: 201, body: {} },
    );

    const result = await provisionLab({ azure }, input());
    expect(result.ok).toBe(true);
    expect(result.principalId).toBe("principal-1");
  });

  it("fails honestly when the identity never appears", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 200, body: {} },
      { status: 200, body: {} },
    );

    const result = await provisionLab({ azure }, input());
    expect(result.ok).toBe(false);
    expect(result.principalId).toBe("");
  });
});

describe("provisionLab - storage phase (BlobCollectorLab)", () => {
  it("creates the account, polls provisioning, and deploys only the collector container", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 404, body: {} }, // GET storage account - missing
      { status: 200, body: {} }, // PUT storage account
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // poll GET
      { status: 404, body: {} }, // GET criblblobcollector container
      { status: 201, body: {} }, // PUT container
    );
    const jobs = new FakeJobStore();

    const result = await provisionLab(
      { azure, jobs },
      input({ flags: labDeploymentConfig("BlobCollectorLab", "public") }),
    );

    expect(result.ok).toBe(true);
    expect(result.storage?.accountName).toBe("sacribllabcribl");
    expect(result.storage?.accountCreated).toBe(true);
    expect(result.storage?.containers).toEqual([
      { name: "criblblobcollector", created: true },
    ]);

    const record = (await jobs.list())[0];
    const byName = new Map(record.steps.map((s) => [s.name, s]));
    expect(byName.get("storage-queues")?.status).toBe("skipped");
    expect(byName.get("storage-queues")?.detail).toBe("not requested by profile");
    expect(byName.get("event-grid")?.status).toBe("skipped");
    // No networking steps at all - the profile has no VNet.
    expect(byName.has("virtual-network")).toBe(false);
  });

  it("retries a globally-taken name with the shell-minted suffix", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 404, body: {} }, // GET storage account
      { status: 409, body: { error: { code: "StorageAccountAlreadyTaken" } } }, // PUT 1
      { status: 200, body: {} }, // PUT 2 with suffixed name
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // poll
      { status: 404, body: {} }, // GET container
      { status: 201, body: {} }, // PUT container
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
    expect(azure.calls[6].path).toContain(suffixed);
  });

  it("fails a taken name immediately when no suffix minter is provided", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 404, body: {} },
      { status: 409, body: { error: { code: "StorageAccountAlreadyTaken" } } },
    );

    const result = await provisionLab(
      { azure },
      input({ flags: labDeploymentConfig("BlobCollectorLab", "public") }),
    );
    expect(result.ok).toBe(false);
    expect(result.storage?.accountCreated).toBe(false);
  });
});

describe("provisionLab - storage phase (BlobQueueLab with Event Grid)", () => {
  it("wires containers, queue, system topic, and the BlobCreated subscription", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 200, body: {} }, // GET storage account - exists
      { status: 404, body: {} }, // GET criblqueuesource container
      { status: 201, body: {} }, // PUT container
      { status: 404, body: {} }, // GET blob-notifications queue
      { status: 201, body: {} }, // PUT queue
      { status: 200, body: { registrationState: "Registered" } }, // GET provider
      { status: 404, body: {} }, // GET system topic
      { status: 201, body: {} }, // PUT system topic
      { status: 404, body: {} }, // GET subscription
      { status: 201, body: {} }, // PUT subscription
    );

    const result = await provisionLab(
      { azure },
      input({ flags: labDeploymentConfig("BlobQueueLab", "public") }),
    );

    expect(result.ok).toBe(true);
    expect(result.storage?.accountCreated).toBe(false);
    expect(result.storage?.containers).toEqual([
      { name: "criblqueuesource", created: true },
    ]);
    expect(result.storage?.queues).toEqual([
      { name: "blob-notifications", created: true },
    ]);
    expect(result.storage?.eventGridTopic).toBe("sacribllabcribl-events");
    expect(result.storage?.eventGridSubscriptions).toEqual(["blobCreated"]);
  });
});

describe("provisionLab - networking phase (BasicInfrastructure)", () => {
  it("creates NSGs first, then the VNet with inline associations", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 404, body: {} }, // GET NSG security
      { status: 201, body: {} }, // PUT NSG security
      { status: 404, body: {} }, // GET NSG o11y
      { status: 201, body: {} }, // PUT NSG o11y
      { status: 404, body: {} }, // GET NSG privatelink
      { status: 201, body: {} }, // PUT NSG privatelink
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // PUT VNet
    );

    const result = await provisionLab(
      { azure },
      input({ flags: labDeploymentConfig("BasicInfrastructure", "public") }),
    );

    expect(result.ok).toBe(true);
    expect(result.networking?.vnetName).toBe("vnet-cribllab-eastus");
    expect(result.networking?.nsgs).toHaveLength(3);
    expect(result.networking?.nsgs.every((n) => n.created)).toBe(true);

    // The LAST call is the VNet PUT with the desired subnets + associations.
    const vnetPut = azure.calls[azure.calls.length - 1];
    expect(vnetPut.method).toBe("PUT");
    const subnets = (vnetPut.body as any).properties.subnets;
    expect(subnets.map((s: any) => s.name)).toEqual([
      "GatewaySubnet",
      "SecuritySubnet",
      "O11ySubnet",
      "PrivateLinkSubnet",
    ]);
    expect(subnets[0].properties.networkSecurityGroup).toBeUndefined();
    expect(subnets[1].properties.networkSecurityGroup.id).toContain(
      "nsg-cribllab-SecuritySubnet-eastus",
    );
  });

  it("polls a VNet that provisions asynchronously", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 200, body: { properties: { provisioningState: "Updating" } } }, // PUT VNet
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // poll GET
    );

    const result = await provisionLab(
      { azure },
      input({ flags: labDeploymentConfig("BasicInfrastructure", "public") }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("provisionLab - cross-phase failure semantics", () => {
  it("a TTL grant failure skips every later phase (mandatory self-destruct)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { tags: {} } },
      { status: 200, body: {} },
      LOGIC_APP_OK,
      {
        status: 403,
        body: { error: { code: "AuthorizationFailed", message: "denied" } },
      },
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
  });

  it("a storage-account failure skips its sub-steps but networking still runs", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      ...FOUNDATION_OK,
      { status: 500, body: { error: { code: "InternalServerError" } } }, // GET storage
      { status: 404, body: {} }, // GET NSG security
      { status: 201, body: {} },
      { status: 404, body: {} }, // GET NSG o11y
      { status: 201, body: {} },
      { status: 404, body: {} }, // GET NSG privatelink
      { status: 201, body: {} },
      { status: 200, body: { properties: { provisioningState: "Succeeded" } } }, // PUT VNet
    );
    const jobs = new FakeJobStore();

    // FlowLogLab: storage + VNet + NSGs, no containers/queues/Event Grid.
    const result = await provisionLab(
      { azure, jobs },
      input({ flags: labDeploymentConfig("FlowLogLab", "public") }),
    );

    expect(result.ok).toBe(false);
    const record = (await jobs.list())[0];
    const byName = new Map(record.steps.map((s) => [s.name, s]));
    expect(byName.get("storage-account")?.status).toBe("failed");
    expect(byName.get("blob-containers")?.status).toBe("skipped");
    expect(byName.get("virtual-network")?.status).toBe("succeeded");
    expect(record.status).toBe("failed");
  });
});

describe("provisionLab - progress reporting", () => {
  it("fires onProgress for every step transition (foundation-only profile)", async () => {
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
