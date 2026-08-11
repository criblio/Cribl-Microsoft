/**
 * Contract tests for the app-registration permission catalog.
 *
 * Two failure modes are worth pinning, and they pull in opposite directions:
 *
 *   UNDER-ASKING - the reason this module exists. A ticket that omits a
 *   permission produces an app that authenticates and then fails one request at
 *   a time, each failure needing its own new ticket. So the plan must carry
 *   everything, including the two roles no setup path grants.
 *
 *   OVER-ASKING - the reason it is not just a flat list. Asking a security team
 *   for Contributor AND Sentinel Contributor at the same scope reads as someone
 *   who does not know what they need, and gets the whole request refused. The
 *   suppression rule is what prevents that, and it is pinned per setup path.
 *
 * The plan is also the ONE place the permission model lives - restating any of
 * it here would recreate exactly the drift the module was built to remove - so
 * these tests assert relationships (present, suppressed, non-duplicated,
 * explained) rather than transcribing role names into a second list.
 */
import { describe, expect, it } from "vitest";

import {
  FEATURE_ROLES,
  GRAPH_PERMISSIONS,
  appPermissionPlan,
  graphPermissions,
  rbacPermissions,
} from "./app-permissions";
import { rolePlanForSetupPath } from "../role-plan";
import type { AzureSetupPath } from "../azure-config";

const PATHS: AzureSetupPath[] = ["existing", "lab-new-rg", "lab-byo-rg"];

const names = (path: AzureSetupPath): string[] =>
  appPermissionPlan(path).map((p) => p.name);

describe("appPermissionPlan - completeness", () => {
  it("carries every role the setup path's own plan asks for", () => {
    // The load-bearing composition pin: role-plan stays the source of truth, so
    // a role added there must reach this ticket without anyone editing it here.
    for (const path of PATHS) {
      for (const req of rolePlanForSetupPath(path)) {
        const match = appPermissionPlan(path).find(
          (p) => p.name === req.role && p.scopeLevel === req.scopeLevel,
        );
        expect(match, `${path}: ${req.role}`).toBeDefined();
        expect(match?.necessity).toBe("core");
        expect(match?.justification).toBe(req.justification);
        expect(match?.condition).toBe(req.condition);
      }
    }
  });

  it("asks for the Graph directory read on EVERY path", () => {
    // The permission that was missing from every ticket before this module. It
    // is consented on the registration, not per scope, so no setup path escapes
    // needing it - and the picker it feeds is where operators paste the wrong
    // id when they have to find it themselves.
    for (const path of PATHS) {
      expect(names(path)).toContain("Application.Read.All");
    }
  });

  it("asks for Application.Read.All, NOT the broader Directory.Read.All", () => {
    // Both satisfy the servicePrincipals read; the broader one also grants read
    // over users, groups and devices, none of which this app touches. Asking
    // for more than is needed is how a request gets refused on principle.
    for (const path of PATHS) {
      expect(names(path)).not.toContain("Directory.Read.All");
    }
  });

  it("explains every permission - which feature, why, and the cost of refusing", () => {
    // A permission with no stated cost invites a blanket no, because the
    // approver cannot tell a nice-to-have from a blocker.
    for (const path of PATHS) {
      for (const permission of appPermissionPlan(path)) {
        expect(permission.feature.length, permission.name).toBeGreaterThan(0);
        expect(permission.justification.length, permission.name).toBeGreaterThan(20);
        expect(permission.withoutIt.length, permission.name).toBeGreaterThan(20);
      }
    }
  });
});

describe("appPermissionPlan - suppression (over-asking)", () => {
  it("NEVER asks for the same role twice at the same scope", () => {
    for (const path of PATHS) {
      const rbac = rbacPermissions(appPermissionPlan(path));
      const keys = rbac.map((p) => `${p.name}@${p.scopeLevel}`);
      expect(new Set(keys).size, path).toBe(keys.length);
    }
  });

  it("existing: needs BOTH feature roles - its plan grants neither", () => {
    // Reader + Monitoring Contributor + Log Analytics Contributor covers no
    // SecurityInsights write and no role assignment, so both are real asks.
    const found = names("existing");
    expect(found).toContain("Microsoft Sentinel Contributor");
    expect(found).toContain("RBAC Administrator");
  });

  it("lab-new-rg: asks for NO feature roles - subscription Contributor + RBAC Admin already cover them", () => {
    const found = names("lab-new-rg");
    expect(found).not.toContain("Microsoft Sentinel Contributor");
    // Present once, from the setup plan itself - not added a second time.
    expect(found.filter((n) => n === "RBAC Administrator")).toHaveLength(1);
  });

  it("lab-byo-rg: Contributor covers Sentinel content but NOT role assignment", () => {
    // The distinction the suppression rule has to get right: Contributor is
    // broad enough to write SecurityInsights resources and deliberately
    // excludes Microsoft.Authorization writes, which is exactly why that path's
    // own comment says the app cannot assign roles.
    const found = names("lab-byo-rg");
    expect(found).not.toContain("Microsoft Sentinel Contributor");
    expect(found).toContain("RBAC Administrator");
  });

  it("suppresses on a BROADER scope, not just an equal one", () => {
    // lab-new-rg holds Contributor at the subscription; the feature role is
    // scoped to a resource group. Comparing scopes for equality alone would ask
    // for a role the caller already holds everywhere.
    const contributor = rolePlanForSetupPath("lab-new-rg").find(
      (r) => r.role === "Contributor",
    );
    expect(contributor?.scopeLevel).toBe("subscription");
    const sentinel = FEATURE_ROLES.find(
      (r) => r.name === "Microsoft Sentinel Contributor",
    );
    expect(sentinel?.scopeLevel).toBe("resourceGroup");
    expect(names("lab-new-rg")).not.toContain("Microsoft Sentinel Contributor");
  });
});

describe("appPermissionPlan - shape", () => {
  it("never leaks the suppression bookkeeping into a plan entry", () => {
    // `coveredBy` decides what to ask for; it is not something a ticket reader
    // should ever see, and a spread would have carried it straight through.
    for (const path of PATHS) {
      for (const permission of appPermissionPlan(path)) {
        expect(permission).not.toHaveProperty("coveredBy");
      }
    }
  });

  it("splits cleanly into the two systems, and they are granted differently", () => {
    const plan = appPermissionPlan("existing");
    expect(graphPermissions(plan).length + rbacPermissions(plan).length).toBe(
      plan.length,
    );
    // Graph permissions are tenant-wide by nature; conflating them with a
    // scoped RBAC role is what sends an operator to the wrong approver.
    for (const permission of graphPermissions(plan)) {
      expect(permission.scopeLevel).toBe("tenant");
    }
    for (const permission of rbacPermissions(plan)) {
      expect(permission.scopeLevel).not.toBe("tenant");
    }
  });

  it("marks setup-path roles core and added roles feature", () => {
    // The whole point of the split: an approver may refuse a [feature] line and
    // still leave a working app, and the ticket says so.
    const plan = appPermissionPlan("existing");
    const core = plan.filter((p) => p.necessity === "core").map((p) => p.name);
    expect(core).toEqual(rolePlanForSetupPath("existing").map((r) => r.role));
  });

  it("returns fresh objects - a caller cannot mutate the catalog", () => {
    const first = appPermissionPlan("existing");
    first[0]!.name = "mutated";
    expect(appPermissionPlan("existing")[0]?.name).toBe(
      GRAPH_PERMISSIONS[0]?.name,
    );
  });
});
