/**
 * Tenancy - the pure rules that keep one Azure tenant's facts apart from
 * another's (ADR 0009 decisions 2 and 3).
 *
 *   tenantDocumentKey   where a tenant's KV document lives
 *   tenantToken         the short tenant component in Cribl ids
 *   lease               the best-effort KV lease taken before the shared
 *                       credential slot is swapped to another tenant
 *   credential owner    a plain, NON-secret record of whose client secret was
 *                       last written to the shared `azureBasic` slot
 *   tenant proof        the read that proves a batch was answered by the
 *                       tenant it was meant for
 *
 * WHY A LEASE AND A PROOF. The Cribl app proxy injects every Azure credential
 * from one fixed KV key per host (measured; claude-kit
 * standards/cribl-app-platform.md), so reading tenant N means putting N's
 * credential into that one slot. The KV store is shared by every tab and user
 * and has no compare-and-swap: the lease stops this app's own tabs from
 * interleaving, and the proof - read BEFORE the work and again AFTER it -
 * catches a swap that happened before or during the batch.
 *
 * WHAT THE PROOF DOES NOT PROVE. It reads the subscription's HOME tenant, not
 * the tenant that issued the token. Those differ only when another tenant's
 * identity can read the subscription, which for a service principal means
 * Azure Lighthouse delegation - so a delegated subscription (non-empty
 * `managedByTenants`) is unknown, never proven. A request between the two
 * proofs is covered only by the two of them agreeing, not individually, and
 * the Graph token is not proven at all: there is no Graph read this app holds
 * a permission for that names the token's tenant.
 *
 * Pure: no IO, no Date, no randomness. The clock arrives as a number.
 */

import type { AzureManagementRequest } from "../../ports/azure-management";
import type { PortHttpResponse } from "../../ports/http";
import type { KvDocumentLoad } from "../../ports/kv-document-store";
import { isKvDocumentKey } from "../../ports/kv-document-store";

/** One tenant, one spelling: trimmed and lower case (Entra ids are case-blind). */
export function normalizeTenantId(tenantId: string): string {
  return tenantId.trim().toLowerCase();
}

/** Length of {@link tenantToken}: 8 hex digits, 32 bits. */
const TENANT_TOKEN_LENGTH = 8;

/**
 * The short tenant component a Cribl id carries: the first 8 alphanumerics of
 * the tenant id, lower case (for a GUID, its first 8 hex digits). Null for a
 * blank tenant, so a caller cannot file something under a tenant called "".
 *
 * 32 bits: a collision needs two tenants whose GUIDs share their first eight
 * digits AND the same namespace or table, and it surfaces as an existing Cribl
 * object that differs, which the create paths already refuse.
 */
export function tenantToken(tenantId: string): string | null {
  const alnum = normalizeTenantId(tenantId).replace(/[^a-z0-9]/g, "");
  return alnum === "" ? null : alnum.slice(0, TENANT_TOKEN_LENGTH);
}

/**
 * The KV key a tenant's copy of a document lives under: `{base}.{tenantId}`.
 * Null when the tenant is blank or would make an unsafe key - deliberately NOT
 * the unscoped `base`, which is the legacy single-tenant document.
 *
 * `.` and not `/`: a key that is both a document (`base`) and a prefix
 * (`base/x`) is a shape the platform was never measured with.
 */
export function tenantDocumentKey(base: string, tenantId: string): string | null {
  const tenant = normalizeTenantId(tenantId);
  if (tenant === "" || !/^[a-z0-9.-]+$/.test(tenant)) return null;
  const key = `${base}.${tenant}`;
  return isKvDocumentKey(key) ? key : null;
}

// ---------------------------------------------------------------------------
// Tenant marker in a Cribl object's description
// ---------------------------------------------------------------------------

/**
 * The text a Cribl object's description carries to say which tenant it was
 * written for: ` (tenant {id})`. Appended before the ownership stamp.
 */
export function tenantDescriptionMarker(tenantId: string): string {
  return `(tenant ${normalizeTenantId(tenantId)})`;
}

/** The tenant a description names through {@link tenantDescriptionMarker}, or null. */
export function tenantNamedIn(description: string): string | null {
  const match = /\(tenant ([^)\s]+)\)/i.exec(description);
  return match === null ? null : normalizeTenantId(match[1] ?? "");
}

// ---------------------------------------------------------------------------
// Migration marker
// ---------------------------------------------------------------------------

