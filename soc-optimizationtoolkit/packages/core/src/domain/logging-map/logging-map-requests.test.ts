// Pins for the logging-map request builders (AZR-19, U1a). Exact path,
// api-version and query for each - a builder that drifts sends a request ARM
// answers differently, and nothing else would notice.

import { describe, expect, it } from "vitest";

import {
  API_VERSIONS,
  assignmentsAtScopeRequest,
  definitionRequest,
  descendantsRequest,
  exemptionsRequest,
  listManagementGroupsRequest,
  listSubscriptionsRequest,
  managementGroupRequest,
  roleAssignmentsForPrincipalRequest,
  roleDefinitionRequest,
} from "./logging-map-requests";

const MG = "/providers/Microsoft.Management/managementGroups/corp";
const SUB = "/subscriptions/11111111-1111-1111-1111-111111111111";

describe("API_VERSIONS", () => {
  it("pins every version the plan names", () => {
    expect(API_VERSIONS).toEqual({
      managementGroups: "2023-04-01",
      policyAssignments: "2023-04-01",
      policyDefinitions: "2023-04-01",
      policySetDefinitions: "2023-04-01",
      policyExemptions: "2022-07-01-preview",
      subscriptions: "2022-12-01",
      roleAssignments: "2022-04-01",
      roleDefinitions: "2022-04-01",
    });
  });
});

describe("hierarchy requests", () => {
  it("descendants of the tenant root", () => {
    expect(descendantsRequest("tenant-guid")).toEqual({
      method: "GET",
      path: "/providers/Microsoft.Management/managementGroups/tenant-guid/descendants",
      apiVersion: "2023-04-01",
    });
  });

  it("descendants accepts a full id too", () => {
    expect(descendantsRequest(MG).path).toBe(`${MG}/descendants`);
  });

  it("a management group with and without $expand=path", () => {
    expect(managementGroupRequest("corp", true)).toEqual({
      method: "GET",
      path: MG,
      apiVersion: "2023-04-01",
      query: { $expand: "path" },
    });
    expect(managementGroupRequest(MG, false)).toEqual({ method: "GET", path: MG, apiVersion: "2023-04-01" });
  });

  it("the two permission-filtered lists", () => {
    expect(listManagementGroupsRequest()).toEqual({
      method: "GET",
      path: "/providers/Microsoft.Management/managementGroups",
      apiVersion: "2023-04-01",
    });
    expect(listSubscriptionsRequest()).toEqual({
      method: "GET",
      path: "/subscriptions",
      apiVersion: "2022-12-01",
    });
  });
});

describe("policy requests", () => {
  it("assignments carry atScope() at any scope", () => {
    expect(assignmentsAtScopeRequest(SUB)).toEqual({
      method: "GET",
      path: `${SUB}/providers/Microsoft.Authorization/policyAssignments`,
      apiVersion: "2023-04-01",
      query: { $filter: "atScope()" },
    });
    expect(assignmentsAtScopeRequest(`${MG}/`).path).toBe(
      `${MG}/providers/Microsoft.Authorization/policyAssignments`,
    );
  });

  it("exemptions: atScope() at a management group, NO filter at a subscription", () => {
    expect(exemptionsRequest(MG)).toEqual({
      method: "GET",
      path: `${MG}/providers/Microsoft.Authorization/policyExemptions`,
      apiVersion: "2022-07-01-preview",
      query: { $filter: "atScope()" },
    });
    const sub = exemptionsRequest(SUB);
    expect(sub).toEqual({
      method: "GET",
      path: `${SUB}/providers/Microsoft.Authorization/policyExemptions`,
      apiVersion: "2022-07-01-preview",
    });
    expect("query" in sub).toBe(false);
  });

  it("exemptions recognise a lower-cased management group id", () => {
    expect(exemptionsRequest(MG.toLowerCase()).query).toEqual({ $filter: "atScope()" });
  });

  it("definitions: path is the id, version follows the kind", () => {
    const def = "/providers/Microsoft.Authorization/policyDefinitions/abc";
    const set = "/providers/Microsoft.Authorization/policySetDefinitions/85175a36-2f12-419a-96b4-18d5b0096531";
    expect(definitionRequest(def)).toEqual({ method: "GET", path: def, apiVersion: "2023-04-01" });
    expect(definitionRequest(set)).toEqual({ method: "GET", path: set, apiVersion: "2023-04-01" });
  });
});

describe("role requests", () => {
  it("role assignments for a principal carry assignedTo('<pid>')", () => {
    expect(roleAssignmentsForPrincipalRequest(MG, "pid-1")).toEqual({
      method: "GET",
      path: `${MG}/providers/Microsoft.Authorization/roleAssignments`,
      apiVersion: "2022-04-01",
      query: { $filter: "assignedTo('pid-1')" },
    });
  });

  it("a quote in the principal id is doubled, not passed through", () => {
    expect(roleAssignmentsForPrincipalRequest(SUB, "a'b").query).toEqual({ $filter: "assignedTo('a''b')" });
  });

  it("role definition by id", () => {
    const id = `${SUB}/providers/Microsoft.Authorization/roleDefinitions/749f88d5-cbae-40b8-bcfc-e573ddc772fa`;
    expect(roleDefinitionRequest(id)).toEqual({ method: "GET", path: id, apiVersion: "2022-04-01" });
  });
});
