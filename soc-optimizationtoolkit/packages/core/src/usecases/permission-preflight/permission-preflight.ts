/**
 * permission-preflight - the RBAC PREFLIGHT ORCHESTRATION usecase (porting-plan
 * Unit 9; ENG-38 delta / GUI-11). Before the guided deploy attempts any writes,
 * this composes a single {@link PermissionReport} telling the user exactly what
 * they can and cannot do on BOTH the Azure and the Cribl side, so a deploy that
 * would fail for lack of access is caught up front rather than half-applied.
 *
 * WHY THIS IS NOT THE LEGACY permission-check.ts. The legacy module
 * (IS/permission-check.ts) inferred Azure write capability from ROLE NAMES
 * (`/Owner|Contributor|Monitoring Contributor|.../i.test(role)`). That is
 * unsound - customers routinely use custom roles, and a role literally named
 * "Contributor" may be a lookalike that denies the very actions we need. This
 * usecase instead reuses the already-correct EFFECTIVE-ACTION evaluator in
 * domain/azure-permissions (evaluatePermissions over the RBAC permissions API):
 * it checks the exact set of control-plane actions the chosen setup path
 * performs, net of notActions, per Azure's additive-across / subtractive-within
 * rule. The role name never enters the deploy-readiness decision.
 *
 * TWO SIGNALS, COMBINED (Azure side):
 *   1. EFFECTIVE ACTIONS - a prediction of WRITE capability. Writes cannot be
 *      probed non-destructively, so the RBAC permissions API is the sound source
 *      for "can this caller create a DCR / a custom table / deploy a template".
 *      This is what gates {@link AzurePreflight.hasRequiredAccess}.
 *   2. LIVE EXISTENCE PROBES - no-op GETs (workspace GET, tables list, DCR
 *      list). PROBES ARE TRUTH about what is actually reachable/readable right
 *      now. They decorate the report but never, on their own, flip
 *      deploy-readiness: a Reader passes every probe yet must still read as NOT
 *      deployable, because read does not imply write (the key pin).
 *
 * CRIBL side: capability probes over the CriblClient. PROBES ARE TRUTH; the
 * Cribl role is decoration. Graceful degradation is mandatory: a probe that
 * cannot complete (non-2xx that is not an explicit 401/403, or a transport
 * failure) degrades to `unknown` and NEVER crashes the report. On the CLOUD
 * shell the probe is near-vacuous - the app runs inside the leader under the
 * approved policies.yml, so every capability reads "granted by platform"; on the
 * LOCAL shell the same probes are genuinely informative against the configured
 * leader. THE REPORT SHAPE IS IDENTICAL in both shells.
 *
 * BOTH SIDES RUN IN PARALLEL and PARTIAL RESULTS ALWAYS RENDER: one side failing
 * or slow never blanks the other. Each side runner is total (it catches its own
 * failures and returns a populated preflight), and the top-level composition
 * additionally guards each side with a fallback so an unexpected throw on one
 * side can never blank the whole report.
 *
 * The DEPLOY-READINESS boolean is named {@link PermissionReport.hasRequiredAccess}
 * deliberately - it is a PERMISSION verdict and must never be conflated with
 * integrate-arc's `canDeploy` (the UI section-gate). The two answer different
 * questions and must never collide.
 *
 * Pure orchestration over the AzureManagement + CriblClient (and optional
 * Logger) ports: zero IO of its own, no wall-clock reads, no timers.
 */

import type { AzureManagement, AzureManagementRequest } from "../../ports/azure-management";
import type { CriblClient } from "../../ports/cribl-client";
import type { Logger } from "../../ports/logger";
import {
  evaluatePermissions,
  allGranted,
  REQUIRED_ACTIONS,
} from "../../domain/azure-permissions";
import type {
  PermissionCheckResult,
  PermissionSet,
  SetupPath,
} from "../../domain/azure-permissions";
import { DIRECT_DCR_API_VERSION } from "../../domain/dcr-request";
import { WORKSPACE_API_VERSION } from "../azure-discovery";

