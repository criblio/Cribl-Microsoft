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
  columnOrderShortfall,
  COLUMN_ORDER_SHORTFALL_THRESHOLD,
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

  it("now bundles the four orders cited on 2026-08-25", () => {
    // Four of the six the plan measured against a live Cribl Lake dataset were
    // given orders transcribed from Palo Alto's published Format lines, so they
    // reach the dialog as a PRE-FILL rather than a blank grid. Bundled, not
    // final - the operator still overrides, which the pins below cover.
    for (const logType of ["AUDIT", "CORRELATION", "IPTAG", "USERID"]) {
      const order = bundledColumnOrder(PANOS, logType);
      expect(order, logType).toBeDefined();
      expect(order?.length, logType).toBeGreaterThan(7);
    }
    // Both vendor spellings resolve, via the separator fold in panosHeadersFor.
    expect(bundledColumnOrder(PANOS, "USER-ID")).toBe(
      bundledColumnOrder(PANOS, "USERID"),
    );
    expect(bundledColumnOrder(PANOS, "IP-TAG")).toBe(
      bundledColumnOrder(PANOS, "IPTAG"),
    );
  });

  it("is STILL UNDEFINED for the log types with no recorded order", () => {
    // AUTH is the deliberate decline: Palo Alto publishes no AUTH log type, so
    // there is nothing to transcribe and guessing one would mislabel every
    // column after the first mistake. Undefined is the honest answer - an
    // operator order for these is new knowledge, not an override.
    for (const logType of ["AUTH", "WILDFIRE", "GTP", "SCTP"]) {
      expect(bundledColumnOrder(PANOS, logType), logType).toBeUndefined();
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
    // AUTH, not USERID: USERID gained a cited bundled order on 2026-08-25, so
    // it no longer demonstrates the no-bundled-order case. AUTH is the one the
    // toolkit deliberately declines to record, which makes it the honest
    // stand-in - and this is the path that lets an operator supply what the
    // vendor never published.
    const stored = buildVendorFieldDefinition(PANOS, "AUTH", [
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
    // AUTH is the PAN-OS type with no recorded order (USERID has had one since
    // 2026-08-25), so it is what "neither stored nor bundled" looks like today.
    expect(resolveColumnOrder(PANOS, "AUTH", null)).toBeNull();
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
    // AUTH again: with no bundled order there is nothing an operator order
    // could have replaced, so the notice must not claim one.
    const stored = buildVendorFieldDefinition(PANOS, "AUTH", ["a", "b"]);
    const text = describeColumnOrder(
      present(resolveColumnOrder(PANOS, "AUTH", stored)),
    );
    expect(text).toContain("Your saved Palo Alto Networks AUTH");
    expect(text).not.toContain("REPLACES");
  });
});

describe("VND-3 - a hedge is not a measurement", () => {
  // The two live cases, 2026-08-27 and re-measured 2026-08-28 in the dev app:
  // THREAT arrived with 35 fields against a bundled 120-column order (the card
  // reported 38; the parser counts 35 for a standard line), TRAFFIC 41 against
  // 115. Both are the reason this exists, so both are fixtures.
  it("measures the shortfall instead of asking the operator to eyeball it", () => {
    const text = describeColumnOrder(
      present(resolveColumnOrder(PANOS, "TRAFFIC", null)),
      41,
    );

    expect(text).toContain("naming 41 fields");
    expect(text).not.toContain("check the values beside each name before applying.");
  });

  it("WARNS above the threshold, and says what mis-naming looks like", () => {
    const text = describeColumnOrder(
      present(resolveColumnOrder(PANOS, "TRAFFIC", null)),
      41,
    );

    expect(text).toContain("mis-names every column after it");
    // The count of names with no field under them, stated rather than implied.
    expect(text).toContain(`${TRAFFIC.length - 41} of the ${TRAFFIC.length}`);
  });

  it("does NOT warn when the order closely matches the feed", () => {
    // The rule has to stay quiet on the normal case or it becomes noise - the
    // DBT-19 failure this repo has already had twice.
    const text = describeColumnOrder(
      present(resolveColumnOrder(PANOS, "TRAFFIC", null)),
      TRAFFIC.length - 1,
    );

    expect(text).toContain(`naming ${TRAFFIC.length - 1} fields`);
    expect(text).not.toContain("mis-names every column after it");
  });

  it("keeps the ORIGINAL wording when no field count is available", () => {
    // The CSV header dialog resolves an order before anything is parsed. With
    // no number to compare, checking the values really is the best advice -
    // inventing a comparison would be worse than the hedge it replaced.
    const text = describeColumnOrder(present(resolveColumnOrder(PANOS, "TRAFFIC", null)));

    expect(text).toContain("check the values beside each name before applying.");
    expect(text).not.toContain("naming");
  });

  it("never disables anything - the sentence is the whole intervention", () => {
    // Decision 2026-08-28: WARN, Apply stays enabled. The rest of the app is
    // pinned to annotate-never-hide-never-disable, and this would have been the
    // only control disabled on a heuristic. describeColumnOrder returns TEXT and
    // has no other output, so there is nothing here that could gate a button.
    const text = describeColumnOrder(
      present(resolveColumnOrder(PANOS, "TRAFFIC", null)),
      41,
    );

    expect(typeof text).toBe("string");
  });
});

describe("columnOrderShortfall", () => {
  it("computes the gap and trips above a quarter", () => {
    const s = columnOrderShortfall(120, 35);

    expect(s?.missing).toBe(85);
    expect(s?.warn).toBe(true);
    expect(s?.ratio).toBeGreaterThan(COLUMN_ORDER_SHORTFALL_THRESHOLD);
  });

  it("stays quiet at or under the threshold", () => {
    // Exactly a quarter must NOT warn - the decision says "more than a quarter",
    // and a boundary that drifts by one is how a stated threshold stops meaning
    // what was agreed.
    expect(columnOrderShortfall(100, 75)?.warn).toBe(false);
    expect(columnOrderShortfall(100, 74)?.warn).toBe(true);
  });

  it("says NOTHING when there is no shortfall or no number", () => {
    expect(columnOrderShortfall(120, undefined)).toBeNull();
    expect(columnOrderShortfall(120, 120)).toBeNull();
    expect(columnOrderShortfall(120, 130)).toBeNull();
    expect(columnOrderShortfall(0, 5)).toBeNull();
  });
});
