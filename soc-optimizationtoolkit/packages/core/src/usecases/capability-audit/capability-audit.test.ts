/**
 * Tests for the capability audit orchestration.
 *
 * The lifecycle rules themselves are pinned in domain/capabilities; these pin
 * the ORCHESTRATION on top of them:
 *   - a launch with a matching cached set issues ZERO requests (the conservation
 *     decision, and the only way to observe it is by counting calls);
 *   - a cached set for another connection is never returned to the caller;
 *   - cache failures degrade toward MEASURING, never toward a false cache hit;
 *   - the audit never throws, whatever the ports do.
 */
import { describe, expect, it } from "vitest";

import {
  SUBSCRIPTION_AUDIT_ACTIONS,
  graphPermissionVerdicts,
  loadCachedCapabilities,
  runCapabilityAudit,
} from "./capability-audit";
import type { GraphDirectory, GraphPermissionProbe, GraphProbeResponse } from "../../ports/graph-directory";
import type { CapabilityAuditInput, CapabilityAuditPorts } from "./capability-audit";
import {
  CAPABILITY_AUDIT_CACHE_KEY,
  capabilityAuditCacheKey,
  capabilityAuditKey,
  emptyCapabilitySet,
  serializeCapabilitySet,
} from "../../domain/capabilities";
import type { CapabilitySet } from "../../domain/capabilities";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeContentCache } from "../../testing/fake-sentinel-content";
import { FakeCriblClient } from "../../testing/fake-cribl-client";
import type { ContentCache } from "../../ports/sentinel-content";
import type { PermissionSet } from "../../domain/azure-permissions";
import type { PortHttpResponse } from "../../ports/http";

const SUB = "11111111-1111-1111-1111-111111111111";
const RG = "rg-sentinel";
const WS = "law-sentinel";
const NOW = "2026-08-06T12:00:00Z";

function permSet(partial: Partial<PermissionSet>): PermissionSet {
  return {
    actions: [],
    notActions: [],
    dataActions: [],
    notDataActions: [],
    ...partial,
  };
}
const OWNER = permSet({ actions: ["*"] });
const OK: PortHttpResponse = { status: 200, body: {} };
function permsResponse(...sets: PermissionSet[]): PortHttpResponse {
  return { status: 200, body: { value: sets } };
}

const INPUT: CapabilityAuditInput = {
  trigger: "launch",
  setupPath: "existing-rg",
  azure: { subscriptionId: SUB, resourceGroup: RG, workspaceName: WS },
  identity: { tenantId: "tenant-a", clientId: "client-a" },
  cribl: { mode: "cloud" },
  nowIso: NOW,
};

const KEY = capabilityAuditKey({
  tenantId: "tenant-a",
  clientId: "client-a",
  subscriptionId: SUB,
  resourceGroup: RG,
  workspaceName: WS,
  setupPath: "existing-rg",
  criblWorkerGroup: "",
});

/** Ports with an Owner-grade Azure and the cloud Cribl (which issues no calls). */
function ownerPorts(cache?: ContentCache): CapabilityAuditPorts {
  const azure = new FakeAzureManagement();
  azure.respondWith(permsResponse(OWNER), OK, OK, OK);
  return { azure, cribl: new FakeCriblClient(), ...(cache !== undefined ? { cache } : {}) };
}

/** Seed a cache with a set already measured against `connectionId`. */
async function seeded(connectionId: string, auditedAt = NOW): Promise<FakeContentCache> {
  const cache = new FakeContentCache();
  const set: CapabilitySet = {
    verdicts: { "dcr.write": "granted" },
    auditedAt,
    connectionId,
  };
  await cache.set(CAPABILITY_AUDIT_CACHE_KEY, serializeCapabilitySet(set));
  return cache;
}

// ---------------------------------------------------------------------------
// The conservation decision
// ---------------------------------------------------------------------------

