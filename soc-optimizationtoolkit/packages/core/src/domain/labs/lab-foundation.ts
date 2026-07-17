/**
 * Lab foundation request builders - roadmap Phase 5 (LAB-02: resource group
 * with TTL tags + the TTL self-destruct Logic App).
 *
 * Ported from the legacy UnifiedLab Phase1-Foundation scripts:
 * - Deploy-ResourceGroup.ps1: the resource-group tags (Environment/ManagedBy/
 *   CreatedDate) and the TTL tag set (TTL_Enabled, TTL_ExpirationTime,
 *   TTL_WarningTime, TTL_UserEmail, TTL_Hours), with tag names VERBATIM -
 *   the Logic App reads TTL_Enabled and TTL_ExpirationTime by exactly these
 *   names.
 * - Deploy-TTL.ps1: the Logic App workflow definition VERBATIM (hourly
 *   recurrence; managed-identity HTTP GET of its own resource group; TTL tag
 *   parse; expiration comparison against utcNow(); managed-identity HTTP
 *   DELETE of the resource group) and the Contributor grant to the Logic
 *   App's identity.
 *
 * Recorded deviations from the legacy scripts:
 * - Timestamps are UTC. The legacy wrote LOCAL time with a literal "Z"
 *   suffix, so a lab in any west-of-UTC timezone lived HOURS LONGER than its
 *   TTL (the workflow compares the tag against utcNow()). Here expiration
 *   math runs on an injected UTC instant ({@link labFoundationTags} takes
 *   nowIso - core never reads a clock) and is formatted as real UTC.
 * - The Logic App deploys as a DIRECT ARM PUT of Microsoft.Logic/workflows
 *   (the walking-skeleton redesign convention: no template-deployment
 *   indirection). The resulting resource is identical.
 * - ManagedBy/CreatedBy tags carry this app's name instead of
 *   "UnifiedAzureLab"/"UnifiedLab Deployment" (informational only; nothing
 *   reads them programmatically).
 *
 * In-app policy (feature-catalog "Lab environments", resolved 2026-07-01):
 * TTL is MANDATORY for every app-provisioned lab - there is deliberately no
 * way to build these tags without an expiration.
 *
 * Pure: no IO, no fetch, no React, no clock reads (timestamps are injected).
 */

import type { AzureManagementRequest } from "../../ports/azure-management";

/** ARM api-version for resource-group GET/PUT/PATCH (matches the workflow's URIs). */
export const LAB_RESOURCE_GROUPS_API_VERSION = "2021-04-01";

/** ARM api-version for Microsoft.Logic/workflows (legacy template, verbatim). */
export const LAB_LOGIC_APP_API_VERSION = "2019-05-01";

/** ARM api-version for Microsoft.Authorization/roleAssignments PUT. */
export const LAB_ROLE_ASSIGNMENTS_API_VERSION = "2022-04-01";

/**
 * Built-in "Contributor" role definition GUID - the role the legacy script
 * granted the Logic App's managed identity so it can delete its own resource
 * group. Fixed Azure identifier; do not change.
 */
export const CONTRIBUTOR_ROLE_DEFINITION_ID =
  "b24988ac-9c94-4bd6-b8f0-b3a2255c8d84";

/** TTL settings for one lab (legacy timeToLive block; enabled is implicit). */
export interface LabTtlSettings {
  /** Lab lifetime in hours (legacy default 72). */
  hours: number;
  /** Warning lead time before deletion, in hours (legacy default 24). */
  warningHours: number;
  /** Warning recipient recorded on the TTL_UserEmail tag. */
  userEmail: string;
}

/** Format an instant as the legacy tag timestamp shape, in real UTC. */
function formatLabTimestamp(instant: Date): string {
  return `${instant.toISOString().slice(0, 19)}Z`;
}

/** The computed TTL instants (also surfaced to the UI as the expiry preview). */
export interface LabTtlInstants {
  expirationTime: string;
  warningTime: string;
}

/**
 * Compute the TTL expiration and warning instants from an injected UTC "now"
 * (ISO 8601). Pure - the shell mints nowIso.
 */
