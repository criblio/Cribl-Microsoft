export {
  buildSentinelDestination,
  criblSecretReference,
  defaultSentinelDestinationId,
  destinationEmbedsSecret,
  sentinelClientSecretId,
  SENTINEL_SECRET_ID_MAX,
  rewriteIngestionEndpoint,
  sanitizeDestinationTable,
  SentinelDestinationError,
  HANDLER_CONTROL_HOST_FRAGMENT,
  parseOutputListing,
  INGEST_HOST_FRAGMENT,
  SENTINEL_INGESTION_API_VERSION,
  SENTINEL_OAUTH_SCOPE,
  SENTINEL_SECRET_PLACEHOLDER,
} from "./sentinel-destination";
export { parseSentinelOutputs } from "./existing-outputs";
export type {
  SentinelBindableField,
  SentinelEndpointMode,
  SentinelOutputRow,
  SentinelOutputsResult,
  SentinelSecretKind,
} from "./existing-outputs";
export type {
  ExistingOutput,
  SentinelDestinationConfig,
  SentinelDestinationInput,
} from "./sentinel-destination";
