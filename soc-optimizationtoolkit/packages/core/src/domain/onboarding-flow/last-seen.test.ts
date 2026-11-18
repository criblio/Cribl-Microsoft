/**
 * Pins for the remembered last-seen times (AZR-37). The failure they guard is
 * a fabricated answer: an unreadable document shown as "never seen", a time
 * moved backwards by a stale writer, or a write per poll.
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_FLOW_LAST_SEEN,
  FLOW_LAST_SEEN_MIN_WRITE_INTERVAL_MS,
  describeLastSeen,
  encodeFlowLastSeen,
  flowInputKey,
  lastSeenFor,
  lostFlowLastSeen,
  mergeFlowLastSeen,
  readFlowLastSeen,
  recordFlowSeen,
} from "./last-seen";

const HUB = { groupId: "g1", input: { type: "eventhub", id: "in_entra_1" } };
const BLOB = { groupId: "g1", input: { type: "azure_blob", id: "in_vnet_1" } };
const doc = (byInput: Record<string, number>) => ({ byInput });

describe("readFlowLastSeen", () => {
  it("reads an absent document as empty, and a written one round-trips", () => {
    expect(readFlowLastSeen({ kind: "absent", why: "not-found" })).toEqual({ kind: "read", doc: EMPTY_FLOW_LAST_SEEN });
    const written = encodeFlowLastSeen(doc({ "g1/eventhub:in_entra_1": 1234 }));
    expect(readFlowLastSeen({ kind: "value", value: written })).toEqual({
      kind: "read",
      doc: doc({ "g1/eventhub:in_entra_1": 1234 }),
    });
  });

  it.each([
    ["an unreadable load", { kind: "unknown", reason: "HTTP 503", status: 503 } as const, "HTTP 503"],
    ["a corrupt value", { kind: "absent", why: "corrupt" } as const, "not JSON"],
    ["a foreign document", { kind: "value", value: { kind: "other", byInput: {} } } as const, "did not write"],
    ["a newer version", { kind: "value", value: { kind: "soc.flow-last-seen", version: 2, byInput: {} } } as const, "cannot read"],
    ["a bad time", { kind: "value", value: { kind: "soc.flow-last-seen", version: 1, byInput: { a: "yesterday" } } } as const, "not a time"],
  ])("is UNKNOWN for %s - never the empty document", (_label, load, reason) => {
    const read = readFlowLastSeen(load);
    expect(read.kind).toBe("unknown");
    expect(read.kind === "unknown" ? read.reason : "").toContain(reason);
  });
});

describe("recordFlowSeen", () => {
  it("records every flowing input at the given time, and is due for a new input", () => {
    const out = recordFlowSeen(EMPTY_FLOW_LAST_SEEN, [HUB, BLOB], 5000);
    expect(out).toEqual({ doc: doc({ "g1/eventhub:in_entra_1": 5000, "g1/azure_blob:in_vnet_1": 5000 }), due: true });
  });

  it("is not due again within the interval of what was PERSISTED, but still shows the newer time", () => {
    const persisted = doc({ "g1/eventhub:in_entra_1": 1000 });
    const shown = doc({ "g1/eventhub:in_entra_1": 61_000 });
    const soon = recordFlowSeen(shown, [HUB], 121_000, persisted);
    expect(soon).toEqual({ doc: doc({ "g1/eventhub:in_entra_1": 121_000 }), due: false });
    const later = recordFlowSeen(soon.doc, [HUB], 1000 + FLOW_LAST_SEEN_MIN_WRITE_INTERVAL_MS, persisted);
    expect(later.due).toBe(true);
  });

  it("never moves a time backwards, and an empty or timeless reading changes nothing", () => {
    const d = doc({ "g1/eventhub:in_entra_1": 9000 });
    expect(recordFlowSeen(d, [HUB], 5000)).toEqual({ doc: d, due: false });
    expect(recordFlowSeen(d, [], 99_999_999)).toEqual({ doc: d, due: false });
    expect(recordFlowSeen(d, [HUB], Number.NaN)).toEqual({ doc: d, due: false });
  });
});

describe("lostFlowLastSeen", () => {
  it("names each entry the store lacks or holds older, and nothing it kept", () => {
    const wrote = doc({ a: 10, b: 20, c: 30 });
    expect(lostFlowLastSeen(doc({ a: 10, b: 15, d: 99 }), wrote)).toEqual(["b", "c"]);
    expect(lostFlowLastSeen(doc({ a: 11, b: 20, c: 30 }), wrote)).toEqual([]);
  });
});

describe("mergeFlowLastSeen", () => {
  it("keeps the later time per input and every input from both sides, whichever order", () => {
    const a = doc({ x: 10, y: 50 });
    const b = doc({ y: 40, z: 7 });
    expect(mergeFlowLastSeen(a, b)).toEqual(doc({ x: 10, y: 50, z: 7 }));
    expect(mergeFlowLastSeen(b, a)).toEqual(doc({ x: 10, y: 50, z: 7 }));
  });
});

describe("lastSeenFor and describeLastSeen", () => {
  const fmt = (ms: number) => `T${ms}`;

  it("answers seen, never, or unknown - with the reason - and nothing else", () => {
    const read = { kind: "read", doc: doc({ [flowInputKey(HUB)]: 42 }) } as const;
    expect(lastSeenFor(read, HUB)).toEqual({ kind: "seen", at: 42 });
    expect(lastSeenFor(read, BLOB)).toEqual({ kind: "never" });
    expect(lastSeenFor(null, HUB)).toEqual({ kind: "unknown", reason: "not read yet" });
    expect(lastSeenFor({ kind: "unknown", reason: "HTTP 503" }, HUB)).toEqual({
      kind: "unknown",
      reason: "the remembered times could not be read (HTTP 503)",
    });
    expect(lastSeenFor(read, null)).toMatchObject({ kind: "unknown" });
  });

  it("labels a time as remembered, not measured", () => {
    expect(describeLastSeen({ kind: "seen", at: 42 }, fmt)).toBe(
      "Last seen flowing T42 (remembered by this app from an earlier reading, not measured now).",
    );
    expect(describeLastSeen({ kind: "never" }, fmt)).toBe(
      "Never seen flowing by this app (it remembers only what it measured while Watch for data was on).",
    );
    expect(describeLastSeen({ kind: "unknown", reason: "not read yet" }, fmt)).toBe(
      "When it was last seen flowing is unknown: not read yet.",
    );
  });

  it("keys a pack input by its pack too, so two packs' inputs never share a time", () => {
    expect(flowInputKey({ groupId: "g1", input: { type: "eventhub", id: "in1", packId: "p" } })).toBe("g1/eventhub:p.in1");
    expect(flowInputKey({ groupId: "g1", input: { type: "eventhub", id: "in1" } })).toBe("g1/eventhub:in1");
  });

  it("keys by worker group, so the same input id in two groups never shares a time", () => {
    const g2 = { ...HUB, groupId: "g2" };
    expect(flowInputKey(g2)).toBe("g2/eventhub:in_entra_1");
    const read = { kind: "read", doc: recordFlowSeen(EMPTY_FLOW_LAST_SEEN, [HUB], 7000).doc } as const;
    expect(lastSeenFor(read, HUB)).toEqual({ kind: "seen", at: 7000 });
    expect(lastSeenFor(read, g2)).toEqual({ kind: "never" });
  });
});
