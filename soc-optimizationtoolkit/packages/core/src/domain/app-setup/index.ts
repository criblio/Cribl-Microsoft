/**
 * App setup state (capability-model-plan step 5): acceptance of the
 * acceptable-use agreement, and completion of the first-run wizard. Formerly
 * app-mode, which also owned the four retired operating modes.
 */
export {
  EMPTY_SETUP_RECORD,
  parseAcceptanceRecord,
  parseSetupRecord,
  serializeAcceptanceRecord,
  serializeSetupRecord,
} from "./app-setup";
export type { AcceptanceRecord, SetupRecord } from "./app-setup";
