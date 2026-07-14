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
 * Any blank context field renders as a clear placeholder (for example
 * `<tenant id>`), so a partially filled request is visibly incomplete.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto. Output is
 * deterministic and suitable for pasting into a ticket or email.
 */

import type { AzureConfig, AzureSetupPath } from "../azure-config";
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
 * Request that another team create an Entra app registration (single-tenant,
 * daemon confidential client - no redirect URI, no interactive sign-in), create
 * a client secret, and securely share the tenant id, client id, and secret.
 * Embeds the authentication flow so the reviewer sees why the app needs an ARM
 * identity.
 */
export function appRegistrationRequest(
  ctx: ChangeRequestContext,
  options?: ChangeRequestOptions,
): string {
  const n = resolveNames(ctx);
  const parts: string[] = [
    "Change request: create Entra app registration for " + n.appName,
    requestHeader(n),
    section(
      "What is requested",
      [
        "- Create a single-tenant Entra app registration (daemon / confidential",
        "  client): sign-in audience this directory only, no redirect URI, no",
        "  interactive user sign-in.",
        "- Create a client secret on that app registration.",
        "- Securely share the tenant id, application (client) id, and the client",
        "  secret with the requester (use a secrets manager or vault, not email or",
        "  chat).",
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
    section(
      "Specifics",
      [
        "App registration name:   " + n.appName,
        "Sign-in audience:        single tenant (this directory only)",
        "Redirect URI:            none (daemon / confidential client)",
        "Credential:              client secret",
        "Tenant id:               " + n.tenantId,
        "Application (client) id: " + n.clientId + " (if already created)",
      ].join("\n"),
    ),
  ];
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
