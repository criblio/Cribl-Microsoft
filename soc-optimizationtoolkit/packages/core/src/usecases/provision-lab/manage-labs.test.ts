import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import { destroyLab, extendLabTtl, listLabs } from "./manage-labs";
import { finalizeFlowLogPack } from "./deploy-flowlog-pack";

const SUB = "11111111-2222-3333-4444-555555555555";
const NOW = "2026-07-17T12:00:00.000Z";

describe("listLabs", () => {
  it("filters the resource-group list down to lab-tagged groups", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({
      status: 200,
      body: {
        value: [
          {
            name: "rg-lab-SentinelLab",
            location: "eastus",
            tags: {
              ManagedBy: "SOC-OptimizationToolkit",
              TTL_Enabled: "true",
              TTL_ExpirationTime: "2026-07-19T12:00:00Z",
            },
          },
          { name: "rg-unrelated", location: "eastus", tags: {} },
        ],
      },
    });
    const labs = await listLabs(azure, { subscriptionId: SUB, nowIso: NOW });
    expect(labs).toHaveLength(1);
    expect(labs[0].name).toBe("rg-lab-SentinelLab");
    expect(labs[0].remainingHours).toBeCloseTo(48, 5);
  });

  it("throws on a failed list (inventory unavailable, never silently empty)", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: { error: { code: "Denied" } } });
    await expect(listLabs(azure, { subscriptionId: SUB, nowIso: NOW })).rejects.toThrow();
  });
});

describe("extendLabTtl", () => {
  it("re-stamps the TTL tags over the existing tag set", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith(
      {
        status: 200,
        body: { tags: { Owner: "team-x", TTL_UserEmail: "old@example.com" } },
      },
      { status: 200, body: {} },
    );
    const outcome = await extendLabTtl(azure, {
      subscriptionId: SUB,
      resourceGroupName: "rg-lab-x",
      ttl: { hours: 48, warningHours: 12, userEmail: "" },
      nowIso: NOW,
    });
    expect(outcome.expiresAt).toBe("2026-07-19T12:00:00Z");
    const patch = azure.calls[1];
    expect(patch.method).toBe("PATCH");
    const tags = (patch.body as { tags: Record<string, string> }).tags;
    expect(tags["Owner"]).toBe("team-x"); // preserved
    expect(tags["TTL_ExpirationTime"]).toBe("2026-07-19T12:00:00Z");
    // Empty caller email keeps the recorded recipient.
    expect(tags["TTL_UserEmail"]).toBe("old@example.com");
  });
});

describe("destroyLab", () => {
  it("reports ACCEPTED on the async 202", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 202, body: {} });
    const outcome = await destroyLab(azure, {
      subscriptionId: SUB,
      resourceGroupName: "rg-lab-x",
    });
    expect(outcome.accepted).toBe(true);
    expect(azure.calls[0].method).toBe("DELETE");
  });

  it("throws on rejection", async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 403, body: { error: { code: "Denied" } } });
    await expect(
      destroyLab(azure, { subscriptionId: SUB, resourceGroupName: "rg-lab-x" }),
    ).rejects.toThrow("destroy lab");
  });
});

describe("finalizeFlowLogPack", () => {
  it("creates the secret, commits, and deploys", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 200, body: {} }, // POST secret
      { status: 200, body: { items: [{ commit: "abc123" }] } }, // commit
      { status: 200, body: {} }, // deploy
    );
    const outcome = await finalizeFlowLogPack(cribl, {
      groupId: "default",
      clientSecret: "transient-secret",
    });
    expect(outcome.secret).toBe("created");
    expect(outcome.commitVersion).toBe("abc123");
    expect(outcome.deployed).toBe(true);
    expect(cribl.calls[0].path).toBe("/system/secrets");
    expect(cribl.calls[2].path).toBe("/master/groups/default/deploy");
  });

  it("falls back to PATCH when the secret already exists", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith(
      { status: 409, body: {} }, // POST conflict
      { status: 200, body: {} }, // PATCH
      { status: 200, body: { items: [{ commit: "abc123" }] } },
      { status: 200, body: {} },
    );
    const outcome = await finalizeFlowLogPack(cribl, {
      groupId: "default",
      clientSecret: "transient-secret",
    });
    expect(outcome.secret).toBe("updated");
  });

  it("skips the secret without a value and reports commit errors nonfatally", async () => {
    const cribl = new FakeCriblClient();
    cribl.respondWith({ status: 400, body: { message: "single-instance" } });
    const outcome = await finalizeFlowLogPack(cribl, { groupId: "default" });
    expect(outcome.secret).toBe("skipped");
    expect(outcome.deployed).toBe(false);
    expect(outcome.commitError).toContain("HTTP 400");
  });
});
