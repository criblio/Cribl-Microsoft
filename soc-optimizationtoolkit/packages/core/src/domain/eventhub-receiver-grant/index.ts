/**
 * eventhub-receiver-grant domain barrel (AZR-103): the names, scopes and body
 * of the Cribl principal's Azure Event Hubs Data Receiver grant, and the
 * permissions it needs. Pure.
 */

export {
  DEFAULT_RECEIVER_GRANT_SCOPE,
  RECEIVER_GRANT_NAME_NAMESPACE,
  RECEIVER_GRANT_ROLE,
  hasReceiverGrantStamp,
  armScopeKey,
  classifyReceiverGrantRemoval,
  isReceiverGrantScope,
  parseReceiverAssignmentRow,
  receiverGrantAssignmentName,
  receiverGrantDescription,
  receiverGrantReadBackDiffs,
  receiverGrantScopeId,
} from "./receiver-grant";
export type {
  ReceiverAssignmentRow,
  ReceiverGrantRemovalRecord,
  ReceiverGrantRemovalVerdict,
  ReceiverGrantScopeChoice,
} from "./receiver-grant";
export {
  RECEIVER_GRANT_ACTIONS_NOT_MEASURED,
  RECEIVER_GRANT_ADMIN_CONDITION,
  RECEIVER_GRANT_ADMIN_ROLE,
  RECEIVER_GRANT_DELETE_ACTION,
  RECEIVER_GRANT_PERMISSIONS,
  RECEIVER_GRANT_SCOPE_ACTIONS,
} from "./receiver-grant-permissions";
