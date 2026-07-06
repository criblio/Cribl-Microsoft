import { describe, it, expect } from "vitest";
import {
  parseTransformKql,
  parseDcrJson,
  generateRouteCondition,
  escapeRegExp,
  extractTableRouting,
} from "./kql-parser";
import { CROWDSTRIKE_FDR_PROFILE, DEFAULT_GAP_PROFILE } from "./vendor-profile";

// A realistic multi-line transformKql (real DCRs separate pipes with newlines;
// the rename/extend block regexes depend on that).
const FDR_KQL = [
  "source",
  "| where event_simpleName in ('DnsRequest', 'DnsResponse')",
  "| project-rename",
  "        Renamed = ['orig']",
  "| extend",
  "        count = tolong(count),",
  "        ratio = todouble(ratio)",
].join("\n");

describe("parseTransformKql", () => {
  it("extracts event_simpleName list, renames, and coercions", () => {
    const parsed = parseTransformKql(FDR_KQL);
    expect(parsed.eventSimpleNames).toEqual(["DnsRequest", "DnsResponse"]);
    expect(parsed.renames).toEqual([{ dest: "Renamed", source: "orig" }]);
    expect(parsed.typeConversions).toEqual([
      { field: "count", toType: "long" },
      { field: "ratio", toType: "real" },
    ]);
  });

  it("always includes TimeGenerated and folds renames + coercions into columns", () => {
    const cols = new Map(
      parseTransformKql(FDR_KQL).columns.map((c) => [c.name, c.type]),
    );
    expect(cols.get("TimeGenerated")).toBe("datetime");
    expect(cols.get("Renamed")).toBe("string");
    expect(cols.get("count")).toBe("long");
    expect(cols.get("ratio")).toBe("real");
  });

  it("skips KQL function names and self-renames (skip-list)", () => {
    // `iff`, `now`, `source` on the left of `=` must not become renames, and
    // a dest === source pair is dropped.
    const kql = [
      "source",
      "| project-rename",
      "        Keep = ['src']",
      "| extend",
      "        TimeGenerated = iff(isnotempty(x), x, now()),",
      "        same = same",
    ].join("\n");
    const parsed = parseTransformKql(kql);
    expect(parsed.renames).toEqual([{ dest: "Keep", source: "src" }]);
  });

  // FDR common-field injection is VENDOR-PARAMETERIZED (task item 6).
  it("injects NOTHING vendor-specific under the default profile", () => {
    const names = parseTransformKql(FDR_KQL, DEFAULT_GAP_PROFILE).columns.map(
      (c) => c.name,
    );
    expect(names).not.toContain("event_simpleName");
    expect(names).not.toContain("aid");
    expect(names).not.toContain("event_platform");
  });

  it("injects the FDR common fields under the CrowdStrike profile (only for event_simpleName flows)", () => {
    const names = parseTransformKql(
      FDR_KQL,
      CROWDSTRIKE_FDR_PROFILE,
    ).columns.map((c) => c.name);
    for (const f of [
      "event_simpleName",
      "timestamp",
      "aid",
      "aip",
      "cid",
      "event_platform",
    ]) {
      expect(names).toContain(f);
    }
  });

  it("does NOT inject FDR common fields when there is no event_simpleName route", () => {
    const kql = [
      "source",
      "| project-rename",
      "        Renamed = ['orig']",
    ].join("\n");
    const names = parseTransformKql(kql, CROWDSTRIKE_FDR_PROFILE).columns.map(
      (c) => c.name,
    );
    expect(names).not.toContain("event_simpleName");
    expect(names).not.toContain("aid");
  });
});

