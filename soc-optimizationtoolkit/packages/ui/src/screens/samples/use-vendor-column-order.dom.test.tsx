// @vitest-environment happy-dom
/**
 * DOM pins for useVendorColumnOrder - the wiring the pure core module cannot
 * show, because it is about what actually reaches the ContentCache port and
 * what a SECOND session sees (docs/vendor-field-definition-plan.md, Gap 3).
 *
 * What matters here:
 *   - the ROUND TRIP: an operator order named once is resolved by a fresh mount
 *     next week, under the key the core module pins;
 *   - the WRITE COUNT: a merely confirmed pre-fill writes NOTHING, so the
 *     bundled order is never frozen as an operator fact;
 *   - the OVERRIDE IS RECORDED in the stored value, so a UI reading it back can
 *     say what was replaced rather than that something was;
 *   - a SCOPE CHANGE re-reads, because the key moved.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  FakeContentCache,
  PANOS_CSV_HEADERS,
  buildVendorFieldDefinition,
  vendorFieldDefinitionKey,
} from "@soc/core";
import type { ContentCache, VendorFieldDefinition } from "@soc/core";
import { resolveDefinitionSource } from "./csv-resolution-state";
import { useVendorColumnOrder } from "./use-vendor-column-order";
import type { VendorColumnOrderState } from "./use-vendor-column-order";

afterEach(cleanup);

const PANOS = "Palo Alto Networks";
const TRAFFIC = PANOS_CSV_HEADERS.TRAFFIC;
const TRAFFIC_KEY = "vendor-field-definitions-v1-paloaltonetworks-traffic";

/** The TRAFFIC order with the one real firmware drift the operator would paste. */
function operatorTraffic(): string[] {
  const mine = [...TRAFFIC];
  mine[20] = "log_action";
  return mine;
}

/** Mount the hook for one scope and expose its latest value. */
function mountOrder(
  cache: ContentCache | undefined,
  vendor: string,
  logType: string,
) {
  const seen: { current: VendorColumnOrderState | null } = { current: null };
  function Probe() {
    seen.current = useVendorColumnOrder(cache, vendor, logType);
    return null;
  }
  const view = render(<Probe />);
  return { seen, view };
}

describe("useVendorColumnOrder - pre-fill", () => {
  it("resolves the BUNDLED order when nothing is stored", async () => {
    const cache = new FakeContentCache();
    const { seen } = mountOrder(cache, PANOS, "TRAFFIC");
    await waitFor(() => expect(seen.current?.loading).toBe(false));
    expect(seen.current?.resolved?.source).toBe("bundled");
    expect(seen.current?.resolved?.columns).toHaveLength(TRAFFIC.length);
    expect(seen.current?.notice).toContain("Bundled Palo Alto Networks TRAFFIC");
  });

  it("resolves NOTHING for a log type with no bundled order and none stored", async () => {
    // AUTH, not USERID: USERID gained a cited bundled order on 2026-08-25.
    // AUTH is the PAN-OS type the toolkit deliberately ships no order for,
    // because Palo Alto publishes none - so it is what "no bundled order"
    // genuinely looks like now.
    const cache = new FakeContentCache();
    const { seen } = mountOrder(cache, PANOS, "AUTH");
    await waitFor(() => expect(seen.current?.loading).toBe(false));
    // Never invent a name: the columns stay positional.
    expect(seen.current?.resolved).toBeNull();
    expect(seen.current?.notice).toBe("");
  });
});

