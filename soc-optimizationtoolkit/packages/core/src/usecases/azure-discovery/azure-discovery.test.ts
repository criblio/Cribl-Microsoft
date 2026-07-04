import { describe, expect, it } from "vitest";

import { FakeAzureManagement } from "../../testing/fake-azure-management";
import type { AzureManagement } from "../../ports/azure-management";
import type { ProfileStore } from "../../domain/azure-profiles";
import type { AzureConfig } from "../../domain/azure-config";
import {
  DEFAULT_WORKSPACE_POLL_ATTEMPTS,
  RESOURCE_GROUP_API_VERSION,
  SENTINEL_SOLUTION_API_VERSION,
  SUBSCRIPTIONS_API_VERSION,
  WORKSPACE_API_VERSION,
  WORKSPACE_DEFAULT_RETENTION_DAYS,
  WORKSPACE_DEFAULT_SKU,
  commitTargetScope,
  createResourceGroup,
  createWorkspace,
  enableSentinel,
  listAllPages,
  listResourceGroupChoices,
  listResourceGroups,
  listSubscriptions,
  listWorkspaces,
} from "./azure-discovery";

const SUB = "11111111-1111-1111-1111-111111111111";

/** The fake minus its requestUrl method: an adapter without pagination support. */
function withoutRequestUrl(fake: FakeAzureManagement): AzureManagement {
  return { request: (opts) => fake.request(opts) };
}

// ---------------------------------------------------------------------------
// listSubscriptions: Enabled-state filter (pinned) + tolerant mapping
// ---------------------------------------------------------------------------

describe("listSubscriptions", () => {
  it("returns ENABLED subscriptions only (legacy filter pinned) with {subscriptionId, displayName}", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [
          { id: `/subscriptions/${SUB}`, subscriptionId: SUB, displayName: "Prod", state: "Enabled" },
          { id: "/subscriptions/dead", subscriptionId: "dead", displayName: "Old", state: "Disabled" },
          { id: "/subscriptions/warn", subscriptionId: "warn", displayName: "Warned", state: "Warned" },
          { id: "/subscriptions/due", subscriptionId: "due", displayName: "PastDue", state: "PastDue" },
        ],
      },
    });

    const subscriptions = await listSubscriptions(azure);

    expect(subscriptions).toEqual([{ subscriptionId: SUB, displayName: "Prod" }]);
    expect(azure.calls[0]).toMatchObject({
      method: "GET",
      path: "/subscriptions",
      apiVersion: SUBSCRIPTIONS_API_VERSION,
    });
  });

  it("tolerates missing fields: subscriptionId falls back to the id path, missing displayName maps to ''", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [
          { id: "/subscriptions/from-id-only", state: "Enabled" },
          { state: "Enabled" }, // no identity at all -> dropped
          { subscriptionId: "no-state" }, // state missing -> not Enabled -> dropped
        ],
      },
    });

    const subscriptions = await listSubscriptions(azure);

    expect(subscriptions).toEqual([{ subscriptionId: "from-id-only", displayName: "" }]);
  });

  it("throws raw greppable error text on a non-2xx list response", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: { error: { code: "AuthorizationFailed" } } });
    await expect(listSubscriptions(azure)).rejects.toThrow(
      /list subscriptions: HTTP 403 .*AuthorizationFailed/,
    );
  });
});

// ---------------------------------------------------------------------------
// listWorkspaces: field mapping + tolerance
// ---------------------------------------------------------------------------

