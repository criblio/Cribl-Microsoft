// @soc/ui: shared React feature screens and components, consumed by both app shells.
// Feature folders per catalog domain: onboarding, dcr, packs, discovery, governance,
// lookups, migration, drift, labs. Consumes @soc/core ports via context; no direct IO.

export { PortsContext, PortsProvider, usePorts } from "./ports-context";
export type {
  PortsContextValue,
  PortsProviderProps,
  UiPorts,
} from "./ports-context";
export { OnboardTableScreen } from "./onboarding/onboard-table-screen";
export { formatStepLine, STEP_STATUS_TAG_WIDTH } from "./onboarding/step-line";
