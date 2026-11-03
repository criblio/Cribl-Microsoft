import { describe, expect, it } from "vitest";

import { compareTenant, HEARTBEAT_QUERY, readDataAllowances } from "./data-allowances";
import type { DataAllowances, GrantView } from "./data-allowances";
import { workspaceArmId } from "../workspace-inventory/workspace-inventory";
import type { WorkspaceInventory } from "../workspace-inventory/workspace-inventory";
import { INVENTORY_TIMESPAN, INVENTORY_WINDOW_DAYS } from "../../domain/workspace-inventory";
import { WINDOW_FILTER } from "../../domain/workspace-inventory/workspace-inventory";
import { BENEFIT_QUERY } from "../../domain/data-allowances/benefit-usage";
import { E5_QUALIFYING_SKUS } from "../../domain/data-allowances/allowance-catalog";
import type { AzureManagement, AzureManagementRequest } from "../../ports/azure-management";
import type { GraphDirectory } from "../../ports/graph-directory";
import type { PortHttpResponse } from "../../ports/http";
import { GRAPH_PERMISSIONS } from "../../domain/app-permissions/app-permissions";

const WS = workspaceArmId("sub-1", "rg-1", "law-1");
const WS2 = workspaceArmId("sub-1", "rg-1", "law-2");
const E5_SKU = E5_QUALIFYING_SKUS.find((s) => s.skuPartNumber === "SPE_E5")!;

const OPTS = { readAt: "2026-11-03T00:00:00Z", sentinelWorkspaces: 1 as number | null };

function inventory(
  billableDailyAverageMB: number,
  workspaceId = WS,
  usageWarning: string | null = null,
): WorkspaceInventory {
  return { workspaceId, usageWarning, totals: { billableDailyAverageMB } } as unknown as WorkspaceInventory;
}

function queryResult(columns: string[], rows: unknown[][]): PortHttpResponse {
  return {
    status: 200,
    body: { tables: [{ name: "PrimaryResult", columns: columns.map((name) => ({ name })), rows }] },
  };
}
const benefit = (...rows: Array<[string, string, number]>) =>
  queryResult(["Day", "BenefitType", "BenefitUsedGB"], rows);
const eligible = (...rows: Array<[string, string, number]>) =>
  queryResult(["Day", "DataType", "EligibleMB"], rows);
/** Thirty consecutive days, the window's length; the dates themselves do not matter. */
const WINDOW_DAYS = Array.from({ length: INVENTORY_WINDOW_DAYS }, (_, i) =>
  new Date(Date.UTC(2026, 9, 4 + i)).toISOString().slice(0, 10),
);
/** Each machine reports on every day of the window. */
const heartbeat = (...rows: Array<[string, string]>) =>
  queryResult(
    ["Day", "Computer", "SubscriptionId"],
    rows.flatMap(([computer, sub]) => WINDOW_DAYS.map((day) => [day, computer, sub])),
  );
/** Explicit machine-days: [day, computer, subscription]. */
const heartbeatDays = (...rows: Array<[string, string, string]>) =>
  queryResult(["Day", "Computer", "SubscriptionId"], rows);
/** An answer Log Analytics returned with a partial-result error beside the rows. */
const partial = (r: PortHttpResponse): PortHttpResponse => ({
  status: 200,
  body: { ...(r.body as object), error: { code: "PartialError", message: "query result truncated" } },
});
const DENIED: PortHttpResponse = { status: 403, body: { error: { code: "AuthorizationFailed" } } };
const pricings = (tier: string, subPlan: string): PortHttpResponse => ({
  status: 200,
  body: { value: [{ name: "VirtualMachines", properties: { pricingTier: tier, subPlan } }] },
});

interface Script {
  /** Keyed by workspace id; defaults apply to every workspace not listed. */
  benefit?: Record<string, PortHttpResponse>;
  eligible?: PortHttpResponse;
  heartbeat?: PortHttpResponse;
  pricings?: Record<string, PortHttpResponse>;
  graph?: PortHttpResponse;
  tables?: PortHttpResponse;
}

/** Routes by what the request IS, so the tests do not depend on call order. */
function routedAzure(script: Script) {
  const calls: AzureManagementRequest[] = [];
  const azure: AzureManagement = {
    async request(opts) {
      calls.push(opts);
      if (opts.path.endsWith("/query")) {
        const ws = opts.path.slice(0, -"/query".length);
        const q = String((opts.body as { query: string }).query);
        if (q.startsWith("Operation")) {
          return script.benefit?.[ws] ?? script.benefit?.["*"] ?? benefit();
        }
        if (q.startsWith("Usage")) return script.eligible ?? eligible();
        if (q.startsWith("Heartbeat")) return script.heartbeat ?? heartbeat();
      }
      if (opts.path.endsWith("/tables")) return script.tables ?? DENIED;
      if (opts.path.endsWith("/providers/Microsoft.Security/pricings")) {
        const sub = opts.path.split("/")[2]!;
        return script.pricings?.[sub] ?? pricings("Free", "");
      }
      if (opts.path === "/providers/Microsoft.ResourceGraph/resources") {
        return script.graph ?? { status: 200, body: { data: [] } };
      }
      throw new Error(`unrouted request ${opts.method} ${opts.path}`);
    },
  };
  return { azure, calls };
}

