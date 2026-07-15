/**
 * content-install usecases (user feature 2026-07-14): enable a Sentinel
 * solution's content in the workspace over the EXISTING AzureManagement port
 * (management.azure.com - no new external surface). Four capabilities the
 * Integrate page's "Enable Sentinel Content" section drives:
 *
 *   - installedContentState: what the workspace ALREADY has (solution
 *     installed? which analytics-rule + workbook display names exist?) - so
 *     the UI shows only what is installable.
 *   - installSolution: the documented Content Hub flow (GET the product
 *     package's packagedContent ARM template, deploy it via a
 *     Microsoft.Resources/deployments PUT).
 *   - installAnalyticRules: PUT one alertRules resource per rule, each
 *     yielding a typed {@link ContentInstallOutcome}. Scheduled uses the stable
 *     api-version; NRT uses the preview one (NRT is not in stable).
 *   - installWorkbooks: PUT one Microsoft.Insights/workbooks resource per
 *     workbook, linked to the workspace.
 *
 * Every install is per-item and INDEPENDENT: one failure never aborts the
 * rest, and each returns a success/failure outcome (user requirement). The
 * shell mints resource GUIDs (core is crypto-free) via mintId.
 *
 * Pure orchestration over the ports: no IO of its own.
 */

import type { AzureManagement } from "../../ports/azure-management";
import type { PortHttpResponse } from "../../ports/http";
import type { Logger } from "../../ports/logger";
import { listAllPages } from "../azure-discovery/index";
import {
  alertRuleResourceFromParsed,
  parserResourceBody,
  workbookResourceBody,
} from "../../domain/content-install/index";
import type {
  ContentInstallOutcome,
  ParserResource,
} from "../../domain/content-install/index";
import type { ParsedAnalyticRule } from "../../domain/coverage-analysis/index";

/** SecurityInsights stable api-version (solutions, scheduled rules). */
export const SECURITY_INSIGHTS_API_VERSION = "2025-09-01";
/** NRT rules are not in any stable version - the preview carries them. */
export const SECURITY_INSIGHTS_PREVIEW_API_VERSION = "2025-10-01-preview";
/** Microsoft.Insights/workbooks api-version. */
export const WORKBOOKS_INSTALL_API_VERSION = "2021-08-01";
/** Microsoft.OperationalInsights/workspaces/savedSearches (parsers). */
export const SAVED_SEARCHES_API_VERSION = "2020-08-01";
/** ARM deployments api-version (solution mainTemplate deploy). */
export const DEPLOYMENTS_API_VERSION = "2021-04-01";

/** The workspace coordinates every call is scoped to. */
export interface WorkspaceScope {
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
  /** Azure region (workbooks are regional; solution deploy needs it). */
  location: string;
}

/** The workspace's SecurityInsights ARM scope prefix. */
function workspaceInsightsScope(ws: WorkspaceScope): string {
  return (
    `/subscriptions/${ws.subscriptionId}` +
    `/resourceGroups/${ws.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${ws.workspaceName}` +
    "/providers/Microsoft.SecurityInsights"
  );
}

/** Log Analytics workspace api-version (read the region for regional installs). */
export const WORKSPACE_READ_API_VERSION = "2023-09-01";
/**
 * Sentinel onboarding api-version. The MODERN onboarding method (the one the
 * "not onboarded" error itself recommends) is a PUT of the SecurityInsights
 * onboardingStates/default resource - NOT the legacy
 * Microsoft.OperationsManagement/solutions the old enableSentinel used, which
 * Azure has deprecated and which silently no-ops in many regions.
 */
export const SENTINEL_ONBOARDING_API_VERSION = "2024-03-01";

/** One onboarding attempt's outcome. */
export interface OnboardOutcome {
  ok: boolean;
  detail: string;
}

/**
 * Onboard a workspace to Microsoft Sentinel via the SecurityInsights
 * onboardingStates PUT (the current, RP-recognized method). Idempotent: a
 * PUT on an already-onboarded workspace returns 2xx. Resolves an outcome and
 * never throws so the UI can report success/failure precisely.
 */
export async function onboardSentinelWorkspace(
  azure: AzureManagement,
  ws: WorkspaceScope,
  logger?: Logger,
): Promise<OnboardOutcome> {
  try {
    const res = await azure.request({
      method: "PUT",
      path: `${workspaceInsightsScope(ws)}/onboardingStates/default`,
      apiVersion: SENTINEL_ONBOARDING_API_VERSION,
      body: { properties: {} },
    });
    logger?.info("content-install: sentinel onboarding PUT", { status: res.status });
    return is2xx(res.status)
      ? { ok: true, detail: "Microsoft Sentinel enabled on the workspace." }
      : { ok: false, detail: failDetail(res) };
  } catch (err) {
    return { ok: false, detail: errText(err) };
  }
}

