/**
 * TEST SUPPORT ONLY (not exported from the ui barrel): a path-routed ARM stub
 * for the Azure Logging Map screen pins, and the real map it produces through
 * core's readLoggingMap. Every id below is synthetic.
 *
 * The tenant:
 *
 *   Tenant Root Group (TENANT)
 *     mg-alpha
 *       mg-beta
 *         sub B
 *       sub A
 *       sub C
 *
 * Assignments:
 * - Cribl-AL-Alpha at mg-alpha: the legacy AllLogs initiative with the
 *   legacy identity (user-assigned, principal P_LEGACY). Ours, legacy-strong.
 * - Platform-Diag at mg-alpha: another owner's DINE diagnosticSettings to an
 *   Event Hub, system-assigned identity (principal P_PLATFORM), notScopes
 *   [sub C]. Shown (logging-related).
 * - Audit-Tags at sub A: another owner's Audit policy. Hidden by default.
 *
 * Options turn individual reads into refusals.
 */

import { readLoggingMap, type AzureManagement, type PortHttpResponse, type ReadLoggingMapResult } from "@soc/core";

export const TENANT = "11111111-2222-3333-4444-555555555555";
const MG = "/providers/Microsoft.Management/managementGroups";
export const ROOT_ID = `${MG}/${TENANT}`;
export const MG_ALPHA = `${MG}/mg-alpha`;
export const MG_BETA = `${MG}/mg-beta`;
export const SUB_A = "/subscriptions/aaaaaaaa-0000-0000-0000-000000000001";
export const SUB_B = "/subscriptions/bbbbbbbb-0000-0000-0000-000000000002";
export const SUB_C = "/subscriptions/cccccccc-0000-0000-0000-000000000003";
export const P_LEGACY = "90000000-0000-0000-0000-00000000000a";
export const P_PLATFORM = "90000000-0000-0000-0000-00000000000b";
const AUTHZ = "/providers/Microsoft.Authorization";
export const LEGACY_ASSIGNMENT_ID = `${MG_ALPHA}${AUTHZ}/policyAssignments/Cribl-AL-Alpha`;
export const PLATFORM_ASSIGNMENT_ID = `${MG_ALPHA}${AUTHZ}/policyAssignments/Platform-Diag`;
export const AUDIT_ASSIGNMENT_ID = `${SUB_A}${AUTHZ}/policyAssignments/Audit-Tags`;
const PLATFORM_DEF = `${MG_ALPHA}${AUTHZ}/policyDefinitions/platform-diag-def`;
const AUDIT_DEF = `${SUB_A}${AUTHZ}/policyDefinitions/audit-tags-def`;
const ROLE_MON = `${AUTHZ}/roleDefinitions/3913510d-42f4-4e42-8a64-420c390055eb`;
const ROLE_READER = `${AUTHZ}/roleDefinitions/acdd72a7-3385-48ef-bd42-f606fba81ae7`;

export interface FixtureOptions {
  /** The Tenant Root descendants read answers 403. */
  readonly rootRefused?: boolean;
  /** Scope ids whose policyAssignments read answers 403. */
  readonly assignmentsRefused?: readonly string[];
  /** Scope ids whose policyExemptions read answers 403. */
  readonly exemptionsRefused?: readonly string[];
  /** Every role-assignment read answers 403. */
  readonly rolesRefused?: boolean;
  /**
   * Add Sub-Diag, another owner's logging assignment SET AT sub A: with
   * resourceSelectors (eastus) or with a resource-group notScope beneath sub A.
   */
  readonly subAssignment?: "selectors" | "rg-notscope";
  /** Hold every response until `release()`. */
  readonly hold?: boolean;
}

const ok = (body: unknown): PortHttpResponse => ({ ok: true, status: 200, body }) as unknown as PortHttpResponse;
const forbidden = (): PortHttpResponse =>
  ({
    ok: false,
    status: 403,
    body: { error: { code: "AuthorizationFailed", message: "The client does not have authorization." } },
  }) as unknown as PortHttpResponse;

function mgRow(id: string, name: string, displayName: string, parent: string) {
  return { id, name, type: "Microsoft.Management/managementGroups", properties: { displayName, parent: { id: parent } } };
}