describe("parseDcrJson tolerates all 3 shapes", () => {
  const flow = {
    outputStream: "Custom-My_Table_CL",
    transformKql: "source\n| project-rename\n        Renamed = ['orig']\n",
  };
  const expectOneFlow = (parsed: ReturnType<typeof parseDcrJson>) => {
    expect(parsed.flows).toHaveLength(1);
    expect(parsed.flows[0].tableName).toBe("My_Table_CL");
    expect(parsed.flows[0].renames).toEqual([
      { dest: "Renamed", source: "orig" },
    ]);
  };

  it("shape 1: a direct DCR object", () => {
    expectOneFlow(
      parseDcrJson(JSON.stringify({ properties: { dataFlows: [flow] } })),
    );
  });

  it("shape 2: an ARM template with the DCR inside resources[]", () => {
    expectOneFlow(
      parseDcrJson(
        JSON.stringify({
          resources: [
            {
              type: "Microsoft.Insights/dataCollectionRules",
              properties: { dataFlows: [flow] },
            },
          ],
        }),
      ),
    );
  });

  it("shape 3: a single-element array wrapper", () => {
    expectOneFlow(
      parseDcrJson(JSON.stringify([{ properties: { dataFlows: [flow] } }])),
    );
  });

  it("falls back to streams[0] when outputStream is absent, stripping Microsoft-", () => {
    const parsed = parseDcrJson(
      JSON.stringify({
        properties: {
          dataFlows: [{ streams: ["Microsoft-SecurityEvent"], transformKql: "source" }],
        },
      }),
    );
    expect(parsed.flows[0].outputStream).toBe("Microsoft-SecurityEvent");
    expect(parsed.flows[0].tableName).toBe("SecurityEvent");
  });
});

describe("generateRouteCondition (FIX + PIN: escaped AND anchored)", () => {
  it("returns true for an empty list", () => {
    expect(generateRouteCondition([])).toBe("true");
  });

  it("returns a single equality for one name", () => {
    expect(generateRouteCondition(["ProcessRollup2"])).toBe(
      "event_simpleName == 'ProcessRollup2'",
    );
  });

  it("ORs equalities for up to five names", () => {
    expect(generateRouteCondition(["A", "B", "C"])).toBe(
      "event_simpleName == 'A' || event_simpleName == 'B' || event_simpleName == 'C'",
    );
  });

  it("uses an anchored, escaped alternation regex for more than five names", () => {
    const names = ["Process", "Net", "Dns", "File", "Auth", "Reg"];
    expect(generateRouteCondition(names)).toBe(
      "/^(Process|Net|Dns|File|Auth|Reg)$/.test(event_simpleName)",
    );
  });

  it("CHARACTERIZES the legacy over-match and pins the fix", () => {
    const names = ["Process", "Net", "Dns", "File", "Auth", "Reg"];

    // LEGACY behavior: `/${names.join('|')}/.test(field)` - unanchored,
    // unescaped. It over-matched substrings.
    const legacy = new RegExp(names.join("|"));
    expect(legacy.test("ProcessRollup2")).toBe(true); // BUG: substring over-match

    // FIXED behavior: anchored alternation matches the WHOLE value only.
    const fixed = new RegExp(`^(${names.map(escapeRegExp).join("|")})$`);
    expect(fixed.test("ProcessRollup2")).toBe(false); // no over-match
    expect(fixed.test("Process")).toBe(true); // exact still matches
  });

  it("escapes regex metacharacters so they match literally", () => {
    const names = ["a.b", "c.d", "e.f", "g.h", "i.j", "k.l"]; // 6 -> regex branch
    const cond = generateRouteCondition(names);
    // Every '.' is escaped in the produced pattern.
    expect(cond).toBe("/^(a\\.b|c\\.d|e\\.f|g\\.h|i\\.j|k\\.l)$/.test(event_simpleName)");
    const inner = cond.slice("/^(".length, cond.indexOf(")$/"));
    const fixed = new RegExp(`^(${inner})$`);
    expect(fixed.test("a.b")).toBe(true);
    expect(fixed.test("axb")).toBe(false); // '.' escaped, not any-char

    // The legacy unescaped regex WOULD have matched 'axb' (dot = wildcard).
    const legacy = new RegExp(names.join("|"));
    expect(legacy.test("axb")).toBe(true); // BUG the fix removes
  });
});

describe("extractTableRouting", () => {
  it("summarizes per-table routing + columns from a DCR document", () => {
    const infos = extractTableRouting(
      JSON.stringify({
        properties: {
          dataFlows: [{ outputStream: "Custom-My_Table_CL", transformKql: FDR_KQL }],
        },
      }),
    );
    expect(infos).toHaveLength(1);
    expect(infos[0].tableName).toBe("My_Table_CL");
    expect(infos[0].eventSimpleNames).toEqual(["DnsRequest", "DnsResponse"]);
    expect(infos[0].routeCondition).toBe(
      "event_simpleName == 'DnsRequest' || event_simpleName == 'DnsResponse'",
    );
  });
});
