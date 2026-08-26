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
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareLogTypeCoverage,
  deriveExpectedLogTypes,
  extractDiscriminatorValues,
  logTypeNameMatches,
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

  it("separates field from value in the dedupe key without a raw NUL BYTE", () => {
    // The dedupe key joins field and value on U+0000. Written as a LITERAL nul
    // byte (as it was until 2026-08-20) the separator works fine at runtime and
    // breaks every tool around it: git classifies the file as binary, so its
    // diffs are unreviewable, and grep answers "Binary file ... matches" with
    // no lines, so the module silently drops out of every content search.
    // The escape-sequence form in the template literal is the same
    // character at runtime and keeps the file text. Same fix already
    // applied to the architecture-patterns unify edge key (2026-07-29).
    const source = readFileSync(
      new URL("./expected-log-types.ts", import.meta.url),
    );
    expect(source.indexOf(0)).toBe(-1);

    // ...and the separator still does its job: field and value stay distinct
    // halves of the key, so the same literal under two fields counts twice.
    const out = extractDiscriminatorValues(
      'T | where type == "start" | where subtype == "start"',
    );
    expect(out).toEqual([
      { field: "type", value: "start" },
      { field: "subtype", value: "start" },
    ]);
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

  it("does not let ONE unlabeled tag cover every expected log type", () => {
    // Reachable, not theoretical: sample intake's validateLogType rejects only
    // emptiness, so "-", "_" and "--" are all valid tags - plausible after a
    // no-discriminator capture or from a Lake group value. Each normalizes to
    // "", and `"traffic".includes("")` is true, so a matcher without the
    // empty-name guard reports TOTAL coverage from a single junk sample. This
    // is the side that arms the pack build, which is why it is pinned here and
    // against mergeLogTypeSources in log-type-catalog.test.ts.
    const out = compareLogTypeCoverage(expected, ["-"]);
    expect(out.missing.map((m) => m.value)).toEqual([
      "SYSTEM",
      "THREAT",
      "TRAFFIC",
    ]);
    expect(out.matched).toEqual([]);
    // Not silently dropped either: an unmatched tag is reported neutrally.
    expect(out.unreferenced).toEqual(["-"]);
  });
});

describe("logTypeNameMatches - THE one predicate", () => {
  it("matches case- and separator-insensitively in both directions", () => {
    expect(logTypeNameMatches("TRAFFIC", ["panostraffic"])).toBe(true);
    expect(logTypeNameMatches("PAN-OS Traffic", ["traffic"])).toBe(true);
    expect(logTypeNameMatches("TRAFFIC", ["hipmatch"])).toBe(false);
  });

  it("treats an empty name on EITHER side as no match, never as a wildcard", () => {
    // Both guards live in this function so no caller can forget one - the
    // failure that let compareLogTypeCoverage and mergeLogTypeSources print
    // contradicting sentences on one screen.
    expect(logTypeNameMatches("TRAFFIC", [""])).toBe(false);
    expect(logTypeNameMatches("TRAFFIC", ["", "traffic"])).toBe(true);
    expect(logTypeNameMatches("-", ["traffic"])).toBe(false);
  });

  /**
   * A GENERIC TAG MAY NOT CLAIM A SPECIFIC LOG TYPE (2026-08-26).
   *
   * Observed live: a FortiGate sample tagged "event" was credited against a
   * Zscaler solution's required "Tunnel Event", because normalize("Tunnel
   * Event") is "tunnelevent" and it contains normalize("event"). The solution's
   * unmet-log-type count fell from 9 to 8 and the operator was told a Zscaler
   * tunnel detection was covered by FortiGate system-event data containing no
   * Zscaler tunnel fields. A real coverage gap rendered as a false green - the
   * expensive direction to be wrong in, because it is the direction that arms
   * the pack build.
   *
   * BOTH SIDES ARE PINNED TOGETHER, because the fix is only correct if it keeps
   * the case the substring arm exists for. Word boundaries cannot separate them:
   * `providedNorm` arrives with its separators already stripped, so
   * "tunnelevent" ends in "event" exactly the way "panostraffic" ends in
   * "traffic" and nothing in the strings tells the two apart.
   */
  describe("the substring arm keeps what it is for and stops inventing coverage", () => {
    it("STOPS: a bare generic noun no longer covers a specific log type", () => {
      expect(logTypeNameMatches("Tunnel Event", ["event"])).toBe(false);
      // The same shape under every spelling the tag could arrive in.
      expect(logTypeNameMatches("Tunnel Event", ["Event", "EVENTS"])).toBe(false);
      expect(logTypeNameMatches("Firewall Log", ["log"])).toBe(false);
      expect(logTypeNameMatches("Audit Record", ["records"])).toBe(false);
    });

    it("KEEPS: a qualified tag still covers the name it qualifies", () => {
      // The documented case, in both directions, unchanged.
      expect(logTypeNameMatches("TRAFFIC", ["panos-traffic"])).toBe(true);
      expect(logTypeNameMatches("PAN-OS Traffic", ["traffic"])).toBe(true);
      // And the vendor catalog's alias path, which leans on the same tolerance:
      // "ZIA DNS" carries the alias "dns", and this is how a dataset tagged
      // "zscalernss-dns" is recognised as that feed.
      expect(logTypeNameMatches("dns", ["zscalernss-dns"])).toBe(true);
    });

    it("KEEPS: a log type genuinely CALLED 'event' is still coverable", () => {
      // Fortinet's own `type` field takes the literal value "event", so this is
      // a real expected log type and not a hypothetical. Two ways it is covered,
      // and neither is the broadening the rule refuses:
      expect(logTypeNameMatches("event", ["event"])).toBe(true); // exact
      expect(logTypeNameMatches("event", ["fortigate-event"])).toBe(true); // qualified
    });

    it("refuses the generic tag WITHOUT refusing the sample it came from", () => {
      // The end-to-end shape of the live defect. The tag is reported as
      // unreferenced - neutrally, the way an unmatched tag always is - rather
      // than counted as coverage or silently dropped.
      const zscaler = [
        {
          value: "Tunnel Event",
          field: "DeviceEventClassID",
          referencedBy: ["Zscaler tunnel detection"],
          referencedTypes: ["alert-rule" as const],
        },
      ];
      const out = compareLogTypeCoverage(zscaler, ["event"]);
      expect(out.missing.map((m) => m.value)).toEqual(["Tunnel Event"]);
      expect(out.matched).toEqual([]);
      expect(out.unreferenced).toEqual(["event"]);
    });
  });
});
