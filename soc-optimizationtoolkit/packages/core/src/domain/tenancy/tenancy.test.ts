/**
 * Pins for the pure tenancy rules (ADR 0009 decisions 2 and 3): how a tenant
 * names its KV documents and its Cribl ids, the credential lease, the record of
 * whose secret sits in the shared slot, and the proof that a read answered for
 * the tenant it was meant for.
 *
 * The failure each rule guards is silent: one tenant's facts filed, read or
 * shown under another tenant's name. So these assert exact keys and verdicts,
 * not just "something came back".
 */

import { describe, expect, it } from "vitest";
import { isKvDocumentKey } from "../../ports/kv-document-store";
import {
  CREDENTIAL_LEASE_KEY,
  CREDENTIAL_OWNER_KEY,
  TENANT_PROOF_API_VERSION,
  clearedCredentialOwner,
  credentialOwnerMatches,
  decodeCredentialOwner,
  decodeLease,
  encodeCredentialOwner,
  isTenantMigrationMarker,
  leaseHeldByOther,
  normalizeTenantId,
  proveTenant,
  releasedLease,
  takenLease,
  tenantDocumentKey,
  tenantMigrationMarker,
  tenantProofRequest,
  tenantToken,
} from "./index";

const TENANT = "72F988BF-86F1-41AF-91AB-2D7CD011DB47";
const OTHER = "11111111-2222-3333-4444-555555555555";

describe("normalizeTenantId / tenantToken", () => {
  it("lower-cases and trims, so one tenant has one spelling", () => {
    expect(normalizeTenantId(`  ${TENANT} `)).toBe("72f988bf-86f1-41af-91ab-2d7cd011db47");
  });

  it("is the first 8 hex digits of the GUID, lower case", () => {
    expect(tenantToken(TENANT)).toBe("72f988bf");
  });

  it("is null for a blank tenant - no tenant is not a tenant called ''", () => {
    expect(tenantToken("")).toBeNull();
    expect(tenantToken("   ")).toBeNull();
  });

  it("takes the alphanumerics of a domain-name tenant", () => {
    expect(tenantToken("contoso.onmicrosoft.com")).toBe("contosoo");
  });

  it("gives two tenants two tokens", () => {
    expect(tenantToken(TENANT)).not.toBe(tenantToken(OTHER));
  });
});

describe("tenantDocumentKey", () => {
  it("files a document under base.tenant, lower-cased", () => {
    expect(tenantDocumentKey("azure-onboarding-progress", TENANT)).toBe(
      "azure-onboarding-progress.72f988bf-86f1-41af-91ab-2d7cd011db47",
    );
  });

  it("is a key the KV store accepts", () => {
    const key = tenantDocumentKey("azure-coverage-selection", TENANT);
    expect(key).not.toBeNull();
    expect(isKvDocumentKey(key ?? "")).toBe(true);
  });

  it("refuses a blank tenant rather than falling back to the unscoped key", () => {
    // The unscoped key is the LEGACY document; writing to it under "no tenant"
    // would resurrect the single-tenant shape this exists to remove.
    expect(tenantDocumentKey("azure-onboarding-progress", "  ")).toBeNull();
  });

  it("refuses a tenant that would make an unsafe key", () => {
    expect(tenantDocumentKey("azure-onboarding-progress", "../x")).toBeNull();
    expect(tenantDocumentKey("azure-onboarding-progress", "a b")).toBeNull();
  });

  it("gives two tenants two keys", () => {
    expect(tenantDocumentKey("k", TENANT)).not.toBe(tenantDocumentKey("k", OTHER));
  });
});

describe("tenant migration marker", () => {
  it("names the tenant the legacy document went to", () => {
    const marker = tenantMigrationMarker(TENANT);
    expect(isTenantMigrationMarker(marker)).toBe(true);
    expect((marker as { tenantId: string }).tenantId).toBe(normalizeTenantId(TENANT));
  });

  it("is not mistaken for an ordinary document", () => {
    expect(isTenantMigrationMarker({ kind: "azure-onboarding-progress", version: 1 })).toBe(false);
    expect(isTenantMigrationMarker(null)).toBe(false);
    expect(isTenantMigrationMarker("x")).toBe(false);
  });
});

