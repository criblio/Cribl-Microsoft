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
} from "./models";
export { RAW_EVENTS_CAP, MAX_FIELD_EXAMPLES } from "./models";

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
