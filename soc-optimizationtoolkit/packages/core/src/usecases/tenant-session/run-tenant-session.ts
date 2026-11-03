/**
 * The tenant session sequence (ADR 0009 decision 2) over the shell's
 * {@link CredentialSlot}: lease, swap, prove, work, restore, release.
 *
 *   1. Refuse before touching anything when the run could not be proven or
 *      could not be undone: no tenant or subscription on the profile, the
 *      target's secret not held this session, or - when the target is not the
 *      active connection - the ACTIVE secret not held either, because then the
 *      operator's own connection could not be put back.
 *   2. Take the KV lease (best effort, no compare-and-swap): refuse while
 *      another holder's lease is unexpired, and refuse on an unreadable lease.
 *   3. Inside the slot's exclusive section: write the target's credential
 *      (only when it is not already the active one), record the owner, mint ARM
 *      and Graph tokens for the target tenant.
 *   4. PROVE: GET /subscriptions/{sub} must answer with the target's tenantId.
 *      A mismatch or a refusal makes the batch unknown and the work never runs.
 *   5. Run the work with the slot's session ports.
 *   5b. PROVE AGAIN, and re-read the lease. The lease has no compare-and-swap
 *      and other paths (another tab's Save and connect) write the slot, so a
 *      swap DURING the work is possible; the batch is `done` only when the
 *      second proof also answers as the target and the lease is still this
 *      holder's and unexpired. Otherwise it is unknown - its answers may be
 *      another tenant's.
 *   6. Restore the ACTIVE connection's credential and tokens, whatever happened.
 *   7. Release the lease, unless it has already expired (it may be someone
 *      else's by then).
 *
 * What the proof cannot prove is written down in domain/tenancy (a delegated
 * subscription is unknown; the Graph token is not proven).
 *
 * Never rejects. The clock is injected; core reads no clock of its own.
 */

import type { KvDocumentStore } from "../../ports/kv-document-store";
import type { Logger } from "../../ports/logger";
import type {
  CredentialSlot,
  TenantPorts,
  TenantProfile,
  TenantRestore,
  TenantRun,
  TenantRunStage,
} from "../../ports/tenant-session";
import {
  CREDENTIAL_LEASE_KEY,
  CREDENTIAL_OWNER_KEY,
  decodeLease,
  encodeCredentialOwner,
  leaseHeldByOther,
  normalizeTenantId,
  proveTenant,
  releasedLease,
  takenLease,
  tenantProofRequest,
} from "../../domain/tenancy";

/** Default lease lifetime: long enough for one tenant's scan at the shared budget. */
export const DEFAULT_TENANT_LEASE_TTL_MS = 10 * 60 * 1000;

