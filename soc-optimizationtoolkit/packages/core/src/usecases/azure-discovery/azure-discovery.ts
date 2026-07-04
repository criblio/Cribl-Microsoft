/**
 * Azure resource discovery and targeting (porting-plan Unit 2, ENG-31 delta /
 * GUI-10). Pure orchestration over the AzureManagement port: list the Azure
 * scope choices (subscriptions -> workspaces -> resource groups), create the
 * ones that do not exist yet (resource group, workspace, Sentinel), and commit
 * a chosen scope into the profile store.
 *
 * BROWSE NEVER COMMITS: every list/create/enable function here leaves the
 * profile store untouched. The legacy app switched the committed subscription
 * context as a SIDE EFFECT of browsing (Set-AzContext inside every list
 * handler) - that defect is deliberately not reproduced. The ONE way a chosen
 * scope becomes the active target is {@link commitTargetScope}, which merges
 * into the active profile's config (azure-profiles) and reports what cached
 * state the caller must invalidate (connection-invalidation).
 *
 * LEGACY DEFECT FIXED (pinned by test): the legacy enable-Sentinel handler
 * always deployed the SecurityInsights solution with location 'eastus' - it
 * read `checkResult.output.split('|')[2] || 'eastus'` where checkResult was
 * only ever 'ALREADY_ENABLED'/'NOT_ENABLED', so the workspace's region never
 * made it into the template. {@link enableSentinel} GETs the workspace and
 * uses its ACTUAL location.
 *
 * PAGINATION: ARM list responses carry `nextLink`, a FULL URL.
 * {@link listAllPages} follows it through the OPTIONAL
 * `AzureManagement.requestUrl` method when the adapter provides one, and
 * returns the single first page when it does not.
 *
 * Zero IO of its own, no wall-clock reads, no timers: the create-workspace
 * provisioning poll is bounded by ATTEMPT COUNT only (adapters own
 * per-request timeouts and any inter-attempt delay).
 */

import type {
  AzureManagement,
  AzureManagementRequest,
} from "../../ports/azure-management";
import { deriveResourceGroup } from "../../domain/azure-resource-id";
import { updateActiveConfig, getActiveProfile } from "../../domain/azure-profiles";
import type { ProfileStore } from "../../domain/azure-profiles";
import type { AzureConfig } from "../../domain/azure-config";
import { computeInvalidation } from "../../domain/connection-invalidation";
import type { InvalidationResult } from "../../domain/connection-invalidation";
import { deriveResourceGroupsFromWorkspaces } from "./azure-resources";
import type { AzureResourceGroup } from "./azure-resources";

// ---------------------------------------------------------------------------
// ARM api-versions and defaults
// ---------------------------------------------------------------------------

/** ARM api-version for the subscriptions list. */
export const SUBSCRIPTIONS_API_VERSION = "2022-12-01";

/** ARM api-version for resource-group list/create. */
export const RESOURCE_GROUP_API_VERSION = "2021-04-01";

/**
 * ARM api-version for Microsoft.OperationalInsights workspaces - matches
 * LOG_ANALYTICS_API_VERSION in the onboard-table usecase (the legacy engine
 * pins 2022-10-01 for the workspace surface).
 */
export const WORKSPACE_API_VERSION = "2022-10-01";

/**
 * ARM api-version for the Microsoft.OperationsManagement/solutions resource
 * that enables Sentinel. LEGACY-PINNED: the legacy enable-Sentinel template
 * deployed the SecurityInsights solution at exactly this api-version.
 */
export const SENTINEL_SOLUTION_API_VERSION = "2015-11-01-preview";

/** Legacy default workspace SKU (New-AzOperationalInsightsWorkspace -Sku). */
export const WORKSPACE_DEFAULT_SKU = "PerGB2018";

/** Legacy default workspace retention (-RetentionInDays 90). */
export const WORKSPACE_DEFAULT_RETENTION_DAYS = 90;