// ---------------------------------------------------------------------------
// Constants (ARM api-versions, endpoint knowledge)
// ---------------------------------------------------------------------------

/**
 * ARM api-version for GET {scope}/providers/Microsoft.Authorization/permissions.
 * The RBAC permissions API returns one element per effective role assignment at
 * the queried scope; 2022-04-01 is the current stable version (same version the
 * roleAssignments PUT in assign-dcr-role pins).
 */
export const RBAC_PERMISSIONS_API_VERSION = "2022-04-01";

// ---------------------------------------------------------------------------
// Setup-path -> scope selection (per-SetupPath scope, checked by test)
// ---------------------------------------------------------------------------

/** The ARM scope granularity a setup path's permission check runs against. */
export type PreflightScopeKind = "subscription" | "resource-group";

/**
 * Choose the ARM scope the RBAC permissions API is queried at for a setup path.
 *
 * Discovery-only and create-new-resource-group paths are evaluated at the
 * SUBSCRIPTION scope (the actions they need - and, for lab-new-rg, the
 * roleAssignments/write it uniquely needs - are subscription-level); the
 * existing-RG and bring-your-own-RG paths are evaluated at the RESOURCE-GROUP
 * scope (their writes target one workspace resource group). This mirrors the
 * per-scope intent documented on REQUIRED_ACTIONS in domain/azure-permissions.
 */
export function scopeKindForSetupPath(setupPath: SetupPath): PreflightScopeKind {
  switch (setupPath) {
    case "existing-subscription":
    case "lab-new-rg-subscription":
      return "subscription";
    case "existing-rg":
    case "lab-byo-rg":
      return "resource-group";
  }
}

/** The Azure targeting identifiers the preflight needs to build a scope. */
export interface AzurePreflightTarget {
  /** Target subscription id (required for any Azure check). */
  subscriptionId: string;
  /** Target resource group (required for resource-group-scoped paths). */
  resourceGroup: string;
  /**
   * Target Log Analytics workspace name. When present alongside a resource
   * group, the workspace GET and tables-list existence probes run.
   */
  workspaceName: string;
}

/**
 * Build the ARM scope path for a scope kind, or `null` when the identifiers the
 * scope needs are missing (no subscription for any scope; no resource group for
 * a resource-group scope). A `null` result is what drives the not-configured
 * stub in {@link runAzurePreflight}.
 */
export function buildArmScope(
  kind: PreflightScopeKind,
  target: AzurePreflightTarget,
): string | null {
  if (target.subscriptionId === "") {
    return null;
  }
  if (kind === "subscription") {
    return `/subscriptions/${target.subscriptionId}`;
  }
  if (target.resourceGroup === "") {
    return null;
  }
  return `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}`;
}

// ---------------------------------------------------------------------------
// Checked-actions as DATA (doubles as the least-privilege custom-role def)
// ---------------------------------------------------------------------------

/**
 * The exact control-plane actions the preflight checks for a setup path, as a
 * plain string list. Exported as DATA so it can drive both the UI ("these are
 * the actions we verify") and a least-privilege custom role definition - the
 * two never drift because they read from the same REQUIRED_ACTIONS source.
 */
export function checkedAzureActions(setupPath: SetupPath): string[] {
  return REQUIRED_ACTIONS[setupPath].map((req) => req.action);
}

/** One permission block of an Azure custom role definition. */
export interface AzureRolePermission {
  actions: string[];
  notActions: string[];
  dataActions: string[];
  notDataActions: string[];
}

/**
 * An Azure custom role definition body (the shape ARM accepts under
 * Microsoft.Authorization/roleDefinitions), carrying EXACTLY the actions the
 * preflight checks for a setup path and nothing more.
 */
export interface LeastPrivilegeRoleDefinition {
  /** Stable, machine-friendly identifier for the role. */
  name: string;
  /** Human-readable role name shown in the portal. */
  roleName: string;
  /** What the role is for. */
  description: string;
  /** Scopes the role may be assigned at (defaults to the whole directory). */
  assignableScopes: string[];
  /** Exactly one permission block granting the checked actions. */
  permissions: AzureRolePermission[];
}

