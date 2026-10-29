// Pins for the READ-ONLY Validate usecase (AZR-32, ADR 0007 D16). The
// defects these guard against are silent: a Validate that writes, a
// denied hub list turned into "measured: none" (D9 would then create from
// guesses), a cancelled run rendered as absent, a hand-rolled pager that
// stops after the first page, a measured zero arrival shown as unknown, and
// (AZR-47) a hub the complete listing lacks shown as a quiet hub.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type {
  AzureManagement,
  AzureManagementRequest,
  AzureManagementUrlRequest,
} from "../../ports/azure-management";
import type { PortHttpResponse } from "../../ports/http";
import { defaultPlanValues, type PlanValues } from "../../domain/onboarding-howto/plan-values";
import { ONBOARDING_SOURCES, type OnboardingSourceId } from "../../domain/onboarding-howto/sources";
import { DEFENDER_EXPORT_NAME } from "../../domain/defender-export";
import { MAX_LIST_PAGES } from "../azure-discovery";
import {
  CANCELLED_DETAIL,
  checkKey,
  planValidation,
  validateAzureOnboarding,
  verdictsForStep,
} from "./index";

const FULL: PlanValues = {
  ...defaultPlanValues({ subscriptionId: "sub-1", resourceGroup: "rg-1" }),
  managementGroupId: "mg-1",
  region: "eastus",
  namespace: "ns1",
  hubName: "defender-alerts",
  sendRule: "sender",
  listenRule: "reader",
  storageAccount: "flowlogsa",
  queueName: "flowlog-queue",
  systemTopic: "flowlogsa-events",
  networkWatcher: "NetworkWatcher_eastus",
  flowLogName: "vnet-flowlog",
  criblPrincipalObjectId: "00000000-0000-0000-0000-0000000000aa",
};
const NS_PATH = "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.EventHub/namespaces/ns1";
const ALL_IDS = ONBOARDING_SOURCES.map((s) => s.id);

type Route = (req: AzureManagementRequest) => PortHttpResponse | undefined;

/** Records every call with its method; answers from routes, else a generic 200. */
class RecordingAzure implements AzureManagement {
  readonly calls: { method: string; path: string }[] = [];
  readonly urlCalls: AzureManagementUrlRequest[] = [];
  private readonly routes: Route[];
  private readonly urlAnswer: (url: string) => PortHttpResponse;
  onCall: (() => void) | null = null;
  constructor(routes: Route[] = [], urlAnswer?: (url: string) => PortHttpResponse) {
    this.routes = routes;
    this.urlAnswer = urlAnswer ?? (() => ({ status: 200, body: { value: [] } }));
  }
  async request(req: AzureManagementRequest): Promise<PortHttpResponse> {
    this.calls.push({ method: req.method, path: req.path });
    this.onCall?.();
    for (const r of this.routes) {
      const a = r(req);
      if (a !== undefined) return a;
    }
    return { status: 200, body: { value: [] } };
  }
  async requestUrl(req: AzureManagementUrlRequest): Promise<PortHttpResponse> {
    this.urlCalls.push(req);
    this.calls.push({ method: req.method, path: req.url });
    return this.urlAnswer(req.url);
  }
}

const HUBS_PATH = `${NS_PATH}/eventhubs`;
const onPath =
  (path: string, answer: PortHttpResponse): Route =>
  (req) =>
    req.path === path ? answer : undefined;
const DENIED: PortHttpResponse = {
  status: 403,
  body: { error: { code: "AuthorizationFailed", message: "no" } },
};

