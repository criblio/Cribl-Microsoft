/**
 * Change-request ticket generators - PURE TEXT CONTRACT.
 *
 * Some operators cannot create Azure resources, app registrations, or role
 * assignments themselves and must ask another team to do it. These generators
 * turn a {@link ChangeRequestContext} into a complete, paste-ready ticket body
 * (title + what is requested + justification + concrete specifics + an embedded
 * Mermaid architecture diagram) so the request is unambiguous and
 * self-justifying. The embedded diagram is a fenced ```mermaid block whose
 * SOURCE text is plain 7-bit ASCII, so the whole ticket body pastes safely into
 * any plain-text system and renders as a diagram wherever Markdown+Mermaid is
 * supported.
 *
 * The RBAC role model in {@link roleAssignmentRequest} mirrors EXACTLY the role
 * logic the setup wizard's az-CLI script builder uses (roles, scopes, and the
 * lab-new-rg "Constrain roles and principal types" condition), so a ticket asks
 * for precisely what the wizard would otherwise self-assign.
 *
 * {@link appRegistrationRequest} asks for MORE than that: the full permission
 * plan from domain/app-permissions, which is the setup-path roles plus the Graph
 * application permission and the feature roles no setup path grants. The two
 * generators therefore differ on purpose - the role ticket asks the subscription
 * owner for what the wizard would self-assign, while the app-registration ticket
 * is the one an operator sends before anything works and so must name
 * everything. Neither restates the role model; both compose it.
 *
 * Any blank context field renders as a clear placeholder (for example
 * `<tenant id>`), so a partially filled request is visibly incomplete.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto. Output is
 * deterministic and suitable for pasting into a ticket or email.
 */

import type { AzureConfig, AzureSetupPath } from "../azure-config";
import { appPermissionPlan, graphPermissions, rbacPermissions } from "../app-permissions";
import type { AppPermission } from "../app-permissions";
import { rolePlanForSetupPath } from "../role-plan";
import {
  authFlowMermaid,
  dataExportFlowMermaid,
  dcrDeployFlowMermaid,
  resolveNames,
} from "../dataflow-diagram";
import type { DiagramContext, ResolvedNames } from "../dataflow-diagram";

/**
 * The input every generator reads: the app's display name plus the persisted
 * non-secret Azure config. The client secret is deliberately absent - it lives
 * only in the encrypted write-only secrets entry and is never referenced here.
 */
export interface ChangeRequestContext {
  /** Human-readable application name shown in the ticket title and body. */
  appName: string;
  /** The persisted non-secret Azure configuration. */
  config: AzureConfig;
}

/** Per-generator options. */
export interface ChangeRequestOptions {
  /** Embed the Mermaid architecture diagram(s). Defaults to `true`. */
  includeDiagram?: boolean;
}

/** One requested role assignment: the role, its scope, and why it is needed. */
interface RoleRequest {
  /** The Azure built-in role name to assign. */
  role: string;
  /** The fully-qualified scope the role is assigned at. */
  scope: string;
  /** One-line justification for this specific role. */
  justification: string;
  /** Optional assignment condition (used for the lab-new-rg RBAC Administrator). */
  condition?: string;
}

/** Render a heading followed by an ASCII underline and a body block. */
function section(heading: string, body: string): string {
  return heading + "\n" + "-".repeat(heading.length) + "\n" + body;
}

/** The identity header block shared by every ticket. */
function requestHeader(n: ResolvedNames): string {
  return [
    "Requesting application: " + n.appName,
    "Service principal (client id): " + n.clientId,
    "Tenant id: " + n.tenantId,
  ].join("\n");
}

/** The subscription-level scope string for a resolved context. */
function subscriptionScope(n: ResolvedNames): string {
  return "/subscriptions/" + n.subscriptionId;
}

/** The resource-group-level scope string for a resolved context. */
function resourceGroupScope(n: ResolvedNames): string {
  return (
    "/subscriptions/" + n.subscriptionId + "/resourceGroups/" + n.resourceGroup
  );
}

