// @vitest-environment happy-dom
/**
 * Pins for the shared Azure credential slot and the tenant session over it
 * (ADR 0009 decision 2; audit tenancy HIGH adapters.ts:256 and proxies.yml:40).
 *
 * The proxy injects every Azure credential from ONE fixed KV key per host, so
 * the failures here are all of one kind: a request sent under a credential it
 * was not meant for. That never shows as an error - it shows as another
 * tenant's answer. So the pins record the ORDER of every write and request the
 * transport saw, and assert it whole.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKvDocumentStore } from "@soc/core";
import type { TenantProfile } from "@soc/core";

const fetchWithTimeout = vi.fn();
const acquireArmToken = vi.fn();
const acquireGraphToken = vi.fn();
vi.mock("./http", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
  kvUrl: (key: string) => `kv:${key}`,
  kvDelete: vi.fn(),
  acquireArmToken: (...args: unknown[]) => acquireArmToken(...args),
  acquireGraphToken: (...args: unknown[]) => acquireGraphToken(...args),
}));

const { AzureCredentialSlot } = await import("./credential-slot");
const { PlatformAzureManagement, PlatformGraphDirectory, makeAzureCredentialSlot } = await import("./adapters");
const { PlatformTenantSession } = await import("./tenant-session");

const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "bbbbbbbb-0000-0000-0000-00000000000b";

/** Every transport event, in order: KV PUTs, token mints, ARM sends. */
let events: string[] = [];
/** The tenant whose ARM token the fake KV slot currently holds. */
let armSlot = "";
/** ARM answers, keyed by path; default 200 {}. */
let armAnswers: Record<string, { status: number; body: unknown }> = {};

function response(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === null ? "" : JSON.stringify(body)),
    headers: { get: () => null },
  };
}

beforeEach(() => {
  events = [];
  armSlot = "";
  armAnswers = {};
  acquireArmToken.mockImplementation(async (tenantId: string) => {
    events.push(`token:arm:${tenantId}`);
    return { access_token: `arm-${tenantId}` };
  });
  acquireGraphToken.mockImplementation(async (tenantId: string) => {
    events.push(`token:graph:${tenantId}`);
    return { access_token: `graph-${tenantId}` };
  });
  fetchWithTimeout.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.startsWith("kv:")) {
      const key = url.slice(3);
      events.push(`${method} ${key} ${String(init?.body ?? "")}`);
      if (key.startsWith("azureArmToken")) armSlot = String(init?.body ?? "").replace("arm-", "");
      return response(200, null);
    }
    const path = new URL(url).pathname;
    events.push(`ARM ${method} ${path} as ${armSlot}`);
    const answer = armAnswers[path];
    return answer !== undefined ? response(answer.status, answer.body) : response(200, {});
  });
});

afterEach(() => {
  fetchWithTimeout.mockReset();
  acquireArmToken.mockReset();
  acquireGraphToken.mockReset();
});

const GET = { method: "GET" as const, path: "/subscriptions/x", apiVersion: "2022-12-01" };
const P1: TenantProfile = { id: "p1", config: { tenantId: A, clientId: "ca", subscriptionId: "s1" } };

describe("AzureCredentialSlot - the session's secrets", () => {
  it("holds a secret only once the operator entered it this session", () => {
    const slot = makeAzureCredentialSlot();
    expect(slot.hasCredential(P1)).toBe(false);
    slot.remember("p1", "YmFzaWM=", P1.config);
    expect(slot.hasCredential(P1)).toBe(true);
    slot.forget("p1");
    expect(slot.hasCredential(P1)).toBe(false);
  });

  it("writes the remembered value to azureBasic, encrypted", async () => {
    const slot = makeAzureCredentialSlot();
    slot.remember("p1", "YmFzaWM=", P1.config);
    await slot.exclusive(() => slot.installCredential(P1));
    expect(events).toEqual(["PUT azureBasic?encrypted=true YmFzaWM="]);
  });

  it("refuses to install a secret it does not hold", async () => {
    const slot = makeAzureCredentialSlot();
    await expect(slot.exclusive(() => slot.installCredential({ ...P1, id: "nope" }))).rejects.toThrow(/not entered/);
    expect(events).toEqual([]);
  });

  it("does not hold - or install - a secret whose connection's identity was edited since it was entered", async () => {
    // Review finding: the copy was keyed by profile id only, so editing the
    // client id on Setup let a session restore cA's secret and record cA2 as
    // the owner - an identity that secret was never entered for.
    const slot = makeAzureCredentialSlot();
    slot.remember("p1", "basic-ca", P1.config);
    const edited = { ...P1, config: { ...P1.config, clientId: "ca2" } };
    expect(slot.hasCredential(edited)).toBe(false);
    await expect(slot.exclusive(() => slot.installCredential(edited))).rejects.toThrow(/entered for/);
    const retenanted = { ...P1, config: { ...P1.config, tenantId: B } };
    expect(slot.hasCredential(retenanted)).toBe(false);
    // Case and whitespace are not an edit.
    expect(slot.hasCredential({ ...P1, config: { ...P1.config, clientId: " CA " } })).toBe(true);
    expect(events).toEqual([]);
  });

  it("mints and stores BOTH tokens for the tenant", async () => {
    const slot = makeAzureCredentialSlot();
    await slot.exclusive(() => slot.mintTokens(B));
    expect(events).toEqual([
      `token:arm:${B}`,
      `PUT azureArmToken?encrypted=true arm-${B}`,
      `token:graph:${B}`,
      `PUT azureGraphToken?encrypted=true graph-${B}`,
    ]);
  });
});

