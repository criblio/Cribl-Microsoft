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
import { CREDENTIAL_OWNER_KEY, FakeKvDocumentStore, encodeCredentialOwner } from "@soc/core";
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

const { AzureCredentialSlot, BATCH_JOIN_MS, SharedCredentialRefusal } = await import("./credential-slot");
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

/**
 * A slot over its own in-memory owner store (AZR-92), so the owner reads stay
 * out of `events` - which records only what reaches the KV slot and Azure.
 */
function newSlot(documents: FakeKvDocumentStore = new FakeKvDocumentStore()) {
  return makeAzureCredentialSlot(documents);
}

const GET = { method: "GET" as const, path: "/subscriptions/x", apiVersion: "2022-12-01" };
const P1: TenantProfile = { id: "p1", config: { tenantId: A, clientId: "ca", subscriptionId: "s1" } };

describe("AzureCredentialSlot - the session's secrets", () => {
  it("holds a secret only once the operator entered it this session", () => {
    const slot = newSlot();
    expect(slot.hasCredential(P1)).toBe(false);
    slot.remember("p1", "YmFzaWM=", P1.config);
    expect(slot.hasCredential(P1)).toBe(true);
    slot.forget("p1");
    expect(slot.hasCredential(P1)).toBe(false);
  });

  it("writes the remembered value to azureBasic, encrypted", async () => {
    const slot = newSlot();
    slot.remember("p1", "YmFzaWM=", P1.config);
    await slot.exclusive(() => slot.installCredential(P1));
    expect(events).toEqual(["PUT azureBasic?encrypted=true YmFzaWM="]);
  });

  it("refuses to install a secret it does not hold", async () => {
    const slot = newSlot();
    await expect(slot.exclusive(() => slot.installCredential({ ...P1, id: "nope" }))).rejects.toThrow(/not entered/);
    expect(events).toEqual([]);
  });

  it("does not hold - or install - a secret whose connection's identity was edited since it was entered", async () => {
    // Review finding: the copy was keyed by profile id only, so editing the
    // client id on Setup let a session restore cA's secret and record cA2 as
    // the owner - an identity that secret was never entered for.
    const slot = newSlot();
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
    const slot = newSlot();
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
    const slot = newSlot();
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
    const slot = newSlot();
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
    const slot = newSlot();
    const a = new PlatformAzureManagement(A, slot);
    await a.request(GET);
    slot.noteSecretWritten();
    await a.request(GET);
    expect(events.filter((e) => e.startsWith("token:arm"))).toEqual([`token:arm:${A}`, `token:arm:${A}`]);
  });

  it("installing a session credential also forgets whose token was in the slot", async () => {
    const slot = newSlot();
    slot.remember("p1", "basic-1", P1.config);
    await new PlatformAzureManagement(A, slot).request(GET);
    await slot.exclusive(() => slot.installCredential(P1));
    events = [];
    await new PlatformAzureManagement(A, slot).request(GET);
    expect(events[0]).toBe(`token:arm:${A}`);
  });

  it("re-mints once on a 401 and retries once", async () => {
    const slot = newSlot();
    armAnswers["/subscriptions/x"] = { status: 401, body: { error: "expired" } };
    const out = await new PlatformAzureManagement(A, slot).request(GET);
    expect(out.status).toBe(401);
    expect(events.filter((e) => e.startsWith("token:arm"))).toEqual([`token:arm:${A}`, `token:arm:${A}`]);
    expect(events.filter((e) => e.startsWith("ARM"))).toHaveLength(2);
  });

  it("holds an ordinary request back while a tenant session owns the slot", async () => {
    // Without this, the active screen's poll goes out under the customer
    // tenant's credential in the middle of a scan.
    const slot = newSlot();
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
    const slot = newSlot();
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
    const slot = newSlot();
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
    const slot = newSlot();
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
    const slot = newSlot();
    await slot.exclusive(async () => {
      await slot.mintTokens(B);
      events = [];
      await slot.portsFor(B).azure.request(GET);
    });
    expect(events).toEqual([`ARM GET /subscriptions/x as ${B}`]);
  });

  it("are built for the session's tenant", () => {
    const slot = newSlot();
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
    const slot = newSlot();
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
    const slot = newSlot();
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
    const slot = newSlot();
    slot.remember("pa", "basic-a", ACTIVE.config);
    slot.remember("pb", "basic-b", TARGET.config);
    armAnswers["/subscriptions/sb"] = { status: 200, body: { tenantId: B } };
    const docs = new FakeKvDocumentStore();
    await session(slot, docs).runForTenant(TARGET, async () => 1);
    expect(docs.saves.map((s) => s.key)).toEqual([
      "azure-credential-lease",
      // switching, target, switching, active (AZR-92)
      "azure-credential-owner",
      "azure-credential-owner",
      "azure-credential-owner",
      "azure-credential-owner",
      "azure-credential-lease",
    ]);
    expect(docs.peek("azure-credential-owner")).toMatchObject({ profileId: "pa", tenantId: A });
  });

  it("an ordinary adapter for the active tenant needs no re-mint after the restore", async () => {
    const slot = newSlot();
    slot.remember("pa", "basic-a", ACTIVE.config);
    slot.remember("pb", "basic-b", TARGET.config);
    armAnswers["/subscriptions/sb"] = { status: 200, body: { tenantId: B } };
    await session(slot).runForTenant(TARGET, async () => 1);
    events = [];
    await new PlatformAzureManagement(A, slot).request(GET);
    expect(events).toEqual([`ARM GET /subscriptions/x as ${A}`]);
  });
});

