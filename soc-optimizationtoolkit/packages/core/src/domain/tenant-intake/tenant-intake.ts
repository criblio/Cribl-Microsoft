/**
 * The Setup tenant list - paste tenant ids, get a connection per tenant
 * (ADR 0009 decision 1, AZR-62).
 *
 * A tenant is a connection profile (domain/azure-profiles). The operator
 * pastes a comma- or newline-delimited list; each entry must be a GUID. This
 * module parses the list, plans which tenants are new, adds a blank profile
 * per new tenant, and resolves the config each tenant's change request is
 * generated from.
 *
 * NEVER OVERWRITES. A tenant some profile already carries (in any case, bare
 * or braced) gets no new profile, and no existing profile is changed - not its config, not
 * its name, not which profile is active. Adding profiles writes no secret:
 * the client secret lives in the one shared `azureBasic` slot (see
 * azure-profiles), which only Save and connect writes, so a pasted list can
 * neither replace a saved secret nor leave one filed under the wrong tenant.
 *
 * UNKNOWN IS NOT NEW. A connection may hold its tenant as a domain name
 * (`contoso.onmicrosoft.com`, which the token endpoint accepts). Nothing here
 * can tell which GUID that names, so while such a connection exists, a pasted
 * tenant no GUID matches is UNDETERMINED - reported with the connections that
 * could not be compared, and given no profile - rather than counted as new and
 * duplicated.
 *
 * ONE CONNECTION PER TICKET. The app registration is per tenant, but the RBAC
 * plan (setupPath) and its scopes (subscription, resource group) are per
 * connection, so a tenant two connections carry gets two ticket targets, each
 * from its own connection's config. A ticket never claims to cover a
 * connection whose privileges it does not ask for.
 *
 * NAMED, NEVER DROPPED. An entry that is not a tenant id is returned as typed
 * (trimmed), so the screen can say which entries were refused; a silently
 * dropped entry reads as a tenant that was added.
 *
 * Spaces do not delimit: `a b` is one entry and it is refused, named. A space
 * is more often a paste of two ids glued together than a deliberate list.
 *
 * Pure: no IO, no Date, no randomness. Profile ids are minted by the shell and
 * passed in.
 */

import { EMPTY_AZURE_CONFIG } from "../azure-config";
import type { AzureConfig } from "../azure-config";
import type { ConnectionProfile, ProfileStore } from "../azure-profiles";
import { normalizeTenantId, tenantToken } from "../tenancy";

/** A GUID in its canonical 8-4-4-4-12 form, any case, no braces. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The nil GUID: well formed, and it names no tenant. */
const NIL_GUID = "00000000-0000-0000-0000-000000000000";

/** True when `value` is a tenant id: a canonical GUID other than the nil one. */
export function isTenantId(value: string): boolean {
  return GUID.test(value) && value !== NIL_GUID;
}

/** The result of parsing a pasted tenant list. */
export interface TenantIdListParse {
  /** Valid tenant ids, normalized (lower case), each once, in first-seen order. */
  readonly tenants: string[];
  /** Entries that are not tenant ids, as typed but trimmed, each once, in order. */
  readonly invalid: string[];
  /** Normalized tenant ids that appeared more than once, each once. */
  readonly duplicates: string[];
}

/**
 * Parse a comma- or newline-delimited list of tenant ids. Blank entries (a
 * trailing comma, a doubled newline) are ignored; everything else is either a
 * tenant or named as invalid.
 */
export function parseTenantIdList(text: string): TenantIdListParse {
  const tenants: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  for (const raw of text.split(/[,\r\n]/)) {
    const entry = raw.trim();
    if (entry === "") continue;
    if (!isTenantId(entry)) {
      if (!invalid.includes(entry)) invalid.push(entry);
      continue;
    }
    const tenant = normalizeTenantId(entry);
    if (tenants.includes(tenant)) {
      if (!duplicates.includes(tenant)) duplicates.push(tenant);
    } else {
      tenants.push(tenant);
    }
  }
  return { tenants, invalid, duplicates };
}

/** Which pasted tenants need a profile, and which some profile already carries. */
export interface TenantProfilePlan {
  /** Tenants no profile carries and none might: each gets a new profile. */
  readonly create: string[];
  /** Tenants one or more profiles already carry: left exactly as they are. */
  readonly existing: { tenantId: string; profileIds: string[]; names: string[] }[];
  /**
   * Tenants no profile is KNOWN to carry, while some profile holds a tenant
   * that cannot be compared (not a GUID). Unknown, not new: they get no
   * profile. `connections` names those profiles and the tenant each holds.
   */
  readonly undetermined: { tenantId: string; connections: { name: string; tenant: string }[] }[];
}

/**
 * The GUID a profile's tenant names, normalized: trimmed, lower case, one
 * pair of surrounding braces removed. Null when it is not a tenant id (blank,
 * a domain name, anything else).
 */
function profileTenantGuid(raw: string): string | null {
  const t = normalizeTenantId(raw);
  const bare = t.startsWith("{") && t.endsWith("}") ? t.slice(1, -1).trim() : t;
  return isTenantId(bare) ? bare : null;
}

/** The profiles whose tenant id is `tenantId`, in store order. */
function profilesFor(store: ProfileStore, tenantId: string): ConnectionProfile[] {
  const tenant = normalizeTenantId(tenantId);
  return store.profiles.filter((p) => profileTenantGuid(p.config.tenantId) === tenant);
}

