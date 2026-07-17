/**
 * Lab permission preflight - roadmap Phase 5 (the LAB-14 permission-check
 * half, redesigned): verify the app registration can actually perform the
 * control-plane writes the SELECTED profile needs BEFORE anything deploys,
 * using the same effective-action evaluation as the setup wizard's preflight
 * (domain/azure-permissions) - never role names.
 *
 * The one check effective actions alone cannot settle is the TTL grant:
 * Microsoft.Authorization/roleAssignments/write is typically held through a
 * CONSTRAINED RBAC Administrator assignment carrying an ABAC condition
 * ("Constrain roles and principal types" - the feature-catalog permission
 * design). The permissions API reports the action as granted, but the
 * condition still rejects the PUT at runtime when its allowed-role list does
 * not include Contributor - exactly the AuthorizationFailed("ABAC condition
 * that is not fulfilled") a live lab run hits. {@link
 * analyzeRoleAssignmentGrant} therefore reads the CONDITION strings off the
 * raw permissions response and reports whether any granting element is
 * unconditional or whether a condition textually allows the Contributor role
 * GUID - a stated BEST-EFFORT signal (conditions are free-form expressions),
 * strong enough to warn before a deploy fails halfway.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { AzureManagementRequest } from "../../ports/azure-management";
import {
  actionMatchesGlob,
  type PermissionsResponse,
  type RequiredAction,
} from "../azure-permissions";
import { CONTRIBUTOR_ROLE_DEFINITION_ID } from "./lab-foundation";
import type { LabComponentFlags } from "./lab-profiles";
import { isLabPhaseRequired } from "./lab-profiles";

/** The RBAC permissions API version (same pin as permission-preflight). */
export const LAB_PERMISSIONS_API_VERSION = "2022-04-01";

/** The action the TTL grant needs (checked separately for ABAC conditions). */
export const ROLE_ASSIGNMENTS_WRITE_ACTION =
  "Microsoft.Authorization/roleAssignments/write";

/** GET the caller's effective permissions at an ARM scope. */
export function buildLabPermissionsGetRequest(
  scopePath: string,
): AzureManagementRequest {
  return {
    method: "GET",
    path: `${scopePath}/providers/Microsoft.Authorization/permissions`,
    apiVersion: LAB_PERMISSIONS_API_VERSION,
  };
}

/**
 * The control-plane actions the SELECTED profile exercises, derived from the
 * same component flags and phase gating the deploy uses (so the preflight
 * cannot drift from the deployment). Foundation actions are always present;
 * resource-group creation only in create-new mode.
 */
export function labRequiredActions(
  flags: LabComponentFlags,
  rgMode: "create-new" | "bring-your-own",
): RequiredAction[] {
  const actions: RequiredAction[] = [];
  if (rgMode === "create-new") {
    actions.push({
      action: "Microsoft.Resources/subscriptions/resourceGroups/write",
      label: "Create the lab resource group",
    });
  }
  actions.push(
    {
      action: "Microsoft.Logic/workflows/write",
      label: "Deploy the TTL self-destruct watchdog",
    },
    {
      action: ROLE_ASSIGNMENTS_WRITE_ACTION,
      label: "Grant the TTL identity its delete role",
    },
  );
  if (isLabPhaseRequired(2, flags)) {
    actions.push({
      action: "Microsoft.Storage/storageAccounts/write",
      label: "Create the storage account",
    });
    if (flags.storage.deployEventGrid) {
      actions.push({
        action: "Microsoft.EventGrid/systemTopics/write",
        label: "Wire Event Grid blob notifications",
      });
    }
  }
  if (isLabPhaseRequired(3, flags)) {
    actions.push(
      {
        action: "Microsoft.Network/virtualNetworks/write",
        label: "Create the virtual network",
      },
      {
        action: "Microsoft.Network/networkSecurityGroups/write",
        label: "Create network security groups",
      },
    );
  }
  if (flags.monitoring.deployLogAnalytics || flags.monitoring.deploySentinel) {
    actions.push({
      action: "Microsoft.OperationalInsights/workspaces/write",
      label: "Create the Log Analytics workspace",
    });
  }
  if (flags.monitoring.deploySentinel) {
    actions.push({
      action: "Microsoft.OperationsManagement/solutions/write",
      label: "Enable Microsoft Sentinel",
    });
  }
  if (flags.monitoring.deployPrivateLink) {
    actions.push(
      {
        action: "Microsoft.Insights/privateLinkScopes/write",
        label: "Create the Azure Monitor Private Link Scope",
      },
      {
        action: "Microsoft.Network/privateEndpoints/write",
        label: "Create the private endpoint",
      },
      {
        action: "Microsoft.Network/privateDnsZones/write",
        label: "Create the private DNS zone",
      },
    );
  }
  if (flags.analytics.deployEventHub) {
    actions.push({
      action: "Microsoft.EventHub/namespaces/write",
      label: "Create the Event Hub namespace",
    });
  }
  if (flags.analytics.deployADX) {
    actions.push({
      action: "Microsoft.Kusto/clusters/write",
      label: "Create the ADX cluster",
    });
  }
  if (flags.monitoring.deployFlowLogs) {
    actions.push({
      action: "Microsoft.Network/networkWatchers/write",
      label: "Configure vNet flow logs",
    });
  }
  if (flags.virtualMachines.deployVMs) {
    actions.push(
      {
        action: "Microsoft.Compute/virtualMachines/write",
        label: "Create the test VMs",
      },
      {
        action: "microsoft.devtestlab/schedules/write",
        label: "Configure VM auto-shutdown",
      },
    );
  }
  if (flags.monitoring.deployDCRs) {
    actions.push({
      action: "Microsoft.Insights/dataCollectionRules/write",
      label: "Deploy the Sentinel-table DCRs",
    });
  }
  if (flags.infrastructure.deployVPN) {
    actions.push(
      {
        action: "Microsoft.Network/publicIPAddresses/write",
        label: "Create the gateway public IP",
      },
      {
        action: "Microsoft.Network/virtualNetworkGateways/write",
        label: "Create the VPN gateway",
      },
    );
  }
  return actions;
}

