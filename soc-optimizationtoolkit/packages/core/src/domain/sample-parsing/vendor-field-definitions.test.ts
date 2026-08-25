/**
 * Pins for remembered vendor column orders (docs/vendor-field-definition-plan.md,
 * Gap 3 / step 4, decisions taken 2026-08-25).
 *
 * These are the specification. What they hold down, in the order the plan states
 * the decisions:
 *   - the KEY SHAPE, literally, because it is persisted - a drift silently
 *     forgets every order the operator ever named;
 *   - that the key is VENDOR + LOG TYPE and carries no solution;
 *   - that an unnameable scope has NO key, so un-named vendors cannot share one;
 *   - that a stored entry for another vendor reads as ABSENT, not as columns;
 *   - that a known vendor PRE-FILLS from the bundled order;
 *   - that an operator order BEATS it and the override is RECORDED;
 *   - that a merely CONFIRMED pre-fill stores nothing (the learned-mappings trap).
 */

import { describe, expect, it } from "vitest";
import {
  VENDOR_FIELD_DEFINITION_NAMESPACE,
  bundledColumnOrder,
  buildVendorFieldDefinition,
  describeColumnOrder,
  diffBundledOrder,
  normalizeDefinitionScope,
  parseVendorFieldDefinition,
  resolveColumnOrder,
  vendorFieldDefinitionKey,
} from "./vendor-field-definitions";
import { PANOS_CSV_HEADERS } from "./panos-dictionary";

const PANOS = "Palo Alto Networks";
const TRAFFIC = PANOS_CSV_HEADERS.TRAFFIC;

/** Assert a nullable result is present and narrow it, without a cast. */
function present<T>(value: T | null): T {
  if (value === null) {
    throw new Error("expected a value, got null");
  }
  return value;
}

describe("vendorFieldDefinitionKey - the persisted shape", () => {
  it("keys a definition to the folded vendor and log type, literally", () => {
    expect(vendorFieldDefinitionKey(PANOS, "TRAFFIC")).toBe(
      "vendor-field-definitions-v1-paloaltonetworks-traffic",
    );
  });

  it("is a SINGLE KV path segment of [a-z0-9-] for hostile scope text", () => {
    // "Palo Alto_Cortex XDR_AlertEvent" is a real log type that 404'd the KV
    // store once already, because encodeURIComponent escaped its spaces.
    const key = present(
      vendorFieldDefinitionKey(
        "Palo Alto Networks",
        "Palo Alto_Cortex XDR_AlertEvent",
      ),
    );
    expect(key).toBe(
      "vendor-field-definitions-v1-paloaltonetworks-paloaltocortexxdralertevent",
    );
    expect(key).toMatch(/^[a-z0-9-]+$/);
    expect(encodeURIComponent(key)).toBe(key);
  });

  it("resolves the same key however the vendor and log type are spelled", () => {
    const canonical = vendorFieldDefinitionKey(PANOS, "TRAFFIC");
    for (const spelling of [
      "palo alto networks",
      "PALO-ALTO-NETWORKS",
      "  Palo Alto Networks  ",
      "Palo/Alto/Networks",
    ]) {
      expect(vendorFieldDefinitionKey(spelling, "traffic")).toBe(canonical);
    }
  });

  it("carries NO solution component - one vendor fact, not a per-solution one", () => {
    // The whole of decision 1: the same key whichever solution is selected.
    const key = present(vendorFieldDefinitionKey(PANOS, "TRAFFIC"));
    const prefix = `${VENDOR_FIELD_DEFINITION_NAMESPACE}-v1-`;
    expect(key.startsWith(prefix)).toBe(true);
    expect(key.slice(prefix.length).split("-")).toEqual([
      "paloaltonetworks",
      "traffic",
    ]);
  });

  it("folds SPELLING but not ALIASES - the caller supplies a canonical name", () => {
    // bundledColumnOrder recognises both spellings of this vendor, but the KEY
    // does not: containment is not an equivalence relation, and an alias table
    // here would be a drifting second copy of the curated vendor list. Safe
    // because the app derives the vendor only from detectVendorIdentity.
    expect(vendorFieldDefinitionKey("PAN-OS", "TRAFFIC")).toBe(
      "vendor-field-definitions-v1-panos-traffic",
    );
    expect(vendorFieldDefinitionKey("PAN-OS", "TRAFFIC")).not.toBe(
      vendorFieldDefinitionKey(PANOS, "TRAFFIC"),
    );
    expect(bundledColumnOrder("PAN-OS", "TRAFFIC")).toBe(
      bundledColumnOrder(PANOS, "TRAFFIC"),
    );
  });

  it("keeps the vendor/log-type boundary unambiguous", () => {
    // Neither folded part can contain a hyphen, so these cannot collide.
    expect(vendorFieldDefinitionKey("ab", "c")).not.toBe(
      vendorFieldDefinitionKey("a", "bc"),
    );
  });

  it("REFUSES a key for an unnameable scope rather than sharing an empty slot", () => {
    // Without this, every vendor the app cannot name would key to
    // "...-v1--traffic" and the first one's TRAFFIC order would be handed to
    // the next one. Absent is absent, not empty.
    expect(vendorFieldDefinitionKey("", "TRAFFIC")).toBeNull();
    expect(vendorFieldDefinitionKey("   ", "TRAFFIC")).toBeNull();
    expect(vendorFieldDefinitionKey("---", "TRAFFIC")).toBeNull();
    expect(vendorFieldDefinitionKey(PANOS, "")).toBeNull();
    expect(vendorFieldDefinitionKey(PANOS, "  ")).toBeNull();
  });

  it("normalizes scope text to [a-z0-9] and nothing else", () => {
    expect(normalizeDefinitionScope("Palo Alto_Cortex XDR")).toBe(
      "paloaltocortexxdr",
    );
    expect(normalizeDefinitionScope("HIP-MATCH")).toBe("hipmatch");
  });
});

