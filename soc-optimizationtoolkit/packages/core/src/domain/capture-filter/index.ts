/**
 * capture-filter domain barrel (plan Phase 4, ADR 0003): composing the JS
 * expression a Cribl capture filters on, including the __inputId clause that
 * selects the source - because CaptureParamsReq has no source field.
 */

export type { CaptureFilterInput } from "./capture-filter";
// inputPredicate and logTypePredicate are deliberately NOT exported: they are
// building blocks of buildCaptureFilter, and the 2026-08-20 audit found both
// were reachable only from their own tests. A test importing the module
// directly loses nothing.
export { buildCaptureFilter, captureFilterWarning } from "./capture-filter";
