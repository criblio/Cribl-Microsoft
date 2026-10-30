/**
 * discoverEventHubNamespaces pins (AZR-18). The namespaces-only read the
 * onboarding picker uses: the Resource Graph POST and nothing else, an empty
 * answer that stays unverified, and the Reader hint on a 403. The full
 * discoverEventHubs contract stays pinned in eventhub-discovery.test.ts.
 */

import { describe, expect, it } from "vitest";

import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeLogger } from "../../testing/fake-logger";
import {
  EH_DISCOVERY_MAX_PAGES,
  discoverEventHubNamespaces,
  discoverEventHubs,
} from "./discover-event-hubs";

function nsRow(name: string): Record<string, unknown> {
  return {
    name,
    resourceGroup: "rg-cribl-logging",
    location: "eastus",
    subscriptionId: "sub-1",
    skuName: "Standard",
    id: `/subscriptions/sub-1/resourceGroups/rg-cribl-logging/providers/Microsoft.EventHub/namespaces/${name}`,
  };
}

describe("discoverEventHubNamespaces (AZR-18)", () => {
  it("lists 3 namespaces with exactly 1 Resource Graph POST and no hub GETs", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: { data: [nsRow("ns-a"), nsRow("ns-b"), nsRow("ns-c")] },
    });
    const listing = await discoverEventHubNamespaces(azure, "sub-1");

    expect(listing.kind).toBe("rows");
    if (listing.kind !== "rows") throw new Error("unreachable");
    expect(listing.rows.map((n) => n.name)).toEqual(["ns-a", "ns-b", "ns-c"]);
    expect(listing.rows[0].resourceGroup).toBe("rg-cribl-logging");

    expect(azure.calls).toHaveLength(1);
    expect(azure.calls[0].method).toBe("POST");
    expect(azure.calls[0].path).toBe("/providers/Microsoft.ResourceGraph/resources");
    expect(
      (azure.calls[0].body as Record<string, unknown>)["subscriptions"],
    ).toEqual(["sub-1"]);
    expect(azure.calls.filter((c) => c.path.includes("/eventhubs"))).toHaveLength(0);
    expect(azure.urlCalls).toHaveLength(0);
  });

  it("follows the skipToken and still issues only Resource Graph POSTs", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { data: [nsRow("ns-a")], $skipToken: "more" } },
      { status: 200, body: { data: [nsRow("ns-b")] } },
    );
    const listing = await discoverEventHubNamespaces(azure, "sub-1");
    expect(listing.kind === "rows" ? listing.rows.map((n) => n.name) : []).toEqual([
      "ns-a",
      "ns-b",
    ]);
    expect(azure.calls.map((c) => c.method)).toEqual(["POST", "POST"]);
    expect((azure.calls[1].body as Record<string, unknown>)["options"]).toEqual({
      $skipToken: "more",
    });
  });

  it("stops at the pagination bound even if every page carries a skipToken", async () => {
    const azure = new FakeAzureManagement();
    for (let i = 0; i < EH_DISCOVERY_MAX_PAGES + 2; i += 1) {
      azure.respondWith({
        status: 200,
        body: { data: [nsRow(`ns-${i}`)], $skipToken: `t${i}` },
      });
    }
    await discoverEventHubNamespaces(azure, "sub-1");
    expect(azure.calls).toHaveLength(EH_DISCOVERY_MAX_PAGES);
  });

  it("returns 'empty' - never 'none' - when Resource Graph returns no rows", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { data: [] } });
    const listing = await discoverEventHubNamespaces(azure, "sub-1");
    expect(listing).toEqual({ kind: "empty" });
  });

  it("logs the listing kind and no count at all for an empty read", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { data: [] } });
    const logger = new FakeLogger();
    await discoverEventHubNamespaces(azure, "sub-1", logger);
    const entries = logger.entries.filter(
      (e) => e.message === "eventhub-discovery: namespaces",
    );
    expect(entries).toHaveLength(1);
    // toEqual, not toMatchObject: a `namespaces: 0` key must fail this.
    expect(entries[0].context).toEqual({ subscription: "sub-1", listing: "empty" });
  });

  it("logs the row count alongside the kind when rows came back", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: { data: [nsRow("ns-a"), nsRow("ns-b"), nsRow("ns-c")] },
    });
    const logger = new FakeLogger();
    await discoverEventHubNamespaces(azure, "sub-1", logger);
    const entries = logger.entries.filter(
      (e) => e.message === "eventhub-discovery: namespaces",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].context).toEqual({
      subscription: "sub-1",
      listing: "rows",
      namespaces: 3,
    });
  });

  it("throws with the Reader hint on a 403", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: { error: { code: "AuthorizationFailed" } } });
    await expect(discoverEventHubNamespaces(azure, "sub-1")).rejects.toThrow(
      /HTTP 403 - the identity needs Reader on the subscription/,
    );
  });

  it("throws without the Reader hint on a non-403 failure", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 500, body: {} });
    const err = await discoverEventHubNamespaces(azure, "sub-1").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Resource Graph query failed: HTTP 500");
  });
});

describe("discoverEventHubs delegates to discoverEventHubNamespaces", () => {
  it("with an empty namespace read makes 1 POST, lists no hubs, and warns nothing", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { data: [] } });
    const result = await discoverEventHubs(azure, { subscriptionId: "sub-1" });
    expect(result).toEqual({ namespaces: [], hubs: [], warnings: [] });
    expect(azure.calls).toHaveLength(1);
  });

  it("logs the namespace listing kind, not an unwrapped length, on completion", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { data: [] } });
    const logger = new FakeLogger();
    await discoverEventHubs(azure, { subscriptionId: "sub-1" }, logger);
    const entries = logger.entries.filter(
      (e) => e.message === "eventhub-discovery: complete",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].context).toEqual({
      subscription: "sub-1",
      namespaceListing: "empty",
      hubs: 0,
      warnings: 0,
    });
  });
});