const MIGRATION_MARKER_KIND = "soc-tenant-migrated";

/** What a legacy unscoped document is replaced with once it has been filed under a tenant. */
export interface TenantMigrationMarker {
  readonly kind: typeof MIGRATION_MARKER_KIND;
  readonly tenantId: string;
}

/**
 * The marker written over a legacy unscoped document after its one-time move
 * under `tenantId`, so a second tenant never adopts the same document.
 */
export function tenantMigrationMarker(tenantId: string): TenantMigrationMarker {
  return { kind: MIGRATION_MARKER_KIND, tenantId: normalizeTenantId(tenantId) };
}

/**
 * The document that names the tenant which adopted a legacy unscoped document
 * (`{base}-migrated`, holding a {@link tenantMigrationMarker}). Written BEFORE
 * the copy, under a key no pre-upgrade bundle ever writes: the marker over the
 * legacy key can be overwritten by a tab still running the old bundle, this
 * claim cannot. `-` and not `.`, so it never collides with a
 * {@link tenantDocumentKey}.
 */
export function tenantMigrationClaimKey(base: string): string {
  return `${base}-migrated`;
}

/** Whether a stored value is a {@link tenantMigrationMarker}. */
export function isTenantMigrationMarker(value: unknown): value is TenantMigrationMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).kind === MIGRATION_MARKER_KIND &&
    typeof (value as Record<string, unknown>).tenantId === "string"
  );
}

// ---------------------------------------------------------------------------
// Credential lease
// ---------------------------------------------------------------------------

/** The KV document the lease lives in (plain JSON; it holds no secret). */
export const CREDENTIAL_LEASE_KEY = "azure-credential-lease";

const LEASE_KIND = "soc-credential-lease";

/** A lease as decoded: who holds it and until when (epoch ms, the shell's clock). */
export interface CredentialLease {
  readonly holder: string;
  readonly expiresAt: number;
}

/** The document written to take the lease. */
export function takenLease(holder: string, now: number, ttlMs: number): unknown {
  return { kind: LEASE_KIND, holder, expiresAt: now + ttlMs };
}

/** The document written to release it. */
export function releasedLease(): unknown {
  return { kind: LEASE_KIND, holder: null, expiresAt: 0 };
}

/** Decode a stored lease; null for a released, foreign or malformed document. */
export function decodeLease(value: unknown): CredentialLease | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== LEASE_KIND) return null;
  if (typeof v.holder !== "string" || v.holder === "") return null;
  if (typeof v.expiresAt !== "number" || !Number.isFinite(v.expiresAt)) return null;
  return { holder: v.holder, expiresAt: v.expiresAt };
}

/** Whether another holder has the lease right now. */
export type LeaseVerdict =
  | { readonly held: false }
  | { readonly held: true; readonly holder: string; readonly expiresAt: number }
  | { readonly held: "unknown"; readonly reason: string };

/**
 * Whether the lease as read is held by someone other than `holder` at `now`.
 * An unreadable lease is `unknown`, never free: taking the slot on a read that
 * failed is the interleave the lease is there to stop.
 */
export function leaseHeldByOther(read: KvDocumentLoad, holder: string, now: number): LeaseVerdict {
  if (read.kind === "unknown") return { held: "unknown", reason: read.reason };
  if (read.kind === "absent") return { held: false };
  const lease = decodeLease(read.value);
  if (lease === null || lease.holder === holder || lease.expiresAt <= now) return { held: false };
  return { held: true, holder: lease.holder, expiresAt: lease.expiresAt };
}

// ---------------------------------------------------------------------------
// Credential owner (the last writer of azureBasic)
// ---------------------------------------------------------------------------

/**
 * The KV document naming whose client secret was last written to the shared
 * `azureBasic` slot. Plain JSON, NOT a secret: ids only. The encrypted slot can
 * never be read back, so without this record a tab cannot tell whose secret is
 * there (audit, App.tsx secret probe).
 */
export const CREDENTIAL_OWNER_KEY = "azure-credential-owner";

const OWNER_KIND = "soc-credential-owner";

/** Whose secret the shared slot holds. */
export interface CredentialOwner {
  readonly profileId: string;
  readonly tenantId: string;
  readonly clientId: string;
}

