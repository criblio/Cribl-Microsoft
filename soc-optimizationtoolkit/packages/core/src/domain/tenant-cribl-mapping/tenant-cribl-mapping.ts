/**
 * Tenant to Cribl mapping (ADR 0009 decision 5, AZR-64): which Cribl Stream
 * worker group receives each Azure tenant's sources.
 *
 * The operator chooses one of two shapes (backlog.md 6i, decision 2):
 *
 *   shared       one worker group for every tenant
 *   per-tenant   a worker group per tenant
 *
 * ONE APP-WIDE DOCUMENT, keyed by tenant inside. Not a tenant-scoped
 * `{base}.{tenantId}` document: the shared mode is one fact about every tenant
 * at once, and the Setup panel edits every tenant's row together.
 *
 * DEFAULT IS UNSET, NEVER GUESSED. An absent document, a document with no mode
 * chosen, a shared mode with no group and a tenant with no row all resolve to
 * `unset`. The onboarding screen may then fall back to the group chosen on the
 * screen itself, and says it did. An unreadable or foreign document - or one
 * of ours with a field this release cannot read - resolves to `unknown`, which is NOT unset: falling back on a read that failed could
 * create a tenant's source in a group the mapping names for someone else.
 *
 * Both modes' choices are kept in the document, so switching mode and back
 * loses nothing the operator entered.
 *
 * Pure: no IO, no Date, no randomness.
 */

import type { KvDocumentLoad } from "../../ports/kv-document-store";
import { normalizeTenantId } from "../tenancy";

/** The KV document the mapping lives in (plain JSON; it holds no secret). */
export const TENANT_CRIBL_MAPPING_KEY = "tenant-cribl-mapping";
export const TENANT_CRIBL_MAPPING_KIND = "soc-tenant-cribl-mapping";
export const TENANT_CRIBL_MAPPING_VERSION = 1;

/** One worker group for every tenant, or a worker group per tenant. */
export type TenantCriblMode = "shared" | "per-tenant";

export interface TenantCriblMapping {
  /** Null until the operator chooses: never defaulted. */
  readonly mode: TenantCriblMode | null;
  /** The group every tenant uses in `shared` mode. */
  readonly sharedGroup: string | null;
  /** Normalized tenant id to its own group, used in `per-tenant` mode. */
  readonly groups: Readonly<Record<string, string>>;
}

/** Nothing chosen. */
export const UNSET_TENANT_CRIBL_MAPPING: TenantCriblMapping = Object.freeze({
  mode: null,
  sharedGroup: null,
  groups: Object.freeze({}),
});

/** What the stored document said. */
export type TenantCriblMappingRead =
  | {
      readonly kind: "read";
      readonly mapping: TenantCriblMapping;
      /** False when nothing was stored yet (the unset default). */
      readonly stored: boolean;
    }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * A Cribl worker group id as this document accepts it: trimmed, and only the
 * characters Cribl group ids are made of. Anything else is null, never
 * repaired into a group nobody chose.
 */
function cleanGroup(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const g = value.trim();
  return /^[A-Za-z0-9_.-]+$/.test(g) ? g : null;
}

/** Present-but-unreadable content: the document is left as it is, never trimmed into unset. */
function unreadable(what: string): TenantCriblMappingRead {
  return {
    kind: "unknown",
    reason: `the stored mapping has ${what} this release cannot read, so it is left as it is`,
  };
}

/**
 * Decode a stored document. Strict about whose it is, and strict inside it:
 * a field that is absent or null is "nothing chosen", but a field that is
 * PRESENT and unreadable makes the whole document unknown. Dropping it instead
 * would resolve to unset, let the onboarding screen fall back to its own
 * picker, and let a Save on Setup erase what was dropped.
 */
export function readTenantCriblMapping(load: KvDocumentLoad): TenantCriblMappingRead {
  if (load.kind === "unknown") return { kind: "unknown", reason: load.reason };
  if (load.kind === "absent") return { kind: "read", mapping: UNSET_TENANT_CRIBL_MAPPING, stored: false };
  const v = load.value;
  if (typeof v !== "object" || v === null || (v as Record<string, unknown>).kind !== TENANT_CRIBL_MAPPING_KIND) {
    return {
      kind: "unknown",
      reason: `the stored ${TENANT_CRIBL_MAPPING_KEY} document is not a tenant to Cribl mapping this app wrote, so it is left as it is`,
    };
  }
  const doc = v as Record<string, unknown>;
  if (doc.version !== TENANT_CRIBL_MAPPING_VERSION) {
    return {
      kind: "unknown",
      reason: `the stored mapping is version ${String(doc.version)}, which this release cannot read, so it is left as it is`,
    };
  }

  let mode: TenantCriblMode | null = null;
  if (doc.mode !== undefined && doc.mode !== null) {
    if (doc.mode !== "shared" && doc.mode !== "per-tenant") return unreadable(`a mode (${JSON.stringify(doc.mode)})`);
    mode = doc.mode;
  }

  let sharedGroup: string | null = null;
  if (doc.sharedGroup !== undefined && doc.sharedGroup !== null) {
    sharedGroup = cleanGroup(doc.sharedGroup);
    if (sharedGroup === null) return unreadable(`a shared group (${JSON.stringify(doc.sharedGroup)})`);
  }

  const groups: Record<string, string> = {};
  const rawGroups = doc.groups;
  if (rawGroups !== undefined && rawGroups !== null) {
    if (typeof rawGroups !== "object" || Array.isArray(rawGroups)) return unreadable("groups that are not a tenant map");
    for (const [tenant, group] of Object.entries(rawGroups as Record<string, unknown>)) {
      const t = normalizeTenantId(tenant);
      if (t === "") return unreadable("a group under a blank tenant id");
      const g = cleanGroup(group);
      if (g === null) return unreadable(`a group for tenant ${t} (${JSON.stringify(group)})`);
      groups[t] = g;
    }
  }
  return { kind: "read", stored: true, mapping: { mode, sharedGroup, groups } };
}

