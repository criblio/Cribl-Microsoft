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
 * ROLE NAMES COME FROM THE LEAST-PRIVILEGE REGISTRY (AZR-61, ADR 0009). Each
 * feature role names the registry operation it is asked for, and its name,
 * suppression list and (for a resource-scoped grant) the resource it is granted
 * on are read from that operation. The prose - which feature, why, what refusing
 * costs - stays here, because it is written for an approver about THIS app.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto. Output is
 * deterministic.
 */

import type { AzureSetupPath } from "../azure-config";
import { rolePlanForSetupPath } from "../role-plan";
import type { RoleScopeLevel } from "../role-plan";
import { leastRoleFor, privilegeOperation } from "../least-privilege";
import type { OperationId } from "../least-privilege";

/**
 * Where a permission applies.
 *
 * `tenant` is the Graph case: an application permission is consented once on the
 * app registration and is not scoped to a subscription or resource group.
 * `resource` is a grant on one resource the configuration does not name - the
 * Event Hub namespace a source reads, which may sit in any resource group -
 * described by {@link AppPermission.resource}.
 */
export type PermissionScopeLevel = RoleScopeLevel | "resource" | "tenant";

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
  /** For `resource` scope: which resource, in words a ticket can use. */
  resource?: string;
  /**
   * For a resource-group grant whose group the operator may choose somewhere
   * else in the app: words a ticket prints after the configured group, so the
   * approver knows the role follows the choice (the Defender export goes into
   * whichever group the Defender section picks).
   */
  scopeCaveat?: string;
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
    name: leastRoleFor("graph.servicePrincipals.read"),
    scopeLevel: "tenant" as const,
    feature: "Pick the Cribl ingestion identity by name",
    justification:
      "Granting Cribl access to a Data Collection Rule requires the ingestion service principal's OBJECT id, which is NOT the application (client) id shown on its overview page - confusing the two is the single most common failure in this step. The app lists the tenant's service principals (GET /v1.0/servicePrincipals, id/appId/displayName only) so the operator picks the right identity from a named list instead of pasting an id. Directory.Read.All also satisfies this call but reads the entire directory; Application.Read.All is the least-privilege choice.",
    withoutIt:
      "The picker is replaced by a plain text box for the object id, which the operator must look up themselves. Nothing else is affected.",
    necessity: "feature" as const,
    assignViaPortal: true,
  }),
  Object.freeze({
    kind: "graph-api" as const,
    name: leastRoleFor("graph.subscribedSkus.read"),
    scopeLevel: "tenant" as const,
    feature: "Show how much of the E5 data allowance is granted",
    justification:
      "Microsoft 365 E5-family licences grant free Sentinel ingestion of 5 MB per licensed seat per day, so the granted figure is a seat count times 5 MB. The app reads the tenant's license SKUs and their seat counts (GET /v1.0/subscribedSkus: SKU id, part number, purchased and assigned seats) - not who holds them. Organization.Read.All and Directory.Read.All also satisfy this call but read far more of the directory; LicenseAssignment.Read.All is the least-privilege choice.",
    withoutIt:
      "Used and over-allowance figures still come from the workspace; the granted figure shows as at least the largest benefit Microsoft applied on one day, and headroom is not shown.",
    necessity: "feature" as const,
    assignViaPortal: true,
  }),
]);

/**
 * RBAC roles that shipped features need and that NO setup path grants.
 *
 * These are not oversights in role-plan: each setup path grants what THAT PATH
 * provisions, and the roles below are needed by features an operator reaches
 * afterwards. They are listed as `feature` so an approver can refuse them
 * without blocking setup.
 */
