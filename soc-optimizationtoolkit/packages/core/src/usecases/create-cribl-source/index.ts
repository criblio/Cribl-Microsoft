/**
 * create-cribl-source usecase barrel (AZR-34): plan (read-only), then apply
 * (create-only write, read-back, kit commit and deploy, configVersion) the
 * Cribl input that receives one onboarding lane (ADR 0007 D7-D10).
 */

export {
  CRIBL_SOURCE_COMMIT_TIMEOUT_MS,
  CRIBL_SOURCE_LOG_PREFIX,
  planCriblSource,
} from "./plan-cribl-source";
export type {
  CriblSourceLane,
  CriblSourcePorts,
  PlanCredential,
  PlanCriblSourceInput,
  PlanCriblSourceResult,
  PlanRefusalReason,
  ReadyCriblSource,
} from "./plan-cribl-source";

export { applyCriblSource } from "./apply-cribl-source";
export type {
  ApplyCredential,
  ApplyCriblSourceOutcome,
  ApplyFailureStage,
  ApplyRefusalReason,
  NotDeployedKitReason,
  NotDeployedReason,
} from "./apply-cribl-source";