describe("planValidation", () => {
  it("dedupes: one namespace GET and one hub list across three Event Hub sources", () => {
    const plan = planValidation(["defenderExport", "entraId", "activityLog"], FULL);
    const nsReads = plan.requests.filter((r) => r.request.path === NS_PATH);
    expect(nsReads).toHaveLength(1);
    expect(plan.requests.filter((r) => r.request.path === HUBS_PATH)).toHaveLength(1);
    const keys = plan.requests.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(plan.firstPageReads).toBe(plan.requests.length + plan.arrival.length);
    // Each of the three sources still gets its own namespace verdict slot.
    const sourcesWithNs: OnboardingSourceId[] = plan.checks
      .filter((c) => c.kind === "eh-namespace")
      .map((c) => c.sourceId);
    expect(sourcesWithNs).toEqual(["defenderExport", "entraId", "activityLog"]);
  });

  it("maxReads is an honest upper bound: every first page plus MAX_LIST_PAGES - 1 per listing", () => {
    const plan = planValidation(["defenderExport"], FULL);
    const lists = plan.requests.filter((r) => r.shape === "list").length;
    expect(lists).toBeGreaterThanOrEqual(1);
    expect(plan.listReads).toBe(lists);
    expect(plan.maxReads).toBe(plan.requests.length + plan.arrival.length + lists * (MAX_LIST_PAGES - 1));
    expect(plan.maxReads).toBeGreaterThanOrEqual(plan.firstPageReads + (MAX_LIST_PAGES - 1));
  });

  it("a missing value sends no request for that check and is listed in missing", () => {
    const values = { ...FULL, namespace: "" };
    const plan = planValidation(["defenderExport"], values);
    expect(plan.missing).toContain("namespace");
    expect(plan.requests.some((r) => r.request.path.includes("Microsoft.EventHub"))).toBe(false);
    expect(plan.arrival).toEqual([]);
    const ns = plan.checks.find((c) => c.kind === "eh-namespace");
    expect(ns?.readKeys).toEqual([]);
    expect(ns?.missing).toEqual(["namespace"]);
  });

  it("arrival hubs are the named / known hubs of Event Hub sources only", () => {
    const plan = planValidation(["defenderExport", "vnetFlowLogs"], FULL);
    expect(plan.arrivalHubs).toEqual(["defender-alerts"]);
    expect(plan.arrival[0]?.read.request.path).toBe(`${NS_PATH}/providers/microsoft.insights/metrics`);
    expect(plan.arrival[0]?.read.request.query?.["$filter"]).toBe("EntityName eq 'defender-alerts'");
  });
});

describe("validateAzureOnboarding is read-only", () => {
  it("with every source and full values, every call is a GET and none is listKeys", async () => {
    const azure = new RecordingAzure();
    const plan = planValidation(ALL_IDS, FULL);
    expect(plan.requests.length).toBeGreaterThan(10);
    const result = await validateAzureOnboarding(azure, plan);
    expect(azure.calls.length).toBe(plan.firstPageReads);
    for (const call of azure.calls) {
      expect(call.method, call.path).toBe("GET");
      expect(call.path.toLowerCase()).not.toContain("listkeys");
    }
    expect(result.checks).toHaveLength(plan.checks.length);
    expect(result.cancelled).toBe(false);
  });

  it("a shared namespace is read once, even with three Event Hub sources", async () => {
    const azure = new RecordingAzure();
    const plan = planValidation(["defenderExport", "entraId", "activityLog"], FULL);
    await validateAzureOnboarding(azure, plan);
    expect(azure.calls.filter((c) => c.path === NS_PATH)).toHaveLength(1);
    expect(azure.calls.filter((c) => c.path === HUBS_PATH)).toHaveLength(1);
  });

  it("refuses to send a non-GET that slipped into a plan", async () => {
    const azure = new RecordingAzure();
    const base = planValidation(["defenderExport"], FULL);
    const first = base.requests[0]!;
    const plan = {
      ...base,
      requests: [{ ...first, request: { ...first.request, method: "POST" as const } }, ...base.requests.slice(1)],
    };
    const result = await validateAzureOnboarding(azure, plan);
    expect(azure.calls.every((c) => c.method === "GET")).toBe(true);
    expect(azure.calls.some((c) => c.path === first.request.path && c.method !== "GET")).toBe(false);
    const affected = plan.checks.find((c) => c.readKeys.includes(first.key))!;
    const v = result.verdicts[affected.key];
    expect(v?.kind === "unknown" && v.reason).toBe("failed");
  });
});

