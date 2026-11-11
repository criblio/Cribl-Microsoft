/**
 * validate-azure-onboarding usecase barrel (AZR-32): the READ-ONLY Validate of
 * an onboarding plan's Azure side (ADR 0007, D16).
 */

export {
  ACTIVITY_LOG_WRITTEN_UNCONFIRMED_DETAIL,
  applyActivityLogDeploy,
  applyDefenderDeploy,
  applyOnboardingDeploy,
  CANCELLED_DETAIL,
  DEFENDER_WRITTEN_UNCONFIRMED_DETAIL,
  checkKey,
  planValidation,
  stepKey,
  validateAzureOnboarding,
  verdictsForStep,
} from "./validate-azure-onboarding";
export type {
  ActivityLogDeployForValidation,
  CheckResult,
  DefenderDeployForValidation,
  DefenderWriteOutcome,
  OnboardingDeployForValidation,
  PlanValidationOptions,
  PlannedArrival,
  PlannedCheck,
  PlannedRead,
  ValidateOptions,
  ValidationPlan,
  ValidationResult,
  ValidationSignal,
  ValidationSource,
} from "./validate-azure-onboarding";
