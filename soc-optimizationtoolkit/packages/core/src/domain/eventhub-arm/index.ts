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
  namespaceRuleResourceId,
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
  ruleCanListen,
  ruleCanManage,
  ruleSafeForCriblSource,
  ROOT_MANAGE_RULE_NAME,
  namespaceSupportsKafka,
  buildNamespaceListKeysRequest,
  parseListKeys,
  parseNamespaceResourceId,
  parseEventHubResourceId,
  EVENT_HUB_RECEIVER_ROLES,
  EVENT_HUB_OVERPRIVILEGED_ROLES,
  overprivilegedRoleCovering,
  receiverRoleCovering,
} from "./eventhub-arm";
