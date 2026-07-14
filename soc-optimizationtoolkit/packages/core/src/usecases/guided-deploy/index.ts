/**
 * guided-deploy usecase barrel - porting-plan Unit 20 (ENG-10, ENG-35 deltas,
 * ENG-39 full multi-source orchestrator, GUI-13/14/15/16).
 *
 * The GUIDED DEPLOY: the multi-source orchestrator plus the pure building blocks
 * it composes - route-discriminator auto-detection, pack-name version bump, the
 * CrowdStrike FDR breaker literal, the shared destination wiring + the one
 * secret convention, the ROUTE-ORDER source wiring, the air-gap archive, and the
 * mode-aware unlock chain that integrates additively with integrate-arc.
 */

// The orchestrator
export {
  guidedDeploy,
  guidedDeployKey,
  guidedDeployStepsFor,
  guidedDeployStepName,
  GuidedDeployBusyError,
  GUIDED_DEPLOY_JOB_KIND,
  GUIDED_DEPLOY_STEP_PREFIX,
  AIR_GAP_ARCHIVE_MIME,
} from "./guided-deploy";
export type {
  GuidedDeploySource,
  GuidedDeployScope,
  GuidedDeployContext,
  GuidedDeployInput,
  GuidedDeployPorts,
  GuidedDeployCollaborators,
  GuidedDeployOutcome,
  GuidedDeploySourceResult,
  DeploySourceResult,
  BuildSourcePackResult,
  PublishPackResult,
} from "./guided-deploy";

// Route-discriminator auto-detection (3 strategies)
export {
  detectRouteDiscriminator,
  discriminatorFilter,
  LOGTYPE_FALLBACK_FIELD,
} from "./route-discriminator";
export type {
  DiscriminatorSample,
  DiscriminatorStrategy,
  RouteDiscriminator,
} from "./route-discriminator";

// Pack-name auto version bump
export { bumpPackVersion, DEFAULT_PACK_VERSION } from "./pack-version";

// CrowdStrike FDR breaker literal (core data)
export {
  buildCrowdStrikeFdrBreaker,
  buildFdrBreakerRequest,
  isCrowdStrikeVendor,
  CROWDSTRIKE_FDR_BREAKER_ID,
  BREAKERS_API_PATH,
} from "./fdr-breaker";
export type {
  CrowdStrikeFdrBreaker,
  CrowdStrikeFdrBreakerRule,
} from "./fdr-breaker";

// The one secret convention + ensure-secret
export {
  buildEnsureSecretRequest,
  buildUpdateSecretRequest,
  SENTINEL_CLIENT_SECRET_NAME,
  SENTINEL_CLIENT_SECRET_REFERENCE,
  SECRETS_API_PATH,
} from "./secret-provisioning";

// Source wiring - the ROUTE ORDER SEMANTICS
export {
  planSourceWiring,
  prependRoutes,
} from "./source-wiring";
export type {
  CriblDeploymentType,
  LakeFederation,
  RouteEntry,
  SourceWiringInput,
  SourceWiringPlan,
} from "./source-wiring";

// The wiring applier
export {
  wireSource,
  ROUTES_API_PATH,
  LAKE_DATASETS_API_PATH,
  COMMIT_API_PATH,
  deployApiPath,
} from "./wire-source";
export type { WireSourcePorts, WireSourceResult } from "./wire-source";

// Air-gap export
export { buildAirGapArchive, generateAirGapReadme } from "./air-gap-export";
export type { AirGapExportInput, AirGapArchive } from "./air-gap-export";

// Workflow-state unlock chain + mode gating (integrates with integrate-arc)
export {
  deployModeGating,
  canDeployInMode,
  canDeployContentPathInMode,
  canWireSource,
  readinessPillsForMode,
  deriveGuidedWorkflow,
} from "./workflow-state";
export type {
  DeployMode,
  ModeGating,
  GuidedWorkflowState,
} from "./workflow-state";

// Idempotent skip rules
export {
  decideCustomTablesStep,
  decideDcrsStep,
  decideBuildPackStep,
  decideEmbedStep,
  destinationExistsForTable,
  hasCustomTables,
  normalizeTableKey,
} from "./skip-rules";
export type {
  RunOrSkip,
  DcrsDecision,
  BuildPackDecision,
  EmbedDecision,
} from "./skip-rules";

// Vendor-research memoization
export {
  memoizeVendorResearch,
  normalizeVendorKey,
} from "./vendor-research-memo";
export type { MemoizedResearch } from "./vendor-research-memo";