describe("measured hubs and verdict honesty", () => {
  it("a complete hub list fills measuredHubs", async () => {
    const azure = new RecordingAzure([
      onPath(HUBS_PATH, { status: 200, body: { value: [{ name: "insights-logs-signinlogs" }, { name: "defender-alerts" }] } }),
    ]);
    const result = await validateAzureOnboarding(azure, planValidation(["entraId", "defenderExport"], FULL));
    expect([...(result.measuredHubs ?? [])].sort()).toEqual(["defender-alerts", "insights-logs-signinlogs"]);
  });

  it("a denied hub list gives measuredHubs null and the eh-hub verdict unknown 'denied'", async () => {
    const azure = new RecordingAzure([onPath(HUBS_PATH, DENIED)]);
    const result = await validateAzureOnboarding(azure, planValidation(["defenderExport"], FULL));
    expect(result.measuredHubs).toBeNull();
    const v = result.verdicts[checkKey("defenderExport", "eh-hub", "eh-hub")];
    expect(v).toBeDefined();
    expect(v?.kind === "unknown" && v.reason).toBe("denied");
  });

  it("a nextLink chain longer than MAX_LIST_PAGES is unknown 'truncated' through readAllPages", async () => {
    let n = 0;
    const azure = new RecordingAzure(
      [onPath(HUBS_PATH, { status: 200, body: { value: [{ name: "defender-alerts" }], nextLink: "https://management.azure.com/p/0" } })],
      () => {
        n += 1;
        return { status: 200, body: { value: [{ name: `h${n}` }], nextLink: `https://management.azure.com/p/${n}` } };
      },
    );
    const plan = planValidation(["defenderExport"], FULL);
    const result = await validateAzureOnboarding(azure, plan);
    expect(azure.urlCalls.length).toBe(MAX_LIST_PAGES - 1);
    // The stated bound covers the pages readAllPages actually followed.
    expect(azure.calls.length + azure.urlCalls.length).toBeGreaterThan(plan.firstPageReads);
    expect(azure.calls.length + azure.urlCalls.length).toBeLessThanOrEqual(plan.maxReads);
    const v = result.verdicts[checkKey("defenderExport", "eh-hub", "eh-hub")];
    expect(v?.kind === "unknown" && v.reason).toBe("truncated");
    expect(result.measuredHubs).toBeNull();
  });

  it("a missing value sends no request and the verdict is unknown 'missing-value'", async () => {
    const azure = new RecordingAzure();
    const result = await validateAzureOnboarding(
      azure,
      planValidation(["defenderExport"], { ...FULL, namespace: "" }),
    );
    expect(azure.calls.some((c) => c.path.includes("Microsoft.EventHub"))).toBe(false);
    const v = result.verdicts[checkKey("defenderExport", "eh-namespace", "eh-namespace")];
    expect(v?.kind === "unknown" && v.reason).toBe("missing-value");
  });

  it("another export name targeting the plan hub is present-other-name", async () => {
    const exportItem = {
      id: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Security/automations/PortalExport",
      name: "PortalExport",
      properties: {
        isEnabled: true,
        scopes: [{ scopePath: "/subscriptions/sub-1" }],
        sources: [{ eventSource: "Alerts" }],
        actions: [{ actionType: "EventHub", eventHubResourceId: `${NS_PATH}/eventhubs/defender-alerts` }],
      },
    };
    expect(exportItem.name).not.toBe(DEFENDER_EXPORT_NAME);
    const azure = new RecordingAzure([
      onPath("/subscriptions/sub-1/providers/Microsoft.Security/automations", {
        status: 200,
        body: { value: [exportItem] },
      }),
    ]);
    const result = await validateAzureOnboarding(azure, planValidation(["defenderExport"], FULL));
    const v = result.verdicts[checkKey("defenderExport", "defender-export", "defender-export")];
    expect(v?.kind === "present-other-name" && v.name).toBe("PortalExport");
    expect(verdictsForStep(result, "defender-export")).toEqual([v]);
  });

  it("AZR-39: the Manage rule step is present-differs for a Send-only rule, through the run", async () => {
    const rules = (rights: string[]): Route =>
      onPath(`${NS_PATH}/authorizationRules`, {
        status: 200,
        body: { value: [{ name: "sender", properties: { rights } }] },
      });
    const key = checkKey("entraId", "eh-rule-diagnostic", "eh-rule-manage");
    const sendOnly = await validateAzureOnboarding(new RecordingAzure([rules(["Send"])]), planValidation(["entraId"], FULL));
    expect(sendOnly.verdicts[key]).toEqual({
      kind: "present-differs",
      diffs: [{ field: "rights", expected: "Manage", actual: "Send" }],
    });
    const manage = await validateAzureOnboarding(
      new RecordingAzure([rules(["Manage", "Send", "Listen"])]),
      planValidation(["entraId"], FULL),
    );
    expect(manage.verdicts[key]).toEqual({ kind: "as-expected" });
  });

  it("AZR-39: the Activity Log definition is read by one planned GET listing at the group",async () => {
    const DEFS =
      "/providers/Microsoft.Management/managementGroups/mg-1/providers/Microsoft.Authorization/policyDefinitions";
    const plan = planValidation(["activityLog"], FULL);
    expect(plan.requests.filter((r) => r.request.path === DEFS)).toHaveLength(1);
    const azure = new RecordingAzure([
      onPath(DEFS, {
        status: 200,
        body: { value: [{ id: `${DEFS}/Cribl-Community-ActivityLog-DiagSettings-EventHub` }] },
      }),
    ]);
    const result = await validateAzureOnboarding(azure, plan);
    expect(azure.calls.filter((c) => c.path === DEFS)).toEqual([{ method: "GET", path: DEFS }]);
    expect(result.verdicts[checkKey("activityLog", "activity-log-definition", "policy-definition")]).toEqual({
      kind: "as-expected",
    });
    const denied = await validateAzureOnboarding(new RecordingAzure([onPath(DEFS, DENIED)]), plan);
    const v = denied.verdicts[checkKey("activityLog", "activity-log-definition", "policy-definition")];
    expect(v?.kind === "unknown" && v.reason).toBe("denied");
  });
});

