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
  OUTSIDE_SCOPE_CAVEAT,
  appPermissionPlan,
  entraDirectoryRoles,
  preflightUnmeasuredGrants,
  scopeCovers,
  graphPermissions,
  rbacPermissions,
} from "./app-permissions";
import { rolePlanForSetupPath } from "../role-plan";
import { REQUIRED_ACTIONS, preflightPathForSetupPath } from "../azure-permissions";
import type { AzureSetupPath } from "../azure-config";
import {
  LEAST_PRIVILEGE_FUNCTIONS,
  leastRoleFor,
  privilegeOperation,
} from "../least-privilege";

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

  it("asks for exactly the two Graph permissions, both optional features", () => {
    // LicenseAssignment.Read.All feeds the E5 granted figure (data allowances).
    // It is a feature, so an approver can refuse it without blocking setup.
    expect(GRAPH_PERMISSIONS.map((p) => p.name)).toEqual([
      "Application.Read.All",
      "LicenseAssignment.Read.All",
    ]);
    for (const p of GRAPH_PERMISSIONS) expect(p.necessity, p.name).toBe("feature");
    for (const path of PATHS) {
      expect(names(path)).toContain("LicenseAssignment.Read.All");
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

describe("what the ticket ASKS FOR is what the preflight MEASURES", () => {
  // The invariant that closes architecture-audit finding 1 (2026-08-11). The
  // ticket had grown to ask for two roles nothing checked, so an identity
  // holding neither passed the preflight clean and failed later, one request at
  // a time. The two lists are built independently and always will be - this is
  // the only thing that notices when they drift apart again.
  it("checks a feature action on every path whose plan asks for a MEASURABLE feature role", () => {
    // Feature roles the path's preflight cannot measure (listKeys, granted on
    // the namespace alone; the Defender export, measured only by the
    // subscription evaluation) say so in FEATURE_ROLES.unmeasured and are left
    // out - asking for them is the AZR-61 fix, and pretending to measure them
    // would be the dishonest kind of green.
    const unmeasured = new Set(
      FEATURE_ROLES.filter((r) => r.unmeasured !== undefined).map((r) => r.key),
    );
    for (const path of PATHS) {
      const asksForFeatureRole = appPermissionPlan(path).some(
        (p) => p.kind === "azure-rbac" && p.necessity === "feature" && !unmeasured.has(p.key),
      );
      const checksFeatureAction = REQUIRED_ACTIONS[
        preflightPathForSetupPath(path)
      ].some((a) => a.necessity === "feature");
      expect(checksFeatureAction, `${path} asks=${asksForFeatureRole}`).toBe(
        asksForFeatureRole,
      );
    }
  });

  it("measures the DCR ingestion grant wherever it asks for RBAC Administrator", () => {
    // Named concretely as well as structurally: the generic pin above would
    // still pass if the feature action checked were something unrelated.
    for (const path of PATHS) {
      const asks = appPermissionPlan(path).some(
        (p) => p.name === "RBAC Administrator",
      );
      const checks = REQUIRED_ACTIONS[preflightPathForSetupPath(path)].some(
        (a) => a.action === "Microsoft.Authorization/roleAssignments/write",
      );
      expect(checks, path).toBe(asks);
    }
  });

  it("measures Sentinel content wherever it asks for Sentinel Contributor", () => {
    for (const path of PATHS) {
      const asks = appPermissionPlan(path).some(
        (p) => p.name === "Microsoft Sentinel Contributor",
      );
      const checks = REQUIRED_ACTIONS[preflightPathForSetupPath(path)].some(
        (a) => a.action.startsWith("Microsoft.SecurityInsights/"),
      );
      expect(checks, path).toBe(asks);
    }
  });
});

describe("appPermissionPlan - suppression (over-asking)", () => {
  it("gives every plan entry a distinct key, so one role at two scopes is two choices", () => {
    // The Partially Connected checklist stores keys; two entries sharing one
    // would be ticked and refused together (AZR-84 review).
    for (const path of PATHS) {
      const keys = appPermissionPlan(path).map((p) => p.key);
      expect(new Set(keys).size, path).toBe(keys.length);
    }
    // A setup-path role keeps its name as its key, so saved choices still match.
    for (const req of rolePlanForSetupPath("existing")) {
      expect(appPermissionPlan("existing").find((p) => p.name === req.role && p.scopeLevel === req.scopeLevel)?.key).toBe(req.role);
    }
  });

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

  it("lab-new-rg: asks for no feature role its subscription grants reach - only those on resources outside it", () => {
    // Subscription Contributor + RBAC Admin cover every in-subscription
    // feature role; what is left is on a resource that may sit elsewhere
    // (AZR-84), each caveated so an approver skips it when it is local.
    // The management group sits ABOVE the subscription, so it is asked too.
    const outside = appPermissionPlan("lab-new-rg").filter((p) => p.necessity === "feature" && p.kind === "azure-rbac");
    for (const p of outside) {
      if (p.scopeLevel === "managementGroup") continue;
      expect(p.scopeLevel, p.key).toBe("resource");
      expect(p.scopeCaveat, p.key).toBe(OUTSIDE_SCOPE_CAVEAT);
    }
    expect(outside.filter((p) => p.scopeLevel === "managementGroup").map((p) => p.key)).toEqual([
      "Reader (management group)",
    ]);
    const found = names("lab-new-rg");
    expect(found).not.toContain("Microsoft Sentinel Contributor");
    // Present once, from the setup plan itself - not added a second time.
    expect(found.filter((n) => n === "RBAC Administrator")).toHaveLength(1);
  });

  it("lab-byo-rg: Contributor covers Sentinel content but NOT role assignment", () => {
    // The distinction the suppression rule has to get right: Contributor is
    // broad enough to write SecurityInsights resources and deliberately
    // excludes Microsoft.Authorization writes. RBAC Administrator is now the
    // path's own CORE role (the lab assigns its TTL identity Contributor in
    // both resource-group modes - AZR-61 audit), and its condition also allows
    // Monitoring Metrics Publisher, so the DCR-grant feature role is covered
    // and asked once, not twice.
    const found = names("lab-byo-rg");
    expect(found).not.toContain("Microsoft Sentinel Contributor");
    expect(found.filter((n) => n === "RBAC Administrator")).toHaveLength(1);
    expect(
      appPermissionPlan("lab-byo-rg").find((p) => p.name === "RBAC Administrator")?.necessity,
    ).toBe("core");
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
        expect(permission).not.toHaveProperty("operationId");
        expect(permission).not.toHaveProperty("unmeasured");
        expect(permission).not.toHaveProperty("broaderScopeWhy");
      }
    }
  });

  it("splits cleanly into the three systems, and they are granted differently", () => {
    const plan = appPermissionPlan("existing");
    expect(
      graphPermissions(plan).length +
        rbacPermissions(plan).length +
        entraDirectoryRoles(plan).length,
    ).toBe(plan.length);
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

describe("AZR-61 - roles come from the least-privilege registry", () => {
  it("names the Graph permission the registry names for the identity picker", () => {
    expect(GRAPH_PERMISSIONS.map((p) => p.name)).toEqual([
      leastRoleFor("graph.servicePrincipals.read"),
      leastRoleFor("graph.subscribedSkus.read"),
    ]);
  });

  it("names every feature role after the registry's least role for the call it unlocks", () => {
    for (const role of FEATURE_ROLES) {
      expect(role.name, role.feature).toBe(leastRoleFor(role.operationId));
    }
  });

  it("suppresses a feature role only on a role the registry says also grants it", () => {
    for (const role of FEATURE_ROLES) {
      const op = privilegeOperation(role.operationId);
      for (const holder of role.coveredBy) {
        expect(
          holder === op.leastRole || op.alsoGrantedBy.includes(holder),
          `${role.name} coveredBy ${holder}`,
        ).toBe(true);
      }
    }
  });

  it("takes each feature role's scope from the registry, unless it says why it asks broader", () => {
    // Found by review: the name came from the registry but the scope was a
    // literal, and two already disagreed with no pin (Sentinel content and
    // the DCR grant are registry 'resource' scope, asked at the RG). A
    // registry scope correction must reach the ticket, or be argued against.
    const breadth = { resource: 0, resourceGroup: 1, subscription: 2, managementGroup: 3 } as const;
    for (const role of FEATURE_ROLES) {
      const registry = privilegeOperation(role.operationId).scope;
      if (role.broaderScopeWhy === undefined) {
        expect(role.scopeLevel, role.name).toBe(registry);
      } else {
        expect(role.broaderScopeWhy.length, role.name).toBeGreaterThan(40);
        expect(breadth[role.scopeLevel], role.name).toBeGreaterThan(breadth[registry as keyof typeof breadth]);
      }
    }
  });

  it("never claims, on any path, that no subscription-scope rights are needed while asking for one", () => {
    // AZR-61 audit discrepancy 7: the byo lab's own plan said so, beside a
    // subscription-scope feature role in the same ticket.
    for (const path of PATHS) {
      const plan = appPermissionPlan(path);
      if (plan.some((p) => p.scopeLevel === "subscription")) {
        for (const p of plan) {
          expect(p.justification, `${path} ${p.name}`).not.toMatch(/no subscription-scope/i);
        }
      }
    }
  });

  it("asks for Event Hub listKeys on the namespace (audit discrepancy 1, high)", () => {
    // Create Cribl source with the listKeys credential and the Defender export
    // both POST listKeys, and no plan asked for any role that grants it.
    const role = leastRoleFor("eventhub.rule.listKeys");
    const entry = appPermissionPlan("existing").find((p) => p.name === role);
    expect(entry?.necessity).toBe("feature");
    expect(entry?.scopeLevel).toBe("resource");
    expect(entry?.resource).toBe(privilegeOperation("eventhub.rule.listKeys").scopeNote);
    expect(entry?.justification).toContain("listKeys");
    // The ticket must warn that Validate's rule checks pass under Reader while
    // listKeys still fails - otherwise a green Validate reads as permission.
    expect(entry?.justification).toContain("Reader");
    // RE-PINNED (AZR-84): the namespace may sit in another subscription, which
    // no setup-path grant reaches - subscription Contributor included - so
    // every path asks, and the ticket says to skip it when a role above
    // already covers the namespace.
    for (const path of PATHS) {
      const asked = appPermissionPlan(path).find((p) => p.name === role);
      expect(asked?.scopeLevel, path).toBe("resource");
      expect(asked?.scopeCaveat, path).toBe(OUTSIDE_SCOPE_CAVEAT);
    }
  });

  it("asks for the Defender export's automation write and list (audit discrepancy 2, high)", () => {
    // The preflight measured these as feature checks; no ticket asked for a
    // role that grants automations/write.
    const writer = leastRoleFor("defender.automation.write");
    const reader = leastRoleFor("defender.automations.list");
    const existing = appPermissionPlan("existing");
    expect(existing.find((p) => p.name === writer)?.scopeLevel).toBe("resourceGroup");
    expect(existing.find((p) => p.name === writer)?.necessity).toBe("feature");
    // Reader at the subscription already covers the list and the plans read.
    expect(names("existing")).not.toContain(reader);
    expect(names("lab-new-rg")).not.toContain(writer);
    expect(names("lab-new-rg")).not.toContain(reader);
    // The byo lab holds nothing at the subscription.
    expect(names("lab-byo-rg")).toContain(reader);
  });
});

describe("AZR-84 - grants on resources outside the configured scope", () => {
  // The DCE a DCR names, the private link scope a DCE joins and the Event Hub
  // namespace a source reads may each sit in another resource group or
  // subscription. The registry knew; no plan asked.
  const outsideRow = (path: AzureSetupPath, operationId: Parameters<typeof leastRoleFor>[0]) => {
    const op = privilegeOperation(operationId);
    return appPermissionPlan(path).find(
      (p) => p.name === op.leastRole && p.scopeLevel === "resource" && p.resource === op.scopeNote,
    );
  };

  it("asks for exactly these roles on exactly these resources, on every path", () => {
    for (const path of PATHS) {
      const rows = appPermissionPlan(path)
        .filter((p) => p.scopeLevel === "resource")
        .map((p) => `${p.name} @ ${p.resource ?? ""}`);
      expect(rows, path).toEqual([
        "Azure Event Hubs Data Owner @ the Event Hub namespace that holds the rule",
        "Monitoring Contributor @ the Azure Monitor Private Link Scope, which may sit in another resource group or subscription",
        "Monitoring Reader @ the DCE, which a DCR may name in another resource group or subscription",
        "Reader @ the Event Hub namespace",
      ]);
    }
  });

  it("keeps the namespace Reader and the DCE read although the existing plan holds Reader at the subscription", () => {
    // The suppression this card is about: subscription Reader is in both
    // operations' coveredBy, and a subscription grant used to count as
    // covering any resource. Matched on scope and resource words, not name -
    // Reader is also the core subscription row.
    const ns = outsideRow("existing", "eventhub.namespace.read");
    expect(ns?.necessity).toBe("feature");
    expect(ns?.key).toBe("Reader (Event Hub namespace)");
    expect(ns?.scopeCaveat).toBe(OUTSIDE_SCOPE_CAVEAT);
    expect(outsideRow("existing", "dce.read")?.name).toBe("Monitoring Reader");
    const ampls = outsideRow("existing", "ampls.scopedResource.write");
    expect(ampls?.name).toBe("Monitoring Contributor");
    expect(ampls?.key).toBe("Monitoring Contributor (private link scope)");
  });

  it("does not let a subscription grant cover a resource that may sit outside it", () => {
    expect(scopeCovers("subscription", { scopeLevel: "resource", outsideConfiguredScope: true })).toBe(false);
    expect(scopeCovers("subscription", { scopeLevel: "resource" })).toBe(true);
    expect(scopeCovers("resourceGroup", { scopeLevel: "resource" })).toBe(false);
  });

  it("reports those grants to the preflight as not measured, with the ticket's words", () => {
    expect(preflightUnmeasuredGrants("existing").slice(0, 4)).toEqual([
      { name: "Azure Event Hubs Data Owner", where: "the Event Hub namespace that holds the rule", feature: "Read an Event Hub rule's connection string" },
      { name: "Monitoring Contributor", where: privilegeOperation("ampls.scopedResource.write").scopeNote, feature: "Associate a new DCE with an Azure Monitor Private Link Scope" },
      { name: "Monitoring Reader", where: privilegeOperation("dce.read").scopeNote, feature: "Show the ingestion endpoint of a DCE-based DCR" },
      { name: "Reader", where: "the Event Hub namespace", feature: "Read an Event Hub namespace, its rules and consumer groups" },
    ]);
  });

  it("never measures them as denied: no preflight scope checks their actions", () => {
    // Honesty pin: these grants are on resources no permissions read reaches,
    // so a required action for them would read as denied without measuring.
    const actions = new Set(Object.values(REQUIRED_ACTIONS).flat().map((a) => a.action));
    for (const id of ["ampls.scopedResource.write", "dce.read", "eventhub.namespace.read"] as const) {
      expect(actions.has(privilegeOperation(id).operation), id).toBe(false);
    }
  });
});

describe("AZR-82 - management-group and tenant reads are asked for", () => {
  // Validate and the Logging Map read policy and the management group tree at
  // the customer's management group, and Validate reads the tenant's Entra
  // diagnostic settings. No plan asked for either.

  it("covers every management-group and tenant read of Validate and the Logging Map, by role AND scope", () => {
    // Refuter correction: matching on the role name alone passes today,
    // because Reader is already held - at the SUBSCRIPTION. The grant must be
    // at the scope the registry names.
    const fns = LEAST_PRIVILEGE_FUNCTIONS.filter((f) => f.id === "validate" || f.id === "logging-map");
    expect(fns).toHaveLength(2);
    const needs = new Set(
      fns.flatMap((f) => f.operations).filter((id) => {
        const scope = privilegeOperation(id).scope;
        return scope === "managementGroup" || scope === "tenant";
      }),
    );
    expect([...needs].sort()).toEqual([
      "entra.diagnosticSettings.read",
      "managementGroup.read",
      "managementGroups.descendants.read",
      "managementGroups.list",
      "policy.assignments.read",
      "policy.definition.read",
      "policy.exemptions.read",
      "policy.mgDefinitions.list",
      "policy.remediations.read",
    ]);
    for (const path of PATHS) {
      const plan = appPermissionPlan(path);
      for (const id of needs) {
        const op = privilegeOperation(id);
        const grants = [op.leastRole, ...op.alsoGrantedBy];
        const asked = plan.some((p) => grants.includes(p.name) && p.scopeLevel === op.scope);
        expect(asked, `${path}: ${id}`).toBe(true);
      }
    }
  });

  it("asks for Reader at the management group, a separate choice from subscription Reader", () => {
    const row = appPermissionPlan("existing").find((p) => p.scopeLevel === "managementGroup");
    expect(row).toEqual({
      kind: "azure-rbac",
      name: "Reader",
      key: "Reader (management group)",
      scopeLevel: "managementGroup",
      feature: "Read policy and the management group tree",
      justification: expect.stringContaining("Management Group Reader alone misses remediations and the tree"),
      withoutIt: expect.stringContaining("could not be read"),
      necessity: "feature",
      resource: "the highest management group the customer will grant, not the Tenant Root Group",
    });
  });

  it("never lets a subscription grant cover a management-group need", () => {
    expect(scopeCovers("subscription", { scopeLevel: "managementGroup" })).toBe(false);
    expect(scopeCovers("resourceGroup", { scopeLevel: "managementGroup" })).toBe(false);
  });

  it("asks for the Entra diagnostic-settings read as an optional, unverified directory role", () => {
    for (const path of PATHS) {
      const roles = entraDirectoryRoles(appPermissionPlan(path));
      expect(roles.map((r) => [r.name, r.scopeLevel, r.necessity, r.unverified]), path).toEqual([
        ["Security Administrator", "tenant", "feature", true],
      ]);
    }
    expect(leastRoleFor("entra.diagnosticSettings.read")).toBe("Security Administrator");
  });

  it("reports both to the preflight as not measured", () => {
    const grants = preflightUnmeasuredGrants("existing");
    expect(grants).toContainEqual({
      name: "Reader",
      where: "the management group: the highest management group the customer will grant, not the Tenant Root Group",
      feature: "Read policy and the management group tree",
    });
    expect(grants).toContainEqual({
      name: "Security Administrator",
      where: "the tenant (Entra ID directory role)",
      feature: "Check the Entra ID diagnostic settings",
    });
  });
});