interface FeatureRole extends AppPermission {
  kind: "azure-rbac";
  scopeLevel: RoleScopeLevel | "resource";
  /**
   * Roles that already grant everything this entry asks for. When a setup
   * path's plan contains one of these at an equal or broader scope, this entry
   * is suppressed - the whole of the non-duplication rule, and the reason
   * asking for Contributor and Sentinel Contributor together never happens.
   * Read from the registry: the operation's least role plus every role it says
   * also grants it.
   */
  coveredBy: readonly string[];
  /** The registry operation this role is asked for; its least role is the name. */
  operationId: OperationId;
  /**
   * Why the setup path's preflight cannot measure this grant, when it cannot.
   * Bookkeeping like `coveredBy`: it never reaches a ticket.
   */
  unmeasured?: string;
  /**
   * Present exactly when {@link scopeLevel} is broader than the registry's
   * narrowest scope for the operation, and says why the ticket asks broader.
   * Bookkeeping: it never reaches a ticket.
   */
  broaderScopeWhy?: string;
}

/** The fields a feature role states itself; everything else is read from the registry. */
type FeatureRoleFields = Omit<
  FeatureRole,
  "kind" | "name" | "coveredBy" | "operationId" | "scopeLevel" | "broaderScopeWhy"
> & {
  /** Ask at a broader scope than the registry's, and why. */
  broaderScope?: { level: RoleScopeLevel; why: string };
};

/** The registry scope of an RBAC operation as a feature-role scope level. */
function rbacScopeOf(operationId: OperationId): RoleScopeLevel | "resource" {
  const scope = privilegeOperation(operationId).scope;
  if (scope === "subscription" || scope === "resourceGroup" || scope === "resource") {
    return scope;
  }
  // A feature role at tenant, management-group or Cribl scope needs a ticket
  // shape this catalog does not have; fail loudly rather than mis-scope it.
  throw new Error(`feature role for '${operationId}' has registry scope '${scope}'`);
}

/**
 * A feature role whose name, suppression list and scope are read from the
 * registry (AZR-61 review: the scope was once a literal that already
 * disagreed with the registry in two places). The `resource` words default to
 * the registry's scope note for a resource-scoped grant.
 */
function featureRole(operationId: OperationId, fields: FeatureRoleFields): FeatureRole {
  const op = privilegeOperation(operationId);
  const { broaderScope, ...rest } = fields;
  const scopeLevel = broaderScope?.level ?? rbacScopeOf(operationId);
  const role: FeatureRole = {
    kind: "azure-rbac" as const,
    name: op.leastRole,
    coveredBy: Object.freeze([op.leastRole, ...op.alsoGrantedBy]),
    operationId,
    scopeLevel,
    ...rest,
  };
  if (scopeLevel === "resource" && role.resource === undefined) {
    role.resource = op.scopeNote;
  }
  if (broaderScope !== undefined) {
    role.broaderScopeWhy = broaderScope.why;
  }
  return Object.freeze(role);
}