describe("listWorkspaces", () => {
  it("maps name, resourceGroup (parsed from the resource id), location, customerId, and sku", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [
          {
            id: `/subscriptions/${SUB}/resourceGroups/rg-sec/providers/Microsoft.OperationalInsights/workspaces/law-prod`,
            name: "law-prod",
            location: "westeurope",
            properties: {
              customerId: "22222222-2222-2222-2222-222222222222",
              sku: { name: "PerGB2018" },
            },
          },
        ],
      },
    });

    const workspaces = await listWorkspaces(azure, SUB);

    expect(workspaces).toEqual([
      {
        name: "law-prod",
        resourceGroup: "rg-sec",
        location: "westeurope",
        customerId: "22222222-2222-2222-2222-222222222222",
        sku: "PerGB2018",
      },
    ]);
    expect(azure.calls[0]).toMatchObject({
      method: "GET",
      path: `/subscriptions/${SUB}/providers/Microsoft.OperationalInsights/workspaces`,
      apiVersion: WORKSPACE_API_VERSION,
    });
  });

  it("is tolerant of missing fields: everything but name defaults to ''; nameless rows are dropped", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [
          { name: "bare-workspace" }, // no id/location/properties at all
          { name: "no-sku", id: "not-a-resource-id", location: "eastus2", properties: {} },
          { id: `/subscriptions/${SUB}/resourceGroups/rg-x/providers/Microsoft.OperationalInsights/workspaces/anon` }, // no name -> dropped
        ],
      },
    });

    const workspaces = await listWorkspaces(azure, SUB);

    expect(workspaces).toEqual([
      { name: "bare-workspace", resourceGroup: "", location: "", customerId: "", sku: "" },
      { name: "no-sku", resourceGroup: "", location: "eastus2", customerId: "", sku: "" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Resource groups: list + the legacy derived-from-workspaces fallback
// ---------------------------------------------------------------------------

describe("listResourceGroups / listResourceGroupChoices", () => {
  it("lists resource groups as {name, location}", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [
          { id: `/subscriptions/${SUB}/resourceGroups/rg-a`, name: "rg-a", location: "eastus" },
          { location: "westus" }, // nameless -> dropped
        ],
      },
    });

    const groups = await listResourceGroups(azure, SUB);

    expect(groups).toEqual([{ name: "rg-a", location: "eastus" }]);
    expect(azure.calls[0]).toMatchObject({
      method: "GET",
      path: `/subscriptions/${SUB}/resourcegroups`,
      apiVersion: RESOURCE_GROUP_API_VERSION,
    });
  });

  it("uses the ARM list when it succeeds and returns groups", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: { value: [{ name: "rg-listed", location: "eastus" }] },
    });

    const choices = await listResourceGroupChoices(azure, SUB, [
      { resourceGroup: "rg-from-ws", location: "westus" },
    ]);

    expect(choices).toEqual({
      groups: [{ name: "rg-listed", location: "eastus" }],
      source: "list",
      listError: null,
    });
  });

  it("falls back to deriveResourceGroupsFromWorkspaces when the RG list call is DENIED (legacy behavior)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: { error: { code: "AuthorizationFailed" } } });

    const choices = await listResourceGroupChoices(azure, SUB, [
      { resourceGroup: "rg-a", location: "eastus" },
      { resourceGroup: "rg-a", location: "centralus" },
      { resourceGroup: "rg-b", location: "westus" },
    ]);

    expect(choices.source).toBe("workspaces");
    expect(choices.groups).toEqual([
      { name: "rg-a", location: "eastus" },
      { name: "rg-b", location: "westus" },
    ]);
    expect(choices.listError).toMatch(/HTTP 403 .*AuthorizationFailed/);
  });

  it("falls back to workspace derivation when the list succeeds but is empty", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { value: [] } });

    const choices = await listResourceGroupChoices(azure, SUB, [
      { resourceGroup: "rg-ws", location: "northeurope" },
    ]);

    expect(choices).toEqual({
      groups: [{ name: "rg-ws", location: "northeurope" }],
      source: "workspaces",
      listError: null,
    });
  });

  it("reports empty groups plus the error text when the list is denied and nothing is derivable", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: { error: { code: "AuthorizationFailed" } } });

    const choices = await listResourceGroupChoices(azure, SUB, []);

    expect(choices.groups).toEqual([]);
    expect(choices.listError).toMatch(/HTTP 403/);
  });
});

// ---------------------------------------------------------------------------
// Pagination: listAllPages follows nextLink via the optional requestUrl
// ---------------------------------------------------------------------------

