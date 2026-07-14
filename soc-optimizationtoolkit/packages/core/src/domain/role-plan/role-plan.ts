/**
 * RBAC role plan - SINGLE SOURCE OF TRUTH for the setup-path role model.
 *
 * The setup wizard needs the same RBAC role model in two places: the az-CLI
 * script builder (which self-assigns roles) and the change-request ticket
 * generator (which asks another team to assign them). This module is the ONE
 * canonical definition of that model, so the two consumers can no longer drift.
 *
 * {@link rolePlanForSetupPath} returns the roles, scope levels, justifications,
 * and the lab-new-rg "Constrain roles and principal types" condition for a given
 * {@link AzureSetupPath}. {@link renderRoleAssignmentCli} derives the az CLI
 * script from that plan: every non-portal requirement becomes a command line;
 * requirements marked {@link RoleRequirement.assignViaPortal} are NOT emitted as
 * commands (they carry a bespoke comment block instead, because a condition must
 * be added in the portal).
 *
 * COMPATIBILITY CONTRACT: {@link renderRoleAssignmentCli} reproduces the setup
 * wizard's legacy `buildAzScript` output BYTE-FOR-BYTE - the same placeholders
 * (`<clientId>`, `<subscriptionId>`, and the path-dependent `<workspaceRg>` /
 * `<labRg>`) and the same verbatim per-path comment blocks. Characterization
 * tests pin the full expected strings.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto. Output is
 * deterministic.
 */

import type { AzureSetupPath } from "../azure-config";

/**
 * The scope level a role is assigned at. Kept abstract (a LEVEL, not a fully
 * qualified scope string) so the concrete scope is built from the caller's
 * subscription and resource group at render time.
 *
 * - `subscription`  - assigned at `/subscriptions/{sub}`.
 * - `resourceGroup` - assigned at `/subscriptions/{sub}/resourceGroups/{rg}`.
 */
export type RoleScopeLevel = "subscription" | "resourceGroup";

/**
 * One RBAC role the setup path requires: the built-in role, the scope level it
 * is assigned at, and a one-line justification.
 */
export interface RoleRequirement {
  /** The Azure built-in role name to assign. */
  role: string;
  /** The scope level the role is assigned at. */
  scopeLevel: RoleScopeLevel;
  /** One-line justification for this specific role. */
  justification: string;
  /**
   * Optional assignment condition (the lab-new-rg RBAC Administrator constrains
   * which roles and principal types it may in turn assign).
   */
  condition?: string;
  /**
   * When true, this role must be assigned via the Azure portal (so a condition
   * can be attached) rather than the az CLI. Such requirements are NOT emitted
   * as az commands by {@link renderRoleAssignmentCli}.
   */
  assignViaPortal?: boolean;
}

/**
 * The canonical RBAC role model for a setup path. This is the single definition
 * both the az-CLI builder and the change-request ticket generator draw from.
 *
 * - `existing`   - Reader on the subscription, plus Monitoring Contributor and
 *   Log Analytics Contributor scoped to the workspace resource group.
 * - `lab-new-rg` - Contributor on the subscription (resource-group creation is a
 *   subscription-level action and covers all lab operations), plus RBAC
 *   Administrator on the subscription, assigned via the portal and CONSTRAINED
 *   to only Contributor and Monitoring Metrics Publisher, only to service
 *   principals.
 * - `lab-byo-rg` - Contributor on the pre-created lab resource group only.
 */
export function rolePlanForSetupPath(path: AzureSetupPath): RoleRequirement[] {
  if (path === "lab-new-rg") {
    return [
      {
        role: "Contributor",
        scopeLevel: "subscription",
        justification:
          "Create the lab resource group and deploy the workspace, DCRs, and tables inside it (resource group creation is a subscription-level action, so no workspace-scoped roles are needed on this path).",
      },
      {
        role: "RBAC Administrator",
        scopeLevel: "subscription",
        justification:
          "Assign the lab TTL self-destruct identity its delete role at deploy time.",
        condition:
          "Constrain roles and principal types: only Contributor and Monitoring Metrics Publisher, only to service principals.",
        assignViaPortal: true,
      },
    ];
  }
  if (path === "lab-byo-rg") {
    return [
      {
        role: "Contributor",
        scopeLevel: "resourceGroup",
        justification:
          "Deploy the lab workspace, DCRs, and tables into the pre-created lab resource group; no subscription-scope rights are needed.",
      },
    ];
  }
  // "existing"
  return [
    {
      role: "Reader",
      scopeLevel: "subscription",
      justification:
        "Discover subscriptions, resource groups, workspaces, and existing DCRs before deploying.",
    },
    {
      role: "Monitoring Contributor",
      scopeLevel: "resourceGroup",
      justification:
        "Create and update Data Collection Rules in the workspace resource group.",
    },
    {
      role: "Log Analytics Contributor",
      scopeLevel: "resourceGroup",
      justification:
        "Create custom Log Analytics tables and configure the workspace for ingestion.",
    },
  ];
}

