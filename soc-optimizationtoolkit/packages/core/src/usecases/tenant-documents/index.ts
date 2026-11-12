/** One-time move of legacy unscoped KV documents under a tenant (ADR 0009). */
export { loadTenantDocument, readStrandedLegacyDocument } from "./tenant-documents";
export type { StrandedLegacyRead } from "./tenant-documents";
