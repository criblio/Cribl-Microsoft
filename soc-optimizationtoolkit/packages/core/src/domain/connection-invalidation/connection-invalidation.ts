/**
 * Connection invalidation - WHAT TO CLEAR WHEN A CONFIG CHANGES.
 *
 * When the user edits their Azure connection, some cached artifacts become
 * stale. This module answers the question "given the previous config and the
 * next config, what must be invalidated?" as a pure function - no IO, the caller
 * (a shell) performs the actual clearing against its secrets store / token cache
 * / permission-results cache.
 *
 * Two axes of change matter:
 *
 *   IDENTITY (tenantId, clientId) - a different tenant/client is a different app
 *   registration. The old client secret belongs to the old registration and is
 *   now invalid; the old ARM token was minted for the old tenant; and any cached
 *   permission results were computed for the old identity. => clear everything.
 *
 *   SCOPE (subscriptionId, resourceGroup, workspaceName) - the identity is
 *   unchanged, only the target moved. An ARM client_credentials token is
 *   tenant-scoped, so it survives a subscription/RG/workspace change; the secret
 *   is likewise still valid. Only the cached permission results - which are
 *   evaluated against a specific scope - go stale. => clear results only.
 *
 * Identity comparison is case-insensitive after trimming (Azure GUIDs are
 * case-insensitive and stray surrounding whitespace should not read as a real
 * change). Scope comparison is exact.
 *
 * Pure: no IO, no fetch, no React.
 */

import type { AzureConfig } from "../azure-config";

/**
 * The three cached artifacts a config change may invalidate. Each flag is true
 * when the corresponding artifact must be cleared.
 */
export interface InvalidationResult {
  /** Clear the stored client secret (the encrypted `azureBasic` entry). */
  clearSecret: boolean;
  /** Clear the cached ARM access token. */
  clearToken: boolean;
  /** Clear cached permission-check results. */
  clearPermissionResults: boolean;
}

/** Normalize an identity field: trim then lowercase (GUIDs are case-blind). */
function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Compute what to invalidate when moving from `prev` to `next`.
 *
 * - Identity changed (tenantId or clientId differ after trim+lowercase) ->
 *   `{ clearSecret: true, clearToken: true, clearPermissionResults: true }`.
 * - Otherwise, scope changed (subscriptionId, resourceGroup, or workspaceName
 *   differ exactly) -> `{ false, false, clearPermissionResults: true }`.
 * - Otherwise nothing changed -> all three false.
 */
export function computeInvalidation(
  prev: AzureConfig,
  next: AzureConfig,
): InvalidationResult {
  const identityChanged =
    normalizeIdentity(prev.tenantId) !== normalizeIdentity(next.tenantId) ||
    normalizeIdentity(prev.clientId) !== normalizeIdentity(next.clientId);

  if (identityChanged) {
    return {
      clearSecret: true,
      clearToken: true,
      clearPermissionResults: true,
    };
  }

  const scopeChanged =
    prev.subscriptionId !== next.subscriptionId ||
    prev.resourceGroup !== next.resourceGroup ||
    prev.workspaceName !== next.workspaceName;

  if (scopeChanged) {
    return {
      clearSecret: false,
      clearToken: false,
      clearPermissionResults: true,
    };
  }

  return {
    clearSecret: false,
    clearToken: false,
    clearPermissionResults: false,
  };
}