describe("credential lease", () => {
  const NOW = 1_000_000;

  it("is free when absent", () => {
    expect(leaseHeldByOther({ kind: "absent", why: "not-found" }, "me", NOW)).toEqual({ held: false });
  });

  it("is held by another holder until it expires", () => {
    const lease = takenLease("them", NOW, 60_000);
    expect(leaseHeldByOther({ kind: "value", value: lease }, "me", NOW + 59_999)).toEqual({
      held: true,
      holder: "them",
      expiresAt: NOW + 60_000,
    });
    expect(leaseHeldByOther({ kind: "value", value: lease }, "me", NOW + 60_000)).toEqual({ held: false });
  });

  it("is not held against its own holder", () => {
    const lease = takenLease("me", NOW, 60_000);
    expect(leaseHeldByOther({ kind: "value", value: lease }, "me", NOW)).toEqual({ held: false });
  });

  it("is UNKNOWN when the lease cannot be read - never free", () => {
    // A refused read is not an empty lease (inventory honesty): taking the slot
    // on a read that failed is exactly the interleave the lease exists to stop.
    expect(leaseHeldByOther({ kind: "unknown", reason: "HTTP 403" }, "me", NOW)).toEqual({
      held: "unknown",
      reason: "HTTP 403",
    });
  });

  it("treats a released or unrecognised document as free", () => {
    expect(leaseHeldByOther({ kind: "value", value: releasedLease() }, "me", NOW)).toEqual({ held: false });
    expect(leaseHeldByOther({ kind: "value", value: { what: "else" } }, "me", NOW)).toEqual({ held: false });
  });

  it("round-trips through decodeLease", () => {
    expect(decodeLease(takenLease("me", NOW, 5))).toEqual({ holder: "me", expiresAt: NOW + 5 });
    expect(decodeLease(releasedLease())).toBeNull();
  });

  it("lives at a key the KV store accepts", () => {
    expect(isKvDocumentKey(CREDENTIAL_LEASE_KEY)).toBe(true);
    expect(isKvDocumentKey(CREDENTIAL_OWNER_KEY)).toBe(true);
  });
});

describe("credential owner record", () => {
  const owner = { profileId: "p1", tenantId: TENANT, clientId: "C1" };

  it("round-trips, normalising tenant and client", () => {
    expect(decodeCredentialOwner(encodeCredentialOwner(owner))).toEqual({
      profileId: "p1",
      tenantId: normalizeTenantId(TENANT),
      clientId: "c1",
    });
  });

  it("matches only the same tenant AND client", () => {
    const stored = decodeCredentialOwner(encodeCredentialOwner(owner));
    expect(credentialOwnerMatches(stored, { tenantId: TENANT.toLowerCase(), clientId: "c1" })).toBe(true);
    expect(credentialOwnerMatches(stored, { tenantId: OTHER, clientId: "c1" })).toBe(false);
    expect(credentialOwnerMatches(stored, { tenantId: TENANT, clientId: "c2" })).toBe(false);
    expect(credentialOwnerMatches(null, { tenantId: TENANT, clientId: "c1" })).toBe(false);
  });

  it("a CLEARED record decodes as no owner, so a deleted secret leaves no stale claim", () => {
    expect(decodeCredentialOwner(clearedCredentialOwner())).toBeNull();
  });

  it("decodes anything else as null", () => {
    expect(decodeCredentialOwner({ profileId: "p1" })).toBeNull();
    expect(decodeCredentialOwner(null)).toBeNull();
  });
});

describe("tenant proof", () => {
  it("reads the subscription the profile targets", () => {
    expect(tenantProofRequest("sub-1")).toEqual({
      method: "GET",
      path: "/subscriptions/sub-1",
      apiVersion: TENANT_PROOF_API_VERSION,
    });
  });

  it("refuses to build a proof with no subscription", () => {
    expect(tenantProofRequest("  ")).toBeNull();
  });

  it("is proven only when the subscription's tenantId is the expected tenant", () => {
    expect(proveTenant({ status: 200, body: { tenantId: TENANT.toLowerCase() } }, TENANT)).toEqual({
      kind: "proven",
    });
  });

  it("is a MISMATCH when another tenant answered", () => {
    expect(proveTenant({ status: 200, body: { tenantId: OTHER } }, TENANT)).toEqual({
      kind: "mismatch",
      actual: OTHER,
    });
  });

  it("is UNKNOWN when the read was refused, failed or carried no tenant", () => {
    // Never red, never proven: a refused proof read says nothing about whose
    // token the proxy sent.
    expect(proveTenant({ status: 403, body: "denied" }, TENANT).kind).toBe("unknown");
    expect(proveTenant({ status: 404, body: null }, TENANT).kind).toBe("unknown");
    expect(proveTenant({ status: 200, body: { subscriptionId: "s" } }, TENANT).kind).toBe("unknown");
  });

  it("is UNKNOWN for a DELEGATED subscription - its tenantId is the home tenant, not the token's", () => {
    // Review finding: under Azure Lighthouse a token issued by a MANAGING
    // tenant reads the subscription too, and the body still names the home
    // tenant. So the answer cannot say whose token the proxy sent.
    const out = proveTenant(
      { status: 200, body: { tenantId: TENANT, managedByTenants: [{ tenantId: OTHER }] } },
      TENANT,
    );
    expect(out.kind).toBe("unknown");
    expect(out.kind === "unknown" ? out.reason : "").toContain(OTHER);
  });

  it("an empty managedByTenants is not delegation", () => {
    expect(proveTenant({ status: 200, body: { tenantId: TENANT, managedByTenants: [] } }, TENANT)).toEqual({
      kind: "proven",
    });
  });
});
