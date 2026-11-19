/** Scan one tenant for the multi-tenant logging gap dashboard (ADR 0009 decision 6). */
export { scanTenantGap } from "./scan-tenant-gap";
// TenantGapRow is exported from domain/tenant-gap (AZR-147).
export type { ScanTenantGapOptions, ScanTenantGapPorts, TenantGapProfile } from "./scan-tenant-gap";
