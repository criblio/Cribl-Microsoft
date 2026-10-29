/**
 * onboarding-dataflow domain barrel (AZR-30, AZR-32, AZR-33): the lanes the
 * onboarding dataflow diagram draws, one per chosen source, read from the
 * Azure side, the Cribl side or end to end (ADR 0007, D14 / D15).
 */

export {
  DATAFLOW_PERSPECTIVES,
  NO_HUB_ARRIVAL,
  UNKNOWN_REASON_LABEL,
  arrivalText,
  buildOnboardingLanes,
  isLaneChosen,
  laneCheckKey,
  laneMode,
  tickText,
} from "./lanes";
export type {
  BuildOnboardingLanesInput,
  CardStatus,
  CardStatusKind,
  CriblInputReading,
  CriblRouteReading,
  CriblSideReading,
  DataflowPerspective,
  EdgeFlow,
  LaneCard,
  LaneCardKind,
  LaneEdge,
  OnboardingLane,
  OnboardingLanes,
  SharedObject,
} from "./lanes";