describe("PlatformAzureManagement - one token owner per slot, not per instance", () => {
  it("mints on first use, and a SECOND instance for the same tenant reuses the token", async () => {
    // The old per-instance `tokenEnsured` boolean minted once per adapter.
    const slot = makeAzureCredentialSlot();
    await new PlatformAzureManagement(A, slot).request(GET);
    await new PlatformAzureManagement(A, slot).request(GET);
    expect(events.filter((e) => e.startsWith("token:arm"))).toEqual([`token:arm:${A}`]);
    expect(events.filter((e) => e.startsWith("ARM"))).toEqual([
      `ARM GET /subscriptions/x as ${A}`,
      `ARM GET /subscriptions/x as ${A}`,
    ]);
  });

  it("re-mints when ANOTHER tenant's adapter took the slot in between", async () => {
    // THE DEFECT (audit HIGH, adapters.ts:256): tenant A's adapter believed its
    // token was still in the slot after tenant B's adapter replaced it, and sent
    // A's request under B's token.
    const slot = makeAzureCredentialSlot();
    const a = new PlatformAzureManagement(A, slot);
    await a.request(GET);
    await new PlatformAzureManagement(B, slot).request(GET);
    await a.request(GET);
    expect(events.filter((e) => e.startsWith("ARM"))).toEqual([
      `ARM GET /subscriptions/x as ${A}`,
      `ARM GET /subscriptions/x as ${B}`,
      `ARM GET /subscriptions/x as ${A}`,
    ]);
  });

  it("re-mints after a NEW secret lands, even for the same tenant", async () => {
    // Two app registrations in one tenant: the token in the slot was minted
    // with the previous client's secret, so the tenant matching proves nothing.
    const slot = makeAzureCredentialSlot();
    const a = new PlatformAzureManagement(A, slot);
    await a.request(GET);
    slot.noteSecretWritten();
    await a.request(GET);
    expect(events.filter((e) => e.startsWith("token:arm"))).toEqual([`token:arm:${A}`, `token:arm:${A}`]);
  });

  it("installing a session credential also forgets whose token was in the slot", async () => {
    const slot = makeAzureCredentialSlot();
    slot.remember("p1", "basic-1", P1.config);
    await new PlatformAzureManagement(A, slot).request(GET);
    await slot.exclusive(() => slot.installCredential(P1));
    events = [];
    await new PlatformAzureManagement(A, slot).request(GET);
    expect(events[0]).toBe(`token:arm:${A}`);
  });

  it("re-mints once on a 401 and retries once", async () => {
    const slot = makeAzureCredentialSlot();
    armAnswers["/subscriptions/x"] = { status: 401, body: { error: "expired" } };
    const out = await new PlatformAzureManagement(A, slot).request(GET);
    expect(out.status).toBe(401);
    expect(events.filter((e) => e.startsWith("token:arm"))).toEqual([`token:arm:${A}`, `token:arm:${A}`]);
    expect(events.filter((e) => e.startsWith("ARM"))).toHaveLength(2);
  });

  it("holds an ordinary request back while a tenant session owns the slot", async () => {
    // Without this, the active screen's poll goes out under the customer
    // tenant's credential in the middle of a scan.
    const slot = makeAzureCredentialSlot();
    const active = new PlatformAzureManagement(A, slot);
    await active.request(GET);
    events = [];

    let releaseSession: () => void = () => undefined;
    const session = slot.exclusive(async () => {
      events.push("session:start");
      await slot.mintTokens(B);
      await new Promise<void>((r) => {
        releaseSession = r;
      });
      events.push("session:end");
    });
    await vi.waitFor(() => expect(events).toContain(`PUT azureGraphToken?encrypted=true graph-${B}`));
    const held = active.request(GET);
    await new Promise((r) => setTimeout(r, 0));
    expect(events.filter((e) => e.startsWith("ARM"))).toEqual([]);

    releaseSession();
    await session;
    await held;
    // It went out AFTER the session, and re-minted A first because B had the slot.
    const tail = events.slice(events.indexOf("session:end"));
    expect(tail).toEqual([
      "session:end",
      `token:arm:${A}`,
      `PUT azureArmToken?encrypted=true arm-${A}`,
      `ARM GET /subscriptions/x as ${A}`,
    ]);
  });

  it("lets a session wait for requests already in flight before it swaps", async () => {
    const slot = makeAzureCredentialSlot();
    let releaseArm: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      releaseArm = r;
    });
    const base = fetchWithTimeout.getMockImplementation()!;
    fetchWithTimeout.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!url.startsWith("kv:")) {
        await gate;
        events.push("ARM done");
        return response(200, {});
      }
      return base(url, init);
    });
    const inFlight = new PlatformAzureManagement(A, slot).request(GET);
    await vi.waitFor(() => expect(events).toContain(`PUT azureArmToken?encrypted=true arm-${A}`));
    const session = slot.exclusive(async () => {
      events.push("session:start");
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(events).not.toContain("session:start");
    releaseArm();
    await inFlight;
    await session;
    expect(events.indexOf("ARM done")).toBeLessThan(events.indexOf("session:start"));
  });

  it("never sends one tenant's request while ANOTHER tenant owns the slot, even when their mints overlap", async () => {
    // Review finding (HIGH): ensure-then-send were two steps under a reader
    // lock that admitted any tenant, so B could mint and PUT its token between
    // A's ensure and A's send - and A's request went out under B's token (or
    // A's late PUT overwrote B's after B had sent).
    const slot = makeAzureCredentialSlot();
    let releaseMintA: () => void = () => undefined;
    const gateA = new Promise<void>((r) => {
      releaseMintA = r;
    });
    const baseMint = acquireArmToken.getMockImplementation()!;
    acquireArmToken.mockImplementation(async (tenantId: string) => {
      const token = await baseMint(tenantId);
      if (tenantId === A) await gateA;
      return token;
    });
    const a = new PlatformAzureManagement(A, slot).request(GET);
    await vi.waitFor(() => expect(events).toContain(`token:arm:${A}`));
    const b = new PlatformAzureManagement(B, slot).request(GET);
    await new Promise((r) => setTimeout(r, 0));
    // B is held: it neither mints nor sends while A's request owns the slot.
    expect(events).toEqual([`token:arm:${A}`]);
    releaseMintA();
    await Promise.all([a, b]);
    expect(events).toEqual([
      `token:arm:${A}`,
      `PUT azureArmToken?encrypted=true arm-${A}`,
      `ARM GET /subscriptions/x as ${A}`,
      `token:arm:${B}`,
      `PUT azureArmToken?encrypted=true arm-${B}`,
      `ARM GET /subscriptions/x as ${B}`,
    ]);
  });

  it("admits a waiting tenant before later requests of the tenant that owns the slot (no starvation)", async () => {
    const slot = makeAzureCredentialSlot();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const base = fetchWithTimeout.getMockImplementation()!;
    let held = true;
    fetchWithTimeout.mockImplementation(async (url: string, init?: RequestInit) => {
      const out = await base(url, init);
      if (!url.startsWith("kv:") && held) {
        held = false;
        await gate;
      }
      return out;
    });
    const a1 = new PlatformAzureManagement(A, slot).request(GET);
    await vi.waitFor(() => expect(events).toContain(`ARM GET /subscriptions/x as ${A}`));
    const b = new PlatformAzureManagement(B, slot).request(GET);
    await new Promise((r) => setTimeout(r, 0));
    const a2 = new PlatformAzureManagement(A, slot).request(GET);
    release();
    await Promise.all([a1, b, a2]);
    expect(events.filter((e) => e.startsWith("ARM"))).toEqual([
      `ARM GET /subscriptions/x as ${A}`,
      `ARM GET /subscriptions/x as ${B}`,
      `ARM GET /subscriptions/x as ${A}`,
    ]);
  });
});