/**
 * The RBAC roles a setup path requires, resolved into fully-qualified request
 * rows for a ticket. The role model itself (which roles, at which scope LEVEL,
 * with which justification and condition) is the single source of truth in
 * {@link rolePlanForSetupPath}; this function only turns each abstract scope
 * level into the concrete scope string for the resolved context, so the ticket
 * and the setup wizard's az-CLI script can never drift.
 *
 * - `existing`   - Reader on the subscription, plus Monitoring Contributor and
 *   Log Analytics Contributor scoped to the workspace resource group.
 * - `lab-new-rg` - Contributor on the subscription (resource-group creation is a
 *   subscription-level action and covers all lab operations), plus RBAC
 *   Administrator on the subscription CONSTRAINED to only Contributor and
 *   Monitoring Metrics Publisher, only to service principals.
 * - `lab-byo-rg` - Contributor on the pre-created lab resource group only.
 */
function rolesForSetupPath(
  path: AzureSetupPath,
  n: ResolvedNames,
): RoleRequest[] {
  return rolePlanForSetupPath(path).map((req) => {
    const request: RoleRequest = {
      role: req.role,
      scope:
        req.scopeLevel === "subscription"
          ? subscriptionScope(n)
          : resourceGroupScope(n),
      justification: req.justification,
    };
    if (req.condition !== undefined) {
      request.condition = req.condition;
    }
    return request;
  });
}

/**
 * Render the Mermaid diagram, or `null` when diagrams are suppressed via
 * `includeDiagram: false`. Included by default.
 */
function diagramFor(
  ctx: DiagramContext,
  options: ChangeRequestOptions | undefined,
  mermaid: (c: DiagramContext) => string,
): string | null {
  return (options?.includeDiagram ?? true) ? mermaid(ctx) : null;
}

/**
 * The scope a permission is granted at, written for a ticket reader rather than
 * as an ARM resource id. Graph permissions are tenant-wide by nature; RBAC
 * scopes resolve to the concrete subscription or resource group so the approver
 * can act without looking anything up.
 */
function permissionScope(permission: AppPermission, n: ResolvedNames): string {
  if (permission.scopeLevel === "tenant") {
    return "tenant-wide (consented on the app registration)";
  }
  return permission.scopeLevel === "subscription"
    ? subscriptionScope(n)
    : resourceGroupScope(n);
}

/**
 * One permission rendered as a block: what it is, what needs it, why, and what
 * an approver gives up by refusing it.
 *
 * The "If not granted" line is the point of the whole format. An approver who
 * can grant some of this and not the rest would otherwise have to guess at the
 * cost of each refusal, and a list that hides the cost invites a blanket no.
 */
function permissionBlock(permission: AppPermission, n: ResolvedNames): string {
  const lines: string[] = [
    "- " + permission.name + "  [" + permission.necessity + "]",
    "    Scope:          " + permissionScope(permission, n),
    "    Needed for:     " + permission.feature,
    "    Why:            " + permission.justification,
    "    If not granted: " + permission.withoutIt,
  ];
  if (permission.condition !== undefined) {
    lines.push("    Condition:      " + permission.condition);
  }
  if (permission.assignViaPortal === true) {
    // Both systems have a portal step, but they are entirely different portals
    // and different blades. One generic "use the portal" line would send a
    // Graph approver hunting through RBAC, which is precisely the confusion
    // this ticket's two-section split exists to prevent.
    lines.push(
      "    Where:          " +
        (permission.kind === "graph-api"
          ? "Entra ID > App registrations > this app > API permissions > Grant admin consent."
          : permission.condition !== undefined
            ? "Azure portal, not the CLI - the condition above cannot be set from the CLI."
            : "Azure portal."),
    );
  }
  return lines.join("\n");
}

