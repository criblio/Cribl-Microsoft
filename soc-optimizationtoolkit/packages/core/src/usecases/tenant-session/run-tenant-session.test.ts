/**
 * Pins for the tenant session sequence (ADR 0009 decision 2).
 *
 * What goes wrong without each rule is one tenant's facts shown as another's,
 * or the operator's ACTIVE connection silently left pointing at someone else's
 * tenant. Both are invisible in a returned value, so these pins record the
 * ORDER of every slot operation and KV write and assert it whole.
 */

import { describe, expect, it } from "vitest";
import { FakeAzureManagement } from "../../testing/fake-azure-management";
import { FakeKvDocumentStore } from "../../testing/fake-kv-document-store";
import type { CredentialSlot, TenantPorts, TenantProfile } from "../../ports/tenant-session";
import type { GraphDirectory } from "../../ports/graph-directory";
import {
  CREDENTIAL_LEASE_KEY,
  CREDENTIAL_OWNER_KEY,
  decodeCredentialOwner,
  decodeLease,
  judgeSlotOwner,
  takenLease,
} from "../../domain/tenancy";
import { runTenantSession, runTenantSessionBatch } from "./run-tenant-session";

const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "bbbbbbbb-0000-0000-0000-00000000000b";

const ACTIVE: TenantProfile = { id: "pa", name: "Lab", config: { tenantId: A, clientId: "ca", subscriptionId: "sa" } };
const TARGET: TenantProfile = { id: "pb", name: "Customer", config: { tenantId: B, clientId: "cb", subscriptionId: "sb" } };

const NO_GRAPH: GraphDirectory = {
  listServicePrincipals: async () => [],
} as unknown as GraphDirectory;

/** A slot that records every operation, in order, into a shared log. */
class FakeSlot implements CredentialSlot {
  readonly azure = new FakeAzureManagement();
  credentials = new Set<string>(["pa", "pb"]);
  failMintFor: string | null = null;
  failInstallFor: string | null = null;
  inExclusive = false;
  readonly log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  hasCredential(profile: TenantProfile): boolean {
    return this.credentials.has(profile.id);
  }
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.log.push("exclusive:enter");
    this.inExclusive = true;
    try {
      return await fn();
    } finally {
      this.inExclusive = false;
      this.log.push("exclusive:exit");
    }
  }
  async installCredential(profile: TenantProfile): Promise<void> {
    if (!this.inExclusive) throw new Error("installCredential outside exclusive");
    this.log.push(`install:${profile.id}`);
    if (this.failInstallFor === profile.id) throw new Error(`install ${profile.id} failed`);
  }
  async mintTokens(tenantId: string): Promise<void> {
    if (!this.inExclusive) throw new Error("mintTokens outside exclusive");
    this.log.push(`mint:${tenantId}`);
    if (this.failMintFor === tenantId) throw new Error(`AADSTS700016 for ${tenantId}`);
  }
  portsFor(tenantId: string): TenantPorts {
    this.log.push(`ports:${tenantId}`);
    return { azure: this.azure, graph: NO_GRAPH };
  }
}

/** A KV store that also logs its saves into the shared log. */
class LoggingStore extends FakeKvDocumentStore {
  readonly log: string[];
  constructor(log: string[], seed: Record<string, unknown> = {}) {
    super(seed);
    this.log = log;
  }
  override async save(key: string, value: unknown): Promise<void> {
    await super.save(key, value);
    if (key === CREDENTIAL_LEASE_KEY) {
      this.log.push(decodeLease(value) === null ? "lease:release" : "lease:take");
    } else if (key === CREDENTIAL_OWNER_KEY) {
      const switching = typeof value === "object" && value !== null && (value as { switching?: unknown }).switching === true;
      this.log.push(switching ? "owner:switching" : `owner:${decodeCredentialOwner(value)?.profileId ?? "?"}`);
    }
  }
}

function setup(opts: { seed?: Record<string, unknown>; active?: TenantProfile | null; clock?: number[] } = {}) {
  const log: string[] = [];
  const slot = new FakeSlot(log);
  const store = new LoggingStore(log, opts.seed);
  const times = opts.clock ?? [1000];
  let i = 0;
  const now = () => times[Math.min(i++, times.length - 1)];
  const deps = {
    slot,
    documents: store,
    holderId: "tab-1",
    now,
    leaseTtlMs: 60_000,
    activeProfile: opts.active === undefined ? ACTIVE : opts.active,
  };
  return { log, slot, store, deps };
}

/** The lease the store holds now, decoded. */
async function leaseIn(store: FakeKvDocumentStore) {
  const read = await store.load(CREDENTIAL_LEASE_KEY);
  return read.kind === "value" ? decodeLease(read.value) : null;
}

const proven = (tenantId: string) => ({ status: 200, body: { subscriptionId: "sb", tenantId } });
/** The proof before the work and the proof after it both answer as `tenantId`. */
const provenTwice = (tenantId: string) => [proven(tenantId), proven(tenantId)];

