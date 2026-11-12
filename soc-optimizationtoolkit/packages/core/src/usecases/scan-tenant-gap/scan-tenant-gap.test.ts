import { describe, expect, it } from "vitest";
import { scanTenantGap, type ScanTenantGapPorts, type TenantGapProfile } from "./scan-tenant-gap";
import type { AzureManagement, AzureManagementRequest } from "../../ports/azure-management";
import type { CriblClient, CriblRequest } from "../../ports/cribl-client";
import type { KvDocumentLoad, KvDocumentStore } from "../../ports/kv-document-store";
import type { TenantPorts, TenantProfile, TenantRun, TenantRunOptions, TenantSession } from "../../ports/tenant-session";
import type { RequestPacer } from "../../ports/request-pacer";
import type { GraphDirectory } from "../../ports/graph-directory";
import { ONBOARDING_PROGRESS_KEY, encodeProgress, emptyProgress, withCriblSource, withPlanValues } from "../../domain/onboarding-howto/progress-document";
import { COVERAGE_SELECTION_KEY } from "../../domain/coverage-model/coverage-selection";
import { TENANT_CRIBL_MAPPING_KEY, encodeTenantCriblMapping } from "../../domain/tenant-cribl-mapping";
import { tenantMigrationClaimKey, tenantMigrationMarker } from "../../domain/tenancy";
import { GAP_SOURCES } from "../../domain/tenant-gap";

const TENANT = "1a2b3c4d-0000-0000-0000-000000000001";
const PROFILE: TenantGapProfile = {
  id: "p1",
  name: "Contoso",
  config: { tenantId: TENANT, clientId: "c1", subscriptionId: "sub-1", resourceGroup: "rg-1" },
};

class Docs implements KvDocumentStore {
  readonly loads: string[] = [];
  readonly saves: string[] = [];
  private readonly values: Record<string, KvDocumentLoad>;
  constructor(values: Record<string, KvDocumentLoad>) {
    this.values = values;
  }
  load(key: string): Promise<KvDocumentLoad> {
    this.loads.push(key);
    return Promise.resolve(this.values[key] ?? { kind: "absent", why: "not-found" });
  }
  save(key: string): Promise<void> {
    this.saves.push(key);
    return Promise.resolve();
  }
}

/** An Azure port that answers every read with one status, counting them. */
function azureAnswering(status: number, body: unknown = { error: { code: "x" } }): AzureManagement & { sent: AzureManagementRequest[] } {
  const sent: AzureManagementRequest[] = [];
  return {
    sent,
    request: (r) => {
      sent.push(r);
      return Promise.resolve({ status, body });
    },
  };
}

const GRAPH: GraphDirectory = {} as GraphDirectory;

function sessionDone(
  azure: AzureManagement,
): TenantSession & { runs: TenantProfile[]; runOptions: (TenantRunOptions | undefined)[] } {
  const runs: TenantProfile[] = [];
  const runOptions: (TenantRunOptions | undefined)[] = [];
  return {
    runs,
    runOptions,
    async runForTenant<T>(
      profile: TenantProfile,
      work: (ports: TenantPorts) => Promise<T>,
      options?: TenantRunOptions,
    ): Promise<TenantRun<T>> {
      runs.push(profile);
      runOptions.push(options);
      const value = await work({ azure, graph: GRAPH });
      return { kind: "done", tenantId: profile.config.tenantId, value, restore: { kind: "not-needed" } };
    },
  };
}

function sessionUnknown(stage: "proof" | "credential", reason: string): TenantSession & { runs: TenantProfile[] } {
  const runs: TenantProfile[] = [];
  return {
    runs,
    runForTenant<T>(profile: TenantProfile): Promise<TenantRun<T>> {
      runs.push(profile);
      return Promise.resolve({ kind: "unknown", tenantId: profile.config.tenantId, stage, reason, restore: { kind: "not-needed" } });
    },
  };
}

function criblAnswering(items: unknown[] | null): CriblClient & { sent: CriblRequest[] } {
  const sent: CriblRequest[] = [];
  return {
    sent,
    request: (r) => {
      sent.push(r);
      return Promise.resolve(items === null ? { status: 403, body: null } : { status: 200, body: { items } });
    },
    listGroups: () => Promise.reject(new Error("not used")),
  };
}

const FREE_PACER: RequestPacer = { acquire: () => Promise.resolve() };

function ports(over: Partial<ScanTenantGapPorts>): ScanTenantGapPorts {
  const azure = azureAnswering(403);
  return {
    session: sessionDone(azure),
    documents: new Docs({}),
    cribl: criblAnswering([]),
    pacer: FREE_PACER,
    ...over,
  };
}

