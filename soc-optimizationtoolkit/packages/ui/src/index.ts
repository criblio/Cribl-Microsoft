// @soc/ui: shared React feature screens and components, consumed by both app shells.
// Feature folders per catalog domain: onboarding, dcr, packs, discovery, governance,
// lookups, migration, drift, labs; plus frame/ (app chrome + gates), screens/
// (settings), components/ (shared widgets), polling/ (the one budgeted poller).
// Consumes @soc/core ports via context; no direct IO.

export { PortsContext, PortsProvider, usePorts } from "./ports-context";
export type {
  DeployedGroupPacks,
  PackInstallClient,
  PackRecordStore,
  PortsContextValue,
  PortsProviderProps,
  StoredPack,
  UiPorts,
} from "./ports-context";
export { OnboardTableScreen } from "./onboarding/onboard-table-screen";
export type { OnboardTableScreenProps } from "./onboarding/onboard-table-screen";
export { formatStepLine, STEP_STATUS_TAG_WIDTH } from "./onboarding/step-line";

// Custom (_CL) table section of onboarding (porting-plan Unit 5): the pure
// decision layer behind the schema-source picker, column preview, and
// retention default/override.
export {
  CUSTOM_SCHEMA_SOURCE_OPTIONS,
  RETENTION_CHOICES,
  defaultVendorIdForTable,
  deriveCustomSchemaPreview,
  formatSchemaPreview,
  resolveRetentionDays,
} from "./onboarding/custom-schema-state";
export type {
  CustomSchemaInputs,
  CustomSchemaPreview,
  CustomSchemaSource,
  SchemaPreviewRow,
} from "./onboarding/custom-schema-state";

// Batch deployment (porting-plan Unit 6): the multi-table screen over the
// @soc/core onboardBatch usecase, plus its pure decision layer (selection
// parsing, per-run option overrides, counts/summary derivation, templateOnly
// artifact naming, batch RecentRuns renderers).
export { BatchDeployScreen } from "./onboarding/batch/batch-deploy-screen";
export type { BatchDeployScreenProps } from "./onboarding/batch/batch-deploy-screen";
export {
  DEFAULT_BATCH_RUN_OVERRIDES,
  FORCED_TEMPLATE_ONLY_NOTICE,
  amplsIssueFor,
  applyRunOverrides,
  batchRunDetail,
  batchRunLabel,
  batchTemplatesArtifactName,
  buildBatchSelection,
  buildTemplatesArtifact,
  deriveBatchCounts,
  formatBatchCountsLine,
  formatBatchSummary,
  parseTableListText,
} from "./onboarding/batch/batch-state";
export type {
  BatchCounts,
  BatchRunOverride,
  BatchRunOverrides,
  BatchSelection,
} from "./onboarding/batch/batch-state";

// App frame: chrome, acceptance gate, mode chooser, and their pure state.
export { AppFrame } from "./frame/app-frame";
export type { AppFrameNav, AppFrameProps, AppRoute } from "./frame/app-frame";
export { AuaGate } from "./frame/aua-gate";
export type { AuaGateProps } from "./frame/aua-gate";
export { ModeSelect } from "./frame/mode-select";
export type { ModeSelectProps } from "./frame/mode-select";
export {
  AUA_SCROLL_SLACK_PX,
  DEFAULT_NAV_SECTION,
  EMPTY_MODE_RECORD,
  MODE_LABELS,
  MODE_OPTIONS,
  NAV_SECTION_LABELS,
  NAV_SECTION_ORDER,
  groupNavSections,
  isScrolledToBottom,
  resolveFramePhase,
} from "./frame/frame-state";
export type {
  FramePhase,
  LoadableAcceptance,
  LoadableMode,
  ModeOption,
  NavSection,
  NavSectionGroup,
} from "./frame/frame-state";

// Theme (porting-plan dark-mode note, lands with Unit 6.5): the UI layer
// over @soc/core's app-theme model (codec + resolveTheme live in core) -
// the stylesheet's [data-theme] tokens, the frame topBar toggle, and the
// Settings Appearance control. Shells own persistence (APP_THEME_KEY) and
// the prefers-color-scheme media query.
export { ThemeToggle } from "./frame/theme-toggle";
export type { ThemeControl, ThemeToggleProps } from "./frame/theme-toggle";
export {
  APP_THEME_KEY,
  THEME_LABELS,
  nextThemeChoice,
  themeToggleText,
} from "./frame/theme-state";

