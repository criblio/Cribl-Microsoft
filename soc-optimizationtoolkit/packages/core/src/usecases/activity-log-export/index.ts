/**
 * activity-log-export usecase barrel (AZR-98): read the subscription's
 * diagnostic settings, and create the Activity Log setting - create-only,
 * refused when ours exists, another setting feeds the same namespace, or the
 * subscription is at Azure's limit.
 */

export {
  ACTIVITY_LOG_ITEM_ID,
  confirmEmptyListing,
  deployActivityLogExport,
  listDiagnosticSettings,
  readActivityLogState,
} from "./activity-log-export";
export type {
  ActivityLogDeployInput,
  ActivityLogDeployOutcome,
  ActivityLogDeployStep,
  ActivityLogOursReading,
  ActivityLogSettingsState,
  ActivityLogState,
  ConfirmedListing,
} from "./activity-log-export";

// AZR-105: remove the setting the app created, once proven its own.
export { removeActivityLogExport } from "./remove-activity-log-export";
export type {
  ActivityLogRemoveInput,
  ActivityLogRemoveOutcome,
  ActivityLogRemoveStep,
} from "./remove-activity-log-export";