function graphWith(
  result: Awaited<ReturnType<GraphDirectory["readSubscribedSkus"]>>,
): GraphDirectory {
  return {
    async listServicePrincipals() {
      return [];
    },
    async readSubscribedSkus() {
      return result;
    },
  };
}

function skusBody(...skus: Array<{ enabled: number; consumed: number; skuId?: string; part?: string }>) {
  return {
    kind: "read" as const,
    body: {
      value: skus.map((s) => ({
        skuId: s.skuId ?? E5_SKU.skuId,
        skuPartNumber: s.part ?? E5_SKU.skuPartNumber,
        capabilityStatus: "Enabled",
        appliesTo: "User",
        consumedUnits: s.consumed,
        prepaidUnits: { enabled: s.enabled, warning: 0, suspended: 0, lockedOut: 0 },
      })),
    },
  };
}

const view = (r: DataAllowances, grant: GrantView["grant"]): GrantView => {
  const found = r.grants.find((g) => g.grant === grant);
  if (found === undefined) throw new Error(`no ${grant} view`);
  return found;
};

describe("GRAPH_PERMISSIONS", () => {
  it("names exactly the directory read and the licence read, both optional features", () => {
    expect(GRAPH_PERMISSIONS.map((p) => p.name)).toEqual([
      "Application.Read.All",
      "LicenseAssignment.Read.All",
    ]);
    expect(GRAPH_PERMISSIONS.map((p) => p.necessity)).toEqual(["feature", "feature"]);
  });
});

describe("readDataAllowances - the calls it makes", () => {
  it("posts the benefit query, then eligible, then Heartbeat, one pricings GET per subscription, one Resource Graph POST", async () => {
    const { azure, calls } = routedAzure({
      heartbeat: heartbeat(["vm1", "sub-a"], ["vm2", "sub-b"], ["vm3", "sub-b"]),
    });
    await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);

    expect(calls[0]).toMatchObject({ method: "POST", path: `${WS}/query` });
    expect(calls[0]!.body).toEqual({ query: BENEFIT_QUERY, timespan: INVENTORY_TIMESPAN });
    expect(String((calls[1]!.body as { query: string }).query)).toMatch(/^Usage/);
    expect((calls[1]!.body as { timespan: string }).timespan).toBe(INVENTORY_TIMESPAN);
    expect(String((calls[2]!.body as { query: string }).query)).toMatch(/^Heartbeat/);
    const rest = calls.slice(3);
    expect(
      rest.filter((c) => c.path.endsWith("/providers/Microsoft.Security/pricings")).map((c) => c.path),
    ).toEqual([
      "/subscriptions/sub-a/providers/Microsoft.Security/pricings",
      "/subscriptions/sub-b/providers/Microsoft.Security/pricings",
    ]);
    const graph = rest.filter((c) => c.path === "/providers/Microsoft.ResourceGraph/resources");
    expect(graph).toHaveLength(1);
    expect(graph[0]!.method).toBe("POST");
    expect((graph[0]!.body as { subscriptions: string[] }).subscriptions).toEqual(["sub-a", "sub-b"]);
    expect(rest.filter((c) => c.path === `${WS}/tables`)).toHaveLength(1);
    expect(rest).toHaveLength(4);
  });

  it("makes no pricings or Resource Graph call when no machine reported", async () => {
    const { azure, calls } = routedAzure({});
    await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(calls.map((c) => c.path)).toEqual([`${WS}/query`, `${WS}/query`, `${WS}/query`, `${WS}/tables`]);
  });
});

