/**
 * validate-azure-onboarding usecase barrel (AZR-32): the READ-ONLY Validate of
 * an onboarding plan's Azure side (ADR 0007, D16).
 */

export {
  CANCELLED_DETAIL,
  checkKey,
  planValidation,
  stepKey,
  validateAzureOnboarding,
  verdictsForStep,
} from "./validate-azure-onboarding";
export type {
  CheckResult,
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