describe("useVendorColumnOrder - what reaches the store", () => {
  it("writes NOTHING when the operator merely confirmed the pre-fill", async () => {
    const cache = new FakeContentCache();
    const { seen } = mountOrder(cache, PANOS, "TRAFFIC");
    await waitFor(() => expect(seen.current?.loading).toBe(false));

    act(() => seen.current?.remember([...TRAFFIC]));

    expect(cache.size).toBe(0);
    // And the pre-fill is unchanged, so nothing was lost by not storing it.
    expect(seen.current?.resolved?.source).toBe("bundled");
  });

  it("writes exactly ONE entry, under the pinned key, for an override", async () => {
    const cache = new FakeContentCache();
    const { seen } = mountOrder(cache, PANOS, "TRAFFIC");
    await waitFor(() => expect(seen.current?.loading).toBe(false));

    act(() => seen.current?.remember(operatorTraffic()));

    await waitFor(() => expect(cache.size).toBe(1));
    expect(vendorFieldDefinitionKey(PANOS, "TRAFFIC")).toBe(TRAFFIC_KEY);
    const stored = (await cache.get(TRAFFIC_KEY)) as VendorFieldDefinition;
    expect(stored.vendor).toBe(PANOS);
    expect(stored.logType).toBe("TRAFFIC");
    expect(stored.columns).toHaveLength(TRAFFIC.length);
    expect(stored.columns[20]).toBe("log_action");
  });

  it("RECORDS what the override replaced, in the stored value and the notice", async () => {
    const cache = new FakeContentCache();
    const { seen } = mountOrder(cache, PANOS, "TRAFFIC");
    await waitFor(() => expect(seen.current?.loading).toBe(false));

    act(() => seen.current?.remember(operatorTraffic()));
    await waitFor(() => expect(cache.size).toBe(1));

    const stored = (await cache.get(TRAFFIC_KEY)) as VendorFieldDefinition;
    expect(stored.overrides).toEqual({
      bundledColumnCount: TRAFFIC.length,
      firstDivergentIndex: 20,
      bundledName: "logset",
      operatorName: "log_action",
    });
    expect(seen.current?.notice).toContain("REPLACES the bundled order");
    expect(seen.current?.notice).toContain('bundled "logset"');
  });

  it("writes NOTHING when the scope cannot be named", async () => {
    // An un-curated solution yields no vendor. Without a key, two un-named
    // vendors would share one slot, so nothing is read and nothing is written.
    const cache = new FakeContentCache();
    const { seen } = mountOrder(cache, "", "TRAFFIC");
    await waitFor(() => expect(seen.current?.loading).toBe(false));

    act(() => seen.current?.remember(["a", "b", "c"]));

    expect(cache.size).toBe(0);
    expect(seen.current?.resolved).toBeNull();
  });
});