/** Concrete inputs the CLI renderer substitutes into each az command. */
export interface RoleAssignmentCliParams {
  /** Azure AD application (client) ID; the az `--assignee`. */
  clientId: string;
  /** Target subscription ID. */
  subscriptionId: string;
  /** Target resource group name (workspace RG for `existing`, else lab RG). */
  resourceGroup: string;
}

/** Build the fully-qualified az `--scope` string for a scope level. */
function scopeFor(level: RoleScopeLevel, sub: string, rg: string): string {
  return level === "subscription"
    ? "/subscriptions/" + sub
    : "/subscriptions/" + sub + "/resourceGroups/" + rg;
}

/** The az CLI role-assignment command for one requirement. */
function commandFor(
  req: RoleRequirement,
  client: string,
  sub: string,
  rg: string,
): string {
  return (
    'az role assignment create --assignee ' +
    client +
    ' --role "' +
    req.role +
    '" --scope ' +
    scopeFor(req.scopeLevel, sub, rg)
  );
}

/**
 * Render the az CLI role-assignment script for a setup path, derived from
 * {@link rolePlanForSetupPath}. Each NON-portal requirement becomes one az
 * command line; {@link RoleRequirement.assignViaPortal} requirements are not
 * emitted as commands (their bespoke comment block explains the portal step).
 *
 * Blank params render as placeholders so a partial copy is visibly incomplete:
 * `<clientId>`, `<subscriptionId>`, and the path-dependent resource group
 * (`<workspaceRg>` for `existing`, otherwise `<labRg>`). The per-path comment
 * blocks are preserved verbatim from the legacy `buildAzScript`.
 */
export function renderRoleAssignmentCli(
  path: AzureSetupPath,
  params: RoleAssignmentCliParams,
): string {
  const client =
    params.clientId.trim() === "" ? "<clientId>" : params.clientId.trim();
  const sub =
    params.subscriptionId.trim() === ""
      ? "<subscriptionId>"
      : params.subscriptionId.trim();
  const rg =
    params.resourceGroup.trim() === ""
      ? path === "existing"
        ? "<workspaceRg>"
        : "<labRg>"
      : params.resourceGroup.trim();

  // Command lines come from the canonical plan: portal-assigned roles carry a
  // comment block instead of a command, so they are filtered out here.
  const commands = rolePlanForSetupPath(path)
    .filter((req) => req.assignViaPortal !== true)
    .map((req) => commandFor(req, client, sub, rg));

  if (path === "existing") {
    return [
      "# Existing workspace: least privilege, scoped to its resource group",
      ...commands,
    ].join("\n");
  }
  if (path === "lab-new-rg") {
    return [
      "# Lab creates its own resource group and workspace: subscription Contributor",
      "# covers RG creation plus all workspace/DCR operations inside the lab, so no",
      "# workspace-scoped roles are needed on this path.",
      ...commands,
      "# Assign RBAC Administrator via the Azure portal so you can add the condition",
      '# "Constrain roles and principal types": only Contributor and Monitoring',
      "# Metrics Publisher, only to service principals (the lab TTL self-destruct",
      "# assigns its delete role at deploy time).",
    ].join("\n");
  }
  return [
    "# Pre-created lab resource group: least privilege for labs; the lab deploys",
    "# its workspace and resources into this RG with no subscription-scope rights.",
    ...commands,
    "# An admin must pre-assign the TTL self-destruct identity its delete rights",
    "# on this resource group (the app cannot assign roles on this path).",
  ].join("\n");
}