/** How the caller holds roleAssignments/write, condition included. */
export type RoleAssignmentGrantKind =
  | "unconditional"
  | "conditional-allows-contributor"
  | "conditional-blocks-contributor"
  | "not-granted";

/** The TTL-grant analysis result. */
export interface RoleAssignmentGrantAnalysis {
  kind: RoleAssignmentGrantKind;
  /** The condition expressions on granting elements (empty when none). */
  conditions: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Parse the raw permissions body into the typed shape the effective-action
 * evaluator consumes. Tolerant: junk elements contribute empty sets.
 */
export function parseLabPermissionsResponse(body: unknown): PermissionsResponse {
  const value = isRecord(body) && Array.isArray(body["value"]) ? body["value"] : [];
  return {
    value: value.map((element) => ({
      actions: strings(isRecord(element) ? element["actions"] : []),
      notActions: strings(isRecord(element) ? element["notActions"] : []),
      dataActions: strings(isRecord(element) ? element["dataActions"] : []),
      notDataActions: strings(isRecord(element) ? element["notDataActions"] : []),
    })),
  };
}

/**
 * Analyze HOW roleAssignments/write is held, reading the ABAC `condition`
 * strings the permissions API carries per element:
 *
 * - "unconditional": some granting element has no condition - the TTL grant
 *   will not be condition-blocked.
 * - "conditional-allows-contributor": every granting element is conditional,
 *   and at least one condition CONTAINS the Contributor role GUID - a
 *   best-effort textual signal that the constrained grant permits the TTL
 *   assignment.
 * - "conditional-blocks-contributor": every granting element is conditional
 *   and NONE mentions the Contributor GUID - the live PUT will fail with
 *   AuthorizationFailed("ABAC condition that is not fulfilled"); the
 *   condition's allowed-role list must gain Contributor
 *   ({@link CONTRIBUTOR_ROLE_DEFINITION_ID}) for service principals.
 * - "not-granted": no element grants the action at all.
 */
export function analyzeRoleAssignmentGrant(
  body: unknown,
): RoleAssignmentGrantAnalysis {
  const value = isRecord(body) && Array.isArray(body["value"]) ? body["value"] : [];
  const conditions: string[] = [];
  let unconditional = false;
  for (const element of value) {
    if (!isRecord(element)) {
      continue;
    }
    const actions = strings(element["actions"]);
    const notActions = strings(element["notActions"]);
    const grants =
      actions.some((glob) => actionMatchesGlob(glob, ROLE_ASSIGNMENTS_WRITE_ACTION)) &&
      !notActions.some((glob) =>
        actionMatchesGlob(glob, ROLE_ASSIGNMENTS_WRITE_ACTION),
      );
    if (!grants) {
      continue;
    }
    const condition = element["condition"];
    if (typeof condition === "string" && condition.trim() !== "") {
      conditions.push(condition);
    } else {
      unconditional = true;
    }
  }
  if (unconditional) {
    return { kind: "unconditional", conditions };
  }
  if (conditions.length === 0) {
    return { kind: "not-granted", conditions };
  }
  const allows = conditions.some((condition) =>
    condition.toLowerCase().includes(CONTRIBUTOR_ROLE_DEFINITION_ID.toLowerCase()),
  );
  return {
    kind: allows ? "conditional-allows-contributor" : "conditional-blocks-contributor",
    conditions,
  };
}

/**
 * The remediation text for a condition-blocked TTL grant - the exact fix for
 * the live AuthorizationFailed("ABAC condition") failure: extend the RBAC
 * Administrator assignment's condition so its allowed-role list includes
 * Contributor for service principals (the feature-catalog constrained-grant
 * design names exactly Contributor + Monitoring Metrics Publisher).
 */
export const ROLE_CONDITION_REMEDIATION =
  "The app's RBAC Administrator grant carries a role-assignment condition (ABAC) " +
  "whose allowed-role list does not appear to include Contributor, so the TTL " +
  "self-destruct grant will fail at deploy time. Ask an admin to edit the " +
  "condition (Azure portal: the role assignment's 'Condition' tab) and add " +
  `Contributor (${CONTRIBUTOR_ROLE_DEFINITION_ID}) to the allowed roles for ` +
  "service principals - or grant the role manually after each deploy using the " +
  "az command the run prints.";
