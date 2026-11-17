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
 * The resource group Azure keeps each region's default Network Watcher in.
 * Restated from domain/labs/lab-flowlogs rather than imported, so the role
 * plan does not depend on the labs domain; pinned equal in role-plan.test.ts.
 */
export const NETWORK_WATCHER_RESOURCE_GROUP = "NetworkWatcherRG";

/**
 * One RBAC role the setup path requires: the built-in role, the scope level it
 * is assigned at, and a one-line justification.
 */
export interface RoleRequirement {
  /** The Azure built-in role name to assign. */
  role: string;
  /** The scope level the role is assigned at. */
  scopeLevel: RoleScopeLevel;
  /**
   * For a `resourceGroup` role on a NAMED group other than the configured one
   * (the regional Network Watcher's NetworkWatcherRG, AZR-81).
   */
  resourceGroup?: string;
  /**
   * `feature` when the path works without the role and only one capability
   * is lost; absent means core.
   */
  necessity?: "feature";
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
 *   audit; foundation-phase.ts). Network Contributor on NetworkWatcherRG is a
 *   feature row for the flow logs (AZR-81); the Event Grid registration is an
 *   admin step ({@link adminStepsForSetupPath}), not a subscription role.
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
          "Deploy the lab workspace, DCRs, and tables into the pre-created lab resource group. The grant reaches nothing outside it; the two lab steps that do - flow logs on the regional Network Watcher, and the Event Grid provider registration - are asked for separately.",
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
      // AZR-81: Azure keeps one Network Watcher per region per subscription,
      // normally NetworkWatcherRG/NetworkWatcher_<region>, created with the
      // first virtual network - so the lab cannot make its own beside it, and
      // its flow logs are written there.
      {
        role: leastRoleFor("flowLog.write"),
        scopeLevel: "resourceGroup",
        resourceGroup: NETWORK_WATCHER_RESOURCE_GROUP,
        necessity: "feature",
        justification:
          "Read the region's Network Watcher and write the lab's flow logs on it. Azure keeps one watcher per region per subscription, normally in NetworkWatcherRG, so the lab cannot create its own in the lab resource group.",
        feature: "Lab vNet flow logs",
        withoutIt:
          "The flow-logs step fails with a message naming NetworkWatcherRG; the rest of the lab deploys.",
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

/**
 * A one-time step an administrator takes instead of granting a role: the
 * right it needs sits at a scope the path deliberately does not ask for.
 */
export interface AdminStep {
  /** What to do, in a ticket's words. */
  step: string;
  /** The az command that does it; `<subscriptionId>` is substituted. */
  command: string;
  /** The app capability that needs it. */
  feature: string;
  justification: string;
  withoutIt: string;
}

/**
 * The admin steps a setup path needs (AZR-81). The bring-your-own lab exists
 * so that nothing is granted at the subscription; registering the Event Grid
 * provider is a subscription action (Microsoft.EventGrid/register/action), so
 * it is asked for as a one-time step rather than a subscription role.
 */
export function adminStepsForSetupPath(path: AzureSetupPath): AdminStep[] {
  if (path !== "lab-byo-rg") {
    return [];
  }
  return [
    {
      step: "Register the Microsoft.EventGrid resource provider on the subscription (once; skip if already registered).",
      command: "az provider register --namespace Microsoft.EventGrid --subscription <subscriptionId>",
      feature: "Lab Event Grid blob notifications",
      justification:
        "Registration is per subscription (Microsoft.EventGrid/register/action), which a resource-group grant cannot do. A custom role holding only that action at the subscription also works.",
      withoutIt:
        "On an unregistered subscription the Event Grid step fails; the rest of the lab deploys.",
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
    scopeFor(req.scopeLevel, sub, req.resourceGroup ?? rg)
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
 *
 * `onlyRoles`, when given, keeps only the plan roles it names.
 */
export function renderRoleAssignmentCli(
  path: AzureSetupPath,
  params: RoleAssignmentCliParams,
  onlyRoles?: readonly string[],
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
  // `onlyRoles` narrows the script to the roles the operator asked for (the
  // RBAC half of the connectivity request), so a Partially Connected script
  // never assigns a role nobody ticked. Omitted, the whole plan is emitted.
  const commands = rolePlanForSetupPath(path)
    .filter((req) => req.assignViaPortal !== true)
    .filter((req) => onlyRoles === undefined || onlyRoles.includes(req.role))
    .map((req) => commandFor(req, client, sub, rg));
  if (commands.length === 0) {
    commands.push("# No roles are requested, so there is nothing to assign.");
  }

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
  const adminLines = adminStepsForSetupPath(path).flatMap((step) => [
    ...wrapComment("Admin step: " + step.step),
    step.command.replace("<subscriptionId>", sub),
  ]);
  return [...header, ...commands, ...portalComments(path), ...adminLines].join("\n");
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