describe("readDataAllowances - licences", () => {
  const DAY = "2026-10-20";
  const e5Script: Script = {
    benefit: { "*": benefit([DAY, "M365 E5", 2]) },
    eligible: eligible([DAY, "SigninLogs", 3000]),
  };

  it("graph undefined -> not-bound, E5 granted is the largest applied day, as a floor", async () => {
    const { azure } = routedAzure(e5Script);
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(r.licences).toEqual({ kind: "not-bound" });
    expect(view(r, "e5")).toMatchObject({ grantedMB: 2000, grantedIsFloor: true });
    expect(view(r, "e5").crossCheck.kind).toBe("skipped");
  });

  it("denied -> denied, granted = maxUsedDayMB as a floor, cross-check skipped for seat counts", async () => {
    const { azure } = routedAzure(e5Script);
    const graph = graphWith({ kind: "denied", status: 403, detail: "needs LicenseAssignment.Read.All" });
    const r = await readDataAllowances(azure, graph, WS, inventory(0), OPTS);
    expect(r.licences).toEqual({ kind: "denied", detail: "needs LicenseAssignment.Read.All" });
    const e5 = view(r, "e5");
    expect(e5.grantedMB).toBe(e5.usage.maxUsedDayMB);
    expect(e5.grantedIsFloor).toBe(true);
    expect(e5.crossCheck).toMatchObject({ kind: "skipped" });
    expect((e5.crossCheck as { reason: string }).reason).toMatch(/seat counts/);
  });

  it("a transport failure of the Graph read is denied with the error text, not a throw", async () => {
    const { azure } = routedAzure(e5Script);
    const graph: GraphDirectory = {
      async listServicePrincipals() {
        return [];
      },
      async readSubscribedSkus() {
        throw new Error("socket hang up");
      },
    };
    const r = await readDataAllowances(azure, graph, WS, inventory(0), OPTS);
    expect(r.licences).toEqual({ kind: "denied", detail: "socket hang up" });
  });

  it("read licences give the assigned-seat figure and a matched cross-check on a capped day", async () => {
    // 100 assigned seats = 500 MB/day; 120 purchased = 600. The capped day used 0.5 GB.
    const { azure } = routedAzure({
      benefit: { "*": benefit([DAY, "M365 E5", 0.5]) },
      eligible: eligible([DAY, "SigninLogs", 900]),
    });
    const graph = graphWith(skusBody({ enabled: 120, consumed: 100 }));
    const r = await readDataAllowances(azure, graph, WS, inventory(0), OPTS);
    const e5 = view(r, "e5");
    expect(r.licences.kind).toBe("read");
    expect(e5.grantedMB).toBe(500);
    expect(e5.grantedIsFloor).toBe(false);
    expect(e5.crossCheck).toMatchObject({ kind: "matched", basis: "assigned", medianMB: 500 });
  });

  it("a possibly-missing SKU makes E5 granted a floor but the cross-check is still computed", async () => {
    const { azure } = routedAzure({
      benefit: { "*": benefit([DAY, "M365 E5", 0.5]) },
      eligible: eligible([DAY, "SigninLogs", 900]),
    });
    const graph = graphWith(
      skusBody(
        { enabled: 120, consumed: 100 },
        { enabled: 50, consumed: 40, skuId: "00000000-0000-0000-0000-000000000000", part: "SOMETHING_E5_NEW" },
      ),
    );
    const r = await readDataAllowances(azure, graph, WS, inventory(0), OPTS);
    const e5 = view(r, "e5");
    expect(e5.grantedIsFloor).toBe(true);
    expect(e5.grantedMB).toBe(500);
    expect(e5.crossCheck).toMatchObject({ kind: "matched", basis: "assigned" });
  });

  it("several Sentinel workspaces skip every cross-check, naming how many", async () => {
    const { azure } = routedAzure({
      benefit: { "*": benefit([DAY, "M365 E5", 0.5]) },
      eligible: eligible([DAY, "SigninLogs", 900]),
    });
    const graph = graphWith(skusBody({ enabled: 120, consumed: 100 }));
    const r = await readDataAllowances(azure, graph, WS, inventory(0), { ...OPTS, sentinelWorkspaces: 2 });
    expect(r.grants.length).toBeGreaterThan(0);
    for (const g of r.grants) {
      expect(g.crossCheck.kind).toBe("skipped");
      expect((g.crossCheck as { reason: string }).reason).toMatch(/2 Sentinel workspaces/);
    }
    expect(r.scope).toEqual({ kind: "workspace", sentinelWorkspaces: 2 });
  });

  it("an unknown Sentinel workspace count skips the cross-check even with seats read and a capped day", async () => {
    const { azure } = routedAzure({
      benefit: { "*": benefit([DAY, "M365 E5", 0.5]) },
      eligible: eligible([DAY, "SigninLogs", 900]),
    });
    const graph = graphWith(skusBody({ enabled: 120, consumed: 100 }));
    const r = await readDataAllowances(azure, graph, WS, inventory(0), { ...OPTS, sentinelWorkspaces: null });
    expect(view(r, "e5").usage.cappedDays).toHaveLength(1);
    expect(view(r, "e5").crossCheck).toEqual({
      kind: "skipped",
      reason: expect.stringMatching(/number of Sentinel workspaces .* unknown/),
    });
  });
});

