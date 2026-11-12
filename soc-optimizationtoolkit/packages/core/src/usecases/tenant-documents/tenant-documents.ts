/**
 * Load a tenant's copy of a KV document, moving the legacy unscoped document
 * under the ACTIVE tenant the first time (ADR 0009 decision 3).
 *
 * Before multi-tenant support, the How-to progress (plan values, ticks, Cribl
 * source records) and the coverage selection each lived under ONE key for the
 * whole app. They now live under `{base}.{tenantId}`. The first load after the
 * upgrade, by whichever tenant is active then, adopts the legacy document and
 * overwrites it with a marker naming that tenant, so no second tenant adopts
 * it too. After that the legacy key is never read as a document again: one
 * shape, read once. The one exception is {@link readStrandedLegacyDocument},
 * which only REPORTS what an earlier app version wrote there later (AZR-96)
 * and never adopts or merges it.
 *
 * THE CLAIM. The marker over the legacy key is not enough on its own: a tab
 * still running the pre-upgrade bundle keeps saving the whole single-tenant
 * document to that key, over the marker, and the next tenant to load would
 * adopt it. So the adopting tenant first writes a claim under a key the old
 * bundle never writes ({@link tenantMigrationClaimKey}) and reads it back; a
 * claim naming another tenant means the legacy document is not this tenant's,
 * whatever the legacy key holds now. No compare-and-swap exists, so two tabs
 * racing the very first load can still both write a claim - the read-back
 * leaves only the last writer adopting.
 *
 * THE TENANT THAT ADOPTS IT is the one active when a screen first loads the
 * document - the only tenant the app had before this change, unless the
 * operator added and switched to a second connection before opening the screen.
 * That is the audit's own rule ("assign the legacy document to the profile
 * that was active when the migration runs").
 *
 * Honesty: every unreadable step is `unknown`, which blocks the caller's save;
 * nothing that failed is ever reported as a first run.
 */

import type { KvDocumentLoad, KvDocumentStore } from "../../ports/kv-document-store";
import {
  isTenantMigrationMarker,
  normalizeTenantId,
  tenantDocumentKey,
  tenantMigrationClaimKey,
  tenantMigrationMarker,
} from "../../domain/tenancy";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read `{base}.{tenantId}`; when it is absent, migrate `base` into it once.
 * Never rejects.
 */
export async function loadTenantDocument(
  store: KvDocumentStore,
  base: string,
  tenantId: string,
): Promise<KvDocumentLoad> {
  const key = tenantDocumentKey(base, tenantId);
  if (key === null) {
    return {
      kind: "unknown",
      reason: "the active connection has no tenant id, so there is no tenant to file this under",
    };
  }
  const scoped = await store.load(key);
  if (scoped.kind !== "absent") return scoped;

  const legacy = await store.load(base);
  if (legacy.kind === "unknown") {
    return {
      kind: "unknown",
      reason: `the earlier single-tenant copy could not be read (${legacy.reason}), so whether it should move to this tenant is unknown`,
      ...(legacy.status !== undefined ? { status: legacy.status } : {}),
    };
  }
  if (legacy.kind === "absent" || isTenantMigrationMarker(legacy.value)) return scoped;

  // The claim: which tenant the legacy document belongs to.
  const claimKey = tenantMigrationClaimKey(base);
  const claimedBy = async (): Promise<{ kind: "tenant"; tenantId: string } | { kind: "none" } | KvDocumentLoad> => {
    const claim = await store.load(claimKey);
    if (claim.kind === "unknown") return claim;
    if (claim.kind === "absent" || !isTenantMigrationMarker(claim.value)) return { kind: "none" };
    return { kind: "tenant", tenantId: claim.value.tenantId };
  };
  const unreadableClaim = (reason: string): KvDocumentLoad => ({
    kind: "unknown",
    reason: `whether the earlier single-tenant copy was already claimed by another tenant could not be read (${reason})`,
  });
  const me = normalizeTenantId(tenantId);
  let claim = await claimedBy();
  if (claim.kind === "unknown") return unreadableClaim(claim.reason);
  if (claim.kind === "none") {
    try {
      await store.save(claimKey, tenantMigrationMarker(tenantId));
    } catch (err) {
      return {
        kind: "unknown",
        reason: `the earlier single-tenant copy could not be claimed for this tenant (${errText(err)})`,
      };
    }
    claim = await claimedBy();
    if (claim.kind === "unknown") return unreadableClaim(claim.reason);
  }
  // Another tenant adopted it (or won the race to): not this tenant's document.
  if (claim.kind !== "tenant" || claim.tenantId !== me) return scoped;

  try {
    await store.save(key, legacy.value);
  } catch (err) {
    return {
      kind: "unknown",
      reason: `the earlier single-tenant copy could not be moved to this tenant (${errText(err)})`,
    };
  }
  try {
    await store.save(base, tenantMigrationMarker(tenantId));
  } catch {
    // The tenant has its copy; only the marker is missing, so a second tenant
    // could still adopt the legacy document. Best effort: the next load by any
    // tenant whose own copy is absent tries the marker again.
  }
  return { kind: "value", value: legacy.value };
}

