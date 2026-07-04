import { describe, expect, it } from "vitest";

import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeLogger } from "../../testing/fake-logger";
import {
  createResourceGroup,
  enableSentinel,
  listResourceGroupChoices,
  listSubscriptions,
  listWorkspaces,
} from "./azure-discovery";

const SUB = "11111111-1111-1111-1111-111111111111";

describe("azure-discovery logging", () => {
  it("logs list call boundaries with COUNTS and ids, never response bodies", async () => {
    const azure = new FakeAzureManagement();
    const logger = new FakeLogger(() => "2026-07-03T10:00:00.000Z");
    azure.respondWith({
      status: 200,
      body: {
        value: [
          { subscriptionId: SUB, displayName: "Prod", state: "Enabled" },
          { subscriptionId: "off", displayName: "Old", state: "Disabled" },
        ],
      },
    });

    await listSubscriptions(azure, logger);

    expect(logger.entries).toEqual([
      {
        timestamp: "2026-07-03T10:00:00.000Z",
        level: "debug",
        message: "azure-discovery: list subscriptions",
        context: {},
      },
      {
        timestamp: "2026-07-03T10:00:00.000Z",
        level: "info",
        message: "azure-discovery: list subscriptions succeeded",
        context: { count: 1 },
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain("Prod");
  });

  it("logs list failures with the raw greppable error text and still rethrows", async () => {
    const azure = new FakeAzureManagement();
    const logger = new FakeLogger();
    azure.respondWith({ status: 403, body: { error: { code: "AuthorizationFailed" } } });

    await expect(listWorkspaces(azure, SUB, logger)).rejects.toThrow(/HTTP 403/);

    const errors = logger.entries.filter((entry) => entry.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("azure-discovery: list workspaces failed");
    expect(errors[0].context?.subscriptionId).toBe(SUB);
    expect(errors[0].context?.error).toMatch(
      /list workspaces in subscription .*: HTTP 403 .*AuthorizationFailed/,
    );
  });

  it("warns when the resource-group fallback derives choices from workspaces", async () => {
    const azure = new FakeAzureManagement();
    const logger = new FakeLogger();
    azure.respondWith({ status: 403, body: { error: { code: "AuthorizationFailed" } } });

    const choices = await listResourceGroupChoices(azure, SUB, [
      { resourceGroup: "rg-sec", location: "eastus" },
    ], logger);

    expect(choices.source).toBe("workspaces");
    const warns = logger.entries.filter((entry) => entry.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toBe(
      "azure-discovery: resource-group list unavailable; derived choices from workspaces",
    );
    expect(warns[0].context).toMatchObject({
      subscriptionId: SUB,
      derivedCount: 1,
    });
    expect(warns[0].context?.listError).toMatch(/HTTP 403/);
  });

  it("logs create boundaries with the target identifiers", async () => {
    const azure = new FakeAzureManagement();
    const logger = new FakeLogger();
    azure.respondWith({
      status: 201,
      body: { name: "rg-new", location: "westus2" },
    });

    await createResourceGroup(
      azure,
      { subscriptionId: SUB, name: "rg-new", location: "westus2" },
      logger,
    );

    expect(logger.messagesAt("debug")).toEqual([
      "azure-discovery: create resource group",
    ]);
    const info = logger.entries.filter((entry) => entry.level === "info");
    expect(info[0].message).toBe("azure-discovery: create resource group succeeded");
    expect(info[0].context).toEqual({
      subscriptionId: SUB,
      name: "rg-new",
      location: "westus2",
    });
  });

  it("logs the enable-Sentinel outcome including alreadyEnabled and the ACTUAL location", async () => {
    const azure = new FakeAzureManagement();
    const logger = new FakeLogger();
    azure.respondWith(
      // workspace GET (actual location, not eastus)
      { status: 200, body: { id: "/subscriptions/x/y", location: "westeurope" } },
      // solution pre-check: exists
      { status: 200, body: {} },
    );

    const result = await enableSentinel(
      azure,
      { subscriptionId: SUB, resourceGroup: "rg-sec", workspaceName: "law-prod" },
      logger,
    );

    expect(result.alreadyEnabled).toBe(true);
    const info = logger.entries.filter((entry) => entry.level === "info");
    expect(info[0].message).toBe("azure-discovery: enable Sentinel succeeded");
    expect(info[0].context).toMatchObject({
      workspaceName: "law-prod",
      alreadyEnabled: true,
      location: "westeurope",
    });
  });

  it("is a pure passthrough without a logger (zero behavior change)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: { value: [{ subscriptionId: SUB, displayName: "Prod", state: "Enabled" }] },
    });

    const subscriptions = await listSubscriptions(azure);

    expect(subscriptions).toEqual([{ subscriptionId: SUB, displayName: "Prod" }]);
  });
});
