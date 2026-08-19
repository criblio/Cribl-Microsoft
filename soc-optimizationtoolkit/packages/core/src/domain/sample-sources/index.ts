/**
 * sample-sources domain barrel (sample-acquisition plan Phase 3, ADR 0003):
 * where the operator gets their own samples from - an existing Cribl Lake
 * dataset to query, or a live Cribl source to capture.
 */

export type {
  AcquisitionMode,
  SampleSourceKind,
  SampleSourceRef,
  SampleSourceSection,
  SampleSourceInventory,
} from "./models";
export { MODE_KIND } from "./models";
export type { InventoryInput, RawSection } from "./inventory";
export {
  buildSampleSourceInventory,
  parseCriblSources,
  parseLakeDatasets,
  sectionFor,
} from "./inventory";