describe("bundledColumnOrder - what operator input can override", () => {
  it("finds the PAN-OS order however the vendor is spelled", () => {
    expect(bundledColumnOrder(PANOS, "TRAFFIC")).toBe(TRAFFIC);
    expect(bundledColumnOrder("PAN-OS", "TRAFFIC")).toBe(TRAFFIC);
    expect(bundledColumnOrder("Palo Alto Networks PAN-OS", "TRAFFIC")).toBe(
      TRAFFIC,
    );
  });

  it("is UNDEFINED for the live log types with no recorded order", () => {
    // The six the plan measured against a live Cribl Lake dataset. Undefined is
    // the honest answer: an operator order for these is new knowledge, not an
    // override.
    for (const logType of [
      "AUDIT",
      "AUTH",
      "CORRELATION",
      "IPTAG",
      "USERID",
      "WILDFIRE",
    ]) {
      expect(bundledColumnOrder(PANOS, logType)).toBeUndefined();
    }
  });

  it("is UNDEFINED for a vendor that ships no bundled orders", () => {
    expect(bundledColumnOrder("Zscaler", "web")).toBeUndefined();
    expect(bundledColumnOrder("", "TRAFFIC")).toBeUndefined();
  });
});

describe("diffBundledOrder - what counts as an override", () => {
  it("records nothing when the operator confirmed the bundled order", () => {
    expect(diffBundledOrder(TRAFFIC, [...TRAFFIC])).toBeNull();
  });

  it("records nothing when there is no bundled order to override", () => {
    expect(diffBundledOrder(undefined, ["a", "b"])).toBeNull();
  });

  it("records WHERE the orders first differ, not merely that they do", () => {
    // The real drift: PAN-OS index 20 is 'logset' here and was 'log_action' in
    // the legacy parser. An operator on that firmware pastes the other one.
    const mine = [...TRAFFIC];
    mine[20] = "log_action";
    expect(diffBundledOrder(TRAFFIC, mine)).toEqual({
      bundledColumnCount: TRAFFIC.length,
      firstDivergentIndex: 20,
      bundledName: "logset",
      operatorName: "log_action",
    });
  });

  it("records a truncation as a divergence past the end of the shorter order", () => {
    expect(diffBundledOrder(["a", "b", "c"], ["a", "b"])).toEqual({
      bundledColumnCount: 3,
      firstDivergentIndex: 2,
      bundledName: "c",
      operatorName: "",
    });
    expect(diffBundledOrder(["a", "b"], ["a", "b", "c"])).toEqual({
      bundledColumnCount: 2,
      firstDivergentIndex: 2,
      bundledName: "",
      operatorName: "c",
    });
  });
});