export function labTtlInstants(ttl: LabTtlSettings, nowIso: string): LabTtlInstants {
  const now = new Date(nowIso);
  const expiration = new Date(now.getTime() + ttl.hours * 3600_000);
  const warning = new Date(expiration.getTime() - ttl.warningHours * 3600_000);
  return {
    expirationTime: formatLabTimestamp(expiration),
    warningTime: formatLabTimestamp(warning),
  };
}

/**
 * The lab resource group's tag set (legacy Deploy-ResourceGroup.ps1 tags,
 * names verbatim). TTL tags are ALWAYS present - the in-app TTL mandate.
 */
export function labFoundationTags(
  ttl: LabTtlSettings,
  nowIso: string,
): Record<string, string> {
  const instants = labTtlInstants(ttl, nowIso);
  return {
    Environment: "Lab",
    ManagedBy: "SOC-OptimizationToolkit",
    CreatedDate: formatLabTimestamp(new Date(nowIso)),
    TTL_Enabled: "true",
    TTL_ExpirationTime: instants.expirationTime,
    TTL_WarningTime: instants.warningTime,
    TTL_UserEmail: ttl.userEmail,
    TTL_Hours: String(ttl.hours),
  };
}

/** GET one resource group (existence check + current tags). */
export function buildResourceGroupGetRequest(
  subscriptionId: string,
  resourceGroup: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`,
    apiVersion: LAB_RESOURCE_GROUPS_API_VERSION,
  };
}

/** PUT (create or update) one resource group with the given tags. */
export function buildResourceGroupPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  location: string,
  tags: Record<string, string>,
): AzureManagementRequest {
  return {
    method: "PUT",
    path: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`,
    apiVersion: LAB_RESOURCE_GROUPS_API_VERSION,
    body: { location, tags },
  };
}

/**
 * PATCH one resource group's tags. ARM replaces the whole tag set with the
 * body's `tags`, so callers MERGE existing tags with the TTL tags first
 * (the legacy existing-RG path did the same via Set-AzResourceGroup).
 */
