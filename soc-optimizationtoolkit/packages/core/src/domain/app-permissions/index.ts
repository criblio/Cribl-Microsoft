// FEATURE_ROLES and GRAPH_PERMISSIONS are deliberately NOT re-exported: they are
// the catalog's raw input, and every consumer wants the resolved plan (which
// applies the suppression rule) rather than the unfiltered lists. Exporting them
// would invite a caller to render FEATURE_ROLES directly and ask a lab path for
// roles its Contributor grant already covers. The module's own tests import them
// from "./app-permissions" directly.
export {
  OUTSIDE_SCOPE_CAVEAT,
  appPermissionPlan,
  graphPermissions,
  preflightUnmeasuredGrants,
  rbacPermissions,
} from "./app-permissions";
export type {
  AppPermission,
  PermissionScopeLevel,
  UnmeasuredGrant,
} from "./app-permissions";
