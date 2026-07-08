/**
 * eventhub-discovery domain module barrel - roadmap Phase 4 (EVH-03 inventory
 * + LOG-16 Cribl source generation). The pure request/parse/generate half;
 * fetching lives in usecases/discover-event-hubs. All pure.
 */

export type {
  EventHubNamespaceInfo,
  EventHubInfo,
} from "./eventhub-discovery";
export {
  RESOURCE_GRAPH_API_VERSION,
  EVENTHUB_API_VERSION,
  EVENTHUB_NAMESPACES_KQL,
  EH_DEFAULT_CONSUMER_GROUP,
  EH_SECRET_PLACEHOLDER,
  resourceGraphRequest,
  parseNamespacesResponse,
  listEventHubsRequest,
  parseEventHubItem,
  sanitizeEhId,
  ehSecretName,
  buildEventHubSourceConfig,
  buildConnectionStringsReference,
} from "./eventhub-discovery";