describe("listAllPages", () => {
  const NEXT = `https://management.azure.com/subscriptions/${SUB}/resourcegroups?api-version=2021-04-01&%24skiptoken=abc`;

  it("follows nextLink across two pages via requestUrl and concatenates the items", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { value: [{ name: "rg-1", location: "eastus" }], nextLink: NEXT } },
      { status: 200, body: { value: [{ name: "rg-2", location: "westus" }] } },
    );

    const groups = await listResourceGroups(azure, SUB);

    expect(groups).toEqual([
      { name: "rg-1", location: "eastus" },
      { name: "rg-2", location: "westus" },
    ]);
    expect(azure.calls).toHaveLength(1); // first page via path request
    expect(azure.urlCalls).toEqual([{ method: "GET", url: NEXT }]); // second page via the FULL nextLink URL
  });

  it("returns the single first page when the adapter does not implement requestUrl", async () => {
    const fake = new FakeAzureManagement();
    fake.respondWith({
      status: 200,
      body: { value: [{ name: "rg-1", location: "eastus" }], nextLink: NEXT },
    });

    const groups = await listResourceGroups(withoutRequestUrl(fake), SUB);

    expect(groups).toEqual([{ name: "rg-1", location: "eastus" }]);
    expect(fake.urlCalls).toHaveLength(0);
  });

  it("throws with page context when a follow-up page fails", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { value: [], nextLink: NEXT } },
      { status: 500, body: { error: { code: "InternalServerError" } } },
    );

    await expect(
      listAllPages(
        azure,
        { method: "GET", path: `/subscriptions/${SUB}/resourcegroups`, apiVersion: RESOURCE_GROUP_API_VERSION },
        "list resource groups",
      ),
    ).rejects.toThrow(/list resource groups \(page 2\): HTTP 500/);
  });

  it("tolerates a body with no value array", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: {} });
    const items = await listAllPages(
      azure,
      { method: "GET", path: "/subscriptions", apiVersion: SUBSCRIPTIONS_API_VERSION },
      "list subscriptions",
    );
    expect(items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createResourceGroup
// ---------------------------------------------------------------------------

describe("createResourceGroup", () => {
  it("PUTs the resource group with its location and returns the resulting name/location", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 201,
      body: { id: `/subscriptions/${SUB}/resourceGroups/rg-new`, name: "rg-new", location: "eastus" },
    });

    const created = await createResourceGroup(azure, {
      subscriptionId: SUB,
      name: "rg-new",
      location: "eastus",
    });

    expect(created).toEqual({ name: "rg-new", location: "eastus" });
    expect(azure.calls[0]).toMatchObject({
      method: "PUT",
      path: `/subscriptions/${SUB}/resourcegroups/rg-new`,
      apiVersion: RESOURCE_GROUP_API_VERSION,
      body: { location: "eastus" },
    });
  });

  it("throws raw error text on a non-2xx response", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: { error: { code: "AuthorizationFailed" } } });
    await expect(
      createResourceGroup(azure, { subscriptionId: SUB, name: "rg-no", location: "eastus" }),
    ).rejects.toThrow(/create resource group 'rg-no': HTTP 403/);
  });
});

// ---------------------------------------------------------------------------
// createWorkspace: legacy defaults + attempt-bounded provisioning poll
// ---------------------------------------------------------------------------