describe("runTenantSession - the swap path", () => {
  it("leases, swaps, proves, works, restores the ACTIVE connection, releases - in that order", async () => {
    const { log, slot, deps } = setup();
    slot.azure.respondWith(...provenTwice(B));
    const out = await runTenantSession(deps, TARGET, async () => {
      log.push("work");
      return 42;
    });

    expect(out).toEqual({ kind: "done", tenantId: B, value: 42, restore: { kind: "restored" } });
    expect(log).toEqual([
      "lease:take",
      "exclusive:enter",
      // AZR-92: the switching marker goes in BEFORE the slot changes and the
      // new owner only AFTER both tokens are in, so no other tab's batch is
      // ever admitted by a record that names a tenant the slot does not hold.
      "owner:switching",
      "install:pb",
      `mint:${B}`,
      "owner:pb",
      `ports:${B}`,
      "work",
      // Re-checked and renewed before the restore, so the restore runs under
      // this tab's lease even after a slow tenant (review round 2).
      "lease:take",
      "owner:switching",
      "install:pa",
      `mint:${A}`,
      "owner:pa",
      "exclusive:exit",
      "lease:release",
    ]);
    // The proof is the subscription the TARGET profile names.
    expect(slot.azure.calls[0]).toMatchObject({ method: "GET", path: "/subscriptions/sb" });
  });

  it("takes the lease with the injected clock and TTL", async () => {
    const { slot, store, deps } = setup({ clock: [5000] });
    slot.azure.respondWith(...provenTwice(B));
    await runTenantSession(deps, TARGET, async () => 1);
    const take = store.saves.find((s) => s.key === CREDENTIAL_LEASE_KEY);
    expect(decodeLease(take?.value)).toEqual({ holder: "tab-1", expiresAt: 65_000 });
  });

  it("does NOT release (or renew) a lease another tab took after this one expired, but still restores", async () => {
    const { log, slot, store, deps } = setup({ clock: [1000, 999_999] });
    slot.azure.respondWith(...provenTwice(B));
    const out = await runTenantSession(deps, TARGET, async () => {
      await store.save(CREDENTIAL_LEASE_KEY, takenLease("tab-2", 999_000, 60_000));
      return 1;
    });
    expect(out).toMatchObject({ kind: "unknown", stage: "lease", restore: { kind: "restored" } });
    expect(log.filter((l) => l.startsWith("lease:"))).toEqual(["lease:take", "lease:take"]);
    expect((await leaseIn(store))).toEqual({ holder: "tab-2", expiresAt: 1_059_000 });
  });

  it("re-takes an expired lease nobody else took before the restore, then releases it", async () => {
    const { log, slot, deps } = setup({ clock: [1000, 999_999] });
    slot.azure.respondWith(...provenTwice(B));
    const out = await runTenantSession(deps, TARGET, async () => 1);
    expect(out).toMatchObject({ kind: "unknown", stage: "lease", restore: { kind: "restored" } });
    expect(log.slice(log.indexOf(`ports:${B}`) + 1)).toEqual([
      "lease:take",
      "owner:switching",
      "install:pa",
      `mint:${A}`,
      "owner:pa",
      "exclusive:exit",
      "lease:release",
    ]);
  });
});

describe("runTenantSession - the active tenant needs no swap", () => {
  it("re-mints and proves, but never rewrites the credential and has nothing to restore", async () => {
    const { log, slot, deps } = setup();
    slot.azure.respondWith(...provenTwice(A));
    const out = await runTenantSession(deps, ACTIVE, async () => "ok");
    expect(out).toEqual({ kind: "done", tenantId: A, value: "ok", restore: { kind: "not-needed" } });
    expect(log.filter((l) => l.startsWith("install:"))).toEqual([]);
    expect(log).toContain(`mint:${A}`);
  });
});

describe("runTenantSession - refusals touch nothing", () => {
  it("asks the slot about the PROFILE, so a secret held for an edited identity does not count", async () => {
    const { slot, deps } = setup();
    const asked: TenantProfile[] = [];
    slot.hasCredential = (profile: TenantProfile) => {
      asked.push(profile);
      return profile.config.clientId === "cb" || profile.id === "pa";
    };
    const edited = { ...TARGET, config: { ...TARGET.config, clientId: "cb2" } };
    const out = await runTenantSession(deps, edited, async () => 1);
    expect(out).toMatchObject({ kind: "unknown", stage: "credential" });
    expect(asked[0]).toBe(edited);
  });

  it("is UNKNOWN (credential) when this session never held the target's secret", async () => {
    const { log, slot, deps } = setup();
    slot.credentials.delete("pb");
    const out = await runTenantSession(deps, TARGET, async () => 1);
    expect(out).toMatchObject({ kind: "unknown", stage: "credential", tenantId: B });
    expect(log).toEqual([]);
  });

  it("is UNKNOWN (credential) when the ACTIVE secret could not be put back afterwards", async () => {
    // Swapping without the active secret in hand would leave the operator's
    // own connection pointing at the customer's tenant until they re-enter it.
    const { log, slot, deps } = setup();
    slot.credentials.delete("pa");
    const out = await runTenantSession(deps, TARGET, async () => 1);
    expect(out).toMatchObject({ kind: "unknown", stage: "credential" });
    expect(out.kind === "unknown" ? out.reason : "").toContain("Lab");
    expect(log).toEqual([]);
  });

  it("is UNKNOWN (lease) while another tab holds an unexpired lease", async () => {
    const { log, deps } = setup({ seed: { [CREDENTIAL_LEASE_KEY]: takenLease("tab-2", 1000, 30_000) } });
    const out = await runTenantSession(deps, TARGET, async () => 1);
    expect(out).toMatchObject({ kind: "unknown", stage: "lease" });
    expect(log).toEqual([]);
  });

  it("takes a lease another tab let expire", async () => {
    const { log, slot, deps } = setup({ seed: { [CREDENTIAL_LEASE_KEY]: takenLease("tab-2", 0, 10) } });
    slot.azure.respondWith(...provenTwice(B));
    const out = await runTenantSession(deps, TARGET, async () => 1);
    expect(out.kind).toBe("done");
    expect(log[0]).toBe("lease:take");
  });

  it("is UNKNOWN (lease) when the lease cannot be read - never taken on a failed read", async () => {
    const { log, store, deps } = setup();
    store.scriptLoad(CREDENTIAL_LEASE_KEY, { kind: "unknown", reason: "HTTP 403", status: 403 });
    const out = await runTenantSession(deps, TARGET, async () => 1);
    expect(out).toMatchObject({ kind: "unknown", stage: "lease" });
    expect(log).toEqual([]);
  });

  it("is UNKNOWN (identity) for a profile with no tenant or no subscription", async () => {
    const { log, deps } = setup();
    const noSub = { ...TARGET, config: { ...TARGET.config, subscriptionId: "" } };
    expect(await runTenantSession(deps, noSub, async () => 1)).toMatchObject({ kind: "unknown", stage: "identity" });
    const noTenant = { ...TARGET, config: { ...TARGET.config, tenantId: " " } };
    expect(await runTenantSession(deps, noTenant, async () => 1)).toMatchObject({ kind: "unknown", stage: "identity" });
    expect(log).toEqual([]);
  });
});

