import { describe, expect, it } from "vitest";

import {
  // usecases/onboard-batch
  onboardBatch,
  onboardBatchStepsFor,
  paceAzureManagement,
  pollAttemptsForTimeout,
  DEFAULT_BATCH_MAX_REQUESTS_PER_MINUTE,
  ONBOARD_BATCH_JOB_KIND,
  // usecases/assign-dcr-role
  assignDcrRoles,
  buildRoleAssignmentRequest,
  matchDcrsToTables,
  ASSIGN_DCR_ROLE_JOB_KIND,
  MONITORING_METRICS_PUBLISHER_ROLE_ID,
  ROLE_ASSIGNMENTS_API_VERSION,
  // domain/journey-state
  deriveJourney,
  nextAction,
  readinessChips,
  FIRST_RUN_ARC,
  INTEGRATE_ARC,
  // domain/integrate-arc
  INTEGRATE_SECTIONS,
  canDeploy,
  deriveReadinessPills,
  deriveSectionStatus,
  // domain/sample-parsing
  DISCRIMINATOR_FIELDS,
  HIGH_CONFIDENCE_DISCRIMINATOR_COUNT,
  RAW_EVENTS_CAP,
  autoDetectLogTypes,
  detectCaptureInnerFormat,
  detectSampleFormat,
  parseSampleContent,
  selectDiscriminatorField,
  FakeTaggedSampleStore,
  // domain/app-theme
  parseThemeChoice,
  resolveTheme,
  serializeThemeChoice,
  THEME_CHOICES,
  // usecases/deployment-preview
  buildDeploymentPreview,
  checkExistingDcrs,
  // usecases/azure-discovery
  commitTargetScope,
  deriveResourceGroupsFromWorkspaces,
  enableSentinel,
  listAllPages,
  listSubscriptions,
  listWorkspaces,
  SENTINEL_SOLUTION_API_VERSION,
  // domain/dcr-naming
  DIRECT_DCR_NAME_MAX_LENGTH,
  DIRECT_DCR_TABLE_ABBREVIATIONS,
  DcrNamingError,
  generateDcrName,
  stripCustomTableSuffix,
  // domain/schema-mapping
  buildDcrColumnSet,
  buildStreamDeclaration,
  mapColumnType,
  NATIVE_SYSTEM_COLUMNS,
  SchemaMappingError,
  // domain/dce-request
  buildDceRequest,
  buildAmplsAssociationRequest,
  parseDceDeployment,
  DCE_API_VERSION,
  // domain/dcr-request (DCE variant)
  buildDceDcrRequest,
  DCE_DCR_API_VERSION,
  // testing fakes
  DEFAULT_FAKE_USER,
  FakeArtifactSink,
  FakeAzureManagement,
  FakeCriblClient,
  FakeJobStore,
  FakeSecretsStore,
  FakeUserContext,
  REDACTED_SECRET_PLACEHOLDER,
} from "./index";
import type {
  // ports (type-only)
  ArtifactSink,
  AzureManagement,
  CriblClient,
  JobStore,
  SecretsStore,
  UserContext,
  TaggedSampleStore,
} from "./index";

