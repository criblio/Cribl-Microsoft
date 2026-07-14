import { describe, expect, it } from "vitest";

import { FakeTaggedSampleStore } from "./fake-tagged-sample-store";
import { parseSampleContent } from "../domain/sample-parsing";
import type { TaggedSample } from "../domain/sample-parsing";

function tagged(logType: string, content: string): TaggedSample {
  const parsed = parseSampleContent(content, { sourceName: logType });
  return {
    logType,
    format: parsed.format,
    rawEvents: parsed.rawEvents,
    parsed,
  };
}

describe("FakeTaggedSampleStore", () => {
  it("upserts and gets by logType", async () => {
    const store = new FakeTaggedSampleStore();
    await store.upsert(tagged("Dns", '{"event_simpleName":"DnsRequest"}'));

    const got = await store.get("Dns");
    expect(got?.logType).toBe("Dns");
    expect(await store.get("Missing")).toBeNull();
  });

  it("REPLACES the existing entry for the same logType", async () => {
    const store = new FakeTaggedSampleStore();
    await store.upsert(tagged("Web", '{"a":1}'));
    await store.upsert(tagged("Web", '{"a":1}\n{"a":2}'));

    expect((await store.list()).length).toBe(1);
    expect((await store.get("Web"))?.parsed.eventCount).toBe(2);
  });

  it("lists in first-upsert order and removes by logType", async () => {
    const store = new FakeTaggedSampleStore();
    await store.upsert(tagged("A", '{"a":1}'));
    await store.upsert(tagged("B", '{"b":1}'));
    expect((await store.list()).map((s) => s.logType)).toEqual(["A", "B"]);

    await store.remove("A");
    expect((await store.list()).map((s) => s.logType)).toEqual(["B"]);
    // Removing a missing logType is a no-op.
    await expect(store.remove("nope")).resolves.toBeUndefined();
  });

  it("returns deep copies so mutating a result cannot corrupt the store", async () => {
    const store = new FakeTaggedSampleStore();
    await store.upsert(tagged("Auth", '{"a":1}'));

    const first = await store.get("Auth");
    first!.rawEvents.push("MUTATED");
    first!.logType = "hacked";

    const second = await store.get("Auth");
    expect(second?.logType).toBe("Auth");
    expect(second?.rawEvents).not.toContain("MUTATED");
  });
});
