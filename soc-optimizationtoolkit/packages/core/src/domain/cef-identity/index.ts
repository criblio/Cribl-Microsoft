/**
 * CEF identity (DeviceVendor / DeviceProduct) override: what a solution's rules
 * expect versus what the sample carries, and the replacement that reconciles
 * them. The mismatch it guards against is invisible - everything ingests, no
 * rule fires.
 */
export {
  CEF_IDENTITY_FIELDS,
  actionableCefIdentity,
  applyCefIdentityOverride,
  cefIdentityFindings,
  extractCefIdentityValues,
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
} from "./cef-identity";
