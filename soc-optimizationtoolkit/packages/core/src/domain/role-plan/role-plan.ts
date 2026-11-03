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
 * COMPATIBILITY CONTRACT: {@link renderRoleAssignmentCli} keeps the setup
 * wizard's legacy `buildAzScript` command lines and placeholders
 * (`<clientId>`, `<subscriptionId>`, and the path-dependent `<workspaceRg>` /
 * `<labRg>`). The lab paths' portal comment is built from the plan row
 * (AZR-61), so it is pinned by the role and condition it must carry.
 *
 * ROLE NAMES COME FROM THE LEAST-PRIVILEGE REGISTRY (AZR-61, ADR 0009) wherever
 * a role is the least role of the operation it is asked for. The one deliberate
 * exception is the lab paths' Contributor: an UMBRELLA grant chosen because a
 * lab touches some sixty operations across a dozen providers, and asking for
 * each one's least role would hand an approver a list nobody grants. It is
 * named here once, as a choice, not as anyone's least role.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto. Output is
 * deterministic.
 */

import type { AzureSetupPath } from "../azure-config";
import { leastRoleFor } from "../least-privilege";

/**
 * The lab paths' umbrella role (see the module header for why it is not read
 * from the registry).
 */
const LAB_UMBRELLA_ROLE = "Contributor";

/**
 * The condition on every lab-path RBAC Administrator grant: the TTL identity
 * gets Contributor, and Cribl's identity gets Monitoring Metrics Publisher on
 * each DCR the lab deploys.
 */
export const LAB_RBAC_CONDITION =
  "Constrain roles and principal types: only Contributor and Monitoring Metrics Publisher, only to service principals.";

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
   * The app capability that needs this role - the "which" a reviewer reads
   * before the "why". Lives here rather than in the ticket generator so the
   * CLI, the role ticket, and the app-registration ticket all name the same
   * capability for the same role.
   */
  feature: string;
  /**
   * What still works if this role is NOT granted. An approver who cannot grant
   * everything needs to know the cost of each refusal, and stating it is also
   * the honest form of the request - see docs/inventory-standard.md for the
   * same principle applied to listings.
   */
  withoutIt: string;
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
 * - `lab-byo-rg` - Contributor on the pre-created lab resource group, plus RBAC
 *   Administrator on that group with the same condition, because the lab
 *   assigns its TTL identity Contributor in both resource-group modes (AZR-61
 *   audit; foundation-phase.ts).
 */
export function rolePlanForSetupPath(path: AzureSetupPath): RoleRequirement[] {
  if (path === "lab-new-rg") {
    return [
      {
        role: LAB_UMBRELLA_ROLE,
        scopeLevel: "subscription",
        justification:
          "Create the lab resource group and deploy the workspace, DCRs, and tables inside it (resource group creation is a subscription-level action, so no workspace-scoped roles are needed on this path).",
        feature: "Deploy the lab environment",
        withoutIt:
          "Nothing on this path runs - the lab cannot create its resource group, so there is nowhere to deploy.",
      },
      {
        role: leastRoleFor("lab.roleAssignment.write"),
        scopeLevel: "subscription",
        justification:
          "Assign the lab TTL self-destruct identity its delete role at deploy time.",
        condition: LAB_RBAC_CONDITION,
        assignViaPortal: true,
        feature: "Lab TTL self-destruct",
        withoutIt:
          "The lab deploys but never auto-deletes, so it lingers as orphaned cost until someone removes it by hand.",
      },
    ];
  }
  if (path === "lab-byo-rg") {
    return [
      {
        role: LAB_UMBRELLA_ROLE,
        scopeLevel: "resourceGroup",
        justification:
          "Deploy the lab workspace, DCRs, and tables into the pre-created lab resource group. The grant reaches nothing outside it: the Event Grid provider registration (subscription) and the regional Network Watcher (NetworkWatcherRG) need rights there, or an admin who registers the provider and creates the watcher first.",
        feature: "Deploy the lab environment",
        withoutIt:
          "Nothing on this path runs - there is no other scope the lab is allowed to deploy into.",
      },
      {
        role: leastRoleFor("lab.roleAssignment.write"),
        scopeLevel: "resourceGroup",
        justification:
          "Assign the lab TTL self-destruct identity its delete role on the lab resource group at deploy time.",
        condition: LAB_RBAC_CONDITION,
        assignViaPortal: true,
        feature: "Lab TTL self-destruct",
        withoutIt:
          "The deploy stops at the TTL step: a lab with no working self-destruct is never left running.",
      },
    ];
  }
  // "existing"
  return [
    {
      role: leastRoleFor("subscriptions.list"),
      scopeLevel: "subscription",
      justification:
        "Discover subscriptions, resource groups, workspaces, and existing DCRs before deploying.",
      feature: "Discovery and gap analysis",
      withoutIt:
        "The app cannot find your workspace or read the DCRs already deployed, so every screen that starts from your environment is empty and gap analysis has nothing to compare against.",
    },
    {
      role: leastRoleFor("dcr.write"),
      scopeLevel: "resourceGroup",
      justification:
        "Create and update Data Collection Rules in the workspace resource group.",
      feature: "Deploy Data Collection Rules",
      withoutIt:
        "The app can still generate the DCR ARM template for someone else to deploy, but cannot deploy it itself - no data path is created.",
    },
    {
      role: leastRoleFor("table.write"),
      scopeLevel: "resourceGroup",
      justification:
        "Create custom Log Analytics tables and configure the workspace for ingestion.",
      feature: "Create custom tables",
      withoutIt:
        "Onboarding a source to a table that does not exist yet fails; existing native tables can still be targeted.",
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
 * headers are the legacy `buildAzScript` ones; each portal requirement's
 * comment block is built from its plan row.
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
  const header =
    path === "lab-new-rg"
      ? [
          "# Lab creates its own resource group and workspace: subscription Contributor",
          "# covers RG creation plus all workspace/DCR operations inside the lab, so no",
          "# workspace-scoped roles are needed on this path.",
        ]
      : [
          "# Pre-created lab resource group: least privilege for labs; the lab deploys",
          "# its workspace and resources into this RG. A few lab steps reach outside it",
          "# (Event Grid provider registration, the regional Network Watcher).",
        ];
  return [...header, ...commands, ...portalComments(path)].join("\n");
}

/**
 * The comment block for each portal-assigned requirement of a path, built
 * from the plan row itself - its role (the registry's least role) and its
 * condition - so the script can never ask for a different grant than the plan
 * (AZR-61 review: this block once restated both by hand, and it is the only
 * place the script names the grant).
 */
function portalComments(path: AzureSetupPath): string[] {
  const where = path === "lab-byo-rg" ? " on this resource group" : "";
  return rolePlanForSetupPath(path)
    .filter((req) => req.assignViaPortal === true)
    .flatMap((req) =>
      wrapComment(
        `Assign ${req.role}${where} via the Azure portal so you can add the condition` +
          (req.condition === undefined ? "." : ` "${req.condition}"`) +
          ` (${req.justification.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())}).`,
      ),
    );
}

/** Word-wrap text into `# ` comment lines no wider than 80 columns. */
function wrapComment(text: string): string[] {
  const lines: string[] = [];
  let line = "#";
  for (const word of text.split(" ")) {
    if (line !== "#" && line.length + 1 + word.length > 80) {
      lines.push(line);
      line = "#";
    }
    line += " " + word;
  }
  lines.push(line);
  return lines;
}
