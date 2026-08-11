/**
 * Contract tests for the persisted-audit codec.
 *
 * A persisted set outlives the build that wrote it, so the pins that matter are
 * about what happens when the stored blob does not match this build's taxonomy:
 * unknown capabilities and unknown verdicts are DROPPED, never passed through,
 * because a bogus verdict is not noise - it is the model claiming a permission
 * fact nothing measured.
 */
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_AUDIT_CACHE_KEY,
  parseCapabilitySet,
  serializeCapabilitySet,
} from "./capability-codec";
import { emptyCapabilitySet, verdictFor } from "./capabilities";
import type { CapabilitySet } from "./capabilities";

const SET: CapabilitySet = {
  verdicts: { "dcr.write": "granted", "table.write": "denied", "pack.manage": "granted" },
  auditedAt: "2026-08-06T12:00:00Z",
  connectionId: "v1|tenant=a",
};

describe("round trip", () => {
  it("preserves a well-formed set exactly", () => {
    expect(parseCapabilitySet(serializeCapabilitySet(SET))).toEqual(SET);
  });

  it("preserves the never-audited set", () => {
    const empty = emptyCapabilitySet();
    expect(parseCapabilitySet(serializeCapabilitySet(empty))).toEqual(empty);
  });

  it("has a versioned cache key", () => {
    expect(CAPABILITY_AUDIT_CACHE_KEY).toContain("~v1");
  });
});

describe("parse is total", () => {
  it("yields an empty set for anything that is not an object", () => {
    for (const junk of [null, undefined, 42, "text", [], true]) {
      expect(parseCapabilitySet(junk)).toEqual(emptyCapabilitySet());
    }
  });

  it("survives a partially corrupt blob", () => {
    const parsed = parseCapabilitySet({
      verdicts: "not-an-object",
      auditedAt: 12345,
      connectionId: { nested: true },
    });
    expect(parsed).toEqual(emptyCapabilitySet());
  });
});

describe("unknown entries are dropped, never passed through", () => {
  it("drops a capability this build does not have", () => {
    // A set written when the taxonomy had an extra capability must not inject it.
    const parsed = parseCapabilitySet({
      verdicts: { "dcr.write": "granted", "workspace.delete": "granted" },
      auditedAt: null,
      connectionId: null,
    });
    expect(parsed.verdicts).toEqual({ "dcr.write": "granted" });
  });

  it("drops a verdict value outside the union", () => {
    const parsed = parseCapabilitySet({
      verdicts: { "dcr.write": "probably", "table.write": "denied" },
      auditedAt: null,
      connectionId: null,
    });
    expect(parsed.verdicts).toEqual({ "table.write": "denied" });
    // The dropped one resolves from context, not as a denial.
    expect(
      verdictFor("dcr.write", parsed, {
        azureIdentityPresent: true,
        criblReachable: true,
      }),
    ).toBe("unknown");
  });

  it("drops unknown capabilities on the way out too", () => {
    const stored = serializeCapabilitySet({
      verdicts: { "dcr.write": "granted", "bogus.capability": "granted" } as CapabilitySet["verdicts"],
      auditedAt: null,
      connectionId: null,
    });
    expect(stored.verdicts).toEqual({ "dcr.write": "granted" });
  });
});
