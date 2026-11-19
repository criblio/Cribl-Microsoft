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
import { LEAST_PRIVILEGE_FUNCTIONS, leastRoleFor, privilegeOperation } from "../least-privilege";
import type { OperationId } from "../least-privilege";
import { RECEIVER_GRANT_ADMIN_CONDITION } from "../eventhub-receiver-grant/receiver-grant-permissions";

/**
 * Where a permission applies.
 *
 * `tenant` is the Graph case: an application permission is consented once on the
 * app registration and is not scoped to a subscription or resource group.
 * `resource` is a grant on one resource the configuration does not name - the
 * Event Hub namespace a source reads, which may sit in any resource group -
 * described by {@link AppPermission.resource}. `managementGroup` is a grant at
 * the customer's management group, which the configuration does not name
 * either; {@link AppPermission.resource} says which group (AZR-82).
 */
export type PermissionScopeLevel =
  | RoleScopeLevel
  | "resource"
  | "managementGroup"
  | "tenant";

/**
 * What a ticket prints after the resource of a grant that may sit outside the
 * configured subscription and resource group: when the resource is local, a
 * role already in the ticket reaches it and the approver can skip the line.
 */
export const OUTSIDE_SCOPE_CAVEAT = "skip if a role above already covers it";

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
  kind: "graph-api" | "azure-rbac" | "entra-directory-role";
  /** Graph permission name, or the Azure built-in role name. */
  name: string;
  /**
   * The entry's identity within a plan - what the Partially Connected
   * checklist stores and the ticket filters on. Equal to {@link name} except
   * where the same role is asked for twice at different scopes (Reader at the
   * subscription, and Reader on an Event Hub namespace in another one), which
   * an approver must be able to tick or refuse separately.
   */
  key: string;
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
  /** For `resource` or `managementGroup` scope: which one, in words a ticket can use. */
  resource?: string;
  /**
   * True when the least privilege for this grant is undocumented and was not
   * measured: the ticket says so, and an approver may refuse it at no cost
   * beyond the one check it serves.
   */
  unverified?: true;
  /**
   * For a resource-group grant on a NAMED group other than the configured one
   * (NetworkWatcherRG for the byo lab's flow logs, AZR-81).
   */
  resourceGroup?: string;
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
    key: leastRoleFor("graph.servicePrincipals.read"),
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
    key: leastRoleFor("graph.subscribedSkus.read"),
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
 * The actions Validate and the Logging Map call at a management group, read
 * from the registry: what a custom role narrower than Reader must hold there.
 */
export const MANAGEMENT_GROUP_READ_ACTIONS: readonly string[] = Object.freeze(
  [
    ...new Set(
      LEAST_PRIVILEGE_FUNCTIONS.filter((f) => f.id === "validate" || f.id === "logging-map")
        .flatMap((f) => f.operations)
        .filter((id) => privilegeOperation(id).scope === "managementGroup")
        .map((id) => privilegeOperation(id).operation),
    ),
  ].sort(),
);

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
  scopeLevel: RoleScopeLevel | "resource" | "managementGroup";
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
  /**
   * True when the resource may sit outside the configured subscription and
   * resource group (a DCR's DCE, a private link scope, an Event Hub
   * namespace). No grant the setup path holds can then be assumed to reach it,
   * so the row is never suppressed; its ticket line says to skip it when a
   * role above already covers the resource. Bookkeeping: never reaches a ticket.
   */
  outsideConfiguredScope?: true;
  /**
   * True when only the existing-resources path asks for the row: a lab
   * creates these resources in its own group, and reads nothing above it
   * (review of AZR-82/84). Bookkeeping: never reaches a ticket.
   */
  existingOnly?: true;
}

/** The fields a feature role states itself; everything else is read from the registry. */
type FeatureRoleFields = Omit<
  FeatureRole,
  "kind" | "name" | "key" | "coveredBy" | "operationId" | "scopeLevel" | "broaderScopeWhy"
