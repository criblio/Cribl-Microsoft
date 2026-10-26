/**
 * eventhub-arm domain module barrel (AZR-12): the shared Microsoft.EventHub
 * ARM builders and parsers that labs, eventhub-discovery and the Azure
 * onboarding screen all use. One api-version, one namespace path. All pure.
 */

export type {
  NamespaceRef,
  NamespaceSkuSettings,
  NamespaceAuthRule,
} from "./eventhub-arm";
export {
  EVENTHUB_ARM_API_VERSION,
  DEFAULT_NAMESPACE_RULE,
  eventHubNamespacePath,
  eventHubResourceId,
  buildNamespaceGetRequest,
  buildNamespacePutRequest,
  buildNamespaceHubsListRequest,
  buildHubGetRequest,
  buildHubPutRequest,
  buildHubConsumerGroupGetRequest,
  buildHubConsumerGroupPutRequest,
  buildNamespaceAuthRulesListRequest,
  parseNamespaceAuthRules,
  ruleCanSend,
  buildNamespaceListKeysRequest,
  parseListKeys,
  parseNamespaceResourceId,
  parseEventHubResourceId,
} from "./eventhub-arm";