/** Default bound on workspace provisioning-poll GETs (attempts, not time). */
export const DEFAULT_WORKSPACE_POLL_ATTEMPTS = 10;

/** Bound on nextLink pages {@link listAllPages} follows (fail-loud, not silent truncation). */
export const MAX_LIST_PAGES = 50;

// ---------------------------------------------------------------------------
// Shared helpers (same pattern as usecases/onboard-table)
// ---------------------------------------------------------------------------

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

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Read a property of an unknown value, or undefined when not an object. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** Coerce an unknown field to a string, '' for anything not a string. */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------------------
// Pagination: listAllPages
// ---------------------------------------------------------------------------

/**
 * Execute an ARM list request and return the concatenated `value` arrays of
 * every page.
 *
 * ARM list responses carry `nextLink` - a FULL https://management.azure.com
 * URL with an opaque continuation token. When the adapter implements the
 * OPTIONAL `requestUrl` port method, each nextLink is followed via GET until
 * a page has none; when it does not, the FIRST PAGE ALONE is returned (the
 * documented single-page fallback). Follows at most {@link MAX_LIST_PAGES}
 * nextLinks, then throws - a cyclic or absurd nextLink chain fails loudly
 * instead of looping.
 *
 * Throws on any non-2xx page response with raw greppable error text.
 */
