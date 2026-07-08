/**
 * eventhub-discovery pins - roadmap Phase 4 (EVH-03 + LOG-16). The Resource
 * Graph request/parse shapes, the VERBATIM legacy Cribl source template
 * (field set, defaults, secret naming, id sanitization), and the discovery
 * usecase's pagination + soft-failure contract.
 */

import { describe, expect, it } from "vitest";

import { FakeAzureManagement } from "../../testing/fake-azure-management";
import {
  EH_SECRET_PLACEHOLDER,
  EVENTHUB_NAMESPACES_KQL,
  buildConnectionStringsReference,
  buildEventHubSourceConfig,
  ehSecretName,
  listEventHubsRequest,
  parseEventHubItem,
  parseNamespacesResponse,
  resourceGraphRequest,
  sanitizeEhId,
} from "./eventhub-discovery";
import { discoverEventHubs } from "../../usecases/discover-event-hubs/discover-event-hubs";

const NS = {
  name: "cribl-diag-a64acbf7",
  resourceGroup: "rg-cribl-logging",
  location: "eastus",
  subscriptionId: "sub-1",
  skuName: "Standard",
  resourceId: "/subscriptions/sub-1/resourceGroups/rg-cribl-logging/providers/Microsoft.EventHub/namespaces/cribl-diag-a64acbf7",
};

describe("Resource Graph request/parse (EVH-03)", () => {
  it("builds the namespaces POST with the subscription scope", () => {
    const req = resourceGraphRequest("sub-1", EVENTHUB_NAMESPACES_KQL);
    expect(req).toMatchObject({
      method: "POST",
      path: "/providers/Microsoft.ResourceGraph/resources",
    });
    expect(req.body).toMatchObject({
      subscriptions: ["sub-1"],
      query: EVENTHUB_NAMESPACES_KQL,
    });
    expect((req.body as Record<string, unknown>)["options"]).toBeUndefined();
  });

  it("carries the skipToken continuation when present", () => {
    const req = resourceGraphRequest("sub-1", EVENTHUB_NAMESPACES_KQL, "tok");
    expect((req.body as Record<string, unknown>)["options"]).toEqual({
      $skipToken: "tok",
    });
  });

  it("parses rows and the continuation token, dropping nameless rows", () => {
    const parsed = parseNamespacesResponse({
      data: [
        {
          name: "ns-1",
          resourceGroup: "rg",
          location: "eastus",
          subscriptionId: "sub-1",
          skuName: "Standard",
          id: "/x/ns-1",
        },
        { location: "westus" },
        "garbage",
      ],
      $skipToken: "next",
    });
    expect(parsed.namespaces).toHaveLength(1);
    expect(parsed.namespaces[0].name).toBe("ns-1");
    expect(parsed.skipToken).toBe("next");
  });

  it("builds the per-namespace hub GET and parses items defensively", () => {
    const req = listEventHubsRequest(NS);
    expect(req.path).toBe(
      "/subscriptions/sub-1/resourceGroups/rg-cribl-logging" +
        "/providers/Microsoft.EventHub/namespaces/cribl-diag-a64acbf7/eventhubs",
    );
    const hub = parseEventHubItem(
      {
        name: "insights-logs-auditevent",
        id: "/x/hub",
        properties: { partitionCount: 4, messageRetentionInDays: 7, status: "Active" },
      },
      NS.name,
    );
    expect(hub).toMatchObject({
      name: "insights-logs-auditevent",
      namespace: NS.name,
      partitionCount: 4,
      status: "Active",
    });
    expect(parseEventHubItem({ properties: {} }, NS.name)).toBeNull();
    expect(parseEventHubItem("junk", NS.name)).toBeNull();
  });
});

