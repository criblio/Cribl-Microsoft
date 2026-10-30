/**
 * cribl-onboarding-source domain barrel (AZR-34): the Cribl input bodies the
 * onboarding screen creates (its secret body is domain/cribl-secrets'
 * buildSecretBody, re-exported, DBT-163), the non-secret descriptor of a pasted
 * Event Hub connection string, the create-only classifiers of what already
 * exists, the commit markers, and the hubs a lane reads (ADR 0007 D7-D10).
 * All pure; usecases/create-cribl-source performs the reads and writes.
 */

export {
  APP_ID,
  IDENTITY_FIELDS,
  ONBOARDING_ID_MAX,
  ONBOARDING_INPUT_ID_PREFIX,
  buildBlobInputBody,
  buildEventHubInputBody,
  buildSecretBody,
  isOnboardingInputId,
  isOnboardingSecretId,
  jsStringExpression,
  onboardingInputId,
  onboardingSecretId,
} from "./input-bodies";
export type { BlobInputSpec, EventHubInputSpec } from "./input-bodies";

export {
  checkPastedCredential,
  isInvalidConnection,
  parseEventHubConnectionString,
  sameDescriptor,
} from "./connection-string";
export type {
  ConnectionDescriptor,
  InvalidConnectionReason,
  ParsedConnection,
  PastedCredentialCheck,
  PastedCredentialContext,
  PastedCredentialRefusal,
} from "./connection-string";

export {
  COMMIT_MARKERS,
  classifyExistingInput,
  classifyExistingSecret,
  identityDiffs,
  laneTopics,
} from "./classify-existing";
export type {
  ExistingInputVerdict,
  ExistingRead,
  ExistingSecretVerdict,
  LaneTopics,
  LaneTopicsRefusal,
  OtherLane,
} from "./classify-existing";