describe("runTenantSession - the proof gates the batch", () => {
  it("is UNKNOWN (proof) and never runs the work when ANOTHER tenant answered", async () => {
    const { log, slot, deps } = setup();
    slot.azure.respondWith(proven(A));
    let ran = false;
    const out = await runTenantSession(deps, TARGET, async () => {
      ran = true;
      return 1;
    });
    expect(ran).toBe(false);
    expect(out).toMatchObject({ kind: "unknown", stage: "proof", restore: { kind: "restored" } });
    expect(out.kind === "unknown" ? out.reason : "").toContain(A);
    // Restored and released even so.
    expect(log.slice(-6)).toEqual(["owner:switching", "install:pa", `mint:${A}`, "owner:pa", "exclusive:exit", "lease:release"]);
  });

  it("is UNKNOWN (proof) when the slot no longer answers as the target AFTER the work", async () => {
    // Review finding: the proof ran once, before the work. Another tab's
    // Save and connect (or a scan outliving the lease) could put another
    // tenant's credential in the slot mid-batch, and the batch came back
    // `done` with that tenant's answers in it.
    const { log, slot, deps } = setup();
    slot.azure.respondWith(proven(B), proven(A));
    const out = await runTenantSession(deps, TARGET, async () => {
      log.push("work");
      return 1;
    });
    expect(out).toMatchObject({ kind: "unknown", stage: "proof", restore: { kind: "restored" } });
    expect(out.kind === "unknown" ? out.reason : "").toContain(A);
    expect(log).toContain("work");
    expect(slot.azure.calls.map((c) => c.path)).toEqual(["/subscriptions/sb", "/subscriptions/sb"]);
  });

  it("is UNKNOWN (proof) when the proof after the work is refused", async () => {
    const { slot, deps } = setup();
    slot.azure.respondWith(proven(B), { status: 401, body: "InvalidAuthenticationTokenTenant" });
    const out = await runTenantSession(deps, TARGET, async () => 1);
    expect(out).toMatchObject({ kind: "unknown", stage: "proof" });
  });

  it("is UNKNOWN (proof) when the proof read is refused", async () => {
    const { slot, deps } = setup();
    slot.azure.respondWith({ status: 403, body: "AuthorizationFailed" });
    const out = await runTenantSession(deps, TARGET, async () => 1);
    expect(out).toMatchObject({ kind: "unknown", stage: "proof" });
  });
});

describe("runTenantSession - the lease must still be ours when the work ends", () => {
  it("is UNKNOWN (lease) when another holder took the lease during the work", async () => {
    const { log, slot, store, deps } = setup();
    slot.azure.respondWith(...provenTwice(B));
    const out = await runTenantSession(deps, TARGET, async () => {
      await store.save(CREDENTIAL_LEASE_KEY, takenLease("tab-2", 1000, 60_000));
      return 1;
    });
    expect(out).toMatchObject({ kind: "unknown", stage: "lease", restore: { kind: "restored" } });
    // Tab 2's lease (the second take) is left standing (review round 2): no
    // renewal, no release.
    expect(log.filter((l) => l.startsWith("lease:"))).toEqual(["lease:take", "lease:take"]);
    expect((await leaseIn(store))?.holder).toBe("tab-2");
  });

  it("is UNKNOWN (lease) when the lease expired during the work - another tab may have swapped the slot", async () => {
    const { log, slot, deps } = setup({ clock: [1000, 70_000] });
    slot.azure.respondWith(...provenTwice(B));
    const out = await runTenantSession(deps, TARGET, async () => 1);
    expect(out).toMatchObject({ kind: "unknown", stage: "lease" });
    // Nobody took it meanwhile, so it is taken again for the restore and then
    // released; a lease another tab took is never released (pinned above).
    expect(log.filter((l) => l.startsWith("lease:"))).toEqual(["lease:take", "lease:take", "lease:release"]);
  });

  it("is UNKNOWN (lease) when the lease cannot be re-read after the work", async () => {
    const { slot, store, deps } = setup();
    slot.azure.respondWith(...provenTwice(B));
    const out = await runTenantSession(deps, TARGET, async () => {
      store.scriptLoad(CREDENTIAL_LEASE_KEY, { kind: "unknown", reason: "HTTP 502", status: 502 });
      return 1;
    });
    expect(out).toMatchObject({ kind: "unknown", stage: "lease" });
  });
});

