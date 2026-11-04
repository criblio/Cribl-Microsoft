/**
 * Pins for the two paths that write or verify the shared Azure secret outside
 * a tenant session: Save and connect, and the once-per-connection probe (ADR
 * 0009; review findings on AZR-65).
 *
 * Every failure here is silent in the product: a connection marked live on
 * another connection's secret, a secret shown as FAILED that was never tried,
 * or another tab's tenant session having its credential swapped from under it.
 * So the pins assert the whole order of slot writes, and the exact state.
 */

import { describe, expect, it } from "vitest";
import { FakeKvDocumentStore } from "@soc/core";
import type { TenantProfile } from "@soc/core";
import {
  CREDENTIAL_LEASE_KEY,
  CREDENTIAL_OWNER_KEY,
  SWITCHING_MARKER_STALE_MS,
  classifyCredentialOwner,
  clearedCredentialOwner,
  decodeCredentialOwner,
  encodeCredentialOwner,
  switchingCredentialOwner,
  takenLease,
} from "@soc/core";
import type { KvDocumentLoad } from "@soc/core";
import { connectThroughSlot, probeStoredSecret } from "./secret-connect";
import type { SecretSlot } from "./secret-connect";

const T = "aaaaaaaa-0000-0000-0000-00000000000a";
const PA: TenantProfile = { id: "pa", name: "App A", config: { tenantId: T, clientId: "ca", subscriptionId: "s" } };
const PB: TenantProfile = { id: "pb", name: "App B", config: { tenantId: T, clientId: "cb", subscriptionId: "s" } };

/** A slot that records every operation in one log and runs exclusive sections inline. */
class FakeSlot implements SecretSlot {
  readonly log: string[];
  readonly held = new Map<string, string>();
  inExclusive = false;
  constructor(log: string[]) {
    this.log = log;
  }
  async exclusive<R>(fn: () => Promise<R>): Promise<R> {
    this.log.push("exclusive:enter");
    this.inExclusive = true;
    try {
      return await fn();
    } finally {
      this.inExclusive = false;
      this.log.push("exclusive:exit");
    }
  }
  remember(profileId: string, basic: string): void {
    this.held.set(profileId, basic);
    this.log.push(`remember:${profileId}`);
  }
  hasCredential(profile: TenantProfile): boolean {
    return this.held.has(profile.id);
  }
  async installCredential(profile: TenantProfile): Promise<void> {
    if (!this.inExclusive) throw new Error("install outside exclusive");
    this.log.push(`install:${profile.id}`);
  }
  noteSecretWritten(): void {
    this.log.push("note:secret");
  }
  noteArmToken(tenantId: string): void {
    if (!this.inExclusive) throw new Error("noteArmToken outside exclusive");
    this.log.push(`note:arm:${tenantId}`);
  }
}

function setup(over: { active?: () => TenantProfile | null; seed?: Record<string, unknown>; mintFails?: boolean } = {}) {
  const log: string[] = [];
  const slot = new FakeSlot(log);
  const documents = new FakeKvDocumentStore(over.seed ?? {});
  const deps = {
    slot,
    documents,
    holderId: "tab-1",
    now: () => 1000,
    writeSecret: async (basic: string) => {
      log.push(`write:basic:${basic}`);
    },
    mintArmToken: async (tenantId: string) => {
      log.push(`mint:${tenantId}`);
      if (over.mintFails === true) throw new Error("AADSTS7000215 invalid client secret");
      return { access_token: `tok-${tenantId}`, expires_in: 3599 };
    },
    writeArmToken: async (token: string) => {
      log.push(`write:arm:${token}`);
    },
    clearSlot: () => {
      log.push("clear:slot");
    },
    activeProfile: over.active ?? (() => PA),
  };
  return { log, slot, documents, deps };
}

const CONNECT = { tenantId: T, clientId: "ca", basic: "basic-a" };