export async function listAllPages(
  azure: AzureManagement,
  request: AzureManagementRequest,
  context: string,
): Promise<unknown[]> {
  const first = await azure.request(request);
  if (!is2xx(first.status)) {
    throw new Error(httpErrorText(context, first.status, first.body));
  }

  const items: unknown[] = [];
  const collect = (body: unknown): string => {
    const value = prop(body, "value");
    if (Array.isArray(value)) {
      items.push(...value);
    }
    return asString(prop(body, "nextLink"));
  };

  let nextLink = collect(first.body);
  if (nextLink === "" || typeof azure.requestUrl !== "function") {
    return items;
  }

  let pagesFollowed = 0;
  while (nextLink !== "") {
    if (pagesFollowed >= MAX_LIST_PAGES) {
      throw new Error(
        `${context}: exceeded ${MAX_LIST_PAGES} nextLink pages - refusing to follow further`,
      );
    }
    pagesFollowed++;
    const page = await azure.requestUrl({ method: "GET", url: nextLink });
    if (!is2xx(page.status)) {
      throw new Error(
        httpErrorText(`${context} (page ${pagesFollowed + 1})`, page.status, page.body),
      );
    }
    nextLink = collect(page.body);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Listing: subscriptions, workspaces, resource groups
// ---------------------------------------------------------------------------

/** A subscription choice for the targeting cascade. */
export interface AzureSubscription {
  subscriptionId: string;
  displayName: string;
}

/**
 * List the subscriptions the credential can see, ENABLED ONLY (legacy pinned:
 * the legacy handler filtered `state === 'Enabled'` exactly - Disabled,
 * Warned, PastDue, and Deleted subscriptions never reach the picker).
 *
 * Tolerant mapping: `subscriptionId` falls back to parsing the `id` resource
 * path; entries with neither are dropped; a missing `displayName` maps to ''.
 */
export async function listSubscriptions(
  azure: AzureManagement,
): Promise<AzureSubscription[]> {
  const items = await listAllPages(
    azure,
    { method: "GET", path: "/subscriptions", apiVersion: SUBSCRIPTIONS_API_VERSION },
    "list subscriptions",
  );

  const subscriptions: AzureSubscription[] = [];
  for (const item of items) {
    if (asString(prop(item, "state")) !== "Enabled") {
      continue;
    }
    const direct = asString(prop(item, "subscriptionId"));
    const subscriptionId =
      direct !== "" ? direct : parseSubscriptionIdFromResourceId(prop(item, "id"));
    if (subscriptionId === "") {
      continue;
    }
    subscriptions.push({
      subscriptionId,
      displayName: asString(prop(item, "displayName")),
    });
  }
  return subscriptions;
}

/** `/subscriptions/{id}` -> `{id}`, '' when unparseable. */
function parseSubscriptionIdFromResourceId(id: unknown): string {
  const raw = asString(id);
  if (raw === "") {
    return "";
  }
  const segments = raw.split("/").filter((segment) => segment !== "");
  const index = segments.findIndex(
    (segment) => segment.toLowerCase() === "subscriptions",
  );
  if (index < 0 || index + 1 >= segments.length) {
    return "";
  }
  return segments[index + 1];
}

/** A Log Analytics workspace choice for the targeting cascade. */
export interface AzureWorkspace {
  name: string;
  /** Derived from the workspace's ARM resource id (azure-resource-id parser). */
  resourceGroup: string;
  location: string;
  /** The workspace GUID Log Analytics queries key on ('' when absent). */
  customerId: string;
  /** SKU name, e.g. 'PerGB2018' ('' when absent). */
  sku: string;
}

/**
 * List the Log Analytics workspaces of one subscription.
 *
 * Field paths mined from the legacy handler's Get-AzOperationalInsightsWorkspace
 * projection (Name | ResourceGroupName | Location | CustomerId | Sku.Name),
 * mapped onto the ARM REST shape: name, id (resource group is parsed from it),
 * location, properties.customerId, properties.sku.name. TOLERANT of missing
 * fields: everything except `name` defaults to '' (legacy dropped only
 * nameless rows; so do we).
 */
export async function listWorkspaces(
  azure: AzureManagement,
  subscriptionId: string,
): Promise<AzureWorkspace[]> {
  const items = await listAllPages(
    azure,
    {
      method: "GET",
      path: `/subscriptions/${subscriptionId}/providers/Microsoft.OperationalInsights/workspaces`,
      apiVersion: WORKSPACE_API_VERSION,
    },
    `list workspaces in subscription '${subscriptionId}'`,
  );

  const workspaces: AzureWorkspace[] = [];
  for (const item of items) {
    const name = asString(prop(item, "name"));
    if (name === "") {
      continue;
    }
    const properties = prop(item, "properties");
    workspaces.push({
      name,
      resourceGroup: deriveResourceGroup(asString(prop(item, "id"))),
      location: asString(prop(item, "location")),
      customerId: asString(prop(properties, "customerId")),
      sku: asString(prop(prop(properties, "sku"), "name")),
    });
  }
  return workspaces;
}

/**
 * List the resource groups of one subscription. Throws on non-2xx (a denied
 * list is an ERROR here; {@link listResourceGroupChoices} owns the fallback).
 */
export async function listResourceGroups(
  azure: AzureManagement,
  subscriptionId: string,
): Promise<AzureResourceGroup[]> {
  const items = await listAllPages(
    azure,
    {
      method: "GET",
      path: `/subscriptions/${subscriptionId}/resourcegroups`,
      apiVersion: RESOURCE_GROUP_API_VERSION,
    },
    `list resource groups in subscription '${subscriptionId}'`,
  );

  const groups: AzureResourceGroup[] = [];
  for (const item of items) {
    const name = asString(prop(item, "name"));
    if (name === "") {
      continue;
    }
    groups.push({ name, location: asString(prop(item, "location")) });
  }
  return groups;
}

/** How {@link listResourceGroupChoices} obtained its groups. */
export type ResourceGroupChoicesSource = "list" | "workspaces";

/** Result of {@link listResourceGroupChoices}. */
export interface ResourceGroupChoices {
  groups: AzureResourceGroup[];
  /** 'list' = the ARM RG list; 'workspaces' = derived fallback was used. */
  source: ResourceGroupChoicesSource;
  /** Raw error text when the ARM list call failed; null when it succeeded. */
  listError: string | null;
}

/**
 * The resource-group choices for the targeting cascade, with the LEGACY
 * FALLBACK (characterized by azure-resources.test.ts): when the dedicated
 * resource-group list call is DENIED (or succeeds but returns nothing), the
 * choices are derived from workspace metadata via the verbatim
 * {@link deriveResourceGroupsFromWorkspaces} - a user who can list workspaces
 * but not resource groups still gets a usable picker.
 *
 * Never rejects for a failed list call; the failure text is surfaced on
 * `listError` alongside whatever fallback produced.
 */
export async function listResourceGroupChoices(
  azure: AzureManagement,
  subscriptionId: string,
  workspaces: Array<{ resourceGroup: string; location: string }>,
): Promise<ResourceGroupChoices> {
  let listed: AzureResourceGroup[] | null = null;
  let listError: string | null = null;
  try {
    listed = await listResourceGroups(azure, subscriptionId);
  } catch (error) {
    listError = error instanceof Error ? error.message : String(error);
  }

  if (listed !== null && listed.length > 0) {
    return { groups: listed, source: "list", listError: null };
  }

  const derived = deriveResourceGroupsFromWorkspaces(workspaces);
  if (derived.length > 0) {
    return { groups: derived, source: "workspaces", listError };
  }

  // Nothing derivable either: report the (possibly empty) list result
  // honestly, keeping the error text when the list call failed.
  return { groups: listed ?? [], source: "list", listError };
}

// ---------------------------------------------------------------------------
// Creation: resource group, workspace, Sentinel
// ---------------------------------------------------------------------------

/** Input for {@link createResourceGroup}. */
export interface CreateResourceGroupInput {
  subscriptionId: string;
  name: string;
  location: string;
}

/**
 * Create (or idempotently update - ARM PUT semantics, matching the legacy
 * `New-AzResourceGroup -Force`) a resource group. Returns the resulting
 * name/location. Throws on non-2xx.
 */
export async function createResourceGroup(
  azure: AzureManagement,
  input: CreateResourceGroupInput,
): Promise<AzureResourceGroup> {
  const response = await azure.request({
    method: "PUT",
    path: `/subscriptions/${input.subscriptionId}/resourcegroups/${input.name}`,
    apiVersion: RESOURCE_GROUP_API_VERSION,
    body: { location: input.location },
  });
  if (!is2xx(response.status)) {
    throw new Error(
      httpErrorText(
        `create resource group '${input.name}'`,
        response.status,
        response.body,
      ),
    );
  }
  const name = asString(prop(response.body, "name"));
  const location = asString(prop(response.body, "location"));
  return {
    name: name !== "" ? name : input.name,
    location: location !== "" ? location : input.location,
  };
}

/** Input for {@link createWorkspace}. */
export interface CreateWorkspaceInput {
  subscriptionId: string;
  resourceGroup: string;
  name: string;
  location: string;
  /** Max provisioning-poll GETs; defaults to {@link DEFAULT_WORKSPACE_POLL_ATTEMPTS}. */
  maxPollAttempts?: number;
}

/** Result of {@link createWorkspace} (mirrors the legacy handler's fields). */
export interface CreatedWorkspace {
  name: string;
  resourceGroup: string;
  location: string;
  customerId: string;
}

/**
 * Create a Log Analytics workspace with the LEGACY DEFAULTS: sku PerGB2018
 * and retentionInDays 90 (exactly what the legacy handler passed to
 * New-AzOperationalInsightsWorkspace). PUTs the workspace, then GET-polls
 * until properties.provisioningState is Succeeded - the poll is bounded by
 * ATTEMPT COUNT ({@link CreateWorkspaceInput.maxPollAttempts}), never by
 * wall-clock. Throws on non-2xx, on a Failed/Canceled provisioning state, and
 * when the bound is exhausted.
 */
export async function createWorkspace(
  azure: AzureManagement,
  input: CreateWorkspaceInput,
): Promise<CreatedWorkspace> {
  const path =
    `/subscriptions/${input.subscriptionId}` +
    `/resourceGroups/${input.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${input.name}`;

  const putResponse = await azure.request({
    method: "PUT",
    path,
    apiVersion: WORKSPACE_API_VERSION,
    body: {
      location: input.location,
      properties: {
        sku: { name: WORKSPACE_DEFAULT_SKU },
        retentionInDays: WORKSPACE_DEFAULT_RETENTION_DAYS,
      },
    },
  });
  if (!is2xx(putResponse.status)) {
    throw new Error(
      httpErrorText(
        `create workspace '${input.name}'`,
        putResponse.status,
        putResponse.body,
      ),
    );
  }

  const provisioningState = (body: unknown): string =>
    asString(prop(prop(body, "properties"), "provisioningState"));

  let body: unknown = putResponse.body;
  const maxAttempts = input.maxPollAttempts ?? DEFAULT_WORKSPACE_POLL_ATTEMPTS;
  let attempts = 0;
  while (provisioningState(body).toLowerCase() !== "succeeded") {
    const state = provisioningState(body);
    if (/^(failed|canceled)$/i.test(state)) {
      throw new Error(
        `workspace '${input.name}' provisioning ended in state '${state}'`,
      );
    }
    if (attempts >= maxAttempts) {
      throw new Error(
        `workspace '${input.name}' did not reach provisioningState Succeeded ` +
          `within ${maxAttempts} poll attempts (last state '${state || "unknown"}')`,
      );
    }
    attempts++;
    const pollResponse = await azure.request({
      method: "GET",
      path,
      apiVersion: WORKSPACE_API_VERSION,
    });
    if (!is2xx(pollResponse.status)) {
      throw new Error(
        httpErrorText(
          `poll workspace '${input.name}'`,
          pollResponse.status,
          pollResponse.body,
        ),
      );
    }
    body = pollResponse.body;
  }

  const properties = prop(body, "properties");
  const resourceGroup = deriveResourceGroup(asString(prop(body, "id")));
  const location = asString(prop(body, "location"));
  return {
    name: input.name,
    resourceGroup: resourceGroup !== "" ? resourceGroup : input.resourceGroup,
    location: location !== "" ? location : input.location,
    customerId: asString(prop(properties, "customerId")),
  };
}

/** Input for {@link enableSentinel}. */
export interface EnableSentinelInput {
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
}

/** Result of {@link enableSentinel}. */
export interface EnableSentinelResult {
  /** True when the SecurityInsights solution already existed (no PUT sent). */
  alreadyEnabled: boolean;
  /** The workspace's actual location the solution was (or is) deployed in. */
  location: string;
  /** The solution resource name, `SecurityInsights({workspaceName})`. */
  solutionName: string;
}

/**
 * Enable Microsoft Sentinel on a workspace by creating the SecurityInsights
 * solution resource the legacy app created:
 * Microsoft.OperationsManagement/solutions named
 * `SecurityInsights({workspaceName})` at api-version 2015-11-01-preview, with
 * plan {name: same, publisher: Microsoft, product: OMSGallery/SecurityInsights,
 * promotionCode: ''} and properties.workspaceResourceId pointing at the
 * workspace.
 *
 * IDEMPOTENT PRE-CHECK (legacy behavior): a GET of the solution resource that
 * returns 2xx short-circuits to success with `alreadyEnabled: true` - no PUT
 * is sent. Any non-2xx pre-check (404 or otherwise, mirroring the legacy
 * -ErrorAction SilentlyContinue) proceeds to the PUT.
 *
 * LOCATION FIX (pinned by test): the solution is deployed in the WORKSPACE'S
 * ACTUAL location, read from the workspace resource. The legacy handler
 * hardcoded 'eastus' through a broken split expression; that defect is not
 * reproduced.
 */
export async function enableSentinel(
  azure: AzureManagement,
  input: EnableSentinelInput,
): Promise<EnableSentinelResult> {
  const workspacePath =
    `/subscriptions/${input.subscriptionId}` +
    `/resourceGroups/${input.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${input.workspaceName}`;

  const workspaceResponse = await azure.request({
    method: "GET",
    path: workspacePath,
    apiVersion: WORKSPACE_API_VERSION,
  });
  if (!is2xx(workspaceResponse.status)) {
    throw new Error(
      httpErrorText(
        `fetch workspace '${input.workspaceName}'`,
        workspaceResponse.status,
        workspaceResponse.body,
      ),
    );
  }
  const workspaceResourceId =
    asString(prop(workspaceResponse.body, "id")) !== ""
      ? asString(prop(workspaceResponse.body, "id"))
      : workspacePath;
  const location = asString(prop(workspaceResponse.body, "location"));
  if (location === "") {
    throw new Error(
      `workspace '${input.workspaceName}' reported no location; ` +
        `cannot place the SecurityInsights solution`,
    );
  }

  const solutionName = `SecurityInsights(${input.workspaceName})`;
  const solutionPath =
    `/subscriptions/${input.subscriptionId}` +
    `/resourceGroups/${input.resourceGroup}` +
    `/providers/Microsoft.OperationsManagement/solutions/${solutionName}`;

  const preCheck = await azure.request({
    method: "GET",
    path: solutionPath,
    apiVersion: SENTINEL_SOLUTION_API_VERSION,
  });
  if (is2xx(preCheck.status)) {
    return { alreadyEnabled: true, location, solutionName };
  }

  const putResponse = await azure.request({
    method: "PUT",
    path: solutionPath,
    apiVersion: SENTINEL_SOLUTION_API_VERSION,
    body: {
      location,
      plan: {
        name: solutionName,
        publisher: "Microsoft",
        product: "OMSGallery/SecurityInsights",
        promotionCode: "",
      },
      properties: { workspaceResourceId },
    },
  });
  if (!is2xx(putResponse.status)) {
    throw new Error(
      httpErrorText(
        `enable Sentinel on '${input.workspaceName}'`,
        putResponse.status,
        putResponse.body,
      ),
    );
  }
  return { alreadyEnabled: false, location, solutionName };
}

// ---------------------------------------------------------------------------
// Commit: the ONE place browsing results become the active target scope
// ---------------------------------------------------------------------------

/** The scope {@link commitTargetScope} writes into the active profile. */
export interface TargetScope {
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
}

/** Result of {@link commitTargetScope}. */
export interface CommitTargetScopeResult {
  /** The next profile store (a NEW object; the input is never mutated). */
  store: ProfileStore;
  /**
   * What the caller must invalidate (connection-invalidation semantics). A
   * pure scope change clears permission results only; identity fields are
   * untouched here, so secret and token always survive.
   */
  invalidation: InvalidationResult;
  /** False when no profile is active - nothing was committed. */
  committed: boolean;
}

/**
 * Commit a browsed scope (subscription / resource group / workspace) into the
 * ACTIVE profile's config. PURE - the caller persists the returned store and
 * applies the returned invalidation.
 *
 * MERGE, NEVER REPLACE (pinned by test): only the three scope fields change;
 * clientId, tenantId, and setupPath survive untouched, as do all other
 * profiles and the active-profile pointer. Browsing functions in this module
 * never call this - committing is always an explicit caller decision.
 *
 * When no profile is active this is a no-op: the input store is returned
 * unchanged with `committed: false` and an all-false invalidation.
 */
export function commitTargetScope(
  store: ProfileStore,
  scope: TargetScope,
): CommitTargetScopeResult {
  const active = getActiveProfile(store);
  if (active === null) {
    return {
      store,
      invalidation: {
        clearSecret: false,
        clearToken: false,
        clearPermissionResults: false,
      },
      committed: false,
    };
  }

  const previous = active.config;
  const next: AzureConfig = {
    ...previous,
    subscriptionId: scope.subscriptionId,
    resourceGroup: scope.resourceGroup,
    workspaceName: scope.workspaceName,
  };
  return {
    store: updateActiveConfig(store, next),
    invalidation: computeInvalidation(previous, next),
    committed: true,
  };
}
