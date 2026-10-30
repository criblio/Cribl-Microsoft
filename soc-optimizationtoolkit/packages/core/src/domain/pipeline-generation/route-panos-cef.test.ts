/**
 * PAN-OS CEF routes by header TYPE (GEN-24).
 *
 * DBT-196 splits a PAN-OS CEF capture by the TYPE in CEF header field 6, so a
 * pack built from THREAT and TRAFFIC samples has two log types whose only
 * defining difference is a header value. The header field names never reach
 * `_raw` (isMintedHeaderField), so before this the value and presence ladders
 * either placeholdered a log type or settled on whatever extension value
 * happened to name it (`PanOSContentVer === 'AppThreat-...'`, a content version
 * that changes with every content update).
 *
 * These pins run the REAL path - split, parse, value evidence, planner, route
 * emitter - and then EVALUATE each emitted filter, taken back out of route.yml
 * through a strict YAML double-quote unescape, against every line. Asserting
 * the filter text alone would pass a filter that matches nothing.
 */

import { describe, expect, it } from "vitest";
import { parseSampleContent, splitSamplesByLogType } from "../sample-parsing";
import { buildPipelinePlan } from "./plan";
import { generateRouteYml, placeholderLogTypes } from "./route-yml";
import { checkCriblYaml } from "./cribl-yaml-validator";
import { fieldValuesFromRecords } from "./route-value-discriminator";
import type { LogTypeFieldValues } from "./route-value-discriminator";
import { derivePanosCefTypeFilter } from "./route-panos-cef";

/**
 * The value of a YAML double-quoted scalar, STRICTLY. YAML defines a closed set
 * of escapes; `\|` is not one of them and a conforming loader rejects it, so a
 * lenient `\\\\ -> \\` replace would let an unescaped regex through. Only the
 * two escapes the emitter writes are accepted; anything else throws.
 */
function yamlDoubleQuoted(body: string): string {
  return body.replace(/\\([\s\S])/g, (_, c: string) => {
    if (c === "\\" || c === '"') return c;
    throw new Error(`invalid YAML escape \\${c} in ${body}`);
  });
}

/** Every route filter in a route.yml, YAML-unescaped. */
function routeFilters(yaml: string): string[] {
  return [...yaml.matchAll(/^ {4}filter: "((?:[^"\\]|\\.)*)"$/gm)].map((m) =>
    yamlDoubleQuoted(m[1] ?? ""),
  );
}

/** Evaluate a Cribl filter against an unparsed route-time event. */
function matches(filter: string, raw: string): boolean {
  return Boolean(new Function("_raw", `return (${filter});`)(raw));
}

const THREAT_FILTER =
  "typeof _raw === 'string' && /CEF:(?:\\\\[\\s\\S]|[^|\\\\])*\\|Palo Alto Networks\\|PAN-OS\\|(?:\\\\[\\s\\S]|[^|\\\\])*\\|(?:\\\\[\\s\\S]|[^|\\\\])*\\|THREAT\\|/.test(_raw)";
const TRAFFIC_FILTER = THREAT_FILTER.replace("THREAT", "TRAFFIC");

const HEAD = "CEF:0|Palo Alto Networks|PAN-OS|10.2.4";

/**
 * Lines built to catch a filter that is not anchored to header field 6:
 *   - a TRAFFIC line whose SUBTYPE (field 5) is `THREAT`;
 *   - a TRAFFIC line whose extension carries `|THREAT|`;
 *   - a THREAT line with an ESCAPED pipe in DeviceVersion, which shifts field
 *     6 for any split that ignores CEF's escape rule;
 *   - syslog-wrapped and bare lines both.
 */
const THREAT_LINES = [
  `<14>Oct 29 12:00:01 fw01 ${HEAD}|url|THREAT|1|src=10.0.0.1 dst=203.0.113.1 act=alert cat=(9999) request=a.example/x`,
  `${HEAD}|virus|THREAT|5|src=10.0.0.2 dst=203.0.113.2 act=reset-both cat=(9999) request=b.example/y`,
  "<14>Oct 29 12:00:03 fw01 CEF:0|Palo Alto Networks|PAN-OS|10.2\\|beta|spyware|THREAT|3|src=10.0.0.3 dst=203.0.113.3 act=drop cat=(9999) request=c.example/z",
];
const TRAFFIC_LINES = [
  `<14>Oct 29 12:00:04 fw01 ${HEAD}|end|TRAFFIC|1|src=10.0.0.4 dst=203.0.113.4 act=allow cat=aged-out in=10 out=20`,
  `<14>Oct 29 12:00:05 fw01 ${HEAD}|THREAT|TRAFFIC|1|src=10.0.0.5 dst=203.0.113.5 act=allow cat=aged-out in=11 out=21`,
  `${HEAD}|end|TRAFFIC|1|src=10.0.0.6 dst=203.0.113.6 act=allow cat=aged-out in=12 out=22 msg=x|THREAT|y`,
];

