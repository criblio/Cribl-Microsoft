/** The Setup tenant list (ADR 0009 decision 1, AZR-62). */
export {
  addTenantProfiles,
  isTenantId,
  parseTenantIdList,
  planTenantProfiles,
  tenantTicketTargets,
} from "./tenant-intake";
export type { TenantIdListParse, TenantProfilePlan, TenantTicketTarget } from "./tenant-intake";
