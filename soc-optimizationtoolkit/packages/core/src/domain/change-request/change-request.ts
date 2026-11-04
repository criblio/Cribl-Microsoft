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
 * Both permission tickets read ONE plan, {@link appPermissionPlan}: the setup
 * path's own roles (role-plan, the same model the az-CLI script uses) plus the
 * feature roles no setup path grants, whose names come from the least-privilege
 * registry (AZR-61). {@link roleAssignmentRequest} lists the plan's RBAC half
 * for the subscription owner - the path's roles first, exactly as the wizard
 * would self-assign them, then the feature roles tagged `[feature]`.
 * {@link appRegistrationRequest} adds the Graph permission, because it is the
 * ticket sent before anything works. Neither restates a role.
 *
 * The role ticket used to carry the path's roles only (AZR-61 audit, medium):
 * Setup offers only that ticket to the subscription owner, so the feature gaps
 * the preflight reported were gaps no ticket the owner saw asked to close.
 *
 * ONE TICKET IS ONE TENANT'S. Every generator reads one config, and the
 * app-registration ticket names that config's tenant in its title, its steps,
 * its Graph consent and its hand-back. Several tenants are several tickets
 * (tenant-requests.ts, AZR-62, ADR 0009 decision 1), built on this generator
 * rather than beside it.
 *
 * Any blank context field renders as a clear placeholder (for example
 * `<tenant id>`), so a partially filled request is visibly incomplete.
 *
 * Pure: no IO, no fetch, no React, no Date / Math.random / crypto. Output is
 * deterministic and suitable for pasting into a ticket or email.
 */

import type { AzureConfig, AzureSetupPath } from "../azure-config";
import { appPermissionPlan, graphPermissions, rbacPermissions } from "../app-permissions";
import {
  effectiveSetupPath,
  requestedPermissions,
  requestedRoleNames,
} from "../azure-connectivity";
import type { AppPermission } from "../app-permissions";
import type { PermissionNecessity } from "../azure-permissions";
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
  /** The fully-qualified scope the role is assigned at, or the resource in words. */
  scope: string;
  /** One-line justification for this specific role. */
  justification: string;
  /** Optional assignment condition (the lab paths' RBAC Administrator, the DCR grant). */
  condition?: string;
  /** `feature` roles are tagged in the ticket; the path's own roles are not. */
  necessity: PermissionNecessity;
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
 * The RBAC roles to request for a setup path, resolved into request rows for a
 * ticket: the RBAC half of {@link appPermissionPlan}, in plan order (the path's
 * own roles, then the feature roles it does not already cover). This function
 * only turns each abstract scope into the concrete scope for the resolved
 * context. The path's own roles come from rolePlanForSetupPath, the plan the
 * setup wizard's az-CLI script renders, so those two cannot drift; the feature
 * roles (AZR-61) are asked for here only - the script grants what the setup
 * path needs, not the optional features (architecture audit 2026-11-04).
 */
