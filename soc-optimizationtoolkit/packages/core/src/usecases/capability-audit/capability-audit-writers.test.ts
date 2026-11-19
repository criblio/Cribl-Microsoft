/**
 * CAP-11: the two writers of one tenant's cached capability set.
 *
 * The app-level audit (runCapabilityAudit) and the RBAC preflight panel both
 * save through saveCapabilityAudit under the same per-tenant key. The panel
 * measures only what the setup path's preflight measures; the audit adds the
 * subscription-scope verdicts (Defender on existing-rg, the policy and identity
 * enablers) and the Graph probes. These pins replay the real sequence - audit,
 * then a panel refresh built exactly as rbac-preflight-panel.tsx builds it -
 * and require every audit-only verdict to survive with its exact prior value.
 */
import { describe, expect, it } from "vitest";

import {
  loadCachedCapabilities,
  runCapabilityAudit,
  saveCapabilityAudit,
} from "./capability-audit";
import type { CapabilityAuditInput } from "./capability-audit";
import {
  capabilityAuditCacheKey,
  capabilityAuditKey,
  serializeCapabilitySet,
} from "../../domain/capabilities";
import type { Capability, CapabilitySet } from "../../domain/capabilities";
import {
  capabilitiesFromSides,
  runAzurePreflight,
  runCriblPreflight,
} from "../permission-preflight";
import type { GraphDirectory, GraphProbeResponse } from "../../ports/graph-directory";
import type { ContentCache } from "../../ports/sentinel-content";
import type { PermissionSet } from "../../domain/azure-permissions";
import type { PortHttpResponse } from "../../ports/http";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeContentCache } from "../../testing/fake-sentinel-content";
import { FakeCriblClient } from "../../testing/fake-cribl-client";

const SUB = "11111111-1111-1111-1111-111111111111";
const TARGET = { subscriptionId: SUB, resourceGroup: "rg-sentinel", workspaceName: "law-sentinel" };
const AUDIT_AT = "2026-11-18T09:00:00Z";
const PANEL_AT = "2026-11-18T09:05:00Z";

const INPUT: CapabilityAuditInput = {
  trigger: "launch",
  setupPath: "existing-rg",
  azure: TARGET,
  identity: { tenantId: "tenant-a", clientId: "client-a" },
  cribl: { mode: "cloud" },
  nowIso: AUDIT_AT,
};

/** The key both writers compute for this connection (cloud shell: no group). */
const KEY = capabilityAuditKey({
  tenantId: "tenant-a",
  clientId: "client-a",
  ...TARGET,
  setupPath: "existing-rg",
  criblWorkerGroup: "",
});

function permSet(actions: string[]): PermissionSet {
  return { actions, notActions: [], dataActions: [], notDataActions: [] };
}
const OK: PortHttpResponse = { status: 200, body: {} };
const perms = (set: PermissionSet): PortHttpResponse => ({ status: 200, body: { value: [set] } });

/** The resource-group read plus the five preflight probes, Owner-grade. */
function groupReads(): PortHttpResponse[] {
  return [perms(permSet(["*"])), OK, OK, OK, OK, OK];
}

/**
 * Subscription permissions chosen so the audit-only verdicts are MIXED -
 * granted and denied both - so "kept its exact prior value" cannot pass by
 * every verdict happening to read the same.
 */
const SUBSCRIPTION = perms(
  permSet(["Microsoft.Security/*", "Microsoft.ManagedIdentity/userAssignedIdentities/*"]),
);

