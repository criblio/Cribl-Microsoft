import { describe, expect, it } from "vitest";
import * as arm from "./index";
import * as labs from "../labs";
import * as discovery from "../eventhub-discovery";
import {
  DEFAULT_NAMESPACE_RULE,
  EVENTHUB_ARM_API_VERSION,
  buildNamespaceAuthRulesListRequest,
  buildNamespaceListKeysRequest,
  eventHubResourceId,
  parseEventHubResourceId,
  parseListKeys,
  parseNamespaceAuthRules,
  parseNamespaceResourceId,
  ruleCanSend,
} from "./index";
import type { NamespaceRef } from "./index";
import { LAB_EVENTHUB_ARM_API_VERSION } from "../labs";
import { EVENTHUB_API_VERSION, listEventHubsRequest } from "../eventhub-discovery";

const NS: NamespaceRef = {
  subscriptionId: "sub-1",
  resourceGroup: "rg-cribl-logging",
  name: "cribl-diag-a64acbf7",
};
const NS_ID =
  "/subscriptions/sub-1/resourceGroups/rg-cribl-logging" +
  "/providers/Microsoft.EventHub/namespaces/cribl-diag-a64acbf7";

describe("eventhub-arm: one api-version", () => {
  it("labs and discovery alias the shared constant", () => {
    expect(EVENTHUB_ARM_API_VERSION).toBe("2021-11-01");
    expect(LAB_EVENTHUB_ARM_API_VERSION === EVENTHUB_ARM_API_VERSION).toBe(true);
    expect(EVENTHUB_API_VERSION === EVENTHUB_ARM_API_VERSION).toBe(true);
  });
});