// Guided journey shell (ux-flow-plan, Unit 6.5): the JourneyStepper rail
// over @soc/core deriveJourney, the pure stage->route binding layer
// (cross-links are shell props, never shell-sniffing prose), and the
// state-aware Home screen both shells land on every launch.
export { JourneyStepper } from "./frame/journey-stepper";
export type { JourneyStepperProps } from "./frame/journey-stepper";
export {
  SHARED_JOURNEY_LINKS,
  buildStepperItems,
  mergeJourneyLinks,
} from "./frame/stepper-state";
export type {
  JourneyLink,
  JourneyLinks,
  StepperItem,
} from "./frame/stepper-state";
export { HomeScreen } from "./screens/home/home-screen";
export type { HomeScreenProps } from "./screens/home/home-screen";
export {
  NO_ACTION_FALLBACK,
  deriveNextActionView,
  modeNoteFor,
} from "./screens/home/home-state";
export type { NextActionView } from "./screens/home/home-state";

// Review (porting-plan Unit 7, ux-flow-plan 5.2): the Integrate arc's
// REVIEW stage - live-ARM deployment preview over @soc/core
// buildDeploymentPreview (dcr-naming is the single name source), with the
// staleness marker, the acknowledge gate arming the Deploy handoff, and
// the pure decision layer behind it all.
export { ReviewScreen } from "./screens/review/review-screen";
export type { ReviewScreenProps } from "./screens/review/review-screen";
export {
  HANDOFF_CHECKING_REASON,
  HANDOFF_NEEDS_ACKNOWLEDGE_REASON,
  HANDOFF_NEEDS_PREVIEW_REASON,
  HANDOFF_STALE_REASON,
  REVIEW_SELECTION_NOTE,
  STALE_NOTICE,
  checkActionLabel,
  deriveDeployHandoff,
  deriveReviewRows,
  formatReviewSummary,
  isPreviewStale,
  previewOptionsOf,
  reviewCounts,
  reviewInputsToken,
} from "./screens/review/review-state";
export type {
  DeployHandoff,
  DeployHandoffInput,
  GeneratedPreview,
  ReviewCounts,
  ReviewRow,
  ReviewRowTag,
  ReviewScope,
  ReviewVerdict,
} from "./screens/review/review-state";

// Integrate arc (legacy-flow-analysis.md single-page decision, ADOPTED
// 2026-07-04): the MVP centerpiece - the single-page Integrate flagship
// composing the built screens (Azure Targeting, the native onboardTable
// deploy) as numbered sections over @soc/core integrate-arc, with the
// coming-soon sections rendered honestly. Plus the REUSABLE numbered-section
// vocabulary (NumberedSection, ReadinessFooter) later units reuse for their
// own sections, and the pure screen-state binding layer.
export { NumberedSection } from "./components/numbered-section";
export type { NumberedSectionProps } from "./components/numbered-section";
export { ReadinessFooter } from "./components/readiness-footer";
export type { ReadinessFooterProps } from "./components/readiness-footer";
export { IntegrateScreen } from "./screens/integrate/integrate-screen";
export type { IntegrateScreenProps } from "./screens/integrate/integrate-screen";
export {
  FALLBACK_PACK_NAME,
  INTEGRATE_DEFAULT_TABLE,
  defaultPackName,
  deployDisabledReason,
  deriveSectionInputs,
} from "./screens/integrate/integrate-screen-state";
export type { IntegrateRawInputs } from "./screens/integrate/integrate-screen-state";

