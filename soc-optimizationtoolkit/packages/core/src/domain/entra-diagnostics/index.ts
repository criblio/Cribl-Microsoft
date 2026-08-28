/**
 * entra-diagnostics domain barrel (AZR-2, the tracer bullet through
 * backlog.md#6b): one tenant-level ARM PUT, with the checkbox grain at the
 * CATEGORY and the two consequences an operator needs - the volume cliff and
 * the UEBA hard limit - attached to the categories that earn them.
 */

export {
  ENTRA_CATEGORIES,
  ENTRA_PROFILES,
  ENTRA_PROFILE_CATEGORIES,
  categoriesForProfile,
  entraCategory,
  profileForSelection,
  uebaBoundTables,
  volumeWarnings,
} from "./entra-categories";
export type { EntraCategory, EntraCategoryName, EntraProfile } from "./entra-categories";

export {
  AADIAM_API_VERSION,
  DEFAULT_SETTING_NAME,
  ENTRA_DIRECTORY_PRECONDITION,
  buildEntraDiagnosticRequest,
  listSettingsUrl,
} from "./entra-diagnostic-setting";
export type {
  DiagnosticLogEntry,
  EntraDiagnosticInput,
  EntraDiagnosticRequest,
  UnmeasurablePrecondition,
} from "./entra-diagnostic-setting";
