// @vitest-environment happy-dom
/**
 * Pins for PlatformCriblClient's request plumbing.
 *
 * THE FIRST TEST IN apps/cribl-app/src, and the reason is worth recording: the
 * app's suite covered only scripts/, so every adapter in this package was
 * unpinned. That was invisible until AZR-18, when the fix for a capture timeout
 * was split across two halves - the use case asking for a longer wait, and this
 * adapter honouring it - and only the first half could be tested. Deleting
 * `opts.timeoutMs` from the fetch call left all 252 app tests green while
 * restoring the defect in full.
 *
 * So these pins are narrow on purpose: they hold the CONTRACT BETWEEN the port
 * and the platform, which is the seam a core-side test cannot reach and the one
 * where this defect lived.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * fetchWithTimeout is mocked rather than the global fetch, because the value
 * under test is its THIRD ARGUMENT - the wait itself. Racing a real timer would
 * pin that a long request does not reject early, which is slower, flakier, and
 * still would not prove the caller's number was the one used.
 */
const fetchWithTimeout = vi.fn();
vi.mock("./http", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
  kvUrl: (key: string) => `https://leader.example/api/v1/kvstore/${key}`,
  kvDelete: vi.fn(),
  acquireArmToken: vi.fn(),
  acquireGraphToken: vi.fn(),
}));

const { PlatformCriblClient, PlatformSecretsStore, KvContentCache, PlatformGithubPat } =
  await import("./adapters");

afterEach(() => {
  fetchWithTimeout.mockReset();
});

function respondOk() {
  fetchWithTimeout.mockResolvedValue({
    status: 200,
    text: async () => "{}",
    headers: { get: () => "application/json" },
  });
}

describe("PlatformCriblClient passes the caller's wait to the transport", () => {
  it("forwards timeoutMs, which is what lifted the 12-second capture ceiling", async () => {
    // AZR-18. The capture holds the response open for its whole window, so the
    // request has to be allowed to outlast it. Before this, every product API
    // call shared one short default and a capture longer than that reported a
    // transport failure for a capture that had run.
    (window as unknown as { CRIBL_API_URL: string }).CRIBL_API_URL =
      "https://leader.example/api/v1";
    respondOk();

    await new PlatformCriblClient().request({
      method: "POST",
      path: "/system/capture",
      groupId: "g",
      body: { duration: 600 },
      timeoutMs: 620000,
    });

    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    // The third argument IS the contract. Asserting the call happened, or that
    // the URL was right, would pass with the wait silently dropped.
    expect(fetchWithTimeout.mock.calls[0]?.[2]).toBe(620000);
  });

  it("passes undefined when the caller states no wait, so ONE default governs", async () => {
    // Not a detail. If the adapter substituted its own number here there would
    // be two opinions about how long a hung bridge may hang, and platform/http
    // could no longer be the single source of that decision. undefined is what
    // makes fetchWithTimeout's default parameter the only one.
    (window as unknown as { CRIBL_API_URL: string }).CRIBL_API_URL =
      "https://leader.example/api/v1";
    respondOk();

    await new PlatformCriblClient().request({
      method: "GET",
      path: "/master/groups",
    });

    expect(fetchWithTimeout.mock.calls[0]?.[2]).toBeUndefined();
  });
});

describe("PlatformCriblClient.listGroups returns a Listing (DBT-134)", () => {
  function respondWith(status: number, body: unknown) {
    (window as unknown as { CRIBL_API_URL: string }).CRIBL_API_URL =
      "https://leader.example/api/v1";
    fetchWithTimeout.mockResolvedValue({
      status,
      text: async () => JSON.stringify(body),
      headers: { get: () => "application/json" },
    });
  }

  it("reports a 200 with no items as the UNVERIFIED empty listing", async () => {
    // The tester's answer, most likely: the leader sends this both when no
    // group exists and when the caller's role or the app's grant covers none.
    // A bare [] here is what let four screens render it as "No matches".
    respondWith(200, { count: 0, items: [] });
    expect(await new PlatformCriblClient().listGroups()).toEqual({ kind: "empty" });
  });

  it("maps listed groups to rows, classing type 'stream' as Stream whatever product says", async () => {
    respondWith(200, {
      count: 3,
      items: [
        { id: "default", type: "stream", product: "cribl" },
        { id: "default_fleet", isFleet: true },
        { product: "stream" },
      ],
    });
    expect(await new PlatformCriblClient().listGroups()).toEqual({
      kind: "rows",
      rows: [
        { id: "default", product: "stream" },
        { id: "default_fleet", product: "edge" },
      ],
    });
  });

  it("still REJECTS a refusal rather than turning it into a listing", async () => {
    respondWith(403, { message: "Forbidden" });
    await expect(new PlatformCriblClient().listGroups()).rejects.toThrow(/HTTP 403/);
  });
});