const ROW: GraphProbeResponse = { status: 200, body: { value: [{ id: "x" }] } };
const DENIED: GraphProbeResponse = {
  status: 403,
  body: { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" } },
};
const GRAPH: GraphDirectory = {
  listServicePrincipals: async () => [],
  readSubscribedSkus: async () => ({ kind: "denied", status: 403, detail: "unused" }),
  probePermission: async (probe) => (probe === "subscribed-skus" ? ROW : DENIED),
};

/** Run the audit with every audit-only measurement answered. */
async function auditInto(
  cache: ContentCache,
  trigger: CapabilityAuditInput["trigger"] = "launch",
): Promise<CapabilitySet> {
  const azure = new FakeAzureManagement();
  azure.respondWith(...groupReads(), SUBSCRIPTION);
  const result = await runCapabilityAudit(
    { azure, cribl: new FakeCriblClient(), cache, graph: GRAPH },
    { ...INPUT, trigger },
  );
  expect(result.decision.run).toBe(true);
  return result.set;
}

/** The panel's set, built exactly as rbac-preflight-panel.tsx builds it. */
async function panelSet(azureResponses: PortHttpResponse[], at: string): Promise<CapabilitySet> {
  const azure = new FakeAzureManagement();
  azure.respondWith(...azureResponses);
  const azureSide = await runAzurePreflight(azure, "existing-rg", TARGET);
  const criblSide = await runCriblPreflight(new FakeCriblClient(), "cloud", undefined);
  return capabilitiesFromSides(azureSide, criblSide, { auditedAt: at, connectionId: KEY });
}

/** What the audit measured that the panel does not measure at all. */
const AUDIT_ONLY: Readonly<Partial<Record<Capability, string>>> = {
  "defender-plans.read": "granted",
  "defender-automation.read": "granted",
  "defender-automation.write": "granted",
  "policy.assign": "denied",
  "policy.remediate": "denied",
  "identity.create": "granted",
  // CAP-10: the subscription diagnostic-settings verdicts are audit-only too.
  "subscription-diagnostics.read": "denied",
  "subscription-diagnostics.write": "denied",
  "subscription-diagnostics.delete": "denied",
  "graph-licences.read": "granted",
  "graph-incidents.read": "denied",
};

describe("audit, then an RBAC panel refresh (CAP-11)", () => {
  it("keeps every audit-only verdict at its exact prior value", async () => {
    const cache = new FakeContentCache();
    const audited = await auditInto(cache);
    const panel = await panelSet(groupReads(), PANEL_AT);

    // Preconditions, so the pin means what it says: the audit measured exactly
    // these, and the panel measures none of them.
    const auditOnly = Object.keys(audited.verdicts).filter((c) => !(c in panel.verdicts));
    expect(auditOnly.sort()).toEqual(Object.keys(AUDIT_ONLY).sort());
    for (const [capability, verdict] of Object.entries(AUDIT_ONLY)) {
      expect(audited.verdicts[capability as Capability]).toBe(verdict);
    }
    expect(Object.keys(panel.verdicts).length).toBeGreaterThan(0);

    await saveCapabilityAudit(cache, panel, "tenant-a");
    const stored = await loadCachedCapabilities(cache, "tenant-a");

    for (const [capability, verdict] of Object.entries(AUDIT_ONLY)) {
      expect({ capability, verdict: stored.verdicts[capability as Capability] }).toEqual({
        capability,
        verdict,
      });
    }
    // The panel's own verdicts are stored too, and the set is the union.
    for (const [capability, verdict] of Object.entries(panel.verdicts)) {
      expect(stored.verdicts[capability as Capability]).toBe(verdict);
    }
    expect(Object.keys(stored.verdicts).sort()).toEqual(Object.keys(audited.verdicts).sort());
    // The set is "last audited" at the panel's run; each carried verdict keeps
    // the audit's time, so a later merge can still tell it is the older one.
    expect(stored.auditedAt).toBe(PANEL_AT);
    expect(stored.measuredAt).toEqual(
      Object.fromEntries(Object.keys(AUDIT_ONLY).sort().map((c) => [c, AUDIT_AT])),
    );
  });

  it("serves those verdicts to the next launch, which re-uses the cache with zero requests", async () => {
    const cache = new FakeContentCache();
    await auditInto(cache);
    await saveCapabilityAudit(cache, await panelSet(groupReads(), PANEL_AT), "tenant-a");

    const azure = new FakeAzureManagement();
    const relaunch = await runCapabilityAudit({ azure, cribl: new FakeCriblClient(), cache }, INPUT);
    expect(relaunch.decision.run).toBe(false);
    expect(azure.calls).toHaveLength(0);
    for (const [capability, verdict] of Object.entries(AUDIT_ONLY)) {
      expect(relaunch.set.verdicts[capability as Capability]).toBe(verdict);
    }
  });

  it("replaces a verdict both measured with the panel's newer measurement", async () => {
    const cache = new FakeContentCache();
    const audited = await auditInto(cache);
    expect(audited.verdicts["dcr.write"]).toBe("granted");

    // The panel now reads a Reader-only group: dcr.write is denied.
    const reader = [perms(permSet(["*/read"])), OK, OK, OK, OK, OK, OK];
    const panel = await panelSet(reader, PANEL_AT);
    expect(panel.verdicts["dcr.write"]).toBe("denied");

    const stored = await saveCapabilityAudit(cache, panel, "tenant-a");
    expect(stored.verdicts["dcr.write"]).toBe("denied");
    expect((await loadCachedCapabilities(cache, "tenant-a")).verdicts["dcr.write"]).toBe("denied");
  });

  it("does not let an OLDER measurement that lands later replace a newer one", async () => {
    // Two writers finish out of order: the panel's run (09:05) is saved first,
    // then an audit that STARTED earlier (09:00) saves. The panel's dcr.write
    // denial is the newer measurement and must survive.
    const cache = new FakeContentCache();
    const reader = [perms(permSet(["*/read"])), OK, OK, OK, OK, OK, OK];
    await saveCapabilityAudit(cache, await panelSet(reader, PANEL_AT), "tenant-a");

    // A manual refresh, so the matching cached key does not skip the audit.
    const audited = await auditInto(cache, "manual");
    expect(audited.verdicts["dcr.write"]).toBe("denied");
    expect(audited.verdicts["defender-plans.read"]).toBe("granted");
  });

  it("does not merge across connections: another key's verdicts are replaced, never carried", async () => {
    const cache = new FakeContentCache();
    await auditInto(cache);
    // The panel on a different setup path is a different connection key.
    const other: CapabilitySet = {
      verdicts: { "dcr.write": "denied" },
      auditedAt: PANEL_AT,
      connectionId: `${KEY}-other`,
    };
    const stored = await saveCapabilityAudit(cache, other, "tenant-a");
    expect(stored).toEqual(other);
    expect(await cache.get(capabilityAuditCacheKey("tenant-a"))).toEqual(serializeCapabilitySet(other));
  });

  it("skips the write when the cached set cannot be read, so nothing is erased", async () => {
    const writes: unknown[] = [];
    const unreadable: ContentCache = {
      get: () => Promise.reject(new Error("KV down")),
      set: async (_key, value) => {
        writes.push(value);
      },
    };
    const panel = await panelSet(groupReads(), PANEL_AT);
    expect(await saveCapabilityAudit(unreadable, panel, "tenant-a")).toBe(panel);
    expect(writes).toHaveLength(0);
  });
});

describe("an audit retracts its own earlier verdicts it could not repeat (CAP-11 review round 1)", () => {
  const LATER = "2026-11-18T15:00:00Z";
  const EMPTY: GraphProbeResponse = { status: 200, body: { value: [] } };
  const granting: GraphDirectory = { ...GRAPH, probePermission: async () => ROW };

  async function audit(
    cache: ContentCache,
    graph: GraphDirectory,
    nowIso: string,
    subscription: PortHttpResponse = SUBSCRIPTION,
  ): Promise<CapabilitySet> {
    const azure = new FakeAzureManagement();
    azure.respondWith(...groupReads(), subscription);
    const result = await runCapabilityAudit(
      { azure, cribl: new FakeCriblClient(), cache, graph },
      { ...INPUT, trigger: "manual", nowIso },
    );
    expect(result.decision.run).toBe(true);
    return result.set;
  }

  it("an empty 200 on a refresh turns an earlier graph-incidents.read grant into unknown", async () => {
    const cache = new FakeContentCache();
    const first = await audit(cache, granting, AUDIT_AT);
    expect(first.verdicts["graph-incidents.read"]).toBe("granted");

    const emptyIncidents: GraphDirectory = {
      ...GRAPH,
      probePermission: async (probe) => (probe === "subscribed-skus" ? ROW : EMPTY),
    };
    const second = await audit(cache, emptyIncidents, LATER);
    const stored = await loadCachedCapabilities(cache, "tenant-a");
    for (const set of [second, stored]) {
      expect(set.verdicts["graph-incidents.read"]).toBeUndefined();
      expect(set.verdicts["graph-licences.read"]).toBe("granted");
      expect(set.auditedAt).toBe(LATER);
      expect(set.measuredAt).toBeUndefined();
    }
  });

  it("a probe that rejects, and a failed subscription read, retract their earlier verdicts too", async () => {
    const cache = new FakeContentCache();
    const first = await audit(cache, GRAPH, AUDIT_AT);
    expect(first.verdicts["graph-licences.read"]).toBe("granted");
    expect(first.verdicts["policy.assign"]).toBe("denied");
    expect(first.verdicts["defender-plans.read"]).toBe("granted");

    const rejecting: GraphDirectory = {
      ...GRAPH,
      probePermission: () => Promise.reject(new Error("network")),
    };
    const second = await audit(cache, rejecting, LATER, { status: 500, body: {} });
    const lost = Object.keys(AUDIT_ONLY).filter((c) => second.verdicts[c as Capability] !== undefined);
    expect(lost).toEqual([]);
    expect(Object.keys((await loadCachedCapabilities(cache, "tenant-a")).verdicts).sort()).toEqual(
      Object.keys(second.verdicts).sort(),
    );
  });

  it("a panel run between two audits still keeps the audit-only verdicts (the panel merges)", async () => {
    const cache = new FakeContentCache();
    await audit(cache, GRAPH, AUDIT_AT);
    await saveCapabilityAudit(cache, await panelSet(groupReads(), PANEL_AT), "tenant-a");
    const stored = await loadCachedCapabilities(cache, "tenant-a");
    for (const [capability, verdict] of Object.entries(AUDIT_ONLY)) {
      expect(stored.verdicts[capability as Capability]).toBe(verdict);
    }
  });
});
