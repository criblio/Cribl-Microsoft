/**
 * onboarding-validation domain barrel (AZR-32): the READ-ONLY checks Validate
 * makes against the Azure side of an onboarding plan - the GETs per check kind
 * and the classifiers that turn their reads into verdicts, plus the hub
 * arrival reading. All pure; the usecase performs the reads.
 *
 * planNamespace and managementGroupScope stay module-internal: onboarding-
 * howto-steps exports names of its own with those spellings, and the core
 * root barrel re-exports both with `export *`.
 */

export {
  AUDIT_ASSIGNMENT_NAME,
  CHECK_REQUIRED_VALUES,
  CUSTOM_POLICY_DEFINITIONS_FILTER,
  DEFAULT_ARRIVAL_WINDOW,
  POLICY_REMEDIATIONS_API_VERSION,
  SECURITY_PROVIDER_NAMESPACE,
  STORAGE_READER_ROLES,
  SUBSCRIPTION_DIAGNOSTIC_SETTINGS_API_VERSION,
  arrivalRequestFor,
  checkExpectationsFor,
  communitySetDefinitionId,
  planStorageAccountId,
  requestsFor,
} from "./requests";
export type {
  ArrivalRequest,
  CheckExpectations,
  CheckReadShape,
  CheckRequest,
  CheckRequests,
  PolicyExpectation,
} from "./requests";

export {
  GET_BY_NAME_KINDS,
  POLICY_IDENTITY_ROLES_DETAIL,
  XDR_UNMEASURABLE_DETAIL,
  classifyArrival,
  classifyHubArrival,
  classifyCheck,
  measuredHubNames,
  refusalReason,
} from "./classify";
