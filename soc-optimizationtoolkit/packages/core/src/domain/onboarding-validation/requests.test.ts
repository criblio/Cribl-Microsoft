// Pins for the Validate requests (AZR-32). The load-bearing one is the first:
// Validate is read-only BY CONSTRUCTION, so every request any check kind can
// build is a GET, and none of them is a listKeys.

import { describe, expect, it } from "vitest";

import { CHECK_KINDS, type CheckKind } from "../onboarding-howto/check-kinds";
import { defaultPlanValues, type PlanValues } from "../onboarding-howto/plan-values";
import { ONBOARDING_SOURCES } from "../onboarding-howto/sources";
import { ENTRA_PROFILE_CATEGORIES } from "../entra-diagnostics/entra-categories";
import { managementGroupDefinitionsPath } from "../onboarding-howto-steps/policy-steps";
import {
  CHECK_REQUIRED_VALUES,
  CUSTOM_POLICY_DEFINITIONS_FILTER,
  DEFAULT_ARRIVAL_WINDOW,
  arrivalRequestFor,
  checkExpectationsFor,
  communitySetDefinitionId,
  requestsFor,
  type CheckExpectations,
  type CheckRequest,
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

const AUDIT = checkExpectationsFor("diagnosticSettingsInitiative", FULL);
const COMMUNITY = checkExpectationsFor("communityPolicyInitiative", FULL);

function requestsOf(kind: CheckKind, ex: CheckExpectations): readonly CheckRequest[] {
  const r = requestsFor(kind, FULL, ex);
  if (r.kind !== "requests") throw new Error(`${kind} reported missing ${r.missing.join(",")}`);
  return r.requests;
}

describe("requestsFor: read-only by construction", () => {
  it("every request of every check kind, for both policy sources, is a GET and never listKeys", () => {
    const all: CheckRequest[] = [];
    for (const kind of CHECK_KINDS) {
      all.push(...requestsOf(kind, AUDIT), ...requestsOf(kind, COMMUNITY));
    }
    // Every kind but the two that read nothing, for each source - less one:
    // the built-in Audit imports no definition, so policy-definition reads
    // nothing for it.
    expect(all.length).toBeGreaterThanOrEqual(2 * (CHECK_KINDS.length - 2) - 1);
    for (const r of all) {
      expect(r.request.method, r.context).toBe("GET");
      expect(r.request.path.toLowerCase(), r.context).not.toContain("listkeys");
      expect(r.request.body, r.context).toBeUndefined();
    }
  });

  it("the arrival request is a GET of IncomingMessages on the namespace, filtered to the hub", () => {
    const r = arrivalRequestFor(FULL, "insights-logs-signinlogs");
    expect(r.kind).toBe("request");
    if (r.kind !== "request") return;
    expect(r.request.method).toBe("GET");
    expect(r.request.path).toBe(
      "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.EventHub/namespaces/ns1" +
        "/providers/microsoft.insights/metrics",
    );
    expect(r.request.query?.["$filter"]).toBe("EntityName eq 'insights-logs-signinlogs'");
    expect(r.request.query?.["metricnames"]).toBe("IncomingMessages");
    expect(r.request.query).not.toHaveProperty("timespan");
    expect(r.window).toBe(DEFAULT_ARRIVAL_WINDOW);
  });

  it("a caller-minted timespan is sent and becomes the window", () => {
    const span = "2026-10-26T00:00:00Z/2026-10-26T01:00:00Z";
    const r = arrivalRequestFor(FULL, "h", span);
    expect(r.kind === "request" && r.request.query?.["timespan"]).toBe(span);
    expect(r.kind === "request" && r.window).toBe(span);
  });
});

describe("requestsFor: a missing value sends nothing", () => {
  it("returns the missing keys and no request for every kind that needs a value", () => {
    const blank = defaultPlanValues(null);
    for (const kind of CHECK_KINDS) {
      const r = requestsFor(kind, blank, AUDIT);
      const needed = CHECK_REQUIRED_VALUES[kind].filter((k) => blank[k].trim() === "");
      if (needed.length === 0) {
        expect(r.kind, kind).toBe("requests");
      } else {
        expect(r, kind).toEqual({ kind: "missing", missing: needed });
      }
    }
  });

  it("arrival needs the namespace", () => {
    expect(arrivalRequestFor({ ...FULL, namespace: "" }, "h")).toEqual({
      kind: "missing",
      missing: ["namespace"],
    });
  });

  it("the kinds that read nothing are exactly xdr-streaming and policy-identity-roles", () => {
    const empty = CHECK_KINDS.filter((k) => requestsOf(k, COMMUNITY).length === 0);
    expect(empty).toEqual(["policy-identity-roles", "xdr-streaming"]);
  });
});

describe("requestsFor: the paths come from the owning builders", () => {
  it("names the plan's namespace, rules list and consumer group", () => {
    expect(requestsOf("eh-namespace", {})[0].request.path).toBe(
      "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.EventHub/namespaces/ns1",
    );
    expect(requestsOf("eh-rule-listen", {})[0].request.path).toMatch(/\/namespaces\/ns1\/authorizationRules$/);
    expect(requestsOf("eh-consumer-group", {})[0].request.path).toMatch(
      /\/eventhubs\/defender-alerts\/consumergroups\/cribl$/,
    );
  });

  it("reads Entra with the tenant-level path form", () => {
    expect(requestsOf("entra-setting", {})[0].request).toEqual({
      method: "GET",
      path: "/providers/microsoft.aadiam/diagnosticSettings",
      apiVersion: "2017-04-01",
    });
  });

  it("reads the built-in Audit set for the built-in source and the community set at the group", () => {
    expect(requestsOf("policy-set-definition", AUDIT)[0].request.path).toBe(
      "/providers/Microsoft.Authorization/policySetDefinitions/1020d527-2764-4230-92cc-7035e4fcf8a7",
    );
    expect(requestsOf("policy-set-definition", COMMUNITY)[0].request.path).toBe(
      communitySetDefinitionId("mg-1"),
    );
    expect(requestsOf("policy-assignment", AUDIT)[0].request.path).toBe(
      "/providers/Microsoft.Management/managementGroups/mg-1/providers/Microsoft.Authorization/policyAssignments",
    );
  });

  it("marks list reads and single reads", () => {
    expect(requestsOf("eh-hub", {})[0].shape).toBe("list");
    expect(requestsOf("eh-namespace", {})[0].shape).toBe("single");
    expect(requestsOf("storage-rbac", {})[0].shape).toBe("list");
  });

  it("a policy check with no expected initiative reads nothing", () => {
    expect(requestsOf("policy-assignment", {})).toEqual([]);
    expect(requestsOf("policy-definition", AUDIT)).toEqual([]);
  });

  it("eh-rule-manage reads the same rules listing as eh-rule-send, so a run reads it once", () => {
    expect(requestsOf("eh-rule-manage", {})).toEqual(requestsOf("eh-rule-send", {}));
    expect(CHECK_REQUIRED_VALUES["eh-rule-manage"]).toEqual(["subscriptionId", "resourceGroup", "namespace", "sendRule"]);
  });

  it("policy-definition is ONE GET listing the custom definitions at the management group", () => {
    const expected = {
      request: {
        method: "GET",
        path: "/providers/Microsoft.Management/managementGroups/mg-1/providers/Microsoft.Authorization/policyDefinitions",
        apiVersion: "2023-04-01",
        query: { $filter: "policyType eq 'Custom'" },
      },
      shape: "list",
      context: "custom policy definitions at mg-1",
    };
    expect(CUSTOM_POLICY_DEFINITIONS_FILTER).toBe("policyType eq 'Custom'");
    expect(requestsOf("policy-definition", COMMUNITY)).toEqual([expected]);
    expect(requestsOf("policy-definition", checkExpectationsFor("activityLog", FULL))).toEqual([expected]);
    expect(CHECK_REQUIRED_VALUES["policy-definition"]).toEqual(["managementGroupId"]);
  });

  it("lists the definitions at the same path every expected definition id sits under (AZR-52)", () => {
    const path = "/providers/Microsoft.Management/managementGroups/mg-1/providers/Microsoft.Authorization/policyDefinitions";
    expect(managementGroupDefinitionsPath("mg-1")).toBe(path);
    expect(requestsOf("policy-definition", COMMUNITY).map((r) => r.request.path)).toEqual([path]);
    const ids = [
      ...(COMMUNITY.policyDefinitions ?? []),
      ...(checkExpectationsFor("activityLog", FULL).policyDefinitions ?? []),
    ];
    expect(ids).toHaveLength(45);
    expect(ids.filter((id) => !id.startsWith(`${path}/`))).toEqual([]);
  });
});

describe("checkExpectationsFor", () => {
  it("Entra's categories are the Standard profile's, without NonInteractiveUserSignInLogs", () => {
    const ex = checkExpectationsFor("entraId", FULL, ["Standard"]);
    expect([...(ex.entraCategories ?? [])].sort()).toEqual([...ENTRA_PROFILE_CATEGORIES.Standard].sort());
    expect(ex.entraCategories).not.toContain("NonInteractiveUserSignInLogs");
  });

  it("the built-in initiative expects Cribl-AU-Central on the Audit set", () => {
    expect(AUDIT.policy?.assignmentName).toBe("Cribl-AU-Central");
    expect(AUDIT.expectedHubPrefix).toBe("insights-logs-");
  });

  it("the community initiative has no expectation until the management group is set", () => {
    expect(checkExpectationsFor("communityPolicyInitiative", { ...FULL, managementGroupId: "" }).policy).toBeUndefined();
  });

  it("the Activity Log expects its one community definition at the group, and no initiative", () => {
    const ex = checkExpectationsFor("activityLog", FULL);
    expect(ex.policyDefinitions).toEqual([
      "/providers/Microsoft.Management/managementGroups/mg-1/providers/Microsoft.Authorization" +
        "/policyDefinitions/Cribl-Community-ActivityLog-DiagSettings-EventHub",
    ]);
    expect(ex.policy).toBeUndefined();
    expect(checkExpectationsFor("activityLog", { ...FULL, managementGroupId: "" }).policyDefinitions).toBeUndefined();
  });

  it("the community initiative expects one definition per service of the chosen tiers", () => {
    const base = "/providers/Microsoft.Management/managementGroups/mg-1/providers/Microsoft.Authorization/policyDefinitions/";
    expect(checkExpectationsFor("communityPolicyInitiative", FULL, ["Networking"]).policyDefinitions).toEqual([
      `${base}Cribl-LoadBalancer-DiagSettings-EH`,
      `${base}Cribl-TrafficManager-DiagSettings-EH`,
      `${base}Cribl-CDNEndpoint-DiagSettings-EH`,
    ]);
    // The default (All) is the 44 resource types the catalog advertises.
    expect(COMMUNITY.policyDefinitions).toHaveLength(44);
    expect(new Set(COMMUNITY.policyDefinitions).size).toBe(44);
    expect(AUDIT.policyDefinitions).toBeUndefined();
  });

  it("Defender expects the named hub; every source yields an object", () => {
    expect(checkExpectationsFor("defenderExport", FULL).expectedHubs).toEqual(["defender-alerts"]);
    for (const s of ONBOARDING_SOURCES) expect(typeof checkExpectationsFor(s.id, FULL)).toBe("object");
  });
});