describe("eventhub-arm: listEventHubsRequest on a NamespaceRef", () => {
  it("accepts the three-field ref without a cast and builds the pre-AZR-12 path", () => {
    // A plain object literal with ONLY the three fields: tsc rejects this call
    // if the parameter type ever goes back to EventHubNamespaceInfo.
    const req = listEventHubsRequest({
      subscriptionId: "sub-1",
      resourceGroup: "rg-cribl-logging",
      name: "cribl-diag-a64acbf7",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe(`${NS_ID}/eventhubs`);
    expect(req.apiVersion).toBe("2021-11-01");
  });
});

describe("eventhub-arm: the lab wrappers build the pre-AZR-12 requests", () => {
  // The literal paths the lab builders produced before the lift. Distinct
  // subscription / resource group / namespace values, so a wrapper that swaps
  // two positional arguments fails here (lab-analytics.test.ts does not pin
  // every one of these).
  const hub = `${NS_ID}/eventhubs/hub-a`;
  it("namespace, hub and consumer-group GET/PUT keep path, method and body", () => {
    const s = NS.subscriptionId;
    const r = NS.resourceGroup;
    const n = NS.name;
    expect(labs.buildEventHubNamespaceGetRequest(s, r, n)).toEqual({
      method: "GET",
      path: NS_ID,
      apiVersion: "2021-11-01",
    });
    expect(
      labs.buildEventHubNamespacePutRequest(s, r, n, "eastus", { sku: "Standard", capacity: 1 }),
    ).toEqual({
      method: "PUT",
      path: NS_ID,
      apiVersion: "2021-11-01",
      body: {
        location: "eastus",
        sku: { name: "Standard", tier: "Standard", capacity: 1 },
        properties: {},
      },
    });
    expect(labs.buildEventHubGetRequest(s, r, n, "hub-a")).toEqual({
      method: "GET",
      path: hub,
      apiVersion: "2021-11-01",
    });
    expect(labs.buildEventHubPutRequest(s, r, n, "hub-a", 4, 7)).toEqual({
      method: "PUT",
      path: hub,
      apiVersion: "2021-11-01",
      body: { properties: { partitionCount: 4, messageRetentionInDays: 7 } },
    });
    expect(labs.buildConsumerGroupGetRequest(s, r, n, "hub-a", "cribl")).toEqual({
      method: "GET",
      path: `${hub}/consumergroups/cribl`,
      apiVersion: "2021-11-01",
    });
    expect(labs.buildConsumerGroupPutRequest(s, r, n, "hub-a", "cribl")).toEqual({
      method: "PUT",
      path: `${hub}/consumergroups/cribl`,
      apiVersion: "2021-11-01",
      body: { properties: {} },
    });
  });
});

describe("eventhub-arm: namespace authorization rules", () => {
  it("lists rules on the namespace, not a hub", () => {
    const req = buildNamespaceAuthRulesListRequest(NS);
    expect(req.method).toBe("GET");
    expect(req.path).toBe(`${NS_ID}/authorizationRules`);
    expect(req.apiVersion).toBe(EVENTHUB_ARM_API_VERSION);
  });

  it("a 200 with an empty rule list is 'empty', never a measured zero", () => {
    expect(parseNamespaceAuthRules({ value: [] })).toEqual({ kind: "empty" });
    expect(parseNamespaceAuthRules({})).toEqual({ kind: "empty" });
    expect(parseNamespaceAuthRules("garbage")).toEqual({ kind: "empty" });
  });

  it("parses name, id and rights, dropping nameless items", () => {
    const listing = parseNamespaceAuthRules({
      value: [
        {
          id: `${NS_ID}/authorizationRules/RootManageSharedAccessKey`,
          name: "RootManageSharedAccessKey",
          properties: { rights: ["Listen", "Manage", "Send"] },
        },
        { name: "listen-only", properties: { rights: ["Listen", 7] } },
        { properties: { rights: ["Send"] } },
        "garbage",
      ],
    });
    expect(listing.kind).toBe("rows");
    if (listing.kind !== "rows") return;
    expect(listing.rows).toHaveLength(2);
    expect(listing.rows[0]).toEqual({
      name: "RootManageSharedAccessKey",
      id: `${NS_ID}/authorizationRules/RootManageSharedAccessKey`,
      rights: ["Listen", "Manage", "Send"],
    });
    expect(listing.rows[1]).toEqual({ name: "listen-only", id: "", rights: ["Listen"] });
  });

  it("ruleCanSend rejects a Listen-only rule and accepts Send or Manage", () => {
    expect(ruleCanSend(["Listen"])).toBe(false);
    expect(ruleCanSend([])).toBe(false);
    expect(ruleCanSend(["Send"])).toBe(true);
    expect(ruleCanSend(["Manage", "Listen", "Send"])).toBe(true);
    expect(ruleCanSend(["Manage"])).toBe(true);
    // Rights are compared case-insensitively; a hand-typed or re-cased right
    // must not hide a usable rule.
    expect(ruleCanSend(["send"])).toBe(true);
    expect(ruleCanSend(["MANAGE"])).toBe(true);
    expect(ruleCanSend(["LISTEN"])).toBe(false);
  });

  it("names the Azure default rule without making it a selection", () => {
    expect(DEFAULT_NAMESPACE_RULE).toBe("RootManageSharedAccessKey");
  });
});

describe("eventhub-arm: listKeys", () => {
  it("POSTs listKeys on the NAMESPACE rule, never a hub rule", () => {
    const req = buildNamespaceListKeysRequest(NS, "cribl-send");
    expect(req.method).toBe("POST");
    expect(req.path).toBe(`${NS_ID}/authorizationRules/cribl-send/listKeys`);
    expect(req.path).toContain(`/namespaces/${NS.name}/authorizationRules/`);
    expect(req.path).not.toContain("/eventhubs/");
    expect(req.apiVersion).toBe(EVENTHUB_ARM_API_VERSION);
  });

  it("returns the primary connection string", () => {
    const cs =
      "Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=r;SharedAccessKey=abc";
    expect(parseListKeys({ primaryConnectionString: cs, keyName: "r" })).toBe(cs);
  });

  it("throws without echoing the body when the connection string is missing", () => {
    const body = {
      keyName: "r",
      primaryKey: "SECRETKEYVALUE",
      secondaryConnectionString:
        "Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=r;SharedAccessKey=SECRETKEYVALUE",
    };
    let message = "";
    try {
      parseListKeys(body);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("SharedAccessKey");
    expect(message).not.toContain("SECRETKEYVALUE");
    expect(() => parseListKeys({ primaryConnectionString: "" })).toThrow();
    expect(() => parseListKeys(null)).toThrow();
  });
});

describe("eventhub-arm: resource ids", () => {
  it("builds the HUB id under the namespace", () => {
    expect(eventHubResourceId(NS, "defender-alerts")).toBe(
      `${NS_ID}/eventhubs/defender-alerts`,
    );
  });

  it("parses a namespace id, case-insensitive on keys, verbatim on values", () => {
    expect(parseNamespaceResourceId(NS_ID)).toEqual(NS);
    expect(
      parseNamespaceResourceId(
        " /subscriptions/sub-1/resourcegroups/RG-X/providers/microsoft.eventhub/Namespaces/Ns-1/ ",
      ),
    ).toEqual({ subscriptionId: "sub-1", resourceGroup: "RG-X", name: "Ns-1" });
  });

  it("returns null for a hub id and for non-namespace ids", () => {
    expect(parseNamespaceResourceId(`${NS_ID}/eventhubs/hub-a`)).toBeNull();
    expect(
      parseNamespaceResourceId(
        "/subscriptions/s/resourceGroups/r/providers/Microsoft.Storage/storageAccounts/a",
      ),
    ).toBeNull();
    // Same /namespaces/ shape, wrong provider: only the provider check stops a
    // Service Bus or Relay namespace from parsing as an Event Hub namespace.
    expect(
      parseNamespaceResourceId(
        "/subscriptions/s/resourceGroups/r/providers/Microsoft.ServiceBus/namespaces/x",
      ),
    ).toBeNull();
    expect(
      parseNamespaceResourceId("/subscriptions/s/resourceGroups/r/providers/Microsoft.Relay/namespaces/x"),
    ).toBeNull();
    expect(parseNamespaceResourceId("")).toBeNull();
  });

  it("parses a hub id and round-trips eventHubResourceId", () => {
    const id = eventHubResourceId(NS, "hub-a");
    expect(parseEventHubResourceId(id)).toEqual({ namespace: NS, hubName: "hub-a" });
    expect(parseEventHubResourceId(NS_ID)).toBeNull();
    expect(parseEventHubResourceId(`${NS_ID}/authorizationRules/r`)).toBeNull();
    expect(parseEventHubResourceId(`${id}/consumergroups/cg`)).toBeNull();
    expect(
      parseEventHubResourceId(
        "/subscriptions/s/resourceGroups/r/providers/Microsoft.ServiceBus/namespaces/x/eventhubs/h",
      ),
    ).toBeNull();
  });
});

describe("eventhub-arm: barrel names do not collide", () => {
  it("exports no runtime name that labs or eventhub-discovery also export", () => {
    // The core barrel re-exports all three with `export *`; a shared name would
    // be an ambiguity. Type-only names are covered by tsc on the core barrel.
    const armNames = Object.keys(arm);
    expect(armNames.length).toBeGreaterThan(10);
    const others = new Set([...Object.keys(labs), ...Object.keys(discovery)]);
    expect(armNames.filter((n) => others.has(n))).toEqual([]);
  });
});
