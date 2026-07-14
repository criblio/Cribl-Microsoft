/**
 * Azure targeting state - the PURE decisions behind the AzureTargetingScreen
 * (porting-plan Unit 2, GUI-10 / GUI-28 Azure half), kept out of the component
 * so they are unit-testable without a DOM:
 *
 *   - {@link sanitizeResourceGroupName}: the LEGACY input rule for the
 *     create-new-RG field, mined verbatim from SentinelIntegration.tsx
 *     (`value.replace(/[^a-zA-Z0-9_\-().]/g, '')`).
 *   - {@link validateResourceGroupName}: the honest pre-submit check the
 *     legacy field lacked (Azure's own limits: 1-90 chars, no trailing
 *     period), so a rejected name fails in the form, not in ARM.
 *   - {@link buildLoaderPlan}: the ONE-LOADER contract. The legacy page ran
 *     THREE overlapping load effects (subscriptions, workspaces, resource
 *     groups) that raced each other; here a single effect derives what to
 *     fetch from one pure plan, and the tests pin that offline mode fetches
 *     nothing and that browsing a subscription reloads dependents only.
 *   - {@link commitNoticeText}: the invalidation consequences surfaced when a
 *     browsed scope is COMMITTED (connection-bar notice pattern), mapped from
 *     the @soc/core connection-invalidation result.
 *   - {@link formatScopeChip}: the compact committed-scope chip text shown in
 *     the frame topBar area next to the connection bar.
 *   - {@link parseTargetScope} / {@link serializeTargetScope}: the tolerant
 *     codec the local shell persists its committed scope override with.
 *
 * Pure: no IO, no fetch, no React.
 */

import type { InvalidationResult, TargetScope } from "@soc/core";

// ---------------------------------------------------------------------------
// Resource-group name rules
// ---------------------------------------------------------------------------

/**
 * Azure's resource-group name length limit (management.azure.com rejects
 * anything longer than 90 characters).
 */
export const RESOURCE_GROUP_MAX_LENGTH = 90;

/**
 * Sanitize a create-new-RG input keystroke stream: strip every character the
 * legacy field stripped. LEGACY RULE MINED VERBATIM from
 * SentinelIntegration.tsx line 2902: letters, digits, underscore, hyphen,
 * parentheses, and period survive; everything else (spaces included) is
 * removed as the user types.
 */
export function sanitizeResourceGroupName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_\-().]/g, "");
}

/**
 * Validate an already-sanitized resource-group name before submitting it to
 * ARM. Returns the human-readable problem, or null when the name is valid.
 * The legacy field submitted anything non-empty and let ARM reject it; these
 * are Azure's documented rules surfaced up front:
 *   - must not be empty
 *   - at most {@link RESOURCE_GROUP_MAX_LENGTH} characters
 *   - must not end with a period
 */