/**
 * Read the workspace's Azure region (workbooks are regional; the solution
 * deploy needs a workspace-location parameter). Returns null when the read
 * fails - the caller then prompts for a region or defaults.
 */
export async function fetchWorkspaceLocation(
  azure: AzureManagement,
  subscriptionId: string,
  resourceGroup: string,
  workspaceName: string,
): Promise<string | null> {
  try {
    const res = await azure.request({
      method: "GET",
      path:
        `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
        `/providers/Microsoft.OperationalInsights/workspaces/${workspaceName}`,
      apiVersion: WORKSPACE_READ_API_VERSION,
    });
    if (!is2xx(res.status)) return null;
    const loc = prop(res.body, "location");
    return typeof loc === "string" && loc !== "" ? loc : null;
  } catch {
    return null;
  }
}

/** The full ARM resource id of the Log Analytics workspace (workbook sourceId). */
export function workspaceResourceId(ws: WorkspaceScope): string {
  return (
    `/subscriptions/${ws.subscriptionId}` +
    `/resourceGroups/${ws.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${ws.workspaceName}`
  );
}

function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Render a failed ARM response as the outcome detail (status + body). */
function failDetail(res: PortHttpResponse): string {
  let body: string;
  try {
    body = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
  } catch {
    body = String(res.body);
  }
  return `HTTP ${res.status}${body && body !== "null" ? ` ${body}` : ""}`;
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

// ---------------------------------------------------------------------------
// Installed-state detection
// ---------------------------------------------------------------------------

/** What the workspace already has (drives the installable partition). */
export interface InstalledContentState {
  /** True when this solution's Content Hub package reports an installedVersion. */
  solutionInstalled: boolean;
  installedSolutionVersion: string | null;
  /** LOWERCASED display names of alert rules already in the workspace. */
  installedRuleNames: ReadonlySet<string>;
  /** LOWERCASED display names of workbooks already linked to the workspace. */
  installedWorkbookNames: ReadonlySet<string>;
  /** Non-fatal notes (a listing that failed degrades to "unknown", not error). */
  notes: string[];
  /**
   * True when a probe returned the "workspace is not onboarded to Microsoft
   * Sentinel" error - the SecurityInsights provider rejects every content
   * call until Sentinel is enabled on the workspace. The UI turns this into
   * an actionable Enable action instead of a raw ARM error.
   */
  notOnboarded: boolean;
}

/**
 * Detect the ARM "not onboarded to Microsoft Sentinel" rejection across its
 * phrasings: the SecurityInsights provider returns a 400 whose (sometimes
 * double-encoded) body says the workspace is not onboarded and points at the
 * OnboardingStates API / quickstart. Match any of those signals so a wording
 * change or nested-JSON escaping never drops it back to a raw note.
 */
export function isNotOnboardedError(body: unknown): boolean {
  let text: string;
  try {
    text = typeof body === "string" ? body : JSON.stringify(body);
  } catch {
    return false;
  }
  return (
    /not onboarded to Microsoft Sentinel/i.test(text) ||
    /onboard(?:ed|ing)?[^.]{0,40}(?:to )?(?:Microsoft )?Sentinel/i.test(text) ||
    /sentinel-onboarding-states/i.test(text) ||
    /OnboardingStates/i.test(text)
  );
}

/**
 * Probe what the workspace already has. Each listing is best-effort: a
 * failure degrades that dimension to empty + a note (so the UI offers
 * install rather than hiding everything). `solutionContentId` is the Content
 * Hub package contentId (from the catalog); omit to skip the solution probe.
 */
export async function installedContentState(
  azure: AzureManagement,
  ws: WorkspaceScope,
  solutionContentId: string | undefined,
  logger?: Logger,
): Promise<InstalledContentState> {
  const scope = workspaceInsightsScope(ws);
  const notes: string[] = [];
  let notOnboarded = false;

  let solutionInstalled = false;
  let installedSolutionVersion: string | null = null;
  if (solutionContentId !== undefined && solutionContentId !== "") {
    try {
      const packages = await listAllPages(
        azure,
        {
          method: "GET",
          path: `${scope}/contentPackages`,
          apiVersion: SECURITY_INSIGHTS_API_VERSION,
        },
        "list installed content packages",
      );
      const match = packages.find(
        (p) => prop(prop(p, "properties"), "contentId") === solutionContentId,
      );
      if (match !== undefined) {
        solutionInstalled = true;
        const v = prop(prop(match, "properties"), "version");
        installedSolutionVersion = typeof v === "string" ? v : null;
      }
    } catch (err) {
      if (isNotOnboardedError(errText(err))) notOnboarded = true;
      else notes.push(`Could not read installed solutions: ${errText(err)}`);
    }
  }

  const installedRuleNames = new Set<string>();
  try {
    const rules = await listAllPages(
      azure,
      {
        method: "GET",
        path: `${scope}/alertRules`,
        apiVersion: SECURITY_INSIGHTS_API_VERSION,
      },
      "list alert rules",
    );
    for (const r of rules) {
      const name = prop(prop(r, "properties"), "displayName");
      if (typeof name === "string") installedRuleNames.add(name.toLowerCase());
    }
  } catch (err) {
    if (isNotOnboardedError(errText(err))) notOnboarded = true;
    else notes.push(`Could not read installed analytics rules: ${errText(err)}`);
  }

  const installedWorkbookNames = new Set<string>();
  try {
    const workbooks = await listAllPages(
      azure,
      {
        method: "GET",
        path:
          `/subscriptions/${ws.subscriptionId}/resourceGroups/${ws.resourceGroup}` +
          "/providers/Microsoft.Insights/workbooks",
        apiVersion: WORKBOOKS_INSTALL_API_VERSION,
        query: {
          category: "sentinel",
          sourceId: workspaceResourceId(ws).toLowerCase(),
        },
      },
      "list workbooks",
    );
    for (const w of workbooks) {
      const name = prop(prop(w, "properties"), "displayName");
      if (typeof name === "string") installedWorkbookNames.add(name.toLowerCase());
    }
  } catch (err) {
    // Workbooks live under Microsoft.Insights, not SecurityInsights, so this
    // path never raises the not-onboarded error; a failure is a plain note.
    notes.push(`Could not read installed workbooks: ${errText(err)}`);
  }

  logger?.info("content-install: installed state probed", {
    solutionInstalled,
    rules: installedRuleNames.size,
    workbooks: installedWorkbookNames.size,
    notOnboarded,
  });

  return {
    solutionInstalled,
    installedSolutionVersion,
    installedRuleNames,
    installedWorkbookNames,
    notes,
    notOnboarded,
  };
}

// ---------------------------------------------------------------------------
// Analytics-rule install
// ---------------------------------------------------------------------------

/** Install one parsed analytics rule; resolves an outcome (never throws). */
export async function installAnalyticRule(
  azure: AzureManagement,
  ws: WorkspaceScope,
  rule: ParsedAnalyticRule,
  mintId: () => string,
): Promise<ContentInstallOutcome> {
  const resource = alertRuleResourceFromParsed(rule);
  if (!resource.supported) {
    return { name: rule.name, ok: false, detail: `skipped: ${resource.reason}` };
  }
  const ruleId = /^[0-9a-f-]{36}$/i.test(rule.id) ? rule.id : mintId();
  const apiVersion =
    resource.kind === "NRT"
      ? SECURITY_INSIGHTS_PREVIEW_API_VERSION
      : SECURITY_INSIGHTS_API_VERSION;
  try {
    const res = await azure.request({
      method: "PUT",
      path: `${workspaceInsightsScope(ws)}/alertRules/${ruleId}`,
      apiVersion,
      body: resource.body,
    });
    return is2xx(res.status)
      ? { name: rule.name, ok: true, detail: `installed (${resource.kind})` }
      : { name: rule.name, ok: false, detail: failDetail(res) };
  } catch (err) {
    return { name: rule.name, ok: false, detail: errText(err) };
  }
}

// ---------------------------------------------------------------------------
// Workbook install
// ---------------------------------------------------------------------------

/** One workbook to install: its display name and serialized document. */
export interface WorkbookInstallSpec {
  displayName: string;
  serializedData: string;
}

/** Install one workbook linked to the workspace; resolves an outcome. */
export async function installWorkbook(
  azure: AzureManagement,
  ws: WorkspaceScope,
  spec: WorkbookInstallSpec,
  mintId: () => string,
): Promise<ContentInstallOutcome> {
  const body = workbookResourceBody({
    displayName: spec.displayName,
    serializedData: spec.serializedData,
    workspaceResourceId: workspaceResourceId(ws),
    location: ws.location,
  });
  try {
    const res = await azure.request({
      method: "PUT",
      path:
        `/subscriptions/${ws.subscriptionId}/resourceGroups/${ws.resourceGroup}` +
        `/providers/Microsoft.Insights/workbooks/${mintId()}`,
      apiVersion: WORKBOOKS_INSTALL_API_VERSION,
      body,
    });
    return is2xx(res.status)
      ? { name: spec.displayName, ok: true, detail: "installed" }
      : { name: spec.displayName, ok: false, detail: failDetail(res) };
  } catch (err) {
    return { name: spec.displayName, ok: false, detail: errText(err) };
  }
}

// ---------------------------------------------------------------------------
// Parser install (savedSearches Function) - a DEPENDENCY of rules/workbooks
// ---------------------------------------------------------------------------

/**
 * Install one solution parser as a savedSearches Function; resolves an
 * outcome. Parsers are installed as a DEPENDENCY when rules/workbooks are
 * installed (they query the function by alias), not as a user choice - so
 * the UI reports them but never asks. The savedSearch id is derived from the
 * alias (deterministic + idempotent: a re-install PUTs over the same id).
 */
export async function installParser(
  azure: AzureManagement,
  ws: WorkspaceScope,
  parser: ParserResource,
): Promise<ContentInstallOutcome> {
  const searchId = `parser-${parser.alias}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  try {
    const res = await azure.request({
      method: "PUT",
      path: `${workspaceResourceId(ws)}/savedSearches/${searchId}`,
      apiVersion: SAVED_SEARCHES_API_VERSION,
      body: parserResourceBody(parser),
    });
    return is2xx(res.status)
      ? { name: `${parser.displayName} (parser)`, ok: true, detail: "installed" }
      : { name: `${parser.displayName} (parser)`, ok: false, detail: failDetail(res) };
  } catch (err) {
    return { name: `${parser.displayName} (parser)`, ok: false, detail: errText(err) };
  }
}

// ---------------------------------------------------------------------------
// Solution install (Content Hub)
// ---------------------------------------------------------------------------

/**
 * Install a Content Hub solution: GET the product package's packagedContent
 * ARM template, then deploy it via a Microsoft.Resources/deployments PUT
 * (the documented flow). `packageId` is the contentPackages/-scoped package
 * name (from the catalog listing's `name`). Resolves an outcome.
 *
 * The packagedContent field name has drifted across doc/samples
 * (packagedContent / mainTemplate / packageContent) - all three are tried.
 */
export async function installSolution(
  azure: AzureManagement,
  ws: WorkspaceScope,
  packageId: string,
  displayName: string,
  logger?: Logger,
): Promise<ContentInstallOutcome> {
  try {
    const pkg = await azure.request({
      method: "GET",
      path: `${workspaceInsightsScope(ws)}/contentProductPackages/${packageId}`,
      apiVersion: SECURITY_INSIGHTS_API_VERSION,
    });
    if (!is2xx(pkg.status)) {
      return { name: displayName, ok: false, detail: failDetail(pkg) };
    }
    const props = prop(pkg.body, "properties");
    const template =
      prop(props, "packagedContent") ??
      prop(props, "mainTemplate") ??
      prop(props, "packageContent");
    if (template === undefined || template === null) {
      return {
        name: displayName,
        ok: false,
        detail: "the product package returned no deployable template (packagedContent)",
      };
    }
    const res = await azure.request({
      method: "PUT",
      path: solutionDeploymentPath(ws, packageId),
      apiVersion: DEPLOYMENTS_API_VERSION,
      body: {
        properties: {
          mode: "Incremental",
          template,
          parameters: {
            workspace: { value: ws.workspaceName },
            "workspace-location": { value: ws.location },
          },
        },
      },
    });
    logger?.info("content-install: solution deploy issued", {
      packageId,
      status: res.status,
    });
    return is2xx(res.status)
      ? {
          name: displayName,
          ok: true,
          detail:
            "solution deployment started - it runs asynchronously and can take " +
            "a minute; reload to see it as installed",
        }
      : { name: displayName, ok: false, detail: failDetail(res) };
  } catch (err) {
    return { name: displayName, ok: false, detail: errText(err) };
  }
}

/** The deployment resource name for a solution install (bounded to 64 chars). */
function solutionDeploymentName(packageId: string): string {
  return `sentinel-solution-${packageId}`.slice(0, 64);
}

/** Full ARM id of the Microsoft.Resources/deployments used for a solution. */
function solutionDeploymentPath(ws: WorkspaceScope, packageId: string): string {
  return (
    `/subscriptions/${ws.subscriptionId}/resourceGroups/${ws.resourceGroup}` +
    `/providers/Microsoft.Resources/deployments/${solutionDeploymentName(packageId)}`
  );
}

/** Flatten an ARM error object ({code, message, details[]}) to one line. */
function renderArmError(err: unknown): string {
  const parts: string[] = [];
  const code = prop(err, "code");
  const message = prop(err, "message");
  if (typeof code === "string" && code !== "") parts.push(code);
  if (typeof message === "string" && message !== "") parts.push(message);
  const details = prop(err, "details");
  if (Array.isArray(details)) {
    for (const d of details) {
      const dm = prop(d, "message");
      if (typeof dm === "string" && dm !== "") parts.push(dm);
    }
  }
  return parts.join(" - ");
}

/** The terminal (or in-flight) state of a solution's install deployment. */
export interface SolutionDeploymentStatus {
  /**
   * The deployment's provisioningState (Succeeded | Failed | Canceled |
   * Running | Accepted | ...); null when NO deployment record exists (the
   * solution was never install-attempted, or ARM aged the record out).
   */
  state: string | null;
  /** Specific failure detail when the deployment Failed/Canceled; else null. */
  error: string | null;
}

/**
 * Read the result of a solution install's async ARM deployment. The install
 * PUT only returns "Accepted" - the deployment then provisions in the
 * background and CAN FAIL after acceptance (a failed deployment looks
 * identical to a pending one at PUT time, which is why an install can report
 * "started" yet never install). This reads the deployment's terminal state
 * and, when it failed, drills into the deployment OPERATIONS to surface the
 * specific resource error (the deployment-level message is usually the
 * generic "list deployment operations for details"). Never throws.
 */
export async function fetchSolutionDeploymentStatus(
  azure: AzureManagement,
  ws: WorkspaceScope,
  packageId: string,
  logger?: Logger,
): Promise<SolutionDeploymentStatus> {
  try {
    const res = await azure.request({
      method: "GET",
      path: solutionDeploymentPath(ws, packageId),
      apiVersion: DEPLOYMENTS_API_VERSION,
    });
    if (res.status === 404) return { state: null, error: null };
    if (!is2xx(res.status)) return { state: null, error: failDetail(res) };
    const props = prop(res.body, "properties");
    const stateRaw = prop(props, "provisioningState");
    const state = typeof stateRaw === "string" ? stateRaw : null;
    if (state !== null && /^(failed|canceled)$/i.test(state)) {
      let error = renderArmError(prop(props, "error"));
      if (error === "" || /list deployment operations/i.test(error)) {
        const opError = await fetchFailedOperationError(azure, ws, packageId);
        if (opError !== "") error = opError;
      }
      logger?.info("content-install: solution deployment failed", { packageId, state });
      return {
        state,
        error: error !== "" ? error : "deployment failed (no error detail returned)",
      };
    }
    return { state, error: null };
  } catch (err) {
    return { state: null, error: errText(err) };
  }
}

/** Pull the first failed deployment operations' resource errors (best-effort). */
async function fetchFailedOperationError(
  azure: AzureManagement,
  ws: WorkspaceScope,
  packageId: string,
): Promise<string> {
  try {
    const res = await azure.request({
      method: "GET",
      path: `${solutionDeploymentPath(ws, packageId)}/operations`,
      apiVersion: DEPLOYMENTS_API_VERSION,
    });
    if (!is2xx(res.status)) return "";
    const value = prop(res.body, "value");
    if (!Array.isArray(value)) return "";
    const messages: string[] = [];
    for (const op of value) {
      const opProps = prop(op, "properties");
      const opState = prop(opProps, "provisioningState");
      if (typeof opState !== "string" || !/^failed$/i.test(opState)) continue;
      const statusMessage = prop(opProps, "statusMessage");
      const errObj = prop(statusMessage, "error") ?? statusMessage;
      const rendered = renderArmError(errObj);
      const resType = prop(prop(opProps, "targetResource"), "resourceType");
      const label = typeof resType === "string" && resType !== "" ? `${resType}: ` : "";
      if (rendered !== "") messages.push(`${label}${rendered}`);
    }
    return messages.slice(0, 3).join(" | ");
  } catch {
    return "";
  }
}