describe("useVendorColumnOrder - reuse across sessions", () => {
  it("a FRESH mount resolves the operator order, which beats the bundled one", async () => {
    const cache = new FakeContentCache();
    const first = mountOrder(cache, PANOS, "TRAFFIC");
    await waitFor(() => expect(first.seen.current?.loading).toBe(false));
    act(() => first.seen.current?.remember(operatorTraffic()));
    await waitFor(() => expect(cache.size).toBe(1));
    cleanup();

    // Next week: a new session, the same vendor and log type, no questions.
    const second = mountOrder(cache, PANOS, "TRAFFIC");
    await waitFor(() => expect(second.seen.current?.loading).toBe(false));
    expect(second.seen.current?.resolved?.source).toBe("operator");
    expect(second.seen.current?.resolved?.columns[20]).toBe("log_action");
    expect(second.seen.current?.resolved?.override?.bundledName).toBe("logset");
  });

  it("resolves a scope whose vendor and log type were SPELLED differently", async () => {
    const cache = new FakeContentCache();
    const first = mountOrder(cache, "palo alto networks", "traffic");
    await waitFor(() => expect(first.seen.current?.loading).toBe(false));
    act(() => first.seen.current?.remember(operatorTraffic()));
    await waitFor(() => expect(cache.size).toBe(1));
    cleanup();

    // Case and punctuation are not identity; the same order comes back.
    const second = mountOrder(cache, "PALO-ALTO-NETWORKS", "TRAFFIC");
    await waitFor(() => expect(second.seen.current?.loading).toBe(false));
    expect(second.seen.current?.resolved?.source).toBe("operator");
    expect(second.seen.current?.resolved?.columns[20]).toBe("log_action");
  });

  it("treats a different NAME for the same vendor as a different scope", async () => {
    // The documented boundary (core module: "the caller supplies a canonical
    // vendor name"). "PAN-OS" and "Palo Alto Networks" are different strings,
    // so they key separately - which is safe ONLY because the app derives the
    // vendor from ONE place, detectVendorIdentity, which always answers with
    // the curated canonical name. Pinned so a second source of vendor names
    // cannot be introduced without this test failing first.
    const cache = new FakeContentCache();
    const first = mountOrder(cache, "PAN-OS", "TRAFFIC");
    await waitFor(() => expect(first.seen.current?.loading).toBe(false));
    act(() => first.seen.current?.remember(operatorTraffic()));
    await waitFor(() => expect(cache.size).toBe(1));
    cleanup();

    const second = mountOrder(cache, PANOS, "TRAFFIC");
    await waitFor(() => expect(second.seen.current?.loading).toBe(false));
    // Not the other alias's order - the bundled one, unchanged and honest.
    expect(second.seen.current?.resolved?.source).toBe("bundled");
    expect(cache.size).toBe(1);
  });

  it("does NOT hand one log type's order to another", async () => {
    const cache = new FakeContentCache();
    // Two types that BOTH still lack a bundled order, so a null answer can only
    // mean "this log type's stored order did not leak", never "the bundled one
    // filled in". USERID/IPTAG stopped serving that purpose on 2026-08-25.
    const first = mountOrder(cache, PANOS, "AUTH");
    await waitFor(() => expect(first.seen.current?.loading).toBe(false));
    act(() => first.seen.current?.remember(["a", "b", "c"]));
    await waitFor(() => expect(cache.size).toBe(1));
    cleanup();

    const second = mountOrder(cache, PANOS, "WILDFIRE");
    await waitFor(() => expect(second.seen.current?.loading).toBe(false));
    expect(second.seen.current?.resolved).toBeNull();
  });

  it("forget drops the stored order and the bundled one answers again", async () => {
    const cache = new FakeContentCache();
    const { seen } = mountOrder(cache, PANOS, "TRAFFIC");
    await waitFor(() => expect(seen.current?.loading).toBe(false));
    act(() => seen.current?.remember(operatorTraffic()));
    await waitFor(() => expect(seen.current?.resolved?.source).toBe("operator"));

    act(() => seen.current?.forget());

    expect(seen.current?.resolved?.source).toBe("bundled");
    expect(seen.current?.resolved?.columns[20]).toBe("logset");
  });
});

describe("the pre-fill survives the dialog's derivation", () => {
  it("round-trips every bundled order, so a CONFIRMED one stores nothing", () => {
    // The joint between this persistence layer and the dialog: the pre-fill is
    // seeded as ORDINARY TEXT in the header-row box and derived back through
    // resolveDefinitionSource, exactly as a paste would be. If that trip were
    // lossy by even one character, applying an untouched pre-fill would build a
    // definition that DIFFERS from the bundled order - so the app would store an
    // override nobody made and tell the operator they had replaced the vendor's
    // table. The notice would lie, which is the one failure decision 3 exists to
    // prevent, and nothing else in either module would notice.
    for (const [logType, columns] of Object.entries(PANOS_CSV_HEADERS)) {
      const seeded = resolveDefinitionSource("row", columns.join("\n"), "");
      expect(seeded.headers, logType).toEqual([...columns]);
      expect(
        buildVendorFieldDefinition(PANOS, logType, seeded.headers),
        logType,
      ).toBeNull();
    }
  });
});

describe("useVendorColumnOrder - no cache bound", () => {
  it("still pre-fills from the bundled order and remembers nothing", async () => {
    const { seen } = mountOrder(undefined, PANOS, "TRAFFIC");
    await waitFor(() => expect(seen.current?.loading).toBe(false));
    expect(seen.current?.resolved?.source).toBe("bundled");
    act(() => seen.current?.remember(operatorTraffic()));
    expect(seen.current?.resolved?.source).toBe("bundled");
  });
});