/** The split -> parse -> plan -> route.yml path a two-type PAN-OS pack takes. */
function panosPlan(lines: readonly string[]) {
  const splits = splitSamplesByLogType(lines, "cef", "cef");
  const samples = splits.map((s) => ({
    logType: s.logType,
    parsed: parseSampleContent(s.rawEvents.join("\n")),
  }));
  const plan = buildPipelinePlan({
    solutionName: "PaloAlto-PAN-OS",
    packName: "paloalto-sentinel",
    tables: samples.map((s) => ({
      sentinelTable: "CommonSecurityLog",
      logType: s.logType,
      sourceFormat: s.parsed.format,
      // Every source field kept, the shape a gap analysis hands over.
      presetFields: s.parsed.fields.map((f) => ({
        source: f.name,
        target: f.name,
        type: "string",
        action: "keep" as const,
      })),
      sampleFieldValues: fieldValuesFromRecords(s.logType, s.parsed.records),
    })),
  });
  return { splits, samples, plan };
}

describe("a two-type PAN-OS CEF pack routes by header TYPE", () => {
  const all = [...THREAT_LINES, ...TRAFFIC_LINES];
  const { splits, samples, plan } = panosPlan(all);

  it("starts from DBT-196's split: THREAT and TRAFFIC, three lines each, as cef", () => {
    expect(splits.map((s) => [s.logType, s.eventCount])).toEqual([
      ["THREAT", 3],
      ["TRAFFIC", 3],
    ]);
    expect(samples.map((s) => s.parsed.format)).toEqual(["cef", "cef"]);
  });

  it("gives each log type the header-TYPE filter, and no placeholder", () => {
    expect(plan.tables.map((t) => [t.logType, t.routeCondition])).toEqual([
      ["THREAT", THREAT_FILTER],
      ["TRAFFIC", TRAFFIC_FILTER],
    ]);
    expect(placeholderLogTypes(plan)).toEqual([]);
  });

  it("emits a route.yml whose filters, read back as YAML, are exactly those two", () => {
    const yaml = generateRouteYml(plan);
    expect(checkCriblYaml(yaml, "route.yml")).toEqual([]);
    expect(yaml).not.toContain("ACTION REQUIRED");
    // A reduction route and a passthrough route per log type, same filter each.
    expect(routeFilters(yaml)).toEqual([
      THREAT_FILTER,
      THREAT_FILTER,
      TRAFFIC_FILTER,
      TRAFFIC_FILTER,
    ]);
  });

  it("selects exactly its own type's lines when each filter is evaluated", () => {
    const [threat, traffic] = routeFilters(generateRouteYml(plan)).filter(
      (_, i) => i % 2 === 0,
    );
    expect(all.filter((l) => matches(threat ?? "false", l))).toEqual(THREAT_LINES);
    expect(all.filter((l) => matches(traffic ?? "false", l))).toEqual(
      TRAFFIC_LINES,
    );
  });
});

/** Value evidence for one PAN-OS log type, built by hand for the guard pins. */
function evidence(
  logType: string,
  over: Record<string, readonly string[]> = {},
): LogTypeFieldValues {
  return {
    logType,
    eventCount: 2,
    values: {
      DeviceVendor: ["Palo Alto Networks", "Palo Alto Networks"],
      DeviceProduct: ["PAN-OS", "PAN-OS"],
      Name: [logType, logType],
      ...over,
    },
  };
}

describe("derivePanosCefTypeFilter - scoped to PAN-OS CEF, as DBT-196 is", () => {
  const traffic = evidence("TRAFFIC");

  it("derives the anchored header filter for PAN-OS CEF", () => {
    expect(derivePanosCefTypeFilter(evidence("THREAT"), [traffic], "cef")).toBe(
      THREAT_FILTER,
    );
  });

  it("leaves every other CEF vendor to the existing ladder", () => {
    const fortinet = evidence("THREAT", {
      DeviceVendor: ["Fortinet", "Fortinet"],
      DeviceProduct: ["FortiGate", "FortiGate"],
    });
    expect(derivePanosCefTypeFilter(fortinet, [traffic], "cef")).toBeNull();
    // Each half of the identity on its own, so neither test can be dropped.
    const otherVendor = evidence("THREAT", {
      DeviceVendor: ["Acme Networks", "Acme Networks"],
    });
    expect(derivePanosCefTypeFilter(otherVendor, [traffic], "cef")).toBeNull();
    const otherProduct = evidence("THREAT", {
      DeviceProduct: ["Cortex XDR", "Cortex XDR"],
    });
    expect(derivePanosCefTypeFilter(otherProduct, [traffic], "cef")).toBeNull();
  });

  it("answers only for cef, not for a json record that happens to carry the names", () => {
    expect(derivePanosCefTypeFilter(evidence("THREAT"), [traffic], "json")).toBeNull();
  });

  it("refuses a TYPE that is not constant across the log type", () => {
    const mixed = evidence("THREAT", { Name: ["THREAT", "TRAFFIC"] });
    expect(derivePanosCefTypeFilter(mixed, [traffic], "cef")).toBeNull();
    const partial = evidence("THREAT", { Name: ["THREAT"] });
    expect(derivePanosCefTypeFilter(partial, [traffic], "cef")).toBeNull();
  });

  it("refuses a TYPE a sibling also carries, since the filter would take its events", () => {
    expect(
      derivePanosCefTypeFilter(evidence("THREAT"), [evidence("THREAT")], "cef"),
    ).toBeNull();
  });

  it("refuses a TYPE it would have to escape into the regex", () => {
    const odd = evidence("THREAT", { Name: ["THR|EAT", "THR|EAT"] });
    expect(derivePanosCefTypeFilter(odd, [traffic], "cef")).toBeNull();
  });
});
