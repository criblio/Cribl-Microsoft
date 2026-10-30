/**
 * eventhub-target pins (AZR-11 on the AZR-18 onboarding screen). Each read is
 * exactly one GET and never a write, a 403 is a `denied` failure rather than
 * an empty picker, a 2xx with no items is the unverified `empty`, and every
 * rule carries the same canSend verdict ruleCanSend gives. A page that comes
 * back with a nextLink is reported as truncated, never as the whole list.
 */

import { describe, expect, it } from "vitest";

import type { AzureManagement } from "../../ports/azure-management";
import { ruleCanSend } from "../../domain/eventhub-arm/eventhub-arm";
import type { NamespaceRef } from "../../domain/eventhub-arm/eventhub-arm";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { listNamespaceAuthRules, listNamespaceHubs } from "./eventhub-target";

const NS: NamespaceRef = {
  subscriptionId: "sub-1",
  resourceGroup: "rg-logging",
  name: "ns-a",
};
const NS_PATH =
  "/subscriptions/sub-1/resourceGroups/rg-logging/providers/Microsoft.EventHub/namespaces/ns-a";

function hubItem(name: string): Record<string, unknown> {
  return {
    name,
    id: `${NS_PATH}/eventhubs/${name}`,
    properties: { partitionCount: 4, messageRetentionInDays: 1, status: "Active" },
  };
}

function ruleItem(name: string, rights: string[]): Record<string, unknown> {
  return { name, id: `${NS_PATH}/authorizationRules/${name}`, properties: { rights } };
}

const READS = [
  { label: "listNamespaceHubs", run: listNamespaceHubs, path: `${NS_PATH}/eventhubs` },
  {
    label: "listNamespaceAuthRules",
    run: listNamespaceAuthRules,
    path: `${NS_PATH}/authorizationRules`,
  },
] as const;

describe.each(READS)("$label", ({ run, path }) => {
  it("issues exactly one GET on the namespace path and no other verb", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { value: [] } });
    await run(azure, NS);
    expect(azure.calls).toHaveLength(1);
    expect(azure.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(azure.calls[0].path).toBe(path);
    expect(azure.calls[0].apiVersion).toBe("2021-11-01");
    expect(azure.urlCalls).toHaveLength(0);
  });

  it("classifies a 403 as a denied failure, not an empty listing", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 403,
      body: { error: { code: "AuthorizationFailed", message: "nope" } },
    });
    const read = await run(azure, NS);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("unreachable");
    expect(read.failure.kind).toBe("denied");
    expect(read.failure.status).toBe(403);
    expect(read.failure.message).toContain("AuthorizationFailed");
    expect(read.failure.message).toContain("ns-a");
  });

  it("classifies a 404 as failed with its status, not denied", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 404, body: { error: { code: "NotFound" } } });
    const read = await run(azure, NS);
    if (read.ok) throw new Error("expected a failure");
    expect(read.failure).toMatchObject({ kind: "failed", status: 404 });
  });

  it("resolves (never rejects) when the transport throws", async () => {
    const azure: AzureManagement = {
      request: () => Promise.reject(new Error("socket hang up")),
    };
    const read = await run(azure, NS);
    if (read.ok) throw new Error("expected a failure");
    expect(read.failure.kind).toBe("failed");
    expect(read.failure.status).toBeNull();
    expect(read.failure.message).toContain("socket hang up");
  });

  it("gives the unverified 'empty' for a 200 with [] (never 'none')", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { value: [] } });
    const read = await run(azure, NS);
    if (!read.ok) throw new Error("expected a listing");
    expect(read.listing.kind).toBe("empty");
  });

  it("reports a page with a nextLink as truncated, not as the whole list", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [hubItem("defender"), ruleItem("send", ["Send"])],
        nextLink: `https://management.azure.com${path}?$skiptoken=abc`,
      },
    });
    const read = await run(azure, NS);
    if (!read.ok) throw new Error("expected a listing");
    expect(read.truncated).toBe(true);
    // Still one GET: the flag reports the later page, it does not fetch it.
    expect(azure.calls).toHaveLength(1);
    expect(azure.urlCalls).toHaveLength(0);
  });

  it("reports a page without a nextLink (or with an empty one) as complete", async () => {
    for (const extra of [{}, { nextLink: "" }, { nextLink: null }]) {
      const azure = new FakeAzureManagement();
      azure.respondWith({ status: 200, body: { value: [], ...extra } });
      const read = await run(azure, NS);
      if (!read.ok) throw new Error("expected a listing");
      expect(read.truncated).toBe(false);
    }
  });

  it("never echoes the response body into a failure message", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 500,
      body: { error: { code: "InternalError", message: "SharedAccessKey=leak" } },
    });
    const read = await run(azure, NS);
    if (read.ok) throw new Error("expected a failure");
    expect(read.failure.message).not.toContain("SharedAccessKey");
    expect(read.failure.message).toContain("InternalError");
  });
});

describe("listNamespaceHubs rows", () => {
  it("parses each hub with its namespace and hub resource id", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: { value: [hubItem("defender"), { properties: {} }, hubItem("entra")] },
    });
    const read = await listNamespaceHubs(azure, NS);
    if (!read.ok || read.listing.kind !== "rows") throw new Error("expected rows");
    expect(read.listing.rows.map((h) => h.name)).toEqual(["defender", "entra"]);
    expect(read.listing.rows[0].namespace).toBe("ns-a");
    expect(read.listing.rows[0].resourceId).toBe(`${NS_PATH}/eventhubs/defender`);
  });
});

describe("listNamespaceAuthRules canSend", () => {
  it("carries canSend matching ruleCanSend on every rule, Listen-only included", async () => {
    const rights: string[][] = [
      ["Listen"],
      ["Send"],
      ["Manage", "Listen", "Send"],
      ["Listen", "Send"],
    ];
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [
          ruleItem("listen-only", rights[0]),
          ruleItem("send-only", rights[1]),
          ruleItem("RootManageSharedAccessKey", rights[2]),
          ruleItem("both", rights[3]),
        ],
      },
    });
    const read = await listNamespaceAuthRules(azure, NS);
    if (!read.ok || read.listing.kind !== "rows") throw new Error("expected rows");
    const rules = read.listing.rows;
    expect(rules.map((r) => r.name)).toEqual([
      "listen-only",
      "send-only",
      "RootManageSharedAccessKey",
      "both",
    ]);
    expect(rules.map((r) => r.canSend)).toEqual(rights.map((r) => ruleCanSend(r)));
    // Stated literally too, so a ruleCanSend that regressed to "always true"
    // cannot make this pin agree with itself.
    expect(rules.map((r) => r.canSend)).toEqual([false, true, true, true]);
    expect(rules[1].id).toBe(`${NS_PATH}/authorizationRules/send-only`);
    expect(rules[1].rights).toEqual(["Send"]);
  });
});