describe("session ports", () => {
  it("never wait for the slot (no deadlock inside a session) and never mint on first use", async () => {
    const slot = makeAzureCredentialSlot();
    await slot.exclusive(async () => {
      await slot.mintTokens(B);
      events = [];
      await slot.portsFor(B).azure.request(GET);
    });
    expect(events).toEqual([`ARM GET /subscriptions/x as ${B}`]);
  });

  it("are built for the session's tenant", () => {
    const slot = makeAzureCredentialSlot();
    const ports = slot.portsFor(B);
    expect(ports.azure).toBeInstanceOf(PlatformAzureManagement);
    expect(ports.graph).toBeInstanceOf(PlatformGraphDirectory);
  });
});

describe("PlatformTenantSession - end to end over the transport", () => {
  const ACTIVE: TenantProfile = { id: "pa", name: "Lab", config: { tenantId: A, clientId: "ca", subscriptionId: "sa" } };
  const TARGET: TenantProfile = { id: "pb", name: "Customer", config: { tenantId: B, clientId: "cb", subscriptionId: "sb" } };

  function session(slot: InstanceType<typeof AzureCredentialSlot>, documents = new FakeKvDocumentStore()) {
    return new PlatformTenantSession({
      slot,
      documents,
      holderId: "tab-1",
      now: () => 1000,
      getActiveProfile: () => ACTIVE,
    });
  }

  it("swaps to the target, proves it, works as the target, proves it again, and puts the active connection back", async () => {
    const slot = makeAzureCredentialSlot();
    slot.remember("pa", "basic-a", ACTIVE.config);
    slot.remember("pb", "basic-b", TARGET.config);
    armAnswers["/subscriptions/sb"] = { status: 200, body: { subscriptionId: "sb", tenantId: B } };

    const out = await session(slot).runForTenant(TARGET, async (ports) => {
      await ports.azure.request({ method: "GET", path: "/subscriptions/sb/resourcegroups", apiVersion: "2021-04-01" });
      return "scanned";
    });

    expect(out).toEqual({ kind: "done", tenantId: B, value: "scanned", restore: { kind: "restored" } });
    expect(events).toEqual([
      "PUT azureBasic?encrypted=true basic-b",
      `token:arm:${B}`,
      `PUT azureArmToken?encrypted=true arm-${B}`,
      `token:graph:${B}`,
      `PUT azureGraphToken?encrypted=true graph-${B}`,
      `ARM GET /subscriptions/sb as ${B}`,
      `ARM GET /subscriptions/sb/resourcegroups as ${B}`,
      // The proof again, after the work: the batch counts only if the slot
      // still answered as the target at the end.
      `ARM GET /subscriptions/sb as ${B}`,
      "PUT azureBasic?encrypted=true basic-a",
      `token:arm:${A}`,
      `PUT azureArmToken?encrypted=true arm-${A}`,
      `token:graph:${A}`,
      `PUT azureGraphToken?encrypted=true graph-${A}`,
    ]);
  });

  // AZR-63 review: the session's own proxied requests went out unpaced.
  it("spends the caller's pacer once per proxied request the session itself sends", async () => {
    const slot = makeAzureCredentialSlot();
    slot.remember("pa", "basic-a", ACTIVE.config);
    slot.remember("pb", "basic-b", TARGET.config);
    armAnswers["/subscriptions/sb"] = { status: 200, body: { subscriptionId: "sb", tenantId: B } };
    let acquired = 0;
    const pacer = { acquire: async () => void (acquired += 1) };
    await session(slot).runForTenant(TARGET, async () => 1, { pacer });
    // Two mints of two tokens (swap and restore) and two proof reads.
    const proxied = events.filter((e) => e.startsWith("token:") || e.startsWith("ARM GET")).length;
    expect(proxied).toBe(6);
    expect(acquired).toBe(proxied);
  });

  it("records whose secret is in the slot, and releases the lease", async () => {
    const slot = makeAzureCredentialSlot();
    slot.remember("pa", "basic-a", ACTIVE.config);
    slot.remember("pb", "basic-b", TARGET.config);
    armAnswers["/subscriptions/sb"] = { status: 200, body: { tenantId: B } };
    const docs = new FakeKvDocumentStore();
    await session(slot, docs).runForTenant(TARGET, async () => 1);
    expect(docs.saves.map((s) => s.key)).toEqual([
      "azure-credential-lease",
      "azure-credential-owner",
      "azure-credential-owner",
      "azure-credential-lease",
    ]);
    expect(docs.peek("azure-credential-owner")).toMatchObject({ profileId: "pa", tenantId: A });
  });

  it("an ordinary adapter for the active tenant needs no re-mint after the restore", async () => {
    const slot = makeAzureCredentialSlot();
    slot.remember("pa", "basic-a", ACTIVE.config);
    slot.remember("pb", "basic-b", TARGET.config);
    armAnswers["/subscriptions/sb"] = { status: 200, body: { tenantId: B } };
    await session(slot).runForTenant(TARGET, async () => 1);
    events = [];
    await new PlatformAzureManagement(A, slot).request(GET);
    expect(events).toEqual([`ARM GET /subscriptions/x as ${A}`]);
  });
});
