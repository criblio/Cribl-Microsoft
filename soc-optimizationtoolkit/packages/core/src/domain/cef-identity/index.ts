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
//
// expectedCefIdentity, findCefIdentityAll and overrideChangesEvent are NOT
// re-exported either (architecture audit 2026-08-12). The first two are
// ingredients of cefIdentityFindings and re-exporting them invites the same
// skip-the-comparison mistake as above; overrideChangesEvent is
// specification-only and answers a PER-EVENT question that must never gate the
// emitted constant (see its docstring). All three stay exported from the module
// so their tests, which import "./cef-identity" directly, keep pinning them.
export {
  CEF_IDENTITY_FIELDS,
  actionableCefIdentity,
  applyCefIdentityOverride,
  cefIdentityFindings,
  effectiveCefIdentity,
  findCefIdentity,
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