describe("createWorkspace", () => {
  const WS_PATH =
    `/subscriptions/${SUB}/resourceGroups/rg-sec` +
    `/providers/Microsoft.OperationalInsights/workspaces/law-new`;

  it("PUTs the legacy body (sku PerGB2018, retentionInDays 90) and polls until Succeeded", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 201, body: { properties: { provisioningState: "Creating" } } },
      { status: 200, body: { properties: { provisioningState: "Creating" } } },
      {
        status: 200,
        body: {
          id: WS_PATH,
          location: "westeurope",
          properties: {
            provisioningState: "Succeeded",
            customerId: "33333333-3333-3333-3333-333333333333",
          },
        },
      },
    );

    const created = await createWorkspace(azure, {
      subscriptionId: SUB,
      resourceGroup: "rg-sec",
      name: "law-new",
      location: "westeurope",
    });

    expect(created).toEqual({
      name: "law-new",
      resourceGroup: "rg-sec",
      location: "westeurope",
      customerId: "33333333-3333-3333-3333-333333333333",
    });
    expect(azure.calls[0]).toMatchObject({
      method: "PUT",
      path: WS_PATH,
      apiVersion: WORKSPACE_API_VERSION,
      body: {
        location: "westeurope",
        properties: {
          sku: { name: WORKSPACE_DEFAULT_SKU },
          retentionInDays: WORKSPACE_DEFAULT_RETENTION_DAYS,
        },
      },
    });
    expect(azure.calls[1]).toMatchObject({ method: "GET", path: WS_PATH });
    expect(azure.calls).toHaveLength(3);
    expect(WORKSPACE_DEFAULT_SKU).toBe("PerGB2018");
    expect(WORKSPACE_DEFAULT_RETENTION_DAYS).toBe(90);
  });

  it("bounds the provisioning poll by ATTEMPT COUNT and throws when exhausted", async () => {
    const azure = new FakeAzureManagement();
    const maxPollAttempts = 3;
    azure.respondWith(
      { status: 201, body: { properties: { provisioningState: "Creating" } } },
      ...Array.from({ length: maxPollAttempts }, () => ({
        status: 200,
        body: { properties: { provisioningState: "Creating" } },
      })),
    );

    await expect(
      createWorkspace(azure, {
        subscriptionId: SUB,
        resourceGroup: "rg-sec",
        name: "law-slow",
        location: "eastus",
        maxPollAttempts,
      }),
    ).rejects.toThrow(/did not reach provisioningState Succeeded within 3 poll attempts/);
    // Exactly 1 PUT + maxPollAttempts GETs - no unbounded polling.
    expect(azure.calls).toHaveLength(1 + maxPollAttempts);
    expect(DEFAULT_WORKSPACE_POLL_ATTEMPTS).toBeGreaterThan(0);
  });

  it("throws immediately when provisioning ends in Failed", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 201, body: { properties: { provisioningState: "Creating" } } },
      { status: 200, body: { properties: { provisioningState: "Failed" } } },
    );
    await expect(
      createWorkspace(azure, {
        subscriptionId: SUB,
        resourceGroup: "rg-sec",
        name: "law-bad",
        location: "eastus",
      }),
    ).rejects.toThrow(/provisioning ended in state 'Failed'/);
  });
});

// ---------------------------------------------------------------------------
// enableSentinel: idempotent pre-check + the location FIX (never eastus)
// ---------------------------------------------------------------------------

describe("enableSentinel", () => {
  const WS_PATH =
    `/subscriptions/${SUB}/resourceGroups/rg-sec` +
    `/providers/Microsoft.OperationalInsights/workspaces/law-prod`;
  const SOLUTION_PATH =
    `/subscriptions/${SUB}/resourceGroups/rg-sec` +
    `/providers/Microsoft.OperationsManagement/solutions/SecurityInsights(law-prod)`;

  it("deploys the SecurityInsights solution in the WORKSPACE'S ACTUAL location (legacy always-eastus bug fixed)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { id: WS_PATH, location: "westeurope" } }, // workspace GET
      { status: 404, body: { error: { code: "ResourceNotFound" } } }, // pre-check: not enabled
      { status: 201, body: {} }, // solution PUT
    );

    const result = await enableSentinel(azure, {
      subscriptionId: SUB,
      resourceGroup: "rg-sec",
      workspaceName: "law-prod",
    });

    expect(result).toEqual({
      alreadyEnabled: false,
      location: "westeurope",
      solutionName: "SecurityInsights(law-prod)",
    });

    const put = azure.calls[2]!;
    expect(put).toMatchObject({
      method: "PUT",
      path: SOLUTION_PATH,
      apiVersion: SENTINEL_SOLUTION_API_VERSION,
    });
    // THE FIX, pinned: the request body carries the workspace's location.
    expect(put.body).toEqual({
      location: "westeurope",
      plan: {
        name: "SecurityInsights(law-prod)",
        publisher: "Microsoft",
        product: "OMSGallery/SecurityInsights",
        promotionCode: "",
      },
      properties: { workspaceResourceId: WS_PATH },
    });
    expect((put.body as { location: string }).location).not.toBe("eastus");
  });

  it("is IDEMPOTENT: a 2xx pre-check short-circuits to alreadyEnabled success with NO PUT", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { id: WS_PATH, location: "australiaeast" } }, // workspace GET
      { status: 200, body: { name: "SecurityInsights(law-prod)" } }, // pre-check: exists
    );

    const result = await enableSentinel(azure, {
      subscriptionId: SUB,
      resourceGroup: "rg-sec",
      workspaceName: "law-prod",
    });

    expect(result).toEqual({
      alreadyEnabled: true,
      location: "australiaeast",
      solutionName: "SecurityInsights(law-prod)",
    });
    // Exactly two calls: workspace GET + pre-check GET. No PUT was sent.
    expect(azure.calls).toHaveLength(2);
    expect(azure.calls[1]).toMatchObject({
      method: "GET",
      path: SOLUTION_PATH,
      apiVersion: SENTINEL_SOLUTION_API_VERSION,
    });
  });

  it("throws when the workspace reports no location (never silently defaults a region)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { id: WS_PATH } });
    await expect(
      enableSentinel(azure, {
        subscriptionId: SUB,
        resourceGroup: "rg-sec",
        workspaceName: "law-prod",
      }),
    ).rejects.toThrow(/reported no location/);
  });

  it("throws raw error text when the solution PUT fails", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { id: WS_PATH, location: "westeurope" } },
      { status: 404, body: {} },
      { status: 403, body: { error: { code: "AuthorizationFailed" } } },
    );
    await expect(
      enableSentinel(azure, {
        subscriptionId: SUB,
        resourceGroup: "rg-sec",
        workspaceName: "law-prod",
      }),
    ).rejects.toThrow(/enable Sentinel on 'law-prod': HTTP 403/);
  });
});