describe("runTenantSession - failures still restore", () => {
  it("is UNKNOWN (work) when the work throws, and restores", async () => {
    const { log, slot, deps } = setup();
    slot.azure.respondWith(proven(B));
    const out = await runTenantSession(deps, TARGET, async () => {
      throw new Error("boom");
    });
    expect(out).toMatchObject({ kind: "unknown", stage: "work", reason: "boom", restore: { kind: "restored" } });
    expect(log).toContain("lease:release");
  });

  it("is UNKNOWN (swap) when the target's token cannot be minted, and restores", async () => {
    const { log, slot, deps } = setup();
    slot.failMintFor = B;
    const out = await runTenantSession(deps, TARGET, async () => 1);
    expect(out).toMatchObject({ kind: "unknown", stage: "swap", restore: { kind: "restored" } });
    expect(log).toContain("install:pa");
  });

  it("keeps the work's answer but reports a FAILED restore", async () => {
    // The batch was proven and finished, so its answer stands; the operator
    // must still be told their active connection is not back.
    const { slot, deps } = setup();
    slot.azure.respondWith(...provenTwice(B));
    slot.failMintFor = A;
    const out = await runTenantSession(deps, TARGET, async () => 7);
    expect(out.kind).toBe("done");
    expect(out.restore.kind).toBe("failed");
    expect(out.restore.kind === "failed" ? out.restore.reason : "").toContain("AADSTS700016");
  });

  it("with no active connection, leaves the target's credential in the slot and says nothing needed restoring", async () => {
    const { log, slot, deps } = setup({ active: null });
    slot.azure.respondWith(...provenTwice(B));
    const out = await runTenantSession(deps, TARGET, async () => 1);
    expect(out).toMatchObject({ kind: "done", restore: { kind: "not-needed" } });
    expect(log.filter((l) => l.startsWith("install:"))).toEqual(["install:pb"]);
  });
});

// AZR-63 review: the session's own proxied requests (proof reads, token
// mints) went out unpaced, and a cancelled scan still sent them.
describe("runTenantSession - the caller's pacer and signal", () => {
  function pacerInto(log: string[]) {
    const signals: unknown[] = [];
    return {
      signals,
      pacer: {
        acquire: async (signal?: { readonly aborted: boolean }) => {
          signals.push(signal);
          if (signal?.aborted === true) throw new Error("cancelled");
          log.push("acquire");
        },
      },
    };
  }

  it("spends one request before every proof read and two before every mint (ARM and Graph), restore included", async () => {
    const { log, slot, deps } = setup();
    slot.azure.respondWith(...provenTwice(B));
    const { pacer } = pacerInto(log);
    const out = await runTenantSession({ ...deps, pacer }, TARGET, async () => {
      log.push("work");
      return 1;
    });
    expect(out.kind).toBe("done");
    expect(log.filter((l) => !l.startsWith("owner:"))).toEqual([
      "lease:take",
      "exclusive:enter",
      "install:pb",
      "acquire",
      "acquire",
      `mint:${B}`,
      `ports:${B}`,
      "acquire",
      "work",
      "acquire",
      "lease:take",
      "install:pa",
      "acquire",
      "acquire",
      `mint:${A}`,
      "exclusive:exit",
      "lease:release",
    ]);
  });

  it("once the signal aborts, the after-proof is not sent, the run is unknown, and the restore STILL runs", async () => {
    const { log, slot, deps } = setup();
    slot.azure.respondWith(...provenTwice(B));
    const signal = { aborted: false };
    const { pacer, signals } = pacerInto(log);
    const out = await runTenantSession({ ...deps, pacer, signal }, TARGET, async () => {
      signal.aborted = true;
      return 1;
    });
    expect(out).toMatchObject({ kind: "unknown", stage: "proof", restore: { kind: "restored" } });
    expect(slot.azure.calls.length).toBe(1);
    expect(log).toContain(`mint:${A}`);
    // The restore's acquires are never handed the signal: it must not be cancellable.
    expect(signals.slice(-2)).toEqual([undefined, undefined]);
  });
});

