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
import { CREDENTIAL_LEASE_KEY, CREDENTIAL_OWNER_KEY, decodeCredentialOwner, encodeCredentialOwner, takenLease } from "@soc/core";
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
});