describe("readDataAllowances - Servers P2", () => {
  const DAY = "2026-10-20";
  const base: Script = {
    benefit: { "*": benefit([DAY, "Defender for Servers", 1]) },
    eligible: eligible([DAY, "SecurityEvent", 1000]),
  };

  it("a 403 pricings answer is not-read, never off, and the granted figure is a floor", async () => {
    const { azure } = routedAzure({
      ...base,
      heartbeat: heartbeat(["vm1", "sub-a"], ["vm2", "sub-b"]),
      pricings: { "sub-a": DENIED, "sub-b": pricings("Standard", "P2") },
      graph: { status: 200, body: { data: [{ subscriptionId: "sub-b", Machines: 4 }] } },
    });
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(r.servers.rows).toEqual([
      { subscriptionId: "sub-a", plan: "not-read", machinesInSubscription: null, machinesReportingHere: 1 },
      { subscriptionId: "sub-b", plan: "P2", machinesInSubscription: 4, machinesReportingHere: 1 },
    ]);
    expect(view(r, "servers-p2")).toMatchObject({ grantedMB: 500, grantedIsFloor: true });
  });

  it("grantedMB is null, not 0, when no subscription's pricings could be read", async () => {
    const { azure } = routedAzure({
      ...base,
      heartbeat: heartbeat(["vm1", "sub-a"]),
      pricings: { "sub-a": DENIED },
    });
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(view(r, "servers-p2").grantedMB).toBeNull();
    expect(view(r, "servers-p2").crossCheck.kind).toBe("skipped");
  });

  it("grantedMB is null, not 0, when Heartbeat reported no machines at all", async () => {
    const { azure } = routedAzure({ ...base, heartbeat: heartbeat() });
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(r.servers.rows).toEqual([]);
    expect(view(r, "servers-p2").grantedMB).toBeNull();
  });

  it("grantedMB is 0 only when every subscription was read and none has P2", async () => {
    const { azure } = routedAzure({
      ...base,
      heartbeat: heartbeat(["vm1", "sub-a"]),
      pricings: { "sub-a": pricings("Standard", "P1") },
    });
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(r.servers.rows[0]!.plan).toBe("P1");
    expect(view(r, "servers-p2")).toMatchObject({ grantedMB: 0, grantedIsFloor: false });
  });

  it("a failed Heartbeat read is a stated gap and an unknown granted figure", async () => {
    const { azure } = routedAzure({ ...base, heartbeat: DENIED });
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(r.gaps.join("\n")).toMatch(/Reporting machines .* not read/);
    expect(view(r, "servers-p2").grantedMB).toBeNull();
    // Never "no reporting machines were found": the read did not happen.
    expect(r.servers.heartbeatComplete).toBe(false);
    expect(view(r, "servers-p2").crossCheck).toEqual({
      kind: "skipped",
      reason: "Cross-check skipped: reporting machines were not read.",
    });
  });

  it("an answered, empty Heartbeat says no reporting machines were found", async () => {
    const { azure } = routedAzure({ ...base, heartbeat: heartbeat() });
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(r.servers.heartbeatComplete).toBe(true);
    expect(view(r, "servers-p2").crossCheck).toEqual({
      kind: "skipped",
      reason: "Cross-check skipped: no reporting machines were found.",
    });
  });

  it("a PARTIAL Heartbeat answer is a gap, floors Granted and skips the cross-check", async () => {
    const { azure } = routedAzure({
      benefit: { "*": benefit([DAY, "Defender for Servers", 0.5]) },
      eligible: eligible([DAY, "SecurityEvent", 1000]),
      heartbeat: partial(heartbeat(["vm1", "sub-a"])),
      pricings: { "sub-a": pricings("Standard", "P2") },
    });
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(r.gaps.join("\n")).toMatch(/reporting machines read was partial: query result truncated/);
    expect(r.servers.heartbeatComplete).toBe(false);
    expect(view(r, "servers-p2")).toMatchObject({ grantedMB: 500, grantedIsFloor: true });
    expect(view(r, "servers-p2").crossCheck).toEqual({
      kind: "skipped",
      reason: expect.stringMatching(/reporting machines were only partly read/),
    });
  });

  it("counts machines per day: thirty one-day machines earn one machine's daily grant, not thirty", async () => {
    const { azure } = routedAzure({
      ...base,
      heartbeat: heartbeatDays(...WINDOW_DAYS.map((d, i): [string, string, string] => [d, `vm${i}`, "sub-a"])),
      pricings: { "sub-a": pricings("Standard", "P2") },
    });
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(r.servers.rows[0]!.machinesReportingHere).toBe(1);
    expect(view(r, "servers-p2").grantedMB).toBe(500);
  });

  it("the cross-check compares a capped day with THAT day's machines (reporting-here basis)", async () => {
    // 1 machine every day, plus 3 more on the capped day only: that day grants 2000 MB.
    const { azure } = routedAzure({
      benefit: { "*": benefit([DAY, "Defender for Servers", 2]) },
      eligible: eligible([DAY, "SecurityEvent", 3000]),
      heartbeat: heartbeatDays(
        ...WINDOW_DAYS.map((d): [string, string, string] => [d, "vm0", "sub-a"]),
        [DAY, "vm1", "sub-a"],
        [DAY, "vm2", "sub-a"],
        [DAY, "vm3", "sub-a"],
      ),
      pricings: { "sub-a": pricings("Standard", "P2") },
      graph: { status: 200, body: { data: [{ subscriptionId: "sub-a", Machines: 9 }] } },
    });
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(view(r, "servers-p2").crossCheck).toEqual({ kind: "matched", basis: "reporting-here", medianMB: 2000 });
  });

  it("matches the reporting-here basis when Microsoft applied 500 MB for one machine reporting here", async () => {
    const { azure } = routedAzure({
      benefit: { "*": benefit([DAY, "Defender for Servers", 0.5]) },
      eligible: eligible([DAY, "SecurityEvent", 1000]),
      heartbeat: heartbeat(["vm1", "sub-a"]),
      pricings: { "sub-a": pricings("Standard", "P2") },
      graph: { status: 200, body: { data: [{ subscriptionId: "sub-a", Machines: 4 }] } },
    });
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(view(r, "servers-p2").crossCheck).toEqual({ kind: "matched", basis: "reporting-here", medianMB: 500 });
  });

  it("matches the in-subscription basis when Microsoft applied 2.0 GB for the subscription's 4 machines", async () => {
    const { azure } = routedAzure({
      benefit: { "*": benefit([DAY, "Defender for Servers", 2]) },
      eligible: eligible([DAY, "SecurityEvent", 3000]),
      heartbeat: heartbeat(["vm1", "sub-a"]),
      pricings: { "sub-a": pricings("Standard", "P2") },
      graph: { status: 200, body: { data: [{ subscriptionId: "sub-a", Machines: 4 }] } },
    });
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(view(r, "servers-p2").crossCheck).toEqual({ kind: "matched", basis: "in-subscription", medianMB: 2000 });
  });

  it("freezes the Heartbeat query: its output columns are what machinesOf reads (Day, Computer, SubscriptionId)", async () => {
    expect(HEARTBEAT_QUERY).toBe(
      [
        "Heartbeat",
        `| where ${WINDOW_FILTER}`,
        "| summarize by Day = format_datetime(startofday(TimeGenerated), 'yyyy-MM-dd'), Computer,",
        "    SubscriptionId = tostring(_SubscriptionId)",
      ].join("\n"),
    );
    const { azure } = routedAzure({});
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(r.queries.heartbeat).toBe(HEARTBEAT_QUERY);
  });

  it("a Resource Graph failure leaves machinesInSubscription null and says so", async () => {
    const { azure } = routedAzure({
      ...base,
      heartbeat: heartbeat(["vm1", "sub-a"]),
      pricings: { "sub-a": pricings("Standard", "P2") },
      graph: DENIED,
    });
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(r.servers.rows[0]!.machinesInSubscription).toBeNull();
    expect(r.gaps.join("\n")).toMatch(/Machines per subscription were not counted/);
  });

  it("counts a machine with no subscription as unattributed and never adds it to the figure", async () => {
    const { azure } = routedAzure({
      ...base,
      heartbeat: heartbeat(["vm1", "sub-a"], ["onprem", ""]),
      pricings: { "sub-a": pricings("Standard", "P2") },
    });
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(r.servers.unattributedMachines).toBe(1);
    expect(view(r, "servers-p2").grantedMB).toBe(500);
  });
});