describe("buildVendorFieldDefinition - what gets stored", () => {
  it("stores an override AND the record of what it replaced", () => {
    const mine = [...TRAFFIC];
    mine[20] = "log_action";
    const stored = buildVendorFieldDefinition(PANOS, "TRAFFIC", mine);
    expect(stored).not.toBeNull();
    expect(stored?.columns).toHaveLength(TRAFFIC.length);
    expect(stored?.overrides).toEqual({
      bundledColumnCount: TRAFFIC.length,
      firstDivergentIndex: 20,
      bundledName: "logset",
      operatorName: "log_action",
    });
  });

  it("stores new knowledge for a log type with NO bundled order, unrecorded", () => {
    const stored = buildVendorFieldDefinition(PANOS, "USERID", [
      "receive_time",
      "serial",
      "type",
    ]);
    expect(stored?.columns).toEqual(["receive_time", "serial", "type"]);
    // Nothing was replaced, so nothing is claimed to have been.
    expect(stored?.overrides).toBeUndefined();
  });

  it("stores NOTHING when the operator merely CONFIRMED the pre-filled order", () => {
    // The learned-mappings trap, in this domain: the app put those names in the
    // box, so Apply is assent, not knowledge. Storing it would freeze today's
    // bundled order as an operator fact and make the override notice lie.
    expect(buildVendorFieldDefinition(PANOS, "TRAFFIC", [...TRAFFIC])).toBeNull();
    // And it costs nothing - the pre-fill still resolves next week.
    const next = resolveColumnOrder(PANOS, "TRAFFIC", null);
    expect(next?.source).toBe("bundled");
    expect(next?.columns).toEqual(TRAFFIC);
  });

  it("stores nothing for an unnameable scope or an empty order", () => {
    expect(buildVendorFieldDefinition("", "TRAFFIC", ["a"])).toBeNull();
    expect(buildVendorFieldDefinition(PANOS, "", ["a"])).toBeNull();
    expect(buildVendorFieldDefinition(PANOS, "USERID", [])).toBeNull();
  });

  it("takes column names VERBATIM - it never re-packs the order", () => {
    // Silently dropping a blank would rename every column after it, which is
    // the off-by-one the mismatch warning exists to catch.
    const stored = buildVendorFieldDefinition(PANOS, "USERID", ["a", "", "c"]);
    expect(stored?.columns).toEqual(["a", "", "c"]);
  });
});

describe("resolveColumnOrder - the precedence", () => {
  it("PRE-FILLS from the bundled order when nothing is stored", () => {
    const resolved = resolveColumnOrder(PANOS, "TRAFFIC", null);
    expect(resolved?.source).toBe("bundled");
    expect(resolved?.columns).toHaveLength(TRAFFIC.length);
  });

  it("an operator order BEATS the bundled one and the override is carried", () => {
    const mine = [...TRAFFIC];
    mine[20] = "log_action";
    const stored = buildVendorFieldDefinition(PANOS, "TRAFFIC", mine);
    const resolved = resolveColumnOrder(PANOS, "TRAFFIC", stored);
    expect(resolved?.source).toBe("operator");
    expect(resolved?.columns[20]).toBe("log_action");
    expect(resolved?.override?.firstDivergentIndex).toBe(20);
    expect(resolved?.override?.bundledName).toBe("logset");
  });

  it("RE-DERIVES the override against the CURRENT bundled order", () => {
    // A stored record must never be able to silence the notice: the operator's
    // order is diffed live, so a bundled order that changes later is compared
    // afresh rather than believed from the stored provenance.
    const stale = {
      vendor: PANOS,
      logType: "TRAFFIC",
      columns: [...TRAFFIC],
      overrides: {
        bundledColumnCount: 2,
        firstDivergentIndex: 0,
        bundledName: "gone",
        operatorName: "future_use1",
      },
    };
    // The columns ARE today's bundled order, so today there is no override.
    expect(resolveColumnOrder(PANOS, "TRAFFIC", stale)?.override).toBeUndefined();
  });

  it("is NULL when neither a stored nor a bundled order exists", () => {
    // Never invent a name: the columns stay positional and are shown unmapped.
    expect(resolveColumnOrder(PANOS, "USERID", null)).toBeNull();
    expect(resolveColumnOrder("Zscaler", "web", null)).toBeNull();
  });
});

