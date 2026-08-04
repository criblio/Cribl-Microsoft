/**
 * Contract tests for the expected-log-type derivation (user request
 * 2026-08-04). The rules being pinned:
 *   - values are pulled from the discriminator comparisons real Sentinel rules
 *     use (==, =~, has, contains, in, in~), not from field names;
 *   - string literals must SURVIVE cleaning (extractKqlFields strips them,
 *     which is why this cannot reuse that function);
 *   - the comparison is separator/case-insensitive in BOTH directions;
 *   - an empty derivation reads as "nothing to compare", never "all covered".
 */
import { describe, expect, it } from "vitest";
import {
  compareLogTypeCoverage,
  deriveExpectedLogTypes,
  extractDiscriminatorValues,
} from "./expected-log-types";
import type { ContentItem } from "./models";

const rule = (name: string, ...queries: string[]): ContentItem => ({
  type: "alert-rule",
  id: name,
  name,
  queries,
});

describe("extractDiscriminatorValues", () => {
  it("pulls the literal from an equality comparison", () => {
    const out = extractDiscriminatorValues(
      'CommonSecurityLog | where DeviceEventClassID == "TRAFFIC"',
    );
    expect(out).toEqual([{ field: "DeviceEventClassID", value: "TRAFFIC" }]);
  });

  it("handles =~, has and contains as well as ==", () => {
    const out = extractDiscriminatorValues(`
      T | where type =~ "threat"
      | where subtype has "start"
      | where category contains "config"
    `);
    expect(out.map((v) => v.value).sort()).toEqual(["config", "start", "threat"]);
  });

  it("expands set membership into one entry per literal", () => {
    const out = extractDiscriminatorValues(
      'T | where subtype in ("start", "end", "drop")',
    );
    expect(out.map((v) => v.value)).toEqual(["start", "end", "drop"]);
    expect(out.every((v) => v.field === "subtype")).toBe(true);
  });

  it("handles in~ and single quotes", () => {
    const out = extractDiscriminatorValues("T | where type in~ ('TRAFFIC','THREAT')");
    expect(out.map((v) => v.value)).toEqual(["TRAFFIC", "THREAT"]);
  });

  it("keeps string literals - the whole point, and what extractKqlFields discards", () => {
    // extractKqlFields replaces "..." with "" before matching because it wants
    // field NAMES. If this function ever reused that cleaning it would return
    // nothing at all, so the literal surviving is the load-bearing behavior.
    const out = extractDiscriminatorValues('T | where DeviceEventClassID == "SYSTEM"');
    expect(out).toHaveLength(1);
    expect(out[0]?.value).toBe("SYSTEM");
  });

  it("ignores comparisons against non-discriminator fields", () => {
    const out = extractDiscriminatorValues(
      'T | where DestinationIP == "10.0.0.1" | where SourceUserName == "admin"',
    );
    expect(out).toEqual([]);
  });

  it("ignores values inside comments", () => {
    const out = extractDiscriminatorValues(
      '// where type == "COMMENTED"\nT | where type == "REAL"',
    );
    expect(out.map((v) => v.value)).toEqual(["REAL"]);
  });

  it("dedupes a value repeated across clauses", () => {
    const out = extractDiscriminatorValues(
      'T | where type == "TRAFFIC" | where type =~ "traffic"',
    );
    expect(out).toHaveLength(1);
  });

  it("returns nothing for a table-wide rule (an honest lower bound)", () => {
    expect(
      extractDiscriminatorValues("CommonSecurityLog | summarize count() by DeviceVendor"),
    ).toEqual([]);
  });
});

describe("deriveExpectedLogTypes", () => {
  it("unions across items and records who references each", () => {
    const out = deriveExpectedLogTypes([
      rule("Port scan", 'T | where DeviceEventClassID == "TRAFFIC"'),
      rule("Malware", 'T | where DeviceEventClassID == "THREAT"'),
      rule("Beaconing", 'T | where DeviceEventClassID == "TRAFFIC"'),
    ]);
    expect(out.map((e) => e.value)).toEqual(["TRAFFIC", "THREAT"]);
    expect(out[0]?.referencedBy).toEqual(["Port scan", "Beaconing"]);
    expect(out[1]?.referencedBy).toEqual(["Malware"]);
  });

  it("sorts by how many detections depend on the log type", () => {
    const out = deriveExpectedLogTypes([
      rule("A", 'T | where type == "rare"'),
      rule("B", 'T | where type == "common"'),
      rule("C", 'T | where type == "common"'),
    ]);
    expect(out.map((e) => e.value)).toEqual(["common", "rare"]);
  });

  it("keeps first-seen casing while deduping case-insensitively", () => {
    const out = deriveExpectedLogTypes([
      rule("A", 'T | where type == "TRAFFIC"'),
      rule("B", 'T | where type == "traffic"'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.value).toBe("TRAFFIC");
    expect(out[0]?.referencedBy).toEqual(["A", "B"]);
  });

  it("returns empty for a solution with no discriminating content", () => {
    expect(deriveExpectedLogTypes([rule("Broad", "T | count")])).toEqual([]);
  });
});

describe("compareLogTypeCoverage", () => {
  const expected = deriveExpectedLogTypes([
    rule("A", 'T | where DeviceEventClassID in ("TRAFFIC","THREAT","SYSTEM")'),
  ]);

  it("reports the log types with no sample", () => {
    const out = compareLogTypeCoverage(expected, ["traffic"]);
    // All three come from one rule, so reference counts tie and the order is
    // the alphabetical tiebreak - deterministic, not insertion order.
    expect(out.missing.map((m) => m.value)).toEqual(["SYSTEM", "THREAT"]);
    expect(out.matched).toEqual(["traffic"]);
  });

  it("matches ignoring case and separators in both directions", () => {
    // The operator's tag may be more specific than the content's token.
    const out = compareLogTypeCoverage(expected, [
      "TRAFFIC",
      "pan-os threat",
      "System",
    ]);
    expect(out.missing).toEqual([]);
    expect(out.unreferenced).toEqual([]);
  });

  it("reports provided-but-unreferenced neutrally, not as missing", () => {
    // A vendor emits more than any one solution detects on; extra samples are
    // never an error.
    const out = compareLogTypeCoverage(expected, [
      "TRAFFIC",
      "THREAT",
      "SYSTEM",
      "hipmatch",
    ]);
    expect(out.missing).toEqual([]);
    expect(out.unreferenced).toEqual(["hipmatch"]);
  });

  it("with nothing expected, nothing is missing and everything is unreferenced", () => {
    // The honesty case: no derivation must never render as "all covered".
    const out = compareLogTypeCoverage([], ["traffic"]);
    expect(out.expected).toEqual([]);
    expect(out.missing).toEqual([]);
    expect(out.unreferenced).toEqual(["traffic"]);
  });

  it("with nothing provided, every expected type is missing", () => {
    const out = compareLogTypeCoverage(expected, []);
    expect(out.missing).toHaveLength(3);
    expect(out.matched).toEqual([]);
  });
});
