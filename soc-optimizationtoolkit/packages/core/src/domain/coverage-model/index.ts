/**
 * coverage-model domain barrel (AZR-0): the `resource-coverage.json` port.
 *
 * The catalog is what CAN be ticked, the selection is what IS ticked, and what
 * ticking MEANS lives in `onboarding-selection` (AZR-1's additive-only
 * contract). Kept apart because they change for different reasons and on
 * different schedules - the catalog ships in code, the selection lives in the
 * KV store and outlives the code that wrote it.
 */

export {
  COVERAGE_CATALOG,
  DEFAULT_ENABLED,
  DEPLOYMENT_MODES,
  UNSUPPORTED_SOURCES,
  XDR_TABLES_NOT_SUPPORTED,
  coverageItem,
  itemsByMethod,
} from "./coverage-catalog";
export type {
  CollectionMethod,
  CoverageItem,
  DeploymentMode,
  SubSelection,
  SubSelectionKind,
  SubSelectionOption,
  UnsupportedItem,
} from "./coverage-catalog";

export {
  COVERAGE_SELECTION_KEY,
  COVERAGE_SELECTION_VERSION,
  decodeSelection,
  defaultSelection,
  encodeSelection,
  resolvedSubSelection,
  selectedItemIds,
} from "./coverage-selection";
export type { CoverageSelection, DecodedSelection } from "./coverage-selection";
