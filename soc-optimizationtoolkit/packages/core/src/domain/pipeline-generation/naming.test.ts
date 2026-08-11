/**
 * Contract tests for pack/pipeline naming.
 *
 * naming.ts had no test file of its own until 2026-08-11 - its rules were
 * covered only incidentally, through whatever a plan test happened to assert.
 * That is how the pack name came to ignore the solution entirely without a
 * single suite noticing: nothing here was asking what the name SHOULD be.
 */
import { describe, expect, it } from "vitest";

import { packNameForSolution, vendorPrefixFromSolution } from "./naming";

describe("packNameForSolution - one pack name per solution", () => {
  // The 2026-08-11 report. Every solution used to prefill the SAME name, so a
  // second solution's build landed on the first one's pack and the only thing
  // between that and a silent replacement was an operator reading the overwrite
  // prompt. The pack's DISPLAY name was already solution-derived, which made it
  // harder to spot: two packs reading as different things, sharing one id.
  it("gives DIFFERENT solutions DIFFERENT names from one prefix", () => {
    const names = [
      "Gigamon Connector",
      "Cloudflare",
      "Palo Alto Networks PAN-OS",
    ].map((s) => packNameForSolution("MS-Sentinel", s));
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toBe("MS-Sentinel-Gigamon");
    expect(names[1]).toBe("MS-Sentinel-Cloudflare");
  });

  it("shortens the vendor the SAME way the pipeline ids do", () => {
    // Not a second sanitizer: a pack whose name shortened a vendor differently
    // from the pipelines inside it would be its own small confusion.
    for (const solution of ["Gigamon Connector", "Palo Alto Networks PAN-OS"]) {
      const vendor = vendorPrefixFromSolution(solution).replace(/_/g, "-");
      expect(packNameForSolution("MS-Sentinel", solution)).toBe(
        `MS-Sentinel-${vendor}`,
      );
    }
  });

  it("uses ONE separator - no MS-Sentinel-Palo_Alto", () => {
    // vendorPrefixFromSolution joins with underscores; the prefix uses hyphens.
    // Mixing them reads like two conventions colliding in one name.
    const name = packNameForSolution("MS-Sentinel", "Palo Alto Networks PAN-OS");
    expect(name).not.toContain("_");
    expect(name).toBe("MS-Sentinel-Palo-Alto");
  });

  it("returns the prefix unchanged before a solution is chosen", () => {
    // Nothing to distinguish yet, and inventing a token would be worse than the
    // shared default it replaces.
    expect(packNameForSolution("MS-Sentinel", "")).toBe("MS-Sentinel");
    expect(packNameForSolution("MS-Sentinel", "   ")).toBe("MS-Sentinel");
  });

  it("trims a trailing separator from the prefix", () => {
    // The stored destination prefix is "MS-Sentinel-"; the naive join would
    // produce "MS-Sentinel--Gigamon".
    expect(packNameForSolution("MS-Sentinel-", "Gigamon Connector")).toBe(
      "MS-Sentinel-Gigamon",
    );
  });

  it("does NOT double a vendor already at the tail", () => {
    // Re-deriving from an existing name (or a prefix an operator built by hand)
    // must be idempotent, or a rename cycle grows the name each pass.
    const once = packNameForSolution("MS-Sentinel", "Gigamon Connector");
    expect(packNameForSolution(once, "Gigamon Connector")).toBe(once);
  });

  it("falls back to the prefix when a solution name yields no vendor", () => {
    // vendorPrefixFromSolution answers "vendor" when every word is noise.
    // Appending that would add nothing and claim to distinguish.
    expect(packNameForSolution("MS-Sentinel", "Microsoft Sentinel Solution")).toBe(
      "MS-Sentinel",
    );
  });
});
