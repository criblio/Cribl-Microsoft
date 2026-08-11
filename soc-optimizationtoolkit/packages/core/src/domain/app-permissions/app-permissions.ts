/**
 * App-registration permission catalog - EVERYTHING the app registration needs
 * to be fully functional, in one place, each entry carrying which feature needs
 * it and what stops working without it.
 *
 * WHY THIS EXISTS. The permissions an operator must ask for were split across
 * three places that no single ticket ever gathered: the setup-path RBAC roles
 * (role-plan), the Microsoft Graph application permission the ingestion-identity
 * picker needs (documented only in a port comment and a 403 hint), and two
 * roles no setup path grants at all even though shipped features call the APIs
 * they cover. An operator who did exactly what the app-registration ticket asked
 * still could not install Sentinel content or grant Cribl access to a DCR, and
 * found that out one failed request at a time.
 *
 * TWO PERMISSION SYSTEMS, AND THEY ARE NOT INTERCHANGEABLE. Graph application
 * permissions are consented on the app registration itself, tenant-wide, by an
 * Entra administrator. Azure RBAC roles are assigned per scope by whoever owns
 * that subscription or resource group. They are often different teams, so the
 * ticket keeps them in separate sections rather than presenting one list an
 * approver would have to sort.
 *
 * ROLE-PLAN REMAINS THE SOURCE OF TRUTH for setup-path RBAC: those entries are
 * COMPOSED from {@link rolePlanForSetupPath}, never restated. What is added here
 * is only what no setup path covers - see {@link FEATURE_ROLES} and the
 * suppression rule in {@link appPermissionPlan}, which is what keeps this module
 * from becoming a second, drifting copy of the role model.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto. Output is
 * deterministic.
 */

import type { AzureSetupPath } from "../azure-config";
import { rolePlanForSetupPath } from "../role-plan";
import type { RoleScopeLevel } from "../role-plan";

/**
 * Where a permission applies.
 *
 * `tenant` is the Graph case: an application permission is consented once on the
 * app registration and is not scoped to a subscription or resource group.
 */
export type PermissionScopeLevel = RoleScopeLevel | "tenant";

/**
 * How much is lost without a permission - re-exported from azure-permissions
 * rather than redefined.
 *
 * ONE vocabulary on purpose. The same distinction decides what the ticket tags
 * `[feature]` and what the preflight declines to gate deploy readiness on, and
 * an operator who reads both should not have to work out whether two words that
 * look alike mean the same thing. Two identical unions in two modules is how
 * that stops being true.
 */
export type { PermissionNecessity } from "../azure-permissions";
import type { PermissionNecessity } from "../azure-permissions";

/** One permission the app registration needs, with its justification. */
export interface AppPermission {
  /**
   * Which system grants it. Decides the section it renders in, because the two
   * are granted by different people through different portals.
   */
  kind: "graph-api" | "azure-rbac";
  /** Graph permission name, or the Azure built-in role name. */
  name: string;
  scopeLevel: PermissionScopeLevel;
  /** The app capability that needs it - the "which". */
  feature: string;
  /** Why that capability cannot work without it - the "why". */
  justification: string;
  /** What still works if this one is refused. */
  withoutIt: string;
  necessity: PermissionNecessity;
  /** Assignment condition, where one narrows the grant (RBAC only). */
  condition?: string;
  /**
   * True when the grant has a specific portal step worth naming - an RBAC
   * condition that the CLI cannot attach, or the Graph admin-consent click.
   * The two are different portals, so consumers must render this per `kind`.
   */
  assignViaPortal?: boolean;
}

/**
 * Microsoft Graph APPLICATION permissions (not delegated - the app runs
 * headless, so there is no signed-in user to delegate from). Each needs an
 * Entra administrator to grant admin consent; until they do, the permission is
 * listed on the registration but inert.
 *
 * Least privilege is deliberate: `Application.Read.All` is requested rather
 * than `Directory.Read.All`, which would also satisfy the call but grants read
 * over the whole directory - users, groups, devices - none of which this app
 * reads.
 */
export const GRAPH_PERMISSIONS: readonly AppPermission[] = Object.freeze([
  Object.freeze({
    kind: "graph-api" as const,
    name: "Application.Read.All",
    scopeLevel: "tenant" as const,
    feature: "Pick the Cribl ingestion identity by name",
    justification:
      "Granting Cribl access to a Data Collection Rule requires the ingestion service principal's OBJECT id, which is NOT the application (client) id shown on its overview page - confusing the two is the single most common failure in this step. The app lists the tenant's service principals (GET /v1.0/servicePrincipals, id/appId/displayName only) so the operator picks the right identity from a named list instead of pasting an id. Directory.Read.All also satisfies this call but reads the entire directory; Application.Read.All is the least-privilege choice.",
    withoutIt:
      "The picker is replaced by a plain text box for the object id, which the operator must look up themselves. Nothing else is affected.",
    necessity: "feature" as const,
    assignViaPortal: true,
  }),
]);

/**
 * RBAC roles that shipped features need and that NO setup path grants.
 *
 * These are not oversights in role-plan: each setup path grants what THAT PATH
 * provisions, and both roles below are needed by features an operator reaches
 * afterwards. They are listed as `feature` so an approver can refuse them
 * without blocking setup.
 */
