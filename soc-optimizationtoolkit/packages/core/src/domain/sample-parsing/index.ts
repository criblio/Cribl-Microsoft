/**
 * sample-parsing domain module barrel - porting-plan Unit 11 (ENG-14/15/18).
 *
 * ONE format detector (strict/lenient), ONE parseSampleContent with first-class
 * Cribl-capture inner-_raw unwrap, ONE unified discriminator list, and the
 * renderer-extracted log-type heuristics. All pure.
 */

export type {
  SampleFormat,
  FieldType,
  DiscoveredField,
  ParsedSample,
  TaggedSample,
  SplitSample,
} from "./models";
export {
  RAW_EVENTS_CAP,
  MAX_FIELD_EXAMPLES,
  // THE ONE NAME FOR AN UNNAMED COLUMN. Exported because the UI's interactive
  // column mapper has to speak it too: a position the operator has not named
  // must round-trip as positional, and re-testing /^_\d+$/ in the renderer is
  // how the two conventions drifted apart in the first place (see models.ts).
  positionalFieldName,
  isPositionalFieldName,
} from "./models";

export type { CappedTaggedSample } from "./cap-bytes";
export { TAGGED_SAMPLE_MAX_BYTES, capTaggedSampleBytes } from "./cap-bytes";

export type { DetectMode, DetectOptions } from "./format-detection";
export {
  detectSampleFormat,
  detectCaptureInnerFormat,
} from "./format-detection";

export {
  stripSyslogPrefix,
  parseJson,
  parseNdjson,
  parseCsv,
  parseKv,
  parseCef,
  parseLeef,
  parseSyslog,
  parseByFormat,
} from "./parsers";

export type { ParseSampleOptions } from "./parse-sample";
export {
  parseSampleContent,
  unwrapCapture,
  collectFields,
  guessTimestampField,
  inferFieldType,
  mergeFieldType,
} from "./parse-sample";

export type {
  AutoDetectedLogType,
  AutoDetectResult,
} from "./discriminators";
export {
  DISCRIMINATOR_FIELDS,
  HIGH_CONFIDENCE_DISCRIMINATOR_COUNT,
  selectDiscriminatorField,
  autoDetectLogTypes,
} from "./discriminators";

export {
  detectLogType,
  isHeaderlessCsv,
  recordOriginalFormats,
  resolveOriginalFormat,
} from "./log-type";

// Unit 12 (ENG-16/17, GUI-07): headerless-CSV + vendor feed-config resolution.
export type { ParseCsvWithHeadersOptions } from "./csv-headers";
export { parseCsvWithHeaders } from "./csv-headers";

export {
  PANOS_CSV_HEADERS,
  PANOS_LOG_TYPES,
  PANOS_TRAFFIC_LOGSET_INDEX,
  PANOS_LEGACY_PARSER_INDEX20,
  PANOS_CANONICAL_INDEX20,
  panosHeadersFor,
  parsePanosLine,
  isPanosFormat,
  convertPanosToJson,
} from "./panos-dictionary";

export type { VendorFeedConfig } from "./feed-config";
export { parseFeedConfig } from "./feed-config";

// Drop savings estimator (bytes saved by reviewer drops, for the GUI)
export type { DropSavings } from "./drop-savings";
export {
  NO_DROP_SAVINGS,
  dropSavingsLine,
  dropSavingsPercent,
  estimateDropSavings,
  meanEventBytes,
  mergeDropSavings,
} from "./drop-savings";

// Log-type SPLITTING of a mixed stream (rehomed 2026-08-18 from the deleted
// sample-acquisition domain; load-bearing for capture and mixed uploads).
export {
  parseKvLine,
  splitSamplesByLogType,
  splitFoundNoDiscriminator,
  splitSampleId,
  hasNamedFields,
  convertPanosSplitAtLoad,
} from "./splitting";

// Remembered column orders per VENDOR + LOG TYPE (plan Gap 3 / step 4): the
// operator names a positional column once, not once per sample.
export type {
  BundledOverride,
  ColumnOrderSource,
  ResolvedColumnOrder,
  VendorFieldDefinition,
} from "./vendor-field-definitions";
export {
  VENDOR_FIELD_DEFINITION_NAMESPACE,
  VENDOR_FIELD_DEFINITION_VERSION,
  bundledColumnOrder,
  buildVendorFieldDefinition,
  describeColumnOrder,
  diffBundledOrder,
  normalizeDefinitionScope,
  parseVendorFieldDefinition,
  resolveColumnOrder,
  vendorFieldDefinitionKey,
} from "./vendor-field-definitions";