// Sample intake (porting-plan Unit 11 UI, ENG-14/15/18): the Integrate page's
// Sample Data section - multi-file upload + paste-and-tag, per-sample chips with
// the detected format, a field table, and a raw preview, and a log-type rename
// that RE-KEYS the tagged-sample store entry and any downstream log-type-keyed
// edits (the legacy orphaning-bug fix). Plus the pure decision layer behind it.
export { SampleIntakeSection } from "./screens/samples/sample-intake-section";
export type { SampleIntakeSectionProps } from "./screens/samples/sample-intake-section";
export {
  buildTaggedSample,
  chipFromTagged,
  dedupeByLogType,
  fieldRows,
  normalizeLogType,
  rawPreviewLines,
  reKeyByLogType,
  removeByLogType,
  renameInList,
  suggestLogType,
  tagFileContent,
  tagSampleFromContent,
  upsertSample,
  validateLogType,
  validateRename,
} from "./screens/samples/sample-intake-state";
export type {
  RenameCheck,
  SampleChip,
  SampleFieldRow,
} from "./screens/samples/sample-intake-state";

// Match preview (porting-plan Unit 13 UI, ENG-04/05/03): the minimal,
// read-only preview seeded into the Sample Data section - a tagged sample vs a
// destination table rendered as matched/overflow/unmatched stat cards (the
// legacy gap-analysis vocabulary), surfaced warnings (the AdditionalData_d
// overflow-loss case honestly), and an expandable per-field mapping list. The
// SEED of the Unit 18 gap-analysis review screen. Schema resolution flows
// through the @soc/core SchemaCatalog port (bundled adapter by default); all
// projection is the pure match-preview-state helpers.
export { MatchPreview } from "./screens/match-preview/match-preview";
export type { MatchPreviewProps } from "./screens/match-preview/match-preview";
export { MatchPreviewSection } from "./screens/match-preview/match-preview-section";
export type { MatchPreviewSectionProps } from "./screens/match-preview/match-preview-section";
export {
  MATCH_PREVIEW_NO_SAMPLE_REASON,
  MATCH_PREVIEW_NO_TABLE_REASON,
  deriveMatchPreview,
  deriveMatchRows,
  deriveMatchStats,
  deriveMatchWarnings,
  formatRowRoute,
  matchPreviewEmptyReason,
  matchRatePercent,
} from "./screens/match-preview/match-preview-state";
export type {
  MatchPreviewInputs,
  MatchPreviewRow,
  MatchPreviewStat,
  MatchPreviewView,
  MatchPreviewWarning,
  MatchRowKind,
  MatchStatKey,
  MatchStatTone,
  MatchWarningKind,
} from "./screens/match-preview/match-preview-state";

// DCR Gap Analysis / mapping review (porting-plan Unit 18, ENG-12, GUI-08,
// GUI-32): THE crown-jewel approval moment - the Integrate page's Gap Analysis
// section grown from the Unit 13 match-preview seed. The MappingReviewSection
// runs the @soc/core analyzeSamples usecase per log type and renders the six
// stat tiles, the DCR/Cribl handles split, an editable dest/action mapping
// table, and the data-loss warnings. The pure approval STATE MACHINE
// (mapping-review-state) owns the consent semantics: approvals reset on
// re-analysis, edits survive and re-key on rename (the Unit 11 seam), the
// staleness flag, and the CONTENT-path deploy gate that is strictly partitioned
// from the native quick-onboard gate.
export { MappingReviewSection } from "./screens/mapping-review/mapping-review-section";
export type {
  MappingReviewRenameEvent,
  MappingReviewSectionProps,
} from "./screens/mapping-review/mapping-review-section";
export {
  INITIAL_MAPPING_REVIEW_STATE,
  MAPPING_REVIEW_NO_SAMPLES_REASON,
  MAPPING_REVIEW_STALE_NOTICE,
  OVERFLOW_COVERAGE_NOTE,
  analyzeButtonLabel,
  approvalBarText,
  deriveMappingReviewGate,
  effectiveMappings,
  fieldMappingsLabel,
  isApproved,
  isModified,
  isRuleField,
  mappingReviewReducer,
  sortedMappings,
  tablesWithMappings,
  unmappedDestColumns,
} from "./screens/mapping-review/mapping-review-state";
export type {
  MappingEditField,
  MappingReviewAction,
  MappingReviewGate,
  MappingReviewState,
} from "./screens/mapping-review/mapping-review-state";