/**
 * Derive a least-privilege Azure custom role definition from a setup path's
 * checked actions. This is the actionable companion to a failed preflight: hand
 * the output to an Azure admin and the caller gets exactly the access the app
 * needs, no more. Purely a projection of {@link checkedAzureActions}.
 */
export function leastPrivilegeRoleDefinition(
  setupPath: SetupPath,
  assignableScopes: readonly string[] = ["/"],
): LeastPrivilegeRoleDefinition {
  return {
    name: `cribl-sentinel-preflight-${setupPath}`,
    roleName: `Cribl Sentinel Onboarding (${setupPath})`,
    description:
      "Least-privilege custom role granting exactly the control-plane actions " +
      "the Cribl-to-Sentinel onboarding preflight checks for this setup path.",
    assignableScopes: [...assignableScopes],
    permissions: [
      {
        actions: checkedAzureActions(setupPath),
        notActions: [],
        dataActions: [],
        notDataActions: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Cribl capability probe catalog (exported as data)
// ---------------------------------------------------------------------------

/** One Cribl capability the preflight probes for. */
export interface CriblCapabilitySpec {
  /** Machine key, e.g. "packs". */
  capability: string;
  /** Human-readable label, e.g. "Manage packs". */
  label: string;
  /** Group-scoped GET path used as the read-probe for the capability. */
  path: string;
  /** Whether this capability is required for a deploy (gates readiness). */
  required: boolean;
}

/**
 * The Cribl capabilities probed, in fixed priority order. `packs` and `outputs`
 * are REQUIRED for a deploy (they mirror the legacy canManagePacks &&
 * canManageOutputs gate); `inputs` and `routes` are informative. Exported as
 * DATA so the UI can render the same list the runner probes.
 */
export const CRIBL_CAPABILITY_PROBES: readonly CriblCapabilitySpec[] = [
  { capability: "packs", label: "Manage packs", path: "/packs", required: true },
  {
    capability: "outputs",
    label: "Manage destinations",
    path: "/system/outputs",
    required: true,
  },
  {
    capability: "inputs",
    label: "Manage sources",
    path: "/system/inputs",
    required: false,
  },
  { capability: "routes", label: "Manage routes", path: "/routes", required: false },
];

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

/** Outcome of one live Azure existence probe. */
export type AzureProbeStatus = "ok" | "denied" | "unknown";

/** One live no-op Azure existence probe result (probes are truth). */
export interface AzureProbeResult {
  /** Probe key, e.g. "dcr-list". */
  name: string;
  /** Human-readable label. */
  label: string;
  /** ok = 2xx; denied = explicit 401/403; unknown = anything else. */
  status: AzureProbeStatus;
  /** Short greppable detail. */
  detail: string;
}

/** The Azure half of the {@link PermissionReport}. */
export interface AzurePreflight {
  /** False when the target lacked the ids the scope needs (the stub case). */
  configured: boolean;
  /** The setup path evaluated. */
  setupPath: SetupPath;
  /** The scope granularity used. */
  scopeKind: PreflightScopeKind;
  /** The ARM scope path evaluated ('' when not configured). */
  scope: string;
  /** Whether the RBAC permissions API returned successfully. */
  permissionsFetched: boolean;
  /** Per-required-action effective-permission results (order preserved). */
  checks: PermissionCheckResult[];
  /** Live existence probes (decoration/truth; do not gate readiness alone). */
  probes: AzureProbeResult[];
  /**
   * Deploy-readiness for the Azure side: EVERY required action is effectively
   * granted AND the permissions API was actually read. Reader-only is false
   * here even though its read probes all pass - read does not imply write.
   */
  hasRequiredAccess: boolean;
  /** Raw greppable error text ('' when none). */
  error: string;
}

/** Outcome of one Cribl capability probe. */
export type CriblProbeStatus = "granted" | "denied" | "unknown";

/** One Cribl capability probe result. */
export interface CriblCapabilityProbe {
  /** Capability key, e.g. "packs". */
  capability: string;
  /** Human-readable label. */
  label: string;
  /** Whether the capability is required for a deploy. */
  required: boolean;
  /** granted = 2xx (or platform-granted on cloud); denied = 401/403; unknown otherwise. */
  status: CriblProbeStatus;
  /** Short greppable detail. */
  detail: string;
}

/** The Cribl half of the {@link PermissionReport}. */
export interface CriblPreflight {
  /** Which shell produced this - cloud probes are near-vacuous. */
  mode: CriblShellMode;
  /** The worker group / edge fleet the probes targeted ('' when none). */
  workerGroup: string;
  /** Per-capability probe results, in fixed priority order. */
  probes: CriblCapabilityProbe[];
  /** True when every REQUIRED capability probe is granted. */
  hasRequiredAccess: boolean;
  /** Raw greppable error text ('' when none). */
  error: string;
}

/** Which app shell the Cribl-side probe runs in. */
export type CriblShellMode = "cloud" | "local";

/**
 * The combined preflight report. Same SHAPE in both shells; only the Cribl-side
 * probe fidelity differs (near-vacuous on cloud, informative on local).
 */
export interface PermissionReport {
  /** Cribl-side capability report. */
  cribl: CriblPreflight;
  /** Azure-side effective-action + existence-probe report. */
  azure: AzurePreflight;
  /**
   * DEPLOY-READINESS: both sides have the required access. Named distinctly
   * from integrate-arc's `canDeploy` (the UI section-gate) on purpose - this is
   * the PERMISSION verdict and the two must never be conflated.
   */
  hasRequiredAccess: boolean;
  /** One-line summary; fixed-priority failure reasons when not ready. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** The ports the preflight orchestrates. */
export interface PermissionPreflightPorts {
  azure: AzureManagement;
  cribl: CriblClient;
  /** OPTIONAL diagnostics sink. */
  logger?: Logger;
}

/** Input to {@link runPermissionPreflight}. */
export interface PermissionPreflightInput {
  /** The setup path being checked (selects required actions AND scope). */
  setupPath: SetupPath;
  /** Azure targeting identifiers. */
  azure: AzurePreflightTarget;
  /** Cribl-side context. */
  cribl: {
    /** Which shell - cloud probes are near-vacuous. */
    mode: CriblShellMode;
    /** Worker group / edge fleet the probes target (local shell). */
    workerGroup?: string;
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Render an HTTP failure as raw, greppable error text. */
function httpErrorText(context: string, status: number, body: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(body);
  } catch {
    raw = String(body);
  }
  return `${context}: HTTP ${status} ${raw ?? ""}`.trim();
}

/** Render a thrown value as text. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read a property of an unknown value, or undefined when not an object. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** Coerce an unknown to a string array (dropping non-strings), [] otherwise. */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Tolerantly coerce an RBAC permissions API body into PermissionSet[]. Missing
 * or malformed elements/fields degrade to empty arrays rather than throwing, so
 * a surprising body shape can never crash the report.
 */
function extractPermissionSets(body: unknown): PermissionSet[] {
  const value = prop(body, "value");
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((element) => ({
    actions: asStringArray(prop(element, "actions")),
    notActions: asStringArray(prop(element, "notActions")),
    dataActions: asStringArray(prop(element, "dataActions")),
    notDataActions: asStringArray(prop(element, "notDataActions")),
  }));
}

/** Build a denied check result for every required action (permissions unread). */
function deniedChecks(setupPath: SetupPath): PermissionCheckResult[] {
  return REQUIRED_ACTIONS[setupPath].map((req) => ({
    action: req.action,
    label: req.label,
    granted: false,
  }));
}

// ---------------------------------------------------------------------------
// Azure side
// ---------------------------------------------------------------------------

/** Run one live no-op Azure existence probe; never rejects. */
async function probeAzure(
  azure: AzureManagement,
  name: string,
  label: string,
  request: AzureManagementRequest,
): Promise<AzureProbeResult> {
  try {
    const response = await azure.request(request);
    if (is2xx(response.status)) {
      return { name, label, status: "ok", detail: "access confirmed" };
    }
    if (response.status === 401 || response.status === 403) {
      return { name, label, status: "denied", detail: `HTTP ${response.status}` };
    }
    // 404 / 5xx / anything else is not a permission verdict - degrade to
    // unknown so a missing-resource or transient error never reads as denial.
    return {
      name,
      label,
      status: "unknown",
      detail: `HTTP ${response.status}`,
    };
  } catch (err) {
    return { name, label, status: "unknown", detail: errText(err) };
  }
}

/**
 * The Azure half: RBAC effective-action evaluation at the setup path's scope,
 * plus live existence probes. TOTAL - catches its own failures and always
 * returns a populated {@link AzurePreflight}. hasRequiredAccess is gated on the
 * EFFECTIVE ACTIONS (writes), never on the read probes, so Reader-only is false.
 */
export async function runAzurePreflight(
  azure: AzureManagement,
  setupPath: SetupPath,
  target: AzurePreflightTarget,
  logger?: Logger,
): Promise<AzurePreflight> {
  const scopeKind = scopeKindForSetupPath(setupPath);
  const scope = buildArmScope(scopeKind, target);

  if (scope === null) {
    // Not configured: mirror the legacy stub, but do not attempt any call.
    logger?.info("permission-preflight: azure not configured", {
      setupPath,
      scopeKind,
    });
    return {
      configured: false,
      setupPath,
      scopeKind,
      scope: "",
      permissionsFetched: false,
      checks: deniedChecks(setupPath),
      probes: [],
      hasRequiredAccess: false,
      error:
        scopeKind === "resource-group"
          ? "No resource group configured"
          : "No subscription configured",
    };
  }

  const required = REQUIRED_ACTIONS[setupPath];

  // --- Effective-action evaluation from the RBAC permissions API ---
  let permissionsFetched = false;
  let checks: PermissionCheckResult[];
  let error = "";
  try {
    const response = await azure.request({
      method: "GET",
      path: `${scope}/providers/Microsoft.Authorization/permissions`,
      apiVersion: RBAC_PERMISSIONS_API_VERSION,
    });
    if (is2xx(response.status)) {
      permissionsFetched = true;
      checks = evaluatePermissions(
        { value: extractPermissionSets(response.body) },
        required,
      );
    } else {
      checks = deniedChecks(setupPath);
      error = httpErrorText("fetch RBAC permissions", response.status, response.body);
    }
  } catch (err) {
    checks = deniedChecks(setupPath);
    error = `fetch RBAC permissions: ${errText(err)}`;
  }

  // --- Live existence probes (truth; do not gate readiness on their own) ---
  const probeRequests: {
    name: string;
    label: string;
    request: AzureManagementRequest;
  }[] = [
    {
      name: "dcr-list",
      label: "List Data Collection Rules",
      request: {
        method: "GET",
        path: `${scope}/providers/Microsoft.Insights/dataCollectionRules`,
        apiVersion: DIRECT_DCR_API_VERSION,
      },
    },
  ];
  if (target.resourceGroup !== "" && target.workspaceName !== "") {
    const wsBase =
      `/subscriptions/${target.subscriptionId}` +
      `/resourceGroups/${target.resourceGroup}` +
      `/providers/Microsoft.OperationalInsights/workspaces/${target.workspaceName}`;
    probeRequests.push({
      name: "workspace-get",
      label: "Read Log Analytics workspace",
      request: { method: "GET", path: wsBase, apiVersion: WORKSPACE_API_VERSION },
    });
    probeRequests.push({
      name: "tables-list",
      label: "List workspace tables",
      request: {
        method: "GET",
        path: `${wsBase}/tables`,
        apiVersion: WORKSPACE_API_VERSION,
      },
    });
  }
  const probes = await Promise.all(
    probeRequests.map((p) => probeAzure(azure, p.name, p.label, p.request)),
  );

  const hasRequiredAccess = permissionsFetched && allGranted(checks);
  logger?.info("permission-preflight: azure evaluated", {
    setupPath,
    scopeKind,
    permissionsFetched,
    hasRequiredAccess,
  });

  return {
    configured: true,
    setupPath,
    scopeKind,
    scope,
    permissionsFetched,
    checks,
    probes,
    hasRequiredAccess,
    error,
  };
}

// ---------------------------------------------------------------------------
// Cribl side
// ---------------------------------------------------------------------------

/** Probe one Cribl capability; never rejects (graceful degradation). */
async function probeCribl(
  cribl: CriblClient,
  spec: CriblCapabilitySpec,
  workerGroup: string,
): Promise<CriblCapabilityProbe> {
  const base = {
    capability: spec.capability,
    label: spec.label,
    required: spec.required,
  };
  try {
    const response = await cribl.request({
      method: "GET",
      path: spec.path,
      groupId: workerGroup !== "" ? workerGroup : undefined,
    });
    if (is2xx(response.status)) {
      return { ...base, status: "granted", detail: "access confirmed" };
    }
    if (response.status === 401 || response.status === 403) {
      return { ...base, status: "denied", detail: `HTTP ${response.status}` };
    }
    return { ...base, status: "unknown", detail: `HTTP ${response.status}` };
  } catch (err) {
    // A failed probe degrades to unknown - it must NEVER crash the report.
    return { ...base, status: "unknown", detail: errText(err) };
  }
}

/**
 * The Cribl half. TOTAL - always returns a populated {@link CriblPreflight}.
 *
 * On CLOUD the app runs inside the leader under the approved policies.yml, so
 * the probe is near-vacuous: every capability reads "granted by platform" and
 * no request is issued. On LOCAL each capability is genuinely probed against the
 * configured leader; graceful degradation keeps a failed probe from crashing the
 * report. hasRequiredAccess is true only when every REQUIRED capability is
 * granted (an `unknown` required probe is NOT granted).
 */
export async function runCriblPreflight(
  cribl: CriblClient,
  mode: CriblShellMode,
  workerGroup: string | undefined,
  logger?: Logger,
): Promise<CriblPreflight> {
  const group = workerGroup ?? "";

  if (mode === "cloud") {
    logger?.info("permission-preflight: cribl granted by platform (cloud)", {
      workerGroup: group,
    });
    const probes: CriblCapabilityProbe[] = CRIBL_CAPABILITY_PROBES.map((spec) => ({
      capability: spec.capability,
      label: spec.label,
      required: spec.required,
      status: "granted",
      detail: "granted by platform",
    }));
    return { mode, workerGroup: group, probes, hasRequiredAccess: true, error: "" };
  }

  const probes = await Promise.all(
    CRIBL_CAPABILITY_PROBES.map((spec) => probeCribl(cribl, spec, group)),
  );
  const requiredProbes = probes.filter((probe) => probe.required);
  const hasRequiredAccess =
    requiredProbes.length > 0 &&
    requiredProbes.every((probe) => probe.status === "granted");
  // Only when NO probe could complete do we call the leader unreachable; a mix
  // of denied/granted is a real permission answer, not a connection failure.
  const error = probes.every((probe) => probe.status === "unknown")
    ? "Cribl leader not reachable"
    : "";

  logger?.info("permission-preflight: cribl evaluated (local)", {
    workerGroup: group,
    hasRequiredAccess,
  });
  return { mode, workerGroup: group, probes, hasRequiredAccess, error };
}

// ---------------------------------------------------------------------------
// Summary (fixed-priority failure reasons)
// ---------------------------------------------------------------------------

/** The first (highest-priority) Cribl-side issue, or null when ready. */
function firstCriblIssue(cribl: CriblPreflight): string | null {
  if (cribl.hasRequiredAccess) {
    return null;
  }
  if (cribl.error !== "") {
    return `Cribl: ${cribl.error}`;
  }
  for (const probe of cribl.probes) {
    if (probe.required && probe.status !== "granted") {
      return `Cribl: cannot ${probe.label.toLowerCase()} (${probe.status})`;
    }
  }
  return "Cribl: required access missing";
}

/** The first (highest-priority) Azure-side issue, or null when ready. */
function firstAzureIssue(azure: AzurePreflight): string | null {
  if (azure.hasRequiredAccess) {
    return null;
  }
  if (!azure.configured) {
    return `Azure: ${azure.error}`;
  }
  if (!azure.permissionsFetched) {
    return "Azure: permission check failed";
  }
  for (const check of azure.checks) {
    if (!check.granted) {
      return `Azure: cannot ${check.label.toLowerCase()}`;
    }
  }
  return "Azure: required access missing";
}

/**
 * Compose the one-line summary. FIXED PRIORITY: Cribl issue first, then Azure -
 * a stable order so the same failing state always renders the same summary.
 */
function summarize(
  cribl: CriblPreflight,
  azure: AzurePreflight,
  ready: boolean,
): string {
  if (ready) {
    return "All required access verified. Ready to deploy.";
  }
  const issues: string[] = [];
  const criblIssue = firstCriblIssue(cribl);
  if (criblIssue !== null) {
    issues.push(criblIssue);
  }
  const azureIssue = firstAzureIssue(azure);
  if (azureIssue !== null) {
    issues.push(azureIssue);
  }
  return `Cannot deploy: ${issues.join("; ")}`;
}

// ---------------------------------------------------------------------------
// Top-level composition
// ---------------------------------------------------------------------------

/** Fallback Azure preflight for an unexpected runner throw (keeps partial render). */
function azureFallback(setupPath: SetupPath, err: unknown): AzurePreflight {
  return {
    configured: false,
    setupPath,
    scopeKind: scopeKindForSetupPath(setupPath),
    scope: "",
    permissionsFetched: false,
    checks: deniedChecks(setupPath),
    probes: [],
    hasRequiredAccess: false,
    error: `azure preflight error: ${errText(err)}`,
  };
}

/** Fallback Cribl preflight for an unexpected runner throw (keeps partial render). */
function criblFallback(
  mode: CriblShellMode,
  workerGroup: string | undefined,
  err: unknown,
): CriblPreflight {
  return {
    mode,
    workerGroup: workerGroup ?? "",
    probes: CRIBL_CAPABILITY_PROBES.map((spec) => ({
      capability: spec.capability,
      label: spec.label,
      required: spec.required,
      status: "unknown",
      detail: errText(err),
    })),
    hasRequiredAccess: false,
    error: `cribl preflight error: ${errText(err)}`,
  };
}

/**
 * Run the combined permission preflight. Both sides run IN PARALLEL and PARTIAL
 * RESULTS ALWAYS RENDER: each side runner is total, and each is additionally
 * guarded with a fallback so an unexpected throw on one side can never blank the
 * other. Never rejects - the report always carries both halves.
 *
 * The combined {@link PermissionReport.hasRequiredAccess} is true only when BOTH
 * sides have their required access. This is the PERMISSION verdict, deliberately
 * distinct from integrate-arc's `canDeploy` UI gate.
 */
export async function runPermissionPreflight(
  ports: PermissionPreflightPorts,
  input: PermissionPreflightInput,
): Promise<PermissionReport> {
  const { azure: azurePort, cribl: criblPort, logger } = ports;

  const [azure, cribl] = await Promise.all([
    runAzurePreflight(azurePort, input.setupPath, input.azure, logger).catch(
      (err) => azureFallback(input.setupPath, err),
    ),
    runCriblPreflight(
      criblPort,
      input.cribl.mode,
      input.cribl.workerGroup,
      logger,
    ).catch((err) => criblFallback(input.cribl.mode, input.cribl.workerGroup, err)),
  ]);

  const hasRequiredAccess = azure.hasRequiredAccess && cribl.hasRequiredAccess;
  const summary = summarize(cribl, azure, hasRequiredAccess);

  logger?.info("permission-preflight: report generated", {
    setupPath: input.setupPath,
    hasRequiredAccess,
    azureReady: azure.hasRequiredAccess,
    criblReady: cribl.hasRequiredAccess,
  });

  return { cribl, azure, hasRequiredAccess, summary };
}