/** The document to store. */
export function encodeTenantCriblMapping(mapping: TenantCriblMapping): unknown {
  return {
    kind: TENANT_CRIBL_MAPPING_KIND,
    version: TENANT_CRIBL_MAPPING_VERSION,
    mode: mapping.mode,
    sharedGroup: mapping.sharedGroup,
    groups: { ...mapping.groups },
  };
}

/** Choose (or clear, with null) the mode. The other mode's choices are kept. */
export function withMappingMode(mapping: TenantCriblMapping, mode: TenantCriblMode | null): TenantCriblMapping {
  return { ...mapping, mode };
}

/** Choose (or clear, with null or blank) the group every tenant uses. */
export function withSharedGroup(mapping: TenantCriblMapping, group: string | null): TenantCriblMapping {
  return { ...mapping, sharedGroup: cleanGroup(group) };
}

/** Choose (or clear, with null or blank) one tenant's own group. A blank tenant changes nothing. */
export function withTenantGroup(
  mapping: TenantCriblMapping,
  tenantId: string,
  group: string | null,
): TenantCriblMapping {
  const t = normalizeTenantId(tenantId);
  if (t === "") return mapping;
  const groups = { ...mapping.groups };
  const g = cleanGroup(group);
  if (g === null) delete groups[t];
  else groups[t] = g;
  return { ...mapping, groups };
}

/** Why a tenant has no mapped group. */
export type TenantGroupUnsetWhy = "no-mode" | "no-shared-group" | "no-tenant-group";

/** Which worker group a tenant's sources go to, per the mapping. */
export type TenantGroupResolution =
  | { readonly kind: "mapped"; readonly groupId: string; readonly mode: TenantCriblMode }
  | { readonly kind: "unset"; readonly why: TenantGroupUnsetWhy }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * The tenant's worker group. `unset` only when the mapping was READ and names
 * no group for this tenant; a failed read, a foreign document and a blank
 * tenant id are `unknown`.
 */
export function resolveTenantGroup(read: TenantCriblMappingRead, tenantId: string): TenantGroupResolution {
  if (read.kind === "unknown") return { kind: "unknown", reason: read.reason };
  const t = normalizeTenantId(tenantId);
  if (t === "") {
    return { kind: "unknown", reason: "the active connection has no tenant id, so there is no tenant to look up" };
  }
  const m = read.mapping;
  if (m.mode === null) return { kind: "unset", why: "no-mode" };
  if (m.mode === "shared") {
    return m.sharedGroup === null
      ? { kind: "unset", why: "no-shared-group" }
      : { kind: "mapped", groupId: m.sharedGroup, mode: "shared" };
  }
  const own = m.groups[t];
  return own === undefined ? { kind: "unset", why: "no-tenant-group" } : { kind: "mapped", groupId: own, mode: "per-tenant" };
}

/** One tenant the mapping can hold a row for, with every connection that names it. */
export interface MappingTenant {
  readonly tenantId: string;
  readonly names: readonly string[];
}

/**
 * The distinct tenants among the connection profiles, in first-seen order,
 * and the names of the connections with no tenant id (which cannot be mapped).
 * Two connections for one tenant share one row: the mapping is per tenant,
 * like every other tenant-scoped fact (ADR 0009 decision 3).
 */
export function mappingTenants(
  profiles: readonly { readonly name: string; readonly config: { readonly tenantId: string } }[],
): { readonly tenants: readonly MappingTenant[]; readonly withoutTenant: readonly string[] } {
  const order: string[] = [];
  const names = new Map<string, string[]>();
  const withoutTenant: string[] = [];
  for (const p of profiles) {
    const t = normalizeTenantId(p.config.tenantId);
    if (t === "") {
      withoutTenant.push(p.name);
      continue;
    }
    const list = names.get(t);
    if (list === undefined) {
      order.push(t);
      names.set(t, [p.name]);
    } else {
      list.push(p.name);
    }
  }
  return { tenants: order.map((tenantId) => ({ tenantId, names: names.get(tenantId) ?? [] })), withoutTenant };
}
