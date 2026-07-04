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
export { formatStepLine, STEP_STATUS_TAG_WIDTH } from "./onboarding/step-line";

// App frame: chrome, acceptance gate, mode chooser, and their pure state.
export { AppFrame } from "./frame/app-frame";
export type { AppFrameNav, AppFrameProps, AppRoute } from "./frame/app-frame";
export { AuaGate } from "./frame/aua-gate";
export type { AuaGateProps } from "./frame/aua-gate";
export { ModeSelect } from "./frame/mode-select";
export type { ModeSelectProps } from "./frame/mode-select";
export {
  AUA_SCROLL_SLACK_PX,
  EMPTY_MODE_RECORD,
  MODE_LABELS,
  MODE_OPTIONS,
  isScrolledToBottom,
  resolveFramePhase,
} from "./frame/frame-state";
export type {
  FramePhase,
  LoadableAcceptance,
  LoadableMode,
  ModeOption,
} from "./frame/frame-state";

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
