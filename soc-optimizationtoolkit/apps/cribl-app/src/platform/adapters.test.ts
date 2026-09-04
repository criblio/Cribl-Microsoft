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

const { PlatformCriblClient } = await import("./adapters");

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