describe("connectThroughSlot", () => {
  it("writes the secret and the token in ONE exclusive section, then records the owner and remembers the secret", async () => {
    const { log, documents, deps } = setup();
    const out = await connectThroughSlot(deps, PA, CONNECT);
    expect(out).toEqual({ kind: "connected", expiresIn: 3599 });
    expect(log).toEqual([
      "exclusive:enter",
      "write:basic:basic-a",
      "note:secret",
      `mint:${T}`,
      `write:arm:tok-${T}`,
      `note:arm:${T}`,
      "exclusive:exit",
      "remember:pa",
    ]);
    expect(decodeCredentialOwner(documents.peek(CREDENTIAL_OWNER_KEY))).toEqual({ profileId: "pa", tenantId: T, clientId: "ca" });
  });

  it("keeps the secret but reports the token step when the mint is refused", async () => {
    const { log, deps } = setup({ mintFails: true });
    const out = await connectThroughSlot(deps, PA, CONNECT);
    expect(out).toMatchObject({ kind: "token-failed" });
    expect(out.kind === "token-failed" ? out.message : "").toContain("AADSTS7000215");
    expect(log).toContain("remember:pa");
  });

  // Review finding: the record named the new owner although the token slot
  // could still hold the previous tenant's token, so other tabs were admitted.
  it("names NO owner when the token step failed - the record is cleared, never this connection", async () => {
    for (const failAt of ["mint", "write"] as const) {
      const { documents, deps } = setup({ mintFails: failAt === "mint" });
      if (failAt === "write") {
        deps.writeArmToken = async () => {
          throw new Error("PUT azureArmToken: HTTP 500");
        };
      }
      expect((await connectThroughSlot(deps, PA, CONNECT)).kind).toBe("token-failed");
      expect(classifyCredentialOwner(documents.peek(CREDENTIAL_OWNER_KEY))).toEqual({ kind: "cleared" });
    }
  });

  it("REFUSES while another tab holds the credential lease - its tenant session would be swapped from under it", async () => {
    // Review finding: Save and connect never read the lease, so it wrote the
    // lab's secret and token into the slot in the middle of another tab's
    // customer batch.
    const { log, deps } = setup({ seed: { [CREDENTIAL_LEASE_KEY]: takenLease("tab-2", 900, 60_000) } });
    const out = await connectThroughSlot(deps, PA, CONNECT);
    expect(out).toMatchObject({ kind: "leased" });
    expect(log).toEqual([]);
  });

  it("REFUSES when the lease cannot be read - never writes on a failed read", async () => {
    const { log, documents, deps } = setup();
    documents.scriptLoad(CREDENTIAL_LEASE_KEY, { kind: "unknown", reason: "HTTP 502", status: 502 });
    const out = await connectThroughSlot(deps, PA, CONNECT);
    expect(out).toMatchObject({ kind: "leased" });
    expect(log).toEqual([]);
  });

  it("goes ahead over this tab's own lease or an expired one", async () => {
    for (const lease of [takenLease("tab-1", 900, 60_000), takenLease("tab-2", 0, 10)]) {
      const { deps } = setup({ seed: { [CREDENTIAL_LEASE_KEY]: lease } });
      expect((await connectThroughSlot(deps, PA, CONNECT)).kind).toBe("connected");
    }
  });

  it("when the operator SWITCHED connection during connect, puts the now-active connection's secret back and marks nothing live", async () => {
    // Review finding: two app registrations in one tenant. Connect for A
    // waited on the slot, the operator switched to B, and A's secret and
    // token landed afterwards - noted for the shared tenant, so B's requests
    // skipped the mint and ran under A's app registration.
    let active: TenantProfile = PA;
    const { log, slot, documents, deps } = setup({ active: () => active });
    slot.held.set("pb", "basic-b");
    deps.writeSecret = async (basic: string) => {
      log.push(`write:basic:${basic}`);
      active = PB;
    };
    const out = await connectThroughSlot(deps, PA, CONNECT);
    expect(out).toMatchObject({ kind: "changed" });
    // The restore happens INSIDE the exclusive section, before any other
    // request of this tab can go out.
    expect(log.slice(log.indexOf(`note:arm:${T}`))).toEqual([`note:arm:${T}`, "install:pb", "note:secret", "exclusive:exit"]);
    expect(log).not.toContain("remember:pa");
    expect(decodeCredentialOwner(documents.peek(CREDENTIAL_OWNER_KEY))?.profileId).toBe("pb");
  });

  it("when switched to a connection whose secret this tab does not hold, clears the slot and the owner record", async () => {
    let active: TenantProfile = PA;
    const { log, documents, deps } = setup({ active: () => active });
    deps.writeSecret = async (basic: string) => {
      log.push(`write:basic:${basic}`);
      active = PB;
    };
    const out = await connectThroughSlot(deps, PA, CONNECT);
    expect(out).toMatchObject({ kind: "changed" });
    expect(log.slice(log.indexOf(`note:arm:${T}`))).toEqual([`note:arm:${T}`, "clear:slot", "note:secret", "exclusive:exit"]);
    expect(decodeCredentialOwner(documents.peek(CREDENTIAL_OWNER_KEY))).toBeNull();
  });

  it("reports a failed secret write and touches nothing else", async () => {
    const { log, deps } = setup();
    deps.writeSecret = async () => {
      throw new Error("PUT azureBasic: HTTP 500");
    };
    const out = await connectThroughSlot(deps, PA, CONNECT);
    expect(out).toMatchObject({ kind: "write-failed" });
    expect(log).toEqual(["exclusive:enter", "exclusive:exit"]);
  });

  // AZR-92: other tabs' ordinary batches check the owner record, so it must
  // never name a connection whose secret and token are not both in the slot.
  it("marks the slot SWITCHING before the secret is written, and names the owner only after the token", async () => {
    const { log, documents, deps } = setup();
    const seen: string[] = [];
    const peekOwner = () => {
      const v = documents.peek(CREDENTIAL_OWNER_KEY) as { switching?: boolean } | undefined;
      return v?.switching === true ? "switching" : (decodeCredentialOwner(v)?.profileId ?? "none");
    };
    deps.writeSecret = async (basic: string) => {
      seen.push(`secret:${peekOwner()}`);
      log.push(`write:basic:${basic}`);
    };
    deps.writeArmToken = async (token: string) => {
      seen.push(`token:${peekOwner()}`);
      log.push(`write:arm:${token}`);
    };
    expect((await connectThroughSlot(deps, PA, CONNECT)).kind).toBe("connected");
    expect(seen).toEqual(["secret:switching", "token:switching"]);
    expect(peekOwner()).toBe("pa");
    // Each owner write is its own record, so a batch spanning a reconnect is caught.
    const owners = documents.saves.filter((s) => s.key === CREDENTIAL_OWNER_KEY).map((s) => JSON.stringify(s.value));
    expect(new Set(owners).size).toBe(owners.length);
  });

  it("writes nothing when the switching marker cannot be written", async () => {
    const { log, documents, deps } = setup();
    documents.failSaves();
    const out = await connectThroughSlot(deps, PA, CONNECT);
    expect(out).toMatchObject({ kind: "write-failed" });
    expect(log).toEqual(["exclusive:enter", "exclusive:exit"]);
  });

  it("after a failed secret write the record is CLEARED, not left naming the previous owner or switching", async () => {
    const { documents, deps } = setup({
      seed: { [CREDENTIAL_OWNER_KEY]: encodeCredentialOwner({ profileId: "pb", tenantId: T, clientId: "cb" }) },
    });
    deps.writeSecret = async () => {
      throw new Error("PUT azureBasic: timeout");
    };
    await connectThroughSlot(deps, PA, CONNECT);
    const v = documents.peek(CREDENTIAL_OWNER_KEY) as Record<string, unknown>;
    expect(v.switching).toBeUndefined();
    expect(decodeCredentialOwner(v)).toBeNull();
  });
});

