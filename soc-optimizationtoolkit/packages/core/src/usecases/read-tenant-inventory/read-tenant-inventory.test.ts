import { describe, expect, it } from "vitest";
import { emptyProgress } from "../../domain/onboarding-howto/progress-document";
import type { AzureManagement, AzureManagementRequest } from "../../ports/azure-management";
import type { PortHttpResponse } from "../../ports/http";
import { ACTIVITY_LOG_CATEGORIES } from "../../domain/activity-log-export/activity-log-setting";
import { DEFENDER_EXPORT_TYPES } from "../../domain/tenant-inventory/tenant-inventory";
import { DEFENDER_EXPORT_ITEM_ID } from "../../domain/defender-export/defender-automation";
import { NO_APP_ARCHIVE_EVIDENCE } from "../../domain/tenant-inventory/tenant-inventory";
import { cancellableAzure, READ_CANCELLED, readTenantInventory } from "./read-tenant-inventory";

const SUB_A = "00000000-0000-0000-0000-00000000000a";
const SUB_B = "00000000-0000-0000-0000-00000000000b";
const NOW = "2026-01-02T03:04:05.000Z";

const ok = (value: unknown[]): PortHttpResponse => ({ status: 200, body: { value } });
const forbidden: PortHttpResponse = {
  status: 403,
  body: { error: { code: "AuthorizationFailed", message: "no access" } },
};

type Route = (request: AzureManagementRequest) => PortHttpResponse | Promise<PortHttpResponse>;

/** Routes by path, so the test does not depend on the order of reads. */
function router(routes: Record<string, Route>): AzureManagement & { calls: AzureManagementRequest[] } {
  const calls: AzureManagementRequest[] = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      const key = Object.keys(routes).find((k) => request.path === k || request.path.endsWith(k));
      if (key === undefined) return { status: 404, body: { error: { code: "NotFound", message: request.path } } };
      return routes[key](request);
    },
  };
}

function healthy(subs: string[] = [SUB_A, SUB_B]): Record<string, Route> {
  const routes: Record<string, Route> = {
    "/subscriptions": () => ok(subs.map((id) => ({ subscriptionId: id, displayName: `sub ${id.slice(-1)}`, state: "Enabled" }))),
    "/providers/microsoft.aadiam/diagnosticSettings": () => ok([]),
  };
  for (const id of subs) {
    routes[`/subscriptions/${id}/providers/Microsoft.Insights/diagnosticSettings`] = () => ok([]);
    routes[`/subscriptions/${id}/providers/Microsoft.Security/automations`] = () => ok([]);
  }
  return routes;
}

const run = (azure: AzureManagement, onProgress?: (d: number, t: number) => void) =>
  readTenantInventory({ azure, progress: emptyProgress(), now: () => NOW, onProgress });