describe("readDataAllowances - table plans", () => {
  const DAY = "2026-10-20";
  const script: Script = {
    benefit: { "*": benefit([DAY, "M365 E5", 1]) },
    eligible: eligible([DAY, "SigninLogs", 1500], [DAY, "AuditLogs", 600]),
  };

  it("reads the plans with one GET and attaches them, with Cribl writability", async () => {
    const { azure, calls } = routedAzure({
      ...script,
      tables: {
        status: 200,
        body: {
          value: [
            { name: "SigninLogs", properties: { plan: "Analytics" } },
            { name: "AuditLogs", properties: { plan: "Basic" } },
          ],
        },
      },
    });
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    const gets = calls.filter((c) => c.path === `${WS}/tables`);
    expect(gets).toHaveLength(1);
    expect(gets[0]).toMatchObject({ method: "GET", apiVersion: "2022-10-01" });
    expect(view(r, "e5").eligibleTables).toEqual([
      { table: "SigninLogs", eligibleDailyMB: 50, plan: "Analytics", criblWritable: "no" },
      { table: "AuditLogs", eligibleDailyMB: 20, plan: "Basic", criblWritable: "no" },
    ]);
    expect(r.queries.tables).toBe(`${WS}/tables`);
  });

  it("a 403 tables read leaves every plan null, never Analytics, and is a stated gap", async () => {
    const { azure } = routedAzure({ ...script, tables: DENIED });
    const r = await readDataAllowances(azure, undefined, WS, inventory(0), OPTS);
    expect(view(r, "e5").eligibleTables.map((t) => t.plan)).toEqual([null, null]);
    expect(r.gaps.join("\n")).toMatch(/Table plans were not read/);
  });
});

