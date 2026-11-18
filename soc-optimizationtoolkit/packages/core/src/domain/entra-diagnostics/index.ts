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
  licenceNotes,
  profileForSelection,
  uebaBoundTables,
  volumeWarnings,
} from "./entra-categories";
export type { EntraCategory, EntraCategoryName, EntraProfile } from "./entra-categories";

export {
  AADIAM_API_VERSION,
  DEFAULT_SETTING_NAME,
  ENTRA_DIAGNOSTIC_SETTINGS_PATH,
  ENTRA_DIRECTORY_PRECONDITION,
  buildEntraDiagnosticRequest,
  buildEntraSettingDeleteRequest,
  buildEntraSettingGetRequest,
  buildEntraSettingPutRequest,
  entraDiagnosticBody,
  entraSettingPath,
  listSettingsRequest,
  listSettingsUrl,
} from "./entra-diagnostic-setting";
export type {
  DiagnosticLogEntry,
  EntraDiagnosticInput,
  EntraDiagnosticRequest,
  UnmeasurablePrecondition,
} from "./entra-diagnostic-setting";

// AZR-99: the Deploy and Remove of the tenant setting from the onboarding screen.
export {
  ENTRA_AUTO_HUB_TEXT,
  // ENTRA_ITEM_ID is re-exported by usecases/entra-diagnostic-export, like ACTIVITY_LOG_ITEM_ID.
  ENTRA_SETTING_NAME,
  classifyOursEntraSetting,
  entraCategoriesDiff,
  entraDiagnosticInputFor,
  entraOurSettingPath,
  entraSettingDiffs,
  expectedEntraSetting,
  findOverlappingEntraSettings,
  sameEntraCategories,
  unknownEntraCategories,
} from "./entra-setting-deploy";
export type { EntraSettingInput, ExpectedEntraSetting } from "./entra-setting-deploy";

export {
  ENTRA_ACTIONS_NOT_MEASURABLE,
  ENTRA_NAMESPACE_ACTIONS,
  ENTRA_TENANT_ACTIONS,
} from "./entra-permissions";
