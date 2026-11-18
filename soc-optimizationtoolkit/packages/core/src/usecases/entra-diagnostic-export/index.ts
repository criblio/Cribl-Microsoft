/**
 * entra-diagnostic-export usecase barrel (AZR-99): read the tenant's Entra ID
 * diagnostic settings, create CriblEntraIDLogs (create-only, refused when ours
 * exists, differs, or another setting already sends a chosen category to the
 * same namespace), and remove it once proven the app's.
 */

export {
  ENTRA_ITEM_ID,
  deployEntraSetting,
  readEntraSettingState,
  removeEntraSetting,
} from "./entra-diagnostic-export";
export type {
  EntraDeployInput,
  EntraDeployOutcome,
  EntraDeployStep,
  EntraOursReading,
  EntraRemoveInput,
  EntraRemoveOutcome,
  EntraRemoveStep,
  EntraSettingState,
  EntraSettingsState,
} from "./entra-diagnostic-export";