describe("arrival", () => {
  const METRICS = `${NS_PATH}/providers/microsoft.insights/metrics`;
  const metrics = (total: number): PortHttpResponse => ({
    status: 200,
    body: { value: [{ timeseries: [{ data: [{ total }] }] }] },
  });
  const hubList = (...names: string[]): Route =>
    onPath(HUBS_PATH, { status: 200, body: { value: names.map((name) => ({ name })) } });
  const PLAN_HUB = hubList("defender-alerts");

  it("an IncomingMessages total of 0 is a MEASURED zero; a 403 is unknown; they differ", async () => {
    const zero = await validateAzureOnboarding(
      new RecordingAzure([PLAN_HUB, onPath(METRICS, metrics(0))]),
      planValidation(["defenderExport"], FULL),
    );
    expect(zero.arrival["defender-alerts"]).toEqual({ kind: "measured", messages: 0, window: "PT1H" });

    const denied = await validateAzureOnboarding(
      new RecordingAzure([PLAN_HUB, onPath(METRICS, DENIED)]),
      planValidation(["defenderExport"], FULL),
    );
    const a = denied.arrival["defender-alerts"];
    expect(a?.kind === "unknown" && a.reason).toBe("denied");
    expect(a).not.toEqual(zero.arrival["defender-alerts"]);
  });

  it("the caller's timespan is the window sent and recorded", async () => {
    const span = "2026-10-26T00:00:00Z/2026-10-26T01:00:00Z";
    const plan = planValidation(["defenderExport"], FULL, { arrivalTimespan: span });
    expect(plan.arrival[0]?.read.request.query?.["timespan"]).toBe(span);
    const r = await validateAzureOnboarding(new RecordingAzure([PLAN_HUB, onPath(METRICS, metrics(7))]), plan);
    expect(r.arrival["defender-alerts"]).toEqual({ kind: "measured", messages: 7, window: span });
  });

  // AZR-47. Azure Monitor answers an EntityName-filtered read for a hub that
  // is not in the namespace with a zero series, so only the hub listing can
  // tell a missing hub from a quiet one.
  it("a COMPLETE listing without the hub is no-hub, even though the metric reads 0", async () => {
    const r = await validateAzureOnboarding(
      new RecordingAzure([hubList("t1", "t2", "t3"), onPath(METRICS, metrics(0))]),
      planValidation(["defenderExport"], FULL),
    );
    expect(r.measuredHubs).toEqual(["t1", "t2", "t3"]);
    expect(r.arrival).toEqual({ "defender-alerts": { kind: "no-hub" } });
  });

  it("every Entra auto-created hub a complete listing lacks is no-hub; the listed one is measured", async () => {
    const plan = planValidation(["entraId"], FULL);
    expect(plan.arrivalHubs.length).toBeGreaterThan(1);
    const [listed, ...unlisted] = plan.arrivalHubs;
    const r = await validateAzureOnboarding(
      new RecordingAzure([hubList("t1", "t2", "t3", listed!.toUpperCase()), onPath(METRICS, metrics(0))]),
      plan,
    );
    expect(r.arrival[listed!]).toEqual({ kind: "measured", messages: 0, window: "PT1H" });
    expect(Object.keys(r.arrival).filter((h) => r.arrival[h]?.kind === "no-hub")).toEqual(unlisted);
  });

  it("an incomplete hub listing keeps the measured zero: absence is never inferred from it", async () => {
    let n = 0;
    const truncated = new RecordingAzure(
      [
        onPath(HUBS_PATH, { status: 200, body: { value: [{ name: "t1" }], nextLink: "https://management.azure.com/p/0" } }),
        onPath(METRICS, metrics(0)),
      ],
      () => {
        n += 1;
        return { status: 200, body: { value: [{ name: `h${n}` }], nextLink: `https://management.azure.com/p/${n}` } };
      },
    );
    const plan = planValidation(["defenderExport"], FULL);
    const cut = await validateAzureOnboarding(truncated, plan);
    expect(cut.measuredHubs).toBeNull();
    expect(cut.arrival).toEqual({ "defender-alerts": { kind: "measured", messages: 0, window: "PT1H" } });

    const denied = await validateAzureOnboarding(
      new RecordingAzure([onPath(HUBS_PATH, DENIED), onPath(METRICS, metrics(0))]),
      plan,
    );
    expect(denied.arrival).toEqual({ "defender-alerts": { kind: "measured", messages: 0, window: "PT1H" } });
  });

  // AZR-50: the same listing was absent to the eh-hub verdict and complete to
  // measuredHubs; all three readers now share measuredHubNames' rule.
  it("a listing with a nameless row is not complete: that row may be the hub, so the zero stands", async () => {
    const r = await validateAzureOnboarding(
      new RecordingAzure([
        onPath(HUBS_PATH, { status: 200, body: { value: [{ name: "t1" }, { id: "x" }] } }),
        onPath(METRICS, metrics(0)),
      ]),
      planValidation(["defenderExport"], FULL),
    );
    expect(r.arrival).toEqual({ "defender-alerts": { kind: "measured", messages: 0, window: "PT1H" } });
    expect(r.measuredHubs).toBeNull();
    expect(r.verdicts[checkKey("defenderExport", "eh-hub", "eh-hub")]).toEqual({
      kind: "unknown",
      reason: "failed",
      detail: "1 hub row could not be read, so the listing does not show it is missing.",
    });
  });

  it("a complete listing of no hubs is an empty measuredHubs, not the null of a failed one", async () => {
    const empty = await validateAzureOnboarding(
      new RecordingAzure([hubList(), onPath(METRICS, metrics(0))]),
      planValidation(["defenderExport"], FULL),
    );
    expect(empty.measuredHubs).toEqual([]);
    expect(empty.verdicts[checkKey("defenderExport", "eh-hub", "eh-hub")]).toEqual({ kind: "absent" });
    expect(empty.arrival).toEqual({ "defender-alerts": { kind: "no-hub" } });
  });

  it("a listing without the hub overrides even an unreadable metric, and the read is still sent", async () => {
    const azure = new RecordingAzure([hubList("t1"), onPath(METRICS, DENIED)]);
    const plan = planValidation(["defenderExport"], FULL);
    const r = await validateAzureOnboarding(azure, plan);
    expect(r.arrival).toEqual({ "defender-alerts": { kind: "no-hub" } });
    expect(azure.calls.filter((c) => c.path === METRICS).length).toBe(1);
  });
});

