/** Tenant to Cribl mapping (ADR 0009 decision 5, AZR-64). */
export {
  TENANT_CRIBL_MAPPING_KEY,
  TENANT_CRIBL_MAPPING_KIND,
  TENANT_CRIBL_MAPPING_VERSION,
  UNSET_TENANT_CRIBL_MAPPING,
  encodeTenantCriblMapping,
  mappingTenants,
  readTenantCriblMapping,
  resolveTenantGroup,
  withMappingMode,
  withSharedGroup,
  withTenantGroup,
} from "./tenant-cribl-mapping";
export type {
  MappingTenant,
  TenantCriblMapping,
  TenantCriblMappingRead,
  TenantCriblMode,
  TenantGroupResolution,
  TenantGroupUnsetWhy,
} from "./tenant-cribl-mapping";