describe("readDataAllowances - the numbers", () => {
  const DAY = "2026-10-20";

  it("no benefit rows and no eligible tables -> no grants and nothing is subtracted", async () => {
    const { azure } = routedAzure({});
    const r = await readDataAllowances(azure, undefined, WS, inventory(1234), OPTS);
    expect(r.grants).toEqual([]);
    expect(r.pooled).toBeNull();
    expect(r.attribution).toBe("per-grant");
    expect(r.afterAllowancesDailyMB).toBe(1234);
  });

  it("subtracts the benefit applied from billable and floors at zero", async () => {
    const script: Script = {
      benefit: { "*": benefit([DAY, "M365 E5", 3]) },
      eligible: eligible([DAY, "SigninLogs", 6000]),
    };
    const a = await readDataAllowances(routedAzure(script).azure, undefined, WS, inventory(500), OPTS);
    // used 3000 MB over a 30 day window = 100 MB/day
    expect(view(a, "e5").usage.usedDailyMB).toBe(100);
    expect(a.afterAllowancesDailyMB).toBe(400);
    const b = await readDataAllowances(routedAzure(script).azure, undefined, WS, inventory(60), OPTS);
    expect(b.afterAllowancesDailyMB).toBe(0);
  });

  it("a grant with eligible volume but no benefit still gets a view; one with neither does not", async () => {
    const { azure } = routedAzure({ eligible: eligible([DAY, "SigninLogs", 300]) });
    const r = await readDataAllowances(azure, undefined, WS, inventory(10), OPTS);
    expect(r.grants.map((g) => g.grant)).toEqual(["e5"]);
    expect(view(r, "e5").usage.usedDailyMB).toBe(0);
  });

  it("a benefit with no eligible volume still gets a view", async () => {
    const { azure } = routedAzure({ benefit: { "*": benefit([DAY, "M365 E5", 1]) } });
    const r = await readDataAllowances(azure, undefined, WS, inventory(10), OPTS);
    expect(r.grants.map((g) => g.grant)).toEqual(["e5"]);
  });

  it("a failed Operation read throws; a failed eligible read is a stated gap", async () => {
    await expect(
      readDataAllowances(routedAzure({ benefit: { "*": DENIED } }).azure, undefined, WS, inventory(0), OPTS),
    ).rejects.toThrow(/HTTP 403/);
    const r = await readDataAllowances(
      routedAzure({ benefit: { "*": benefit([DAY, "M365 E5", 1]) }, eligible: DENIED }).azure,
      undefined,
      WS,
      inventory(0),
      OPTS,
    );
    expect(r.gaps.join("\n")).toMatch(/Eligible volume .* not read/);
    // The VIEW says unknown: not zero eligible, and not "no capped day".
    const e5 = view(r, "e5");
    expect(e5.eligibleKnown).toBe(false);
    expect(e5.crossCheck.kind).toBe("skipped");
    expect((e5.crossCheck as { reason: string }).reason).toMatch(/eligible volume not read/);
  });

  it("eligibleKnown is true when the eligible read succeeded", async () => {
    const { azure } = routedAzure({
      benefit: { "*": benefit([DAY, "M365 E5", 1]) },
      eligible: eligible([DAY, "SigninLogs", 900]),
    });
    const r = await readDataAllowances(azure, graphWith(skusBody({ enabled: 1, consumed: 1 })), WS, inventory(0), OPTS);
    expect(view(r, "e5").eligibleKnown).toBe(true);
  });

  it("a PARTIAL benefit answer makes Used a floor and skips the cross-check, with a stated gap", async () => {
    const script: Script = {
      benefit: { "*": partial(benefit([DAY, "M365 E5", 0.5])) },
      eligible: eligible([DAY, "SigninLogs", 900]),
    };
    const graph = graphWith(skusBody({ enabled: 120, consumed: 100 }));
    const r = await readDataAllowances(routedAzure(script).azure, graph, WS, inventory(0), OPTS);
    expect(r.usedIsFloor).toBe(true);
    expect(r.gaps.join("\n")).toMatch(/benefit read was partial/);
    expect(view(r, "e5").crossCheck).toEqual({
      kind: "skipped",
      reason: expect.stringMatching(/benefit read \(Operation\) was partial/),
    });
    const complete = await readDataAllowances(
      routedAzure({ ...script, benefit: { "*": benefit([DAY, "M365 E5", 0.5]) } }).azure,
      graph,
      WS,
      inventory(0),
      OPTS,
    );
    expect(complete.usedIsFloor).toBe(false);
    expect(view(complete, "e5").crossCheck.kind).toBe("matched");
  });

  it("sumsAreFloors follows a partial Usage answer in workspace scope", async () => {
    const a = await readDataAllowances(routedAzure({}).azure, undefined, WS, inventory(0, WS, "Usage was partial"), OPTS);
    expect(a.sumsAreFloors).toBe(true);
    const b = await readDataAllowances(routedAzure({}).azure, undefined, WS, inventory(0), OPTS);
    expect(b.sumsAreFloors).toBe(false);
  });
});

