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
 *   3. Inside the slot's exclusive section: mark the owner record SWITCHING,
 *      write the target's credential (only when the slot does not already hold
 *      it), mint ARM and Graph tokens for the target tenant, and only then
 *      record the target as the owner.
 *   4. PROVE: GET /subscriptions/{sub} must answer with the target's tenantId.
 *      A mismatch or a refusal makes the batch unknown and the work never runs.
 *   5. Run the work with the slot's session ports.
 *   5b. PROVE AGAIN, and re-read the lease. The lease has no compare-and-swap
 *      and other paths (another tab's Save and connect) write the slot, so a
 *      swap DURING the work is possible; the batch is `done` only when the
 *      second proof also answers as the target and the lease is still this
 *      holder's and unexpired. Otherwise it is unknown - its answers may be
 *      another tenant's.
 *   6. Restore the ACTIVE connection's credential and tokens, whatever happened
 *      - the same order: switching, credential, tokens, owner.
 *   7. Release the lease, unless it has already expired (it may be someone
 *      else's by then).
 *
 * THE BATCH FORM (AZR-90). {@link runTenantSessionBatch} holds ONE lease and
 * ONE exclusive section across many tenants: steps 3 to 5b run per tenant,
 * swapping straight from the last tenant read to the next (A to B to C), and
 * steps 6 and 7 run ONCE when the batch's body settles. Before every tenant
 * after the first the lease is re-read and renewed, so a long Read all never
 * outlives it unnoticed. A Read all of N tenants used to restore N times (two
 * paced token mints each) for no gain. The restore is decided by what the slot
 * holds, not by what was asked: any swap that STARTED - even one that failed
 * half-way - leaves the slot in doubt, and the active credential goes back.
 * {@link runTenantSession} is the batch of one, so both forms share every rule.
 *
 * What the proof cannot prove is written down in domain/tenancy (a delegated
 * subscription is unknown; the Graph token is not proven).
 *
 * THE OWNER RECORD (AZR-92) is what protects OTHER tabs: every ordinary Azure
 * batch in every tab reads it before sending and after settling (the shell's
 * credential slot). So it must never name a tenant the slot does not hold:
 * the switching marker goes in before the first slot write and the new owner
 * only after both tokens, every write carries its own write id, and a swap
 * whose switching marker cannot be written does not happen. A restore whose
 * marker (retried once) and cleared record both fail to land does not happen
 * either: the record still names the target, which the slot still holds. A
 * restore that fails later leaves the marker standing - the slot is then in
 * no known tenant's hands.
 * The session's own requests go through session ports and never read it.
 *
 * PACING (AZR-63): with `pacer`, every proxied request the session sends
 * itself - each proof read, and two per token mint (ARM and Graph) - spends
 * the caller's budget first. With `signal`, the swap and the proofs stop once
 * it aborts (the run is then unknown); the restore is paced but never handed
 * the signal, so the active credential goes back whatever happened.
 *
 * runTenantSession never rejects; runTenantSessionBatch rejects only when its
 * body does, after the restore and release. The clock is injected; core reads
 * no clock of its own.
 */

import type { KvDocumentStore } from "../../ports/kv-document-store";
import type { Logger } from "../../ports/logger";
import type { PacingSignal, RequestPacer } from "../../ports/request-pacer";
import type {
  CredentialSlot,
  TenantBatchRun,
  TenantPorts,
  TenantProfile,
  TenantRestore,
  TenantRun,
  TenantRunOptions,
  TenantRunStage,
  TenantSession,
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
  clearedCredentialOwner,
  switchingCredentialOwner,
  takenLease,
  tenantProofRequest,
} from "../../domain/tenancy";

/** Default lease lifetime: long enough for one tenant's scan at the shared budget (renewed per tenant in a batch). */
const DEFAULT_TENANT_LEASE_TTL_MS = 10 * 60 * 1000;

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
  /** The caller's budget for the session's own requests (proof reads, mints). */
  readonly pacer?: RequestPacer;
  /** Once aborted, no further proof or swap request is sent. */
  readonly signal?: PacingSignal;
}

/** Proxied requests one {@link CredentialSlot.mintTokens} sends: ARM and Graph. */
const REQUESTS_PER_MINT = 2;

const NOT_NEEDED: TenantRestore = { kind: "not-needed" };
const DEFERRED: TenantRestore = { kind: "deferred" };

/** What the slot holds: a known profile's credential, nothing set by this run, or in doubt. */
const IN_DOUBT = Symbol("in-doubt");
type SlotHolds = TenantProfile | null | typeof IN_DOUBT;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function label(profile: TenantProfile): string {
  return profile.name !== undefined && profile.name.trim() !== "" ? profile.name : profile.id;
}

function unknownRun<T>(
  tenantId: string,
  stage: TenantRunStage,
  reason: string,
  restore: TenantRestore = NOT_NEEDED,
): TenantRun<T> {
  return { kind: "unknown", tenantId, stage, reason, restore };
}

/** Step 1: the refusals that touch nothing. Null when the run may go ahead. */
function refusal<T>(slot: CredentialSlot, active: TenantProfile | null, profile: TenantProfile): TenantRun<T> | null {
  const tenantId = normalizeTenantId(profile.config.tenantId);
  if (tenantId === "") return unknownRun(tenantId, "identity", `${label(profile)} has no tenant id.`);
  if (tenantProofRequest(profile.config.subscriptionId) === null) {
    return unknownRun(
      tenantId,
      "identity",
      `${label(profile)} names no subscription, so there is nothing to prove the tenant against.`,
    );
  }
  const isActive = active !== null && active.id === profile.id;
  if (!isActive && !slot.hasCredential(profile)) {
    return unknownRun(
      tenantId,
      "credential",
      `${label(profile)}'s client secret was not entered in this session (or its tenant or client id was edited since). Stored secrets can never be read back, so it has to be entered again before this tenant can be read.`,
    );
  }
  if (!isActive && active !== null && !slot.hasCredential(active)) {
    return unknownRun(
      tenantId,
      "credential",
      `The active connection ${label(active)}'s client secret was not entered in this session, so it could not be put back after reading ${label(profile)}. Enter it on Setup first.`,
    );
  }
  return null;
}

/** Run `work` against `profile`'s tenant through the shared credential slot: the batch of one. */
export async function runTenantSession<T>(
  deps: TenantSessionDeps,
  profile: TenantProfile,
  work: (ports: TenantPorts) => Promise<T>,
): Promise<TenantRun<T>> {
  // Refuse before the lease is even read: a refused single run touches nothing.
  const refused = refusal<T>(deps.slot, deps.activeProfile, profile);
  if (refused !== null) return refused;
  const options: TenantRunOptions = {
    ...(deps.pacer !== undefined ? { pacer: deps.pacer } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  };
  // The body never rejects (runForTenant does not), so neither does this.
  const batch = await runTenantSessionBatch(deps, (session) => session.runForTenant(profile, work, options));
  return { ...batch.value, restore: batch.restore };
}

/**
 * Run `body` with a session that reads tenant after tenant under one lease and
 * one exclusive section, restoring the active credential ONCE at the end.
 * `deps.pacer` paces that restore; each run's own options (falling back to
 * `deps`) pace and cancel its swap and proofs.
 */
export async function runTenantSessionBatch<R>(
  deps: TenantSessionDeps,
  body: (session: TenantSession) => Promise<R>,
): Promise<TenantBatchRun<R>> {
  const { slot, documents, logger } = deps;
  const active = deps.activeProfile;
  const spend = async (pacer: RequestPacer | undefined, count: number, signal: PacingSignal | undefined): Promise<void> => {
    for (let i = 0; i < count; i++) await pacer?.acquire(signal);
  };

  // 2. The lease. Refused: every run says why, nothing else is touched.
  const takenAt = deps.now();
  const leaseRefusal = await takeLease();
  if (leaseRefusal !== null) {
    const refusedSession: TenantSession = {
      runForTenant: async <T>(profile: TenantProfile) =>
        refusal<T>(slot, active, profile) ??
        unknownRun<T>(normalizeTenantId(profile.config.tenantId), "lease", leaseRefusal),
      runBatch: async <S>(inner: (session: TenantSession) => Promise<S>) => ({
        value: await inner(refusedSession),
        restore: NOT_NEEDED,
      }),
    };
    return { value: await body(refusedSession), restore: NOT_NEEDED };
  }
  const ttl = deps.leaseTtlMs ?? DEFAULT_TENANT_LEASE_TTL_MS;
  let expiresAt = takenAt + ttl;

  let ownerWrites = 0;
  const writeId = (): string => `${deps.holderId}:${takenAt}:${++ownerWrites}`;
  const recordOwner = async (owner: TenantProfile): Promise<void> => {
    try {
      await documents.save(
        CREDENTIAL_OWNER_KEY,
        encodeCredentialOwner(
          { profileId: owner.id, tenantId: owner.config.tenantId, clientId: owner.config.clientId },
          writeId(),
        ),
      );
    } catch (err) {
      logger?.warn("tenant-session: credential owner record not written", { error: errText(err) });
    }
  };
  const markCleared = (): Promise<void> => documents.save(CREDENTIAL_OWNER_KEY, clearedCredentialOwner());
  /** Rejects when the marker could not be written. */
  const markSwitching = (): Promise<void> =>
    documents.save(CREDENTIAL_OWNER_KEY, switchingCredentialOwner(writeId(), takenAt));

  // What the slot holds now. It starts as the active connection's.
  let holds: SlotHolds = active;
  let runs = 0;

  const session: TenantSession = {
    runForTenant: runOne,
    // Already inside a batch: the outer batch restores.
    runBatch: async <S>(inner: (s: TenantSession) => Promise<S>) => ({ value: await inner(session), restore: DEFERRED }),
  };

  let restored: TenantRestore = NOT_NEEDED;
  let value: R;
  try {
    value = await slot.exclusive(async () => {
      try {
        return await body(session);
      } finally {
        // 6. Restore ONCE, whatever happened - body threw, a swap failed half-way, a cancel.
        restored = await restoreIfNeeded();
      }
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
  return { value, restore: restored };

  // -- the steps ------------------------------------------------------------

  /** Null once the lease is this holder's; otherwise why not. */
  async function takeLease(): Promise<string | null> {
    const leaseRead = await documents.load(CREDENTIAL_LEASE_KEY);
    const verdict = leaseHeldByOther(leaseRead, deps.holderId, takenAt);
    if (verdict.held === "unknown") return `The credential lease could not be read (${verdict.reason}).`;
    if (verdict.held) {
      return "Another tab of this app is reading a tenant through the shared credential right now. Try again when it finishes.";
    }
    try {
      await documents.save(CREDENTIAL_LEASE_KEY, takenLease(deps.holderId, takenAt, deps.leaseTtlMs ?? DEFAULT_TENANT_LEASE_TTL_MS));
    } catch (err) {
      return `The credential lease could not be taken (${errText(err)}).`;
    }
    return null;
  }

  /**
   * Before every tenant after the first: the lease must still be this
   * holder's and unexpired, and is renewed for the next tenant's scan. Null
   * when renewed; otherwise why this tenant is not read.
   */
  async function renewLease(profile: TenantProfile): Promise<string | null> {
    const at = deps.now();
    const lost = `The credential lease was no longer this tab's before ${label(profile)} was read, so another tab may be using the shared credential; it was not read.`;
    if (at >= expiresAt) return lost;
    const read = await documents.load(CREDENTIAL_LEASE_KEY);
    if (read.kind === "unknown") {
      return `The credential lease could not be re-read before ${label(profile)} was read (${read.reason}), so it was not read.`;
    }
    const lease = read.kind === "value" ? decodeLease(read.value) : null;
    if (lease === null || lease.holder !== deps.holderId) return lost;
    try {
      await documents.save(CREDENTIAL_LEASE_KEY, takenLease(deps.holderId, at, ttl));
    } catch (err) {
      return `The credential lease could not be renewed before ${label(profile)} was read (${errText(err)}), so it was not read.`;
    }
    expiresAt = at + ttl;
    return null;
  }

  async function runOne<T>(
    profile: TenantProfile,
    work: (ports: TenantPorts) => Promise<T>,
    options: TenantRunOptions = {},
  ): Promise<TenantRun<T>> {
    const refused = refusal<T>(slot, active, profile);
    if (refused !== null) return refused;
    const tenantId = normalizeTenantId(profile.config.tenantId);
    const proofRequest = tenantProofRequest(profile.config.subscriptionId)!;
    const pacer = options.pacer ?? deps.pacer;
    const signal = options.signal ?? deps.signal;
    // Inside a batch the active credential goes back once, at the end.
    const own = (run: TenantRun<T>): TenantRun<T> => ({ ...run, restore: DEFERRED });
    const unknown = (stage: TenantRunStage, reason: string): TenantRun<T> => unknownRun(tenantId, stage, reason, DEFERRED);

    if (runs++ > 0) {
      const lost = await renewLease(profile);
      if (lost !== null) return unknown("lease", lost);
    }

    // 3. Swap - unless the slot already holds this profile's credential.
    const swap = holds === null || holds === IN_DOUBT || holds.id !== profile.id;
    try {
      if (swap) {
        // From here the slot is in doubt until the new owner is recorded: a
        // failure part-way still gets the active credential put back.
        holds = IN_DOUBT;
        // Before the slot changes, so no other tab's batch is admitted by a
        // record naming the tenant whose credential is leaving.
        await markSwitching();
        await slot.installCredential(profile);
      }
      await spend(pacer, REQUESTS_PER_MINT, signal);
      await slot.mintTokens(tenantId);
      if (swap) {
        await recordOwner(profile);
        holds = profile;
      }
    } catch (err) {
      return unknown("swap", `Switching the shared credential to ${label(profile)} failed: ${errText(err)}`);
    }
    // 4. Prove.
    const ports = slot.portsFor(tenantId);
    const before = await prove(ports, "before");
    if (before !== null) return own(before);
    // 5. Work.
    let value: T;
    try {
      value = await work(ports);
    } catch (err) {
      return unknown("work", errText(err));
    }
    // 5b. Prove again, and check the lease is still ours.
    const after = await prove(ports, "after");
    if (after !== null) return own(after);
    const still = await leaseStillOurs();
    if (still !== null) return unknown("lease", still);
    return { kind: "done", tenantId, value, restore: DEFERRED };

    /** Null when the slot answered as the target; otherwise the unknown result. */
    async function prove(p: TenantPorts, when: "before" | "after"): Promise<TenantRun<T> | null> {
      const which = when === "before" ? "The tenant proof read" : "The tenant proof read after the work";
      let answer;
      try {
        await spend(pacer, 1, signal);
        answer = await p.azure.request(proofRequest);
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

  /** Null once one of `writes` lands; otherwise the last failure. */
  async function firstLanded(writes: ReadonlyArray<() => Promise<void>>): Promise<string | null> {
    let last = "no write tried";
    for (const write of writes) {
      try {
        await write();
        return null;
      } catch (err) {
        last = errText(err);
        logger?.warn("tenant-session: owner record not marked before the restore", { error: last });
      }
    }
    return last;
  }

  /** The active credential goes back only when the slot is not already known to hold it. */
  async function restoreIfNeeded(): Promise<TenantRestore> {
    if (active === null) return NOT_NEEDED;
    if (holds !== IN_DOUBT && holds !== null && holds.id === active.id) return NOT_NEEDED;
    return restore(active);
  }

  async function restore(to: TenantProfile): Promise<TenantRestore> {
    try {
      // Never install a credential under a record naming another tenant: a
      // record still naming the target ADMITS every other tab whose screens
      // are for the target while the slot moves back (review finding). So the
      // marker, retried once; failing that the cleared record (refused by
      // every tab too); failing both, no restore at all - the record then
      // still names the target, which is what the slot still holds.
      const unmarked = await firstLanded([markSwitching, markSwitching, markCleared]);
      if (unmarked !== null) {
        return {
          kind: "failed",
          reason:
            `the record other tabs check before using the shared Azure credential could not be marked (${unmarked}), ` +
            "so the active connection's credential was not put back; it still names the tenant just read",
        };
      }
      await slot.installCredential(to);
      // Paced, but never handed the signal: the restore is not cancellable.
      await spend(deps.pacer, REQUESTS_PER_MINT, undefined);
      await slot.mintTokens(normalizeTenantId(to.config.tenantId));
      await recordOwner(to);
      holds = to;
      return { kind: "restored" };
    } catch (err) {
      logger?.error("tenant-session: the active connection's credential was not restored", { error: errText(err) });
      return { kind: "failed", reason: errText(err) };
    }
  }
}