// Analytics Rule + Workbook Coverage (porting-plan Unit 23, ENG-11, GUI-09,
// plus net-new workbook coverage): the flagship's Rule Coverage section - the
// UI over the ONE shared @soc/core content-reference analyzer. Alert rules
// (SentinelContent port) and workbooks (AzureManagement ARM enumeration) are
// two sources into one engine, rendered as two sections of one panel
// (three-way counts, per-item severity + coverage %, CUSTOM badge, missing
// fields chips, custom-YAML upload/clear). INFORMATIONAL - it lights the Unit
// 18 mapping table's RULE badges via ruleReferencedFields but never gates a
// deploy. All projection is the pure rule-coverage-state helpers.
export { RuleCoverageSection } from "./screens/rule-coverage/rule-coverage-section";
export type { RuleCoverageSectionProps } from "./screens/rule-coverage/rule-coverage-section";
export {
  ANALYTIC_RULE_DIR_VARIANTS,
  CUSTOM_BADGE_LABEL,
  DEFAULT_MISSING_CHIP_LIMIT,
  MISSING_FIELDS_HEADING,
  RULE_COVERAGE_IDLE_NOTE,
  RULE_COVERAGE_NO_REPORTS_NOTE,
  VIEW_KQL_LABEL,
  availableFieldsFromReports,
  contentTypeNoun,
  coverageCountChips,
  coveragePercent,
  coverageSummaryLine,
  coverageTone,
  customRuleCount,
  deriveCoverageItemView,
  deriveCoverageSection,
  deriveThreeWayCounts,
  destinationTableNamesFromReports,
  isRuleYamlFileName,
  missingFieldChips,
  parseCustomRuleUploads,
  ruleFieldSet,
  severityTone,
} from "./screens/rule-coverage/rule-coverage-state";
export type {
  CoverageCountChip,
  CoverageItemView,
  CoverageSectionView,
  CoverageThreeWay,
  CoverageTone,
  RuleYamlUpload,
  SeverityTone,
} from "./screens/rule-coverage/rule-coverage-state";

// Pipeline preview (porting-plan Unit 17 UI, ENG-01/02/03-emission/13): the
// Integrate flow's READ-ONLY pipeline preview panel. It projects the Unit 18
// gap reports + the reviewer's approved/edited mappings into the exact conf.yml
// per log type (the pipeline functions in order), the reduction rules with
// their reasons, and the pack-level route.yml - all emitted by the pure @soc/core
// Unit 17 generators, then validated honestly with checkCriblYaml. Additive and
// non-gating: it consumes the mapping-review content-path gate and never touches
// canDeploy. All projection is the pure pipeline-preview-state helpers.
export { PipelinePreviewSection } from "./screens/pipeline-preview/pipeline-preview-section";
export type { PipelinePreviewSectionProps } from "./screens/pipeline-preview/pipeline-preview-section";
export {
  PIPELINE_PREVIEW_NO_REPORTS_REASON,
  PIPELINE_PREVIEW_NO_SAMPLES_REASON,
  PIPELINE_PREVIEW_NOT_APPROVED_REASON,
  derivePipelinePreview,
  effectiveReportMappings,
  gapMappingToPreset,
  normalizeSourceFormat,
  pipelineFunctionLines,
  pipelinePreviewEmptyReason,
  reductionRuleViews,
  reportToPlanInput,
} from "./screens/pipeline-preview/pipeline-preview-state";
export type {
  PipelineFunctionLine,
  PipelinePreviewInputs,
  PipelinePreviewTable,
  PipelinePreviewView,
  ReductionRuleView,
} from "./screens/pipeline-preview/pipeline-preview-state";