describe("readDataAllowances - pooled attribution", () => {
  const DAY = "2026-10-20";
  const script: Script = {
    benefit: {
      "*": benefit([DAY, "M365 E5", 1], [DAY, "Mystery benefit", 2], ["2026-10-21", "Mystery benefit", 3]),
    },
    eligible: eligible([DAY, "SigninLogs", 4000], [DAY, "SecurityEvent", 1000], ["2026-10-21", "SecurityEvent", 5000]),
  };

  it("lists a view per grant with eligible volume, skips the cross-check, and pools usage", async () => {
    const graph = graphWith(skusBody({ enabled: 100, consumed: 100 }));
    const r = await readDataAllowances(routedAzure(script).azure, graph, WS, inventory(900), OPTS);
    expect(r.attribution).toBe("pooled");
    expect(r.grants.map((g) => g.grant)).toEqual(["e5", "servers-p2"]);
    for (const g of r.grants) {
      expect(g.usage.usedDailyMB).toBe(0);
      expect(g.usage.usedByDay.size).toBe(0);
      expect(g.crossCheck.kind).toBe("skipped");
      expect((g.crossCheck as { reason: string }).reason).toMatch(/Mystery benefit/);
    }
    // eligible 4000 + 1000 + 5000 = 10000 MB; applied 1000 + 2000 + 3000 = 6000 MB
    expect(r.pooled).not.toBeNull();
    expect(r.pooled!.eligibleDailyMB).toBeCloseTo(10000 / 30);
    expect(r.pooled!.usedDailyMB).toBeCloseTo(6000 / 30);
    expect(r.pooled!.usedByDay.get(DAY)).toBe(3000);
    expect(r.afterAllowancesDailyMB).toBeCloseTo(900 - 6000 / 30);
    expect(r.eligibleKnown).toBe(true);
  });

  it("a failed eligible read leaves no grant view and says eligible is not known, never zero", async () => {
    const r = await readDataAllowances(
      routedAzure({ benefit: script.benefit, eligible: DENIED }).azure,
      undefined,
      WS,
      inventory(900),
      OPTS,
    );
    expect(r.attribution).toBe("pooled");
    // Pooled: no per-grant used volume, and no eligible volume seen -> no views.
    expect(r.grants).toEqual([]);
    expect(r.eligibleKnown).toBe(false);
    expect(r.pooled).not.toBeNull();
  });
});