describe("cancel", () => {
  it("abort leaves the remaining checks unknown 'cancelled', never absent", async () => {
    const controller = { aborted: false };
    const azure = new RecordingAzure();
    let seen = 0;
    azure.onCall = () => {
      seen += 1;
      if (seen === 2) controller.aborted = true;
    };
    const plan = planValidation(["defenderExport"], FULL);
    const result = await validateAzureOnboarding(azure, plan, { signal: controller });
    expect(result.cancelled).toBe(true);
    expect(azure.calls).toHaveLength(2);
    const unread = plan.checks.filter((c) =>
      c.readKeys.some((k) => !plan.requests.slice(0, 2).some((r) => r.key === k)),
    );
    expect(unread.length).toBeGreaterThan(0);
    for (const c of unread) {
      expect(result.verdicts[c.key], c.key).toEqual({ kind: "unknown", reason: "failed", detail: CANCELLED_DETAIL });
    }
    expect(unread.some((c) => result.verdicts[c.key]?.kind === "absent")).toBe(false);
    expect(result.arrival["defender-alerts"]).toEqual({ kind: "unknown", reason: "failed", detail: CANCELLED_DETAIL });
  });
});

describe("reuses the logging-map pager", () => {
  it("imports readAllPages and writes no pagination loop of its own", () => {
    const dir = new URL("./", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files).toContain("validate-azure-onboarding.ts");
    const main = readFileSync(new URL("./validate-azure-onboarding.ts", import.meta.url), "utf8");
    expect(main).toMatch(/import\s*\{[^}]*\breadAllPages\b[^}]*\}\s*from\s*"\.\.\/read-logging-map"/);
    for (const f of files) {
      const text = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(text, f).not.toMatch(/nextLink/);
      expect(text, f).not.toMatch(/requestUrl/);
    }
  });
});