// CSV header resolution (porting-plan Unit 12 UI, ENG-16/17, GUI-07): the
// two-tab dialog (header row / paste feed config) that names a headerless
// positional CSV's columns, its preview zip + mismatch warning, and the pure
// queue state that resolves EVERY headerless CSV in a multi-file batch instead
// of dropping the rest after the first (the legacy silent-drop fix). Applying
// re-parses via the core parseCsvWithHeaders and re-keys the tagged sample.
export { CsvHeaderDialog } from "./screens/samples/csv-header-dialog";
export type { CsvHeaderDialogProps } from "./screens/samples/csv-header-dialog";
export {
  advanceQueue,
  buildResolutionQueue,
  currentItem,
  deriveMismatch,
  isHeaderlessCsvSample,
  isQueueDone,
  parseHeaderFileText,
  previewZip,
  queuePosition,
  reconstructCsvLines,
  remainingCount,
  resolveHeaders,
  singleItemQueue,
  splitCsvRow,
  toResolutionItem,
} from "./screens/samples/csv-resolution-state";
export type {
  CsvMismatch,
  CsvResolutionItem,
  CsvResolutionQueue,
  PreviewZipRow,
} from "./screens/samples/csv-resolution-state";

// Azure targeting (Unit 2): the subscription -> workspace -> resource-group
// cascade, create/enable actions, explicit scope commit, and the pure state
// behind it (chip text, commit notice, RG name rules, scope codec).
export { AzureTargetingScreen } from "./screens/azure-targeting/azure-targeting-screen";
export type {
  AzureTargetingScreenProps,
  CommitScopeOutcome,
} from "./screens/azure-targeting/azure-targeting-screen";
export {
  RESOURCE_GROUP_MAX_LENGTH,
  buildLoaderPlan,
  commitNoticeText,
  formatScopeChip,
  parseTargetScope,
  sanitizeResourceGroupName,
  serializeTargetScope,
  validateResourceGroupName,
} from "./screens/azure-targeting/targeting-state";
export type {
  LoaderPlan,
  LoaderPlanInput,
} from "./screens/azure-targeting/targeting-state";

// Logs (porting-plan Unit 3): the diagnostics viewer over the shell's
// Logger adapter, plus the pure line codec/filter glue behind it (the local
// shell re-parses host log lines through parseLogLine/logLineToEntry).
export { LogsScreen } from "./screens/logs/logs-screen";
export type { LogsScreenProps } from "./screens/logs/logs-screen";
export {
  LEVEL_FILTER_OPTIONS,
  RECENT_JOBS_LIMIT,
  SUPPORT_BUNDLE_FILENAME,
  buildLogFilter,
  logLineToEntry,
  parseLogLine,
} from "./screens/logs/logs-state";
export type { LogFilterInputs } from "./screens/logs/logs-state";

// Options (porting-plan Unit 4): the two @soc/core option forms rendered
// from their field descriptors through the generic OptionFieldRow (the
// descriptor-driven pattern later units reuse), with validate-on-save
// per-field errors, a dirty indicator, and merge-preserving persistence
// through shell-provided load/save callbacks over one stored blob.
export { OptionFieldRow, OptionsScreen } from "./screens/options/options-screen";
export type {
  OptionFieldRowProps,
  OptionsScreenProps,
} from "./screens/options/options-screen";
export {
  defaultOptionsState,
  isOptionsStateDirty,
  patchFromState,
  stateFromOptions,
  validateOptionsState,
} from "./screens/options/options-state";
export type { OptionsFormState } from "./screens/options/options-state";

// Sentinel content browser + Repositories/PAT settings (porting-plan Unit 14):
// the lazy GitHub solution browser (search, deprecation badges, the preserved
// `#/?solution=` deep link) and the PAT settings page (13-step walkthrough,
// save-then-unstick stale-error sequence, reachability + PAT-valid status).
// Pure decision logic lives in the *-state modules with their own tests.
export { SolutionBrowser } from "./screens/solution-browser/solution-browser";
export type { SolutionBrowserProps } from "./screens/solution-browser/solution-browser";
export {
  DEPRECATED_BADGE_LABEL,
  SOLUTION_DEEPLINK_PARAM,
  buildSolutionDeepLink,
  deprecationBadge,
  filterSolutions,
  parseSolutionDeepLink,
  resolveSelectedSolution,
  solutionCounts,
  solutionMatchesQuery,
} from "./screens/solution-browser/browser-state";
export type {
  DeprecationBadge,
  SolutionCounts,
  SolutionFilter,
} from "./screens/solution-browser/browser-state";
export { RepositoriesScreen } from "./screens/repositories/repositories-screen";
export type { RepositoriesScreenProps } from "./screens/repositories/repositories-screen";
export {
  derivePatFormView,
  deriveReachabilityStatus,
  initialPatFormState,
  patFormReducer,
} from "./screens/repositories/pat-form-state";
export type {
  PatFormAction,
  PatFormPhase,
  PatFormState,
  PatFormView,
  ReachabilityInput,
  ReachabilityStatus,
  ReachabilityTone,
} from "./screens/repositories/pat-form-state";

