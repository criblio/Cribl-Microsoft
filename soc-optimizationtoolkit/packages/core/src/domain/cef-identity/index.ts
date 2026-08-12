/**
 * CEF identity (DeviceVendor / DeviceProduct) override: what a solution's rules
 * expect versus what the sample carries, and the replacement that reconciles
 * them. The mismatch it guards against is invisible - everything ingests, no
 * rule fires.
 */
// extractCefIdentityValues is deliberately NOT re-exported (architecture audit
// 2026-08-12). It is the ingredient, and a caller holding raw literals would be
// one step from comparing them itself - skipping findCefIdentity, and with it
// the case-mismatch distinction that keeps "wrong casing" from reading as
// "wrong vendor". Callers want cefIdentityFindings. The module's own tests
// import it from "./cef-identity" directly.
export {
  CEF_IDENTITY_FIELDS,
  actionableCefIdentity,
  applyCefIdentityOverride,
  cefIdentityFindings,
  effectiveCefIdentity,
  expectedCefIdentity,
  findCefIdentity,
  findCefIdentityAll,
  overrideChangesEvent,
  overrideValueFor,
} from "./cef-identity";
export type {
  CefIdentityField,
  CefIdentityFinding,
  CefIdentityOverride,
  CefIdentityStatus,
  CefIdentityEnrichmentRow,
  CefIdentityMappingRow,
} from "./cef-identity";