function subRow(id: string, displayName: string, parent: string) {
  return {
    id,
    name: id.split("/").pop(),
    type: "Microsoft.Management/managementGroups/subscriptions",
    properties: { displayName, parent: { id: parent } },
  };
}

const LEGACY = {
  id: LEGACY_ASSIGNMENT_ID,
  name: "Cribl-AL-Alpha",
  identity: {
    type: "UserAssigned",
    userAssignedIdentities: {
      [`${SUB_A}/resourceGroups/rg-cribl/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cribl-diag-policy-identity`]: {
        principalId: P_LEGACY,
      },
    },
  },
  properties: {
    displayName: "Cribl-AL-Alpha",
    scope: MG_ALPHA,
    policyDefinitionId: `${AUTHZ}/policySetDefinitions/85175a36-2f12-419a-96b4-18d5b0096531`,
    parameters: { eventHubAuthorizationRuleId: { value: "/x/authorizationRules/send" } },
    metadata: { createdBy: "someone" },
  },
};

const PLATFORM = {
  id: PLATFORM_ASSIGNMENT_ID,
  name: "Platform-Diag",
  identity: { type: "SystemAssigned", principalId: P_PLATFORM },
  properties: {
    displayName: "Platform-Diag",
    scope: MG_ALPHA,
    policyDefinitionId: PLATFORM_DEF,
    notScopes: [SUB_C],
    parameters: { eventHubAuthorizationRuleId: { value: "/y/authorizationRules/send" } },
  },
};

const AUDIT = {
  id: AUDIT_ASSIGNMENT_ID,
  name: "Audit-Tags",
  properties: { displayName: "Audit-Tags", scope: SUB_A, policyDefinitionId: AUDIT_DEF },
};

export const SUB_DIAG_ASSIGNMENT_ID = `${SUB_A}${AUTHZ}/policyAssignments/Sub-Diag`;

function subDiag(kind: "selectors" | "rg-notscope") {
  return {
    id: SUB_DIAG_ASSIGNMENT_ID,
    name: "Sub-Diag",
    properties: {
      displayName: "Sub-Diag",
      scope: SUB_A,
      policyDefinitionId: PLATFORM_DEF,
      parameters: { eventHubAuthorizationRuleId: { value: "/z/authorizationRules/send" } },
      ...(kind === "selectors"
        ? { resourceSelectors: [{ name: "east", selectors: [{ kind: "resourceLocation", in: ["eastus"] }] }] }
        : { notScopes: [`${SUB_A}/resourceGroups/rg-skip`] }),
    },
  };
}

/** What each scope's atScope() read returns: set there plus inherited from above. */
const ASSIGNMENTS_AT: Readonly<Record<string, readonly unknown[]>> = {
  [ROOT_ID.toLowerCase()]: [],
  [MG_ALPHA.toLowerCase()]: [LEGACY, PLATFORM],
  [MG_BETA.toLowerCase()]: [LEGACY, PLATFORM],
  [SUB_A.toLowerCase()]: [LEGACY, PLATFORM, AUDIT],
  [SUB_B.toLowerCase()]: [LEGACY, PLATFORM],
  [SUB_C.toLowerCase()]: [LEGACY],
};

function definitionBody(path: string): unknown {
  if (path.toLowerCase() === PLATFORM_DEF.toLowerCase()) {
    return {
      id: PLATFORM_DEF,
      name: "platform-diag-def",
      properties: {
        displayName: "Platform diagnostics",
        policyType: "Custom",
        parameters: { eventHubAuthorizationRuleId: { type: "String" } },
        policyRule: { then: { effect: "DeployIfNotExists", details: { type: "Microsoft.Insights/diagnosticSettings" } } },
      },
    };
  }
  return {
    id: AUDIT_DEF,
    name: "audit-tags-def",
    properties: { displayName: "Audit tags", policyType: "Custom", policyRule: { then: { effect: "audit" } } },
  };
}