export const FEATURE_ROLES: readonly FeatureRole[] = Object.freeze([
  featureRole("sentinel.alertRule.write", {
    broaderScope: {
      level: "resourceGroup",
      why: "Microsoft recommends assigning Microsoft Sentinel Contributor on the workspace's resource group rather than on the workspace alone (the registry's scope note says so), and the solution and content installs write resources beside the workspace.",
    },
    feature: "Install Microsoft Sentinel content",
    justification:
      "Installing analytic rules and workbooks, and onboarding a workspace to Sentinel, WRITE Microsoft.SecurityInsights resources. Log Analytics Contributor grants read across the subscription but no Microsoft.SecurityInsights write, so without this role the install fails on the first rule.",
    withoutIt:
      "Content cannot be installed from the app. It can still be generated as an ARM template to hand to someone who can deploy it; DCR deployment, table creation, and gap analysis are unaffected.",
    necessity: "feature" as const,
  }),
  featureRole("dcr.roleAssignment.write", {
    broaderScope: {
      level: "resourceGroup",
      why: "The least scope is each DCR, but the app deploys DCRs one at a time and grants on each as it goes; a per-DCR grant would need a new ticket for every rule, where one conditioned resource-group grant covers every DCR the app deploys there.",
    },
    feature: "Grant Cribl access to each deployed DCR",
    justification:
      "Data only flows through a Data Collection Rule if the sending identity holds Monitoring Metrics Publisher ON THAT RULE, and creating a role assignment is itself a privileged action that Contributor does not include. Attach the condition below so this grant cannot be used to assign anything else.",
    withoutIt:
      "DCRs still deploy, but no data reaches them until someone with role-assignment rights grants Cribl's identity Monitoring Metrics Publisher on each one. The app generates a change request for exactly that grant.",
    necessity: "feature" as const,
    condition:
      "Constrain roles and principal types: only Monitoring Metrics Publisher, only to service principals.",
    assignViaPortal: true,
  }),
  // AZR-61 audit discrepancy 1 (high): Create Cribl source with the listKeys
  // credential and the Defender export both POST listKeys, and no plan asked
  // for any role that grants it.
  featureRole("eventhub.rule.listKeys", {
    feature: "Read an Event Hub rule's connection string",
    justification:
      "Creating the Cribl Event Hub source with the listKeys credential, and deploying the Defender continuous export, read the connection string of a namespace shared access rule (POST .../authorizationRules/{rule}/listKeys). That is an /action, which Reader does not grant: Reader passes every Event Hub rule check in Validate while listKeys still returns 403. A custom role with only authorizationRules/listKeys/action and authorizationRules/read on the namespace is narrower still.",
    withoutIt:
      "Paste the connection string into the source instead, or use the Entra ID credential; the Defender export cannot be deployed from the app. Validate and discovery are unaffected.",
    necessity: "feature" as const,
    unmeasured:
      "listKeys can be granted on the namespace alone, so a subscription or resource-group evaluation would read it as denied (CAP-7b); it is never probed, because a probe would return a key.",
  }),
  // AZR-61 audit discrepancy 2 (high): the preflight measured the Defender
  // export's actions and no ticket asked for a role that grants them.
  featureRole("defender.automation.write", {
    scopeCaveat:
      "the default; the role is needed on whichever resource group you deploy CriblDefenderExport into in the Defender section",
    feature: "Deploy the Defender for Cloud continuous export",
    justification:
      "The export is a Microsoft.Security/automations resource (CriblDefenderExport) the app creates in the resource group chosen in the Defender section; creating it needs automations/write, which neither Reader nor the Monitoring and Log Analytics roles include.",
    withoutIt:
      "The export cannot be deployed from the app; the How-to gives the portal steps for someone who holds the role. Reading which Defender plans are on is unaffected.",
    necessity: "feature" as const,
    unmeasured:
      "Measured only by the subscription-scope evaluation (CAP-7a, existing-subscription); the resource-group preflight this path runs does not check it.",
  }),
  featureRole("defender.automations.list", {
    feature: "Read the Defender for Cloud plans and continuous exports",
    justification:
      "Before deploying the export the app reads which Defender plans are on (pricings/read) and lists the subscription's continuous exports (automations/read) so it never creates a duplicate.",
    withoutIt:
      "The Defender section shows its state as unknown and refuses to deploy, because it cannot rule out a duplicate export.",
    necessity: "feature" as const,
    unmeasured:
      "Measured only by the subscription-scope evaluation (CAP-7a, existing-subscription); the resource-group preflight this path runs does not check it.",
  }),
]);

/**
 * True when `held` is at least as broad a scope as `needed`. A resource-group
 * grant does NOT cover a `resource` grant: the resource (an Event Hub
 * namespace) may sit in a different resource group from the one the plan names.
 */
function scopeCovers(held: RoleScopeLevel, needed: RoleScopeLevel | "resource"): boolean {
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
 * it. On `lab-byo-rg` the path's own CORE role is RBAC Administrator on the lab
 * resource group, conditioned to Contributor and Monitoring Metrics Publisher,
 * for the TTL identity grant every lab deploy makes; that same grant covers the
 * DCR-grant feature role, so the feature role is suppressed rather than asked
 * twice. (Contributor alone cannot assign roles at any scope, which is why the
 * path needs that core role at all.)
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
    if (role.resource !== undefined) {
      entry.resource = role.resource;
    }
    if (role.scopeCaveat !== undefined) {
      entry.scopeCaveat = role.scopeCaveat;
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