/**
 * What the legacy unscoped document holds for a tenant whose own document
 * already exists (AZR-96). Discriminated on `kind`:
 *
 *   none          nothing to report: no legacy document, only the migration
 *                 marker, or a document the claim gives to ANOTHER tenant
 *   stranded      a document the claim gives to THIS tenant, written after the
 *                 migration (a tab still running the pre-upgrade bundle)
 *   unattributed  a document with no claim at all, so no tenant is known to
 *                 own it - written by an earlier app version after a first run
 *                 that had nothing to migrate. The caller shows it as "tenant
 *                 unknown" and never as this tenant's own state
 *   unknown       the legacy document or the claim could not be read
 */
export type StrandedLegacyRead =
  | { kind: "none" }
  | { kind: "stranded"; value: unknown }
  | { kind: "unattributed"; value: unknown }
  | { kind: "unknown"; reason: string; status?: number };

/**
 * Read the legacy unscoped document `base` for a report, never for adoption
 * (AZR-96). {@link loadTenantDocument} stops reading `base` once the tenant's
 * own document exists, so a record an earlier app version saved there
 * afterwards is otherwise invisible. STRICTLY READ-ONLY: it writes no claim,
 * no marker and no copy, and it does not touch the tenant's own document.
 * Never rejects.
 */
export async function readStrandedLegacyDocument(
  store: KvDocumentStore,
  base: string,
  tenantId: string,
): Promise<StrandedLegacyRead> {
  const me = normalizeTenantId(tenantId);
  if (me === "") {
    return {
      kind: "unknown",
      reason: "the active connection has no tenant id, so whose earlier records these are cannot be told",
    };
  }
  const legacy = await store.load(base);
  if (legacy.kind === "unknown") {
    return {
      kind: "unknown",
      reason: `the earlier single-tenant copy could not be read (${legacy.reason})`,
      ...(legacy.status !== undefined ? { status: legacy.status } : {}),
    };
  }
  if (legacy.kind === "absent" || isTenantMigrationMarker(legacy.value)) return { kind: "none" };

  const claim = await store.load(tenantMigrationClaimKey(base));
  if (claim.kind === "unknown") {
    return {
      kind: "unknown",
      reason: `which tenant the earlier single-tenant copy belongs to could not be read (${claim.reason})`,
      ...(claim.status !== undefined ? { status: claim.status } : {}),
    };
  }
  if (claim.kind === "absent" || !isTenantMigrationMarker(claim.value)) {
    return { kind: "unattributed", value: legacy.value };
  }
  // Multi-tenant isolation: a document claimed by another tenant is never shown here.
  if (normalizeTenantId(claim.value.tenantId) !== me) return { kind: "none" };
  return { kind: "stranded", value: legacy.value };
}
