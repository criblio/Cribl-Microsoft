/**
 * capability-enablers domain barrel (CAP-2, CAP-3): the Azure write actions
 * the capability audit measures ahead of the Azure Policy logging feature.
 * Pure.
 */

export {
  ENABLER_SUBSCRIPTION_ACTIONS,
  ENABLER_SUBSCRIPTION_OPERATIONS,
  MANAGED_IDENTITY_WRITE,
  POLICY_ASSIGNMENTS_WRITE,
  POLICY_REMEDIATIONS_WRITE,
} from "./enabler-actions";
export type { EnablerOperation } from "./enabler-actions";