interface FeatureRole extends AppPermission {
  kind: "azure-rbac";
  scopeLevel: RoleScopeLevel;
  /**
   * Roles that already grant everything this entry asks for. When a setup
   * path's plan contains one of these at an equal or broader scope, this entry
   * is suppressed - the whole of the non-duplication rule, and the reason
   * asking for Contributor and Sentinel Contributor together never happens.
   */
  coveredBy: readonly string[];
}

export const FEATURE_ROLES: readonly FeatureRole[] = Object.freeze([
  Object.freeze({
    kind: "azure-rbac" as const,
    name: "Microsoft Sentinel Contributor",
    scopeLevel: "resourceGroup" as const,
    feature: "Install Microsoft Sentinel content",
    justification:
      "Installing analytic rules and workbooks, and onboarding a workspace to Sentinel, WRITE Microsoft.SecurityInsights resources. Log Analytics Contributor grants read across the subscription but no Microsoft.SecurityInsights write, so without this role the install fails on the first rule.",
    withoutIt:
      "Content cannot be installed from the app. It can still be generated as an ARM template to hand to someone who can deploy it; DCR deployment, table creation, and gap analysis are unaffected.",
    necessity: "feature" as const,
    coveredBy: Object.freeze(["Contributor", "Owner"]),
  }),
  Object.freeze({
    kind: "azure-rbac" as const,
    name: "RBAC Administrator",
    scopeLevel: "resourceGroup" as const,
    feature: "Grant Cribl access to each deployed DCR",
    justification:
      "Data only flows through a Data Collection Rule if the sending identity holds Monitoring Metrics Publisher ON THAT RULE, and creating a role assignment is itself a privileged action that Contributor does not include. Attach the condition below so this grant cannot be used to assign anything else.",
    withoutIt:
      "DCRs still deploy, but no data reaches them until someone with role-assignment rights grants Cribl's identity Monitoring Metrics Publisher on each one. The app generates a change request for exactly that grant.",
    necessity: "feature" as const,
    condition:
      "Constrain roles and principal types: only Monitoring Metrics Publisher, only to service principals.",
    assignViaPortal: true,
    coveredBy: Object.freeze(["RBAC Administrator", "Owner", "User Access Administrator"]),
  }),
]);

/** True when `held` is at least as broad a scope as `needed`. */
function scopeCovers(held: RoleScopeLevel, needed: RoleScopeLevel): boolean {
  return held === "subscription" || held === needed;
}

/**
 * The complete permission plan for a setup path: the Graph permissions, then
 * the setup path's own RBAC roles, then any feature role that path does not
 * already cover.
 *
 * A feature role is suppressed when the plan holds a role from its `coveredBy`
 * list at an equal or broader scope - so the lab paths, which grant subscription
 * or resource-group Contributor, never ask for Sentinel Contributor on top of
 * it. `lab-byo-rg` deliberately still asks for RBAC Administrator: Contributor
 * cannot assign roles at any scope, which is exactly why that path's own
 * comment says the app cannot do it.
 */
export function appPermissionPlan(path: AzureSetupPath): AppPermission[] {
  const plan = rolePlanForSetupPath(path);

  const setupRoles: AppPermission[] = plan.map((req) => {
    const entry: AppPermission = {
      kind: "azure-rbac",
      name: req.role,
      scopeLevel: req.scopeLevel,
      feature: req.feature,
      justification: req.justification,
      withoutIt: req.withoutIt,
      necessity: "core",
    };
    if (req.condition !== undefined) {
      entry.condition = req.condition;
    }
    if (req.assignViaPortal !== undefined) {
      entry.assignViaPortal = req.assignViaPortal;
    }
    return entry;
  });

  const covered = (role: FeatureRole): boolean =>
    plan.some(
      (held) =>
        role.coveredBy.includes(held.role) &&
        scopeCovers(held.scopeLevel, role.scopeLevel),
    );

  // `coveredBy` is suppression bookkeeping, not something a ticket should show,
  // so the returned entry is rebuilt field by field rather than spread.
  const featureRoles: AppPermission[] = FEATURE_ROLES.filter(
    (role) => !covered(role),
  ).map((role) => {
    const entry: AppPermission = {
      kind: role.kind,
      name: role.name,
      scopeLevel: role.scopeLevel,
      feature: role.feature,
      justification: role.justification,
      withoutIt: role.withoutIt,
      necessity: role.necessity,
    };
    if (role.condition !== undefined) {
      entry.condition = role.condition;
    }
    if (role.assignViaPortal !== undefined) {
      entry.assignViaPortal = role.assignViaPortal;
    }
    return entry;
  });

  return [...GRAPH_PERMISSIONS.map((p) => ({ ...p })), ...setupRoles, ...featureRoles];
}

/** The Graph half of a plan, in plan order. */
export function graphPermissions(plan: readonly AppPermission[]): AppPermission[] {
  return plan.filter((p) => p.kind === "graph-api");
}

/** The Azure RBAC half of a plan, in plan order. */
export function rbacPermissions(plan: readonly AppPermission[]): AppPermission[] {
  return plan.filter((p) => p.kind === "azure-rbac");
}
