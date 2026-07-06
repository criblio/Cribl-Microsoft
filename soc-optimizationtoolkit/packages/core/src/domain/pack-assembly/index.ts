/**
 * pack-assembly domain module barrel - porting-plan Unit 19
 * (ENG-06/07/08/09, ENG-28 deltas, GUI-19/20 folded).
 *
 * The pure, filesystem-free pack builder: the in-memory PackTree domain object,
 * the scaffold that turns a Unit 17 PipelinePlan + analysis inputs into that
 * tree, the verbatim breakers/sample/lookup/outputs generators, the ONLY .crbl
 * implementation (a pure gzip+ustar builder with deterministic mtime, golden-
 * file-tested against a Cribl-accepted reference), the persistable build-record
 * model + retention, and the install decision logic exposed as pure
 * request/response-shaping helpers the shells call. All pure.
 */

// 1. PackTree domain object
export type { PackFileContent } from "./pack-tree";
export { PackTree, PackTreeError } from "./pack-tree";

// 2. Scaffold (plan + analysis -> PackTree) and the full assembly convenience
export type {
  TableAssemblyInput,
  PackScaffoldInput,
  AssembledPack,
} from "./scaffold";
export { scaffoldPack, assemblePack } from "./scaffold";

// 3. breakers.yml KB
export {
  DEFAULT_MAX_EVENT_BYTES,
  CROWDSTRIKE_MAX_EVENT_BYTES,
  isCrowdStrikeSolution,
  generateBreakersYml,
} from "./breakers";

// 4. Sample-file generation (envelope, CEF reconstruction, samples.yml) + values
export type {
  PackVendorSample,
  SampleSourceField,
  PackSampleEvent,
  SampleRegistryEntry,
} from "./sample-file";
export {
  SAMPLE_TIME_BASE_SEC,
  reconstructCefLine,
  generateRawVendorEvent,
  generateSampleFile,
  renderSampleRegistryEntry,
  generateSamplesYml,
} from "./sample-file";
export { generateFieldValue, isoFromEpochMs } from "./sample-values";

// 5. outputs.yml serializer (over the existing sentinel-destination module)
export { CRIBL_SECRET_REFERENCE, serializeSentinelOutputsYml } from "./outputs-yml";

// 6. Lookup CSV + lookups.yml
export {
  LOOKUP_CSV_HEADER,
  LOOKUP_DATA_DIR,
  escapeCsvCell,
  lookupRowsFromMatch,
  lookupRowsFromOverrides,
  renderLookupCsv,
  lookupFileName,
  generateLookupsYml,
} from "./lookups";

// package.json manifest + the streamtags-read fix
export type { PackageJson } from "./package-json";
export {
  MIN_LOG_STREAM_VERSION,
  buildPackageJson,
  renderPackageJson,
  streamtagsFromPackage,
} from "./package-json";

// 7. The pure ustar/.crbl builder (the packaging-correctness heart)
export type { TarFileEntry, ParsedTarEntry } from "./tar";
export {
  REPORT_FILE_EXCLUSIONS,
  isExcludedFromCrbl,
  toBytes,
  buildUstarTar,
  parseUstarTar,
  crc32,
  gzipStored,
  ungzipStored,
  buildCrbl,
} from "./tar";

// 8. Build records + retention
export type { PackBuildRecord } from "./build-record";
export {
  buildRecordId,
  crblFileName,
  makeBuildRecord,
  applyRetention,
} from "./build-record";

// Install decision logic (pure request/response shaping; fetch lives in shells)
export type {
  ShapedRequest,
  UploadResult,
  InstalledPack,
  InstallOutcome,
  PackListResult,
} from "./install";
export {
  packApiPath,
  packUploadRequest,
  parseUploadResponse,
  packInstallRequest,
  interpretInstallResponse,
  packIdFromCrblFileName,
  packDeleteRequest,
  packListRequest,
  parsePackListResponse,
  isPackDeployed,
  deployedGroups,
} from "./install";
