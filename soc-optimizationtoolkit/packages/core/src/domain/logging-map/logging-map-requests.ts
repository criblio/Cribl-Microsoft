/**
 * The ARM requests the Azure Logging Map makes (AZR-19, phase 1). Every one is
 * a GET: the map is READ-ONLY.
 *
 * Phase 1 reads per scope through direct ARM rather than Resource Graph:
 * Resource Graph with a management-group body scope has never been used in
 * this codebase (eventhub-discovery uses subscriptions only), and that is a
 * separate follow-up card.
 *
 * Builders only - the usecase sends them through the AzureManagement port.
 * Pure: no IO, no Date, no randomness. Domain - imports no usecase.
 */

import type { AzureManagementRequest } from "../../ports/azure-management";
import { isManagementGroupId, lastSegment } from "./scope-tree";

/**
 * API versions, one per resource provider surface. Each is a platform claim
 * still to be confirmed live (AZR-19 live item 3a); if Azure rejects one,
 * correct it HERE and its pin in logging-map-requests.test.ts.
 */
export const API_VERSIONS = {
  managementGroups: "2023-04-01",
  policyAssignments: "2023-04-01",
  policyDefinitions: "2023-04-01",
  policySetDefinitions: "2023-04-01",
  policyExemptions: "2022-07-01-preview",
  subscriptions: "2022-12-01",
  roleAssignments: "2022-04-01",
  roleDefinitions: "2022-04-01",
} as const;

const MG_BASE = "/providers/Microsoft.Management/managementGroups";

function trimScope(scope: string): string {
  let s = scope.trim();
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s.startsWith("/") ? s : `/${s}`;
}

/** Accept a management group's name or its full id; return the name. */
function groupName(nameOrId: string): string {
  return nameOrId.includes("/") ? lastSegment(nameOrId) : nameOrId.trim();
}

/** OData string literal: single quotes doubled. */
function odataQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Every management group and subscription beneath a group (flat, each row
 * naming its parent). Called with the tenant id, it is the whole hierarchy
 * from the Tenant Root Group.
 */
export function descendantsRequest(groupNameOrId: string): AzureManagementRequest {
  return {
    method: "GET",
    path: `${MG_BASE}/${groupName(groupNameOrId)}/descendants`,
    apiVersion: API_VERSIONS.managementGroups,
  };
}

/**
 * One management group. With `expandPath`, ARM includes its ancestor path and
 * parent - the fallback uses this to place groups when descendants is refused.
 */
export function managementGroupRequest(groupNameOrId: string, expandPath: boolean): AzureManagementRequest {
  return {
    method: "GET",
    path: `${MG_BASE}/${groupName(groupNameOrId)}`,
    apiVersion: API_VERSIONS.managementGroups,
    ...(expandPath ? { query: { $expand: "path" } } : {}),
  };
}

/** The management groups the caller can see. PERMISSION-FILTERED. */
export function listManagementGroupsRequest(): AzureManagementRequest {
  return { method: "GET", path: MG_BASE, apiVersion: API_VERSIONS.managementGroups };
}

/** The subscriptions the caller can see. PERMISSION-FILTERED. */
export function listSubscriptionsRequest(): AzureManagementRequest {
  return { method: "GET", path: "/subscriptions", apiVersion: API_VERSIONS.subscriptions };
}

/**
 * Policy assignments that APPLY at a scope: set there, or inherited from
 * above (`atScope()`), each naming the scope it is set at.
 */
export function assignmentsAtScopeRequest(scopeId: string): AzureManagementRequest {
  return {
    method: "GET",
    path: `${trimScope(scopeId)}/providers/Microsoft.Authorization/policyAssignments`,
    apiVersion: API_VERSIONS.policyAssignments,
    query: { $filter: "atScope()" },
  };
}

/**
 * Policy exemptions at a scope.
 *
 * At a MANAGEMENT GROUP the list must carry `atScope()` (ARM requires a filter
 * there). At a SUBSCRIPTION it carries none, because the unfiltered list also
 * returns exemptions placed on resource groups and resources beneath it - the
 * map needs those to mark a subscription partially exempt (live item 3d).
 */
export function exemptionsRequest(scopeId: string): AzureManagementRequest {
  const base: AzureManagementRequest = {
    method: "GET",
    path: `${trimScope(scopeId)}/providers/Microsoft.Authorization/policyExemptions`,
    apiVersion: API_VERSIONS.policyExemptions,
  };
  return isManagementGroupId(scopeId) ? { ...base, query: { $filter: "atScope()" } } : base;
}

/**
 * GET a policy definition or set definition by its full id. The api-version
 * follows the kind the id names.
 */
export function definitionRequest(definitionId: string): AzureManagementRequest {
  const isSet = definitionId.toLowerCase().includes("/policysetdefinitions/");
  return {
    method: "GET",
    path: trimScope(definitionId),
    apiVersion: isSet ? API_VERSIONS.policySetDefinitions : API_VERSIONS.policyDefinitions,
  };
}

/**
 * Role assignments held by one principal, read at a scope. `assignedTo()`
 * returns the principal's grants at, above and (to be confirmed live, item 3g)
 * below the scope.
 */
export function roleAssignmentsForPrincipalRequest(scopeId: string, principalId: string): AzureManagementRequest {
  return {
    method: "GET",
    path: `${trimScope(scopeId)}/providers/Microsoft.Authorization/roleAssignments`,
    apiVersion: API_VERSIONS.roleAssignments,
    query: { $filter: `assignedTo(${odataQuote(principalId.trim())})` },
  };
}

/** GET a role definition by its full id (for its roleName). */
export function roleDefinitionRequest(roleDefinitionId: string): AzureManagementRequest {
  return {
    method: "GET",
    path: trimScope(roleDefinitionId),
    apiVersion: API_VERSIONS.roleDefinitions,
  };
}