> & {
  /** A distinct {@link AppPermission.key}, when the role name alone repeats in a plan. */
  key?: string;
  /** Ask at a broader scope than the registry's, and why. */
  broaderScope?: { level: RoleScopeLevel; why: string };
};

/** The registry scope of an RBAC operation as a feature-role scope level. */
function rbacScopeOf(
  operationId: OperationId,
): RoleScopeLevel | "resource" | "managementGroup" {
  const scope = privilegeOperation(operationId).scope;
  if (
    scope === "subscription" ||
    scope === "resourceGroup" ||
    scope === "resource" ||
    scope === "managementGroup"
  ) {
    return scope;
  }
  // A feature role at tenant or Cribl scope needs a ticket shape this RBAC
  // catalog does not have (an Entra directory role is ENTRA_DIRECTORY_ROLES);
  // fail loudly rather than mis-scope it.
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
  const { broaderScope, key, ...rest } = fields;
  const scopeLevel = broaderScope?.level ?? rbacScopeOf(operationId);
  const role: FeatureRole = {
    kind: "azure-rbac" as const,
    name: op.leastRole,
    key: key ?? op.leastRole,
    coveredBy: Object.freeze([op.leastRole, ...op.alsoGrantedBy]),
    operationId,
    scopeLevel,
    ...rest,
  };
  if ((scopeLevel === "resource" || scopeLevel === "managementGroup") && role.resource === undefined) {
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
    outsideConfiguredScope: true,
    unmeasured:
      "listKeys can be granted on the namespace alone, so a subscription or resource-group evaluation would read it as denied (CAP-7b); it is never probed, because a probe would return a key.",
  }),
  // AZR-61 audit discrepancy 15 (AZR-84): three resources the app reads or
  // writes may sit outside the configured subscription and resource group,
  // where no role a setup path holds reaches them. Named in words, as listKeys
  // is, and reported by the preflight as not measured rather than denied.
  featureRole("ampls.scopedResource.write", {
    key: "Monitoring Contributor (private link scope)",
    existingOnly: true,
    feature: "Associate a new DCE with an Azure Monitor Private Link Scope",
    justification:
      "When the workspace accepts data only over private link, onboarding associates each new DCE with the private link scope (PUT .../privateLinkScopes/{scope}/scopedResources/{name}), a write on the scope itself. The scope may sit in another resource group or subscription.",
    withoutIt:
      "The DCE still deploys, but a private-only workspace cannot be reached through it until someone associates it with the scope.",
    necessity: "feature" as const,
    outsideConfiguredScope: true,
    unmeasured:
      "On a resource the configuration does not name, so no preflight scope reaches it.",
  }),
  featureRole("dce.read", {
    existingOnly: true,
    feature: "Show the ingestion endpoint of a DCE-based DCR",
    justification:
      "The deployment preview reads the Data Collection Endpoint a DCR names (GET on its resource id) to show where Cribl sends data. A DCR may name a DCE in another resource group or subscription.",
    withoutIt:
      "The preview cannot show that DCR's endpoint. Deploying is unaffected.",
    necessity: "feature" as const,
    outsideConfiguredScope: true,
    unmeasured:
      "On a resource the configuration does not name, so no preflight scope reaches it.",
  }),
  featureRole("eventhub.namespace.read", {
    key: "Reader (Event Hub namespace)",
    existingOnly: true,
    feature: "Read an Event Hub namespace, its rules and consumer groups",
    justification:
      "Validate, Create Cribl source and the Defender export read the namespace, its shared access rules and its consumer groups. The namespace may sit in another resource group or subscription, which subscription Reader does not reach.",
    withoutIt:
      "Those reads show as could not be read for that namespace. Nothing is changed in Azure.",
    necessity: "feature" as const,
    outsideConfiguredScope: true,
    unmeasured:
      "On a resource the configuration does not name, so no preflight scope reaches it.",
  }),
  // AZR-103: the onboarding screen grants the Cribl principal Azure Event
  // Hubs Data Receiver on the hub (or the namespace, when chosen). Creating a
  // role assignment is privileged and Contributor does not include it, so the
  // ask is RBAC Administrator ON THAT RESOURCE, conditioned to this one role.
  // AZR-141: the same role holds roleAssignments/delete, which the teardown
  // panel's Remove uses; the condition narrows both actions alike.
  featureRole("eventhub.receiverGrant.write", {
    key: "RBAC Administrator (Event Hub)",
    existingOnly: true,
    feature: "Grant the Cribl principal Azure Event Hubs Data Receiver",
    justification:
      "The Cribl Event Hubs source signs in with Entra ID as a service principal dedicated to Cribl, which needs Azure Event Hubs Data Receiver on the hub it reads. The onboarding screen can make that one assignment itself (PUT .../providers/Microsoft.Authorization/roleAssignments/{name} on the hub, or on the namespace when chosen), behind a confirm, and later remove the one it made (DELETE of the same name, from Remove or pause what this app created). Attach the condition below so this grant cannot be used to assign or remove anything else.",
    withoutIt:
      "An administrator assigns Data Receiver to the Cribl principal by hand (the How-to step and the resource-creation request say how), or the source uses a Listen-only shared access rule; the assignment is then removed by hand too. Nothing else is affected.",
    necessity: "feature" as const,
    condition: RECEIVER_GRANT_ADMIN_CONDITION,
    assignViaPortal: true,
    outsideConfiguredScope: true,
    unmeasured: "On a resource the configuration does not name, so no preflight scope reaches it.",
  }),
  // AZR-61 audit discrepancy 10 (AZR-82): Validate's policy checks and the
  // Logging Map read at the customer's management group. Reader there is the
  // one built-in role that covers every read: Management Group Reader grants
  // the policy reads but not remediations or the descendants tree.
  featureRole("managementGroups.descendants.read", {
    key: "Reader (management group)",
    existingOnly: true,
    feature: "Read policy and the management group tree",
    justification:
      "Validate's policy checks and the Logging Map read policy assignments, exemptions, definitions and remediations, and the management group tree, at your management group. Reader there covers all of them; Management Group Reader alone misses remediations and the tree. It reaches every subscription beneath the group. A custom role with only " +
      MANAGEMENT_GROUP_READ_ACTIONS.join(", ") +
      " at the management group is narrower still.",
    withoutIt:
      "Validate's policy checks read as could not be read, and the Logging Map lists subscriptions without the management group tree.",
    necessity: "feature" as const,
    unmeasured: "At a management group, which no preflight scope reads.",
  }),
  // AZR-85 review: Enable Sentinel PUTs the SecurityInsights(workspace)
  // Microsoft.OperationsManagement solution at the workspace's resource
  // group. Log Analytics Contributor at the group covered it by accident;
  // asked on the workspace, it no longer does, so it is asked for here -
  // only where Sentinel is not yet enabled.
  featureRole("sentinel.solution.write", {
    key: "Log Analytics Contributor (resource group)",
    existingOnly: true,
    scopeCaveat: "skip if Microsoft Sentinel is already enabled on the workspace",
    feature: "Enable Microsoft Sentinel on the workspace",
    justification:
      "Enable Sentinel writes the SecurityInsights solution for the workspace, a Microsoft.OperationsManagement/solutions resource in the workspace's resource group rather than under the workspace, so the workspace grant above does not reach it. A custom role with only Microsoft.OperationsManagement/solutions/write and Microsoft.OperationsManagement/solutions/read at the resource group is narrower still.",
    withoutIt:
      "Enable Sentinel on the targeting screen fails with a 403; enabling it in the portal (Microsoft Sentinel > Create, then pick the workspace) does the same thing. Nothing else is affected.",
    necessity: "feature" as const,
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
 * Entra ID directory roles - granted by an Entra administrator in Roles and
 * administrators, neither consented on the registration (Graph) nor assigned
 * in IAM (RBAC), so they are a third kind with their own ticket section.
 *
 * AZR-61 audit discrepancy 11 (AZR-82): Validate reads the tenant's Entra ID
 * diagnostic settings, and no ticket asked for the role that call needs. The
 * least privilege for a service principal is undocumented (registry
 * confidence low), so the row is marked unverified and optional.
 *
 * AZR-99: the same role covers the onboarding screen's Entra ID Deploy and
 * Remove (PUT / DELETE of the tenant setting; Microsoft documents Security
 * Administrator for creating Entra diagnostic settings). ONE row, not a second
 * one for the same role: the administrator grants it once, and the row says
 * both uses so the refusal is an informed one.
 */
const ENTRA_DIRECTORY_ROLES: readonly AppPermission[] = Object.freeze([
  Object.freeze({
    kind: "entra-directory-role" as const,
    name: leastRoleFor("entra.diagnosticSettings.read"),
    key: leastRoleFor("entra.diagnosticSettings.read"),
    scopeLevel: "tenant" as const,
    feature: "Check, deploy and remove the Entra ID diagnostic setting",
    justification:
      "Security Administrator is a privileged Entra directory role: it can change security policy and Conditional Access across the whole tenant. It is asked for only so Validate's optional Entra ID diagnostic settings check can read GET /providers/microsoft.aadiam/diagnosticSettings, for which Microsoft documents no read-only role, and so the onboarding screen's optional Entra ID Deploy can create (and Remove can delete) the one tenant setting CriblEntraIDLogs it streams sign-in and audit logs with. We recommend refusing it unless that check or that deploy is needed.",
    withoutIt:
      "Validate's Entra ID diagnostic settings check reads as could not be read, and the Entra ID Deploy is refused by Azure; the How-to steps still let an administrator who holds the role create the setting by hand. Nothing else is affected.",
    necessity: "feature" as const,
    unverified: true as const,
    assignViaPortal: true,
  }),
]);

/**
 * True when a setup-path grant at `held` reaches what `role` needs.
 *
 * - A role flagged {@link FeatureRole.outsideConfiguredScope} is covered by
 *   nothing the setup path holds: the configured subscription is not every
 *   subscription (AZR-84).
 * - A resource-group grant does NOT cover a `resource` grant: the resource
 *   may sit in a different resource group from the one the plan names.
 * - A subscription grant covers its resource groups and their resources, and
 *   an equal scope covers itself.
 * - A grant at the configured resource group or subscription covers the
 *   configured workspace inside it; a workspace grant covers nothing but the
 *   workspace (AZR-85).
 * - Nothing a setup path holds covers a management group: a subscription is
 *   BELOW one, so subscription Reader never stands in for management group
 *   Reader (AZR-82 refuter correction).
 */
export function scopeCovers(
  held: RoleScopeLevel,
  role: Pick<FeatureRole, "scopeLevel" | "outsideConfiguredScope">,
): boolean {
  if (role.outsideConfiguredScope === true) {
    return false;
  }
  const needed = role.scopeLevel;
  if (held === needed) {
    return true;
  }
  if (needed === "workspace") {
    return held === "subscription" || held === "resourceGroup";
  }
  return held === "subscription" && (needed === "resourceGroup" || needed === "resource");
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
      key: req.role,
      scopeLevel: req.scopeLevel,
      feature: req.feature,
      justification: req.justification,
      withoutIt: req.withoutIt,
      necessity: req.necessity ?? "core",
    };
    if (req.resourceGroup !== undefined) {
      entry.resourceGroup = req.resourceGroup;
    }
    if (req.condition !== undefined) {
      entry.condition = req.condition;
    }
    if (req.assignViaPortal !== undefined) {
      entry.assignViaPortal = req.assignViaPortal;
    }
    return entry;
  });

  // Only the existing-resources path points at resources outside its own
  // scope; a lab creates them in its own group, so on a lab path the
  // outside-scope flag does not apply (review of AZR-84).
  const existing = path === "existing";
  const outside = (role: FeatureRole): boolean =>
    existing && role.outsideConfiguredScope === true;

  // A grant on a named other group (NetworkWatcherRG) covers nothing the
  // feature roles need: they sit in the configured group or elsewhere.
  const covered = (role: FeatureRole): boolean =>
    plan.some(
      (held) =>
        held.resourceGroup === undefined &&
        role.coveredBy.includes(held.role) &&
        scopeCovers(held.scopeLevel, outside(role) ? role : { scopeLevel: role.scopeLevel }),
    );

  // `coveredBy` is suppression bookkeeping, not something a ticket should show,
  // so the returned entry is rebuilt field by field rather than spread.
  const featureRoles: AppPermission[] = FEATURE_ROLES.filter(
    (role) => (existing || role.existingOnly !== true) && !covered(role),
  ).map((role) => {
    const entry: AppPermission = {
      kind: role.kind,
      name: role.name,
      key: role.key,
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
    } else if (outside(role)) {
      entry.scopeCaveat = OUTSIDE_SCOPE_CAVEAT;
    }
    if (role.assignViaPortal !== undefined) {
      entry.assignViaPortal = role.assignViaPortal;
    }
    return entry;
  });

  return [
    ...GRAPH_PERMISSIONS.map((p) => ({ ...p })),
    ...setupRoles,
    ...featureRoles,
    // The Entra role serves one optional Validate check against an existing
    // tenant; a lab ticket never asks for a privileged directory role.
    ...(existing ? ENTRA_DIRECTORY_ROLES.map((p) => ({ ...p })) : []),
  ];
}

