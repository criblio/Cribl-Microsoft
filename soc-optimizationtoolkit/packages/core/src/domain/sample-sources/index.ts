/**
 * sample-sources domain barrel (sample-acquisition plan Phase 3, ADR 0003):
 * what the operator can REACH to get their own samples from, normalized across
 * Search datasets, Lake datasets and live Cribl sources.
 */

export type {
  SampleSourceKind,
  SampleSourceRef,
  SampleSourceSection,
  SampleSourceInventory,
} from "./models";
export type { InventoryInput, RawSection } from "./inventory";
export {
  allEntries,
  buildSampleSourceInventory,
  hasAnySource,
  parseCriblSources,
  parseLakeDatasets,
  parseSearchDatasets,
} from "./inventory";
