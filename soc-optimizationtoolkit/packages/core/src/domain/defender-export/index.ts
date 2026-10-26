/**
 * defender-export domain barrel (AZR-3): Defender for Cloud continuous export
 * to an Event Hub. Plans are read and never written; the automation is
 * created only, never replaced, and recognised by name in any resource group;
 * the actions it needs are stated per scope and not yet measured. All pure.
 */

export {
  DEFENDER_PLANS,
  SECURITY_PRICINGS_API_VERSION,
  STANDARD_TIER,
  anyStandard,
  buildPricingsListRequest,
  parsePricings,
} from "./defender-plans";
export type {
  DefenderPlan,
  PlanStatus,
  PricingsRead,
  PricingsResult,
  PricingsUnreadable,
  UnrecognizedPricing,
} from "./defender-plans";

export {
  ALERTS_EVENT_SOURCE,
  DEFENDER_EXPORT_DESCRIPTION,
  DEFENDER_EXPORT_NAME,
  EVENTHUB_ACTION_TYPE,
  SECURITY_AUTOMATIONS_API_VERSION,
  automationDiffs,
  automationMatches,
  buildAutomationGetByIdRequest,
  buildAutomationPutRequest,
  buildSubscriptionAutomationsListRequest,
  classifyOurs,
  defenderExportPath,
  expectedExportFor,
  findSameTargetExports,
  parseAutomation,
  parseAutomations,
  subscriptionScopePath,
} from "./defender-automation";
export type {
  AutomationAction,
  DefenderAutomation,
  DefenderExportInput,
  DefenderExportPutRequest,
  ExpectedExport,
  OursState,
} from "./defender-automation";

export {
  DEFENDER_ACTIONS_NOT_MEASURED,
  DEFENDER_NAMESPACE_ACTIONS,
  DEFENDER_SUBSCRIPTION_ACTIONS,
} from "./defender-permissions";