export function validateResourceGroupName(name: string): string | null {
  if (name === "") {
    return "Enter a resource group name.";
  }
  if (name.length > RESOURCE_GROUP_MAX_LENGTH) {
    return `Resource group names are limited to ${RESOURCE_GROUP_MAX_LENGTH} characters (this one is ${name.length}).`;
  }
  if (name.endsWith(".")) {
    return "Resource group names must not end with a period.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The one-loader plan
// ---------------------------------------------------------------------------

/** Input to {@link buildLoaderPlan}: what the screen currently shows. */
export interface LoaderPlanInput {
  /** Air-gapped/offline branch: free-text scope entry, NOTHING is fetched. */
  offline: boolean;
  /** The subscription currently being browsed ('' = none selected yet). */
  subscriptionId: string;
  /** Bumped by the Refresh button and after create actions. */
  reloadNonce: number;
}

/**
 * What the screen's SINGLE loader effect should fetch. Each key is compared
 * against the last key actually loaded; '' means "do not fetch this at all".
 */
export interface LoaderPlan {
  /** Key for the subscriptions list ('' = skip). */
  subscriptionsKey: string;
  /** Key for the workspaces + resource-group choices of one subscription. */
  dependentsKey: string;
}

/**
 * Derive the loader plan for the current screen state. THE one-loader
 * contract (the legacy page had three overlapping effects; this plan feeds
 * exactly one):
 *   - offline: nothing is ever fetched (both keys '').
 *   - online: subscriptions load once per reloadNonce; dependents (workspaces
 *     + resource groups) load once per (reloadNonce, subscription) and only
 *     when a subscription is selected.
 */
export function buildLoaderPlan(input: LoaderPlanInput): LoaderPlan {
  if (input.offline) {
    return { subscriptionsKey: "", dependentsKey: "" };
  }
  return {
    subscriptionsKey: `subs:${input.reloadNonce}`,
    dependentsKey:
      input.subscriptionId === ""
        ? ""
        : `dep:${input.reloadNonce}:${input.subscriptionId}`,
  };
}

// ---------------------------------------------------------------------------
// Commit notice (connection-bar notice pattern)
// ---------------------------------------------------------------------------

/**
 * The user-facing consequence line for a committed target scope, from the
 * @soc/core connection-invalidation result. Returns '' when nothing was
 * invalidated (the scope was already committed); callers render their own
 * "unchanged" line for that case.
 *
 * A pure scope commit only ever sets clearPermissionResults, but the mapping
 * is total: should a caller ever route an identity change through it, the
 * secret/token consequence is stated rather than silently ignored.
 */
export function commitNoticeText(invalidation: InvalidationResult): string {
  if (invalidation.clearSecret || invalidation.clearToken) {
    return (
      "Connection identity changed - the stored client secret and ARM token were " +
      "cleared. Re-enter the client secret and reconnect before deploying."
    );
  }
  if (invalidation.clearPermissionResults) {
    return (
      "Target scope committed. Cached permission results are stale for the new " +
      "scope - re-run the permission validation before deploying."
    );
  }
  return "";
}

// ---------------------------------------------------------------------------
// Committed-scope chip
// ---------------------------------------------------------------------------

/**
 * Compact one-line rendering of the COMMITTED scope for the frame topBar
 * chip: `workspace @ resourceGroup (subscription)`. Missing pieces render as
 * explicit placeholders so a half-configured target is visible at a glance;
 * a fully empty scope reads as "no target committed".
 */
export function formatScopeChip(scope: TargetScope): string {
  const { subscriptionId, resourceGroup, workspaceName } = scope;
  if (subscriptionId === "" && resourceGroup === "" && workspaceName === "") {
    return "no target committed";
  }
  const ws = workspaceName === "" ? "(no workspace)" : workspaceName;
  const rg = resourceGroup === "" ? "(no resource group)" : resourceGroup;
  const sub = subscriptionId === "" ? "(no subscription)" : subscriptionId;
  return `${ws} @ ${rg} (${sub})`;
}

// ---------------------------------------------------------------------------
// TargetScope codec (local-shell scope override persistence)
// ---------------------------------------------------------------------------

/**
 * Serialize a committed scope for persistence. Emits exactly the three known
 * fields; extra properties on the caller's object are never written out.
 * Round-trips through {@link parseTargetScope}.
 */
export function serializeTargetScope(scope: TargetScope): string {
  return JSON.stringify({
    subscriptionId: scope.subscriptionId,
    resourceGroup: scope.resourceGroup,
    workspaceName: scope.workspaceName,
  });
}

/** True when `value` is a plain (non-null, non-array) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce an unknown field to a string, '' for anything not a string. */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Parse an untrusted persisted blob into a committed scope. TOLERANT and
 * TOTAL - never throws. Returns null for null/undefined, blank strings,
 * malformed JSON, non-objects, and objects where all three fields end up
 * empty (an empty override must read as "nothing committed", not as a
 * committed blank scope that would wipe the base config's fields).
 */
export function parseTargetScope(
  raw: string | null | undefined,
): TargetScope | null {
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }
  const scope: TargetScope = {
    subscriptionId: asString(parsed["subscriptionId"]),
    resourceGroup: asString(parsed["resourceGroup"]),
    workspaceName: asString(parsed["workspaceName"]),
  };
  if (
    scope.subscriptionId === "" &&
    scope.resourceGroup === "" &&
    scope.workspaceName === ""
  ) {
    return null;
  }
  return scope;
}