const RECORD = { groupId: "grp-a", inputId: "in_entra_1a2b3c4d", inputType: "eventhub", secretId: "s1" } as const;

function progressWithEntraRecord(): KvDocumentLoad {
  const p = withCriblSource(emptyProgress({ subscriptionId: "sub-1", resourceGroup: "rg-1" }), "entraId", RECORD);
  return { kind: "value", value: JSON.parse(encodeProgress(p)) };
}

const progressKey = `${ONBOARDING_PROGRESS_KEY}.${TENANT}`;

describe("scanTenantGap", () => {
  it("returns one cell per catalog source, in catalog order", async () => {
    const row = await scanTenantGap(ports({}), PROFILE);
    expect(row.cells.map((c) => c.sourceId)).toEqual(GAP_SOURCES.map((s) => s.id));
  });

  it("reads Azure ONLY through the tenant session, paced, and never writes KV", async () => {
    const azure = azureAnswering(403);
    const session = sessionDone(azure);
    const docs = new Docs({});
    let acquired = 0;
    const pacer: RequestPacer = {
      acquire: () => {
        acquired += 1;
        return Promise.resolve();
      },
    };
    const signal = { aborted: false };
    const row = await scanTenantGap(ports({ session, documents: docs, pacer }), PROFILE, { signal });
    expect(session.runs.map((p) => p.id)).toEqual(["p1"]);
    // Every Azure read the work sent spent the pacer once.
    expect(azure.sent.length).toBeGreaterThan(0);
    expect(acquired).toBe(azure.sent.length);
    // The session gets the same pacer and signal for its own proof reads and mints.
    expect(session.runOptions).toEqual([{ pacer, signal }]);
    expect(azure.sent.every((r) => r.method === "GET")).toBe(true);
    expect(docs.saves).toEqual([]);
    expect(row.status.state).toBe("green");
    expect(row.cancelled).toBe(false);
  });

  it("a refused Azure read is unknown in the Azure indicator, never red", async () => {
    const row = await scanTenantGap(ports({}), PROFILE);
    const states = row.cells.map((c) => c.azure.state);
    expect(states.filter((s) => s === "red")).toEqual([]);
    expect(states.filter((s) => s === "unknown").length).toBe(GAP_SOURCES.length);
  });

  it("a tenant whose proof fails is unknown in EVERY cell, both indicators", async () => {
    const cribl = criblAnswering([{ id: RECORD.inputId, type: "eventhub" }]);
    const row = await scanTenantGap(
      ports({
        session: sessionUnknown("proof", "another tenant answered"),
        cribl,
        documents: new Docs({ [progressKey]: progressWithEntraRecord() }),
      }),
      PROFILE,
    );
    expect(row.status.state).toBe("unknown");
    expect(row.status.reason).toContain("another tenant answered");
    for (const c of row.cells) {
      expect(c.azure.state).toBe("unknown");
      expect(c.cribl.state).toBe("unknown");
    }
    expect(cribl.sent).toEqual([]);
  });

  it("a session that never ran (no secret) leaves Azure unknown but still reads the Cribl side", async () => {
    const cribl = criblAnswering([{ id: RECORD.inputId, type: "eventhub" }]);
    const row = await scanTenantGap(
      ports({
        session: sessionUnknown("credential", "secret not entered"),
        cribl,
        documents: new Docs({ [progressKey]: progressWithEntraRecord() }),
      }),
      PROFILE,
    );
    expect(row.cells.every((c) => c.azure.state === "unknown")).toBe(true);
    expect(row.cells.find((c) => c.sourceId === "entraId")?.cribl.state).toBe("green");
    expect(row.cells.find((c) => c.sourceId === "activityLog")?.cribl.state).toBe("red");
    expect(cribl.sent).toEqual([{ method: "GET", path: "/system/inputs", groupId: "grp-a" }]);
  });

  it("reads each recorded group's inputs once, sharing them across tenants through the cache", async () => {
    const cribl = criblAnswering([{ id: RECORD.inputId, type: "eventhub" }]);
    const cache = new Map();
    const docs = new Docs({ [progressKey]: progressWithEntraRecord() });
    await scanTenantGap(ports({ cribl, documents: docs }), PROFILE, { criblInputs: cache });
    await scanTenantGap(ports({ cribl, documents: docs }), PROFILE, { criblInputs: cache });
    expect(cribl.sent.length).toBe(1);
  });

  it("a blank tenant id reads nothing at all and is unknown everywhere", async () => {
    const session = sessionDone(azureAnswering(200));
    const docs = new Docs({});
    const row = await scanTenantGap(
      ports({ session, documents: docs }),
      { ...PROFILE, config: { ...PROFILE.config, tenantId: " " } },
    );
    expect(session.runs).toEqual([]);
    expect(docs.loads).toEqual([]);
    expect(row.cells.every((c) => c.azure.state === "unknown" && c.cribl.state === "unknown")).toBe(true);
  });

  it("an unreadable progress document is unknown on both sides and sends no Azure read", async () => {
    const session = sessionDone(azureAnswering(200));
    const row = await scanTenantGap(
      ports({ session, documents: new Docs({ [progressKey]: { kind: "unknown", reason: "HTTP 500" } }) }),
      PROFILE,
    );
    expect(session.runs).toEqual([]);
    expect(row.cells.every((c) => c.azure.state === "unknown" && c.cribl.state === "unknown")).toBe(true);
    expect(row.cells[0]!.cribl.reason).toContain("HTTP 500");
  });

  it("a legacy single-tenant document not yet filed under any tenant is unknown, never an empty first run", async () => {
    const legacy = progressWithEntraRecord();
    const row = await scanTenantGap(
      ports({ documents: new Docs({ [ONBOARDING_PROGRESS_KEY]: legacy }) }),
      PROFILE,
    );
    expect(row.cells.every((c) => c.cribl.state === "unknown")).toBe(true);
    expect(row.cells[0]!.cribl.reason).toContain("Azure Native Source Onboarding");
  });

  it("a legacy document already filed under a tenant (marker) reads this tenant's own copy as absent", async () => {
    const row = await scanTenantGap(
      ports({
        documents: new Docs({
          [ONBOARDING_PROGRESS_KEY]: { kind: "value", value: tenantMigrationMarker("someone-else") },
        }),
      }),
      PROFILE,
    );
    expect(row.cells.every((c) => c.cribl.state === "red")).toBe(true);
  });

  it("validates with the tenant's own plan values, not the active connection's", async () => {
    const azure = azureAnswering(403);
    const p = withPlanValues(emptyProgress({ subscriptionId: "sub-tenant", resourceGroup: "rg-t" }), {
      ...emptyProgress({ subscriptionId: "sub-tenant", resourceGroup: "rg-t" }).planValues,
      namespace: "ns-tenant",
    });
    await scanTenantGap(
      ports({
        session: sessionDone(azure),
        documents: new Docs({ [progressKey]: { kind: "value", value: JSON.parse(encodeProgress(p)) } }),
      }),
      PROFILE,
    );
    expect(azure.sent.some((r) => r.path.includes("/namespaces/ns-tenant"))).toBe(true);
    expect(azure.sent.some((r) => r.path.includes("sub-1"))).toBe(false);
  });

  it("an unreadable coverage selection makes only the sources with a sub-selection unknown", async () => {
    const azure = azureAnswering(200, { value: [] });
    const row = await scanTenantGap(
      ports({
        session: sessionDone(azure),
        documents: new Docs({ [`${COVERAGE_SELECTION_KEY}.${TENANT}`]: { kind: "unknown", reason: "HTTP 502" } }),
      }),
      PROFILE,
    );
    const entra = row.cells.find((c) => c.sourceId === "entraId")!;
    expect(entra.azure.state).toBe("unknown");
    expect(entra.azure.reason).toContain("HTTP 502");
    const activity = row.cells.find((c) => c.sourceId === "activityLog")!;
    expect(activity.azure.reason).not.toContain("HTTP 502");
  });

  it("names the mapped group in a red Cribl cell", async () => {
    const mapping = encodeTenantCriblMapping({ mode: "shared", sharedGroup: "shared-grp", groups: {} });
    const row = await scanTenantGap(
      ports({ documents: new Docs({ [TENANT_CRIBL_MAPPING_KEY]: { kind: "value", value: mapping } }) }),
      PROFILE,
    );
    expect(row.cells[0]!.cribl.state).toBe("red");
    expect(row.cells[0]!.cribl.reason).toContain("shared-grp");
  });

  it("a cancelled scan reads no Cribl group and leaves recorded cells unknown", async () => {
    const cribl = criblAnswering([{ id: RECORD.inputId, type: "eventhub" }]);
    const row = await scanTenantGap(
      ports({ cribl, documents: new Docs({ [progressKey]: progressWithEntraRecord() }) }),
      PROFILE,
      { signal: { aborted: true } },
    );
    expect(cribl.sent).toEqual([]);
    expect(row.cells.find((c) => c.sourceId === "entraId")!.cribl.state).toBe("unknown");
  });

  it("warns when the active connection's credential could not be put back", async () => {
    const session: TenantSession = {
      async runForTenant<T>(profile: TenantProfile, work: (p: TenantPorts) => Promise<T>): Promise<TenantRun<T>> {
        const value = await work({ azure: azureAnswering(403), graph: GRAPH });
        return { kind: "done", tenantId: profile.config.tenantId, value, restore: { kind: "failed", reason: "mint refused" } };
      },
    };
    const row = await scanTenantGap(ports({ session }), PROFILE);
    expect(row.warnings.join(" ")).toContain("mint refused");
  });

  // AZR-63 review: a progress value that EXISTS but is not understood read as
  // absent, so every Cribl cell went red from a document nobody could read.
  it.each([
    ["a truncated JSON string", { kind: "value", value: '{"kind":"soc.onboarding-progress","vers' } as KvDocumentLoad],
    ["a record with no kind and no version", { kind: "value", value: { criblSources: { entraId: RECORD } } } as KvDocumentLoad],
    ["a value that is not a record", { kind: "value", value: 42 } as KvDocumentLoad],
  ])("progress holding %s is unknown on both sides, never red, and sends no Azure read", async (_label, load) => {
    const session = sessionDone(azureAnswering(200));
    const cribl = criblAnswering([]);
    const row = await scanTenantGap(ports({ session, cribl, documents: new Docs({ [progressKey]: load }) }), PROFILE);
    expect(row.cells.filter((c) => c.cribl.state === "red")).toEqual([]);
    expect(row.cells.every((c) => c.azure.state === "unknown" && c.cribl.state === "unknown")).toBe(true);
    expect(row.cells[0]!.cribl.reason).toContain("cannot read");
    expect(session.runs).toEqual([]);
    expect(cribl.sent).toEqual([]);
  });

  it.each([
    ["an unparseable string", "{not json"],
    ["a record with no kind and no version", { subSelections: {} }],
  ])("a coverage selection holding %s is unknown for sources with a sub-selection, never checked against defaults", async (_label, value) => {
    const azure = azureAnswering(200, { value: [] });
    const row = await scanTenantGap(
      ports({
        session: sessionDone(azure),
        documents: new Docs({ [`${COVERAGE_SELECTION_KEY}.${TENANT}`]: { kind: "value", value } }),
      }),
      PROFILE,
    );
    const entra = row.cells.find((c) => c.sourceId === "entraId")!;
    expect(entra.azure.state).toBe("unknown");
    expect(entra.azure.reason).toContain("cannot read");
  });

  // AZR-63 review: a cancelled read came back with a green status, so the
  // screen cached it over the tenant's last complete answer.
  it("a read cancelled mid-way says so: cancelled, and the status is unknown, not green", async () => {
    const signal = { aborted: false };
    const azure: AzureManagement = {
      request: () => {
        signal.aborted = true;
        return Promise.resolve({ status: 403, body: { error: { code: "x" } } });
      },
    };
    const row = await scanTenantGap(ports({ session: sessionDone(azure) }), PROFILE, { signal });
    expect(row.cancelled).toBe(true);
    expect(row.status.state).toBe("unknown");
    expect(row.status.reason).toContain("cancelled");
  });

  // AZR-108: loadReadOnly stopped at the tenant's own document, so a Cribl
  // source an earlier app version recorded under the legacy key afterwards
  // showed as "not created".
  describe("Cribl sources stranded under the legacy key (AZR-108)", () => {
    const OLD = { groupId: "grp-old", inputId: "in_activity_old", inputType: "eventhub", secretId: "s0" } as const;
    function legacyWithActivity(): KvDocumentLoad {
      const p = withCriblSource(emptyProgress({ subscriptionId: "sub-1", resourceGroup: "rg-1" }), "activityLog", OLD);
      return { kind: "value", value: JSON.parse(encodeProgress(p)) };
    }
    const claimKey = tenantMigrationClaimKey(ONBOARDING_PROGRESS_KEY);

    it("a record claimed for this tenant shows as earlier-version, not adopted - unknown, not red - and writes nothing", async () => {
      const cribl = criblAnswering([{ id: RECORD.inputId, type: "eventhub" }]);
      const docs = new Docs({
        [progressKey]: progressWithEntraRecord(),
        [ONBOARDING_PROGRESS_KEY]: legacyWithActivity(),
        [claimKey]: { kind: "value", value: tenantMigrationMarker(TENANT) },
      });
      const row = await scanTenantGap(ports({ cribl, documents: docs }), PROFILE);
      const activity = row.cells.find((c) => c.sourceId === "activityLog")!;
      expect(activity.cribl.state).toBe("unknown");
      expect(activity.cribl.reason).toContain("in_activity_old in worker group grp-old for this tenant");
      expect(activity.cribl.reason).toContain("not adopted");
      // Only the stranded source changed; the rest stay as they were.
      expect(row.cells.filter((c) => c.cribl.state === "red").length).toBe(GAP_SOURCES.length - 2);
      expect(row.cells.find((c) => c.sourceId === "entraId")!.cribl.state).toBe("green");
      expect(row.warnings).toEqual([
        "1 Cribl source record was recorded by an earlier app version for this tenant and not adopted. " +
          "It is not counted here; review it on Azure Native Source Onboarding.",
      ]);
      expect(docs.saves).toEqual([]);
      // The stranded record's group is not read: it is reported, not confirmed.
      expect(cribl.sent).toEqual([{ method: "GET", path: "/system/inputs", groupId: "grp-a" }]);
    });

    it("an unclaimed legacy record is shown with no tenant named", async () => {
      const row = await scanTenantGap(
        ports({ documents: new Docs({ [progressKey]: progressWithEntraRecord(), [ONBOARDING_PROGRESS_KEY]: legacyWithActivity() }) }),
        PROFILE,
      );
      const activity = row.cells.find((c) => c.sourceId === "activityLog")!;
      expect(activity.cribl.state).toBe("unknown");
      expect(activity.cribl.reason).toContain("with no tenant named");
      expect(row.warnings[0]).toContain("with no tenant named");
    });

    it("a legacy record claimed by ANOTHER tenant is never shown here", async () => {
      const row = await scanTenantGap(
        ports({
          documents: new Docs({
            [progressKey]: progressWithEntraRecord(),
            [ONBOARDING_PROGRESS_KEY]: legacyWithActivity(),
            [claimKey]: { kind: "value", value: tenantMigrationMarker("99999999-0000-0000-0000-000000000000") },
          }),
        }),
        PROFILE,
      );
      expect(row.cells.find((c) => c.sourceId === "activityLog")!.cribl.state).toBe("red");
      expect(row.warnings).toEqual([]);
    });

    it("an unreadable legacy key is could-not-check: no-record cells unknown, never red", async () => {
      const docs = new Docs({
        [progressKey]: progressWithEntraRecord(),
        [ONBOARDING_PROGRESS_KEY]: { kind: "unknown", reason: "HTTP 503" },
      });
      const cribl = criblAnswering([{ id: RECORD.inputId, type: "eventhub" }]);
      const row = await scanTenantGap(ports({ cribl, documents: docs }), PROFILE);
      expect(row.cells.filter((c) => c.cribl.state === "red")).toEqual([]);
      expect(row.cells.filter((c) => c.cribl.state === "unknown").length).toBe(GAP_SOURCES.length - 1);
      const activity = row.cells.find((c) => c.sourceId === "activityLog")!;
      expect(activity.cribl.reason).toContain("could not be checked");
      expect(activity.cribl.reason).toContain("HTTP 503");
      expect(row.cells.find((c) => c.sourceId === "entraId")!.cribl.state).toBe("green");
      expect(row.warnings.join(" ")).toContain(
        "could not be checked (the earlier single-tenant copy could not be read (HTTP 503))",
      );
      expect(docs.saves).toEqual([]);
    });

    it("a legacy load that throws is could-not-check too", async () => {
      const docs = new Docs({ [progressKey]: progressWithEntraRecord() });
      const load = docs.load.bind(docs);
      docs.load = (key: string) =>
        key === ONBOARDING_PROGRESS_KEY ? Promise.reject(new Error("socket hang up")) : load(key);
      const row = await scanTenantGap(ports({ documents: docs }), PROFILE);
      expect(row.cells.filter((c) => c.cribl.state === "red")).toEqual([]);
      expect(row.warnings.join(" ")).toContain("socket hang up");
    });

    it("a legacy record matching the tenant's own (input AND group) is not reported", async () => {
      const row = await scanTenantGap(
        ports({
          documents: new Docs({
            [progressKey]: progressWithEntraRecord(),
            [ONBOARDING_PROGRESS_KEY]: progressWithEntraRecord(),
            [claimKey]: { kind: "value", value: tenantMigrationMarker(TENANT) },
          }),
        }),
        PROFILE,
      );
      expect(row.warnings).toEqual([]);
      expect(row.cells.find((c) => c.sourceId === "activityLog")!.cribl.state).toBe("red");
    });
  });
});