describe("@soc/core root barrel", () => {
  it("re-exports the dcr-naming domain module", () => {
    expect(typeof generateDcrName).toBe("function");
    expect(typeof stripCustomTableSuffix).toBe("function");
    expect(DcrNamingError.prototype).toBeInstanceOf(Error);
    expect(DIRECT_DCR_NAME_MAX_LENGTH).toBe(30);
    expect(Object.keys(DIRECT_DCR_TABLE_ABBREVIATIONS).length).toBeGreaterThan(0);
  });

  it("re-exports the schema-mapping domain module", () => {
    expect(typeof buildDcrColumnSet).toBe("function");
    expect(typeof buildStreamDeclaration).toBe("function");
    expect(typeof mapColumnType).toBe("function");
    expect(SchemaMappingError.prototype).toBeInstanceOf(Error);
    expect(NATIVE_SYSTEM_COLUMNS.length).toBeGreaterThan(0);
  });

  it("re-exports the dce-request and DCE-mode dcr-request builders", () => {
    expect(typeof buildDceRequest).toBe("function");
    expect(typeof buildAmplsAssociationRequest).toBe("function");
    expect(typeof parseDceDeployment).toBe("function");
    expect(typeof buildDceDcrRequest).toBe("function");
    expect(DCE_API_VERSION).toBe("2023-03-11");
    expect(DCE_DCR_API_VERSION).toBe("2023-03-11");
  });

  it("re-exports the onboard-batch usecase module", () => {
    expect(typeof onboardBatch).toBe("function");
    expect(typeof onboardBatchStepsFor).toBe("function");
    expect(typeof paceAzureManagement).toBe("function");
    expect(typeof pollAttemptsForTimeout).toBe("function");
    expect(ONBOARD_BATCH_JOB_KIND).toBe("onboard-batch");
    expect(DEFAULT_BATCH_MAX_REQUESTS_PER_MINUTE).toBe(80);
  });

  it("re-exports the assign-dcr-role usecase module", () => {
    expect(typeof assignDcrRoles).toBe("function");
    expect(typeof buildRoleAssignmentRequest).toBe("function");
    expect(typeof matchDcrsToTables).toBe("function");
    expect(ASSIGN_DCR_ROLE_JOB_KIND).toBe("assign-dcr-role");
    expect(MONITORING_METRICS_PUBLISHER_ROLE_ID).toBe(
      "3913510d-42f4-4e42-8a64-420c390055eb",
    );
    expect(ROLE_ASSIGNMENTS_API_VERSION).toBe("2022-04-01");
  });

  it("re-exports the azure-discovery usecase module", () => {
    expect(typeof listSubscriptions).toBe("function");
    expect(typeof listWorkspaces).toBe("function");
    expect(typeof listAllPages).toBe("function");
    expect(typeof enableSentinel).toBe("function");
    expect(typeof commitTargetScope).toBe("function");
    expect(typeof deriveResourceGroupsFromWorkspaces).toBe("function");
    expect(SENTINEL_SOLUTION_API_VERSION).toBe("2015-11-01-preview");
  });

  it("re-exports the deployment-preview usecase module", () => {
    expect(typeof checkExistingDcrs).toBe("function");
    expect(typeof buildDeploymentPreview).toBe("function");
  });

  it("re-exports the journey-state domain module", () => {
    expect(typeof deriveJourney).toBe("function");
    expect(typeof nextAction).toBe("function");
    expect(typeof readinessChips).toBe("function");
    expect(FIRST_RUN_ARC[0]).toBe("accept");
    expect(INTEGRATE_ARC).toHaveLength(6);
  });

  it("re-exports the integrate-arc domain module", () => {
    expect(typeof deriveSectionStatus).toBe("function");
    expect(typeof deriveReadinessPills).toBe("function");
    expect(typeof canDeploy).toBe("function");
    expect(INTEGRATE_SECTIONS).toHaveLength(7);
    // sample-data joined the built set when Unit 11 shipped (was 3); solution
    // joined it when Unit 14 shipped the lazy solution browser (was 5);
    // gap-analysis joined it when Unit 18 shipped the mapping review (was 6);
    // rule-coverage joined it when Unit 23 shipped the coverage panel - all
    // seven sections are built now.
    expect(INTEGRATE_SECTIONS.filter((s) => s.built)).toHaveLength(7);
  });

  it("re-exports the sample-parsing domain module and store fake", () => {
    expect(typeof parseSampleContent).toBe("function");
    expect(typeof detectSampleFormat).toBe("function");
    expect(typeof detectCaptureInnerFormat).toBe("function");
    expect(typeof selectDiscriminatorField).toBe("function");
    expect(typeof autoDetectLogTypes).toBe("function");
    expect(RAW_EVENTS_CAP).toBe(200);
    expect(HIGH_CONFIDENCE_DISCRIMINATOR_COUNT).toBe(6);
    expect(DISCRIMINATOR_FIELDS.length).toBe(16);
    const store: TaggedSampleStore = new FakeTaggedSampleStore();
    expect(store).toBeDefined();
  });

  it("re-exports the app-theme domain module", () => {
    expect(typeof serializeThemeChoice).toBe("function");
    expect(parseThemeChoice(null)).toBe("system");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(THEME_CHOICES).toHaveLength(3);
  });

  it("re-exports a fake implementing each port interface", () => {
    const secrets: SecretsStore = new FakeSecretsStore();
    const user: UserContext = new FakeUserContext();
    const artifacts: ArtifactSink = new FakeArtifactSink();
    const jobs: JobStore = new FakeJobStore();
    const azure: AzureManagement = new FakeAzureManagement();
    const cribl: CriblClient = new FakeCriblClient();
    for (const fake of [secrets, user, artifacts, jobs, azure, cribl]) {
      expect(fake).toBeDefined();
    }
    expect(typeof REDACTED_SECRET_PLACEHOLDER).toBe("string");
    expect(DEFAULT_FAKE_USER).toBeDefined();
  });
});