// AZR-92: the owner record is what OTHER tabs' ordinary batches check, so the
// session's writes to it must never name a tenant the slot does not hold.
describe("runTenantSession - the owner record other tabs check", () => {
  it("does not swap when the switching marker cannot be written - other tabs would be unprotected", async () => {
    const { log, slot, deps } = setup();
    slot.azure.respondWith(...provenTwice(B));
    // Only owner writes fail; the lease still takes and releases.
    const failing = new (class extends LoggingStore {
      override async save(key: string, value: unknown): Promise<void> {
        if (key === CREDENTIAL_OWNER_KEY) throw new Error("PUT owner: HTTP 500");
        await super.save(key, value);
      }
    })(log);
    let ran = false;
    const out = await runTenantSession({ ...deps, documents: failing }, TARGET, async () => {
      ran = true;
      return 1;
    });
    expect(ran).toBe(false);
    expect(out).toMatchObject({ kind: "unknown", stage: "swap" });
    expect(log.filter((l) => l.startsWith("install:pb"))).toEqual([]);
  });

  it("leaves the switching marker in place when the restore fails - the slot is in no known tenant's hands", async () => {
    const { log, slot, store, deps } = setup();
    slot.azure.respondWith(...provenTwice(B));
    slot.failMintFor = A;
    await runTenantSession(deps, TARGET, async () => 1);
    expect(log.filter((l) => l.startsWith("owner:")).slice(-1)).toEqual(["owner:switching"]);
    expect(decodeCredentialOwner(store.peek(CREDENTIAL_OWNER_KEY))).toBeNull();
  });

  it("gives every owner write its own write id, so an A -> B -> A run is not the record it replaced", async () => {
    const { slot, store, deps } = setup({
      seed: { [CREDENTIAL_OWNER_KEY]: { kind: "soc-credential-owner", profileId: "pa", tenantId: A, clientId: "ca" } },
    });
    slot.azure.respondWith(...provenTwice(B));
    const before = JSON.stringify(store.peek(CREDENTIAL_OWNER_KEY));
    await runTenantSession(deps, TARGET, async () => 1);
    const ownerWrites = store.saves.filter((s) => s.key === CREDENTIAL_OWNER_KEY).map((s) => JSON.stringify(s.value));
    expect(new Set(ownerWrites).size).toBe(ownerWrites.length);
    expect(JSON.stringify(store.peek(CREDENTIAL_OWNER_KEY))).not.toBe(before);
    expect(decodeCredentialOwner(store.peek(CREDENTIAL_OWNER_KEY))?.profileId).toBe("pa");
  });

  // Review finding: a failed restore marker was only logged, and the restore
  // went on installing A's credential under a record still naming the target
  // B - so another tab whose screens are for B was admitted mid-restore.
  describe("the restore never installs a credential under a record naming another tenant", () => {
    /**
     * Owner writes fail from the `from`-th on, except the kinds in `allow`:
     * `cleared` lets the cleared record land; `retryOk` fails only the first
     * switching marker, and nothing after it.
     */
    function failingOwnerStore(log: string[], from: number, allow: { cleared?: boolean; retryOk?: boolean } = {}) {
      let ownerSaves = 0;
      let switchingFails = 0;
      return new (class extends LoggingStore {
        override async save(key: string, value: unknown): Promise<void> {
          if (key === CREDENTIAL_OWNER_KEY) {
            ownerSaves += 1;
            const v = value as { switching?: boolean; profileId?: unknown };
            const isSwitching = v.switching === true;
            const isCleared = !isSwitching && v.profileId === null;
            if (ownerSaves >= from && !(allow.retryOk === true && switchingFails > 0 && !isSwitching)) {
              if (isSwitching) {
                switchingFails += 1;
                if (!(allow.retryOk === true && switchingFails > 1)) {
                  this.log.push("owner:write-failed");
                  throw new Error("PUT owner: HTTP 500");
                }
              } else if (!(isCleared && allow.cleared === true)) {
                this.log.push("owner:write-failed");
                throw new Error("PUT owner: HTTP 500");
              }
            }
          }
          await super.save(key, value);
          if (key === CREDENTIAL_OWNER_KEY && (value as { switching?: boolean; profileId?: unknown }).profileId === null && (value as { switching?: boolean }).switching !== true) {
            this.log.push("owner:cleared");
          }
        }
      })(log);
    }
    /** What an ordinary batch for tenant `t` in another tab would be told, read when A's secret goes in. */
    function judgedAtInstall(slot: FakeSlot, store: FakeKvDocumentStore, t: string): string[] {
      const seen: string[] = [];
      const install = slot.installCredential.bind(slot);
      slot.installCredential = async (p: TenantProfile) => {
        if (p.id === "pa") {
          const v = store.peek(CREDENTIAL_OWNER_KEY);
          seen.push(judgeSlotOwner(v === undefined ? { kind: "absent", why: "not-found" } : { kind: "value", value: v }, t).kind);
        }
        await install(p);
      };
      return seen;
    }

    it("retries the switching marker once before installing", async () => {
      const { log, slot, deps } = setup();
      slot.azure.respondWith(...provenTwice(B));
      const store = failingOwnerStore(log, 3, { retryOk: true });
      const seen = judgedAtInstall(slot, store, B);
      const out = await runTenantSession({ ...deps, documents: store }, TARGET, async () => 1);
      expect(out.restore).toEqual({ kind: "restored" });
      expect(log.slice(log.lastIndexOf("owner:write-failed"))).toEqual(["owner:write-failed", "owner:switching", "install:pa", `mint:${A}`, "owner:pa", "exclusive:exit", "lease:release"]);
      expect(seen).toEqual(["refuse"]);
    });

    it("writes the CLEARED record before installing when the marker cannot be written", async () => {
      const { log, slot, deps } = setup();
      slot.azure.respondWith(...provenTwice(B));
      const store = failingOwnerStore(log, 3, { cleared: true });
      const seen = judgedAtInstall(slot, store, B);
      await runTenantSession({ ...deps, documents: store }, TARGET, async () => 1);
      // A tab whose screens are for the target B is refused while A goes back in.
      expect(seen).toEqual(["refuse"]);
      expect(log.indexOf("owner:cleared")).toBeLessThan(log.indexOf("install:pa"));
    });

    it("does NOT restore when no owner write lands - the record still names the target, which the slot then still holds", async () => {
      const { log, slot, deps } = setup();
      slot.azure.respondWith(...provenTwice(B));
      const store = failingOwnerStore(log, 3);
      const out = await runTenantSession({ ...deps, documents: store }, TARGET, async () => 1);
      expect(log).not.toContain("install:pa");
      expect(out.restore).toMatchObject({ kind: "failed" });
      expect(out.restore.kind === "failed" ? out.restore.reason : "").toMatch(/record/);
      expect(decodeCredentialOwner(store.peek(CREDENTIAL_OWNER_KEY))?.profileId).toBe("pb");
    });
  });
});