describe("compareTenant", () => {
  const DAY = "2026-10-20";

  it("sums every readable workspace and lists the one that refused as not read, flagging the sums", async () => {
    const { azure } = routedAzure({
      benefit: { [WS]: benefit([DAY, "M365 E5", 1]), [WS2]: DENIED },
      eligible: eligible([DAY, "SigninLogs", 2000]),
    });
    const graph = graphWith(skusBody({ enabled: 100, consumed: 100 }));
    const r = await compareTenant(
      azure,
      graph,
      [WS, WS2],
      new Map([
        [WS, inventory(300, WS)],
        [WS2, inventory(700, WS2)],
      ]),
      { readAt: OPTS.readAt },
    );
    expect(r.scope.kind).toBe("tenant");
    if (r.scope.kind !== "tenant") throw new Error("unreachable");
    expect(r.scope.workspaces).toEqual([WS, WS2]);
    expect(r.scope.notRead).toHaveLength(1);
    expect(r.scope.notRead[0]!.id).toBe(WS2);
    expect(r.scope.notRead[0]!.error).toMatch(/HTTP 403/);
    // E5 seat counts are tenant-wide and were read: an unread workspace does not floor them.
    expect(view(r, "e5").grantedIsFloor).toBe(false);
    expect(r.sumsAreFloors).toBe(true);
    expect(r.queries.tables).toBeNull();
    expect(r.gaps).toContain("Table plans are not read in a tenant comparison.");
    // Billable sums only the workspace that was read; used 1000 MB / 30.
    expect(r.afterAllowancesDailyMB).toBeCloseTo(300 - 1000 / 30);
    // A partial sum is never cross-checked.
    for (const g of r.grants) {
      expect(g.crossCheck.kind).toBe("skipped");
      expect((g.crossCheck as { reason: string }).reason).toMatch(/1 workspace was not read/);
    }
  });

  it("sums benefit and eligible volume across workspaces and counts a shared machine once", async () => {
    const { azure } = routedAzure({
      benefit: { "*": benefit([DAY, "M365 E5", 1]) },
      eligible: eligible([DAY, "SigninLogs", 2000]),
      heartbeat: heartbeat(["vm1", "sub-a"]),
      pricings: { "sub-a": pricings("Standard", "P2") },
    });
    const r = await compareTenant(
      azure,
      undefined,
      [WS, WS2],
      new Map([
        [WS, inventory(300, WS)],
        [WS2, inventory(700, WS2)],
      ]),
      { readAt: OPTS.readAt },
    );
    expect(view(r, "e5").usage.usedByDay.get(DAY)).toBe(2000);
    expect(view(r, "e5").usage.eligibleByDay.get(DAY)).toBe(4000);
    expect(r.servers.rows[0]!.machinesReportingHere).toBe(1);
    expect(r.afterAllowancesDailyMB).toBeCloseTo(1000 - 2000 / 30);
    expect(view(r, "e5").grantedIsFloor).toBe(true); // licences not bound: floor from usage
    expect(r.sumsAreFloors).toBe(false);
  });

  it("an unread workspace floors the Servers granted figure but not the E5 one", async () => {
    const { azure } = routedAzure({
      benefit: { [WS]: benefit([DAY, "M365 E5", 1], [DAY, "Defender for Servers", 1]), [WS2]: DENIED },
      eligible: eligible([DAY, "SigninLogs", 2000], [DAY, "SecurityEvent", 2000]),
      heartbeat: heartbeat(["vm1", "sub-a"]),
      pricings: { "sub-a": pricings("Standard", "P2") },
    });
    const r = await compareTenant(
      azure,
      graphWith(skusBody({ enabled: 100, consumed: 100 })),
      [WS, WS2],
      new Map([
        [WS, inventory(300, WS)],
        [WS2, inventory(700, WS2)],
      ]),
      { readAt: OPTS.readAt },
    );
    expect(view(r, "e5")).toMatchObject({ grantedMB: 500, grantedIsFloor: false });
    expect(view(r, "servers-p2")).toMatchObject({ grantedMB: 500, grantedIsFloor: true });
  });

  it("runs the E5 cross-check tenant-wide when every workspace was read, and skips Servers P2 (capped per workspace)", async () => {
    // 100 assigned seats = 500 MB/day; each workspace applied 250 MB on a capped day.
    const { azure } = routedAzure({
      benefit: {
        [WS]: benefit([DAY, "M365 E5", 0.25], [DAY, "Defender for Servers", 0.5]),
        [WS2]: benefit([DAY, "M365 E5", 0.25], [DAY, "Defender for Servers", 0.5]),
      },
      eligible: eligible([DAY, "SigninLogs", 900], [DAY, "SecurityEvent", 1000]),
      heartbeat: heartbeat(["vm1", "sub-a"]),
      pricings: { "sub-a": pricings("Standard", "P2") },
    });
    const r = await compareTenant(
      azure,
      graphWith(skusBody({ enabled: 120, consumed: 100 })),
      [WS, WS2],
      new Map([
        [WS, inventory(300, WS)],
        [WS2, inventory(700, WS2)],
      ]),
      { readAt: OPTS.readAt },
    );
    if (r.scope.kind !== "tenant") throw new Error("unreachable");
    expect(r.scope.notRead).toEqual([]);
    expect(view(r, "e5").crossCheck).toEqual({ kind: "matched", basis: "assigned", medianMB: 500 });
    expect(view(r, "servers-p2").usage.cappedDays).toHaveLength(1);
    expect(view(r, "servers-p2").crossCheck).toEqual({
      kind: "skipped",
      reason: expect.stringMatching(/capped per workspace/),
    });
  });

  it("a workspace with no inventory is listed as not read rather than read with a zero total", async () => {
    const { azure } = routedAzure({});
    const r = await compareTenant(azure, undefined, [WS], new Map(), { readAt: OPTS.readAt });
    if (r.scope.kind !== "tenant") throw new Error("unreachable");
    expect(r.scope.notRead.map((n) => n.id)).toEqual([WS]);
  });
});