// ---------------------------------------------------------------------------
// AZR-92: an owner check per batch
// ---------------------------------------------------------------------------

describe("AZR-92 - every ordinary Azure batch checks the slot's owner before sending and after settling", () => {
  const owner = (tenantId: string, writeId = "tab-9:1:1") =>
    encodeCredentialOwner({ profileId: "px", tenantId, clientId: "cx" }, writeId);
  const ownerReads = (docs: FakeKvDocumentStore) => docs.loads.filter((k) => k === CREDENTIAL_OWNER_KEY).length;
  /** Everything that left for Azure or Entra: ARM sends and token mints. */
  const azureTraffic = () => events.filter((e) => e.startsWith("ARM") || e.startsWith("token:"));
  /** After the first Azure send, run `then` (another tab writing the owner record, say). */
  function onFirstAzureSend(then: () => Promise<void> | void) {
    const base = fetchWithTimeout.getMockImplementation()!;
    let fired = false;
    fetchWithTimeout.mockImplementation(async (url: string, init?: RequestInit) => {
      const out = await base(url, init);
      if (!url.startsWith("kv:") && !fired) {
        fired = true;
        await then();
      }
      return out;
    });
  }

  it("own tenant: the request is sent, for exactly TWO owner reads - one before, one after", async () => {
    const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
    const out = await new PlatformAzureManagement(A, newSlot(docs)).request(GET);
    expect(out.status).toBe(200);
    expect(events.filter((e) => e.startsWith("ARM"))).toEqual([`ARM GET /subscriptions/x as ${A}`]);
    expect(ownerReads(docs)).toBe(2);
  });

  it("foreign owner: a GET is REFUSED as unknown - it rejects (never a status a screen could read as red or empty) and nothing is sent", async () => {
    const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(B) });
    const req = new PlatformAzureManagement(A, newSlot(docs)).request(GET);
    await expect(req).rejects.toBeInstanceOf(SharedCredentialRefusal);
    await expect(req).rejects.toThrow(/another tab of this app is reading a different tenant/);
    expect(azureTraffic()).toEqual([]);
    // Refused on the before-read: one owner read, no after-read.
    expect(ownerReads(docs)).toBe(1);
  });

  it("foreign owner: a PUT, POST, PATCH or DELETE is refused BEFORE anything is sent - not even a token mint", async () => {
    for (const method of ["PUT", "POST", "PATCH", "DELETE"] as const) {
      const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(B) });
      const azure = new PlatformAzureManagement(A, newSlot(docs));
      await expect(azure.request({ ...GET, method, body: {} })).rejects.toThrow(/Nothing was written/);
      await expect(
        azure.requestUrl({ method, url: "https://management.azure.com/subscriptions/x?api-version=1" }),
      ).rejects.toThrow(/Nothing was written/);
    }
    expect(azureTraffic()).toEqual([]);
  });

  it("owner flips mid-batch (another tab's session swapped while the read was in flight): the answer is DISCARDED as unknown", async () => {
    const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
    onFirstAzureSend(() => docs.save(CREDENTIAL_OWNER_KEY, owner(B, "tab-2:5:1")));
    const req = new PlatformAzureManagement(A, newSlot(docs)).request(GET);
    await expect(req).rejects.toThrow(/changed while this read was in flight/);
    // It WAS sent - that is what the after-read is for - and its answer is not returned.
    expect(events.filter((e) => e.startsWith("ARM"))).toHaveLength(1);
    expect(ownerReads(docs)).toBe(2);
  });

  it("owner rewritten to the SAME tenant mid-batch (a whole A -> N -> A session ran during it) still discards", async () => {
    const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A, "w-1") });
    onFirstAzureSend(() => docs.save(CREDENTIAL_OWNER_KEY, owner(A, "w-2")));
    await expect(new PlatformAzureManagement(A, newSlot(docs)).request(GET)).rejects.toBeInstanceOf(SharedCredentialRefusal);
  });

  it("a write whose owner changed in flight is reported as an UNKNOWN outcome, not as success", async () => {
    const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
    onFirstAzureSend(() => docs.save(CREDENTIAL_OWNER_KEY, owner(B, "tab-2:5:1")));
    await expect(new PlatformAzureManagement(A, newSlot(docs)).request({ ...GET, method: "PUT", body: {} })).rejects.toThrow(
      /outcome is unknown/,
    );
  });

  it("an unreadable or undecodable owner record is unknown, never success - and nothing is sent", async () => {
    const unreadable = { kind: "unknown" as const, reason: "GET kvstore/azure-credential-owner: HTTP 502", status: 502 };
    const reads = [
      unreadable,
      { kind: "absent" as const, why: "corrupt" as const },
      { kind: "value" as const, value: { kind: "soc-credential-owner", tenantId: 42 } },
    ];
    for (const read of reads) {
      const docs = new FakeKvDocumentStore().scriptLoad(CREDENTIAL_OWNER_KEY, read);
      await expect(new PlatformAzureManagement(A, newSlot(docs)).request(GET)).rejects.toBeInstanceOf(SharedCredentialRefusal);
    }
    const docs = new FakeKvDocumentStore().scriptLoad(CREDENTIAL_OWNER_KEY, unreadable);
    await expect(new PlatformAzureManagement(A, newSlot(docs)).request(GET)).rejects.toThrow(/HTTP 502/);
    expect(azureTraffic()).toEqual([]);
  });

  it("an unreadable owner AFTER the batch discards the answer", async () => {
    const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
    onFirstAzureSend(() => {
      docs.scriptLoad(CREDENTIAL_OWNER_KEY, { kind: "unknown", reason: "timeout" });
    });
    await expect(new PlatformAzureManagement(A, newSlot(docs)).request(GET)).rejects.toThrow(/timeout/);
  });

  it("N concurrent reads in one tab share ONE before-read and ONE after-read", async () => {
    const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
    const slot = newSlot(docs);
    const outs = await Promise.all([
      new PlatformAzureManagement(A, slot).request(GET),
      new PlatformAzureManagement(A, slot).request(GET),
      new PlatformAzureManagement(A, slot).request(GET),
      new PlatformAzureManagement(A, slot).request(GET),
      new PlatformGraphDirectory(A, slot).listServicePrincipals(),
    ]);
    expect(outs).toHaveLength(5);
    // The fake transport labels every non-KV send "ARM" - the Graph page too.
    expect(events.filter((e) => e.startsWith("ARM"))).toHaveLength(5);
    expect(ownerReads(docs)).toBe(2);
  });

  it("a write never rides an earlier read's before-check: it reads the owner itself before it is sent", async () => {
    const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
    const slot = newSlot(docs);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    onFirstAzureSend(() => gate);
    const read = new PlatformAzureManagement(A, slot).request(GET);
    await vi.waitFor(() => expect(events).toContain(`ARM GET /subscriptions/x as ${A}`));
    expect(ownerReads(docs)).toBe(1);
    // Another tab's session now owns the slot. The write must see that.
    await docs.save(CREDENTIAL_OWNER_KEY, owner(B, "tab-2:5:1"));
    await expect(new PlatformAzureManagement(A, slot).request({ ...GET, method: "PUT", body: {} })).rejects.toThrow(
      /Nothing was written/,
    );
    expect(events.filter((e) => e.startsWith("ARM PUT"))).toEqual([]);
    release();
    await expect(read).rejects.toBeInstanceOf(SharedCredentialRefusal);
  });

  it("Graph reads are checked too: a foreign owner refuses the directory read and mints nothing", async () => {
    const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(B) });
    await expect(new PlatformGraphDirectory(A, newSlot(docs)).listServicePrincipals()).rejects.toBeInstanceOf(
      SharedCredentialRefusal,
    );
    expect(azureTraffic()).toEqual([]);
  });

  it("an owner record that was never written (an install from before it existed) admits the request", async () => {
    const docs = new FakeKvDocumentStore();
    expect((await new PlatformAzureManagement(A, newSlot(docs)).request(GET)).status).toBe(200);
    expect(ownerReads(docs)).toBe(2);
  });

  it("building the slot and the adapters reads nothing - mounting a screen adds no owner read", () => {
    const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
    const slot = newSlot(docs);
    new PlatformAzureManagement(A, slot);
    new PlatformGraphDirectory(A, slot);
    slot.portsFor(B);
    expect(docs.loads).toEqual([]);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  // -- review findings on the AZR-92 diff --------------------------------------

  it("the after-read waits for the LAST member of a batch: a slow read sent after another tab's swap is discarded", async () => {
    // Review finding: no pin proved this; the coalescing pin settles every
    // member together, so starting the after-read on the FIRST leave passed.
    const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
    const slot = newSlot(docs);
    let releaseSlow: () => void = () => undefined;
    const slowGate = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const base = fetchWithTimeout.getMockImplementation()!;
    const order: string[] = [];
    fetchWithTimeout.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/subscriptions/slow")) {
        await slowGate;
        order.push("slow:sent");
      }
      return base(url, init);
    });
    const loadOwner = docs.load.bind(docs);
    docs.load = async (key: string) => {
      if (key === CREDENTIAL_OWNER_KEY) order.push("owner:read");
      return loadOwner(key);
    };
    const azure = new PlatformAzureManagement(A, slot);
    const fast = azure.request(GET);
    const slow = azure.request({ ...GET, path: "/subscriptions/slow" });
    // The fast member has been answered; let it leave the batch.
    await vi.waitFor(() => expect(events).toContain(`ARM GET /subscriptions/x as ${A}`));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // Another tab swaps to B while the slow member is still to be sent.
    await docs.save(CREDENTIAL_OWNER_KEY, owner(B, "tab-2:5:1"));
    releaseSlow();
    await expect(slow).rejects.toMatchObject({ name: "SharedCredentialRefusal", stage: "after" });
    await expect(fast).rejects.toMatchObject({ stage: "after" });
    // One before-read, and the after-read only once the slow member was sent.
    expect(order).toEqual(["owner:read", "slow:sent", "owner:read"]);
  });

  describe("anything sent later on a batch's verdict re-checks the owner first", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a foreign owner written during a 429 wait means ZERO resends of a write", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
      armAnswers["/subscriptions/x"] = { status: 429, body: { error: "throttled" } };
      onFirstAzureSend(() => docs.save(CREDENTIAL_OWNER_KEY, owner(B, "tab-2:5:1")));
      const put = new PlatformAzureManagement(A, newSlot(docs)).request({ ...GET, method: "PUT", body: {} });
      const settled = put.then(
        () => "resolved",
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const out = await settled;
      expect(out).toBeInstanceOf(SharedCredentialRefusal);
      expect((out as InstanceType<typeof SharedCredentialRefusal>).stage).toBe("before");
      expect(events.filter((e) => e.startsWith("ARM PUT"))).toHaveLength(1);
      // Before, and the one re-check before the resend that was not sent.
      expect(ownerReads(docs)).toBe(2);
    });

    it("an unchanged owner lets the write's resend go, for one extra owner read per resend", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
      armAnswers["/subscriptions/x"] = { status: 429, body: { error: "throttled" } };
      onFirstAzureSend(() => {
        armAnswers["/subscriptions/x"] = { status: 200, body: {} };
      });
      const put = new PlatformAzureManagement(A, newSlot(docs)).request({ ...GET, method: "PUT", body: {} });
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await put).status).toBe(200);
      expect(events.filter((e) => e.startsWith("ARM PUT"))).toHaveLength(2);
      // before + re-check + after.
      expect(ownerReads(docs)).toBe(3);
    });

    it.each(["GET", "PUT"] as const)("a foreign owner written before a 401 re-mint means NO re-mint and no retry (%s)", async (method) => {
      const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
      const slot = newSlot(docs);
      slot.noteArmToken(A);
      armAnswers["/subscriptions/x"] = { status: 401, body: { error: "expired" } };
      onFirstAzureSend(() => docs.save(CREDENTIAL_OWNER_KEY, owner(B, "tab-2:5:1")));
      await expect(new PlatformAzureManagement(A, slot).request({ ...GET, method })).rejects.toBeInstanceOf(
        SharedCredentialRefusal,
      );
      expect(events.filter((e) => e.startsWith("token:"))).toEqual([]);
      expect(events.filter((e) => e.startsWith("ARM"))).toHaveLength(1);
    });
  });

  it("Graph: a foreign owner written before the 401/403 re-mint means no Graph mint and no retry", async () => {
    const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
    const slot = newSlot(docs);
    armAnswers["/v1.0/servicePrincipals"] = { status: 403, body: { error: "stale consent" } };
    await new PlatformAzureManagement(A, slot).request(GET); // warm nothing for Graph
    events = [];
    const graph = new PlatformGraphDirectory(A, slot);
    let sends = 0;
    const base = fetchWithTimeout.getMockImplementation()!;
    fetchWithTimeout.mockImplementation(async (url: string, init?: RequestInit) => {
      const out = await base(url, init);
      if (url.includes("servicePrincipals") && ++sends === 1) await docs.save(CREDENTIAL_OWNER_KEY, owner(B, "tab-2:5:1"));
      return out;
    });
    await expect(graph.listServicePrincipals()).rejects.toBeInstanceOf(SharedCredentialRefusal);
    expect(events.filter((e) => e.startsWith("token:graph"))).toHaveLength(1); // the first-use mint only
    expect(sends).toBe(1);
  });

  describe("a batch admits new reads only while its verdict is fresh", () => {
    it("a read asked more than BATCH_JOIN_MS after the batch's before-read opens its OWN batch", async () => {
      // Review finding: a batch stayed open until its first member settled, so
      // a read asked a minute later (behind a 429 backoff) rode a minute-old verdict.
      let clock = 10_000;
      const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
      const slot = makeAzureCredentialSlot(docs, () => clock);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      onFirstAzureSend(() => gate);
      const first = new PlatformAzureManagement(A, slot).request(GET);
      await vi.waitFor(() => expect(events).toContain(`ARM GET /subscriptions/x as ${A}`));
      expect(ownerReads(docs)).toBe(1);
      clock += BATCH_JOIN_MS + 1;
      // Meanwhile another tab swapped to B: the late read must see that.
      await docs.save(CREDENTIAL_OWNER_KEY, owner(B, "tab-2:5:1"));
      await expect(new PlatformAzureManagement(A, slot).request(GET)).rejects.toMatchObject({ stage: "before" });
      expect(ownerReads(docs)).toBe(2);
      release();
      await expect(first).rejects.toBeInstanceOf(SharedCredentialRefusal);
    });

    it("a read asked within BATCH_JOIN_MS joins the open batch (no extra owner read)", async () => {
      const clock = 10_000;
      const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
      const slot = makeAzureCredentialSlot(docs, () => clock);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      onFirstAzureSend(() => gate);
      const first = new PlatformAzureManagement(A, slot).request(GET);
      await vi.waitFor(() => expect(events).toContain(`ARM GET /subscriptions/x as ${A}`));
      const second = new PlatformAzureManagement(A, slot).request(GET);
      release();
      await Promise.all([first, second]);
      expect(ownerReads(docs)).toBe(2);
    });

    it("a SEQUENTIAL chain of reads reuses each after-read as the next before-read: 1 owner read per request after the first", async () => {
      let clock = 10_000;
      const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
      const slot = makeAzureCredentialSlot(docs, () => clock);
      const azure = new PlatformAzureManagement(A, slot);
      for (let page = 0; page < 5; page++) await azure.request(GET);
      expect(ownerReads(docs)).toBe(6);
      // Past the window the chain starts over: before and after again.
      clock += BATCH_JOIN_MS + 1;
      await azure.request(GET);
      expect(ownerReads(docs)).toBe(8);
      // A write never reuses an after-read.
      await azure.request({ ...GET, method: "PUT", body: {} });
      expect(ownerReads(docs)).toBe(10);
    });

    it("a reused after-read still catches a swap: the chained read's own after-read discards it", async () => {
      const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
      const slot = makeAzureCredentialSlot(docs, () => 10_000);
      const azure = new PlatformAzureManagement(A, slot);
      await azure.request(GET);
      onFirstAzureSend(() => docs.save(CREDENTIAL_OWNER_KEY, owner(B, "tab-2:5:1")));
      await expect(azure.request(GET)).rejects.toMatchObject({ stage: "after" });
    });
  });

  it("same tenant under ANOTHER app registration refuses when the adapter knows its client", async () => {
    // Review finding: tab B's session for P2 (same tenant, contributor app)
    // admitted tab A's reader-only P1 batches - the wrong identity's grants.
    const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) }); // client "cx"
    const slot = newSlot(docs);
    await expect(new PlatformAzureManagement(A, slot, "shared", "c-other").request(GET)).rejects.toThrow(
      /another app registration/,
    );
    await expect(new PlatformGraphDirectory(A, slot, "shared", "c-other").listServicePrincipals()).rejects.toThrow(
      /another app registration/,
    );
    expect(azureTraffic()).toEqual([]);
    expect((await new PlatformAzureManagement(A, slot, "shared", "CX").request(GET)).status).toBe(200);
  });

  it("a record rewritten by another tab drops this tab's token caches: the next request mints before it sends", async () => {
    // Review finding: a connect whose mint failed (or that never minted Graph)
    // left another tenant's token in the slot under a record naming A; a tab
    // with A cached skipped the mint and sent under it.
    let clock = 10_000;
    const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A, "w-1") });
    const slot = makeAzureCredentialSlot(docs, () => clock);
    const azure = new PlatformAzureManagement(A, slot);
    await azure.request(GET);
    expect(events.filter((e) => e.startsWith("token:arm"))).toHaveLength(1);
    // Unchanged record: no second mint.
    await azure.request(GET);
    expect(events.filter((e) => e.startsWith("token:arm"))).toHaveLength(1);
    armSlot = B; // another tab's write left B's token in the slot
    await docs.save(CREDENTIAL_OWNER_KEY, owner(A, "w-2"));
    clock += BATCH_JOIN_MS + 1;
    events = [];
    await azure.request(GET);
    expect(events).toEqual([`token:arm:${A}`, `PUT azureArmToken?encrypted=true arm-${A}`, `ARM GET /subscriptions/x as ${A}`]);
  });

  describe("the tenant session is exempt, and protects other tabs", () => {
    const ACTIVE: TenantProfile = { id: "pa", name: "Lab", config: { tenantId: A, clientId: "ca", subscriptionId: "sa" } };
    const TARGET: TenantProfile = { id: "pb", name: "Customer", config: { tenantId: B, clientId: "cb", subscriptionId: "sb" } };

    function sessionOver(slot: InstanceType<typeof AzureCredentialSlot>, documents: FakeKvDocumentStore) {
      return new PlatformTenantSession({
        slot,
        documents,
        holderId: "tab-1",
        now: () => 1000,
        getActiveProfile: () => ACTIVE,
      });
    }

    it("the session's own requests are not blocked by the owner it wrote, and make no owner read", async () => {
      const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
      const slot = newSlot(docs);
      slot.remember("pa", "basic-a", ACTIVE.config);
      slot.remember("pb", "basic-b", TARGET.config);
      armAnswers["/subscriptions/sb"] = { status: 200, body: { subscriptionId: "sb", tenantId: B } };
      const out = await sessionOver(slot, docs).runForTenant(TARGET, async (ports) => {
        await ports.azure.request({ method: "GET", path: "/subscriptions/sb/resourcegroups", apiVersion: "2021-04-01" });
        return "scanned";
      });
      expect(out).toMatchObject({ kind: "done", value: "scanned" });
      expect(events).toContain(`ARM GET /subscriptions/sb/resourcegroups as ${B}`);
      expect(ownerReads(docs)).toBe(0);
    });

    it("ANOTHER tab's ordinary read during the session is refused, and goes through again after the restore", async () => {
      const docs = new FakeKvDocumentStore({ [CREDENTIAL_OWNER_KEY]: owner(A) });
      const sessionTab = newSlot(docs);
      const otherTab = newSlot(docs);
      sessionTab.remember("pa", "basic-a", ACTIVE.config);
      sessionTab.remember("pb", "basic-b", TARGET.config);
      armAnswers["/subscriptions/sb"] = { status: 200, body: { subscriptionId: "sb", tenantId: B } };
      let during: Promise<unknown> = Promise.resolve();
      await sessionOver(sessionTab, docs).runForTenant(TARGET, async () => {
        during = new PlatformAzureManagement(A, otherTab).request(GET);
        await during.catch(() => undefined);
        return 1;
      });
      await expect(during).rejects.toThrow(/another tab of this app is reading a different tenant/);
      expect(events.filter((e) => e === `ARM GET /subscriptions/x as ${B}`)).toEqual([]);
      // After the restore the record names A again (a new write), and the other tab's read goes out.
      expect((await new PlatformAzureManagement(A, otherTab).request(GET)).status).toBe(200);
    });
  });
});