// AZR-90: a Read all restored the active credential after EVERY tenant - two
// paced token mints each, for nothing. The batch swaps tenant to tenant and
// restores ONCE, and that one restore must survive every failure on the way.
describe("runTenantSessionBatch - tenant to tenant, one restore", () => {
  const C = "cccccccc-0000-0000-0000-00000000000c";
  const THIRD: TenantProfile = { id: "pc", name: "Woodgrove", config: { tenantId: C, clientId: "cc", subscriptionId: "sc" } };

  function batchSetup(opts: Parameters<typeof setup>[0] = {}) {
    const s = setup(opts);
    s.slot.credentials.add("pc");
    return s;
  }
  const work = (log: string[], name: string) => async () => {
    log.push(`work:${name}`);
    return name;
  };
  const RESTORE_TAIL = ["lease:take", "owner:switching", "install:pa", `mint:${A}`, "owner:pa", "exclusive:exit", "lease:release"];

  it("swaps A to B to C under one lease and one exclusive section, and restores the active credential once", async () => {
    const { log, slot, deps } = batchSetup();
    slot.azure.respondWith(...provenTwice(B), ...provenTwice(C));
    const out = await runTenantSessionBatch(deps, async (session) => [
      await session.runForTenant(TARGET, work(log, "pb")),
      await session.runForTenant(THIRD, work(log, "pc")),
    ]);

    expect(out.restore).toEqual({ kind: "restored" });
    expect(out.value).toEqual([
      { kind: "done", tenantId: B, value: "pb", restore: { kind: "deferred" } },
      { kind: "done", tenantId: C, value: "pc", restore: { kind: "deferred" } },
    ]);
    expect(log).toEqual([
      "lease:take",
      "exclusive:enter",
      "owner:switching",
      "install:pb",
      `mint:${B}`,
      "owner:pb",
      `ports:${B}`,
      "work:pb",
      // Renewed before the next tenant, so a long run never outlives it.
      "lease:take",
      // Straight from B to C: the active connection is NOT put back between.
      "owner:switching",
      "install:pc",
      `mint:${C}`,
      "owner:pc",
      `ports:${C}`,
      "work:pc",
      ...RESTORE_TAIL,
    ]);
  });

  it("spends two mints for the ONE restore, not two per tenant", async () => {
    const { log, slot, deps } = batchSetup();
    slot.azure.respondWith(...provenTwice(B), ...provenTwice(C), ...provenTwice(B));
    let acquires = 0;
    const pacer = {
      acquire: async () => {
        acquires += 1;
      },
    };
    await runTenantSessionBatch({ ...deps, pacer }, async (session) => {
      for (const p of [TARGET, THIRD, TARGET]) await session.runForTenant(p, async () => 1);
    });
    // Per tenant: 2 (mint) + 1 (proof) + 1 (proof after) = 4; plus 2 for the one restore.
    expect(acquires).toBe(3 * 4 + 2);
    expect(log.filter((l) => l === `mint:${A}`)).toEqual([`mint:${A}`]);
  });

  it("restores once when a tenant fails half-way, another's work throws, and the last swap breaks", async () => {
    const { log, slot, deps } = batchSetup();
    // B: its mint fails after its credential went in. C: proven, then the
    // work throws. B again: its credential cannot even be installed.
    slot.failMintFor = B;
    slot.azure.respondWith(proven(C));
    const out = await runTenantSessionBatch(deps, async (session) => {
      const first = await session.runForTenant(TARGET, async () => 1);
      const second = await session.runForTenant(THIRD, async () => {
        throw new Error("boom");
      });
      slot.failMintFor = null;
      slot.failInstallFor = "pb";
      const third = await session.runForTenant(TARGET, async () => 1);
      slot.failInstallFor = null;
      return [first, second, third].map((r) => (r.kind === "unknown" ? r.stage : r.kind));
    });
    expect(out.value).toEqual(["swap", "work", "swap"]);
    expect(out.restore).toEqual({ kind: "restored" });
    expect(log.filter((l) => l === "install:pa")).toEqual(["install:pa"]);
    expect(log.slice(-RESTORE_TAIL.length)).toEqual(RESTORE_TAIL);
  });

  it("restores and releases, then rejects, when the body itself throws mid-run", async () => {
    const { log, slot, deps } = batchSetup();
    slot.azure.respondWith(...provenTwice(B));
    await expect(
      runTenantSessionBatch(deps, async (session) => {
        await session.runForTenant(TARGET, async () => 1);
        throw new Error("screen gone");
      }),
    ).rejects.toThrow("screen gone");
    expect(log.slice(-RESTORE_TAIL.length)).toEqual(RESTORE_TAIL);
  });

  it("restores once a cancel stops the run part-way, never handing the restore the signal", async () => {
    const { log, slot, deps } = batchSetup();
    slot.azure.respondWith(...provenTwice(B));
    const signal = { aborted: false };
    const handed: unknown[] = [];
    const pacer = {
      acquire: async (s?: { readonly aborted: boolean }) => {
        handed.push(s);
        if (s?.aborted === true) throw new Error("cancelled");
      },
    };
    const out = await runTenantSessionBatch({ ...deps, pacer }, async (session) => {
      const first = await session.runForTenant(TARGET, async () => 1, { pacer, signal });
      signal.aborted = true;
      const second = await session.runForTenant(THIRD, async () => 1, { pacer, signal });
      return [first.kind, second.kind === "unknown" ? second.stage : second.kind];
    });
    expect(out.value).toEqual(["done", "swap"]);
    expect(out.restore).toEqual({ kind: "restored" });
    expect(handed.slice(-2)).toEqual([undefined, undefined]);
    expect(log.slice(-RESTORE_TAIL.length)).toEqual(RESTORE_TAIL);
  });

  it("needs no restore when every tenant read was the active connection", async () => {
    const { log, slot, deps } = batchSetup();
    slot.azure.respondWith(...provenTwice(A), ...provenTwice(A));
    const out = await runTenantSessionBatch(deps, async (session) => {
      await session.runForTenant(ACTIVE, async () => 1);
      await session.runForTenant(ACTIVE, async () => 1);
    });
    expect(out.restore).toEqual({ kind: "not-needed" });
    expect(log.filter((l) => l.startsWith("install:") || l.startsWith("owner:"))).toEqual([]);
  });

  it("reads the active connection mid-run by putting it back, and then needs no restore at the end", async () => {
    const { log, slot, deps } = batchSetup();
    slot.azure.respondWith(...provenTwice(B), ...provenTwice(A));
    const out = await runTenantSessionBatch(deps, async (session) => {
      await session.runForTenant(TARGET, async () => 1);
      await session.runForTenant(ACTIVE, async () => 1);
    });
    expect(out.restore).toEqual({ kind: "not-needed" });
    expect(log.filter((l) => l.startsWith("install:"))).toEqual(["install:pb", "install:pa"]);
  });

  it("stops reading, and still restores, when another tab took the lease between tenants", async () => {
    const { log, slot, store, deps } = batchSetup();
    slot.azure.respondWith(...provenTwice(B));
    const out = await runTenantSessionBatch(deps, async (session) => {
      const first = await session.runForTenant(TARGET, async () => 1);
      await store.save(CREDENTIAL_LEASE_KEY, takenLease("tab-2", 1000, 60_000));
      const second = await session.runForTenant(THIRD, async () => 1);
      return { first: first.kind, second };
    });
    expect(out.value.first).toBe("done");
    expect(out.value.second).toMatchObject({ kind: "unknown", stage: "lease", tenantId: C });
    expect(log).not.toContain("install:pc");
    // The restore still runs (a slot left on B would serve tenant B to the
    // next ordinary batch), but tab 2's lease is neither renewed nor released.
    expect(out.restore).toEqual({ kind: "restored" });
    expect(log.slice(log.indexOf(`ports:${B}`) + 1)).toEqual([
      "lease:take", // tab 2's
      "owner:switching",
      "install:pa",
      `mint:${A}`,
      "owner:pa",
      "exclusive:exit",
    ]);
    expect((await leaseIn(store))?.holder).toBe("tab-2");
  });

  // Review round 3: one slow tenant let the lease expire, and every tenant
  // after it was refused as "another tab" although no other tab existed.
  it("re-takes its own expired lease before the next tenant and still reads it", async () => {
    // now(): take at 1000; B's after-check at 2000; the renewal before C at
    // 999_999, long past the 60 s TTL; C's after-check; the restore.
    const { log, slot, store, deps } = batchSetup({ clock: [1000, 2000, 999_999, 1_000_500, 1_000_600] });
    slot.azure.respondWith(...provenTwice(B), ...provenTwice(C));
    const out = await runTenantSessionBatch(deps, async (session) => [
      await session.runForTenant(TARGET, work(log, "pb")),
      await session.runForTenant(THIRD, work(log, "pc")),
    ]);
    expect(out.value).toEqual([
      { kind: "done", tenantId: B, value: "pb", restore: { kind: "deferred" } },
      { kind: "done", tenantId: C, value: "pc", restore: { kind: "deferred" } },
    ]);
    expect(out.restore).toEqual({ kind: "restored" });
    expect(log.slice(log.indexOf("work:pb") + 1)).toEqual([
      "lease:take", // re-taken at 999_999
      "owner:switching",
      "install:pc",
      `mint:${C}`,
      "owner:pc",
      `ports:${C}`,
      "work:pc",
      ...RESTORE_TAIL,
    ]);
    expect(await leaseIn(store)).toBeNull();
  });

  it("refuses the next tenant, naming the other tab, when another tab took the expired lease", async () => {
    const { log, slot, store, deps } = batchSetup({ clock: [1000, 2000, 999_999] });
    slot.azure.respondWith(...provenTwice(B));
    const out = await runTenantSessionBatch(deps, async (session) => {
      await session.runForTenant(TARGET, async () => 1);
      await store.save(CREDENTIAL_LEASE_KEY, takenLease("tab-2", 990_000, 60_000));
      return session.runForTenant(THIRD, async () => 1);
    });
    expect(out.value).toEqual({
      kind: "unknown",
      tenantId: C,
      stage: "lease",
      reason:
        "Another tab of this app took the credential lease before Woodgrove was read, so it may be using the shared credential; it was not read.",
      restore: { kind: "deferred" },
    });
    expect(log).not.toContain("install:pc");
    expect((await leaseIn(store))?.holder).toBe("tab-2");
  });

  it("leaves another tab's lease standing when it is taken after the last tenant, before the restore", async () => {
    const { log, slot, store, deps } = batchSetup();
    slot.azure.respondWith(...provenTwice(B));
    const out = await runTenantSessionBatch(deps, async (session) => {
      const run = await session.runForTenant(TARGET, work(log, "pb"));
      // The last tenant's Cribl listing and bookkeeping run long; tab 2 takes the lease.
      await store.save(CREDENTIAL_LEASE_KEY, takenLease("tab-2", 1000, 60_000));
      return run.kind;
    });
    expect(out.value).toBe("done");
    expect(out.restore).toEqual({ kind: "restored" });
    expect(log.slice(log.indexOf("work:pb") + 1)).toEqual([
      "lease:take", // tab 2's
      "owner:switching",
      "install:pa",
      `mint:${A}`,
      "owner:pa",
      "exclusive:exit",
    ]);
    expect((await leaseIn(store))?.holder).toBe("tab-2");
  });

  it("does not release a lease it cannot re-read at the end", async () => {
    const { log, slot, store, deps } = batchSetup();
    slot.azure.respondWith(...provenTwice(A));
    await runTenantSessionBatch(deps, async (session) => {
      await session.runForTenant(ACTIVE, work(log, "pa"));
      store.scriptLoad(CREDENTIAL_LEASE_KEY, { kind: "unknown", reason: "HTTP 502", status: 502 });
    });
    expect(log.filter((l) => l.startsWith("lease:"))).toEqual(["lease:take"]);
  });

  // Review round 2: the lease and the exclusive section are taken by the first
  // run that passes its refusals, so a Read of refused tenants touches nothing.
  it("writes no lease and never enters the section when every tenant is refused or none is asked for", async () => {
    const { log, slot, deps } = batchSetup();
    slot.credentials.delete("pb");
    let entered = 0;
    const exclusive = slot.exclusive.bind(slot);
    slot.exclusive = async <T>(fn: () => Promise<T>) => {
      entered += 1;
      return exclusive(fn);
    };
    const refused = await runTenantSessionBatch(deps, async (session) => [
      await session.runForTenant(TARGET, async () => 1),
      await session.runForTenant({ ...THIRD, config: { ...THIRD.config, subscriptionId: "" } }, async () => 1),
    ]);
    expect(refused.value.map((r) => (r.kind === "unknown" ? r.stage : r.kind))).toEqual(["credential", "identity"]);
    expect(refused.restore).toEqual({ kind: "not-needed" });
    const empty = await runTenantSessionBatch(deps, async () => "nothing read");
    expect(empty).toEqual({ value: "nothing read", restore: { kind: "not-needed" } });
    expect(log).toEqual([]);
    expect(entered).toBe(0);
  });

  it("takes the lease at the first tenant that may be read, after a refused one", async () => {
    const { log, slot, deps } = batchSetup();
    slot.credentials.delete("pb");
    slot.azure.respondWith(...provenTwice(C));
    const out = await runTenantSessionBatch(deps, async (session) => [
      await session.runForTenant(TARGET, work(log, "pb")),
      await session.runForTenant(THIRD, work(log, "pc")),
    ]);
    expect(out.value.map((r) => r.kind)).toEqual(["unknown", "done"]);
    expect(log.slice(0, 3)).toEqual(["lease:take", "exclusive:enter", "owner:switching"]);
    expect(log.slice(-RESTORE_TAIL.length)).toEqual(RESTORE_TAIL);
  });

  it("tries the lease again at the next tenant once the other tab has released it", async () => {
    const { log, slot, store, deps } = batchSetup({ seed: { [CREDENTIAL_LEASE_KEY]: takenLease("tab-2", 1000, 30_000) } });
    slot.azure.respondWith(...provenTwice(C));
    const out = await runTenantSessionBatch(deps, async (session) => {
      const first = await session.runForTenant(TARGET, work(log, "pb"));
      await store.save(CREDENTIAL_LEASE_KEY, null);
      log.length = 0;
      const second = await session.runForTenant(THIRD, work(log, "pc"));
      return [first.kind === "unknown" ? first.stage : first.kind, second.kind];
    });
    expect(out.value).toEqual(["lease", "done"]);
    expect(log).toEqual([
      "lease:take",
      "exclusive:enter",
      "owner:switching",
      "install:pc",
      `mint:${C}`,
      "owner:pc",
      `ports:${C}`,
      "work:pc",
      ...RESTORE_TAIL,
    ]);
  });

  it("touches nothing but the lease read when another tab holds it, and says so for every tenant", async () => {
    const { log, deps } = batchSetup({ seed: { [CREDENTIAL_LEASE_KEY]: takenLease("tab-2", 1000, 30_000) } });
    const out = await runTenantSessionBatch(deps, async (session) => [
      await session.runForTenant(TARGET, async () => 1),
      await session.runForTenant(THIRD, async () => 1),
    ]);
    expect(out.value.map((r) => (r.kind === "unknown" ? r.stage : r.kind))).toEqual(["lease", "lease"]);
    expect(out.restore).toEqual({ kind: "not-needed" });
    expect(log).toEqual([]);
  });
});