// Pack inventory (porting-plan Unit 19, GUI-19/20 folded): the ONE merged pack
// inventory screen - build records with DEPLOYED badges per worker group (truth
// from the live packs API), storage/retention, DOWNLOAD .crbl via ArtifactSink
// (regenerated deterministically or served cached), install-to-group, and
// DELETE guarded by scoped record-id validation (no path semantics). Additive:
// it never touches canDeploy / canDeployContentPath. Pure decisions live in
// pack-inventory-state with their own tests.
export { PackInventoryScreen } from "./screens/packs/pack-inventory-screen";
export type { PackInventoryScreenProps } from "./screens/packs/pack-inventory-screen";
export {
  PACK_INVENTORY_EMPTY_REASON,
  PACK_INVENTORY_UNAVAILABLE_REASON,
  PACK_RETENTION_NOTE,
  deriveDeployedBadge,
  deriveInventoryRows,
  deriveStorageSummary,
  formatCrblSize,
  resolveBytesSource,
  tablesSummary,
  validateDeleteId,
} from "./screens/packs/pack-inventory-state";
export type {
  BytesSource,
  DeleteIdCheck,
  DeployedBadge,
  PackInventoryRow,
  StorageSummary,
} from "./screens/packs/pack-inventory-state";

// Ingestion role assignment (porting-plan Unit 8, ENG-37 runtime half): the
// Integrate page's Azure-section step that grants Monitoring Metrics Publisher
// to the ingestion service principal on each deployed DCR (the run is the
// @soc/core assignDcrRoles usecase; GUID minting is shell-injected). Additive
// and NON-GATING - it never touches canDeploy / canDeployContentPath. The
// object-id validation SHAPE, the always-visible-disabled gate, and the
// {assigned, total} + per-DCR result projection are the pure state module.
export { RoleAssignmentSection } from "./screens/role-assignment/role-assignment-section";
export type { RoleAssignmentSectionProps } from "./screens/role-assignment/role-assignment-section";
export {
  OBJECT_ID_EMPTY_REASON,
  OBJECT_ID_IS_CLIENT_ID_REASON,
  OBJECT_ID_NOT_GUID_REASON,
  ROLE_ASSIGN_NO_MINTER_REASON,
  ROLE_ASSIGN_NO_TARGETS_REASON,
  ROLE_ASSIGN_RUNNING_REASON,
  ROLE_DETAIL_ALREADY,
  ROLE_DETAIL_ASSIGNED,
  dcrResourceIdFor,
  projectRoleOutcome,
  roleAssignDisabledReason,
  roleAssignStepNames,
  roleTargetDisplayName,
  upsertRoleTarget,
  validateObjectId,
} from "./screens/role-assignment/role-assignment-state";
export type {
  DcrScopeName,
  ObjectIdCheck,
  RoleAssignGateInput,
  RoleOutcomeKind,
  RoleOutcomeRow,
  RoleOutcomeView,
} from "./screens/role-assignment/role-assignment-state";

// Settings.
export { SettingsScreen } from "./screens/settings-screen";
export type {
  PlatformInfoRow,
  SettingsConfigEditor,
  SettingsScreenProps,
} from "./screens/settings-screen";
export { validateConfigJson } from "./screens/config-json";
export type { ConfigJsonResult } from "./screens/config-json";

// Shared widgets.
export { InfoTip } from "./components/info-tip";
export type { InfoTipProps } from "./components/info-tip";

// The one budgeted status poller (wraps the @soc/core poll-scheduler).
export { useConsolidatedPolling } from "./polling/use-consolidated-polling";
export type {
  ConsolidatedPoll,
  ConsolidatedPollingOptions,
} from "./polling/use-consolidated-polling";
