/**
 * activity-log-export domain barrel (AZR-98): how this app reads a diagnostic
 * setting, and the subscription Activity Log setting it creates - create-only,
 * refused when ours exists, another setting feeds the same namespace, or the
 * subscription is at Azure's limit.
 */

export {
  parseDiagnosticSettings,
  readDiagnosticSetting,
  settingTargetsNamespace,
} from "./diagnostic-setting";
export type { DiagnosticSettingRead } from "./diagnostic-setting";

export {
  ACTIVITY_LOG_AUTO_HUB,
  ACTIVITY_LOG_CATEGORIES,
  ACTIVITY_LOG_SETTING_NAME,
  MAX_SUBSCRIPTION_DIAGNOSTIC_SETTINGS,
  SUBSCRIPTION_DIAGNOSTIC_SETTINGS_API_VERSION,
  activityLogSettingDiffs,
  activityLogSettingPath,
  buildActivityLogSettingGetRequest,
  buildActivityLogSettingPutRequest,
  buildSubscriptionDiagnosticSettingsListRequest,
  classifyOursSetting,
  describeSettingDiff,
  expectedActivityLogSetting,
  findSameNamespaceSettings,
  subscriptionDiagnosticSettingsPath,
  subscriptionSettingsFull,
} from "./activity-log-setting";
export type {
  ActivityLogSettingInput,
  ActivityLogSettingPutRequest,
  ExpectedActivityLogSetting,
  OursSettingState,
  SettingDiff,
} from "./activity-log-setting";

export {
  ACTIVITY_LOG_ACTIONS_NOT_MEASURED,
  ACTIVITY_LOG_NAMESPACE_ACTIONS,
  ACTIVITY_LOG_SUBSCRIPTION_ACTIONS,
} from "./activity-log-permissions";