/**
 * Request that another team create an Entra app registration (single-tenant,
 * daemon confidential client - no redirect URI, no interactive sign-in), create
 * a client secret, securely share the credentials, AND grant every permission
 * the app needs to be fully functional. Embeds the authentication flow so the
 * reviewer sees why the app needs an ARM identity.
 *
 * THE PERMISSIONS ARE THE POINT. This ticket used to ask only for the
 * registration and the secret, which produced an app that could authenticate
 * and do nothing else - the operator then met each missing permission one
 * failed request at a time, and needed a fresh ticket for each. The full plan
 * comes from {@link appPermissionPlan}, so the ticket cannot fall behind what
 * the app actually calls.
 *
 * The two permission systems render as SEPARATE sections because they are
 * usually granted by different people: Graph application permissions by an
 * Entra administrator on the registration itself, RBAC roles by whoever owns
 * the subscription or resource group.
 */
export function appRegistrationRequest(
  ctx: ChangeRequestContext,
  options?: ChangeRequestOptions,
): string {
  const n = resolveNames(ctx);
  const plan = appPermissionPlan(ctx.config.setupPath);
  const graph = graphPermissions(plan);
  const rbac = rbacPermissions(plan);

  const parts: string[] = [
    "Change request: create Entra app registration for " + n.appName,
    requestHeader(n),
    section(
      "What is requested",
      [
        "1. Create a single-tenant Entra app registration (daemon / confidential",
        "   client): sign-in audience this directory only, no redirect URI, no",
        "   interactive user sign-in.",
        "2. Create a client secret on that app registration.",
        "3. Grant the Microsoft Graph API permissions listed below and ADMIN-CONSENT",
        "   them.",
        "4. Assign the Azure RBAC roles listed below to this app's service principal.",
        "5. Securely share the tenant id, application (client) id, and the client",
        "   secret with the requester (use a secrets manager or vault, not email or",
        "   chat).",
        "",
        "Steps 3 and 4 are usually different approvers. Every permission below says",
        "what needs it and what stops working without it, so each can be granted or",
        "refused on its own - a partial grant leaves a working app with fewer",
        "features, never a broken one.",
      ].join("\n"),
    ),
    section(
      "Justification",
      [
        n.appName +
          " authenticates to Azure Resource Manager as a confidential client",
        "using the OAuth2 client_credentials grant to deploy Data Collection Rules",
        "and read Microsoft Sentinel content. It runs headless (no interactive user",
        "sign-in), so it needs its own app registration and client secret rather",
        "than delegated user permissions.",
      ].join("\n"),
    ),
  ];

  if (graph.length > 0) {
    parts.push(
      section(
        "Microsoft Graph API permissions (admin consent required)",
        [
          "Add these as APPLICATION permissions - not delegated, because the app runs",
          "with no signed-in user - then grant admin consent. Until consent is",
          "granted the permission is listed on the registration but has no effect.",
          "",
          ...graph.map((permission) => permissionBlock(permission, n)),
        ].join("\n"),
      ),
    );
  }

  parts.push(
    section(
      "Azure RBAC roles (setup path: " + ctx.config.setupPath + ")",
      [
        "Assign each role to the service principal for " +
          n.appName +
          " (client id:",
        n.clientId + ") at the scope given.",
        "",
        "[core] roles are what this setup path needs to function at all. [feature]",
        "roles each unlock one named capability and can be refused independently.",
        "",
        ...rbac.map((permission) => permissionBlock(permission, n)),
      ].join("\n"),
    ),
    section(
      "Specifics",
      [
        "App registration name:   " + n.appName,
        "Sign-in audience:        single tenant (this directory only)",
        "Redirect URI:            none (daemon / confidential client)",
        "Credential:              client secret",
        "Tenant id:               " + n.tenantId,
        "Application (client) id: " + n.clientId + " (if already created)",
        "Setup path:              " + ctx.config.setupPath,
        "Subscription:            " + n.subscriptionId,
        "Resource group:          " + n.resourceGroup,
      ].join("\n"),
    ),
  );

  const diagram = diagramFor(ctx, options, authFlowMermaid);
  if (diagram !== null) {
    parts.push(section("Why (authentication flow)", diagram));
  }
  return parts.join("\n\n");
}