/** The profiles that hold a tenant which cannot be compared with a GUID. */
function uncomparableProfiles(store: ProfileStore): ConnectionProfile[] {
  return store.profiles.filter((p) => p.config.tenantId.trim() !== "" && profileTenantGuid(p.config.tenantId) === null);
}

/** Split `tenants` into new ones, ones a profile already carries, and ones nobody can tell. */
export function planTenantProfiles(store: ProfileStore, tenants: readonly string[]): TenantProfilePlan {
  const create: string[] = [];
  const existing: TenantProfilePlan["existing"] = [];
  const undetermined: TenantProfilePlan["undetermined"] = [];
  const uncomparable = uncomparableProfiles(store);
  for (const raw of tenants) {
    const tenantId = normalizeTenantId(raw);
    const matches = profilesFor(store, tenantId);
    if (matches.length > 0) {
      existing.push({ tenantId, profileIds: matches.map((p) => p.id), names: matches.map((p) => p.name) });
    } else if (uncomparable.length > 0) {
      undetermined.push({
        tenantId,
        connections: uncomparable.map((p) => ({ name: p.name, tenant: p.config.tenantId.trim() })),
      });
    } else {
      create.push(tenantId);
    }
  }
  return { create, existing, undetermined };
}

/**
 * The name for a new tenant's profile: `Tenant <first 8 digits>`, or, when a
 * profile already has that name (any case), `Tenant <full tenant id>`, then
 * that with ` (2)`, ` (3)`... The secret is entered by picking a connection
 * by name, so two connections must never share one.
 */
function uniqueTenantName(tenantId: string, taken: ReadonlySet<string>): string {
  for (const name of [`Tenant ${tenantToken(tenantId) ?? tenantId}`, `Tenant ${tenantId}`]) {
    if (!taken.has(name.toLowerCase())) return name;
  }
  for (let n = 2; ; n += 1) {
    const name = `Tenant ${tenantId} (${n})`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/**
 * Add a blank profile for each tenant in `tenants` that {@link planTenantProfiles}
 * puts in `create`, with only the tenant id filled in and a name no other
 * profile has. Returns a NEW store; existing profiles and the active choice
 * are untouched. `mintId` is called once per profile actually added.
 *
 * Throws on a value that is not a tenant id: the caller should only pass
 * what {@link parseTenantIdList} accepted, and a profile filed under garbage
 * would be worse than a loud failure.
 */
export function addTenantProfiles(
  store: ProfileStore,
  tenants: readonly string[],
  mintId: (tenantId: string) => string,
): ProfileStore {
  for (const t of tenants) {
    if (!isTenantId(t.trim())) throw new Error(`'${t}' is not a tenant id`);
  }
  const taken = new Set(store.profiles.map((p) => p.name.trim().toLowerCase()));
  const added: ConnectionProfile[] = [];
  for (const tenantId of planTenantProfiles(store, tenants).create) {
    if (added.some((p) => p.config.tenantId === tenantId)) continue;
    const name = uniqueTenantName(tenantId, taken);
    taken.add(name.toLowerCase());
    added.push({ id: mintId(tenantId), name, config: { ...EMPTY_AZURE_CONFIG, tenantId } });
  }
  if (added.length === 0) return store;
  return { profiles: [...store.profiles, ...added], activeProfileId: store.activeProfileId };
}

/** What one change request is generated from: one tenant, at most one connection. */
export interface TenantTicketTarget {
  /** The tenant, normalized. */
  readonly tenantId: string;
  /** The ONE connection whose config this ticket is built from; null for a tenant with none. */
  readonly connectionName: string | null;
  /** How many connections carry this tenant (0 for none); above 1, each has its own ticket. */
  readonly connectionsForTenant: number;
  /**
   * For a tenant no connection is known to carry: the connections whose
   * tenant could not be compared (not a GUID), any of which might be it.
   * Empty otherwise.
   */
  readonly undeterminedConnections: readonly string[];
  /**
   * That connection's config (so a client id, subscription, resource group
   * and setup path already known are used), or a blank config - with the
   * tenant id set to {@link tenantId} either way, so the ticket names the
   * tenant it was asked for even when the profile spells it otherwise.
   */
  readonly config: AzureConfig;
}

/**
 * The ticket targets for the tenants, in the order given: one per connection
 * that carries the tenant (store order), or one blank target for a tenant
 * with none.
 */
export function tenantTicketTargets(store: ProfileStore, tenants: readonly string[]): TenantTicketTarget[] {
  const uncomparable = uncomparableProfiles(store).map((p) => p.name);
  return tenants.flatMap((raw): TenantTicketTarget[] => {
    const tenantId = normalizeTenantId(raw);
    const matches = profilesFor(store, tenantId);
    if (matches.length === 0) {
      return [
        {
          tenantId,
          connectionName: null,
          connectionsForTenant: 0,
          undeterminedConnections: uncomparable,
          config: { ...EMPTY_AZURE_CONFIG, tenantId },
        },
      ];
    }
    return matches.map((p) => ({
      tenantId,
      connectionName: p.name,
      connectionsForTenant: matches.length,
      undeterminedConnections: [],
      config: { ...p.config, tenantId },
    }));
  });
}