describe("parseVendorFieldDefinition - decoding a stored value", () => {
  const GOOD = { vendor: PANOS, logType: "USERID", columns: ["a", "b", "c"] };

  it("round-trips a stored definition for its own scope", () => {
    const decoded = parseVendorFieldDefinition(GOOD, PANOS, "USERID");
    expect(decoded?.columns).toEqual(["a", "b", "c"]);
  });

  it("accepts the scope however it is spelled at read time", () => {
    expect(
      parseVendorFieldDefinition(GOOD, "palo-alto networks", "userid")?.columns,
    ).toHaveLength(3);
  });

  it("reads ANOTHER vendor's entry as ABSENT, never as columns", () => {
    // The collision gate. Two vendors must not silently merge, so an entry that
    // is not about this scope is not a definition for it.
    expect(parseVendorFieldDefinition(GOOD, "Zscaler", "USERID")).toBeNull();
    expect(parseVendorFieldDefinition(GOOD, PANOS, "TRAFFIC")).toBeNull();
  });

  it("REJECTS THE WHOLE ENTRY when any column is malformed", () => {
    // Unlike learned mappings, which drop bad entries one at a time: those are
    // independent facts, a column order is ONE fact whose meaning is position.
    // Dropping element 1 here would rename every column after it.
    expect(
      parseVendorFieldDefinition(
        { ...GOOD, columns: ["a", 7, "c"] },
        PANOS,
        "USERID",
      ),
    ).toBeNull();
    expect(
      parseVendorFieldDefinition(
        { ...GOOD, columns: ["a", "", "c"] },
        PANOS,
        "USERID",
      ),
    ).toBeNull();
  });

  it("reads anything else as absent rather than throwing", () => {
    for (const raw of [
      null,
      undefined,
      "not an object",
      [],
      {},
      { vendor: PANOS, logType: "USERID" },
      { vendor: PANOS, logType: "USERID", columns: [] },
      { vendor: PANOS, logType: "USERID", columns: "a,b,c" },
    ]) {
      expect(parseVendorFieldDefinition(raw, PANOS, "USERID")).toBeNull();
    }
  });
});

describe("describeColumnOrder - decision 3's 'and they are told'", () => {
  it("says a bundled order is bundled and asks for a check", () => {
    const text = describeColumnOrder(
      present(resolveColumnOrder(PANOS, "TRAFFIC", null)),
    );
    expect(text).toContain("Bundled Palo Alto Networks TRAFFIC");
    expect(text).toContain(`${TRAFFIC.length} columns`);
  });

  it("NAMES what an override replaced and where it diverges", () => {
    const mine = [...TRAFFIC];
    mine[20] = "log_action";
    const stored = buildVendorFieldDefinition(PANOS, "TRAFFIC", mine);
    const text = describeColumnOrder(
      present(resolveColumnOrder(PANOS, "TRAFFIC", stored)),
    );
    expect(text).toContain("REPLACES the bundled order");
    expect(text).toContain("column 21"); // 1-based for the operator
    expect(text).toContain('bundled "logset"');
    expect(text).toContain('yours "log_action"');
  });

  it("does NOT claim an override when nothing was replaced", () => {
    const stored = buildVendorFieldDefinition(PANOS, "USERID", ["a", "b"]);
    const text = describeColumnOrder(
      present(resolveColumnOrder(PANOS, "USERID", stored)),
    );
    expect(text).toContain("Your saved Palo Alto Networks USERID");
    expect(text).not.toContain("REPLACES");
  });
});