describe("launch with a matching cached audit", () => {
  it("issues ZERO requests", async () => {
    // The whole point of the decision: the audit costs real requests against a
    // shared budget, and only a call count can prove it was skipped.
    const cache = await seeded(KEY);
    const ports = ownerPorts(cache);
    const result = await runCapabilityAudit(ports, INPUT);

    expect((ports.azure as FakeAzureManagement).calls).toHaveLength(0);
    expect(result.decision.run).toBe(false);
    expect(result.report).toBeNull();
    expect(result.set.verdicts["dcr.write"]).toBe("granted");
    expect(result.set.auditedAt).toBe(NOW);
  });

  it("audits when the cache is empty", async () => {
    const ports = ownerPorts(new FakeContentCache());
    const result = await runCapabilityAudit(ports, INPUT);

    expect(result.decision.run).toBe(true);
    expect(result.report).not.toBeNull();
    expect((ports.azure as FakeAzureManagement).calls.length).toBeGreaterThan(0);
  });

  it("audits with no cache bound at all", async () => {
    const ports = ownerPorts();
    const result = await runCapabilityAudit(ports, INPUT);
    expect(result.decision.run).toBe(true);
    expect(result.set.verdicts["dcr.write"]).toBe("granted");
  });

  it("re-audits on manual refresh despite a matching cache", async () => {
    const ports = ownerPorts(await seeded(KEY));
    const result = await runCapabilityAudit(ports, { ...INPUT, trigger: "manual" });
    expect(result.decision.run).toBe(true);
    expect((ports.azure as FakeAzureManagement).calls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Another connection's verdicts never reach the caller
// ---------------------------------------------------------------------------

describe("a cached audit for another connection", () => {
  it("is re-audited rather than reused", async () => {
    const ports = ownerPorts(await seeded("some-other-connection"));
    const result = await runCapabilityAudit(ports, INPUT);

    expect(result.decision.run).toBe(true);
    expect(result.set.connectionId).toBe(KEY);
  });

  it("never surfaces its verdicts even when the re-audit measures nothing", async () => {
    // Azure unconfigured, so the fresh audit records no Azure verdict at all.
    // The stale 'dcr.write: granted' from the other connection must not show
    // through - being confidently wrong about permissions is the worst failure
    // this model can have.
    const cache = await seeded("some-other-connection");
    const azure = new FakeAzureManagement();
    const result = await runCapabilityAudit(
      { azure, cribl: new FakeCriblClient(), cache },
      {
        ...INPUT,
        azure: { subscriptionId: "", resourceGroup: "", workspaceName: "" },
        cribl: { mode: "local" },
      },
    );

    expect(result.set.verdicts["dcr.write"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("persistence", () => {
  it("stores the audit so the next launch can skip it", async () => {
    const cache = new FakeContentCache();
    const first = ownerPorts(cache);
    await runCapabilityAudit(first, INPUT);

    const second = ownerPorts(cache);
    const result = await runCapabilityAudit(second, INPUT);
    expect(result.decision.run).toBe(false);
    expect((second.azure as FakeAzureManagement).calls).toHaveLength(0);
  });

  it("stamps the caller's clock reading and connection onto the stored set", async () => {
    const cache = new FakeContentCache();
    await runCapabilityAudit(ownerPorts(cache), INPUT);

    const stored = await loadCachedCapabilities(cache, "tenant-a");
    expect(stored.auditedAt).toBe(NOW);
    expect(stored.connectionId).toBe(KEY);
  });

  it("stores and restores the Defender verdicts an existing-subscription audit measured", async () => {
    // CAP-7a. The cached set is decoded against the capability taxonomy, which
    // DROPS names it does not know - so a capability missing from the taxonomy
    // would be measured, saved, and silently lost on the next launch.
    const cache = new FakeContentCache();
    const azure = new FakeAzureManagement();
    // RE-PINNED 2026-10-27 (review): Reader-like '*/read' became Security
    // Admin's Microsoft.Security/*, because a subscription-scope miss on the
    // automations write is no longer recorded (it may be granted on the group
    // the export is written to), so only a grant can round-trip for it.
    azure.respondWith(permsResponse(permSet({ actions: ["Microsoft.Security/*"] })), OK, OK);
    const subInput: CapabilityAuditInput = { ...INPUT, setupPath: "existing-subscription" };
    const first = await runCapabilityAudit({ azure, cribl: new FakeCriblClient(), cache }, subInput);
    expect(first.set.verdicts["defender-automation.write"]).toBe("granted");

    const stored = await loadCachedCapabilities(cache, "tenant-a");
    expect(stored.verdicts["defender-plans.read"]).toBe("granted");
    expect(stored.verdicts["defender-automation.read"]).toBe("granted");
    expect(stored.verdicts["defender-automation.write"]).toBe("granted");
  });

  describe("the existing path's audit measures Defender at the subscription (AZR-86)", () => {
    const SUB_PERMISSIONS = `/subscriptions/${SUB}/providers/Microsoft.Authorization/permissions`;

    it("reads the subscription once and records the Defender verdicts", async () => {
      const azure = new FakeAzureManagement();
      // Group perms (Owner grants tables/write, so no workspace read), five
      // probes (the fifth is the Sentinel incidents list, CAP-4), then the
      // subscription perms holding Security Admin's actions.
      azure.respondWith(
        permsResponse(OWNER),
        OK,
        OK,
        OK,
        OK,
        OK,
        permsResponse(permSet({ actions: ["Microsoft.Security/*"] })),
      );
      const result = await runCapabilityAudit({ azure, cribl: new FakeCriblClient() }, INPUT);
      expect(azure.calls).toHaveLength(7);
      expect(azure.calls[6]?.method).toBe("GET");
      expect(azure.calls[6]?.path).toBe(SUB_PERMISSIONS);
      expect(result.set.verdicts["defender-plans.read"]).toBe("granted");
      expect(result.set.verdicts["defender-automation.read"]).toBe("granted");
      expect(result.set.verdicts["defender-automation.write"]).toBe("granted");
      // The group's own verdicts are untouched.
      expect(result.set.verdicts["dcr.write"]).toBe("granted");
    });

    it("records a subscription miss as denied, except the grant-only export write", async () => {
      const azure = new FakeAzureManagement();
      azure.respondWith(
        permsResponse(OWNER),
        OK,
        OK,
        OK,
        OK,
        OK,
        permsResponse(permSet({ actions: ["Microsoft.Insights/*"] })),
      );
      const result = await runCapabilityAudit({ azure, cribl: new FakeCriblClient() }, INPUT);
      // The two reads are the subscription's own, so a miss is a denial; the
      // write is not measured there, because the export may be granted on
      // the resource group it is written to.
      expect(result.set.verdicts["defender-plans.read"]).toBe("denied");
      expect(result.set.verdicts["defender-automation.read"]).toBe("denied");
      expect(result.set.verdicts["defender-automation.write"]).toBeUndefined();
      // CAP-2 / CAP-3, from the same read: the policy writes are measured at
      // the subscription (and above it), the identity write is grant-only.
      expect(result.set.verdicts["policy.assign"]).toBe("denied");
      expect(result.set.verdicts["policy.remediate"]).toBe("denied");
      expect(result.set.verdicts["identity.create"]).toBeUndefined();
    });

    it("measures the capability enablers in that same single read (CAP-2, CAP-3)", async () => {
      const azure = new FakeAzureManagement();
      // Resource Policy Contributor's actions plus Managed Identity
      // Contributor's identity write, at the subscription.
      azure.respondWith(
        permsResponse(OWNER),
        OK,
        OK,
        OK,
        OK,
        OK,
        permsResponse(
          permSet({
            actions: [
              "Microsoft.Authorization/policyassignments/*",
              "Microsoft.PolicyInsights/*",
              "Microsoft.ManagedIdentity/userAssignedIdentities/*",
            ],
          }),
        ),
      );
      const result = await runCapabilityAudit({ azure, cribl: new FakeCriblClient() }, INPUT);
      expect(azure.calls.filter((c) => c.path === SUB_PERMISSIONS)).toHaveLength(1);
      expect(SUBSCRIPTION_AUDIT_ACTIONS.map((a) => a.action)).toEqual([
        "Microsoft.Security/pricings/read",
        "Microsoft.Security/automations/read",
        "Microsoft.Security/automations/write",
        "Microsoft.Authorization/policyAssignments/write",
        "Microsoft.PolicyInsights/remediations/write",
        "Microsoft.ManagedIdentity/userAssignedIdentities/write",
      ]);
      expect(result.set.verdicts["policy.assign"]).toBe("granted");
      expect(result.set.verdicts["policy.remediate"]).toBe("granted");
      expect(result.set.verdicts["identity.create"]).toBe("granted");
      expect(result.set.verdicts["defender-plans.read"]).toBe("denied");
    });

    it("records nothing when the subscription cannot be read", async () => {
      const azure = new FakeAzureManagement();
      azure.respondWith(permsResponse(OWNER), OK, OK, OK, OK, OK, { status: 403, body: {} });
      const result = await runCapabilityAudit({ azure, cribl: new FakeCriblClient() }, INPUT);
      expect(azure.calls[6]?.path).toBe(SUB_PERMISSIONS);
      expect(result.set.verdicts["defender-plans.read"]).toBeUndefined();
      expect(result.set.verdicts["defender-automation.read"]).toBeUndefined();
      // Nor the enablers that ride in the same read (CAP-2, CAP-3).
      expect(result.set.verdicts["policy.assign"]).toBeUndefined();
      expect(result.set.verdicts["policy.remediate"]).toBeUndefined();
      expect(result.set.verdicts["identity.create"]).toBeUndefined();
    });

    it("adds no request to an existing-subscription audit, which measures them itself", async () => {
      const azure = new FakeAzureManagement();
      azure.respondWith(permsResponse(permSet({ actions: ["Microsoft.Security/*"] })), OK, OK);
      await runCapabilityAudit(
        { azure, cribl: new FakeCriblClient() },
        { ...INPUT, setupPath: "existing-subscription" },
      );
      expect(azure.calls.filter((c) => c.path === SUB_PERMISSIONS)).toHaveLength(1);
    });
  });

  describe("the enablers are measured on every setup path (review r1)", () => {
    const SUB_PERMISSIONS = `/subscriptions/${SUB}/providers/Microsoft.Authorization/permissions`;
    const POLICY_AND_IDENTITY = permSet({
      actions: [
        "Microsoft.Authorization/policyassignments/*",
        "Microsoft.PolicyInsights/*",
        "Microsoft.ManagedIdentity/userAssignedIdentities/*",
      ],
    });

    it("evaluates them against the lab subscription path's own read, adding no request", async () => {
      const azure = new FakeAzureManagement();
      // One subscription read by the preflight; every later call answers OK.
      azure.respondWith(permsResponse(POLICY_AND_IDENTITY), OK, OK, OK, OK, OK, OK);
      const result = await runCapabilityAudit(
        { azure, cribl: new FakeCriblClient() },
        { ...INPUT, setupPath: "lab-new-rg-subscription" },
      );
      expect(azure.calls.filter((c) => c.path === SUB_PERMISSIONS)).toHaveLength(1);
      expect(result.set.verdicts["policy.assign"]).toBe("granted");
      expect(result.set.verdicts["policy.remediate"]).toBe("granted");
      expect(result.set.verdicts["identity.create"]).toBe("granted");
    });

    it("records nothing from a subscription path whose read failed, and does not re-ask", async () => {
      const azure = new FakeAzureManagement();
      azure.respondWith({ status: 403, body: {} }, OK, OK, OK, OK, OK, OK);
      const result = await runCapabilityAudit(
        { azure, cribl: new FakeCriblClient() },
        { ...INPUT, setupPath: "existing-subscription" },
      );
      expect(azure.calls.filter((c) => c.path === SUB_PERMISSIONS)).toHaveLength(1);
      expect(result.set.verdicts["policy.assign"]).toBeUndefined();
      expect(result.set.verdicts["identity.create"]).toBeUndefined();
    });

    it("reads the subscription once on lab-byo-rg, as on existing-rg", async () => {
      const azure = new FakeAzureManagement();
      // Group perms (Owner), five probes, then the subscription perms.
      azure.respondWith(permsResponse(OWNER), OK, OK, OK, OK, OK, permsResponse(POLICY_AND_IDENTITY));
      const result = await runCapabilityAudit(
        { azure, cribl: new FakeCriblClient() },
        { ...INPUT, setupPath: "lab-byo-rg" },
      );
      expect(azure.calls.filter((c) => c.path === SUB_PERMISSIONS)).toHaveLength(1);
      expect(azure.calls[6]?.path).toBe(SUB_PERMISSIONS);
      expect(result.set.verdicts["policy.assign"]).toBe("granted");
      expect(result.set.verdicts["policy.remediate"]).toBe("granted");
      expect(result.set.verdicts["identity.create"]).toBe("granted");
      expect(result.set.verdicts["defender-plans.read"]).toBe("denied");
    });
  });

  it("re-audits after a scope change, because the key changed", async () => {
    const cache = new FakeContentCache();
    await runCapabilityAudit(ownerPorts(cache), INPUT);

    const ports = ownerPorts(cache);
    const result = await runCapabilityAudit(ports, {
      ...INPUT,
      azure: { ...INPUT.azure, resourceGroup: "rg-other" },
    });
    expect(result.decision.run).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure degrades toward measuring, never toward a false hit
// ---------------------------------------------------------------------------

describe("cache failures are non-fatal", () => {
  const exploding: ContentCache = {
    get: () => Promise.reject(new Error("KV down")),
    set: () => Promise.reject(new Error("KV down")),
  };

  it("audits when the cache read fails", async () => {
    // A read failure must never look like a cache HIT - that is the path that
    // skips measuring.
    const ports = ownerPorts(exploding);
    const result = await runCapabilityAudit(ports, INPUT);
    expect(result.decision.run).toBe(true);
    expect(result.set.verdicts["dcr.write"]).toBe("granted");
  });

  it("still returns the audit when the cache write fails", async () => {
    const ports = ownerPorts(exploding);
    const result = await runCapabilityAudit(ports, { ...INPUT, trigger: "manual" });
    expect(result.set.verdicts["dcr.write"]).toBe("granted");
  });

  it("loadCachedCapabilities degrades to the empty set", async () => {
    expect(await loadCachedCapabilities(exploding, "tenant-a")).toEqual(emptyCapabilitySet());
    expect(await loadCachedCapabilities(undefined, "tenant-a")).toEqual(emptyCapabilitySet());
  });
});

// ---------------------------------------------------------------------------
// Graph application permissions (CAP-5)
// ---------------------------------------------------------------------------

describe("the Graph permission probes (CAP-5)", () => {
  /** A Graph reader whose probes answer from a table and record what was asked. */
  function graphWith(
    answers: Partial<Record<GraphPermissionProbe, GraphProbeResponse | Error>>,
  ): GraphDirectory & { asked: GraphPermissionProbe[]; remints: (boolean | undefined)[] } {
    const asked: GraphPermissionProbe[] = [];
    const remints: (boolean | undefined)[] = [];
    return {
      asked,
      remints,
      listServicePrincipals: async () => [],
      readSubscribedSkus: async () => ({ kind: "denied", status: 403, detail: "unused" }),
      probePermission: async (probe, options) => {
        asked.push(probe);
        remints.push(options?.remint);
        const answer = answers[probe];
        if (answer === undefined || answer instanceof Error) {
          throw answer ?? new Error(`no answer for ${probe}`);
        }
        return answer;
      },
    };
  }
  const ROW: GraphProbeResponse = { status: 200, body: { value: [{ id: "x" }] } };
  const EMPTY: GraphProbeResponse = { status: 200, body: { value: [] } };
  const DENIED: GraphProbeResponse = {
    status: 403,
    body: { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" } },
  };

  it("asks each probe once, in order, and records a row as granted", async () => {
    const graph = graphWith({ "subscribed-skus": ROW, "security-incidents": ROW });
    expect(await graphPermissionVerdicts(graph)).toEqual({
      "graph-licences.read": "granted",
      "graph-incidents.read": "granted",
    });
    expect(graph.asked).toEqual(["subscribed-skus", "security-incidents"]);
  });

  it("never records an empty 200 as denied (AZR-111), and records a privileges 403 as denied", async () => {
    const graph = graphWith({ "subscribed-skus": EMPTY, "security-incidents": DENIED });
    expect(await graphPermissionVerdicts(graph)).toEqual({ "graph-incidents.read": "denied" });
  });

  it("allows one token re-mint per audit: none after a probe that re-minted (review r1)", async () => {
    const graph = graphWith({
      "subscribed-skus": { ...DENIED, reminted: true },
      "security-incidents": DENIED,
    });
    expect(await graphPermissionVerdicts(graph)).toEqual({
      "graph-licences.read": "denied",
      "graph-incidents.read": "denied",
    });
    expect(graph.remints).toEqual([true, false]);
  });

  it("still lets the second probe re-mint when the first did not", async () => {
    const graph = graphWith({ "subscribed-skus": ROW, "security-incidents": ROW });
    await graphPermissionVerdicts(graph);
    expect(graph.remints).toEqual([true, true]);
  });

  it("records a 403 that does not name missing privileges as nothing (review r1)", async () => {
    const graph = graphWith({
      "subscribed-skus": ROW,
      "security-incidents": { status: 403, body: { error: { code: "Forbidden" } } },
    });
    expect(await graphPermissionVerdicts(graph)).toEqual({ "graph-licences.read": "granted" });
  });

  it("records nothing for a probe that rejects, and still runs the other", async () => {
    const graph = graphWith({ "subscribed-skus": new Error("slot refused"), "security-incidents": ROW });
    expect(await graphPermissionVerdicts(graph)).toEqual({ "graph-incidents.read": "granted" });
    expect(graph.asked).toHaveLength(2);
  });

  it("records nothing without a Graph port, or with one that cannot probe", async () => {
    expect(await graphPermissionVerdicts(undefined)).toEqual({});
    const noProbe: GraphDirectory = {
      listServicePrincipals: async () => [],
      readSubscribedSkus: async () => ({ kind: "denied", status: 403, detail: "unused" }),
    };
    expect(await graphPermissionVerdicts(noProbe)).toEqual({});
  });

  it("joins the audited set and survives the cache round trip", async () => {
    const cache = new FakeContentCache();
    const ports = ownerPorts(cache);
    // ownerPorts scripts the group read and three probes; the rest of the
    // ARM reads are answered here.
    (ports.azure as FakeAzureManagement).respondWith(OK, OK, permsResponse(OWNER));
    const graph = graphWith({ "subscribed-skus": ROW, "security-incidents": DENIED });
    const result = await runCapabilityAudit({ ...ports, graph }, INPUT);
    expect(result.set.verdicts["graph-licences.read"]).toBe("granted");
    expect(result.set.verdicts["graph-incidents.read"]).toBe("denied");

    const stored = await loadCachedCapabilities(cache, "tenant-a");
    expect(stored.verdicts["graph-licences.read"]).toBe("granted");
    expect(stored.verdicts["graph-incidents.read"]).toBe("denied");
    expect(stored.verdicts["policy.assign"]).toBe("granted");
    expect(stored.verdicts["identity.create"]).toBe("granted");
  });

  it("issues no Graph read when the cached audit is reused", async () => {
    const graph = graphWith({ "subscribed-skus": ROW, "security-incidents": ROW });
    const ports = ownerPorts(await seeded(KEY));
    await runCapabilityAudit({ ...ports, graph }, INPUT);
    expect(graph.asked).toEqual([]);
  });
});

describe("the audit never throws", () => {
  it("survives ports that reject every call", async () => {
    const azure = {
      request: () => Promise.reject(new Error("network down")),
    } as unknown as CapabilityAuditPorts["azure"];
    const cribl = {
      request: () => Promise.reject(new Error("network down")),
    } as unknown as CapabilityAuditPorts["cribl"];

    const result = await runCapabilityAudit(
      { azure, cribl },
      { ...INPUT, cribl: { mode: "local" } },
    );

    // Nothing measured, and the caller still has something honest to render.
    expect(result.set.verdicts).toEqual({});
    expect(result.set.connectionId).toBe(KEY);
  });
});

// ---------------------------------------------------------------------------
// One audit per tenant (ADR 0009; audit tenancy MEDIUM capability-codec.ts:31)
// ---------------------------------------------------------------------------

describe("the cache keeps one audit per tenant", () => {
  const INPUT_B: CapabilityAuditInput = { ...INPUT, identity: { tenantId: "tenant-b", clientId: "client-b" } };

  it("auditing tenant B leaves tenant A's audit in place, so switching back costs nothing", async () => {
    // THE DEFECT: one slot for every connection, so measuring B overwrote A and
    // switching back to A re-measured against the shared request budget.
    const cache = new FakeContentCache();
    await runCapabilityAudit(ownerPorts(cache), INPUT);
    await runCapabilityAudit(ownerPorts(cache), INPUT_B);

    expect((await loadCachedCapabilities(cache, "tenant-a")).connectionId).toBe(KEY);
    const back = ownerPorts(cache);
    const result = await runCapabilityAudit(back, INPUT);
    expect(result.decision.run).toBe(false);
    expect((back.azure as FakeAzureManagement).calls).toHaveLength(0);
  });

  it("files each tenant under its own key", () => {
    expect(capabilityAuditCacheKey("Tenant-A")).toBe(`${CAPABILITY_AUDIT_CACHE_KEY}~tenant-a`);
    expect(capabilityAuditCacheKey("tenant-a")).not.toBe(capabilityAuditCacheKey("tenant-b"));
  });

  it("moves the legacy single-slot audit only to the tenant it was measured for", async () => {
    const cache = await seeded(KEY);
    // Tenant B must not adopt A's verdicts - and must not destroy them either.
    expect(await loadCachedCapabilities(cache, "tenant-b")).toEqual(emptyCapabilitySet());
    expect(await cache.get(CAPABILITY_AUDIT_CACHE_KEY)).not.toBeNull();

    const forA = await loadCachedCapabilities(cache, "tenant-a");
    expect(forA.connectionId).toBe(KEY);
    expect(await cache.get(capabilityAuditCacheKey("tenant-a"))).not.toBeNull();
    // Moved once: the legacy slot is emptied.
    expect(await cache.get(CAPABILITY_AUDIT_CACHE_KEY)).toBeNull();
  });
});