export function buildResourceGroupPatchTagsRequest(
  subscriptionId: string,
  resourceGroup: string,
  tags: Record<string, string>,
): AzureManagementRequest {
  return {
    method: "PATCH",
    path: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`,
    apiVersion: LAB_RESOURCE_GROUPS_API_VERSION,
    body: { tags },
  };
}

/** The TTL cleanup Logic App's name (legacy, verbatim). */
export function ttlLogicAppName(baseObjectName: string): string {
  return `la-ttl-cleanup-${baseObjectName}`;
}

/**
 * The TTL watchdog workflow definition (legacy Deploy-TTL.ps1, verbatim
 * structure): every hour, GET the resource group via managed identity, parse
 * the TTL tags, and DELETE the whole resource group once TTL_Enabled is
 * "true" and TTL_ExpirationTime is in the past.
 */
export function buildTtlWorkflowDefinition(
  subscriptionId: string,
  resourceGroup: string,
): Record<string, unknown> {
  const rgUri =
    `https://management.azure.com/subscriptions/${subscriptionId}` +
    `/resourceGroups/${resourceGroup}?api-version=${LAB_RESOURCE_GROUPS_API_VERSION}`;
  return {
    $schema:
      "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
    contentVersion: "1.0.0.0",
    parameters: {},
    triggers: {
      Recurrence: {
        type: "Recurrence",
        recurrence: { frequency: "Hour", interval: 1 },
      },
    },
    actions: {
      Get_Resource_Group: {
        type: "Http",
        runAfter: {},
        inputs: {
          method: "GET",
          uri: rgUri,
          authentication: { type: "ManagedServiceIdentity" },
        },
      },
      Parse_Resource_Group: {
        type: "ParseJson",
        runAfter: { Get_Resource_Group: ["Succeeded"] },
        inputs: {
          content: "@body('Get_Resource_Group')",
          schema: {
            type: "object",
            properties: {
              tags: {
                type: "object",
                properties: {
                  TTL_Enabled: { type: "string" },
                  TTL_ExpirationTime: { type: "string" },
                },
              },
            },
          },
        },
      },
      Check_TTL_Enabled: {
        type: "If",
        runAfter: { Parse_Resource_Group: ["Succeeded"] },
        expression: {
          and: [
            {
              equals: [
                "@body('Parse_Resource_Group')?['tags']?['TTL_Enabled']",
                "true",
              ],
            },
          ],
        },
        actions: {
          Check_Expiration: {
            type: "If",
            runAfter: {},
            expression: {
              and: [
                {
                  less: [
                    "@body('Parse_Resource_Group')?['tags']?['TTL_ExpirationTime']",
                    "@utcNow()",
                  ],
                },
              ],
            },
            actions: {
              Delete_Resource_Group: {
                type: "Http",
                runAfter: {},
                inputs: {
                  method: "DELETE",
                  uri: rgUri,
                  authentication: { type: "ManagedServiceIdentity" },
                },
              },
            },
            else: { actions: {} },
          },
        },
        else: { actions: {} },
      },
    },
    outputs: {},
  };
}

/** GET the TTL Logic App (existence check + identity principal id). */
export function buildTtlLogicAppGetRequest(
  subscriptionId: string,
  resourceGroup: string,
  baseObjectName: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path:
      `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
      `/providers/Microsoft.Logic/workflows/${ttlLogicAppName(baseObjectName)}`,
    apiVersion: LAB_LOGIC_APP_API_VERSION,
  };
}

/**
 * PUT the TTL Logic App as a direct ARM resource write (redesign - the
 * legacy wrapped the identical resource in a template deployment): consumption
 * workflow, system-assigned identity, enabled, hourly TTL watchdog definition.
 */
export function buildTtlLogicAppPutRequest(
  subscriptionId: string,
  resourceGroup: string,
  location: string,
  baseObjectName: string,
): AzureManagementRequest {
  return {
    method: "PUT",
    path:
      `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
      `/providers/Microsoft.Logic/workflows/${ttlLogicAppName(baseObjectName)}`,
    apiVersion: LAB_LOGIC_APP_API_VERSION,
    body: {
      location,
      identity: { type: "SystemAssigned" },
      properties: {
        state: "Enabled",
        definition: buildTtlWorkflowDefinition(subscriptionId, resourceGroup),
      },
      tags: {
        Purpose: "TTL Cleanup",
        TargetResourceGroup: resourceGroup,
        CreatedBy: "SOC-OptimizationToolkit",
      },
    },
  };
}

/** Inputs for {@link buildRgContributorRoleAssignmentRequest}. */
export interface RgRoleAssignmentInput {
  subscriptionId: string;
  resourceGroup: string;
  /** The assignment name (a GUID), SHELL-minted and passed in. */
  assignmentName: string;
  /** The Logic App managed identity's principal (object) id. */
  principalId: string;
}

/**
 * PUT the Contributor role assignment for the Logic App's managed identity at
 * resource-group scope (legacy New-AzRoleAssignment, as ARM REST). Same body
 * conventions as the assign-dcr-role usecase: principalType ServicePrincipal
 * (a managed identity IS a service principal) suppresses the Graph-replication
 * pre-flight on the service side.
 */
export function buildRgContributorRoleAssignmentRequest(
  input: RgRoleAssignmentInput,
): AzureManagementRequest {
  const scope = `/subscriptions/${input.subscriptionId}/resourceGroups/${input.resourceGroup}`;
  return {
    method: "PUT",
    path: `${scope}/providers/Microsoft.Authorization/roleAssignments/${input.assignmentName}`,
    apiVersion: LAB_ROLE_ASSIGNMENTS_API_VERSION,
    body: {
      properties: {
        roleDefinitionId:
          `/subscriptions/${input.subscriptionId}/providers/Microsoft.Authorization` +
          `/roleDefinitions/${CONTRIBUTOR_ROLE_DEFINITION_ID}`,
        principalId: input.principalId,
        principalType: "ServicePrincipal",
      },
    },
  };
}
