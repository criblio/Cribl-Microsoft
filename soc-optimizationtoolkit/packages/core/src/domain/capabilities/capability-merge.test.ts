/**
 * mergeCapabilitySets (CAP-11): a writer merges only what it measured, and a
 * verdict is replaced only by a newer measurement of the same capability.
 */
import { describe, expect, it } from "vitest";

import { mergeCapabilitySets, supersedeCapabilitySet } from "./capability-merge";
import { parseCapabilitySet, serializeCapabilitySet } from "./capability-codec";
import type { CapabilitySet } from "./capabilities";

const KEY = "v1|tenant=t|client=c";
const T1 = "2026-11-18T09:00:00Z";
const T2 = "2026-11-18T09:05:00Z";

function set(verdicts: CapabilitySet["verdicts"], auditedAt: string | null, connectionId = KEY): CapabilitySet {
  return { verdicts, auditedAt, connectionId };
}

describe("mergeCapabilitySets", () => {
  it("keeps a stored verdict the incoming set did not measure, with its own time", () => {
    const merged = mergeCapabilitySets(
      set({ "policy.assign": "denied", "dcr.write": "granted" }, T1),
      set({ "dcr.write": "denied" }, T2),
    );
    expect(merged).toEqual({
      verdicts: { "policy.assign": "denied", "dcr.write": "denied" },
      auditedAt: T2,
      connectionId: KEY,
      measuredAt: { "policy.assign": T1 },
    });
  });

  it("keeps the newer stored measurement when an older one arrives later", () => {
    const merged = mergeCapabilitySets(set({ "dcr.write": "denied" }, T2), set({ "dcr.write": "granted" }, T1));
    expect(merged.verdicts).toEqual({ "dcr.write": "denied" });
    expect(merged.auditedAt).toBe(T2);
    expect(merged.measuredAt).toBeUndefined();
  });

  it("judges age per capability, not per set", () => {
    // Stored set is newer overall, but its policy.assign was carried from T1.
    const stored: CapabilitySet = {
      ...set({ "policy.assign": "denied", "dcr.write": "granted" }, T2),
      measuredAt: { "policy.assign": T1 },
    };
    const merged = mergeCapabilitySets(stored, set({ "policy.assign": "granted" }, "2026-11-18T09:02:00Z"));
    expect(merged.verdicts).toEqual({ "policy.assign": "granted", "dcr.write": "granted" });
    expect(merged.measuredAt).toEqual({ "policy.assign": "2026-11-18T09:02:00Z" });
  });

  it("gives a tie to the incoming write", () => {
    const merged = mergeCapabilitySets(set({ "dcr.write": "granted" }, T1), set({ "dcr.write": "denied" }, T1));
    expect(merged.verdicts["dcr.write"]).toBe("denied");
  });

  it("never lets a derived unknown or unreachable displace a measurement", () => {
    const merged = mergeCapabilitySets(
      set({ "dcr.write": "granted", "policy.assign": "denied" }, T1),
      set({ "dcr.write": "unknown", "policy.assign": "unreachable" }, T2),
    );
    expect(merged.verdicts).toEqual({ "dcr.write": "granted", "policy.assign": "denied" });
  });

  it("does not let an unparseable incoming time replace a timed measurement", () => {
    const merged = mergeCapabilitySets(set({ "dcr.write": "granted" }, T1), set({ "dcr.write": "denied" }, "garbage"));
    expect(merged.verdicts["dcr.write"]).toBe("granted");
  });

  it("replaces outright across connections, carrying nothing", () => {
    const incoming = set({ "dcr.write": "denied" }, T2, "other");
    expect(mergeCapabilitySets(set({ "policy.assign": "granted" }, T1), incoming)).toBe(incoming);
  });

  it("returns the incoming set when nothing is stored", () => {
    const incoming = set({ "dcr.write": "denied" }, T2);
    expect(mergeCapabilitySets({ verdicts: {}, auditedAt: null, connectionId: null }, incoming)).toBe(incoming);
  });
});

describe("supersedeCapabilitySet (the audit, which attempts every capability)", () => {
  const T3 = "2026-11-18T09:10:00Z";

  it("drops every older stored verdict, measured again or not", () => {
    const out = supersedeCapabilitySet(
      set({ "graph-incidents.read": "granted", "dcr.write": "granted" }, T1),
      set({ "dcr.write": "denied" }, T2),
    );
    expect(out).toEqual({ verdicts: { "dcr.write": "denied" }, auditedAt: T2, connectionId: KEY });
  });

  it("keeps only a STRICTLY newer stored measurement, with its own time", () => {
    const stored: CapabilitySet = {
      ...set({ "dcr.write": "denied", "policy.assign": "granted", "table.write": "unknown" }, T3),
      measuredAt: { "policy.assign": T2 },
    };
    // The audit started at T2: dcr.write (T3) is newer and survives over the
    // audit's own grant; policy.assign (T2) ties and goes; an unknown is no
    // measurement and goes.
    const out = supersedeCapabilitySet(stored, set({ "dcr.write": "granted" }, T2));
    expect(out).toEqual({
      verdicts: { "dcr.write": "denied" },
      auditedAt: T3,
      connectionId: KEY,
    });
  });

  it("replaces outright across connections and over an empty store", () => {
    const incoming = set({ "dcr.write": "denied" }, T2, "other");
    expect(supersedeCapabilitySet(set({ "policy.assign": "granted" }, T3), incoming)).toBe(incoming);
    const own = set({ "dcr.write": "denied" }, T2);
    expect(supersedeCapabilitySet({ verdicts: {}, auditedAt: null, connectionId: null }, own)).toBe(own);
  });
});

describe("measuredAt survives the cache codec", () => {
  it("round-trips, and drops a time whose verdict did not survive", () => {
    const merged: CapabilitySet = {
      ...set({ "policy.assign": "denied", "dcr.write": "granted" }, T2),
      measuredAt: { "policy.assign": T1 },
    };
    const stored = serializeCapabilitySet(merged);
    expect(stored).toEqual({
      verdicts: { "policy.assign": "denied", "dcr.write": "granted" },
      auditedAt: T2,
      connectionId: KEY,
      measuredAt: { "policy.assign": T1 },
    });
    expect(parseCapabilitySet(stored)).toEqual(merged);
    expect(
      parseCapabilitySet({ ...stored, measuredAt: { "policy.assign": T1, "not.a.capability": T1, "dcr.write": 5 } }),
    ).toEqual(merged);
  });

  it("writes no measuredAt for a single-writer set", () => {
    expect(Object.keys(serializeCapabilitySet(set({ "dcr.write": "granted" }, T1))).sort()).toEqual([
      "auditedAt",
      "connectionId",
      "verdicts",
    ]);
  });
});
