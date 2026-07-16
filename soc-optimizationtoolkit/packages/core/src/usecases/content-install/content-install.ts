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

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The response body as a string (for error-message matching). */
function bodyText(res: PortHttpResponse): string {
  try {
    return typeof res.body === "string" ? res.body : JSON.stringify(res.body);
  } catch {
    return String(res.body);
  }
}

/** Render a failed ARM response as the outcome detail (status + body). */
function failDetail(res: PortHttpResponse): string {
  const body = bodyText(res);
  return `HTTP ${res.status}${body && body !== "null" ? ` ${body}` : ""}`;
}

/**
 * A rule PUT is validated against the workspace: Azure compiles the query and
 * rejects it when a table it reads does not exist yet ("Failed to run the
 * analytics rule query. One of the tables does not exist."). That is a
 * workflow dependency, not a tooling bug - the source's data table is created
 * when ingestion is set up (its DCR / custom table) and data arrives. Turn the
 * opaque message into actionable guidance, keeping the raw error for reference.
 */
function ruleFailureDetail(res: PortHttpResponse): string {
  const text = bodyText(res);
  if (/does not exist|Failed to run the analytics rule query/i.test(text)) {
    return (
      "the rule's data table does not exist in the workspace yet - set up " +
      "ingestion for this source first (create its DCR / custom table and let " +
      "data arrive), then install the rule. Raw error: " +
      failDetail(res)
    );
  }
  return failDetail(res);
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
      : { name: rule.name, ok: false, detail: ruleFailureDetail(res) };
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
  // The workbooks API rejects an empty body with "A payload is required." Fail
  // with a precise reason rather than that opaque message if the content or
  // region is missing (both are required: serializedData and a regional location).
  if (spec.serializedData.trim() === "") {
    return {
      name: spec.displayName,
      ok: false,
      detail: "the workbook content was empty (nothing to install)",
    };
  }
  if (ws.location.trim() === "") {
    return {
      name: spec.displayName,
      ok: false,
      detail: "the workspace region is unknown; regional workbooks need it",
    };
  }
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
 *
 * DUPLICATE-ALIAS SAFETY: the SecurityInsights RP lets two savedSearches
 * carry the SAME functionAlias under different resource names (the solution's
 * own parser + ours), and a query that references the alias then fails to
 * compile ("Detected multiple functions with the same name"). So before
 * creating ours, look for an EXISTING function with this alias from another
 * source; if one exists, delete our deterministic copy (if any) and defer to
 * it - leaving exactly one provider.
 */
export async function installParser(
  azure: AzureManagement,
  ws: WorkspaceScope,
  parser: ParserResource,
): Promise<ContentInstallOutcome> {
  const searchId = `parser-${parser.alias}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const searchPath = `${workspaceResourceId(ws)}/savedSearches/${searchId}`;
  const label = `${parser.displayName} (parser)`;
  try {
    // Which resources already provide this alias? (Best-effort: if the listing
    // fails, fall through to a plain idempotent PUT.)
    const aliasLc = parser.alias.toLowerCase();
    let othersProvideAlias = false;
    try {
      const all = await listAllPages(
        azure,
        {
          method: "GET",
          path: `${workspaceResourceId(ws)}/savedSearches`,
          apiVersion: SAVED_SEARCHES_API_VERSION,
        },
        "list saved searches",
      );
      othersProvideAlias = all.some((s) => {
        const name = str(prop(s, "name")).toLowerCase();
        const alias = str(prop(prop(s, "properties"), "functionAlias")).toLowerCase();
        return alias === aliasLc && name !== searchId;
      });
    } catch {
      /* listing unavailable - fall through to the plain PUT below */
    }
    if (othersProvideAlias) {
      // Another resource already provides this function. Remove OUR own copy
      // (deterministic id) if it exists so exactly one remains, and defer.
      try {
        await azure.request({
          method: "DELETE",
          path: searchPath,
          apiVersion: SAVED_SEARCHES_API_VERSION,
        });
      } catch {
        /* best-effort cleanup */
      }
      return { name: label, ok: true, detail: "already provided by the solution" };
    }
    const res = await azure.request({
      method: "PUT",
      path: searchPath,
      apiVersion: SAVED_SEARCHES_API_VERSION,
      body: parserResourceBody(parser),
    });
    return is2xx(res.status)
      ? { name: label, ok: true, detail: "installed" }
      : { name: label, ok: false, detail: failDetail(res) };
  } catch (err) {
    return { name: label, ok: false, detail: errText(err) };
  }
}

// ---------------------------------------------------------------------------
// Solution install (Content Hub)
// ---------------------------------------------------------------------------

/**
 * Install a Content Hub solution via the first-class "Content Package -
 * Install" operation: a direct PUT of the contentPackages/{packageId}
 * resource. This is the documented, SYNCHRONOUS install (the portal's
 * "Install" button) - the response IS the installed package (its
 * installedVersion is set), so there is no async deployment to poll.
 *
 * We deliberately do NOT deploy the package's packagedContent ARM template
 * ourselves (the legacy path) - that outer deployment can sit in
 * provisioningState "Running" indefinitely while its nested deployments
 * resolve, so an install would report "started" yet never install. The
 * install PUT lets the SecurityInsights RP materialize the content
 * server-side. Ref: learn.microsoft.com Content Package - Install.
 *
 * The five install fields all come from the contentProductPackages GET we
 * already make (contentId, contentProductId, contentKind, displayName,
 * version). `packageId` is the product package's `name` (== its contentId).
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
    const contentId = str(prop(props, "contentId"));
    const contentProductId = str(prop(props, "contentProductId"));
    const contentKind = str(prop(props, "contentKind")) || "Solution";
    const version = str(prop(props, "version"));
    const name = str(prop(props, "displayName")) || displayName;
    // Required by the live 2025-09-01 install API (the REST reference lists it
    // as optional, but the RP rejects the PUT without it). Sourced from the
    // product package; default to the current Content Hub schema version.
    const contentSchemaVersion = str(prop(props, "contentSchemaVersion")) || "3.0.0";
    if (contentId === "" || contentProductId === "" || version === "") {
      return {
        name: displayName,
        ok: false,
        detail:
          "the product package is missing required install fields " +
          "(contentId / contentProductId / version)",
      };
    }
    // Short-circuit: the product package already reports an installed version.
    const installedVersion = str(prop(props, "installedVersion"));
    if (installedVersion !== "") {
      return {
        name: displayName,
        ok: true,
        detail: `already installed (version ${installedVersion})`,
      };
    }
    // The install resource name is the short contentId (== the product
    // package name); the RP enforces one contentPackages resource per
    // contentId. Ref: learn.microsoft.com Content Package - Install.
    const body = {
      properties: {
        contentId,
        contentProductId,
        contentKind,
        contentSchemaVersion,
        displayName: name,
        version,
      },
    };
    const put = () =>
      azure.request({
        method: "PUT",
        path: `${workspaceInsightsScope(ws)}/contentPackages/${contentId}`,
        apiVersion: SECURITY_INSIGHTS_API_VERSION,
        body,
      });
    let res = await put();
    // A prior partial/failed attempt can leave an ORPHAN contentPackages
    // resource that already owns this contentId under a different name (the
    // versioned contentProductId), so the RP refuses a second association with
    // "contentId ... is already associated with another package". Delete the
    // orphan(s) - two Solutions never share a contentId, so it can only be a
    // stale copy of THIS solution - then retry the install once.
    if (res.status === 400 && /already associated with another package/i.test(bodyText(res))) {
      logger?.info("content-install: clearing orphaned package association", { contentId });
      await deleteContentPackage(azure, ws, contentProductId);
      await deleteContentPackage(azure, ws, contentId);
      res = await put();
    }
    logger?.info("content-install: solution install PUT", {
      packageId,
      status: res.status,
    });
    return is2xx(res.status)
      ? { name: displayName, ok: true, detail: `installed (version ${version})` }
      : { name: displayName, ok: false, detail: failDetail(res) };
  } catch (err) {
    return { name: displayName, ok: false, detail: errText(err) };
  }
}

/** Uninstall (DELETE) a contentPackages resource by name; best-effort, never throws. */
async function deleteContentPackage(
  azure: AzureManagement,
  ws: WorkspaceScope,
  name: string,
): Promise<void> {
  if (name === "") return;
  try {
    await azure.request({
      method: "DELETE",
      path: `${workspaceInsightsScope(ws)}/contentPackages/${name}`,
      apiVersion: SECURITY_INSIGHTS_API_VERSION,
    });
  } catch {
    /* best-effort - a retry PUT still surfaces any real failure */
  }
}
