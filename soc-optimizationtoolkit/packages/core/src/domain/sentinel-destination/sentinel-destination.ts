/**
 * Cribl "sentinel" (Microsoft Sentinel / Azure Logs Ingestion) destination
 * config builder.
 *
 * Field set mined from TWO sources:
 *   - The OutputSentinel schema in assets/cribl-openapi.json - AUTHORITATIVE
 *     for field names and enums (type "sentinel", endpointURLConfiguration
 *     "url"|"ID", authType "oauth", dcrID, dceEndpoint, streamName,
 *     loginUrl/secret/client_id/scope; required: type,
 *     endpointURLConfiguration, loginUrl, secret, client_id).
 *   - The legacy generator Azure/CustomDeploymentTemplates/DCR-Automation/
 *     core/Generate-CriblDestinations.ps1 + core/dst-cribl-template.json -
 *     informs the VALUES: scope https://monitor.azure.com/.default, loginUrl
 *     https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token,
 *     endpointURLConfiguration "ID", keepAlive/concurrency/backpressure
 *     defaults, the single-quoted client_id (the OpenAPI documents client_id
 *     as a JavaScript EXPRESSION, so the legacy emits the id wrapped in
 *     single quotes to make it a string constant), the composed `url`, and
 *     the "<replace me>" secret placeholder.
 *
 * SECRET HANDLING - READ THIS: `ingestionClientSecret` is TRANSIENT input.
 * The platform's encrypted KV entries are WRITE-ONLY (GET returns 403
 * "Cannot read encrypted value"), so the app can NEVER read a stored secret
 * back to inject it here. The caller either passes the secret through from
 * live user input in the same interaction, or omits it and ships the
 * "<replace me>" placeholder for the operator to fill in inside Cribl Stream
 * (exactly what the legacy generator does). Never persist the real secret in
 * job records, artifacts, or logs.
 *
 * Pure: no IO, no fetch, no React, no Date/Math.random/crypto.
 */

/**
 * The literal placeholder the legacy generator writes into `secret` when no
 * client secret is supplied ("Client Secret - Always use <replace me>
 * placeholder" in Generate-CriblDestinations.ps1).
 */
export const SENTINEL_SECRET_PLACEHOLDER = "<replace me>";

/** OAuth scope for the Azure Monitor Logs Ingestion API (legacy template). */
export const SENTINEL_OAUTH_SCOPE = "https://monitor.azure.com/.default";

/**
 * api-version of the Logs Ingestion endpoint baked into the composed `url`
 * field (legacy dst-cribl-template.json).
 */
export const SENTINEL_INGESTION_API_VERSION = "2021-11-01-preview";

/** Input for {@link buildSentinelDestination}. */
export interface SentinelDestinationInput {
  /** Cribl output id, e.g. "MS-Sentinel-SecurityEvent-dest". */
  id: string;
  /** properties.immutableId of the deployed DCR ("dcr-..."). */
  dcrImmutableId: string;
  /**
   * The DCR's logs-ingestion endpoint URL, e.g.
   * "https://dcr-name-abcd.eastus-1.ingest.monitor.azure.com".
   */
  ingestionEndpoint: string;
  /** DCR input stream name: "Custom-{Table}". */
  streamName: string;
  /** Entra ID tenant id used to compose the OAuth loginUrl. */
  tenantId: string;
  /** App-registration client id used for ingestion (emitted single-quoted). */
  ingestionClientId: string;
  /**
   * TRANSIENT client secret - see the module doc. When absent or empty the
   * config ships {@link SENTINEL_SECRET_PLACEHOLDER} and the operator pastes
   * the real secret into Cribl Stream manually.
   */
  ingestionClientSecret?: string | null;
}

/**
 * POST body for /system/outputs creating an OutputSentinel destination.
 * Field names/enums per the vendored OpenAPI; values per the legacy
 * generator.
 */