function route(path: string, query: Record<string, string> | undefined, opts: FixtureOptions): PortHttpResponse {
  const p = path.toLowerCase();
  if (p.endsWith("/descendants")) {
    const root = p === `${ROOT_ID}/descendants`.toLowerCase();
    if (root && opts.rootRefused === true) return forbidden();
    return ok({
      value: [
        ...(root ? [mgRow(MG_ALPHA, "mg-alpha", "Alpha", ROOT_ID)] : []),
        mgRow(MG_BETA, "mg-beta", "Beta", MG_ALPHA),
        subRow(SUB_A, "Sub A", MG_ALPHA),
        subRow(SUB_B, "Sub B", MG_BETA),
        subRow(SUB_C, "Sub C", MG_ALPHA),
      ],
    });
  }
  if (p === MG.toLowerCase()) {
    return ok({ value: [mgRow(MG_ALPHA, "mg-alpha", "Alpha", ROOT_ID), mgRow(MG_BETA, "mg-beta", "Beta", MG_ALPHA)] });
  }
  if (p.startsWith(MG.toLowerCase()) && !p.includes("/providers/microsoft.authorization/")) {
    const name = p.split("/").pop() ?? "";
    const parent = name === "mg-beta" ? MG_ALPHA : ROOT_ID;
    return ok({
      id: `${MG}/${name}`,
      name,
      properties: { displayName: name === "mg-beta" ? "Beta" : "Alpha", details: { parent: { id: parent } } },
    });
  }
  if (p === "/subscriptions") {
    return ok({
      value: [
        { id: SUB_A, subscriptionId: SUB_A.split("/").pop(), displayName: "Sub A", state: "Enabled" },
        { id: SUB_B, subscriptionId: SUB_B.split("/").pop(), displayName: "Sub B", state: "Enabled" },
        { id: SUB_C, subscriptionId: SUB_C.split("/").pop(), displayName: "Sub C", state: "Enabled" },
      ],
    });
  }
  const scope = p.split("/providers/microsoft.authorization/")[0] ?? "";
  if (p.endsWith("/providers/microsoft.authorization/policyassignments")) {
    if ((opts.assignmentsRefused ?? []).some((s) => s.toLowerCase() === scope)) return forbidden();
    const extra = opts.subAssignment !== undefined && scope === SUB_A.toLowerCase() ? [subDiag(opts.subAssignment)] : [];
    return ok({ value: [...(ASSIGNMENTS_AT[scope] ?? []), ...extra] });
  }
  if (p.endsWith("/providers/microsoft.authorization/policyexemptions")) {
    if ((opts.exemptionsRefused ?? []).some((s) => s.toLowerCase() === scope)) return forbidden();
    return ok({ value: [] });
  }
  if (p.endsWith("/providers/microsoft.authorization/roleassignments")) {
    if (opts.rolesRefused === true) return forbidden();
    const filter = query?.["$filter"] ?? "";
    if (filter.includes(P_PLATFORM)) {
      return ok({
        value: [
          { properties: { scope: MG_ALPHA, roleDefinitionId: ROLE_MON } },
          { properties: { scope: SUB_B, roleDefinitionId: ROLE_READER } },
        ],
      });
    }
    return ok({ value: [{ properties: { scope: MG_ALPHA, roleDefinitionId: ROLE_MON } }] });
  }
  if (p.includes("/roledefinitions/")) {
    const isMon = p.endsWith(ROLE_MON.split("/").pop() ?? "");
    return ok({ id: path, properties: { roleName: isMon ? "Monitoring Contributor" : "Reader" } });
  }
  if (p.includes("/policydefinitions/") || p.includes("/policysetdefinitions/")) return ok(definitionBody(path));
  return { ok: false, status: 404, body: { error: { code: "NotFound", message: path } } } as unknown as PortHttpResponse;
}

export interface FixtureAzure {
  readonly port: AzureManagement;
  readonly calls: string[];
  /** Release every held response (hold mode). */
  release(): void;
}

export function makeFixtureAzure(opts: FixtureOptions = {}): FixtureAzure {
  const calls: string[] = [];
  const pending: (() => void)[] = [];
  return {
    calls,
    release() {
      for (const r of pending.splice(0, pending.length)) r();
    },
    port: {
      async request(req) {
        calls.push(req.path);
        if (opts.hold === true) await new Promise<void>((resolve) => pending.push(resolve));
        return route(req.path, req.query, opts);
      },
    },
  };
}

/** The real map core builds from the stub (no pacing). */
export async function fixtureResult(opts: FixtureOptions = {}): Promise<ReadLoggingMapResult> {
  return readLoggingMap({ azure: makeFixtureAzure(opts).port, tenantId: TENANT, now: "2030-01-01T00:00:00Z" });
}