/**
 * Request the RBAC role assignments the context's setup path requires (see
 * {@link rolesForSetupPath}), naming the service principal by client id and
 * listing each scope with a one-line justification per role. Embeds the DCR
 * deploy and data export flows as the "why".
 */
export function roleAssignmentRequest(
  ctx: ChangeRequestContext,
  options?: ChangeRequestOptions,
): string {
  const n = resolveNames(ctx);
  const roles = rolesForSetupPath(ctx.config.setupPath, n);

  const requested: string[] = [
    "Assign the following roles to the service principal for " +
      n.appName +
      " (client id: " +
      n.clientId +
      "):",
  ];
  for (const r of roles) {
    requested.push("- " + r.role + " at " + r.scope);
    if (r.condition !== undefined) {
      requested.push("    Condition: " + r.condition);
    }
  }

  const justifications = roles.map(
    (r) => "- " + r.role + " (" + r.scope + "): " + r.justification,
  );

  const parts: string[] = [
    "Change request: assign Azure RBAC roles for " +
      n.appName +
      " (setup path: " +
      ctx.config.setupPath +
      ")",
    requestHeader(n),
    section("What is requested", requested.join("\n")),
    section("Justification", justifications.join("\n")),
    section(
      "Specifics",
      [
        "Service principal (client id): " + n.clientId,
        "Tenant id:                     " + n.tenantId,
        "Setup path:                    " + ctx.config.setupPath,
        "Subscription:                  " + n.subscriptionId,
        "Resource group:                " + n.resourceGroup,
      ].join("\n"),
    ),
  ];

  const deploy = diagramFor(ctx, options, dcrDeployFlowMermaid);
  const exported = diagramFor(ctx, options, dataExportFlowMermaid);
  if (deploy !== null && exported !== null) {
    parts.push(
      section("Why (deploy and ingestion flows)", deploy + "\n\n" + exported),
    );
  }
  return parts.join("\n\n");
}

/**
 * Request creation of resources the app needs but the requester may lack rights
 * to create: for the lab-new-rg path a resource group with a MANDATORY TTL
 * auto-delete, and an Event Hub namespace for the diagnostic-settings export
 * path. Embeds the data export flow.
 */
export function resourceCreationRequest(
  ctx: ChangeRequestContext,
  options?: ChangeRequestOptions,
): string {
  const n = resolveNames(ctx);

  const requested: string[] = [];
  if (ctx.config.setupPath === "lab-new-rg") {
    requested.push(
      "- Create a lab resource group named " +
        n.resourceGroup +
        " in subscription",
      "  " + n.subscriptionId + ", with a MANDATORY time-to-live (TTL)",
      "  auto-delete so the lab resource group self-destructs and does not",
      "  linger as orphaned cost.",
    );
  }
  requested.push(
    "- Create an Event Hub namespace in resource group " + n.resourceGroup,
    "  (subscription " + n.subscriptionId + ") to receive Azure",
    "  diagnostic-settings streams for the data export path.",
  );

  const parts: string[] = [
    "Change request: create Azure resources for " + n.appName,
    requestHeader(n),
    section("What is requested", requested.join("\n")),
    section(
      "Justification",
      [
        n.appName +
          " needs these resources to run but the requester may lack rights",
        "to create them directly. A lab resource group carries a mandatory TTL so",
        "it auto-deletes and never becomes orphaned cost. The Event Hub namespace",
        "is the ingestion point for Azure diagnostic settings before Cribl Stream",
        "reduces and forwards the data to Microsoft Sentinel.",
      ].join("\n"),
    ),
    section(
      "Specifics",
      [
        "Subscription:   " + n.subscriptionId,
        "Resource group: " + n.resourceGroup,
        "Setup path:     " + ctx.config.setupPath,
      ].join("\n"),
    ),
  ];

  const diagram = diagramFor(ctx, options, dataExportFlowMermaid);
  if (diagram !== null) {
    parts.push(section("Why (data export flow)", diagram));
  }
  return parts.join("\n\n");
}