export interface SentinelDestinationConfig {
  id: string;
  type: "sentinel";
  systemFields: string[];
  streamtags: string[];
  keepAlive: boolean;
  concurrency: number;
  maxPayloadSizeKB: number;
  maxPayloadEvents: number;
  compress: boolean;
  rejectUnauthorized: boolean;
  timeoutSec: number;
  flushPeriodSec: number;
  useRoundRobinDns: boolean;
  failedRequestLoggingMode: string;
  safeHeaders: string[];
  responseRetrySettings: unknown[];
  timeoutRetrySettings: { timeoutRetry: boolean };
  responseHonorRetryAfterHeader: boolean;
  onBackpressure: string;
  authType: "oauth";
  scope: string;
  endpointURLConfiguration: "url" | "ID";
  dceEndpoint: string;
  dcrID: string;
  streamName: string;
  /** JavaScript expression: the client id wrapped in single quotes. */
  client_id: string;
  secret: string;
  loginUrl: string;
  url: string;
}

/** Error thrown when a required input field is missing or blank. */
export class SentinelDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SentinelDestinationError";
  }
}

/** Strip scheme and path from an endpoint URL, leaving just the host. */
function endpointHost(endpoint: string): string {
  return endpoint
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "");
}

function requireNonBlank(value: string, field: string): string {
  if (value.trim() === "") {
    throw new SentinelDestinationError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Build the Cribl OutputSentinel destination config (the POST body for
 * /system/outputs) from a deployed Direct DCR.
 *
 * The returned object reproduces the legacy dst-cribl-template.json field
 * set: endpointURLConfiguration "ID" with dceEndpoint/dcrID/streamName as the
 * operative routing fields, plus the fully composed `url` the legacy
 * template also carries (harmless under "ID" configuration, kept for
 * fidelity). `authType` "oauth" is added explicitly - it is the only value
 * the OpenAPI enum admits and the legacy template relied on it as the
 * implicit default.
 *
 * @throws SentinelDestinationError when any required input string is blank.
 */
export function buildSentinelDestination(
  input: SentinelDestinationInput,
): SentinelDestinationConfig {
  const id = requireNonBlank(input.id, "id");
  const dcrImmutableId = requireNonBlank(input.dcrImmutableId, "dcrImmutableId");
  const ingestionEndpoint = requireNonBlank(
    input.ingestionEndpoint,
    "ingestionEndpoint",
  );
  const streamName = requireNonBlank(input.streamName, "streamName");
  const tenantId = requireNonBlank(input.tenantId, "tenantId");
  const ingestionClientId = requireNonBlank(
    input.ingestionClientId,
    "ingestionClientId",
  );

  const secret =
    input.ingestionClientSecret != null && input.ingestionClientSecret !== ""
      ? input.ingestionClientSecret
      : SENTINEL_SECRET_PLACEHOLDER;

  const host = endpointHost(ingestionEndpoint);

  return {
    id,
    systemFields: [],
    streamtags: [],
    keepAlive: true,
    concurrency: 5,
    maxPayloadSizeKB: 1000,
    maxPayloadEvents: 0,
    compress: true,
    rejectUnauthorized: true,
    timeoutSec: 30,
    flushPeriodSec: 1,
    useRoundRobinDns: false,
    failedRequestLoggingMode: "none",
    safeHeaders: [],
    responseRetrySettings: [],
    timeoutRetrySettings: { timeoutRetry: false },
    responseHonorRetryAfterHeader: false,
    onBackpressure: "drop",
    authType: "oauth",
    scope: SENTINEL_OAUTH_SCOPE,
    endpointURLConfiguration: "ID",
    type: "sentinel",
    dceEndpoint: ingestionEndpoint,
    dcrID: dcrImmutableId,
    streamName,
    client_id: `'${ingestionClientId}'`,
    secret,
    loginUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    url:
      `https://${host}/dataCollectionRules/${dcrImmutableId}` +
      `/streams/${streamName}?api-version=${SENTINEL_INGESTION_API_VERSION}`,
  };
}

/**
 * The legacy destination-id convention: IDprefix + sanitized table +
 * IDsuffix with the shipped cribl-parameters.json defaults ("MS-Sentinel-",
 * "-dest"). Sanitization mirrors New-CriblDestinationConfig: strip one
 * trailing "_CL" (case-insensitive, PowerShell -replace '_CL$'), then map
 * every non-alphanumeric character to "_".
 */
export function defaultSentinelDestinationId(table: string): string {
  const sanitized = table.replace(/_CL$/i, "").replace(/[^a-zA-Z0-9]/g, "_");
  return `MS-Sentinel-${sanitized}-dest`;
}
