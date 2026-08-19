/**
 * capture-filter domain barrel (plan Phase 4, ADR 0003): composing the JS
 * expression a Cribl capture filters on, including the __inputId clause that
 * selects the source - because CaptureParamsReq has no source field.
 */

export type { CaptureFilterInput } from "./capture-filter";
export {
  buildCaptureFilter,
  captureFilterWarning,
  inputPredicate,
  logTypePredicate,
} from "./capture-filter";