describe("Cribl source generation (LOG-16, verbatim legacy template)", () => {
  it("sanitizes ids and names the secret by the legacy convention", () => {
    expect(sanitizeEhId("cribl-diag.a64")).toBe("cribl_diag_a64");
    expect(ehSecretName("cribl-diag-a64acbf7")).toBe(
      "eh_cribl_diag_a64acbf7_connectionString",
    );
  });

  it("builds the legacy source config shape", () => {
    const config = buildEventHubSourceConfig(
      "cribl-diag-a64acbf7",
      "insights-logs-auditevent",
    );
    expect(config).toMatchObject({
      id: "eh_cribl_diag_a64acbf7_insights_logs_auditevent",
      type: "eventhub",
      brokers: ["cribl-diag-a64acbf7.servicebus.windows.net:9093"],
      topics: ["insights-logs-auditevent"],
      groupId: "$Default",
      fromBeginning: true,
      sasl: {
        disabled: false,
        mechanism: "plain",
        authType: "secret",
        username: "$ConnectionString",
        password: EH_SECRET_PLACEHOLDER,
        textSecret: "eh_cribl_diag_a64acbf7_connectionString",
      },
      tls: { disabled: false, rejectUnauthorized: true },
    });
    // The legacy tuning defaults survive verbatim.
    expect(config["maxBytesPerPartition"]).toBe(1048576);
    expect(config["sessionTimeout"]).toBe(30000);
  });

  it("honors a custom consumer group", () => {
    const config = buildEventHubSourceConfig("ns", "hub", "cribl-group");
    expect(config["groupId"]).toBe("cribl-group");
  });

  it("builds the connection-strings reference with deduped namespaces", () => {
    const ref = buildConnectionStringsReference(["ns-b", "ns-a", "ns-b"]);
    const secrets = ref["secrets"] as Array<Record<string, string>>;
    expect(secrets.map((s) => s.namespace)).toEqual(["ns-a", "ns-b"]);
    expect(secrets[0].secretName).toBe("eh_ns_a_connectionString");
    expect(secrets[0].connectionStringFormat).toContain("sb://ns-a.servicebus.windows.net/");
  });
});

describe("discoverEventHubs usecase", () => {
  it("paginates namespaces and lists hubs per namespace", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      // Page 1 with a continuation.
      {
        status: 200,
        body: {
          data: [{ ...NS, name: "ns-1", id: "/x/ns-1" }],
          $skipToken: "more",
        },
      },
      // Page 2, complete.
      { status: 200, body: { data: [{ ...NS, name: "ns-2", id: "/x/ns-2" }] } },
      // Hubs for ns-1.
      {
        status: 200,
        body: { value: [{ name: "hub-a", id: "/x/a", properties: { partitionCount: 2 } }] },
      },
      // Hubs for ns-2.
      { status: 200, body: { value: [{ name: "hub-b", id: "/x/b", properties: {} }] } },
    );
    const result = await discoverEventHubs(azure, { subscriptionId: "sub-1" });
    expect(result.namespaces.map((n) => n.name)).toEqual(["ns-1", "ns-2"]);
    expect(result.hubs.map((h) => `${h.namespace}/${h.name}`)).toEqual([
      "ns-1/hub-a",
      "ns-2/hub-b",
    ]);
    expect(result.warnings).toEqual([]);
    // The second Resource Graph call carried the continuation token.
    expect((azure.calls[1].body as Record<string, unknown>)["options"]).toEqual({
      $skipToken: "more",
    });
  });

  it("soft-fails a namespace whose hub listing is denied", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { data: [{ ...NS, name: "ns-1" }, { ...NS, name: "ns-2" }] } },
      { status: 403, body: { error: { code: "AuthorizationFailed" } } },
      { status: 200, body: { value: [{ name: "hub-b", id: "/x/b", properties: {} }] } },
    );
    const result = await discoverEventHubs(azure, { subscriptionId: "sub-1" });
    expect(result.hubs.map((h) => h.name)).toEqual(["hub-b"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("ns-1");
  });

  it("throws on a Resource Graph failure with a permission hint on 403", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: {} });
    await expect(
      discoverEventHubs(azure, { subscriptionId: "sub-1" }),
    ).rejects.toThrow(/Reader on the subscription/);
  });
});
