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

import { loadCachedCapabilities, runCapabilityAudit } from "./capability-audit";
import type { CapabilityAuditInput, CapabilityAuditPorts } from "./capability-audit";
import {
  CAPABILITY_AUDIT_CACHE_KEY,
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

    const stored = await loadCachedCapabilities(cache);
    expect(stored.auditedAt).toBe(NOW);
    expect(stored.connectionId).toBe(KEY);
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
    expect(await loadCachedCapabilities(exploding)).toEqual(emptyCapabilitySet());
    expect(await loadCachedCapabilities(undefined)).toEqual(emptyCapabilitySet());
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