/** The Graph half of a plan, in plan order. */
export function graphPermissions(plan: readonly AppPermission[]): AppPermission[] {
  return plan.filter((p) => p.kind === "graph-api");
}

/** The Entra ID directory roles of a plan, in plan order. */
export function entraDirectoryRoles(plan: readonly AppPermission[]): AppPermission[] {
  return plan.filter((p) => p.kind === "entra-directory-role");
}

/** The Azure RBAC half of a plan, in plan order. */
export function rbacPermissions(plan: readonly AppPermission[]): AppPermission[] {
  return plan.filter((p) => p.kind === "azure-rbac");
}

/** A grant the setup preflight cannot measure, because no scope it reads reaches it. */
export interface UnmeasuredGrant {
  /** The role or directory role asked for. */
  name: string;
  /** Where it is granted, in the ticket's words. */
  where: string;
  /** The capability that needs it. */
  feature: string;
}

/**
 * The plan's grants the setup preflight cannot measure: every entry on a
 * resource the configuration does not name (AZR-84), at a management group,
 * an Entra directory role (AZR-82), or on a named group other than the
 * configured one (NetworkWatcherRG, AZR-81 - the Labs preflight measures it). The preflight reads effective
 * permissions only at the configured subscription, resource group and
 * workspace (AZR-85), so these are reported as not measured - unknown, never
 * denied.
 */
export function preflightUnmeasuredGrants(
  requested: readonly AppPermission[],
): UnmeasuredGrant[] {
  // Takes the REQUESTED entries, not a path: a Partially Connected request
  // asks for a subset, and an unrequested grant is not worth reporting.
  return requested
    .filter(
      (p) =>
        p.kind !== "graph-api" &&
        (p.resourceGroup !== undefined ||
          (p.scopeLevel !== "subscription" &&
            p.scopeLevel !== "resourceGroup" &&
            p.scopeLevel !== "workspace")),
    )
    .map((p) => ({ name: p.name, where: unmeasuredWhere(p), feature: p.feature }));
}

function unmeasuredWhere(p: AppPermission): string {
  if (p.kind === "entra-directory-role") {
    return "the tenant (Entra ID directory role)";
  }
  if (p.resourceGroup !== undefined) {
    return "resource group " + p.resourceGroup;
  }
  if (p.scopeLevel === "managementGroup") {
    return "the management group: " + (p.resource ?? "<management group>");
  }
  return p.resource ?? "<resource>";
}
