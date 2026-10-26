import { describe, expect, it } from "vitest";

import { FakeKvDocumentStore } from "./fake-kv-document-store";
import { isKvDocumentKey } from "../ports/kv-document-store";

describe("FakeKvDocumentStore", () => {
  it("loads an unsaved key as absent: not-found, and records the load", async () => {
    const store = new FakeKvDocumentStore();
    expect(await store.load("coverage/selection")).toEqual({ kind: "absent", why: "not-found" });
    expect(store.loads).toEqual(["coverage/selection"]);
  });

  it("round-trips a save, records it, and loads it back as value", async () => {
    const store = new FakeKvDocumentStore();
    await store.save("doc", { kind: "k", version: 1, items: ["a"] });

    expect(store.saves).toEqual([{ key: "doc", value: { kind: "k", version: 1, items: ["a"] } }]);
    expect(await store.load("doc")).toEqual({
      kind: "value",
      value: { kind: "k", version: 1, items: ["a"] },
    });
  });

  it("loads a seeded document as value", async () => {
    const store = new FakeKvDocumentStore({ doc: { version: 2 } });
    expect(await store.load("doc")).toEqual({ kind: "value", value: { version: 2 } });
    expect(store.saves).toEqual([]);
  });

  it("answers a scripted unknown over a stored value, until the script is cleared", async () => {
    // The screen pins depend on this: an unknown read must be producible for a
    // key that DOES hold a document, because that is the case Save must not
    // overwrite.
    const store = new FakeKvDocumentStore({ doc: { version: 1 } });
    store.scriptLoad("doc", { kind: "unknown", reason: "HTTP 403", status: 403 });

    expect(await store.load("doc")).toEqual({ kind: "unknown", reason: "HTTP 403", status: 403 });
    expect(await store.load("other")).toEqual({ kind: "absent", why: "not-found" });

    store.clearScript();
    expect(await store.load("doc")).toEqual({ kind: "value", value: { version: 1 } });
  });

  it("failSaves makes save reject without storing or recording, and null restores it", async () => {
    const store = new FakeKvDocumentStore({ doc: { v: "old" } });
    store.failSaves();

    await expect(store.save("doc", { v: "new" })).rejects.toThrow(/HTTP 500/);
    expect(store.saves).toEqual([]);
    expect(store.peek("doc")).toEqual({ v: "old" });

    store.failSaves(new Error("custom"));
    await expect(store.save("doc", { v: "new" })).rejects.toThrow("custom");

    store.failSaves(null);
    await store.save("doc", { v: "new" });
    expect(store.peek("doc")).toEqual({ v: "new" });
  });

  it("isolates stored values from the caller's objects (JSON copies both ways)", async () => {
    const store = new FakeKvDocumentStore();
    const value = { items: ["a"] };
    await store.save("doc", value);
    value.items.push("mutated-after-save");

    const loaded = await store.load("doc");
    if (loaded.kind !== "value") throw new Error("expected value");
    (loaded.value as { items: string[] }).items.push("mutated-after-load");

    expect(store.peek("doc")).toEqual({ items: ["a"] });
    expect(store.saves[0]?.value).toEqual({ items: ["a"] });
  });

  it("refuses an unsafe key: load answers unknown (never rejects), save rejects", async () => {
    const store = new FakeKvDocumentStore();
    const loaded = await store.load("prefs/auth0|123");
    expect(loaded.kind).toBe("unknown");
    await expect(store.save("prefs/auth0|123", {})).rejects.toThrow(/unsafe KV key/);
    expect(store.saves).toEqual([]);
  });
});

describe("isKvDocumentKey", () => {
  it("accepts the measured-safe alphabet: [A-Za-z0-9-] segments, '.', '/' and the '_' escape", () => {
    for (const key of ["coverage-selection", "azure-onboarding/selection", "jobs/a1.b2", "A9", "prefs/auth0_7c123"]) {
      expect(isKvDocumentKey(key), key).toBe(true);
    }
  });

  it("refuses percent-escapes, other punctuation, spaces, malformed slashes and dot-only segments", () => {
    // Each of these 404s or misroutes on Cribl.Cloud, and the 404 reads as
    // "never written" - so a refused key must fail loudly instead. A dot-only
    // segment is resolved by the URL parser: kvstore/../x is /api/v1/x.
    for (const key of ["", "a%3Ab", "auth0|1", "a b", "a:b", "/a", "a/", "a//b", ".", "..", "a/../b", "../x", "a/..."]) {
      expect(isKvDocumentKey(key), key).toBe(false);
    }
  });
});