export interface TenantSessionDeps {
  readonly slot: CredentialSlot;
  /** Where the lease and the credential-owner record live. */
  readonly documents: KvDocumentStore;
  /** This tab's lease holder id (shell-minted). */
  readonly holderId: string;
  /** Epoch ms, from the shell. */
  readonly now: () => number;
  readonly leaseTtlMs?: number;
  /** The connection the operator has active, whose credential is put back afterwards. */
  readonly activeProfile: TenantProfile | null;
  readonly logger?: Logger;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function label(profile: TenantProfile): string {
  return profile.name !== undefined && profile.name.trim() !== "" ? profile.name : profile.id;
}

/** Run `work` against `profile`'s tenant through the shared credential slot. */
export async function runTenantSession<T>(
  deps: TenantSessionDeps,
  profile: TenantProfile,
  work: (ports: TenantPorts) => Promise<T>,
): Promise<TenantRun<T>> {
  const tenantId = normalizeTenantId(profile.config.tenantId);
  const NOT_NEEDED: TenantRestore = { kind: "not-needed" };
  const unknown = (stage: TenantRunStage, reason: string, restore: TenantRestore = NOT_NEEDED): TenantRun<T> => ({
    kind: "unknown",
    tenantId,
    stage,
    reason,
    restore,
  });
  const { slot, documents, logger } = deps;

  // 1. Refusals that touch nothing.
  if (tenantId === "") return unknown("identity", `${label(profile)} has no tenant id.`);
  const proof = tenantProofRequest(profile.config.subscriptionId);
  if (proof === null) {
    return unknown(
      "identity",
      `${label(profile)} names no subscription, so there is nothing to prove the tenant against.`,
    );
  }
  const proofRequest = proof;
  const active = deps.activeProfile;
  const swap = active === null || active.id !== profile.id;
  if (swap && !slot.hasCredential(profile)) {
    return unknown(
      "credential",
      `${label(profile)}'s client secret was not entered in this session (or its tenant or client id was edited since). Stored secrets can never be read back, so it has to be entered again before this tenant can be read.`,
    );
  }
  if (swap && active !== null && !slot.hasCredential(active)) {
    return unknown(
      "credential",
      `The active connection ${label(active)}'s client secret was not entered in this session, so it could not be put back after reading ${label(profile)}. Enter it on Setup first.`,
    );
  }

  // 2. The lease.
  const takenAt = deps.now();
  const leaseRead = await documents.load(CREDENTIAL_LEASE_KEY);
  const verdict = leaseHeldByOther(leaseRead, deps.holderId, takenAt);
  if (verdict.held === "unknown") {
    return unknown("lease", `The credential lease could not be read (${verdict.reason}).`);
  }
  if (verdict.held) {
    return unknown(
      "lease",
      "Another tab of this app is reading a tenant through the shared credential right now. Try again when it finishes.",
    );
  }
  const ttl = deps.leaseTtlMs ?? DEFAULT_TENANT_LEASE_TTL_MS;
  const expiresAt = takenAt + ttl;
  try {
    await documents.save(CREDENTIAL_LEASE_KEY, takenLease(deps.holderId, takenAt, ttl));
  } catch (err) {
    return unknown("lease", `The credential lease could not be taken (${errText(err)}).`);
  }

  const recordOwner = async (owner: TenantProfile): Promise<void> => {
    try {
      await documents.save(
        CREDENTIAL_OWNER_KEY,
        encodeCredentialOwner({ profileId: owner.id, tenantId: owner.config.tenantId, clientId: owner.config.clientId }),
      );
    } catch (err) {
      logger?.warn("tenant-session: credential owner record not written", { error: errText(err) });
    }
  };

  let outcome: TenantRun<T>;
  try {
    outcome = await slot.exclusive(async () => {
      // swapProveAndWork never rejects, so the restore below always runs.
      const result = await swapProveAndWork();
      // 6. Restore, whatever happened.
      const restored = swap && active !== null ? await restore(active) : NOT_NEEDED;
      return { ...result, restore: restored };
    });
  } finally {
    // 7. Release, unless expired - an expired lease may be someone else's now.
    if (deps.now() < expiresAt) {
      try {
        await documents.save(CREDENTIAL_LEASE_KEY, releasedLease());
      } catch (err) {
        logger?.warn("tenant-session: lease not released; it expires on its own", { error: errText(err) });
      }
    }
  }
  return outcome;

  // -- the exclusive section's steps ---------------------------------------

  async function swapProveAndWork(): Promise<TenantRun<T>> {
    // 3. Swap.
    try {
      if (swap) {
        await slot.installCredential(profile);
        await recordOwner(profile);
      }
      await slot.mintTokens(tenantId);
    } catch (err) {
      return unknown("swap", `Switching the shared credential to ${label(profile)} failed: ${errText(err)}`);
    }
    // 4. Prove.
    const ports = slot.portsFor(tenantId);
    const before = await prove(ports, "before");
    if (before !== null) return before;
    // 5. Work.
    let value: T;
    try {
      value = await work(ports);
    } catch (err) {
      return unknown("work", errText(err));
    }
    // 5b. Prove again, and check the lease is still ours.
    const after = await prove(ports, "after");
    if (after !== null) return after;
    const still = await leaseStillOurs();
    if (still !== null) return unknown("lease", still);
    return { kind: "done", tenantId, value, restore: NOT_NEEDED };
  }

  /** Null when the slot answered as the target; otherwise the unknown result. */
  async function prove(ports: TenantPorts, when: "before" | "after"): Promise<TenantRun<T> | null> {
    const which = when === "before" ? "The tenant proof read" : "The tenant proof read after the work";
    let answer;
    try {
      answer = await ports.azure.request(proofRequest);
    } catch (err) {
      return unknown("proof", `${which} failed: ${errText(err)}`);
    }
    const proven = proveTenant(answer, tenantId);
    if (proven.kind === "mismatch") {
      logger?.warn("tenant-session: proof mismatch", { when, expected: tenantId, actual: proven.actual });
      return unknown(
        "proof",
        `${which} answered for tenant ${proven.actual}, not ${tenantId} - something else changed the shared credential, so nothing read in this batch can be trusted.`,
      );
    }
    if (proven.kind === "unknown") {
      return unknown("proof", `${which} could not prove the tenant: ${proven.reason}.`);
    }
    return null;
  }

  /** Null while this holder's lease is unexpired; otherwise why the batch is unknown. */
  async function leaseStillOurs(): Promise<string | null> {
    const at = deps.now();
    if (at >= expiresAt) {
      return "The credential lease expired before the work finished, so another tab may have changed the shared credential during it; nothing read in this batch can be trusted.";
    }
    const read = await documents.load(CREDENTIAL_LEASE_KEY);
    if (read.kind === "unknown") {
      return `The credential lease could not be re-read after the work (${read.reason}), so whether another tab changed the shared credential during it is unknown.`;
    }
    const lease = read.kind === "value" ? decodeLease(read.value) : null;
    if (lease === null || lease.holder !== deps.holderId) {
      return "The credential lease was no longer this tab's when the work finished, so another tab may have changed the shared credential during it; nothing read in this batch can be trusted.";
    }
    return null;
  }

  async function restore(to: TenantProfile): Promise<TenantRestore> {
    try {
      await slot.installCredential(to);
      await recordOwner(to);
      await slot.mintTokens(normalizeTenantId(to.config.tenantId));
      return { kind: "restored" };
    } catch (err) {
      logger?.error("tenant-session: the active connection's credential was not restored", { error: errText(err) });
      return { kind: "failed", reason: errText(err) };
    }
  }
}