/**
 * DBT-145, store half. The three KV readers below used to fold EVERY 403 into
 * "absent". Only two answers may read as absent: a 404 (never written) and
 * the platform's write-only encrypted value, whose 403 body says "Cannot read
 * encrypted value". Any other 403 is a refused read - a role or grant problem
 * - and the entry may well exist. Reading it as absent is how a finished
 * install was sent back through setup: the setup-unreadable path in App.tsx
 * (frame-state.ts loadableSetupFromRead) only runs when get() REJECTS.
 *
 * Each response carries `ok` because these adapters branch on it; respondOk
 * above serves an adapter that does not.
 */
describe("KV readers: only a 404 or the encrypted-value 403 reads as absent (DBT-145)", () => {
  const ENCRYPTED_403 = '{"message":"Cannot read encrypted value"}';
  const REFUSED_403 = '{"message":"Forbidden"}';

  function respond(status: number, body: string) {
    (window as unknown as { CRIBL_API_URL: string }).CRIBL_API_URL =
      "https://leader.example/api/v1";
    fetchWithTimeout.mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
      headers: { get: () => "application/json" },
    });
  }

  describe("PlatformSecretsStore.get", () => {
    it("404 resolves null", async () => {
      respond(404, '{"message":"not found"}');
      expect(await new PlatformSecretsStore().get("setupComplete")).toBeNull();
    });

    it("the encrypted-value 403 resolves null - a write-only secret is present but unreadable by design", async () => {
      respond(403, ENCRYPTED_403);
      expect(await new PlatformSecretsStore().get("azureBasic")).toBeNull();
    });

    it("any other 403 REJECTS with the status and body, so the caller can say the read failed", async () => {
      respond(403, REFUSED_403);
      await expect(new PlatformSecretsStore().get("setupComplete")).rejects.toThrow(
        /GET kvstore\/setupComplete: HTTP 403\n\{"message":"Forbidden"\}/,
      );
    });

    it("a 403 whose body cannot be read REJECTS rather than guessing it was the encrypted one", async () => {
      (window as unknown as { CRIBL_API_URL: string }).CRIBL_API_URL =
        "https://leader.example/api/v1";
      fetchWithTimeout.mockResolvedValue({
        status: 403,
        ok: false,
        text: async () => {
          throw new Error("body stream already read");
        },
        headers: { get: () => "application/json" },
      });
      await expect(new PlatformSecretsStore().get("setupComplete")).rejects.toThrow(/HTTP 403/);
    });
  });

  describe("KvContentCache.get", () => {
    it("404 resolves null (a miss)", async () => {
      respond(404, '{"message":"not found"}');
      expect(await new KvContentCache().get("capability-audit")).toBeNull();
    });

    it("the encrypted-value 403 resolves null (a miss)", async () => {
      respond(403, ENCRYPTED_403);
      expect(await new KvContentCache().get("capability-audit")).toBeNull();
    });

    it("any other 403 REJECTS - a refused read is not a miss", async () => {
      respond(403, REFUSED_403);
      await expect(new KvContentCache().get("capability-audit")).rejects.toThrow(
        /GET content-cache capability-audit: HTTP 403\n\{"message":"Forbidden"\}/,
      );
    });
  });

  describe("PlatformGithubPat.status", () => {
    it("404 resolves hasPat false", async () => {
      respond(404, '{"message":"not found"}');
      expect(await new PlatformGithubPat().status()).toEqual({ hasPat: false });
    });

    it("the encrypted-value 403 REJECTS too - githubPatStatus is never written encrypted", async () => {
      // The status companion is plain on purpose (the token is the encrypted
      // key). An encrypted answer here means something other than this
      // adapter wrote the key, and "no PAT" would be a guess.
      respond(403, ENCRYPTED_403);
      await expect(new PlatformGithubPat().status()).rejects.toThrow(
        /GET githubPatStatus: HTTP 403\n\{"message":"Cannot read encrypted value"\}/,
      );
    });

    it("any other 403 REJECTS", async () => {
      respond(403, REFUSED_403);
      await expect(new PlatformGithubPat().status()).rejects.toThrow(
        /GET githubPatStatus: HTTP 403\n\{"message":"Forbidden"\}/,
      );
    });
  });
});