/** The document to write after a secret lands in `azureBasic`. */
export function encodeCredentialOwner(owner: CredentialOwner): unknown {
  return {
    kind: OWNER_KIND,
    profileId: owner.profileId,
    tenantId: normalizeTenantId(owner.tenantId),
    clientId: owner.clientId.trim().toLowerCase(),
  };
}

/**
 * The document written wherever `azureBasic` is deleted: it decodes as no
 * owner, so a deleted secret leaves no stale claim behind.
 */
export function clearedCredentialOwner(): unknown {
  return { kind: OWNER_KIND, profileId: null, tenantId: null, clientId: null };
}

/** Decode the owner record; null when absent, foreign or malformed. */
export function decodeCredentialOwner(value: unknown): CredentialOwner | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== OWNER_KIND) return null;
  if (typeof v.profileId !== "string" || typeof v.tenantId !== "string" || typeof v.clientId !== "string") {
    return null;
  }
  return {
    profileId: v.profileId,
    tenantId: normalizeTenantId(v.tenantId),
    clientId: v.clientId.trim().toLowerCase(),
  };
}

/** Whether the slot's recorded owner is this tenant AND client. */
export function credentialOwnerMatches(
  owner: CredentialOwner | null,
  identity: { readonly tenantId: string; readonly clientId: string },
): boolean {
  return (
    owner !== null &&
    owner.tenantId === normalizeTenantId(identity.tenantId) &&
    owner.clientId === identity.clientId.trim().toLowerCase()
  );
}

// ---------------------------------------------------------------------------
// Tenant proof
// ---------------------------------------------------------------------------

/** Subscriptions - Get. The api-version the subscription listing already uses. */
export const TENANT_PROOF_API_VERSION = "2022-12-01";

/**
 * The read that proves which tenant answered: GET /subscriptions/{sub}, whose
 * body carries the subscription's `tenantId`. Chosen over GET /tenants because
 * it is the operation the least-privilege registry already holds for every
 * profile (Microsoft.Resources/subscriptions/read, granted by any role that
 * reaches the subscription), and because it is anchored to the profile's own
 * subscription: a token for another tenant is refused it outright. GET
 * /tenants was not in the audit at all. Null when the profile names no
 * subscription - there is then nothing to prove against.
 */
export function tenantProofRequest(subscriptionId: string): AzureManagementRequest | null {
  const sub = subscriptionId.trim();
  if (sub === "") return null;
  return { method: "GET", path: `/subscriptions/${sub}`, apiVersion: TENANT_PROOF_API_VERSION };
}

/** What the proof read said. */
export type TenantProof =
  | { readonly kind: "proven" }
  | { readonly kind: "mismatch"; readonly actual: string }
  | { readonly kind: "unknown"; readonly reason: string };

/** The tenants a subscription is delegated to (Azure Lighthouse), from its read. */
function managingTenantsOf(body: Record<string, unknown>): string[] {
  const managed = body.managedByTenants;
  if (!Array.isArray(managed)) return [];
  return managed
    .map((m) => (typeof m === "object" && m !== null ? (m as Record<string, unknown>).tenantId : undefined))
    .filter((t): t is string => typeof t === "string" && t.trim() !== "")
    .map(normalizeTenantId);
}

/**
 * Judge the proof read. Proven only on a 200 whose `tenantId` is the expected
 * tenant and that is not delegated to any other tenant; a different tenant is
 * a mismatch; anything else - refused, failed, no tenantId in the body, a
 * delegated subscription - is unknown, never proven and never red.
 */
export function proveTenant(response: PortHttpResponse, expectedTenantId: string): TenantProof {
  if (response.status !== 200) {
    return { kind: "unknown", reason: `the proof read answered HTTP ${response.status}` };
  }
  const body = response.body;
  const actual =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>).tenantId : undefined;
  if (typeof actual !== "string" || actual.trim() === "") {
    return { kind: "unknown", reason: "the subscription read carried no tenantId" };
  }
  if (normalizeTenantId(actual) !== normalizeTenantId(expectedTenantId)) {
    return { kind: "mismatch", actual: normalizeTenantId(actual) };
  }
  const managing = managingTenantsOf(body as Record<string, unknown>);
  if (managing.length > 0) {
    return {
      kind: "unknown",
      reason:
        `the subscription is delegated to tenant ${managing.join(", ")} (Azure Lighthouse), so a token from there reads it ` +
        "too and its tenantId cannot say whose token answered",
    };
  }
  return { kind: "proven" };
}