// ---------------------------------------------------------------------------
// commitTargetScope: merge-never-replace into the active profile
// ---------------------------------------------------------------------------

describe("commitTargetScope", () => {
  const baseConfig: AzureConfig = {
    clientId: "client-1",
    tenantId: "tenant-1",
    subscriptionId: "old-sub",
    resourceGroup: "old-rg",
    workspaceName: "old-ws",
    setupPath: "lab-byo-rg",
  };

  function storeWithActive(): ProfileStore {
    return {
      profiles: [
        { id: "p-other", name: "Other", config: { ...baseConfig, clientId: "client-2" } },
        { id: "p-active", name: "Active", config: { ...baseConfig } },
      ],
      activeProfileId: "p-active",
    };
  }

  it("MERGES the scope into the active profile: unrelated fields and other profiles survive", async () => {
    const store = storeWithActive();

    const result = commitTargetScope(store, {
      subscriptionId: SUB,
      resourceGroup: "rg-new",
      workspaceName: "law-new",
    });

    expect(result.committed).toBe(true);
    const active = result.store.profiles.find((p) => p.id === "p-active")!;
    expect(active.config).toEqual({
      // MERGE, not replace: identity + setupPath survive untouched.
      clientId: "client-1",
      tenantId: "tenant-1",
      setupPath: "lab-byo-rg",
      subscriptionId: SUB,
      resourceGroup: "rg-new",
      workspaceName: "law-new",
    });
    // Other profiles and the active pointer are untouched.
    expect(result.store.profiles.find((p) => p.id === "p-other")!.config).toEqual({
      ...baseConfig,
      clientId: "client-2",
    });
    expect(result.store.activeProfileId).toBe("p-active");
    // Pure: the input store was not mutated.
    expect(store.profiles.find((p) => p.id === "p-active")!.config.subscriptionId).toBe("old-sub");
  });

  it("reports a SCOPE-ONLY invalidation: permission results clear, secret and token survive", () => {
    const result = commitTargetScope(storeWithActive(), {
      subscriptionId: SUB,
      resourceGroup: "rg-new",
      workspaceName: "law-new",
    });
    expect(result.invalidation).toEqual({
      clearSecret: false,
      clearToken: false,
      clearPermissionResults: true,
    });
  });

  it("reports nothing to invalidate when the committed scope equals the current one", () => {
    const result = commitTargetScope(storeWithActive(), {
      subscriptionId: "old-sub",
      resourceGroup: "old-rg",
      workspaceName: "old-ws",
    });
    expect(result.committed).toBe(true);
    expect(result.invalidation).toEqual({
      clearSecret: false,
      clearToken: false,
      clearPermissionResults: false,
    });
  });

  it("is a no-op when no profile is active", () => {
    const store: ProfileStore = {
      profiles: [{ id: "p1", name: "P1", config: { ...baseConfig } }],
      activeProfileId: null,
    };
    const result = commitTargetScope(store, {
      subscriptionId: SUB,
      resourceGroup: "rg-new",
      workspaceName: "law-new",
    });
    expect(result.committed).toBe(false);
    expect(result.store).toBe(store);
    expect(result.invalidation).toEqual({
      clearSecret: false,
      clearToken: false,
      clearPermissionResults: false,
    });
  });
});
