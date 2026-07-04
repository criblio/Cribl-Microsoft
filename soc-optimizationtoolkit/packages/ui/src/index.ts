// @soc/ui: shared React feature screens and components, consumed by both app shells.
// Feature folders per catalog domain: onboarding, dcr, packs, discovery, governance,
// lookups, migration, drift, labs; plus frame/ (app chrome + gates), screens/
// (settings), components/ (shared widgets), polling/ (the one budgeted poller).
// Consumes @soc/core ports via context; no direct IO.

export { PortsContext, PortsProvider, usePorts } from "./ports-context";
export type {
  PortsContextValue,
  PortsProviderProps,
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
