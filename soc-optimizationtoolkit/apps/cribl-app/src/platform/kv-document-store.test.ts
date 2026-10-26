// @vitest-environment happy-dom
/**
 * Pins for PlatformKvDocumentStore: the mapping from what the KV bridge
 * answers to the port's three-way read, and the shape of the write.
 *
 * The 403 pin is the one this adapter exists for. The two older KV adapters
 * answer `res.status === 404 || res.status === 403` with "absent"; copying that
 * branch here would compile, pass every other pin, and turn a refused read of
 * the operator's saved selection into the defaults the next Save writes over
 * it.
 *
 * fetchWithTimeout is mocked rather than the global fetch so a "timeout" is the
 * rejection platform/http really produces, without racing a real timer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithTimeout = vi.fn();
vi.mock("./http", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
  kvUrl: (key: string) => `https://leader.example/api/v1/kvstore/${key}`,
  kvDelete: vi.fn(),
  acquireArmToken: vi.fn(),
  acquireGraphToken: vi.fn(),
}));

const { PlatformKvDocumentStore } = await import("./kv-document-store");
const { makeCloudPorts } = await import("./adapters");

afterEach(() => {
  fetchWithTimeout.mockReset();
});

function respond(status: number, body = "") {
  fetchWithTimeout.mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  });
}

describe("PlatformKvDocumentStore.load maps the bridge's answer to absent | value | unknown", () => {
  it("404 is absent: not-found", async () => {
    respond(404, '{"message":"not found"}');
    expect(await new PlatformKvDocumentStore().load("coverage/selection")).toEqual({
      kind: "absent",
      why: "not-found",
    });
    expect(fetchWithTimeout.mock.calls[0]?.[0]).toBe(
      "https://leader.example/api/v1/kvstore/coverage/selection",
    );
  });

  it("403 is UNKNOWN, never absent - a refused read is not a first run", async () => {
    respond(403, '{"message":"Cannot read encrypted value"}');
    const loaded = await new PlatformKvDocumentStore().load("coverage/selection");
    expect(loaded.kind).toBe("unknown");
    expect(loaded).toMatchObject({ kind: "unknown", status: 403 });
  });

  it("500 is unknown, carrying the status", async () => {
    respond(500, "boom");
    expect(await new PlatformKvDocumentStore().load("doc")).toMatchObject({
      kind: "unknown",
      status: 500,
    });
  });

  it("a timeout is unknown with the bridge's reason, and load does not reject", async () => {
    fetchWithTimeout.mockRejectedValue(new Error("timed out after 15s - the platform bridge did not respond"));
    const loaded = await new PlatformKvDocumentStore().load("doc");
    expect(loaded.kind).toBe("unknown");
    expect(loaded.kind === "unknown" ? loaded.reason : "").toMatch(/timed out after 15s/);
    expect(loaded.kind === "unknown" ? loaded.status : "n/a").toBeUndefined();
  });

  it("a body that fails to read is unknown with its reason, and load does not reject", async () => {
    fetchWithTimeout.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => {
        throw new Error("body stream lost");
      },
    });
    const loaded = await new PlatformKvDocumentStore().load("doc");
    expect(loaded.kind).toBe("unknown");
    expect(loaded.kind === "unknown" ? loaded.reason : "").toMatch(/body stream lost/);
  });

  it("200 with JSON is the parsed value", async () => {
    respond(200, '{"kind":"coverage-selection","version":1,"items":["defender"]}');
    expect(await new PlatformKvDocumentStore().load("doc")).toEqual({
      kind: "value",
      value: { kind: "coverage-selection", version: 1, items: ["defender"] },
    });
  });

  it("200 with an empty body is absent: empty, and a non-JSON body is absent: corrupt", async () => {
    respond(200, "  ");
    expect(await new PlatformKvDocumentStore().load("doc")).toEqual({ kind: "absent", why: "empty" });
    // The literal the store persists when a write went out as application/json.
    respond(200, "[object Object]");
    expect(await new PlatformKvDocumentStore().load("doc")).toEqual({ kind: "absent", why: "corrupt" });
  });

  it("an unsafe key is unknown and never reaches the bridge", async () => {
    // A percent-escaped key 404s, and that 404 would read as absent.
    expect((await new PlatformKvDocumentStore().load("prefs/auth0|1")).kind).toBe("unknown");
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});

describe("PlatformKvDocumentStore.save", () => {
  it("PUTs the JSON as text/plain to the bare key - no encrypted flag", async () => {
    respond(200);
    await new PlatformKvDocumentStore().save("coverage/selection", { kind: "k", version: 1 });

    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    const [url, init] = fetchWithTimeout.mock.calls[0] as [string, RequestInit];
    // An encrypted document could never be loaded back (GET answers 403).
    expect(url).toBe("https://leader.example/api/v1/kvstore/coverage/selection");
    expect(url).not.toMatch(/encrypted/);
    expect(init.method).toBe("PUT");
    expect(init.body).toBe('{"kind":"k","version":1}');
    // application/json is persisted as "[object Object]" with a 200.
    expect(init.headers).toEqual({ "Content-Type": "text/plain" });
  });

  it("rejects on a 500, with the status in the message", async () => {
    respond(500, "store down");
    await expect(new PlatformKvDocumentStore().save("doc", {})).rejects.toThrow(/HTTP 500/);
  });

  it("rejects an unsafe key without calling the bridge", async () => {
    await expect(new PlatformKvDocumentStore().save("a b", {})).rejects.toThrow(/unsafe KV key/);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});

describe("makeCloudPorts carries the document store", () => {
  it("binds kvDocuments to a PlatformKvDocumentStore", () => {
    const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Parameters<
      typeof makeCloudPorts
    >[1];
    const ports = makeCloudPorts("t", logger);
    expect(ports.kvDocuments).toBeInstanceOf(PlatformKvDocumentStore);
  });
});