describe("probeStoredSecret", () => {
  const listed = (keys: string[]) => async () => keys;

  it("is MISSING when no azureBasic is stored", async () => {
    const { deps } = setup();
    expect(await probeStoredSecret({ ...deps, listKeys: listed([]) }, PA, () => undefined)).toEqual({ state: "missing" });
  });

  it("is LIVE when the owner record names this connection and the token is minted", async () => {
    const { log, deps } = setup({ seed: { [CREDENTIAL_OWNER_KEY]: encodeCredentialOwner({ profileId: "pa", tenantId: T, clientId: "ca" }) } });
    const out = await probeStoredSecret({ ...deps, listKeys: listed(["azureBasic"]) }, PA, () => undefined);
    expect(out).toEqual({ state: "live" });
    expect(log).toEqual(["exclusive:enter", `mint:${T}`, `write:arm:tok-${T}`, `note:arm:${T}`, "exclusive:exit"]);
  });

  it("is UNPROVEN - not failed - when the owner record names ANOTHER connection, and tries nothing", async () => {
    // Review finding: an owner mismatch read as a verified FAILED secret, with
    // text saying token acquisition was refused - when none was attempted, and
    // the record is a best-effort plain document that can be stale.
    const { log, deps } = setup({ seed: { [CREDENTIAL_OWNER_KEY]: encodeCredentialOwner({ profileId: "pb", tenantId: T, clientId: "cb" }) } });
    const out = await probeStoredSecret({ ...deps, listKeys: listed(["azureBasic"]) }, PA, (id) => (id === "pb" ? "App B" : undefined));
    expect(out.state).toBe("unproven");
    expect(out.state === "unproven" ? out.detail : "").toContain("App B");
    expect(out.state === "unproven" ? out.detail : "").not.toMatch(/refused|failed/i);
    expect(log).toEqual([]);
  });

  it("is UNPROVEN when the owner record cannot be read", async () => {
    const { log, documents, deps } = setup();
    documents.scriptLoad(CREDENTIAL_OWNER_KEY, { kind: "unknown", reason: "HTTP 502", status: 502 });
    const out = await probeStoredSecret({ ...deps, listKeys: listed(["azureBasic"]) }, PA, () => undefined);
    expect(out.state).toBe("unproven");
    expect(log).toEqual([]);
  });

  it("is UNPROVEN while another tab holds the lease - its swap may be in the slot right now", async () => {
    const { log, deps } = setup({ seed: { [CREDENTIAL_LEASE_KEY]: takenLease("tab-2", 900, 60_000) } });
    const out = await probeStoredSecret({ ...deps, listKeys: listed(["azureBasic"]) }, PA, () => undefined);
    expect(out.state).toBe("unproven");
    expect(log).toEqual([]);
  });

  it("is FAILED only when a token acquisition was actually refused", async () => {
    const { deps } = setup({ mintFails: true });
    const out = await probeStoredSecret({ ...deps, listKeys: listed(["azureBasic"]) }, PA, () => undefined);
    expect(out.state).toBe("failed");
    expect(out.state === "failed" ? out.detail : "").toContain("AADSTS7000215");
  });

  // AZR-92: a record nobody wrote (an older install) or a switching marker a
  // closed tab left behind would hold every other tab's batches back for good;
  // a live probe proves whose secret is in the slot, so it records it.
  it("records this connection as the owner after a LIVE probe when no record named anyone", async () => {
    const stale = switchingCredentialOwner("closed-tab:1:1", 1000 - SWITCHING_MARKER_STALE_MS);
    for (const seed of [{}, { [CREDENTIAL_OWNER_KEY]: clearedCredentialOwner() }, { [CREDENTIAL_OWNER_KEY]: stale }]) {
      const { documents, deps } = setup({ seed });
      expect(await probeStoredSecret({ ...deps, listKeys: listed(["azureBasic"]) }, PA, () => undefined)).toEqual({ state: "live" });
      expect(decodeCredentialOwner(documents.peek(CREDENTIAL_OWNER_KEY))).toEqual({ profileId: "pa", tenantId: T, clientId: "ca" });
    }
  });

  it("leaves a record that already names this connection alone", async () => {
    const mine = encodeCredentialOwner({ profileId: "pa", tenantId: T, clientId: "ca" }, "w-1");
    const { documents, deps } = setup({ seed: { [CREDENTIAL_OWNER_KEY]: mine } });
    await probeStoredSecret({ ...deps, listKeys: listed(["azureBasic"]) }, PA, () => undefined);
    expect(documents.saves).toEqual([]);
  });

  // Review findings: a LIVE switching marker read as "names nobody", so a
  // probe overwrote another tab's swap in progress - its token and its record.
  describe("never overwrites another tab's swap in progress", () => {
    const probe = (deps: ReturnType<typeof setup>["deps"]) =>
      probeStoredSecret({ ...deps, listKeys: listed(["azureBasic"]) }, PA, () => undefined);

    it("a FRESH switching marker (a Save and connect in flight - it takes no lease): no token write, no owner write", async () => {
      const { log, documents, deps } = setup({ seed: { [CREDENTIAL_OWNER_KEY]: switchingCredentialOwner("tab-2:990:1", 990) } });
      const out = await probe(deps);
      expect(out.state).toBe("unproven");
      expect(out.state === "unproven" ? out.detail : "").toMatch(/switching/);
      expect(log).toEqual([]);
      expect(documents.saves).toEqual([]);
    });

    it("a switching marker with no time (cannot be aged) is never presumed stale", async () => {
      const marker = { ...(switchingCredentialOwner("x") as Record<string, unknown>) };
      const { log, documents, deps } = setup({ seed: { [CREDENTIAL_OWNER_KEY]: marker } });
      expect((await probe(deps)).state).toBe("unproven");
      expect(log).toEqual([]);
      expect(documents.saves).toEqual([]);
    });

    it("a STALE marker with a live lease behind it is a session still swapping: nothing written", async () => {
      const stale = switchingCredentialOwner("tab-2:1:1", 1000 - SWITCHING_MARKER_STALE_MS);
      const { log, documents, deps } = setup({ seed: { [CREDENTIAL_OWNER_KEY]: stale } });
      // The lease is free when first read, taken by tab 2 by the time the
      // owner record has been read: the lease is read AFTER the owner.
      const load = documents.load.bind(documents);
      let ownerRead = false;
      documents.load = async (key: string): Promise<KvDocumentLoad> => {
        if (key === CREDENTIAL_OWNER_KEY) ownerRead = true;
        if (key === CREDENTIAL_LEASE_KEY && ownerRead) {
          return { kind: "value", value: takenLease("tab-2", 900, 60_000) };
        }
        return load(key);
      };
      expect((await probe(deps)).state).toBe("unproven");
      expect(log).toEqual([]);
      expect(documents.saves).toEqual([]);
    });

    it("re-reads lease and owner INSIDE the exclusive section: a session that took the lease meanwhile means no mint and no writes", async () => {
      const { log, documents, deps } = setup();
      const load = documents.load.bind(documents);
      documents.load = async (key: string): Promise<KvDocumentLoad> => {
        if (key === CREDENTIAL_LEASE_KEY && deps.slot.inExclusive) {
          return { kind: "value", value: takenLease("tab-2", 900, 60_000) };
        }
        return load(key);
      };
      const out = await probe(deps);
      expect(out.state).toBe("unproven");
      expect(log).toEqual(["exclusive:enter", "exclusive:exit"]);
      expect(documents.saves).toEqual([]);
    });

    it("an owner record rewritten between the first read and the exclusive section means no mint and no writes", async () => {
      const { log, documents, deps } = setup();
      const load = documents.load.bind(documents);
      documents.load = async (key: string): Promise<KvDocumentLoad> => {
        if (key === CREDENTIAL_OWNER_KEY && deps.slot.inExclusive) {
          return { kind: "value", value: switchingCredentialOwner("tab-2:999:1", 999) };
        }
        return load(key);
      };
      expect((await probe(deps)).state).toBe("unproven");
      expect(log).toEqual(["exclusive:enter", "exclusive:exit"]);
      expect(documents.saves).toEqual([]);
    });

    it("a record this app did not write is not overwritten by a probe", async () => {
      const { log, documents, deps } = setup({ seed: { [CREDENTIAL_OWNER_KEY]: { kind: "soc-credential-owner", tenantId: 7 } } });
      expect((await probe(deps)).state).toBe("unproven");
      expect(log).toEqual([]);
      expect(documents.saves).toEqual([]);
    });
  });
});