describe("readTenantInventory", () => {
  it("reads two subscriptions into seven cards with Entra, Activity Log and Defender cells, GET only", async () => {
    const azure = router(healthy());
    const inv = await run(azure);
    expect(inv.cards).toHaveLength(7);
    expect(inv.cells.filter((c) => c.category === "entraId")).toHaveLength(15);
    expect(inv.cells.some((c) => c.category === "activityLog")).toBe(true);
    expect(inv.cells.some((c) => c.category === DEFENDER_EXPORT_ITEM_ID)).toBe(true);
    expect(azure.calls.every((c) => c.method === "GET")).toBe(true);
    expect(inv.subscriptions.kind).toBe("rows");
    // 1 subscriptions + 1 Entra + 2 x (settings + automations)
    expect(inv.requests).toBe(6);
    expect(inv.requests).toBe(azure.calls.length);
  });

  it("costs two requests per subscription and never reads Defender pricings", async () => {
    const subs = ["1", "2", "3", "4", "5"].map((n) => `00000000-0000-0000-0000-00000000000${n}`);
    const azure = router(healthy(subs));
    const inv = await run(azure);
    expect(inv.requests).toBe(2 + 2 * subs.length);
    for (const id of subs) {
      expect(azure.calls.filter((c) => c.path.startsWith(`/subscriptions/${id}/`))).toHaveLength(2);
    }
    expect(azure.calls.some((c) => c.path.toLowerCase().includes("pricings"))).toBe(false);
  });

  it("reads a Warned or PastDue subscription and skips Disabled and Deleted ones", async () => {
    const routes = healthy();
    routes["/subscriptions"] = () =>
      ok([
        { subscriptionId: SUB_A, displayName: "warned", state: "Warned" },
        { id: `/subscriptions/${SUB_B}`, displayName: "past due", state: "PastDue" },
        { subscriptionId: "dead", displayName: "gone", state: "Deleted" },
        { subscriptionId: "off", displayName: "off", state: "Disabled" },
      ]);
    const azure = router(routes);
    const inv = await run(azure);
    expect(inv.subscriptions).toEqual({
      kind: "rows",
      rows: [
        { id: SUB_A, name: "warned" },
        { id: SUB_B, name: "past due" },
      ],
    });
    expect(azure.calls.some((c) => c.path.includes(`/subscriptions/${SUB_A}/`))).toBe(true);
    expect(azure.calls.some((c) => c.path.includes("/subscriptions/dead/") || c.path.includes("/subscriptions/off/"))).toBe(false);
  });

  it("issues no request once cancelled", async () => {
    const azure = router(healthy());
    let stop = false;
    const inv = await readTenantInventory({
      azure,
      progress: emptyProgress(),
      now: () => NOW,
      // Cancel after the Entra read: the subscriptions and Entra lists were sent.
      onProgress: (done) => {
        if (done === 2) stop = true;
      },
      cancelled: () => stop,
    });
    expect(azure.calls.map((c) => c.path)).toEqual(["/subscriptions", "/providers/microsoft.aadiam/diagnosticSettings"]);
    expect(inv.requests).toBe(2);
    const activity = inv.cells.filter((c) => c.category === "activityLog");
    expect(activity).toHaveLength(ACTIVITY_LOG_CATEGORIES.length);
    for (const c of activity) {
      expect(c.state).toEqual({ kind: "could-not-check", reason: READ_CANCELLED });
    }
  });

  it("cancellableAzure refuses a request issued after the flag is set", async () => {
    const azure = router(healthy());
    let stop = false;
    const guarded = cancellableAzure(azure, () => stop);
    await guarded.request({ method: "GET", path: "/subscriptions", apiVersion: "x" });
    stop = true;
    await expect(guarded.request({ method: "GET", path: "/subscriptions", apiVersion: "x" })).rejects.toThrow(
      READ_CANCELLED,
    );
    expect(azure.calls).toHaveLength(1);
  });

  it("reads in order: subscriptions, Entra, then per subscription settings before Defender", async () => {
    const azure = router(healthy());
    await run(azure);
    const paths = azure.calls.map((c) => c.path);
    expect(paths[0]).toBe("/subscriptions");
    expect(paths[1]).toBe("/providers/microsoft.aadiam/diagnosticSettings");
    expect(paths[2]).toContain(`/subscriptions/${SUB_A}/providers/Microsoft.Insights/diagnosticSettings`);
    expect(paths[3]).toContain(`/subscriptions/${SUB_A}/providers/Microsoft.Security`);
    expect(paths.findIndex((p) => p.includes(SUB_B))).toBeGreaterThan(paths.findIndex((p) => p.includes(SUB_A)));
  });

  it("a 403 on one subscription's settings list leaves its Activity Log cells short of collected, with the reason", async () => {
    const routes = healthy();
    routes[`/subscriptions/${SUB_B}/providers/Microsoft.Insights/diagnosticSettings`] = () => forbidden;
    const inv = await run(router(routes));
    const activity = inv.cells.filter((c) => c.category === "activityLog");
    expect(activity).toHaveLength(ACTIVITY_LOG_CATEGORIES.length);
    for (const c of activity) {
      expect(c.state.kind).toBe("could-not-check");
      if (c.state.kind === "could-not-check") expect(c.state.reason).toContain("no access");
    }
  });

  it("an empty subscription list is could-not-check for Activity Log and Defender, not not-collected", async () => {
    const inv = await run(router(healthy([])));
    expect(inv.subscriptions.kind).not.toBe("rows");
    const nonEntra = inv.cells.filter((x) => x.category !== "entraId");
    expect(nonEntra).toHaveLength(ACTIVITY_LOG_CATEGORIES.length + DEFENDER_EXPORT_TYPES.length);
    for (const c of nonEntra) {
      expect(c.state.kind).toBe("could-not-check");
    }
  });

  it("a refused subscription list is unread with the reason, and every non-Entra cell is could-not-check", async () => {
    const routes = healthy();
    routes["/subscriptions"] = () => forbidden;
    const inv = await run(router(routes));
    expect(inv.subscriptions).toEqual({ kind: "unread", reason: expect.stringContaining("no access") });
    const nonEntra = inv.cells.filter((x) => x.category !== "entraId");
    expect(nonEntra).toHaveLength(ACTIVITY_LOG_CATEGORIES.length + DEFENDER_EXPORT_TYPES.length);
    for (const c of nonEntra) {
      expect(c.state.kind).toBe("could-not-check");
    }
  });

  it("a transport rejection on the Entra list gives 15 could-not-check Entra cells and the rest still read", async () => {
    const routes = healthy();
    routes["/providers/microsoft.aadiam/diagnosticSettings"] = () => {
      throw new Error("socket hang up");
    };
    const inv = await run(router(routes));
    const entra = inv.cells.filter((c) => c.category === "entraId");
    expect(entra).toHaveLength(15);
    for (const c of entra) {
      expect(c.state.kind).toBe("could-not-check");
      if (c.state.kind === "could-not-check") expect(c.state.reason).toContain("socket hang up");
    }
    expect(inv.cells.some((c) => c.category === "activityLog" && c.state.kind === "not-collected")).toBe(true);
  });

  it("a Defender automations refusal makes that subscription's Defender cells could-not-check", async () => {
    const routes = healthy();
    routes[`/subscriptions/${SUB_A}/providers/Microsoft.Security/automations`] = () => forbidden;
    const inv = await run(router(routes));
    const defender = inv.cells.filter((c) => c.category === DEFENDER_EXPORT_ITEM_ID);
    expect(defender).toHaveLength(DEFENDER_EXPORT_TYPES.length);
    for (const c of defender) expect(c.state.kind).toBe("could-not-check");
  });

  it("readAt is the injected now() and progress reports done up to total", async () => {
    const seen: [number, number][] = [];
    const inv = await run(router(healthy()), (d, t) => seen.push([d, t]));
    expect(inv.readAt).toBe(NOW);
    expect(seen.at(-1)).toEqual([6, 6]);
    expect(seen).toHaveLength(6);
  });

  /** SUB_A collects every Activity Log category and Defender type to an Event Hub; SUB_B refuses both lists. */
  function oneHubOneRefused(): Record<string, Route> {
    const routes = healthy();
    const hub = "/subscriptions/x/resourceGroups/rg/providers/Microsoft.EventHub/namespaces/ns/authorizationRules/r";
    routes[`/subscriptions/${SUB_A}/providers/Microsoft.Insights/diagnosticSettings`] = () =>
      ok([
        {
          id: `/subscriptions/${SUB_A}/providers/Microsoft.Insights/diagnosticSettings/s1`,
          name: "s1",
          properties: {
            eventHubAuthorizationRuleId: hub,
            logs: ACTIVITY_LOG_CATEGORIES.map((category) => ({ category, enabled: true })),
          },
        },
      ]);
    routes[`/subscriptions/${SUB_B}/providers/Microsoft.Insights/diagnosticSettings`] = () => forbidden;
    routes[`/subscriptions/${SUB_A}/providers/Microsoft.Security/automations`] = () =>
      ok([
        {
          id: `/subscriptions/${SUB_A}/resourceGroups/rg/providers/Microsoft.Security/automations/a1`,
          name: "a1",
          properties: {
            isEnabled: true,
            scopes: [{ description: "s", scopePath: `/subscriptions/${SUB_A}` }],
            sources: DEFENDER_EXPORT_TYPES.flatMap((t) => t.eventSources).map((eventSource) => ({ eventSource })),
            actions: [{ actionType: "EventHub", eventHubResourceId: hub }],
          },
        },
      ]);
    routes[`/subscriptions/${SUB_B}/providers/Microsoft.Security/automations`] = () => forbidden;
    return routes;
  }

  const LENGTHS = { activityLog: ACTIVITY_LOG_CATEGORIES.length, [DEFENDER_EXPORT_ITEM_ID]: DEFENDER_EXPORT_TYPES.length };

  it("one collecting subscription and one refused is partly (1 collected, 1 read, 1 unread), not not-collected", async () => {
    const inv = await run(router(oneHubOneRefused()));
    const scopes = { collected: 1, read: 1, unread: 1 };
    for (const category of ["activityLog", DEFENDER_EXPORT_ITEM_ID] as const) {
      const cells = inv.cells.filter((c) => c.category === category);
      expect(cells).toHaveLength(LENGTHS[category]);
      for (const c of cells) expect(c.state).toEqual({ kind: "partly", scopes });
    }
  });

  it("with no progress record an Event Hub archive is unknown with the reason, never archived", async () => {
    const inv = await readTenantInventory({ azure: router(oneHubOneRefused()), progress: null, now: () => NOW });
    for (const category of ["activityLog", DEFENDER_EXPORT_ITEM_ID] as const) {
      const cells = inv.cells.filter((c) => c.category === category);
      expect(cells).toHaveLength(LENGTHS[category]);
      for (const c of cells) expect(c.archive).toEqual({ kind: "unknown", reason: NO_APP_ARCHIVE_EVIDENCE });
    }
  });
});
