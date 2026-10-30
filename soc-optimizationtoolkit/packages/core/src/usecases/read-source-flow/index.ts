/**
 * read-source-flow usecase barrel (AZR-33, AZR-30): the live-flow metrics read
 * and the read-only Cribl side of the onboarding diagram (ADR 0007, D15/D17).
 */

export { NO_GROUP_DETAIL, readSourceFlow } from "./read-source-flow";

export {
  CRIBL_SIDE_PATHS,
  readOnboardingCriblSide,
  routeConsumption,
} from "./read-onboarding-cribl-side";
export type {
  ConsumingRoute,
  CriblSideUnknownReason,
  InputPresence,
  OnboardingCriblInputSide,
  OnboardingCriblSide,
  OnboardingInputRef,
  QuickConnection,
  RouteConsumption,
  RouteRow,
  RoutesTable,
  WalkAssumption,
} from "./read-onboarding-cribl-side";
