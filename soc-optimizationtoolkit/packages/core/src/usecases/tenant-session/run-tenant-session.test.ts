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
  takenLease,
} from "../../domain/tenancy";
import { runTenantSession } from "./run-tenant-session";

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
      this.log.push(`owner:${decodeCredentialOwner(value)?.profileId ?? "?"}`);
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
      "install:pb",
      "owner:pb",
      `mint:${B}`,
      `ports:${B}`,
      "work",
      "install:pa",
      "owner:pa",
      `mint:${A}`,
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

  it("does NOT release a lease that has already expired - it may be someone else's now", async () => {
    const { log, slot, deps } = setup({ clock: [1000, 999_999] });
    slot.azure.respondWith(proven(B));
    await runTenantSession(deps, TARGET, async () => 1);
    expect(log).not.toContain("lease:release");
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
    expect(log.slice(-5)).toEqual(["install:pa", "owner:pa", `mint:${A}`, "exclusive:exit", "lease:release"]);
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
    const { slot, store, deps } = setup();
    slot.azure.respondWith(...provenTwice(B));
    const out = await runTenantSession(deps, TARGET, async () => {
      await store.save(CREDENTIAL_LEASE_KEY, takenLease("tab-2", 1000, 60_000));
      return 1;
    });
    expect(out).toMatchObject({ kind: "unknown", stage: "lease", restore: { kind: "restored" } });
  });

  it("is UNKNOWN (lease) when the lease expired during the work - another tab may have swapped the slot", async () => {
    const { log, slot, deps } = setup({ clock: [1000, 70_000] });
    slot.azure.respondWith(...provenTwice(B));
    const out = await runTenantSession(deps, TARGET, async () => 1);
    expect(out).toMatchObject({ kind: "unknown", stage: "lease" });
    // And an expired lease is never released: it may be someone else's.
    expect(log).not.toContain("lease:release");
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
    expect(log.filter((l) => l !== "owner:pb" && l !== "owner:pa")).toEqual([
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
