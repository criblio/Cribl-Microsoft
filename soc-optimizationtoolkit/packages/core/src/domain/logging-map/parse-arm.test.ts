// Pins for the logging-map ARM parsers (AZR-19, U1a), plus the layering pin
// for the whole domain/logging-map folder.
//
// Reading the filesystem is fine in a test: @soc/core's purity rule is about
// the shipped module, and the architecture audit exempts *.test.ts.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  definitionKindOf,
  exemptionScopeOf,
  parseAssignments,
  parseDefinitions,
  parseDescendants,
  parseExemptions,
  parseManagementGroups,
  parseRoleAssignments,
  parseRoleDefinitions,
  parseSetDefinitions,
  parseSubscriptions,
} from "./parse-arm";

const HERE = dirname(fileURLToPath(import.meta.url));
const MG = "/providers/Microsoft.Management/managementGroups";

describe("layering: domain/logging-map imports no usecase", () => {
  // Any import / export-from / dynamic import whose specifier reaches into the
  // usecases layer. Matching specifiers rather than the bare word lets the
  // files DOCUMENT the rule without tripping it.
  const IMPORTS_USECASES = /(?:from\s*|import\s*\(\s*|import\s+)["'][^"']*usecases\//;

  it("the matcher catches every spelling it must", () => {
    expect(IMPORTS_USECASES.test('import { is2xx } from "../../usecases/arm-http";')).toBe(true);
    expect(IMPORTS_USECASES.test("export * from '../../usecases/x';")).toBe(true);
    expect(IMPORTS_USECASES.test('const m = await import("../../usecases/y");')).toBe(true);
    expect(IMPORTS_USECASES.test("// see usecases/arm-http.ts")).toBe(false);
  });

  it("no shipped file in this folder imports from usecases", () => {
    const files = readdirSync(HERE).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    const offenders = files.filter((f) => IMPORTS_USECASES.test(readFileSync(join(HERE, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("hierarchy parsers", () => {
  it("descendants: rows with parents, and an id-less row is counted", () => {
    const out = parseDescendants([
      {
        id: `${MG}/Platform`,
        type: "Microsoft.Management/managementGroups",
        name: "Platform",
        properties: { displayName: "Platform", parent: { id: `${MG}/tenant` } },
      },
      {
        id: "/subscriptions/s1",
        type: "Microsoft.Management/managementGroups/subscriptions",
        name: "s1",
        properties: { displayName: "Prod", parent: { id: `${MG}/Platform` } },
      },
      { name: "no-id", properties: {} },
      "not an object",
    ]);
    expect(out.malformedCount).toBe(2);
    expect(out.rows).toEqual([
      { id: `${MG}/Platform`, name: "Platform", displayName: "Platform", parentId: `${MG}/tenant` },
      { id: "/subscriptions/s1", name: "s1", displayName: "Prod", parentId: `${MG}/Platform` },
    ]);
  });

  it("management group with path: details.parent wins, path is the fallback", () => {
    const out = parseManagementGroups([
      {
        id: `${MG}/A`,
        name: "A",
        properties: { displayName: "A", details: { parent: { id: `${MG}/root` } }, path: [{ name: "root" }] },
      },
      {
        id: `${MG}/B`,
        name: "B",
        // ARM's shape: the path lives under properties.details.
        properties: { displayName: "B", details: { path: [{ name: "root" }, { name: "A" }, { name: "B" }] } },
      },
      { id: `${MG}/C`, name: "C", properties: {} },
    ]);
    expect(out.malformedCount).toBe(0);
    expect(out.rows.map((r) => r.parentId)).toEqual([`${MG}/root`, `${MG}/A`, null]);
    expect(out.rows[1]?.pathNames).toEqual(["root", "A", "B"]);
  });

  it("subscriptions never carry a parent", () => {
    const out = parseSubscriptions([
      { id: "/subscriptions/s1", subscriptionId: "s1", displayName: "Prod", state: "Enabled" },
      { subscriptionId: "s2" },
      { displayName: "nothing" },
    ]);
    expect(out.malformedCount).toBe(1);
    expect(out.rows).toEqual([
      { id: "/subscriptions/s1", name: "s1", displayName: "Prod", parentId: null, subscriptionId: "s1", state: "Enabled" },
      { id: "/subscriptions/s2", name: "s2", displayName: "", parentId: null, subscriptionId: "s2", state: "" },
    ]);
  });
});

describe("parseAssignments", () => {
  const UAI = "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cribl-diag-policy-identity";

  it("projects every field the map uses", () => {
    const out = parseAssignments([
      {
        id: `${MG}/corp/providers/Microsoft.Authorization/policyAssignments/Cribl-AL-Central`,
        name: "Cribl-AL-Central",
        identity: { type: "UserAssigned", userAssignedIdentities: { [UAI]: { principalId: "p-1", clientId: "c" } } },
        properties: {
          displayName: "All logs",
          scope: `${MG}/corp`,
          policyDefinitionId: "/providers/Microsoft.Authorization/policySetDefinitions/85175a36-2f12-419a-96b4-18d5b0096531",
          notScopes: ["/subscriptions/x", 7],
          parameters: { eventHubAuthorizationRuleId: { value: "rule" }, noValue: {} },
          metadata: { createdBy: "someone" },
          resourceSelectors: [{ name: "r", selectors: [{ kind: "resourceLocation", in: ["eastus"] }] }],
        },
      },
    ]);
    expect(out.malformedCount).toBe(0);
    expect(out.rows[0]).toEqual({
      id: `${MG}/corp/providers/Microsoft.Authorization/policyAssignments/Cribl-AL-Central`,
      name: "Cribl-AL-Central",
      displayName: "All logs",
      scope: `${MG}/corp`,
      policyDefinitionId: "/providers/Microsoft.Authorization/policySetDefinitions/85175a36-2f12-419a-96b4-18d5b0096531",
      definitionKind: "set",
      notScopes: ["/subscriptions/x"],
      parameters: { eventHubAuthorizationRuleId: "rule" },
      metadata: { createdBy: "someone" },
      identity: { type: "UserAssigned", principalId: null, userAssigned: [{ id: UAI, principalId: "p-1" }] },
      enforcementMode: "Default",
      resourceSelectors: [{ name: "r", selectors: [{ kind: "resourceLocation", in: ["eastus"], notIn: [] }] }],
    });
  });

  it("defaults a missing identity to None and counts a row with no id", () => {
    const out = parseAssignments([{ name: "x", properties: {} }, { id: "/a", name: "a", identity: { type: "SystemAssigned", principalId: "sp" } }]);
    expect(out.malformedCount).toBe(1);
    expect(out.rows[0]?.identity).toEqual({ type: "SystemAssigned", principalId: "sp", userAssigned: [] });
    expect(parseAssignments([{ id: "/b" }]).rows[0]?.identity).toEqual({ type: "None", principalId: null, userAssigned: [] });
  });

  it("definitionKindOf reads the path, any casing", () => {
    expect(definitionKindOf("/providers/microsoft.authorization/POLICYDEFINITIONS/x")).toBe("policy");
    expect(definitionKindOf("/providers/Microsoft.Authorization/policySetDefinitions/x")).toBe("set");
    expect(definitionKindOf("")).toBe("unknown");
  });
});

describe("parseExemptions", () => {
  it("derives the scope from the id and keeps the expiry", () => {
    const rg = "/subscriptions/s1/resourceGroups/rg1";
    const out = parseExemptions([
      {
        id: `${rg}/providers/Microsoft.Authorization/policyExemptions/ex1`,
        name: "ex1",
        properties: {
          policyAssignmentId: "/a/1",
          exemptionCategory: "Waiver",
          expiresOn: "2026-01-01T00:00:00Z",
          policyDefinitionReferenceIds: ["r1"],
        },
      },
      { name: "no id" },
    ]);
    expect(out.malformedCount).toBe(1);
    expect(out.rows).toEqual([
      {
        id: `${rg}/providers/Microsoft.Authorization/policyExemptions/ex1`,
        name: "ex1",
        scope: rg,
        policyAssignmentId: "/a/1",
        category: "Waiver",
        expiresOn: "2026-01-01T00:00:00Z",
        policyDefinitionReferenceIds: ["r1"],
      },
    ]);
    expect(exemptionScopeOf("/subscriptions/s/providers/microsoft.authorization/POLICYEXEMPTIONS/e")).toBe("/subscriptions/s");
    expect(exemptionScopeOf("garbage")).toBe("");
  });
});

describe("definition parsers", () => {
  it("a definition exposes then.effect and then.details.type as written", () => {
    const out = parseDefinitions([
      {
        id: "/providers/Microsoft.Authorization/policyDefinitions/d1",
        name: "d1",
        properties: {
          displayName: "Diag to EH",
          policyType: "Custom",
          mode: "Indexed",
          parameters: { effect: { type: "String", defaultValue: "DeployIfNotExists" }, eventHubName: { type: "String" } },
          policyRule: { if: {}, then: { effect: "[parameters('effect')]", details: { type: "Microsoft.Insights/diagnosticSettings" } } },
        },
      },
      {},
    ]);
    expect(out.malformedCount).toBe(1);
    const d = out.rows[0];
    expect(d?.thenEffect).toBe("[parameters('effect')]");
    expect(d?.thenDetailsType).toBe("Microsoft.Insights/diagnosticSettings");
    expect(d?.parameters).toEqual({
      effect: { type: "String", hasDefault: true, defaultValue: "DeployIfNotExists" },
      eventHubName: { type: "String", hasDefault: false, defaultValue: undefined },
    });
  });

  it("a set lists its members with unwrapped parameter values", () => {
    const out = parseSetDefinitions([
      {
        id: "/providers/Microsoft.Authorization/policySetDefinitions/s1",
        name: "s1",
        properties: {
          policyType: "BuiltIn",
          policyDefinitions: [
            { policyDefinitionId: "/p/1", policyDefinitionReferenceId: "r1", parameters: { effect: { value: "[parameters('effect')]" } } },
            { policyDefinitionReferenceId: "orphan" },
          ],
        },
      },
    ]);
    expect(out.malformedCount).toBe(0);
    expect(out.rows[0]?.members).toEqual([
      { policyDefinitionId: "/p/1", referenceId: "r1", parameters: { effect: "[parameters('effect')]" } },
    ]);
  });
});

describe("role parsers", () => {
  it("role assignments become grants with no name yet", () => {
    const out = parseRoleAssignments([
      { id: "/ra/1", properties: { roleDefinitionId: "/rd/1", scope: `${MG}/corp`, principalId: "p" } },
      { id: "/ra/2", properties: {} },
    ]);
    expect(out.malformedCount).toBe(1);
    expect(out.rows).toEqual([{ scope: `${MG}/corp`, roleDefinitionId: "/rd/1", roleName: null }]);
  });

  it("role definitions need an id and a roleName", () => {
    const out = parseRoleDefinitions([
      { id: "/rd/1", properties: { roleName: "Monitoring Contributor" } },
      { id: "/rd/2", properties: {} },
    ]);
    expect(out.malformedCount).toBe(1);
    expect(out.rows).toEqual([{ id: "/rd/1", roleName: "Monitoring Contributor" }]);
  });
});