function rolesForSetupPath(
  path: AzureSetupPath,
  n: ResolvedNames,
  onlyRoles: readonly string[],
): RoleRequest[] {
  // The registry plan (AZR-61), kept to the roles the connectivity choice
  // ticked (DBT-246).
  return rbacPermissions(appPermissionPlan(path))
    .filter((permission) => onlyRoles.includes(permission.name))
    .map((permission) => {
      const request: RoleRequest = {
        role: permission.name,
        scope: permissionScope(permission, n),
        justification: permission.justification,
        necessity: permission.necessity,
      };
      if (permission.condition !== undefined) {
        request.condition = permission.condition;
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
  if (permission.scopeLevel === "resource") {
    // A resource the config does not name (an Event Hub namespace may sit in
    // any resource group), so the ticket says which, in words.
    return permission.resource ?? "<resource>";
  }
  if (permission.scopeLevel === "subscription") {
    return subscriptionScope(n);
  }
  // A group the operator may choose elsewhere (the Defender export's): the
  // configured one is the default, and the caveat says the role follows the choice.
  return permission.scopeCaveat === undefined
    ? resourceGroupScope(n)
    : resourceGroupScope(n) + " (" + permission.scopeCaveat + ")";
}

/** Column the permission-block values start at, and the wrap width. */
const FIELD_INDENT = 20;
const WRAP_COLUMNS = 78;

/**
 * A labelled field, hard-wrapped with a hanging indent so continuation lines
 * stay under the value rather than falling back to column 0.
 *
 * Hard-wrapped rather than left to the reader's renderer because this text is
 * pasted into ticketing systems that do not reflow, and because the rest of the
 * ticket is already wrapped - a block of 300-character lines beside it reads as
 * a rendering bug. Words longer than the available width (a resource id, say)
 * are left to overhang rather than broken, since a split id is worse than a
 * long line.
 */
function field(label: string, value: string): string {
  const head = ("    " + label).padEnd(FIELD_INDENT, " ");
  const width = WRAP_COLUMNS - FIELD_INDENT;
  const lines: string[] = [];
  let current = "";
  // A placeholder such as `<resource group>` is one word: split at its space
  // and no line holds it whole, which a Markdown renderer then reads as an HTML
  // tag spanning the break, and the unknown value vanishes (AZR-62).
  for (const word of value.match(/(?:<[a-z][a-z ]*>|[^\s<]|<)+/g) ?? [""]) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines
    .map(
      (line, index) => (index === 0 ? head : " ".repeat(FIELD_INDENT)) + line,
    )
    .join("\n");
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
    field("Scope:", permissionScope(permission, n)),
    field("Needed for:", permission.feature),
    field("Why:", permission.justification),
    field("If not granted:", permission.withoutIt),
  ];
  if (permission.condition !== undefined) {
    lines.push(field("Condition:", permission.condition));
  }
  if (permission.assignViaPortal === true) {
    // Both systems have a portal step, but they are entirely different portals
    // and different blades. One generic "use the portal" line would send a
    // Graph approver hunting through RBAC, which is precisely the confusion
    // this ticket's two-section split exists to prevent.
    lines.push(
      field(
        "Where:",
        permission.kind === "graph-api"
          ? "Entra ID > App registrations > this app > API permissions > Grant admin consent."
          : permission.condition !== undefined
            ? "Azure portal, not the CLI - the condition above cannot be set from the CLI."
            : "Azure portal.",
      ),
    );
  }
  return lines.join("\n");
}

/**
 * The app-registration Justification, describing only what the requested
 * entries enable. Full connectivity keeps its original wording byte-for-byte;
 * a narrower request names the features its entries unlock, so a Reader-only
 * ticket never claims the app deploys Data Collection Rules.
 */
function registrationJustification(
  n: ResolvedNames,
  connectivity: AzureConfig["connectivity"],
  plan: readonly AppPermission[],
): string {
  if (connectivity === "full") {
    return [
      n.appName +
        " authenticates to Azure Resource Manager as a confidential client",
      "using the OAuth2 client_credentials grant to deploy Data Collection Rules",
      "and read Microsoft Sentinel content. It runs headless (no interactive user",
      "sign-in), so it needs its own app registration and client secret rather",
      "than delegated user permissions.",
    ].join("\n");
  }
  const intro = [
    n.appName + " authenticates to Azure Resource Manager as a confidential",
    "client using the OAuth2 client_credentials grant.",
  ];
  const headless = [
    "It runs headless (no interactive user sign-in), so it needs its own app",
    "registration and client secret rather than delegated user permissions.",
  ];
  if (plan.length === 0) {
    return [
      ...intro,
      "It is requested with no Azure permissions, so it can authenticate but",
      "reads nothing from Azure until some are granted.",
      ...headless,
    ].join("\n");
  }
  const features = [...new Set(plan.map((p) => p.feature))];
  return [
    ...intro,
    "The permissions requested below are used only for:",
    ...features.map((f) => "- " + f),
    ...headless,
  ].join("\n");
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
  const { connectivity, allowedPermissions } = ctx.config;
  const plan = requestedPermissions(
    connectivity,
    allowedPermissions,
    ctx.config.setupPath,
  );
  const graph = graphPermissions(plan);
  const rbac = rbacPermissions(plan);
  // A partial request always names the "existing" path, so a saved lab path
  // never reads as a request for lab roles.
  const setupPath = effectiveSetupPath(connectivity, ctx.config.setupPath);

  // Numbered from what is actually asked for, so a request with no Graph
  // permissions or no roles does not point at a section that is not there.
  const steps: string[][] = [
    [
      "Create a single-tenant Entra app registration (daemon / confidential",
      "   client) in tenant " + n.tenantId + ".",
      "   Sign-in audience this directory only, no redirect URI, no interactive",
      "   user sign-in.",
    ],
    ["Create a client secret on that app registration."],
  ];
  if (graph.length > 0) {
    steps.push([
      "Grant the Microsoft Graph API permissions listed below and ADMIN-CONSENT",
      "   them.",
    ]);
  }
  if (rbac.length > 0) {
    steps.push([
      "Assign the Azure RBAC roles listed below to this app's service principal.",
    ]);
  }
  steps.push([
    "Securely share the tenant id, application (client) id, and the client",
    "   secret with the requester (use a secrets manager or vault, not email or",
    "   chat) - see Hand back below.",
  ]);
  const requestedLines = steps.flatMap((lines, index) =>
    lines.map((line, i) => (i === 0 ? String(index + 1) + ". " + line : line)),
  );
  const closing: string[] = [];
  if (graph.length > 0 && rbac.length > 0) {
    closing.push(
      "",
      "Steps 3 and 4 are usually different approvers. Every permission below says",
      "what needs it and what stops working without it, so each can be granted or",
      "refused on its own - a partial grant leaves a working app with fewer",
      "features, never a broken one.",
    );
  } else if (graph.length === 0 && rbac.length === 0) {
    closing.push(
      "",
      "The app is being asked for with no roles and no Graph permissions: it can",
      "authenticate but reads nothing from Azure until some are granted.",
    );
  }
  // Everything is per tenant (AZR-62): a registration and its grants in one
  // tenant reach no other, so each tenant gets its own request.
  closing.push(
    "",
    "Everything here is for this one tenant. A registration, its consent and its",
    "role assignments in one tenant grant nothing in any other, so each tenant",
    "gets its own request.",
  );

  // Core and feature roles are separate sections (AZR-62): an approver who
  // grants only what the app cannot work without reads one section and stops.
  const coreRoles = rbac.filter((permission) => permission.necessity === "core");
  const featureRoles = rbac.filter((permission) => permission.necessity === "feature");
  const rbacHeading = "Azure RBAC roles (setup path: " + setupPath + ")";

  const parts: string[] = [
    "Change request: create Entra app registration for " +
      n.appName +
      " in tenant " +
      n.tenantId,
    requestHeader(n),
    section("What is requested", [...requestedLines, ...closing].join("\n")),
    section("Justification", registrationJustification(n, connectivity, plan)),
  ];

  if (graph.length > 0) {
    parts.push(
      section(
        "Microsoft Graph API permissions (admin consent required)",
        [
          "Add these as APPLICATION permissions - not delegated, because the app runs",
          "with no signed-in user - then grant admin consent in tenant",
          n.tenantId + ".",
          "Until consent is granted the permission is listed on the registration but",
          "has no effect.",
          "",
          ...graph.map((permission) => permissionBlock(permission, n)),
        ].join("\n"),
      ),
    );
  }

  // A section with no roles is not printed (DBT-246: the request numbers and
  // names only what it actually asks for).
  if (coreRoles.length > 0) {
    parts.push(
      section(
        rbacHeading + " - core",
        [
          "Assign each role to the service principal for " +
            n.appName +
            " (client id:",
          n.clientId + ") at the scope given.",
          "",
          "[core] roles are what this setup path needs to function at all.",
          "",
          ...coreRoles.map((permission) => permissionBlock(permission, n)),
        ].join("\n"),
      ),
    );
  }
  if (featureRoles.length > 0) {
    parts.push(
      section(
        rbacHeading + " - feature",
        [
          "Assign these to the same service principal. [feature] roles each unlock",
          "one named capability and can be refused independently.",
          "",
          ...featureRoles.map((permission) => permissionBlock(permission, n)),
        ].join("\n"),
      ),
    );
  }

  parts.push(
    section(
      "Hand back (tenant " + n.tenantId + ")",
      [
        "Return these values to the requester through a secrets manager or vault -",
        "never email or chat:",
        "",
        "Tenant id:               " + n.tenantId,
        "Application (client) id: " + n.clientId,
        "Client secret:           the secret VALUE from step 2 (not its secret id)",
        "Secret expiry:           the expiry date chosen in step 2",
        "",
        "The requester enters them into the connection for this tenant. The secret",
        "is stored encrypted and write-only, and is never displayed again.",
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
        "Setup path:              " + setupPath,
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
  const { connectivity, allowedPermissions } = ctx.config;
  // Only the roles the connectivity choice requests: full is the whole
  // setup-path plan (unchanged), partial is the ticked subset of the "existing"
  // plan, so neither a saved lab path nor an unticked role reaches the ticket.
  const setupPath = effectiveSetupPath(connectivity, ctx.config.setupPath);
  const roles = rolesForSetupPath(
    setupPath,
    n,
    requestedRoleNames(connectivity, allowedPermissions, ctx.config.setupPath),
  );

  const requested: string[] = [
    "Assign the following roles to the service principal for " +
      n.appName +
      " (client id: " +
      n.clientId +
      "):",
  ];
  for (const r of roles) {
    requested.push(
      "- " + r.role + " at " + r.scope + (r.necessity === "feature" ? "  [feature]" : ""),
    );
    if (r.condition !== undefined) {
      requested.push("    Condition: " + r.condition);
    }
  }
  if (roles.length === 0) {
    requested.push("- No roles are requested under the saved connectivity choice.");
  } else if (roles.some((r) => r.necessity === "feature")) {
    requested.push(
      "",
      "[feature] roles each unlock one named capability and can be refused on",
      "their own; the untagged roles are what this setup path needs to work at all.",
    );
  }

  const justifications =
    roles.length === 0
      ? ["No roles are requested, so there is nothing to justify."]
      : roles.map(
          (r) => "- " + r.role + " (" + r.scope + "): " + r.justification,
        );

  const parts: string[] = [
    "Change request: assign Azure RBAC roles for " +
      n.appName +
      " (setup path: " +
      setupPath +
      ")",
    requestHeader(n),
    section("What is requested", requested.join("\n")),
    section("Justification", justifications.join("\n")),
    section(
      "Specifics",
      [
        "Service principal (client id): " + n.clientId,
        "Tenant id:                     " + n.tenantId,
        "Setup path:                    " + setupPath,
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
  const setupPath = effectiveSetupPath(
    ctx.config.connectivity,
    ctx.config.setupPath,
  );

  const requested: string[] = [];
  if (setupPath === "lab-new-rg") {
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
        "Setup path:     " + setupPath,
      ].join("\n"),
    ),
  ];

  const diagram = diagramFor(ctx, options, dataExportFlowMermaid);
  if (diagram !== null) {
    parts.push(section("Why (data export flow)", diagram));
  }
  return parts.join("\n\n");
}

/**
 * The count line beside the request button: how many roles and Graph
 * permissions the saved connectivity choice would ask for, for example
 * `"2 roles - Reader, Monitoring Contributor"`. Built from the same
 * {@link requestedPermissions} the ticket renders, so the line and the ticket
 * cannot disagree.
 */
export function requestSummary(config: AzureConfig): string {
  const plan = requestedPermissions(
    config.connectivity,
    config.allowedPermissions,
    config.setupPath,
  );
  const roles = rbacPermissions(plan);
  const graph = graphPermissions(plan);
  if (roles.length === 0 && graph.length === 0) return "nothing selected";
  const parts: string[] = [];
  if (roles.length > 0) {
    parts.push(
      String(roles.length) +
        (roles.length === 1 ? " role" : " roles") +
        " - " +
        roles.map((r) => r.name).join(", "),
    );
  }
  if (graph.length > 0) {
    parts.push(
      String(graph.length) +
        (graph.length === 1 ? " Graph permission" : " Graph permissions"),
    );
  }
  return parts.join("; ");
}
