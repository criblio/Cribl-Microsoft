/**
 * Azure configuration codec - NON-SECRET CONFIG SERIALIZATION CONTRACT.
 *
 * The setup wizard persists the caller's Azure identity/config so it can be
 * rehydrated on the next launch. That persisted blob carries ONLY non-secret
 * fields: clientId, tenantId, subscriptionId, resourceGroup, workspaceName, and
 * the chosen setupPath. It NEVER carries the client secret.
 *
 * The client secret lives exclusively inside the encrypted, write-only
 * `azureBasic` secrets-store entry. It is never serialized here, never read
 * back, and must never be reconstructable from anything this codec emits. This
 * separation is the whole point of the module: config round-trips in plaintext,
 * the secret does not travel with it.
 *
 * {@link parseAzureConfig} is deliberately TOLERANT and TOTAL: it accepts any
 * untrusted string (or null/undefined) and always returns a well-formed
 * {@link AzureConfig}, never throwing. Any unexpected keys in the incoming
 * payload - including a stray `clientSecret` or `accessToken` planted by a
 * malicious or stale blob - are dropped and never surfaced on the result.
 *
 * Pure: no IO, no fetch, no React.
 */

/**
 * The setup paths the config codec records. Distinct from the more granular
 * `SetupPath` in azure-permissions: this is the coarse choice persisted with
 * the user's config, not the per-scope permission-check variant.
 *
 * - `existing`  - point at an existing subscription/resource group.
 * - `lab-new-rg` - provision a brand-new lab resource group.
 * - `lab-byo-rg` - use a pre-created (bring-your-own) lab resource group.
 */
export type AzureSetupPath = "existing" | "lab-new-rg" | "lab-byo-rg";

/** The three valid {@link AzureSetupPath} values, for runtime validation. */
const VALID_SETUP_PATHS: readonly AzureSetupPath[] = [
  "existing",
  "lab-new-rg",
  "lab-byo-rg",
];

/**
 * The persisted, non-secret Azure configuration.
 *
 * NOTE: there is intentionally NO secret field. The client secret is stored
 * separately in the encrypted, write-only `azureBasic` secrets-store entry and
 * is never carried by this interface.
 */
export interface AzureConfig {
  /** Azure AD application (client) ID. Non-secret. */
  clientId: string;
  /** Azure AD tenant (directory) ID. Non-secret. */
  tenantId: string;
  /** Target subscription ID. Non-secret. */
  subscriptionId: string;
  /** Target resource group name. Non-secret. */
  resourceGroup: string;
  /**
   * Target Log Analytics workspace name. Non-secret. Primarily relevant to the
   * `existing` full-deployment path, where the workspace must be pinned.
   */
  workspaceName: string;
  /** The coarse setup path the user selected. */
  setupPath: AzureSetupPath;
}

/**
 * The canonical empty config: every string blank and the setupPath defaulted to
 * `existing`. Returned by {@link parseAzureConfig} for any unusable input, and
 * usable as an initial value for an unconfigured wizard.
 */
export const EMPTY_AZURE_CONFIG: AzureConfig = {
  clientId: "",
  tenantId: "",
  subscriptionId: "",
  resourceGroup: "",
  workspaceName: "",
  setupPath: "existing",
};

/**
 * Serialize exactly the six non-secret {@link AzureConfig} fields to JSON.
 *
 * Only the known fields are emitted - even if the caller's object carries extra
 * properties (a leaked secret, say), they are not written out.
 */
export function serializeAzureConfig(config: AzureConfig): string {
  const canonical: AzureConfig = {
    clientId: config.clientId,
    tenantId: config.tenantId,
    subscriptionId: config.subscriptionId,
    resourceGroup: config.resourceGroup,
    workspaceName: config.workspaceName,
    setupPath: config.setupPath,
  };
  return JSON.stringify(canonical);
}

/** True when `value` is a plain (non-null, non-array) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce an unknown field to a string, using '' for anything not a string. */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Narrow an unknown to a valid {@link AzureSetupPath}, else `existing`. */
function asSetupPath(value: unknown): AzureSetupPath {
  return VALID_SETUP_PATHS.includes(value as AzureSetupPath)
    ? (value as AzureSetupPath)
    : "existing";
}

/**
 * Parse an untrusted config blob into a well-formed {@link AzureConfig}.
 *
 * TOLERANT and TOTAL - NEVER throws. Returns {@link EMPTY_AZURE_CONFIG} for:
 *   - null / undefined
 *   - the empty or whitespace-only string
 *   - a string that is not valid JSON
 *   - valid JSON that is not a plain object (arrays, numbers, strings, null)
 *
 * For a valid plain object, each string field is copied only if it is actually
 * a string (otherwise ''), and setupPath is copied only if it is one of the
 * three valid values (otherwise 'existing'). A stored config missing
 * `workspaceName` (e.g. one written before this field existed) parses to ''.
 * Any unexpected extra keys - a stray `clientSecret`, `accessToken`, or
 * anything else - are ignored and never appear on the returned config.
 */
export function parseAzureConfig(raw: string | null | undefined): AzureConfig {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ...EMPTY_AZURE_CONFIG };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_AZURE_CONFIG };
  }

  if (!isPlainObject(parsed)) {
    return { ...EMPTY_AZURE_CONFIG };
  }

  // Only the six known fields are read; every other key is dropped, so a
  // planted clientSecret/accessToken can never leak onto the result.
  return {
    clientId: asString(parsed.clientId),
    tenantId: asString(parsed.tenantId),
    subscriptionId: asString(parsed.subscriptionId),
    resourceGroup: asString(parsed.resourceGroup),
    workspaceName: asString(parsed.workspaceName),
    setupPath: asSetupPath(parsed.setupPath),
  };
}

/**
 * Whether the config carries enough non-secret fields to proceed.
 *
 * "Complete enough to acquire a token" (`forToken` true, the default) means the
 * two fields the token request keys on are present: `clientId` and `tenantId`.
 * The client secret is deliberately NOT checked here - it lives in the
 * encrypted, write-only `azureBasic` entry and is never carried by AzureConfig,
 * so token-readiness of this config is defined purely by the identity fields.
 *
 * "Complete for a full deployment" (`forToken` false) additionally requires the
 * target to be pinned: `subscriptionId` and `resourceGroup` must also be set.
 *
 * NOTE: `workspaceName` is intentionally NOT required here. On the `existing`
 * full-deployment path the workspace is the ingestion target and a caller may
 * additionally gate on it, but that is a path-specific concern layered on top of
 * this check; this function stays deliberately un-over-constrained so the lab
 * paths (which mint their own workspace) are not blocked by a blank field.
 *
 * @param forToken - true (default) checks token-acquisition readiness; false
 *   checks full-deployment readiness.
 */
export function isAzureConfigComplete(
  config: AzureConfig,
  forToken = true,
): boolean {
  const hasIdentity = config.clientId !== "" && config.tenantId !== "";
  if (forToken) {
    return hasIdentity;
  }
  return (
    hasIdentity &&
    config.subscriptionId !== "" &&
    config.resourceGroup !== ""
  );
}
