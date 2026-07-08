/**
 * eventhub-discovery domain module barrel - roadmap Phase 4 (EVH-03 inventory
 * + LOG-16 Cribl source generation). The pure request/parse/generate half;
 * fetching lives in usecases/discover-event-hubs. All pure.
 */

export type {
  EventHubNamespaceInfo,
  EventHubInfo,
  DiagnosticSettingSender,
  HubActivity,
  HubFindings,
  EhActivityStatistics,
} from "./eventhub-discovery";
export {
  RESOURCE_GRAPH_API_VERSION,
  EVENTHUB_API_VERSION,
  EVENTHUB_NAMESPACES_KQL,
  EH_DEFAULT_CONSUMER_GROUP,
  EH_SECRET_PLACEHOLDER,
  EVENTHUB_DIAG_SETTINGS_KQL,
  METRICS_API_VERSION,
  EH_ACTIVITY_LOOKBACK_DAYS,
  EH_HIGH_VOLUME_PER_SOURCE,
  resourceGraphRequest,
  parseNamespacesResponse,
  parseDiagSettingsResponse,
  sendersForHub,
  metricsRequest,
  parseIncomingMessagesTotal,
  analyzeHubFindings,
  deriveEhStatistics,
  listEventHubsRequest,
  parseEventHubItem,
  sanitizeEhId,
  ehSecretName,
  buildEventHubSourceConfig,
  buildConnectionStringsReference,
} from "./eventhub-discovery";
