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
import {
  analyzeHubFindings,
  deriveEhStatistics,
  metricsRequest,
  parseDiagSettingsResponse,
  parseIncomingMessagesTotal,
  sendersForHub,
} from "./eventhub-discovery";
import type { DiagnosticSettingSender, HubActivity } from "./eventhub-discovery";
import {
  inferSendersFromEnumeration,
  listAuthRulesRequest,
  listConsumerGroupsRequest,
  parseAuthRulesResponse,
  parseConsumerGroupsResponse,
} from "./eventhub-discovery";
import {
  checkEventHubActivity,
  discoverEventHubSenders,
  discoverEventHubs,
  enumerateEventHubDetails,
} from "../../usecases/discover-event-hubs/discover-event-hubs";

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

describe("sender discovery (EVH-04)", () => {
  const SENDERS: DiagnosticSettingSender[] = [
    { settingName: "to-hub-a", eventHubName: "hub-a", eventHubNamespace: "ns-1", sourceResourceId: "/x/kv" },
    { settingName: "ns-wide", eventHubName: "", eventHubNamespace: "ns-1", sourceResourceId: "/x/vault" },
    { settingName: "other-ns", eventHubName: "hub-a", eventHubNamespace: "ns-2", sourceResourceId: "/x/sql" },
  ];

  it("parses rows + skipToken, dropping nameless rows", () => {
    const parsed = parseDiagSettingsResponse({
      data: [
        { name: "d1", eventHubName: "h", eventHubNamespace: "n", sourceResourceId: "/x" },
        { eventHubName: "orphan" },
      ],
      $skipToken: "next",
    });
    expect(parsed.senders).toHaveLength(1);
    expect(parsed.skipToken).toBe("next");
  });

  it("matches explicit hub targets and namespace-wide settings, never other namespaces", () => {
    expect(sendersForHub(SENDERS, "ns-1", "hub-a").map((s) => s.settingName)).toEqual([
      "to-hub-a",
      "ns-wide",
    ]);
    // The legacy -or overcount is FIXED: an explicit hub-a setting does not
    // credit hub-b; only the namespace-wide (empty hub) setting does.
    expect(sendersForHub(SENDERS, "ns-1", "hub-b").map((s) => s.settingName)).toEqual([
      "ns-wide",
    ]);
    expect(sendersForHub(SENDERS, "ns-3", "hub-a")).toEqual([]);
  });

  it("discoverEventHubSenders paginates and throws on failure", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { data: [{ name: "d1", eventHubName: "h", eventHubNamespace: "n", sourceResourceId: "/x" }], $skipToken: "t" } },
      { status: 200, body: { data: [{ name: "d2", eventHubName: "", eventHubNamespace: "n", sourceResourceId: "/y" }] } },
    );
    const senders = await discoverEventHubSenders(azure, { subscriptionId: "sub-1" });
    expect(senders.map((s) => s.settingName)).toEqual(["d1", "d2"]);

    const failing = new FakeAzureManagement();
    failing.respondWith({ status: 500, body: {} });
    await expect(
      discoverEventHubSenders(failing, { subscriptionId: "sub-1" }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("activity detection (EVH-07)", () => {
  it("builds the legacy metrics GET (IncomingMessages, PT1H, Total)", () => {
    const req = metricsRequest("/x/hub", "2026-07-01T00:00:00Z/2026-07-08T00:00:00Z");
    expect(req.path).toBe("/x/hub/providers/microsoft.insights/metrics");
    expect(req.query).toMatchObject({
      metricnames: "IncomingMessages",
      interval: "PT1H",
      aggregation: "Total",
    });
  });

  it("sums totals defensively", () => {
    expect(
      parseIncomingMessagesTotal({
        value: [{ timeseries: [{ data: [{ total: 10 }, { total: 5 }, {}] }] }],
      }),
    ).toBe(15);
    expect(parseIncomingMessagesTotal({})).toBe(0);
    expect(parseIncomingMessagesTotal("junk")).toBe(0);
  });

  it("checkEventHubActivity marks active/inactive and surfaces per-hub failures", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      { status: 200, body: { value: [{ timeseries: [{ data: [{ total: 42 }] }] }] } },
      { status: 403, body: {} },
    );
    const hubs = [
      { name: "hub-a", namespace: "ns-1", partitionCount: 1, messageRetentionInDays: 1, status: "Active", resourceId: "/x/a" },
      { name: "hub-b", namespace: "ns-1", partitionCount: 1, messageRetentionInDays: 1, status: "Active", resourceId: "/x/b" },
    ];
    const result = await checkEventHubActivity(azure, hubs, "start/end");
    expect(result.activityByHub.get("ns-1/hub-a")).toMatchObject({
      incomingMessages: 42,
      isActive: true,
    });
    expect(result.activityByHub.get("ns-1/hub-b")).toMatchObject({
      isActive: false,
      error: "HTTP 403",
    });
  });
});

describe("unknown-sender inference (EVH-08, legacy thresholds)", () => {
  const active: HubActivity = { incomingMessages: 500, isActive: true };
  const idle: HubActivity = { incomingMessages: 0, isActive: false };

  it("flags an active hub with zero configured sources", () => {
    const findings = analyzeHubFindings(0, active);
    expect(findings.hasUnknownSenders).toBe(true);
    expect(findings.notes[0]).toContain("NO configured sources");
  });

  it("notes an inactive hub with configured sources", () => {
    const findings = analyzeHubFindings(2, idle);
    expect(findings.hasUnknownSenders).toBe(false);
    expect(findings.notes[0]).toContain("INACTIVE but has 2 configured source(s)");
  });

  it("notes high volume relative to configured sources (>100k per source)", () => {
    const atThreshold: HubActivity = { incomingMessages: 200000, isActive: true };
    expect(analyzeHubFindings(2, atThreshold).notes).toEqual([]);
    const flooded: HubActivity = { incomingMessages: 200001, isActive: true };
    expect(analyzeHubFindings(2, flooded).notes[0]).toContain("High message volume");
  });

  it("yields nothing without activity data", () => {
    expect(analyzeHubFindings(0, undefined)).toEqual({
      hasUnknownSenders: false,
      notes: [],
    });
  });

  it("rolls up the legacy statistics", () => {
    const activity = new Map<string, HubActivity>([
      ["a", active],
      ["b", idle],
      ["c", active],
    ]);
    const findings = new Map([
      ["a", analyzeHubFindings(0, active)],
      ["b", analyzeHubFindings(1, idle)],
      ["c", analyzeHubFindings(3, active)],
    ]);
    expect(deriveEhStatistics(activity, findings)).toEqual({
      activeEventHubs: 2,
      inactiveEventHubs: 1,
      eventHubsWithUnknownSenders: 1,
    });
  });
});

describe("consumer-group + auth-rule enumeration (EVH-06)", () => {
  it("builds the two per-hub ARM GETs", () => {
    expect(listConsumerGroupsRequest("/x/hub").path).toBe("/x/hub/consumergroups");
    expect(listAuthRulesRequest("/x/hub").path).toBe("/x/hub/authorizationRules");
  });

  it("parses consumer groups and auth rules defensively", () => {
    expect(
      parseConsumerGroupsResponse({ value: [{ name: "$Default" }, { name: "cribl" }, {}] }),
    ).toEqual(["$Default", "cribl"]);
    expect(parseConsumerGroupsResponse("junk")).toEqual([]);
    expect(
      parseAuthRulesResponse({
        value: [
          { name: "RootManageSharedAccessKey", properties: { rights: ["Listen", "Manage", "Send"] } },
          { name: "app-sender", properties: { rights: ["Send"] } },
          { properties: {} },
        ],
      }),
    ).toEqual([
      { name: "RootManageSharedAccessKey", rights: ["Listen", "Manage", "Send"] },
      { name: "app-sender", rights: ["Send"] },
    ]);
  });

  it("infers consumers from non-$Default groups and senders from Send rules (legacy hints)", () => {
    const inferred = inferSendersFromEnumeration({
      consumerGroups: ["$Default", "cribl-workers"],
      authRules: [
        { name: "RootManageSharedAccessKey", rights: ["Listen", "Manage", "Send"] },
        { name: "app-sender", rights: ["Send"] },
        { name: "listen-only", rights: ["Listen"] },
      ],
    });
    expect(inferred).toHaveLength(2);
    expect(inferred[0]).toMatchObject({
      inferredFrom: "ConsumerGroup",
      name: "cribl-workers",
      confidence: "Hint",
    });
    expect(inferred[1]).toMatchObject({
      inferredFrom: "AuthorizationRule",
      name: "app-sender",
      rights: ["Send"],
    });
  });

  it("enumerateEventHubDetails collects per hub and soft-fails a broken hub", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      // hub-a: groups + rules.
      { status: 200, body: { value: [{ name: "$Default" }, { name: "cribl" }] } },
      { status: 200, body: { value: [{ name: "app-sender", properties: { rights: ["Send"] } }] } },
      // hub-b: groups denied.
      { status: 403, body: {} },
      { status: 200, body: { value: [] } },
    );
    const hubs = [
      { name: "hub-a", namespace: "ns-1", partitionCount: 1, messageRetentionInDays: 1, status: "Active", resourceId: "/x/a" },
      { name: "hub-b", namespace: "ns-1", partitionCount: 1, messageRetentionInDays: 1, status: "Active", resourceId: "/x/b" },
    ];
    const result = await enumerateEventHubDetails(azure, hubs);
    expect(result.enumerationByHub.get("ns-1/hub-a")).toEqual({
      consumerGroups: ["$Default", "cribl"],
      authRules: [{ name: "app-sender", rights: ["Send"] }],
    });
    expect(result.enumerationByHub.has("ns-1/hub-b")).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("hub-b");
  });
});
